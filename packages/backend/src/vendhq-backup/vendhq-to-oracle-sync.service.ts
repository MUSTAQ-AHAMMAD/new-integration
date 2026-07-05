import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SaleStatus } from '@prisma/client';
import {
  InvoiceLine,
  OracleSoapClient,
} from '../clients/oracle/oracle-soap.client';
import { PrismaService } from '../prisma/prisma.service';
import { FusionTransformationService } from '../sync/fusion-transformation.service';
import { SyncControlService } from '../sync/sync-control.service';
import { numberToBigInt } from '../common/utils/bigint-utils';

/** How many pending sales to process per cron run */
const BATCH_SIZE = 50;

/**
 * Validation outcome for a single VendHQ line item, checked against the
 * VendHqItemMeta table before it is pushed to Oracle Fusion.
 */
export interface LineItemValidation {
  lineNumber: number;
  /** VendHQ product_id used as the Oracle item number */
  itemNumber: string | null;
  productName: string;
  quantity: number;
  /** true when a VendHqItemMeta row exists for (itemId, region) */
  foundInItemMeta: boolean;
  /** VendHqItemMeta.status when the row exists (e.g. SUCCESS / ERROR) */
  itemMetaStatus: string | null;
  /** Human-readable reason when the item cannot be safely processed */
  issue: string | null;
}

/** Aggregate validation result for all line items on a sale. */
export interface ItemValidationSummary {
  totalItems: number;
  matched: number;
  missingFromItemMeta: number;
  failedStatus: number;
  items: LineItemValidation[];
}

/**
 * Structured, step-by-step diagnostic report produced by {@link
 * VendHqToOracleSyncService.traceSale}. Each step records whether it
 * succeeded and captures the data flowing through the pipeline so an
 * operator can pinpoint exactly where items stop moving.
 */
