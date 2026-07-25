/**
 * DailyInvoiceService — posts aggregated daily invoices to Oracle Fusion.
 *
 * Replaces the per-order invoice path: one Oracle AR invoice per
 * (branch, business day, customer type, credit flag), with its receipts and
 * journals aggregated to the same grain.
 *
 * Ordering mirrors the legacy Java integration:
 *   invoice → standard receipts → misc receipts → apply receipts → GL journals
 *
 * Re-running a day is safe, and every Oracle object is guarded independently
 * (as the Java does) rather than short-circuiting on the invoice:
 *   - invoice lines already posted are dropped from the new header;
 *   - when ALL of a group's lines are posted the invoice is reused, not
 *     recreated, so receipts or journals the previous run never got to are still
 *     retried — an invoice cannot be stranded unpaid in Oracle AR;
 *   - each receipt/journal is skipped if it already succeeded.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Decimal } from 'decimal.js';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { OracleClient } from '../clients/oracle/oracle.client';
import { FusionApplyReceipt } from '../database/entities/fusion-apply-receipt.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionJournalHeader } from '../database/entities/fusion-journal-header.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { generateId } from '../database/id.util';
import { SyncStatus } from '../database/enums';
import { mapWithConcurrency } from '../common/utils/concurrency';
import {
  DailyAggregationService,
  DailyInvoiceGroup,
} from './daily-aggregation.service';

/**
 * How many store/day units post concurrently. Each is independent; the true
 * load on Oracle is separately capped by the SOAP client's global gate
 * (ORACLE_SOAP_CONCURRENCY). Kept a bit above that gate so there is always
 * enough queued SOAP work to keep the gate full. Tunable via env.
 */
const POST_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.DAILY_POST_CONCURRENCY ?? '12', 10) || 12,
);

/**
 * How many inventory issues post concurrently WITHIN one store's group. Inventory
 * is one Oracle REST call per line and dominates the POST, so it fans out here;
 * the aggregate across all parallel stores is still capped by the Oracle client's
 * global REST gate (ORACLE_REST_CONCURRENCY). Tunable via env.
 */
const INVENTORY_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.DAILY_INVENTORY_CONCURRENCY ?? '8', 10) || 8,
);

export interface DailyInvoiceOutcome {
  branchCode: string;
  /** Human-readable store name for the UI (e.g. "Mahmal Center"). */
  branchName?: string | null;
  businessDay: string;
  groupKey: string;
  customerType: string;
  status: 'CREATED' | 'SKIPPED' | 'FAILED';
  transactionNumber?: string;
  /** Invoice net value (Σ quantity × unit selling price) for the UI. */
  invoiceAmount?: number;
  /** Currency the invoiceAmount is expressed in (e.g. "AED"). */
  currencyCode?: string | null;
  sourceOrderCount: number;
  invoiceLineCount: number;
  standardReceipts: number;
  miscReceipts: number;
  journals: number;
  inventoryTransactions?: number;
  /** Orders held back because Oracle does not know one of their items. */
  excludedOrders?: Array<{ orderNumber: string; reason: string }>;
  error?: string;
}

/** Hard cap on the catch-up window, matching the legacy 7-day limit. */
const MAX_CATCHUP_DAYS = 7;

/**
 * How the run was started. The legacy system kept MANUAL and AUTOMATIC as
 * separate modes and only touched outlets whose OUTLETS_INTEGRATION_CONFIG
 * INTEG_MODE matched — a scheduled run never posts a MANUAL outlet, and an
 * operator-triggered run never posts an AUTOMATIC one.
 *
 * 'ALL' is the operator's full-region integration run: it posts BOTH manual
 * and automatic outlets (NONE stays excluded).
 */
export type IntegrationTrigger = 'MANUAL' | 'AUTOMATIC' | 'ALL';

@Injectable()
export class DailyInvoiceService {
  private readonly logger = new Logger(DailyInvoiceService.name);

  /**
   * Oracle transaction type used for inventory issues. Configurable because the
   * legacy "Vend Sales Issue" type may not exist on every pod; defaults to the
   * standard "Account Issue" which the current pod accepts.
   */
  private readonly inventoryTransactionType =
    process.env.ORACLE_INVENTORY_TXN_TYPE || 'Account Issue';

