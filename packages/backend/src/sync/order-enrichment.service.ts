import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FusionMetadataService } from '../fusion/fusion-metadata.service';
import { ApplyReceiptRequest } from '../clients/oracle/oracle-soap.client';
import { bigIntToNumber, toSafeNumber } from '../common/utils/bigint-utils';

// Define the types properly - matching Oracle client expectations
export interface InvoiceLine {
  lineNumber: number;
  itemNumber?: string;
  description?: string;
  quantity: number;
  unitSellingPrice: number;
  currencyCode: string;
  salesOrder: string;  // ✅ Must be string, not optional
  salesOrderLine?: string;
  memoLineName?: string;
}

export interface InvoiceHeader {
  billToCustomerName: string;
  billToLocation: string;
  billToAccountNumber: string;
  businessUnit: string;
  outletName?: string;
  saleDate: Date;
  transactionSource: string;
  transactionType: string;
  invoiceCurrencyCode: string;
  conversionRateType: string;
  invoiceLines: InvoiceLine[];
}

export interface ReceiptRequest {
  currencyCode: string;
  saleDate: Date;
  receiptMethodId: number;
  receiptNumber: string;
  remittanceBankAccountId: number;
  accountValue: string;
  orgId: number;
  receiptAmount: number;
}

export interface EnrichedOrderData {
  invoiceHeader: InvoiceHeader;
  standardReceipts: ReceiptRequest[];
  miscReceipts: any[];
  applyReceipts: ApplyReceiptRequest[];
  journalHeaders: any[];
}

@Injectable()
export class OrderEnrichmentService {
  private readonly logger = new Logger(OrderEnrichmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fusionMetadataService: FusionMetadataService,
  ) {}

  /**
   * Convert Prisma Decimal or BigInt to number safely
   * Handles various data types that can come from Prisma queries
   * @deprecated Use toSafeNumber from bigint-utils instead
   */
  private toNumber(value: any): number {
    return toSafeNumber(value);
  }