export interface SaleTraceReport {
  invoiceNumber: string;
  region: string | null;
  dryRun: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  sale: {
    found: boolean;
    saleDbId: string | null;
    fusionSynced: boolean | null;
    lineItemCount: number;
  };
  itemValidation: ItemValidationSummary | null;
  transform: {
    ok: boolean;
    invoiceLineCount: number;
    error: string | null;
  };
  push: {
    attempted: boolean;
    ok: boolean;
    error: string | null;
  };
}

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
      this.logger.debug(
        'VendHQ→Oracle sync service is disabled, skipping cron run',
      );
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

    // ── Pre-flight item validation ───────────────────────────────────────────
    // Validate every invoice line against VendHqItemMeta *before* pushing to
    // Oracle so missing / failed items are surfaced in the logs rather than
    // silently producing an empty or rejected invoice.
    const validation = await this.validateInvoiceLines(
      invoiceHeader.invoiceLines,
      region,
    );
    this.logger.log(
      `[${saleDbId}] item validation: ${validation.matched}/${validation.totalItems} matched, ` +
        `${validation.missingFromItemMeta} missing from VendHqItemMeta, ` +
        `${validation.failedStatus} with failed status`,
    );
    for (const item of validation.items) {
      if (item.issue) {
        this.logger.warn(
          `[${saleDbId}] line ${item.lineNumber} (item=${item.itemNumber ?? 'n/a'}, "${item.productName}"): ${item.issue}`,
        );
      }
    }
    if (invoiceHeader.invoiceLines.length === 0) {
      this.logger.warn(
        `[${saleDbId}] transformation produced 0 invoice lines — no items will reach Fusion for this sale`,
      );
    }

    // ── Invoice ──────────────────────────────────────────────────────────────
    let invoiceErrorMessage: string | null = null;
    let invoiceStatus = 'SUCCESS';
    let invoiceResult: any;
    let txnNumber: string;

    try {
      invoiceResult = await this.soapClient.createSimpleInvoice(invoiceHeader);
      txnNumber = String(
        invoiceResult.customerTrxId ??
          invoiceResult.transactionNumber ??
          saleDbId,
      );
      invoiceStatus = invoiceResult.serviceStatus ?? 'SUCCESS';
    } catch (error) {
      invoiceStatus = 'ERROR';
      invoiceErrorMessage =
        error instanceof Error
          ? error.message.substring(0, 500)
          : String(error).substring(0, 500);
      txnNumber = saleDbId;
      throw error; // Re-throw to maintain existing error handling
    }

    // Calculate total amount from invoice lines
    const totalAmount = invoiceHeader.invoiceLines.reduce(
      (sum, line) => sum + (line.unitSellingPrice ?? 0) * (line.quantity ?? 0),
      0,
    );

    const auditHeader = await this.prisma.fusionInvoiceHeader.create({
      data: {
        status: invoiceStatus,
        message: invoiceErrorMessage,
        requestDate: new Date(),
        billToCustName: invoiceHeader.billToCustomerName,
        billToLocation: invoiceHeader.billToLocation,
        billToAccNumber:
          invoiceHeader.billToAccountNumber != null
            ? numberToBigInt(Number(invoiceHeader.billToAccountNumber))
            : null,
        businessUnit: invoiceHeader.businessUnit,
        txnSource: invoiceHeader.transactionSource,
        txnType: invoiceHeader.transactionType,
        txnDate: invoiceHeader.saleDate,
        glDate: invoiceHeader.saleDate,
        currencyCode: invoiceHeader.invoiceCurrencyCode,
        txnNumber: Number(invoiceResult?.customerTrxId) || null,
        customerTxnId: Number(invoiceResult?.customerTrxId) || null,
        totalAmount,
        region,
      },
    });

    await this.prisma.fusionInvoiceLine.createMany({
      data: invoiceHeader.invoiceLines.map((il) => ({
        status: invoiceStatus,
        message: invoiceErrorMessage,
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
      let srStatus = 'SUCCESS';
      let srErrorMessage: string | null = null;
      let srResult: any;

      try {
        srResult = await this.soapClient.createStandardReceipt(sr);
      } catch (error) {
        srStatus = 'ERROR';
        srErrorMessage =
          error instanceof Error
            ? error.message.substring(0, 500)
            : String(error).substring(0, 500);
        throw error; // Re-throw to maintain existing error handling
      }

      await this.prisma.fusionStandardReceipt.create({
        data: {
          status: srStatus,
          message: srErrorMessage,
          requestDate: new Date(),
          currencyCode: sr.currencyCode,
          receiptDate: sr.saleDate,
          glDate: sr.saleDate,
          receiptMethodId: numberToBigInt(sr.receiptMethodId),
          receiptNumber: srResult?.receiptNumber ?? sr.receiptNumber,
          remittanceBankAccId: String(sr.remittanceBankAccountId),
          customerId: sr.customerId,
          accountValue: sr.accountValue,
          receiptAmount: sr.receiptAmount,
          orgId: sr.orgId,
          region,
        },
      });
    }

    // ── Misc Receipts ────────────────────────────────────────────────────────
    for (const mr of miscReceipts) {
      let mrStatus = 'SUCCESS';
      let mrErrorMessage: string | null = null;
      let mrResult: any;

      try {
        mrResult = await this.soapClient.createMiscellaneousReceipt(mr);
      } catch (error) {
        mrStatus = 'ERROR';
        mrErrorMessage =
          error instanceof Error
            ? error.message.substring(0, 500)
            : String(error).substring(0, 500);
        throw error; // Re-throw to maintain existing error handling
      }

      await this.prisma.fusionMiscReceipt.create({
        data: {
          status: mrStatus,
          message: mrErrorMessage,
          requestDate: new Date(),
          currencyCode: mr.currencyCode,
          glDate: mr.saleDate,
          receiptDate: mr.saleDate,
          receiptMethodId: numberToBigInt(mr.receiptMethodId),
          receiptMethodName: mr.receiptMethodName,
          receiptNumber: mrResult?.receiptNumber ?? mr.receiptNumber,
          bankAccNumber: mr.bankAccountName,
          recActivityName: mr.receivableActivityName,
          receiptAmount: mr.receiptAmount,
          orgId: mr.orgId,
          region,
        },
      });
    }

    // ── Apply Receipts ───────────────────────────────────────────────────────
    for (const ar of applyReceipts) {
      let arStatus = 'SUCCESS';
      let arErrorMessage: string | null = null;
      let arResult: any;

      try {
        arResult = await this.soapClient.createApplyReceipt(ar);
      } catch (error) {
        arStatus = 'ERROR';
        arErrorMessage =
          error instanceof Error
            ? error.message.substring(0, 500)
            : String(error).substring(0, 500);
        throw error; // Re-throw to maintain existing error handling
      }

      await this.prisma.fusionApplyReceipt.create({
        data: {
          status: arStatus,
          message: arErrorMessage,
          requestDate: new Date(),
          accountingDate: ar.receiptDate,
          applicationDate: ar.receiptDate,
          txnNumber: arResult?.customerTrxId ?? ar.transactionNumber,
          receiptNumber: arResult?.receiptNumber ?? ar.receiptNumber,
          amountApplied: ar.amountApplied,
          currencyCode: ar.receiptCurrency,
          txnSource: ar.transactionSource,
          region,
        },
      });
    }

    // ── Journal Entries ──────────────────────────────────────────────────────
    for (const jh of journalHeaders) {
      let jeStatus = 'SUCCESS';
      let jeErrorMessage: string | null = null;
      let jeHeaderId: number | null = null;

      try {
        jeHeaderId = await this.soapClient.importJournalEntry(jh);
        if (jeHeaderId == null) {
          jeStatus = 'ERROR';
          jeErrorMessage = 'Journal entry import returned null header ID';
        }
      } catch (error) {
        jeStatus = 'ERROR';
        jeErrorMessage =
          error instanceof Error
            ? error.message.substring(0, 500)
            : String(error).substring(0, 500);
        throw error; // Re-throw to maintain existing error handling
      }

      const jhAudit = await this.prisma.fusionJournalHeader.create({
        data: {
          status: jeStatus,
          message: jeErrorMessage,
          requestDate: new Date(),
          region,
          jeHeaderId: jeHeaderId ?? null,
          ledgerId: numberToBigInt(jh.ledgerId),
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
          status: jeStatus,
          message: jeErrorMessage,
          requestDate: new Date(),
          region,
          jeHeaderId: jeHeaderId ?? null,
          jeLineNum: idx + 1,
          ledgerId: numberToBigInt(jl.ledgerId),
          chartOfAccountsId:
            jl.chartOfAccountsId != null
              ? numberToBigInt(jl.chartOfAccountsId)
              : null,
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

  // ────────────────────────────────────────────────────────────────────────────
  // Diagnostics
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Validate a set of transformed invoice lines against the VendHqItemMeta
   * table. Each line's `itemNumber` (VendHQ product_id) is checked against
   * VendHqItemMeta(itemId, region) so that items missing from the meta table,
   * or with a failed status, can be surfaced before pushing to Oracle Fusion.
   */
  async validateInvoiceLines(
    lines: InvoiceLine[],
    region: string,
  ): Promise<ItemValidationSummary> {
    const itemNumbers = Array.from(
      new Set(
        lines
          .map((l) => l.itemNumber)
          .filter((n): n is string => n != null && n !== ''),
      ),
    );

    const metaRows =
      itemNumbers.length > 0
        ? await this.prisma.vendHqItemMeta.findMany({
            where: { itemId: { in: itemNumbers }, region },
            select: { itemId: true, status: true },
          })
        : [];
    const metaByItem = new Map(metaRows.map((m) => [m.itemId, m.status]));

    const items: LineItemValidation[] = lines.map((line) => {
      const itemNumber = line.itemNumber ?? null;
      const isDiscount = line.memoLineName === 'Discount Item';
      let foundInItemMeta = false;
      let itemMetaStatus: string | null = null;
      let issue: string | null = null;

      if (itemNumber == null || itemNumber === '') {
        // Discount / memo lines legitimately have no item number.
        if (!isDiscount) {
          issue = 'Line has no itemNumber (VendHQ product_id) to map to Fusion';
        }
      } else if (metaByItem.has(itemNumber)) {
        foundInItemMeta = true;
        itemMetaStatus = metaByItem.get(itemNumber) ?? null;
        if (itemMetaStatus && itemMetaStatus.toUpperCase() !== 'SUCCESS') {
          issue = `Item present in VendHqItemMeta but status is "${itemMetaStatus}"`;
        }
      } else {
        issue = `Item not found in VendHqItemMeta for region ${region}`;
      }

      return {
        lineNumber: line.lineNumber,
        itemNumber,
        productName: line.description ?? '',
        quantity: line.quantity ?? 0,
        foundInItemMeta,
        itemMetaStatus,
        issue,
      };
    });

    return {
      totalItems: items.length,
      matched: items.filter((i) => i.foundInItemMeta && !i.issue).length,
      missingFromItemMeta: items.filter(
        (i) => i.itemNumber != null && !i.foundInItemMeta,
      ).length,
      failedStatus: items.filter((i) => i.foundInItemMeta && i.issue != null)
        .length,
      items,
    };
  }

  /**
   * Trace a single VendHQ sale end-to-end through the Fusion pipeline for
   * debugging, logging every step. Locates the backup sale by invoice number
   * (optionally scoped to a region), validates its items against
   * VendHqItemMeta, runs the Fusion transformation, and — unless `dryRun` is
   * true — pushes it to Oracle. Returns a structured report so an operator can
   * see exactly where items stop moving.
   *
   * @param invoiceNumber VendHQ invoice/receipt number of the sale to trace.
   * @param region        Optional region filter.
   * @param opts.dryRun   When true (default) the sale is not pushed to Oracle.
   */
  async traceSale(
    invoiceNumber: string,
    region?: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<SaleTraceReport> {
    const dryRun = opts.dryRun ?? true;
    const report: SaleTraceReport = {
      invoiceNumber,
      region: region ?? null,
      dryRun,
      steps: [],
      sale: {
        found: false,
        saleDbId: null,
        fusionSynced: null,
        lineItemCount: 0,
      },
      itemValidation: null,
      transform: { ok: false, invoiceLineCount: 0, error: null },
      push: { attempted: false, ok: false, error: null },
    };

    const addStep = (step: string, ok: boolean, detail: string) => {
      report.steps.push({ step, ok, detail });
      const line = `traceSale[${invoiceNumber}] ${step}: ${detail}`;
      if (ok) this.logger.log(line);
      else this.logger.error(line);
    };

    // ── Step 1: Fetch the backup sale ────────────────────────────────────────
    const sale = await this.prisma.backupVendHqSale.findFirst({
      where: { invoiceNumber, ...(region ? { region } : {}) },
      include: { backupLineItems: true },
    });

    if (!sale) {
      addStep(
        'fetch',
        false,
        `No BackupVendHqSale found for invoiceNumber=${invoiceNumber}${region ? ` region=${region}` : ''}. Confirm the VendHQ backup ran and stored this sale.`,
      );
      return report;
    }

    report.sale = {
      found: true,
      saleDbId: sale.id,
      fusionSynced: sale.fusionSynced,
      lineItemCount: sale.backupLineItems.length,
    };
    addStep(
      'fetch',
      true,
      `Found sale ${sale.id} (region=${sale.region}, fusionSynced=${sale.fusionSynced}) with ${sale.backupLineItems.length} line item(s)`,
    );
    if (sale.backupLineItems.length > 0) {
      const sample = sale.backupLineItems
        .slice(0, 5)
        .map(
          (li) =>
            `#${li.lineNumber ?? '?'} product=${li.productId ?? 'n/a'} "${li.productName ?? ''}" qty=${li.quantity ?? 0}`,
        )
        .join('; ');
      this.logger.log(
        `traceSale[${invoiceNumber}] sample line items: ${sample}`,
      );
    }

    // ── Step 2: Transform to Fusion payloads ─────────────────────────────────
    let payloads;
    try {
      payloads = await this.transformationService.buildSalePayloads(
        sale.id,
        sale.region,
      );
      report.transform.ok = true;
      report.transform.invoiceLineCount =
        payloads.invoiceHeader.invoiceLines.length;
      addStep(
        'transform',
        true,
        `Transformed to ${payloads.invoiceHeader.invoiceLines.length} invoice line(s), ${payloads.standardReceipts.length} standard receipt(s), ${payloads.miscReceipts.length} misc receipt(s)`,
      );
    } catch (err) {
      report.transform.error = err instanceof Error ? err.message : String(err);
      addStep('transform', false, report.transform.error);
      return report;
    }

    // ── Step 3: Validate items against VendHqItemMeta ────────────────────────
    const validation = await this.validateInvoiceLines(
      payloads.invoiceHeader.invoiceLines,
      sale.region,
    );
    report.itemValidation = validation;
    const validationOk = validation.totalItems > 0 && validation.matched > 0;
    addStep(
      'validate-items',
      validationOk,
      `${validation.matched}/${validation.totalItems} matched, ${validation.missingFromItemMeta} missing from VendHqItemMeta, ${validation.failedStatus} with failed status`,
    );
    for (const item of validation.items) {
      if (item.issue) {
        this.logger.warn(
          `traceSale[${invoiceNumber}] line ${item.lineNumber} (item=${item.itemNumber ?? 'n/a'}): ${item.issue}`,
        );
      }
    }

    // ── Step 4: Push to Oracle (unless dry run) ──────────────────────────────
    if (dryRun) {
      addStep(
        'push',
        true,
        'Dry run — skipping Oracle push. Re-run with dryRun=false to attempt the push.',
      );
      return report;
    }

    report.push.attempted = true;
    try {
      await this.processSale(sale.id, sale.region);
      report.push.ok = true;
      addStep(
        'push',
        true,
        'Sale pushed to Oracle Fusion and marked as synced',
      );
    } catch (err) {
      report.push.error = err instanceof Error ? err.message : String(err);
      addStep('push', false, report.push.error);
    }

    return report;
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