  /**
   * Monotonic, collision-resistant id for the inventory interface. Date.now is
   * unavailable in some sandboxes but fine at runtime; combined with a counter
   * so two transactions in the same millisecond never clash.
   */
  private interfaceSeq = 0;
  private nextInterfaceId(): number {
    this.interfaceSeq = (this.interfaceSeq + 1) % 1000;
    return Date.now() * 1000 + this.interfaceSeq;
  }

  constructor(
    private readonly aggregation: DailyAggregationService,
    private readonly soap: OracleSoapClient,
    private readonly oracleClient: OracleClient,
    @InjectRepository(FusionInvoiceHeader)
    private readonly invoiceHeaderRepo: Repository<FusionInvoiceHeader>,
    @InjectRepository(FusionInvoiceLine)
    private readonly invoiceLineRepo: Repository<FusionInvoiceLine>,
    @InjectRepository(FusionStandardReceipt)
    private readonly stdReceiptRepo: Repository<FusionStandardReceipt>,
    @InjectRepository(FusionMiscReceipt)
    private readonly miscReceiptRepo: Repository<FusionMiscReceipt>,
    @InjectRepository(FusionApplyReceipt)
    private readonly applyReceiptRepo: Repository<FusionApplyReceipt>,
    @InjectRepository(FusionJournalHeader)
    private readonly journalHeaderRepo: Repository<FusionJournalHeader>,
    @InjectRepository(FusionInvTxn)
    private readonly invTxnRepo: Repository<FusionInvTxn>,
    @InjectRepository(OrderSyncQueue)
    private readonly queueRepo: Repository<OrderSyncQueue>,
    @InjectRepository(StoreConfiguration)
    private readonly storeConfigRepo: Repository<StoreConfiguration>,
    @InjectRepository(OutletIntegrationConfig)
    private readonly outletConfigRepo: Repository<OutletIntegrationConfig>,
  ) {}

