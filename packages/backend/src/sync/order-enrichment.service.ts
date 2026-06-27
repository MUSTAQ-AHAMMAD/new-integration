import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Define the types properly
interface InvoiceLine {
  lineNumber: number;
  itemNumber?: string;
  description?: string;
  quantity: number;
  unitSellingPrice: number;
  currencyCode: string;
  salesOrder?: string;
  salesOrderLine?: string;
  memoLineName?: string;
}

interface InvoiceHeader {
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

interface ReceiptRequest {
  currencyCode: string;
  saleDate: Date;
  receiptMethodId: number;
  receiptNumber: string;
  remittanceBankAccountId: number;
  accountValue: string;
  orgId: number;
  receiptAmount: number;
}

interface ApplyReceiptRequest {
  transactionNumber: string;
  receiptNumber: string;
  amountApplied: number;
  receiptCurrency: string;
  transactionSource: string;
  accountingDate: Date;
  applicationDate: Date;
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

  constructor(private readonly prisma: PrismaService) {}

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

    // 2. Get ORDER LINES from BackupOdooOrderLine table
    const backupLines = await this.prisma.backupOdooOrderLine.findMany({
      where: { 
        orderId: order.odooOrderNumber,
      },
    });

    // 3. Get PAYMENTS from BackupOdooOrderPayments table
    const backupPayments = await this.prisma.backupOdooOrderPayment.findMany({
      where: { 
        orderId: order.odooOrderNumber,
      },
    });

    this.logger.log(
      `Order ${order.odooOrderNumber}: ${backupLines.length} lines, ${backupPayments.length} payments found in backup tables`
    );

    // 4. If data exists in backup tables, use it
    if (backupLines.length === 0 && backupPayments.length === 0) {
      this.logger.warn(`No backup data found for order ${order.odooOrderNumber}, creating minimal data`);
      return this.createMinimalPayloads(order, branchCode, region);
    }

    // 5. Build Oracle payloads from backup data
    return this.buildPayloadsFromBackup(order, backupLines, backupPayments, branchCode, region);
  }

  private buildPayloadsFromBackup(
    order: any, 
    backupLines: any[], 
    backupPayments: any[],
    branchCode: string,
    region: string
  ): EnrichedOrderData {
    const saleDate = order.orderDate instanceof Date ? order.orderDate : new Date();

    // Build invoice header with proper typing
    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: order.customerName || 'Default Customer',
      billToLocation: '',
      billToAccountNumber: '1000',
      businessUnit: 'BU1',
      outletName: order.branchName || branchCode,
      saleDate,
      transactionSource: 'Odoo',
      transactionType: 'Invoice',
      invoiceCurrencyCode: order.currency || 'AED',
      conversionRateType: 'Corporate',
      invoiceLines: [],  // Now properly typed as InvoiceLine[]
    };

    // Build invoice lines from backup data
    for (const line of backupLines) {
      const qty = Number(line.qty || 1);
      const unitPrice = Number(line.priceUnit || 0);
      const subtotal = Number(line.priceSubtotal || 0);
      
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
        salesOrder: order.odooOrderNumber,
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
        unitSellingPrice: Number(order.totalAmount || 0),
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: order.odooOrderNumber,
        salesOrderLine: '1',
      };
      
      invoiceHeader.invoiceLines.push(syntheticLine);
    }

    // Build receipts from backup payments
    const standardReceipts: ReceiptRequest[] = [];
    const applyReceipts: ApplyReceiptRequest[] = [];

    for (const payment of backupPayments) {
      const amount = Number(payment.amount || 0);
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
        transactionNumber: order.odooOrderNumber,
        receiptNumber,
        amountApplied: amount,
        receiptCurrency: invoiceHeader.invoiceCurrencyCode,
        transactionSource: invoiceHeader.transactionSource,
        accountingDate: saleDate,
        applicationDate: saleDate,
      };
      applyReceipts.push(applyReceipt);
    }

    // If no payments, create one from total
    if (standardReceipts.length === 0) {
      const total = Number(order.totalAmount || 0);
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
          transactionNumber: order.odooOrderNumber,
          receiptNumber,
          amountApplied: total,
          receiptCurrency: invoiceHeader.invoiceCurrencyCode,
          transactionSource: invoiceHeader.transactionSource,
          accountingDate: saleDate,
          applicationDate: saleDate,
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

  private createMinimalPayloads(order: any, branchCode: string, region: string): EnrichedOrderData {
    const saleDate = order.orderDate instanceof Date ? order.orderDate : new Date();
    const total = Number(order.totalAmount || 0);

    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: order.customerName || 'Default Customer',
      billToLocation: '',
      billToAccountNumber: '1000',
      businessUnit: 'BU1',
      outletName: order.branchName || branchCode,
      saleDate,
      transactionSource: 'Odoo',
      transactionType: 'Invoice',
      invoiceCurrencyCode: order.currency || 'AED',
      conversionRateType: 'Corporate',
      invoiceLines: [{
        lineNumber: 1,
        description: order.odooOrderNumber || 'Sale',
        quantity: 1,
        unitSellingPrice: total,
        currencyCode: order.currency || 'AED',
        salesOrder: order.odooOrderNumber,
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
        transactionNumber: order.odooOrderNumber,
        receiptNumber,
        amountApplied: total,
        receiptCurrency: order.currency || 'AED',
        transactionSource: 'Odoo',
        accountingDate: saleDate,
        applicationDate: saleDate,
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
