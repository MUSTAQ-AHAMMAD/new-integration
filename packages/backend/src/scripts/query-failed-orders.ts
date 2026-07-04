/**
 * Query Failed Orders - Database analysis tool for Status E failures
 *
 * This script provides comprehensive queries to analyze failed orders
 * and identify patterns in Oracle Status E errors.
 *
 * Usage:
 *   npm run query:failed-orders
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

class FailedOrdersAnalyzer {
  constructor(private readonly prisma: PrismaService) {}

  async run() {
    console.log(
      '╔══════════════════════════════════════════════════════════════╗',
    );
    console.log(
      '║   Failed Orders Analysis - Status E Diagnostic              ║',
    );
    console.log(
      '╚══════════════════════════════════════════════════════════════╝\n',
    );

    await this.showSummaryStatistics();
    await this.showFailedOrdersByBranch();
    await this.showFailedOrdersByErrorMessage();
    await this.showRecentFailures();
    await this.showStoreConfigIssues();
    await this.showInvoiceAuditFailures();
    await this.showSuccessVsFailureByBranch();
  }

  private async showSummaryStatistics() {
    console.log('📊 Summary Statistics');
    console.log(
      '─────────────────────────────────────────────────────────────\n',
    );

    const [total, pending, processing, synced, failed, skipped] =
      await Promise.all([
        this.prisma.orderSyncQueue.count(),
        this.prisma.orderSyncQueue.count({ where: { status: 'PENDING' } }),
        this.prisma.orderSyncQueue.count({ where: { status: 'PROCESSING' } }),
        this.prisma.orderSyncQueue.count({ where: { status: 'SYNCED' } }),
        this.prisma.orderSyncQueue.count({ where: { status: 'FAILED' } }),
        this.prisma.orderSyncQueue.count({ where: { status: 'SKIPPED' } }),
      ]);

    console.log(`   Total Orders: ${total}`);
    console.log(
      `   ├─ Pending: ${pending} (${this.percentage(pending, total)}%)`,
    );
    console.log(
      `   ├─ Processing: ${processing} (${this.percentage(processing, total)}%)`,
    );
    console.log(`   ├─ Synced: ${synced} (${this.percentage(synced, total)}%)`);
    console.log(`   ├─ Failed: ${failed} (${this.percentage(failed, total)}%)`);
    console.log(
      `   └─ Skipped: ${skipped} (${this.percentage(skipped, total)}%)\n`,
    );

    const statusECount = await this.prisma.failedTransaction.count({
      where: {
        errorMessage: { contains: 'Status E' },
        orderSyncQueueId: { not: null },
      },
    });

    console.log(
      `   Failed Orders with Status E: ${statusECount} (${this.percentage(statusECount, failed)}% of failures)\n`,
    );
  }

  private async showFailedOrdersByBranch() {
    console.log('🏢 Failed Orders by Branch');
    console.log(
      '─────────────────────────────────────────────────────────────\n',
    );

    const failuresByBranch = await this.prisma.orderSyncQueue.groupBy({
      by: ['branchCode'],
      where: { status: 'FAILED' },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });

    if (failuresByBranch.length === 0) {
      console.log('   ✅ No failed orders\n');
      return;
    }

    failuresByBranch.forEach((item, index) => {
      console.log(
        `   ${index + 1}. ${item.branchCode}: ${item._count.id} failures`,
      );
    });
    console.log();
  }

  private async showFailedOrdersByErrorMessage() {
    console.log('📝 Common Error Messages');
    console.log(
      '─────────────────────────────────────────────────────────────\n',
    );

    const failedTransactions = await this.prisma.failedTransaction.findMany({
      where: {
        orderSyncQueueId: { not: null },
      },
      select: {
        errorMessage: true,
        errorType: true,
      },
      take: 100,
    });

    const errorPatterns = new Map<string, number>();

    failedTransactions.forEach((transaction) => {
      if (!transaction.errorMessage) return;

      // Extract key phrases from error messages
      let pattern = 'Unknown error';

      if (transaction.errorMessage.includes('Status E')) {
        pattern = 'Status E (no details)';

        // Try to extract specific Oracle errors
        const matches = [
          /not found/i,
          /invalid/i,
          /duplicate/i,
          /timeout/i,
          /Business Unit/i,
          /Transaction Source/i,
          /Transaction Type/i,
          /Customer/i,
          /Item/i,
          /Payment Terms/i,
        ];

        for (const regex of matches) {
          if (regex.test(transaction.errorMessage)) {
            pattern = `Status E: ${regex.toString().replace(/[/i]/g, '')}`;
            break;
          }
        }
      } else if (transaction.errorMessage.includes('timeout')) {
        pattern = 'Timeout error';
      } else if (transaction.errorMessage.includes('not found')) {
        pattern = 'Not found error';
      } else if (transaction.errorMessage.includes('validation')) {
        pattern = 'Validation error';
      }

      errorPatterns.set(pattern, (errorPatterns.get(pattern) || 0) + 1);
    });

    const sorted = Array.from(errorPatterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sorted.length === 0) {
      console.log('   ✅ No error patterns found\n');
      return;
    }

    sorted.forEach(([pattern, count], index) => {
      console.log(`   ${index + 1}. ${pattern}: ${count} occurrences`);
    });
    console.log();
  }

  private async showRecentFailures() {
    console.log('🕐 Recent Failures (Last 10)');
    console.log(
      '─────────────────────────────────────────────────────────────\n',
    );

    const recentFailedTransactions =
      await this.prisma.failedTransaction.findMany({
        where: {
          errorMessage: { contains: 'Status E' },
          orderSyncQueueId: { not: null },
        },
        include: {
          orderSyncQueue: {
            select: {
              odooOrderId: true,
              odooOrderNumber: true,
              branchCode: true,
              totalAmount: true,
              currency: true,
              syncAttempts: true,
              updatedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

    if (recentFailedTransactions.length === 0) {
      console.log('   ✅ No recent Status E failures\n');
      return;
    }

    recentFailedTransactions.forEach((transaction, index) => {
      const order = transaction.orderSyncQueue;
      if (!order) return;

      console.log(
        `   ${index + 1}. Order ${order.odooOrderNumber || order.odooOrderId}`,
      );
      console.log(`      Branch: ${order.branchCode}`);
      console.log(
        `      Amount: ${String(order.totalAmount)} ${order.currency}`,
      );
      console.log(`      Attempts: ${order.syncAttempts}`);
      console.log(`      Updated: ${order.updatedAt.toISOString()}`);
      console.log(
        `      Error: ${transaction.errorMessage?.substring(0, 100)}...`,
      );
      console.log();
    });
  }

  private async showStoreConfigIssues() {
    console.log('⚙️  Store Configuration Issues');
    console.log(
      '─────────────────────────────────────────────────────────────\n',
    );

    const configs = await this.prisma.storeConfiguration.findMany({
      where: {
        OR: [
          { isActive: false },
          { validationStatus: { in: ['INVALID', 'PENDING', 'PARTIAL'] } },
        ],
      },
      select: {
        branchCode: true,
        isActive: true,
        validationStatus: true,
        validationErrors: true,
        billToSiteName: true,
        oracleBusinessUnit: true,
      },
    });

    if (configs.length === 0) {
      console.log('   ✅ All store configurations are valid and active\n');
      return;
    }

    console.log(`   Found ${configs.length} configurations with issues:\n`);

    configs.forEach((config, index) => {
      console.log(`   ${index + 1}. ${config.branchCode}`);
      console.log(`      Active: ${config.isActive ? 'Yes' : 'No'}`);
      console.log(`      Status: ${config.validationStatus}`);
      if (config.validationErrors) {
        console.log(`      Errors: ${JSON.stringify(config.validationErrors)}`);
      }
      console.log();
    });
  }

  private async showInvoiceAuditFailures() {
    console.log('📋 Invoice Audit Failures');
    console.log(
      '─────────────────────────────────────────────────────────────\n',
    );

    const failedInvoices = await this.prisma.fusionInvoiceHeader.findMany({
      where: { status: 'E' },
      select: {
        id: true,
        billToCustName: true,
        businessUnit: true,
        txnSource: true,
        txnType: true,
        txnNumber: true,
        customerTxnId: true,
        region: true,
        requestDate: true,
      },
      orderBy: { requestDate: 'desc' },
      take: 10,
    });

    if (failedInvoices.length === 0) {
      console.log('   ✅ No failed invoices in audit table\n');
      return;
    }

    console.log(`   Found ${failedInvoices.length} failed invoices:\n`);

    failedInvoices.forEach((invoice, index) => {
      console.log(`   ${index + 1}. Invoice ${invoice.txnNumber || 'N/A'}`);
      console.log(`      Customer: ${invoice.billToCustName}`);
      console.log(
        `      BU: ${invoice.businessUnit} | Source: ${invoice.txnSource}`,
      );
      console.log(
        `      Type: ${invoice.txnType} | Region: ${invoice.region || 'N/A'}`,
      );
      console.log(
        `      Date: ${invoice.requestDate ? invoice.requestDate.toISOString() : 'N/A'}`,
      );
      console.log();
    });
  }

  private async showSuccessVsFailureByBranch() {
    console.log('📈 Success vs Failure Rate by Branch');
    console.log(
      '─────────────────────────────────────────────────────────────\n',
    );

    const branches = await this.prisma.orderSyncQueue.groupBy({
      by: ['branchCode'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });

    for (const branch of branches) {
      const [synced, failed] = await Promise.all([
        this.prisma.orderSyncQueue.count({
          where: { branchCode: branch.branchCode, status: 'SYNCED' },
        }),
        this.prisma.orderSyncQueue.count({
          where: { branchCode: branch.branchCode, status: 'FAILED' },
        }),
      ]);

      const total = branch._count.id;
      const successRate = parseFloat(this.percentage(synced, total));
      const failureRate = parseFloat(this.percentage(failed, total));

      const indicator =
        successRate >= 90 ? '✅' : successRate >= 70 ? '⚠️' : '❌';

      console.log(`   ${indicator} ${branch.branchCode}`);
      console.log(
        `      Total: ${total} | Success: ${synced} (${successRate}%) | Failed: ${failed} (${failureRate}%)`,
      );
      console.log();
    }
  }

  private percentage(num: number, total: number): string {
    if (total === 0) return '0.0';
    return ((num / total) * 100).toFixed(1);
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const prisma = app.get(PrismaService);
  const analyzer = new FailedOrdersAnalyzer(prisma);

  await analyzer.run();
  await app.close();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
