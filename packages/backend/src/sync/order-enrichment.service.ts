import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

export interface ApplyReceiptRequest {
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

  /**
   * Convert Prisma Decimal or BigInt to number safely
   * Handles various data types that can come from Prisma queries
   */
  private toNumber(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseFloat(value) || 0;
    
    // Handle Prisma Decimal internal structure: { s: 1, e: 2, d: [299, 200000] }
    if (value && typeof value === 'object' && 's' in value && 'e' in value && 'd' in value) {
      try {
        // Reconstruct the number from the Decimal structure
        const decimalParts = value.d;
        let result = 0;
        for (let i = 0; i < decimalParts.length; i++) {
          result += decimalParts[i] * Math.pow(10, (decimalParts.length - 1 - i) - (value.e || 0));
        }
        return result * (value.s || 1);
      } catch {
        return 0;
      }
    }
    
    // Handle Prisma Decimal with toNumber method
    if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
      return value.toNumber();
    }
    
    return Number(value) || 0;
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

    // 2. Get order lines from the queue (already stored)
    const orderLines = order.orderLines as any[] || [];
    
    // 3. Get order payments from the queue (already stored)
    const orderPayments = order.orderPayments as any[] || [];

    this.logger.log(
      `Order ${order.odooOrderNumber}: ${orderLines.length} lines, ${orderPayments.length} payments found in queue`
    );

    // 4. If NO lines in queue, try backup tables
    if (orderLines.length === 0) {
      this.logger.log(`No lines in queue, checking backup tables...`);
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
    }

    // 5. Build payloads from queue data
    return this.buildPayloadsFromQueue(order, orderLines, orderPayments, branchCode, region);
  }

  private buildPayloadsFromQueue(
    order: any,
    orderLines: any[],
    orderPayments: any[],
    branchCode: string,
    region: string,
  ): EnrichedOrderData {
    const saleDate = order.orderDate instanceof Date ? order.orderDate : new Date();
    const totalAmount = this.toNumber(order.totalAmount);
    const currency = order.currency || 'AED';

    this.logger.log(`Building payloads for order ${order.odooOrderNumber} with ${orderLines.length} lines`);

    // Build invoice header
    const invoiceHeader: InvoiceHeader = {
      billToCustomerName: order.customerName || 'Default Customer',
      billToLocation: '',
      billToAccountNumber: '1000',
      businessUnit: 'BU1',
      outletName: order.branchName || branchCode,
      saleDate,
      transactionSource: 'Odoo',
      transactionType: 'Invoice',
      invoiceCurrencyCode: currency,
      conversionRateType: 'Corporate',
      invoiceLines: [],
    };

    // Build invoice lines from queue data
    for (const line of orderLines) {
      const qty = this.toNumber(line.qty || line.quantity || 1);
      if (qty === 0) continue;

      const unitPrice = this.toNumber(line.priceUnit || line.unitPrice || 0);
      const subtotal = this.toNumber(line.priceSubtotal || line.subtotal || 0);

      // Extract product code from product name if it has pattern [CODE]
      let productCode = line.productCode || '';
      let productName = line.productName || 'Product';
      const match = productName.match(/\[([^\]]+)\]/);
      if (match) {
        productCode = match[1];
        productName = productName.replace(/\[[^\]]+\]\s*/, '');
      }

      invoiceHeader.invoiceLines.push({
        lineNumber: invoiceHeader.invoiceLines.length + 1,
        itemNumber: productCode || String(line.productId || ''),
        description: productName,
        quantity: qty,
        unitSellingPrice: unitPrice || (qty > 0 ? subtotal / qty : 0),
        currencyCode: currency,
        salesOrder: order.odooOrderNumber || '',
        salesOrderLine: String(invoiceHeader.invoiceLines.length + 1),
      });
    }

    // If no lines, create one from total
    if (invoiceHeader.invoiceLines.length === 0) {
      this.logger.warn(`No lines for order ${order.odooOrderNumber}, creating synthetic line`);
      invoiceHeader.invoiceLines.push({
        lineNumber: 1,
        description: order.odooOrderNumber || 'Sale',
        quantity: 1,
        unitSellingPrice: totalAmount,
        currencyCode: currency,
        salesOrder: order.odooOrderNumber || '',
        salesOrderLine: '1',
      });
    }

    // Build receipts from payments
    const standardReceipts: ReceiptRequest[] = [];
    const applyReceipts: ApplyReceiptRequest[] = [];

    for (const payment of orderPayments) {
      const amount = this.toNumber(payment.amount || 0);
      const method = payment.paymentName || payment.name || 'DEFAULT';
      
      if (amount === 0) continue;

      const receiptNumber = `${method}-${order.odooOrderNumber}-${Date.now()}`;

      standardReceipts.push({
        currencyCode: currency,
        saleDate,
        receiptMethodId: 1,
        receiptNumber,
        remittanceBankAccountId: 1000,
        accountValue: '1000',
        orgId: 1,
        receiptAmount: amount,
      });

      applyReceipts.push({
        transactionNumber: order.odooOrderNumber,
        receiptNumber,
        amountApplied: amount,
        receiptCurrency: currency,
        transactionSource: 'Odoo',
        accountingDate: saleDate,
        applicationDate: saleDate,
      });
    }

    // If no payments, create one from total
    if (standardReceipts.length === 0 && totalAmount > 0) {
      const receiptNumber = `DEFAULT-${order.odooOrderNumber}-${Date.now()}`;
      
      standardReceipts.push({
        currencyCode: currency,
        saleDate,
        receiptMethodId: 1,
        receiptNumber,
        remittanceBankAccountId: 1000,
        accountValue: '1000',
        orgId: 1,
        receiptAmount: totalAmount,
      });

      applyReceipts.push({
        transactionNumber: order.odooOrderNumber,
        receiptNumber,
        amountApplied: totalAmount,
        receiptCurrency: currency,
        transactionSource: 'Odoo',
        accountingDate: saleDate,
        applicationDate: saleDate,
      });
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
    const total = this.toNumber(order.totalAmount || 0);

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