  /**
   * Honours OUTLETS_INTEGRATION_CONFIG.INTEG_MODE.
   *
   *   NONE      → never integrated (decommissioned / handled elsewhere)
   *   MANUAL    → only on an operator-triggered run
   *   AUTOMATIC → only on a scheduled run
   *
   * An outlet with no config row is treated as AUTOMATIC, matching how the rest
   * of the pipeline defaults an unknown flag to "enabled"; that is logged so a
   * missing row is visible rather than silent.
   */
  private async outletAllows(
    branchCode: string,
    trigger: IntegrationTrigger,
  ): Promise<boolean> {
    const store = await this.storeConfigRepo.findOne({
      where: { branchCode },
      select: { branchName: true, region: true },
    });
    if (!store) return true; // postRange already validated the store exists

    const normalize = (v: string | null | undefined) =>
      (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const candidates = await this.outletConfigRepo.find({
      where: { region: store.region ?? undefined },
      select: { outletName: true, integMode: true },
    });
    const match = candidates.find(
      (c) => normalize(c.outletName) === normalize(store.branchName),
    );

    if (!match) {
      this.logger.warn(
        `[${branchCode}] no OutletIntegrationConfig row for "${store.branchName}" ` +
          `(region ${store.region}) — treating as AUTOMATIC`,
      );
      // Unknown outlets default to "enabled" for every trigger mode.
      return true;
    }

    const mode = (match.integMode ?? '').trim().toUpperCase();
    if (mode === 'NONE') {
      this.logger.log(
        `[${branchCode}] outlet "${match.outletName}" is INTEG_MODE=NONE — skipping`,
      );
      return false;
    }
    if (trigger === 'ALL') return true; // operator full-region run posts both modes
    if (mode === 'MANUAL' && trigger !== 'MANUAL') {
      this.logger.log(
        `[${branchCode}] outlet "${match.outletName}" is MANUAL — not posted by a scheduled run`,
      );
      return false;
    }
    if (mode === 'AUTOMATIC' && trigger !== 'AUTOMATIC') {
      this.logger.log(
        `[${branchCode}] outlet "${match.outletName}" is AUTOMATIC — not posted by a manual run`,
      );
      return false;
    }
    return true;
  }

  /**
   * Posts every outstanding group for one branch on one business day.
   */
  async postDay(
    branchCode: string,
    businessDay: string,
    trigger: IntegrationTrigger = 'MANUAL',
  ): Promise<DailyInvoiceOutcome[]> {
    if (!(await this.outletAllows(branchCode, trigger))) return [];

    const groups = await this.aggregation.buildDailyGroups(
      branchCode,
      businessDay,
    );
    if (groups.length === 0) {
      this.logger.log(
        `[${branchCode} ${businessDay}] nothing to post — no eligible orders or already fully posted`,
      );
      return [];
    }

    const outcomes: DailyInvoiceOutcome[] = [];
    for (const group of groups) {
      outcomes.push(await this.postGroup(group));
    }
    return outcomes;
  }

  /**
   * Posts a date range for every active branch in a region (or one branch).
   * `days` is clamped to MAX_CATCHUP_DAYS so an unattended catch-up can never
   * walk the entire history.
   */
  async postRange(
    params: {
      branchCode?: string;
      region?: string;
      startDate: string;
      days?: number;
      trigger?: IntegrationTrigger;
    },
    /**
     * Called after each store/day is posted, with just that step's outcomes and
     * how far through the store list we are — lets a live UI update per store
     * instead of waiting for the whole range. Never affects the return value.
     */
    onProgress?: (p: {
      outcomes: DailyInvoiceOutcome[];
      storesDone: number;
      storesTotal: number;
      branchCode: string;
      branchName: string | null;
      businessDay: string;
    }) => void,
  ): Promise<DailyInvoiceOutcome[]> {
    const trigger: IntegrationTrigger = params.trigger ?? 'MANUAL';
    const days = Math.min(Math.max(params.days ?? 1, 1), MAX_CATCHUP_DAYS);

    const stores = params.branchCode
      ? await this.storeConfigRepo.find({
          where: { branchCode: params.branchCode },
        })
      : await this.storeConfigRepo.find({
          where: params.region
            ? { region: params.region, isActive: true }
            : { isActive: true },
        });

    if (stores.length === 0) {
      throw new Error(
        `No active StoreConfiguration matched ` +
          `${params.branchCode ? `branchCode=${params.branchCode}` : `region=${params.region ?? 'ALL'}`}`,
      );
    }

    // Build the full (store, day) work list, then post them CONCURRENTLY. Each
    // store/day is independent (distinct invoices/receipts), so this is safe;
    // the actual load on Oracle is bounded by the SOAP client's global
    // concurrency gate (ORACLE_SOAP_CONCURRENCY), while per-group ordering
    // (invoice → receipts → applies → inventory) is preserved inside postDay.
    const tasks: Array<{
      branchCode: string;
      branchName: string | null;
      day: string;
    }> = [];
    for (const store of stores) {
      for (let i = 0; i < days; i++) {
        tasks.push({
          branchCode: store.branchCode,
          branchName: store.branchName ?? null,
          day: this.addDays(params.startDate, i),
        });
      }
    }

    const outcomes: DailyInvoiceOutcome[] = [];
    let done = 0;
    await mapWithConcurrency(tasks, POST_CONCURRENCY, async (task) => {
      let stepOutcomes: DailyInvoiceOutcome[];
      try {
        stepOutcomes = await this.postDay(task.branchCode, task.day, trigger);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[${task.branchCode} ${task.day}] aggregation failed: ${message}`,
        );
        stepOutcomes = [
          {
            branchCode: task.branchCode,
            branchName: task.branchName,
            businessDay: task.day,
            groupKey: `${task.branchCode}|${task.day}`,
            customerType: 'UNKNOWN',
            status: 'FAILED',
            sourceOrderCount: 0,
            invoiceLineCount: 0,
            standardReceipts: 0,
            miscReceipts: 0,
            journals: 0,
            error: message,
          },
        ];
      }
      outcomes.push(...stepOutcomes);
      done += 1;
      onProgress?.({
        outcomes: stepOutcomes,
        storesDone: done,
        storesTotal: tasks.length,
        branchCode: task.branchCode,
        branchName: task.branchName,
        businessDay: task.day,
      });
    });
    return outcomes;
  }

  /** Pushes one aggregated group through the full Oracle sequence. */
  private async postGroup(
    group: DailyInvoiceGroup,
  ): Promise<DailyInvoiceOutcome> {
    const base: DailyInvoiceOutcome = {
      branchCode: group.branchCode,
      branchName: group.branchName,
      businessDay: group.businessDay,
      groupKey: group.groupKey,
      customerType: group.customerType,
      status: 'FAILED',
      invoiceAmount: group.invoiceHeader.invoiceLines.reduce(
        (sum, l) => sum + l.quantity * l.unitSellingPrice,
        0,
      ),
      currencyCode: group.invoiceHeader.invoiceCurrencyCode,
      sourceOrderCount: group.sourceOrderNumbers.length,
      invoiceLineCount: group.invoiceHeader.invoiceLines.length,
      standardReceipts: 0,
      miscReceipts: 0,
      journals: 0,
      inventoryTransactions: 0,
      excludedOrders: group.excludedOrders.length
        ? group.excludedOrders
        : undefined,
    };

    if (group.excludedOrders.length) {
      this.logger.warn(
        `[${group.branchCode} ${group.businessDay}] ${group.excludedOrders.length} ` +
          `order(s) held back: ${group.excludedOrders
            .map((e) => e.orderNumber)
            .join(', ')}`,
      );
    }

    this.logger.log(
      `[${group.branchCode} ${group.businessDay}] posting ${group.customerType}` +
        `${group.isCredit ? ' (credit)' : ''}: ${base.sourceOrderCount} orders → ` +
        `${base.invoiceLineCount} lines` +
        (group.alreadyPostedLines
          ? `, ${group.alreadyPostedLines} lines already posted`
          : ''),
    );

    // ── 1. Invoice ───────────────────────────────────────────────────────────
    // Skipped when a previous run already created it and only its receipts or
    // journals are outstanding.
    let txnNumber: string;
    if (group.postInvoice) {
      let customerTrxId: string;
      try {
        const result = await this.soap.createSimpleInvoice(group.invoiceHeader);
        txnNumber = result.transactionNumber;
        customerTrxId = result.customerTrxId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.persistInvoiceFailure(group, message);
        return { ...base, error: message };
      }
      await this.persistInvoiceSuccess(group, txnNumber, customerTrxId);
    } else {
      txnNumber = group.existingTransactionNumber as string;
      this.logger.log(
        `[${group.branchCode} ${group.businessDay}] reusing invoice ${txnNumber} — ` +
          `checking for unposted receipts/journals`,
      );
    }
    this.aggregation.stampTransactionNumber(group, txnNumber);

    // ── 2. Receipts ──────────────────────────────────────────────────────────
    // A receipt failure must not roll back an accepted invoice: record it and
    // let the day be re-run — the invoice lines are now marked posted, so only
    // the missing receipts are retried.
    for (const receipt of group.standardReceipts) {
      if (
        await this.alreadyPosted(
          this.stdReceiptRepo,
          receipt.receiptNumber,
          group.region,
        )
      ) {
        this.logger.log(
          `[${group.branchCode}] standard receipt ${receipt.receiptNumber} already posted — skipping`,
        );
        continue;
      }
      // Persist exactly what was sent (legacy FUSION_STANDARD_RECEIPTS parity),
      // success or failure, so the admin tables trace every payload field.
      const stdRow = {
        receiptNumber: receipt.receiptNumber,
        region: group.region,
        currencyCode: receipt.currencyCode,
        receiptDate: receipt.saleDate,
        glDate: receipt.saleDate,
        receiptMethodId: BigInt(receipt.receiptMethodId),
        remittanceBankAccId:
          receipt.remittanceBankAccountId != null
            ? String(receipt.remittanceBankAccountId)
            : null,
        customerId:
          receipt.customerId != null ? BigInt(receipt.customerId) : null,
        accountValue: receipt.accountValue ?? null,
        receiptAmount: receipt.receiptAmount,
        orgId: receipt.orgId != null ? BigInt(receipt.orgId) : null,
      };
      try {
        await this.soap.createStandardReceipt(receipt);
        await this.saveReceipt(this.stdReceiptRepo, {
          ...stdRow,
          status: 'SUCCESS',
          message: null,
        });
        base.standardReceipts += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[${group.branchCode}] standard receipt ${receipt.receiptNumber} failed: ${message}`,
        );
        await this.saveReceipt(this.stdReceiptRepo, {
          ...stdRow,
          status: 'ERROR',
          message,
        });
      }
    }

    for (const receipt of group.miscReceipts) {
      if (
        await this.alreadyPosted(
          this.miscReceiptRepo,
          receipt.receiptNumber,
          group.region,
        )
      ) {
        this.logger.log(
          `[${group.branchCode}] misc receipt ${receipt.receiptNumber} already posted — skipping`,
        );
        continue;
      }
      const miscRow = {
        receiptNumber: receipt.receiptNumber,
        region: group.region,
        currencyCode: receipt.currencyCode,
        receiptDate: receipt.saleDate,
        glDate: receipt.saleDate,
        receiptMethodId: BigInt(receipt.receiptMethodId),
        receiptMethodName: receipt.receiptMethodName ?? null,
        bankAccNumber: receipt.bankAccountName ?? null,
        recActivityName: receipt.receivableActivityName ?? null,
        receiptAmount: receipt.receiptAmount,
        orgId: receipt.orgId != null ? BigInt(receipt.orgId) : null,
      };
      try {
        await this.soap.createMiscellaneousReceipt(receipt);
        await this.saveReceipt(this.miscReceiptRepo, {
          ...miscRow,
          status: 'SUCCESS',
          message: null,
        });
        base.miscReceipts += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[${group.branchCode}] misc receipt ${receipt.receiptNumber} failed: ${message}`,
        );
        await this.saveReceipt(this.miscReceiptRepo, {
          ...miscRow,
          status: 'ERROR',
          message,
        });
      }
    }

    for (const apply of group.applyReceipts) {
      if (
        await this.alreadyPosted(
          this.applyReceiptRepo,
          apply.receiptNumber,
          group.region,
        )
      ) {
        this.logger.log(
          `[${group.branchCode}] apply receipt ${apply.receiptNumber} already applied — skipping`,
        );
        continue;
      }
      const applyRow = {
        receiptNumber: apply.receiptNumber,
        region: group.region,
        txnNumber: apply.transactionNumber,
        amountApplied: apply.amountApplied,
        currencyCode: apply.receiptCurrency,
        accountingDate: apply.receiptDate,
        applicationDate: apply.receiptDate,
        txnSource: apply.transactionSource ?? null,
      };
      try {
        await this.soap.createApplyReceipt(apply);
        await this.saveReceipt(this.applyReceiptRepo, {
          ...applyRow,
          status: 'SUCCESS',
          message: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[${group.branchCode}] apply receipt ${apply.receiptNumber} failed: ${message}`,
        );
        await this.saveReceipt(this.applyReceiptRepo, {
          ...applyRow,
          status: 'ERROR',
          message,
        });
      }
    }

    // ── 2b. GL journals (non-NORMAL customer types only) ─────────────────────
    // Posted right after receipts (matching the legacy order) and BEFORE the
    // bulk inventory issues, so the small, quick journal never waits behind
    // thousands of inventory REST calls.
    for (const journal of group.journalHeaders) {
      const journalPosted = await this.journalHeaderRepo.findOne({
        where: {
          txnNumber: BigInt(txnNumber),
          region: group.region,
          status: 'SUCCESS',
        },
        select: { id: true },
      });
      if (journalPosted) {
        this.logger.log(
          `[${group.branchCode}] journal for ${txnNumber} already imported — skipping`,
        );
        continue;
      }
      try {
        // Assign the batch GroupId from the Oracle txn so Oracle groups this
        // journal's balanced Dr/Cr lines together. buildJournalHeaders leaves it
        // unset (the legacy per-order processor filled it in); WITHOUT it Oracle's
        // GL_INTERFACE rejects every row — JBO-27024 on attribute "GroupId".
        const groupId = Number(txnNumber);
        journal.batchDescription = `Odoo Journal Import: ${txnNumber}`;
        for (const jl of journal.journalLines) {
          jl.groupId = Number.isSafeInteger(groupId) ? groupId : undefined;
        }
        const jeHeaderId = await this.soap.importJournalEntry(journal);
        await this.journalHeaderRepo.save(
          this.journalHeaderRepo.create({
            id: generateId(),
            // FusionJournalHeader.txnNumber is a bigint column.
            txnNumber: BigInt(txnNumber),
            region: group.region,
            status: 'SUCCESS',
            jeHeaderId: jeHeaderId ?? null,
            requestDate: new Date(),
            // Persist the mapping actually applied so the dashboard shows it
            // instead of blanks (the values are resolved from
            // ServiceProviderJournalMeta in buildJournalHeaders).
            ledgerId: journal.ledgerId != null ? BigInt(journal.ledgerId) : null,
            batchName: journal.batchName ?? null,
            accountingDate: journal.accountingDate ?? null,
            customerType: group.customerType ?? null,
            cashCredit: journal.cashCredit ?? null,
          } as Partial<FusionJournalHeader>),
        );
        base.journals += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[${group.branchCode}] journal import failed: ${message}`,
        );
        await this.journalHeaderRepo.save(
          this.journalHeaderRepo.create({
            id: generateId(),
            txnNumber: BigInt(txnNumber),
            region: group.region,
            status: 'ERROR',
            message,
            requestDate: new Date(),
            // Persist the intended mapping even on failure, so the row is
            // diagnosable rather than blank.
            ledgerId: journal.ledgerId != null ? BigInt(journal.ledgerId) : null,
            batchName: journal.batchName ?? null,
            accountingDate: journal.accountingDate ?? null,
            customerType: group.customerType ?? null,
            cashCredit: journal.cashCredit ?? null,
          } as Partial<FusionJournalHeader>),
        );
      }
    }

    // ── 2c. Inventory issues ─────────────────────────────────────────────────
    // One staged inventory transaction per contributing line, relieving stock
    // from the store's subinventory. Oracle processes the interface async.
    // Idempotency: skip a line already recorded SUCCESS for this txn+item.
    //
    // These are the bulk of the POST's work (one Oracle REST call per line), so
    // they run CONCURRENTLY within the group. The aggregate load across all
    // parallel stores is bounded by the Oracle client's global REST gate
    // (ORACLE_REST_CONCURRENCY), so raising this per-group fan-out never
    // overwhelms Oracle.
    // Pre-load every already-posted line for this group in ONE query (chunked)
    // instead of a findOne per line — the dedup then costs nothing per line,
    // which matters because we now consider EVERY line (incl. already-invoiced
    // ones) so stranded inventory can be retried.
    const planRefs = [
      ...new Set(
        group.inventoryTransactions.map(
          (p) => `${p.salesOrder}#${p.salesOrderLine}`,
        ),
      ),
    ];
    const postedRefs = new Set<string>();
    for (let i = 0; i < planRefs.length; i += 1000) {
      const rows = await this.invTxnRepo.find({
        where: {
          sourceLineRef: In(planRefs.slice(i, i + 1000)),
          region: group.region,
          status: 'SUCCESS',
        },
        select: { sourceLineRef: true },
      });
      for (const r of rows) if (r.sourceLineRef) postedRefs.add(r.sourceLineRef);
    }