  async enrichOrder(
    orderSyncQueueId: string,
    branchCode: string,
    region: string,
  ): Promise<EnrichedOrderData> {
    this.logger.log(`Enriching order ${orderSyncQueueId}...`);

    // 1. Get order from OrderSyncQueue
    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { id: orderSyncQueueId },
    });

    if (!order) {
      throw new Error(`Order not found: ${orderSyncQueueId}`);
    }

    this.logger.log(`Processing order ${order.odooOrderNumber}...`);

    // 2. Try to get data from backup tables
    const backupOrder = await this.prisma.backupOdooOrder.findFirst({
      where: { orderName: order.odooOrderNumber },
    });

    if (backupOrder) {
      const backupLines = await this.prisma.backupOdooOrderLine.findMany({
        where: { orderId: backupOrder.orderId },
      });
      const backupPayments = await this.prisma.backupOdooOrderPayment.findMany({
        where: { orderId: backupOrder.orderId },
      });
      
      if (backupLines.length > 0) {
        this.logger.log(`Found ${backupLines.length} lines in backup tables`);
        return this.buildPayloadsFromBackup(order, backupLines, backupPayments, branchCode, region);
      }
    }

    // 3. If no backup data found, create minimal payloads as fallback
    this.logger.warn(`No backup data found for order ${order.odooOrderNumber}, using minimal fallback`);
    return this.createMinimalPayloads(order, branchCode, region);
  }


  private async buildPayloadsFromBackup(
    order: any, 
    backupLines: any[], 
    backupPayments: any[],
    branchCode: string,
    region: string
  ): Promise<EnrichedOrderData> {
    // ✅ FETCH from FusionSalesMetadata
    const metadata = await this.fusionMetadataService.getSalesMetadata(region);
    
    if (!metadata) {
      throw new Error(`No FusionSalesMetadata found for region: ${region}`);
    }

    this.logger.log(`Using FusionSalesMetadata for region ${region}:`, {
      billToName: metadata.billToName,
      billToAccount: metadata.billToAccount,
      businessUnit: metadata.businessUnit,
      txnSource: metadata.txnSource,
      txnType: metadata.txnType,
    });

    const saleDate = order.orderDate instanceof Date ? order.orderDate : new Date();

    // ✅ BUILD FROM METADATA
    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: metadata.billToName || 'Default Customer',
      billToLocation: metadata.siteNumber || '',
      billToAccountNumber: String(metadata.billToAccount || '1000'),
      businessUnit: metadata.businessUnit || 'AlQurashi-KSA',
      outletName: order.branchName || branchCode,
      saleDate,
      transactionSource: metadata.txnSource || 'Vend',
      transactionType: metadata.txnType || 'Vend Invoice',
      invoiceCurrencyCode: order.currency || 'AED',
      conversionRateType: metadata.rateIsCorporate ? 'Corporate' : 'User',
      invoiceLines: [],  // Now properly typed as InvoiceLine[]
    };

    // Build invoice lines from backup data
    for (const line of backupLines) {
      const qty = this.toNumber(line.qty || 1);
      const unitPrice = this.toNumber(line.priceUnit || 0);
      const subtotal = this.toNumber(line.priceSubtotal || 0);
      
      // Skip discount items or zero amounts if needed
      if (qty === 0 && subtotal === 0) continue;

      // Extract product code from product name if it has pattern [CODE]
      let productCode = '';
      let productName = line.productName || 'Product';
      const match = productName.match(/\[([^\]]+)\]/);
      if (match) {
        productCode = match[1];
        productName = productName.replace(/\[[^\]]+\]\s*/, '');
      }

      const invoiceLine: InvoiceLine = {
        lineNumber: invoiceHeader.invoiceLines.length + 1,
        itemNumber: productCode || String(line.productId || ''),
        description: productName,
        quantity: qty,
        unitSellingPrice: unitPrice || (qty > 0 ? subtotal / qty : 0),
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: order.odooOrderNumber || '',  // ✅ Always string, never undefined
        salesOrderLine: String(invoiceHeader.invoiceLines.length + 1),
      };
      
      invoiceHeader.invoiceLines.push(invoiceLine);
    }

    // If no valid lines, create one from total
    if (invoiceHeader.invoiceLines.length === 0) {
      this.logger.warn(`No valid lines for order ${order.odooOrderNumber}, creating synthetic line`);
      
      const syntheticLine: InvoiceLine = {
        lineNumber: 1,
        description: order.odooOrderNumber || 'Sale',
        quantity: 1,
        unitSellingPrice: this.toNumber(order.totalAmount || 0),
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: order.odooOrderNumber || '',  // ✅ Always string, never undefined
        salesOrderLine: '1',
      };
      
      invoiceHeader.invoiceLines.push(syntheticLine);
    }

    // Build receipts from backup payments
    const standardReceipts: ReceiptRequest[] = [];
    const applyReceipts: ApplyReceiptRequest[] = [];

    for (const payment of backupPayments) {
      const amount = this.toNumber(payment.amount || 0);
      const method = payment.paymentName || 'DEFAULT';
      
      if (amount === 0) continue;

      const receiptNumber = `${method}-${order.odooOrderNumber}-${Date.now()}`;

      // Create standard receipt
      const receipt: ReceiptRequest = {
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        saleDate,
        receiptMethodId: 1,
        receiptNumber,
        remittanceBankAccountId: 1000,
        accountValue: invoiceHeader.billToAccountNumber,
        orgId: 1,
        receiptAmount: amount,
      };
      standardReceipts.push(receipt);

      // Create apply receipt
      const applyReceipt: ApplyReceiptRequest = {
        receiptDate: saleDate,
        transactionNumber: order.odooOrderNumber,
        receiptNumber,
        amountApplied: amount,
        receiptCurrency: invoiceHeader.invoiceCurrencyCode,
        transactionSource: invoiceHeader.transactionSource,
      };
      applyReceipts.push(applyReceipt);
    }

    // If no payments, create one from total
    if (standardReceipts.length === 0) {
      const total = this.toNumber(order.totalAmount || 0);
      if (total > 0) {
        const receiptNumber = `DEFAULT-${order.odooOrderNumber}-${Date.now()}`;
        
        const receipt: ReceiptRequest = {
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: 1,
          receiptNumber,
          remittanceBankAccountId: 1000,
          accountValue: invoiceHeader.billToAccountNumber,
          orgId: 1,
          receiptAmount: total,
        };
        standardReceipts.push(receipt);

        const applyReceipt: ApplyReceiptRequest = {
          receiptDate: saleDate,
          transactionNumber: order.odooOrderNumber,
          receiptNumber,
          amountApplied: total,
          receiptCurrency: invoiceHeader.invoiceCurrencyCode,
          transactionSource: invoiceHeader.transactionSource,
        };
        applyReceipts.push(applyReceipt);
      }
    }

    this.logger.log(
      `Built ${invoiceHeader.invoiceLines.length} lines, ${standardReceipts.length} receipts for order ${order.odooOrderNumber}`
    );

    return {
      invoiceHeader,
      standardReceipts,
      miscReceipts: [],
      applyReceipts,
      journalHeaders: [],
    };
  }

  private async createMinimalPayloads(order: any, branchCode: string, region: string): Promise<EnrichedOrderData> {
    // ✅ FETCH from FusionSalesMetadata
    const metadata = await this.fusionMetadataService.getSalesMetadata(region);
    
    if (!metadata) {
      throw new Error(`No FusionSalesMetadata found for region: ${region}`);
    }

    this.logger.log(`Using FusionSalesMetadata for region ${region}:`, {
      billToName: metadata.billToName,
      billToAccount: metadata.billToAccount,
      businessUnit: metadata.businessUnit,
      txnSource: metadata.txnSource,
      txnType: metadata.txnType,
    });

    const saleDate = order.orderDate instanceof Date ? order.orderDate : new Date();
    const total = this.toNumber(order.totalAmount || 0);

    // ✅ BUILD FROM METADATA
    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: metadata.billToName || 'Default Customer',
      billToLocation: metadata.siteNumber || '',
      billToAccountNumber: String(metadata.billToAccount || '1000'),
      businessUnit: metadata.businessUnit || 'AlQurashi-KSA',
      outletName: order.branchName || branchCode,
      saleDate,
      transactionSource: metadata.txnSource || 'Vend',
      transactionType: metadata.txnType || 'Vend Invoice',
      invoiceCurrencyCode: order.currency || 'AED',
      conversionRateType: metadata.rateIsCorporate ? 'Corporate' : 'User',
      invoiceLines: [{
        lineNumber: 1,
        description: order.odooOrderNumber || 'Sale',
        quantity: 1,
        unitSellingPrice: total,
        currencyCode: order.currency || 'AED',
        salesOrder: order.odooOrderNumber || '',  // ✅ Always string, never undefined
        salesOrderLine: '1',
      }],
    };

    const standardReceipts: ReceiptRequest[] = [];
    const applyReceipts: ApplyReceiptRequest[] = [];

    if (total > 0) {
      const receiptNumber = `MINIMAL-${order.odooOrderNumber}-${Date.now()}`;
      
      standardReceipts.push({
        currencyCode: order.currency || 'AED',
        saleDate,
        receiptMethodId: 1,
        receiptNumber,
        remittanceBankAccountId: 1000,
        accountValue: '1000',
        orgId: 1,
        receiptAmount: total,
      });

      applyReceipts.push({
        receiptDate: saleDate,
        transactionNumber: order.odooOrderNumber,
        receiptNumber,
        amountApplied: total,
        receiptCurrency: order.currency || 'AED',
        transactionSource: 'Odoo',
      });
    }

    return {
      invoiceHeader,
      standardReceipts,
      miscReceipts: [],
      applyReceipts,
      journalHeaders: [],
    };
  }
}
