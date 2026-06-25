import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SaleStatus } from '@prisma/client';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { PrismaService } from '../prisma/prisma.service';
import { FusionTransformationService } from '../sync/fusion-transformation.service';
import { SyncControlService } from '../sync/sync-control.service';

/** How many pending sales to process per cron run */
const BATCH_SIZE = 50;

@Injectable()
export class VendHqToOracleSyncService {
  private readonly logger = new Logger(VendHqToOracleSyncService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transformationService: FusionTransformationService,
    private readonly soapClient: OracleSoapClient,
    private readonly syncControl: SyncControlService,
  ) {}

  /** Every 10 minutes: process all unsynchronised VendHQ backup sales */
  @Cron('0 */10 * * * *')
  async handleCron(): Promise<void> {
    // Check if sync control allows this service to run
    const enabled = await this.syncControl.isEnabled('vendhq-to-oracle');
    if (!enabled) {
      this.logger.debug('VendHQ→Oracle sync service is disabled, skipping cron run');
      return;
    }

    if (this.running) {
      this.logger.warn('VendHQ→Oracle sync already running, skipping tick');
      return;
    }
    this.running = true;
    await this.syncControl.markRunning('vendhq-to-oracle');
    try {
      await this.runSyncJob();
      await this.syncControl.markStopped('vendhq-to-oracle', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`VendHQ→Oracle sync cron failed: ${msg}`);
      await this.syncControl.markStopped('vendhq-to-oracle', 'error');
    } finally {
      this.running = false;
    }
  }

