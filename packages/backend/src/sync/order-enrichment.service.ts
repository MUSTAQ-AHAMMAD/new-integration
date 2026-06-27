import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface EnrichedOrderData {
  invoiceHeader: any;
  standardReceipts: any[];
  miscReceipts: any[];
  applyReceipts: any[];
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
    //    Use order.odooOrderNumber to link (not orderSyncQueueId)
    const backupLines = await this.prisma.backupOdooOrderLine.findMany({
      where: { 
        orderId: parseInt(order.odooOrderNumber, 10),  // This links to the order
      },
    });

    // 3. Get PAYMENTS from BackupOdooOrderPayment table
    const backupPayments = await this.prisma.backupOdooOrderPayment.findMany({
      where: { 
        orderId: parseInt(order.odooOrderNumber, 10),  // This links to the order
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
  ) {
    const saleDate = order.orderDate instanceof Date ? order.orderDate : new Date();

    // Build invoice header
    const invoiceHeader = {
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
      invoiceLines: [],
    };

    // Build invoice lines from backup data
    for (const line of backupLines) {
      const qty = Number(line.qty || 1);
      const unitPrice = Number(line.priceUnit || 0);
      const subtotal = Number(line.priceSubtotal || 0);
      
      // Skip discount items or zero amounts if needed
      if (qty === 0 && subtotal === 0) continue;

      invoiceHeader.invoiceLines.push({
        lineNumber: invoiceHeader.invoiceLines.length + 1,
        itemNumber: line.productName?.split(']')[0]?.replace('[', '') || String(line.productId || ''),
        description: line.productName || 'Product',
        quantity: qty,
        unitSellingPrice: unitPrice || (qty > 0 ? subtotal / qty : 0),
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: order.odooOrderNumber,
        salesOrderLine: String(invoiceHeader.invoiceLines.length + 1),
      });
    }

    // If no valid lines, create one from total
    if (invoiceHeader.invoiceLines.length === 0) {
      this.logger.warn(`No valid lines for order ${order.odooOrderNumber}, creating synthetic line`);
      invoiceHeader.invoiceLines.push({
        lineNumber: 1,
        description: order.odooOrderNumber || 'Sale',
        quantity: 1,
        unitSellingPrice: Number(order.totalAmount || 0),
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: order.odooOrderNumber,
        salesOrderLine: '1',
      });
    }

    // Build receipts from backup payments
    const standardReceipts = [];
    const applyReceipts = [];

    for (const payment of backupPayments) {
      const amount = Number(payment.amount || 0);
      const method = payment.paymentName || 'DEFAULT';
      
      if (amount === 0) continue;

      // Create standard receipt
      standardReceipts.push({
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        saleDate,
        receiptMethodId: 1,  // You may need to map this properly
        receiptNumber: `${method}-${order.odooOrderNumber}-${Date.now()}`,
        remittanceBankAccountId: 1000,
        accountValue: invoiceHeader.billToAccountNumber,
        orgId: 1,
        receiptAmount: amount,
      });

      // Create apply receipt
      applyReceipts.push({
        transactionNumber: order.odooOrderNumber,
        receiptNumber: `${method}-${order.odooOrderNumber}-${Date.now()}`,
        amountApplied: amount,
        receiptCurrency: invoiceHeader.invoiceCurrencyCode,
        transactionSource: invoiceHeader.transactionSource,
        accountingDate: saleDate,
        applicationDate: saleDate,
      });
    }

    // If no payments, create one from total
    if (standardReceipts.length === 0) {
      const total = Number(order.totalAmount || 0);
      if (total > 0) {
        standardReceipts.push({
          currencyCode: invoiceHeader.invoiceCurrencyCode,
          saleDate,
          receiptMethodId: 1,
          receiptNumber: `DEFAULT-${order.odooOrderNumber}-${Date.now()}`,
          remittanceBankAccountId: 1000,
          accountValue: invoiceHeader.billToAccountNumber,
          orgId: 1,
          receiptAmount: total,
        });

        applyReceipts.push({
          transactionNumber: order.odooOrderNumber,
          receiptNumber: `DEFAULT-${order.odooOrderNumber}-${Date.now()}`,
          amountApplied: total,
          receiptCurrency: invoiceHeader.invoiceCurrencyCode,
          transactionSource: invoiceHeader.transactionSource,
          accountingDate: saleDate,
          applicationDate: saleDate,
        });
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

  private createMinimalPayloads(order: any, branchCode: string, region: string) {
    const saleDate = order.orderDate instanceof Date ? order.orderDate : new Date();
    const total = Number(order.totalAmount || 0);

    return {
      invoiceHeader: {
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
      },
      standardReceipts: total > 0 ? [{
        currencyCode: order.currency || 'AED',
        saleDate,
        receiptMethodId: 1,
        receiptNumber: `MINIMAL-${order.odooOrderNumber}-${Date.now()}`,
        remittanceBankAccountId: 1000,
        accountValue: '1000',
        orgId: 1,
        receiptAmount: total,
      }] : [],
      miscReceipts: [],
      applyReceipts: total > 0 ? [{
        transactionNumber: order.odooOrderNumber,
        receiptNumber: `MINIMAL-${order.odooOrderNumber}-${Date.now()}`,
        amountApplied: total,
        receiptCurrency: order.currency || 'AED',
        transactionSource: 'Odoo',
        accountingDate: saleDate,
        applicationDate: saleDate,
      }] : [],
      journalHeaders: [],
    };
  }
}