    await mapWithConcurrency(
      group.inventoryTransactions,
      INVENTORY_CONCURRENCY,
      async (plan) => {
        // Per-line idempotency: a line's inventory is pushed to Oracle exactly
        // once. Keyed on <salesOrder>#<salesOrderLine> so two lines with the
        // same item both post (never aggregated), and a re-run never double-pushes.
        const sourceLineRef = `${plan.salesOrder}#${plan.salesOrderLine}`;
        const dedupeKey = `${txnNumber}:${sourceLineRef}:${plan.itemNumber}`;
        if (postedRefs.has(sourceLineRef)) {
          return; // already pushed to Oracle on a prior run
        }
        try {
          const orgId = await this.oracleClient.resolveSubinventoryOrgId(
            plan.subinventoryCode,
          );
          if (orgId == null) {
            throw new Error(
              `No inventory organisation found for subinventory "${plan.subinventoryCode}"`,
            );
          }
          const interfaceId = this.nextInterfaceId();
          await this.oracleClient.createStagedInventoryTransaction({
            organizationId: orgId,
            itemNumber: plan.itemNumber,
            subinventoryCode: plan.subinventoryCode,
            transactionQuantity: -Math.abs(plan.quantity), // issue = negative
            transactionUom: plan.uomCode,
            transactionDate: plan.transactionDate.toISOString(),
            transactionTypeName: this.inventoryTransactionType,
            transactionSourceName: plan.salesOrder,
            sourceCode: 'Vend',
            sourceHeaderId: interfaceId,
            sourceLineId: interfaceId,
            transactionInterfaceId: interfaceId,
          });
          await this.invTxnRepo.save(
            this.invTxnRepo.create({
              id: generateId(),
              organizationName: String(orgId),
              itemNumber: plan.itemNumber,
              txnSourceName: plan.salesOrder,
              sourceLineRef,
              subInventory: plan.subinventoryCode,
              txnUom: plan.uomCode,
              txnDate: plan.transactionDate,
              txnQty: -Math.abs(plan.quantity),
              region: group.region,
              status: 'SUCCESS',
              requestDate: new Date(),
            } as Partial<FusionInvTxn>),
          );
          base.inventoryTransactions = (base.inventoryTransactions ?? 0) + 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `[${group.branchCode}] inventory issue for ${plan.itemNumber} ` +
              `(${dedupeKey}) failed: ${message}`,
          );
          await this.invTxnRepo.save(
            this.invTxnRepo.create({
              id: generateId(),
              itemNumber: plan.itemNumber,
              txnSourceName: plan.salesOrder,
              sourceLineRef,
              subInventory: plan.subinventoryCode,
              txnQty: -Math.abs(plan.quantity),
              region: group.region,
              status: 'ERROR',
              message,
              requestDate: new Date(),
            } as Partial<FusionInvTxn>),
          );
        }
      },
    );


    // ── 4. Mark the contributing orders synced ───────────────────────────────
    await this.markOrdersSynced(group, txnNumber);

    this.logger.log(
      `[${group.branchCode} ${group.businessDay}] ✅ invoice ${txnNumber} ` +
        `(${base.sourceOrderCount} orders, ${base.invoiceLineCount} lines, ` +
        `${base.standardReceipts} receipts, ${base.journals} journals)`,
    );

    return {
      ...base,
      status: group.postInvoice ? 'CREATED' : 'SKIPPED',
      transactionNumber: txnNumber,
    };
  }

  private async persistInvoiceSuccess(
    group: DailyInvoiceGroup,
    txnNumber: string,
    customerTrxId: string,
  ): Promise<void> {
    const header = await this.invoiceHeaderRepo.save(
      this.invoiceHeaderRepo.create({
        id: generateId(),
        txnNumber: txnNumber ? Number(txnNumber) : null,
        customerTxnId: customerTrxId ? BigInt(customerTrxId) : null,
        status: 'SUCCESS',
        region: group.region,
        // Full sent payload (legacy FUSION_INVOICES parity) so the admin table
        // shows exactly which customer/account/BU the invoice went to.
        ...this.headerPayloadColumns(group),
        // Both dates are the business day being posted, not "now" — the daily
        // scheduler uses MAX(txnDate) as its catch-up watermark.
        txnDate: group.invoiceHeader.trxDate,
        glDate: group.invoiceHeader.saleDate,
        requestDate: new Date(),
      } as Partial<FusionInvoiceHeader>),
    );

    // One row per line, carrying the source order + line back-reference. This is
    // what makes a re-run idempotent.
    const rows = group.invoiceHeader.invoiceLines.map((line) =>
      this.invoiceLineRepo.create({
        id: generateId(),
        invoiceNumber: txnNumber,
        lineNumber: line.lineNumber,
        itemNumber: line.itemNumber ?? null,
        description: line.description ?? null,
        quantity: line.quantity,
        currencyCode: line.currencyCode,
        salesOrder: line.salesOrder ?? null,
        salesOrderLine: line.salesOrderLine
          ? Number(line.salesOrderLine)
          : null,
        region: group.region,
        status: 'SUCCESS',
        version: 1,
        headerId: header.id,
        requestDate: new Date(),
      } as Partial<FusionInvoiceLine>),
    );
    await this.invoiceLineRepo.save(rows);
  }

  /**
   * The invoice-header request columns, extracted from what was actually sent —
   * persisted on success AND failure so a rejected payload can be diagnosed
   * from the admin table alone (mirrors the legacy FUSION_INVOICES rows).
   */
  private headerPayloadColumns(
    group: DailyInvoiceGroup,
  ): Partial<FusionInvoiceHeader> {
    const h = group.invoiceHeader;
    const accNumber = /^\d+$/.test((h.billToAccountNumber ?? '').trim())
      ? BigInt(h.billToAccountNumber.trim())
      : null;
    const total = h.invoiceLines.reduce(
      (s, l) => s + l.unitSellingPrice * l.quantity,
      0,
    );
    return {
      billToCustName: h.billToCustomerName ?? null,
      billToLocation: h.billToLocation ?? null,
      billToAccNumber: accNumber,
      businessUnit: h.businessUnit ?? null,
      paymentTermsName: h.paymentTermsName ?? null,
      txnSource: h.transactionSource ?? null,
      txnType: h.transactionType ?? null,
      currencyCode: h.invoiceCurrencyCode,
      totalAmount: new Decimal(
        Math.round((total + Number.EPSILON) * 100) / 100,
      ),
    };
  }

  private async persistInvoiceFailure(
    group: DailyInvoiceGroup,
    message: string,
  ): Promise<void> {
    this.logger.error(
      `[${group.branchCode} ${group.businessDay}] invoice creation failed: ${message}`,
    );
    await this.invoiceHeaderRepo.save(
      this.invoiceHeaderRepo.create({
        id: generateId(),
        status: 'ERROR',
        message,
        region: group.region,
        ...this.headerPayloadColumns(group),
        txnDate: group.invoiceHeader.trxDate,
        glDate: group.invoiceHeader.saleDate,
        requestDate: new Date(),
      } as Partial<FusionInvoiceHeader>),
    );
  }

  /**
   * True when this receipt was already accepted by Oracle. Each object is
   * guarded independently (as the Java does) so a run that died between the
   * invoice and its receipts can be resumed without duplicating anything.
   */
  private async alreadyPosted(
    repo: Repository<
      FusionStandardReceipt | FusionMiscReceipt | FusionApplyReceipt
    >,
    receiptNumber: string,
    region: string,
  ): Promise<boolean> {
    const found = await repo.findOne({
      where: { receiptNumber, region, status: 'SUCCESS' },
      select: { id: true },
    });
    return !!found;
  }

  private async saveReceipt(
    repo: Repository<
      FusionStandardReceipt | FusionMiscReceipt | FusionApplyReceipt
    >,
    data: {
      receiptNumber: string;
      region: string;
      status: string;
      message: string | null;
      /** Full request payload columns — persisted so the admin tables show
       *  exactly what was sent to Oracle (like the legacy FUSION_* tables). */
      [key: string]: unknown;
    },
  ): Promise<void> {
    await repo.save(
      repo.create({
        id: generateId(),
        requestDate: new Date(),
        ...data,
      } as never),
    );
  }

  /**
   * Points every contributing OrderSyncQueue row at the aggregated invoice.
   * Orders are matched on the Odoo order id within the branch.
   */
  private async markOrdersSynced(
    group: DailyInvoiceGroup,
    txnNumber: string,
  ): Promise<void> {
    if (group.contributingOdooOrderIds.length === 0) return;
    await this.queueRepo.update(
      {
        odooOrderId: In(group.contributingOdooOrderIds),
        branchCode: group.branchCode,
      },
      {
        status: SyncStatus.SYNCED,
        oracleInvoiceNumber: txnNumber,
        lastSyncAt: new Date(),
      },
    );
  }

  /** YYYY-MM-DD + n days, without timezone drift. */
  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
}