  /**
   * Process pending VendHQ backup sales and push them to Oracle Fusion.
   * @param region Optional filter — when provided only sales for that region
   *               are processed in this run.
   * @returns Counts of processed, succeeded, and failed records.
   */
  async runSyncJob(
    region?: string,
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    const where = {
      fusionSynced: false,
      ...(region ? { region } : {}),
    };

    const pending = await this.prisma.backupVendHqSale.findMany({
      where,
      take: BATCH_SIZE,
      orderBy: { saleDate: 'asc' },
    });

    if (pending.length === 0) {
      this.logger.log(
        `VendHQ→Oracle sync: no pending sales${region ? ` for region ${region}` : ''}`,
      );
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.logger.log(
      `VendHQ→Oracle sync: processing ${pending.length} sale(s)${region ? ` for region ${region}` : ''}`,
    );

    let succeeded = 0;
    let failed = 0;

    for (const sale of pending) {
      try {
        await this.processSale(sale.id, sale.region);
        succeeded++;
      } catch (err) {
        failed++;
        this.logger.error(
          `VendHQ→Oracle sync failed for sale ${sale.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `VendHQ→Oracle sync complete: ${succeeded} succeeded, ${failed} failed`,
    );

    return { processed: pending.length, succeeded, failed };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────────

  private async processSale(saleDbId: string, region: string): Promise<void> {
    const {
      invoiceHeader,
      standardReceipts,
      miscReceipts,
      applyReceipts,
      journalHeaders,
    } = await this.transformationService.buildSalePayloads(saleDbId, region);

    // ── Invoice ──────────────────────────────────────────────────────────────
    const invoiceResult =
      await this.soapClient.createSimpleInvoice(invoiceHeader);
    const txnNumber = String(
      invoiceResult.customerTrxId ??
        invoiceResult.transactionNumber ??
        saleDbId,
    );

    const auditHeader = await this.prisma.fusionInvoiceHeader.create({
      data: {
        status: invoiceResult.serviceStatus ?? 'SUCCESS',
        requestDate: new Date(),
        billToCustName: invoiceHeader.billToCustomerName,
        billToLocation: invoiceHeader.billToLocation,
        billToAccNumber: invoiceHeader.billToAccountNumber != null ? BigInt(invoiceHeader.billToAccountNumber) : null,
        businessUnit: invoiceHeader.businessUnit,
        txnSource: invoiceHeader.transactionSource,
        txnType: invoiceHeader.transactionType,
        txnDate: invoiceHeader.saleDate,
        glDate: invoiceHeader.saleDate,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        txnNumber: Number(invoiceResult.customerTrxId) || null,
        customerTxnId: Number(invoiceResult.customerTrxId) || null,
        region,
      },
    });

    await this.prisma.fusionInvoiceLine.createMany({
      data: invoiceHeader.invoiceLines.map((il) => ({
        status: invoiceResult.serviceStatus ?? 'SUCCESS',
        requestDate: new Date(),
        invoiceNumber: txnNumber,
        lineNumber: il.lineNumber,
        itemNumber: il.itemNumber ?? null,
        description: il.description,
        quantity: il.quantity,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        salesOrder: il.salesOrder ?? null,
        salesOrderLine: Number(il.salesOrderLine) || null,
        region,
        headerId: auditHeader.id,
      })),
    });

    // ── Standard Receipts ────────────────────────────────────────────────────
    for (const sr of standardReceipts) {
      const srResult = await this.soapClient.createStandardReceipt(sr);
      await this.prisma.fusionStandardReceipt.create({
        data: {
          status: 'SUCCESS',
          requestDate: new Date(),
          currencyCode: sr.currencyCode,
          receiptDate: sr.saleDate,
          glDate: sr.saleDate,
          receiptMethodId: BigInt(sr.receiptMethodId),
          receiptNumber: srResult.receiptNumber ?? sr.receiptNumber,
          remittanceBankAccId: String(sr.remittanceBankAccountId),
          orgId: sr.orgId,
          region,
        },
      });
    }

    // ── Misc Receipts ────────────────────────────────────────────────────────
    for (const mr of miscReceipts) {
      const mrResult = await this.soapClient.createMiscellaneousReceipt(mr);
      await this.prisma.fusionMiscReceipt.create({
        data: {
          status: 'SUCCESS',
          requestDate: new Date(),
          currencyCode: mr.currencyCode,
          glDate: mr.saleDate,
          receiptDate: mr.saleDate,
          receiptMethodName: mr.receiptMethodName,
          receiptNumber: mrResult.receiptNumber ?? mr.receiptNumber,
          bankAccNumber: mr.bankAccountName,
          recActivityName: mr.receivableActivityName,
          region,
        },
      });
    }

    // ── Apply Receipts ───────────────────────────────────────────────────────
    for (const ar of applyReceipts) {
      const arResult = await this.soapClient.createApplyReceipt(ar);
      await this.prisma.fusionApplyReceipt.create({
        data: {
          status: 'SUCCESS',
          requestDate: new Date(),
          accountingDate: ar.accountingDate,
          applicationDate: ar.applicationDate,
          txnNumber: arResult.customerTrxId ?? ar.transactionNumber,
          receiptNumber: arResult.receiptNumber ?? ar.receiptNumber,
          currencyCode: ar.receiptCurrency,
          txnSource: ar.transactionSource,
          region,
        },
      });
    }

    // ── Journal Entries ──────────────────────────────────────────────────────
    for (const jh of journalHeaders) {
      const jeHeaderId = await this.soapClient.importJournalEntry(jh);
      const jhAudit = await this.prisma.fusionJournalHeader.create({
        data: {
          status: jeHeaderId != null ? 'SUCCESS' : 'ERROR',
          requestDate: new Date(),
          region,
          jeHeaderId: jeHeaderId ?? null,
          ledgerId: BigInt(jh.ledgerId),
          batchName: jh.batchName,
          batchDescription: jh.batchDescription,
          accountingPeriodName: jh.accountingPeriodName,
          userSourceName: jh.userSourceName,
          userCategoryName: jh.userCategoryName,
          errorToSuspenseFlag: jh.errorToSuspenseFlag,
          summaryFlag: jh.summaryFlag,
          accountingDate: jh.accountingDate,
        },
      });

      await this.prisma.fusionJournalLine.createMany({
        data: jh.journalLines.map((jl, idx) => ({
          status: jeHeaderId != null ? 'SUCCESS' : 'ERROR',
          requestDate: new Date(),
          region,
          jeHeaderId: jeHeaderId ?? null,
          jeLineNum: idx + 1,
          ledgerId: BigInt(jl.ledgerId),
          chartOfAccountsId: jl.chartOfAccountsId != null ? BigInt(jl.chartOfAccountsId) : null,
          currencyCode: jl.currencyCode,
          enteredCrAmount: jl.enteredCrAmount ?? null,
          accountedCr: jl.accountedCr ?? null,
          enteredDrAmount: jl.enteredDrAmount ?? null,
          accountedDr: jl.accountedDr ?? null,
          segment1: jl.segment1 ?? null,
          segment2: jl.segment2 ?? null,
          segment3: jl.segment3 ?? null,
          segment4: jl.segment4 ?? null,
          segment5: jl.segment5 ?? null,
          segment6: jl.segment6 ?? null,
          segment7: jl.segment7 ?? null,
          segment8: jl.segment8 ?? null,
          segment9: jl.segment9 ?? null,
          segment10: jl.segment10 ?? null,
          accountingDate: jl.accountingDate ?? null,
          transactionDate: jl.transactionDate ?? null,
          userJeSourceName: jl.userJeSourceName ?? null,
          userJeCategoryName: jl.jeCategoryName ?? null,
          currencyConversionRate: jl.currencyConversionRate ?? null,
          periodName: jl.periodName ?? null,
          taxCode: jl.taxCode ?? null,
          headerId: jhAudit.id,
        })),
      });
    }

    // ── Mark sale as synced ──────────────────────────────────────────────────
    await this.prisma.backupVendHqSale.update({
      where: { id: saleDbId },
      data: {
        fusionSynced: true,
        fusionSyncAt: new Date(),
        fusionSyncError: null,
      },
    });

    // ── Update SaleSyncStatus if present ────────────────────────────────────
    await this.updateSaleSyncStatus(saleDbId, txnNumber);
  }

  private async updateSaleSyncStatus(
    saleDbId: string,
    oracleInvoiceId: string,
  ): Promise<void> {
    try {
      const sale = await this.prisma.backupVendHqSale.findUnique({
        where: { id: saleDbId },
        select: { invoiceNumber: true, outletId: true, saleDate: true },
      });
      if (!sale) return;

      // SaleSyncStatus uses a composite PK: [saleId, outletId, saleDate]
      // saleId in SaleSyncStatus is the VendHQ invoice number
      await this.prisma.saleSyncStatus.updateMany({
        where: {
          saleId: sale.invoiceNumber,
          ...(sale.outletId != null ? { outletId: sale.outletId } : {}),
        },
        data: {
          status: SaleStatus.SYNCED,
          lastSyncAt: new Date(),
          oracleInvoiceId,
        },
      });
    } catch {
      // Best-effort — don't fail the main sync if status update fails
    }
  }
}
