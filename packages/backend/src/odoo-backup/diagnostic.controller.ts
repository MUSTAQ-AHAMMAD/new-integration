import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Diagnostic controller to help troubleshoot Odoo backup data issues.
 * Provides endpoints to inspect the raw JSON structure returned by Odoo.
 */
@ApiTags('odoo-backup-diagnostics')
@Controller('odoo-backup/diagnostics')
export class OdooBackupDiagnosticsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Analyze the structure of a specific order's raw JSON to diagnose why
   * line items or payments might not be stored.
   */
  @Get('analyze-order/:orderId')
  @ApiOperation({
    summary:
      'Analyze raw JSON structure of an order to diagnose missing lines/payments',
  })
  async analyzeOrder(@Param('orderId') orderId: string) {
    const order = await this.prisma.backupOdooOrder.findFirst({
      where: { orderId: parseInt(orderId, 10) },
      select: {
        id: true,
        orderId: true,
        orderName: true,
        rawJson: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (!order.rawJson || typeof order.rawJson !== 'object') {
      return {
        orderId: order.orderId,
        orderName: order.orderName,
        error: 'No rawJson data available',
      };
    }

    const raw = order.rawJson as Record<string, unknown>;
    const analysis: Record<string, unknown> = {
      orderId: order.orderId,
      orderName: order.orderName,
      lineItems: this.analyzeLineItems(raw),
      payments: this.analyzePayments(raw),
      actualCounts: await this.getActualCounts(order.orderId),
    };

    return analysis;
  }

  /**
   * Get a summary of all orders and identify how many have proper embedded data.
   */
  @Get('summary')
  @ApiOperation({
    summary:
      'Get summary of backup data quality (orders with/without embedded lines/payments)',
  })
  async getSummary() {
    const totalOrders = await this.prisma.backupOdooOrder.count();
    const totalLines = await this.prisma.backupOdooOrderLine.count();
    const totalPayments = await this.prisma.backupOdooOrderPayment.count();

    // Get a sample order to analyze
    const sampleOrder = await this.prisma.backupOdooOrder.findFirst({
      where: { rawJson: { not: null } },
      select: { orderId: true, orderName: true, rawJson: true },
    });

    let sampleAnalysis = null;
    if (sampleOrder && sampleOrder.rawJson) {
      const raw = sampleOrder.rawJson as Record<string, unknown>;
      sampleAnalysis = {
        orderId: sampleOrder.orderId,
        orderName: sampleOrder.orderName,
        lineItems: this.analyzeLineItems(raw),
        payments: this.analyzePayments(raw),
      };
    }

    return {
      summary: {
        totalOrders,
        totalLines,
        totalPayments,
        avgLinesPerOrder: totalOrders > 0 ? totalLines / totalOrders : 0,
        avgPaymentsPerOrder: totalOrders > 0 ? totalPayments / totalOrders : 0,
      },
      diagnosis: {
        linesIssue:
          totalOrders > 0 && totalLines === 0
            ? 'NO LINE ITEMS STORED - Odoo API likely returning integer IDs instead of embedded objects'
            : totalLines < totalOrders * 0.5
              ? 'PARTIAL LINE ITEMS - Some orders missing line data'
              : 'Line items appear healthy',
        paymentsIssue:
          totalOrders > 0 && totalPayments === 0
            ? 'NO PAYMENTS STORED - Odoo API likely returning integer IDs instead of embedded objects'
            : totalPayments < totalOrders * 0.5
              ? 'PARTIAL PAYMENTS - Some orders missing payment data'
              : 'Payments appear healthy',
      },
      sampleAnalysis,
      solution:
        totalLines === 0 || totalPayments === 0
          ? {
              problem:
                'The Odoo API is returning line_ids and/or payment_ids as integer arrays instead of full embedded objects',
              fix: 'Configure your Odoo REST API endpoint to expand related fields. This typically requires adding fields expansion parameters or using a different API endpoint that supports embedding child records.',
              endpoints_to_check: [
                '/api/pos/order - Check if this endpoint supports ?fields parameter',
                '/api/sale.order - Alternative endpoint that may have different embedding behavior',
              ],
            }
          : null,
    };
  }

  private analyzeLineItems(raw: Record<string, unknown>) {
    const analysis: Record<string, unknown> = {};

    // Check 'lines' field
    if (raw.lines !== undefined) {
      analysis.lines = this.analyzeArrayField(raw.lines, 'lines');
    }

    // Check 'order_line' field
    if (raw.order_line !== undefined) {
      analysis.order_line = this.analyzeArrayField(
        raw.order_line,
        'order_line',
      );
    }

    // Check 'line_ids' field
    if (raw.line_ids !== undefined) {
      analysis.line_ids = this.analyzeArrayField(raw.line_ids, 'line_ids');
    }

    if (Object.keys(analysis).length === 0) {
      return { status: 'NO_LINE_FIELDS_FOUND', issue: 'No line item fields present in raw JSON' };
    }

    return analysis;
  }

  private analyzePayments(raw: Record<string, unknown>) {
    const analysis: Record<string, unknown> = {};

    // Check 'statement_ids' field
    if (raw.statement_ids !== undefined) {
      analysis.statement_ids = this.analyzeArrayField(
        raw.statement_ids,
        'statement_ids',
      );
    }

    // Check 'payment_ids' field
    if (raw.payment_ids !== undefined) {
      analysis.payment_ids = this.analyzeArrayField(
        raw.payment_ids,
        'payment_ids',
      );
    }

    // Check 'payments' field
    if (raw.payments !== undefined) {
      analysis.payments = this.analyzeArrayField(raw.payments, 'payments');
    }

    if (Object.keys(analysis).length === 0) {
      return { status: 'NO_PAYMENT_FIELDS_FOUND', issue: 'No payment fields present in raw JSON' };
    }

    return analysis;
  }

  private analyzeArrayField(field: unknown, fieldName: string) {
    if (!Array.isArray(field)) {
      return {
        status: 'NOT_ARRAY',
        type: typeof field,
        issue: `${fieldName} is not an array`,
      };
    }

    if (field.length === 0) {
      return {
        status: 'EMPTY_ARRAY',
        count: 0,
        issue: `${fieldName} is an empty array`,
      };
    }

    const firstItem = field[0];
    const itemType = typeof firstItem;

    if (itemType === 'number') {
      return {
        status: 'INTEGER_IDS_ONLY',
        count: field.length,
        firstValue: firstItem,
        issue: `⚠️ PROBLEM: ${fieldName} contains integer IDs (${field.slice(0, 3).join(', ')}) instead of embedded objects`,
        solution: `Configure Odoo API to return expanded ${fieldName} with full object details`,
      };
    }

    if (itemType === 'object' && firstItem !== null) {
      const keys = Object.keys(firstItem as Record<string, unknown>);
      return {
        status: 'EMBEDDED_OBJECTS',
        count: field.length,
        firstItemKeys: keys.slice(0, 10),
        success: `✓ ${fieldName} contains proper embedded objects`,
      };
    }

    return {
      status: 'UNKNOWN',
      count: field.length,
      firstItemType: itemType,
      issue: `${fieldName} contains unexpected data type: ${itemType}`,
    };
  }

  private async getActualCounts(orderId: number) {
    const lineCount = await this.prisma.backupOdooOrderLine.count({
      where: { orderId },
    });
    const paymentCount = await this.prisma.backupOdooOrderPayment.count({
      where: { orderId },
    });

    return {
      storedLines: lineCount,
      storedPayments: paymentCount,
    };
  }
}
