import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AuditOperation, AuditStatus } from '../database/enums';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';
import {
  CreditMemoHeader,
  OracleSoapClient,
  hasCreditMemoSoapIds,
} from '../clients/oracle/oracle-soap.client';
import {
  OracleClient,
  OracleLiveCreditMemo,
  OracleLiveInvoice,
} from '../clients/oracle/oracle.client';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { StoreConfigService } from '../store-config/store-config.service';
import { SyncStatus } from '../database/enums';
import { IdempotencyService } from '../sync/idempotency.service';
import { OdooTransformationService } from '../sync/odoo-transformation.service';

/**
 * What Oracle actually holds for a refund, read back live. Used by the Refunds
 * screen's Verify action — our own row records only what was sent.
 */
export interface CreditMemoVerification {
  refundId: string;
  refundOrderNumber: string;
  refundAmount: number;
  creditMemoNumber: string | null;
  creditMemoFound: boolean;
  creditMemo: OracleLiveCreditMemo | null;
  /** Oracle's memo total agrees with the refund amount (to the cent). */
  amountMatches: boolean;
  /** Memo balance is zero — it has been applied, not left on-account. */
  applied: boolean;
  invoiceNumber: string | null;
  invoice: OracleLiveInvoice | null;
  /** Human-readable reasons this refund is not fully settled in Oracle. */
  problems: string[];
}

export interface CreditMemoPushResult {
  refundId: string;
  refundOrderNumber: string;
  status: 'SYNCED' | 'FAILED' | 'SKIPPED';
  creditMemoNumber?: string;
  error?: string;
}

/**
 * CreditMemoService — auto-pushes refunds recorded in RefundTracking to Oracle
 * as credit memos.
 *
 * Refund / cancel orders are never sent to Oracle as invoices (the order-sync
 * pipeline diverts them). Refunds land in RefundTracking with
 * creditMemoStatus=PENDING; this service picks them up on a cron, builds a
 * Credit-Memo-class payload (see OdooTransformationService.buildCreditMemoPayload),
 * pushes it, and records the resulting oracleCreditMemoNumber. Failures are
 * marked FAILED with a reason and surface on the Refunds admin page for retry.
 */
@Injectable()
export class CreditMemoService {
  private readonly logger = new Logger(CreditMemoService.name);
  private isRunning = false;
  private readonly enabled: boolean;
  private readonly batchSize: number;

  constructor(
    @InjectRepository(RefundTracking)
    private readonly refunds: Repository<RefundTracking>,
    @InjectRepository(OrderSyncQueue)
    private readonly orders: Repository<OrderSyncQueue>,
    private readonly storeConfigService: StoreConfigService,
    @InjectRepository(BackupOdooOrder)
    private readonly backups: Repository<BackupOdooOrder>,
    private readonly odooTransformation: OdooTransformationService,
    private readonly oracleClient: OracleSoapClient,
    private readonly restClient: OracleClient,
    @InjectRepository(FusionInvoiceHeader)
    private readonly invoiceHeaders: Repository<FusionInvoiceHeader>,
    private readonly idempotency: IdempotencyService,
    @Optional() private readonly circuitBreaker?: CircuitBreakerService,
  ) {
    // Auto-push shares the invoice pipeline's on/off switch by default, with its
    // own override so finance can pause credit-memo posting independently.
    this.enabled =
      process.env.CREDIT_MEMO_AUTO_PUSH_ENABLED !== 'false' &&
      process.env.PIPELINE_ENABLED !== 'false';
    this.batchSize = parseInt(process.env.CREDIT_MEMO_BATCH_SIZE || '50', 10);
  }

  /**
   * Cron — pushes PENDING refunds as credit memos every 5 minutes, in step with
   * the invoice pipeline. Skips when Oracle's circuit breaker is OPEN to avoid a
   * retry storm; PENDING refunds are retried on the next tick.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runAutoPush(): Promise<void> {
    if (!this.enabled || this.isRunning) return;

    if (
      this.circuitBreaker &&
      (await this.circuitBreaker.isAnyOpen('oracle:'))
    ) {
      this.logger.warn(
        '⛔ Oracle circuit breaker is OPEN — skipping credit-memo auto-push.',
      );
      return;
    }

    this.isRunning = true;
    try {
      const results = await this.processPending(this.batchSize);
      const synced = results.filter((r) => r.status === 'SYNCED').length;
      const failed = results.filter((r) => r.status === 'FAILED').length;
      if (results.length > 0) {
        this.logger.log(
          `Credit-memo auto-push: ${synced} synced, ${failed} failed ` +
            `of ${results.length} pending refund(s).`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Credit-memo auto-push failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.isRunning = false;
    }
  }

  /** Processes up to `limit` PENDING refunds, pushing each as a credit memo. */
  async processPending(limit = 50): Promise<CreditMemoPushResult[]> {
    const pending = await this.refunds.find({
      where: { creditMemoStatus: SyncStatus.PENDING },
      order: { refundDate: 'ASC' },
      take: limit,
    });

    const results: CreditMemoPushResult[] = [];
    for (const refund of pending) {
      results.push(await this.pushRefund(refund.id));
    }
    return results;
  }

  /**
   * Builds and pushes the credit memo for a single RefundTracking record.
   * Idempotent: a refund already posted to Oracle (per the audit log) is marked
   * SYNCED without a second push.
   */
  async pushRefund(refundId: string): Promise<CreditMemoPushResult> {
    const startedAt = Date.now();
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) {
      throw new NotFoundException(`Refund ${refundId} not found`);
    }

    const base: CreditMemoPushResult = {
      refundId: refund.id,
      refundOrderNumber: refund.refundOrderNumber,
      status: 'SKIPPED',
    };

    try {
      // ── Resolve branch → store config → region ──────────────────────────
      const branchCode =
        refund.branchCode ??
        (
          await this.orders.findOne({
            where: { odooOrderId: refund.refundOrderId },
            select: { branchCode: true },
          })
        )?.branchCode ??
        null;
      if (!branchCode) {
        return this.markFailed(
          refund.id,
          base,
          'No branchCode on the refund and none found in OrderSyncQueue — ' +
            'cannot resolve store configuration for the credit memo.',
        );
      }

      // Auto-create the store configuration when missing, exactly like the
      // order-sync path — a refund for a branch we have reference data for
      // (outlet config / sales metadata / register) must not hard-fail on a
      // missing StoreConfiguration row.
      const storeConfig =
        await this.storeConfigService.getOrCreateStoreConfig(branchCode);
      const region = storeConfig?.region ?? branchCode;

      // ── Idempotency: skip if this refund was already posted ─────────────
      const idempotencyKey = this.idempotency.generateKey(
        refund.refundOrderId,
        AuditOperation.CREATE_CREDIT_MEMO,
      );
      if (await this.idempotency.isDuplicate(idempotencyKey)) {
        this.logger.log(
          `Refund ${refund.refundOrderNumber} already has a credit memo — marking SYNCED.`,
        );
        await this.refunds.update(refund.id, {
          creditMemoStatus: SyncStatus.SYNCED,
          failureReason: null,
        });
        return { ...base, status: 'SYNCED' };
      }

      // ── Resolve original invoice number (for an applied credit memo) ────
      const originalTransactionNumber =
        await this.resolveOriginalInvoiceNumber(refund);

      // ── Locate the refund's backup order for line detail (optional) ─────
      const backupOrder = await this.backups.findOne({
        where: { orderName: refund.refundOrderNumber },
        select: { id: true },
      });

      // ── Build + push the credit-memo payload ────────────────────────────
      const header = await this.odooTransformation.buildCreditMemoPayload(
        backupOrder?.id ?? null,
        branchCode,
        region,
        {
          refundOrderNumber: refund.refundOrderNumber,
          refundAmount: Number(refund.refundAmount),
          refundDate: refund.refundDate,
          reason: refund.refundReason,
          originalTransactionNumber: originalTransactionNumber ?? undefined,
        },
      );

      // Prefer Oracle's CreditMemoService — the payload verified against the
      // pod — and fall back to the REST resource for branches whose numeric
      // ids are not filled in yet. The two produce the same document, so a
      // half-configured branch keeps posting refunds instead of hard-failing.
      const response = hasCreditMemoSoapIds(header)
        ? await this.createViaCreditMemoService(header)
        : await this.createViaRest(
            header,
            branchCode,
            region,
            refund.refundOrderNumber,
          );

      // Best-effort: apply the memo to the invoice it credits. The memo already
      // exists in Oracle, so an application failure must NOT fail the push — it
      // is recorded as a note and the memo stays SYNCED (left on-account) for
      // finance to apply manually.
      const applicationNote = await this.applyToInvoice({
        creditMemoNumber: response.transactionNumber,
        originalTransactionNumber,
        amount: Number(refund.refundAmount),
        businessUnit: header.businessUnit,
        applyDate: refund.refundDate,
      });

      await this.refunds.update(refund.id, {
        oracleCreditMemoNumber: response.transactionNumber,
        originalInvoiceNumber:
          refund.originalInvoiceNumber ?? originalTransactionNumber ?? null,
        creditMemoStatus: SyncStatus.SYNCED,
        syncedAt: new Date(),
        failureReason: applicationNote,
      });

      await this.idempotency.recordOperation({
        idempotencyKey,
        externalId: refund.refundOrderId,
        externalSystem: 'ODOO',
        targetSystem: 'ORACLE',
        operation: AuditOperation.CREATE_CREDIT_MEMO,
        status: AuditStatus.SUCCESS,
        requestPayload: header,
        responsePayload: response,
        oracleResponseId: response.transactionNumber,
        processingDurationMs: Date.now() - startedAt,
      });

      this.logger.log(
        `✅ Credit memo ${response.transactionNumber} created for refund ` +
          `${refund.refundOrderNumber} (${String(refund.refundAmount)}).`,
      );
      return {
        ...base,
        status: 'SYNCED',
        creditMemoNumber: response.transactionNumber,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.markFailed(refund.id, base, message, Date.now() - startedAt);
    }
  }

  private revenueAccountCache = new Map<string, string>();

  private round2(v: number): number {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  /**
   * Resolves the Revenue GL account a credit memo should book to.
   *
   * A credit memo reverses the same revenue Oracle booked on the store's sales,
   * so we take a real invoice's revenue account as a template and substitute the
   * store's own cost centre (segment 4). This self-configures from live Oracle
   * data — no hard-coded chart-of-accounts — and is cached per branch.
   */
  private async resolveRevenueAccount(
    branchCode: string,
    region: string,
    branchName: string,
  ): Promise<string> {
    const cached = this.revenueAccountCache.get(branchCode);
    if (cached) return cached;

    // Template: any recent successful invoice's revenue account for the region.
    const refInvoice = await this.invoiceHeaders.findOne({
      where: { region, status: 'SUCCESS', customerTxnId: Not(IsNull()) },
      order: { requestDate: 'DESC' },
      select: { customerTxnId: true },
    });
    if (!refInvoice?.customerTxnId) {
      throw new Error(
        `No successful invoice in region ${region} to derive a revenue account ` +
          `from — post at least one sales invoice before crediting.`,
      );
    }
    const template = await this.restClient.getInvoiceRevenueAccount(
      String(refInvoice.customerTxnId),
    );
    if (!template) {
      throw new Error(
        `Could not read a revenue account from invoice ${refInvoice.customerTxnId}.`,
      );
    }

    // Substitute segment 4 (cost centre) with this store's own.
    const costCenter =
      await this.odooTransformation.resolveStoreCostCenterPublic(
        branchName,
        region,
      );
    const segments = template.split('-');
    if (costCenter && segments.length >= 5) {
      segments[3] = costCenter;
    }
    const account = segments.join('-');
    this.revenueAccountCache.set(branchCode, account);
    this.logger.log(
      `[${branchCode}] credit-memo revenue account resolved: ${account} ` +
        `(template ${template}, cost centre ${costCenter ?? 'template default'})`,
    );
    return account;
  }

  /**
   * Creates the memo through CreditMemoService.createCreditMemo — the verified
   * SOAP payload. Line items are identified by Oracle's numeric InventoryItemId;
   * an item Oracle does not know is sent as a description-only line rather than
   * failing the whole memo (same rule the REST path uses).
   */
  private async createViaCreditMemoService(
    header: CreditMemoHeader,
  ): Promise<{ transactionNumber: string; customerTrxId: string }> {
    for (const line of header.creditMemoLines) {
      const item = line.itemNumber?.trim();
      if (!item) continue;
      const itemId = await this.restClient.resolveItemId(item).catch(() => null);
      if (itemId) {
        line.inventoryItemId = itemId;
      } else {
        this.logger.warn(
          `Item "${item}" has no Oracle InventoryItemId — credit-memo line ` +
            `${line.lineNumber} sent as description-only.`,
        );
      }
    }

    const result = await this.oracleClient.createCreditMemoViaService(header);
    return {
      transactionNumber: result.transactionNumber,
      customerTrxId: result.customerTrxId,
    };
  }

  /**
   * Legacy fallback: creates the memo through the REST resource, working from
   * names instead of ids. Used only while a branch is missing its Oracle ids.
   */
  private async createViaRest(
    header: CreditMemoHeader,
    branchCode: string,
    region: string,
    refundOrderNumber: string,
  ): Promise<{ transactionNumber: string; customerTrxId: string }> {
    this.logger.warn(
      `[${branchCode}] no Oracle credit-memo ids configured — falling back to ` +
        `the REST create for refund ${refundOrderNumber}. Set BillToCustomerId, ` +
        `BillToSiteUseId, PaymentTermsId, BatchSourceSequenceId and ` +
        `CreditMemoTrxTypeId on the Stores admin screen to use CreditMemoService.`,
    );

    const revenueAccount = await this.resolveRevenueAccount(
      branchCode,
      region,
      header.billToCustomerName,
    );
    // Items unknown to Oracle's catalog would fail the whole memo with
    // AR-857618 ("The item you entered ... doesn't exist"). ItemNumber is
    // optional on Manual-source credit-memo lines — the distribution carries
    // the revenue account — so fall back to a description-only line for any
    // item Oracle doesn't know rather than losing the refund.
    const itemKnown = new Map<string, boolean>();
    for (const l of header.creditMemoLines) {
      const item = l.itemNumber?.trim();
      if (item && !itemKnown.has(item)) {
        itemKnown.set(
          item,
          await this.restClient.itemExists(item).catch(() => false),
        );
      }
    }
    const restResult = await this.restClient.createCreditMemoViaRest({
      businessUnit: header.businessUnit,
      billToCustomerNumber: header.billToAccountNumber,
      currency: header.invoiceCurrencyCode,
      transactionDate: (header.memoDate instanceof Date
        ? header.memoDate
        : new Date(String(header.memoDate))
      )
        .toISOString()
        .slice(0, 10),
      transactionType: header.transactionType,
      lines: header.creditMemoLines.map((l, i) => {
        const qty = Math.abs(l.quantity || 1);
        const price = Math.abs(l.unitSellingPrice || 0);
        const item = l.itemNumber?.trim();
        const knownItem = item && itemKnown.get(item) ? item : undefined;
        if (item && !knownItem) {
          this.logger.warn(
            `[${refundOrderNumber}] item "${item}" not in Oracle ` +
              `catalog — credit-memo line ${i + 1} sent as description-only.`,
          );
        }
        return {
          lineNumber: l.lineNumber ?? i + 1,
          description: l.description ?? `Refund line ${i + 1}`,
          quantityCredit: -qty,
          unitSellingPrice: price,
          itemNumber: knownItem,
          revenueAccount,
          amount: -this.round2(qty * price),
        };
      }),
    });
    return {
      transactionNumber: restResult.transactionNumber,
      customerTrxId: restResult.customerTransactionId,
    };
  }

  /**
   * Applies a memo that already exists in Oracle to the invoice it credits.
   *
   * Every memo created while application was switched off is sitting
   * on-account; this is how the Refunds screen clears them without creating a
   * second memo. Safe to re-run: Oracle rejects a double application, and the
   * failure is recorded as a note rather than losing the memo.
   */
  async applyExisting(refundId: string): Promise<{
    refundId: string;
    creditMemoNumber: string;
    invoiceNumber: string;
    applied: boolean;
    note: string | null;
  }> {
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException(`Refund ${refundId} not found`);
    if (!refund.oracleCreditMemoNumber) {
      throw new BadRequestException(
        `Refund ${refund.refundOrderNumber} has no Oracle credit memo yet — push it first.`,
      );
    }

    const invoiceNumber = await this.resolveOriginalInvoiceNumber(refund);
    if (!invoiceNumber) {
      throw new BadRequestException(
        `No original Oracle invoice found for refund ${refund.refundOrderNumber} — ` +
          `the memo can only stay on-account.`,
      );
    }

    const branchCode = await this.resolveBranchCode(refund);
    const storeConfig = branchCode
      ? await this.storeConfigService.getOrCreateStoreConfig(branchCode)
      : null;
    if (!storeConfig) {
      throw new BadRequestException(
        `No store configuration for refund ${refund.refundOrderNumber} — ` +
          `the business unit is required to apply a credit memo.`,
      );
    }

    const note = await this.applyToInvoice({
      creditMemoNumber: refund.oracleCreditMemoNumber,
      originalTransactionNumber: invoiceNumber,
      amount: Number(refund.refundAmount),
      businessUnit: storeConfig.oracleBusinessUnit,
      applyDate: refund.refundDate,
    });

    await this.refunds.update(refund.id, {
      originalInvoiceNumber: refund.originalInvoiceNumber ?? invoiceNumber,
      failureReason: note,
    });

    return {
      refundId: refund.id,
      creditMemoNumber: refund.oracleCreditMemoNumber,
      invoiceNumber,
      applied: note === null,
      note,
    };
  }

  /**
   * Reads the refund's memo — and the invoice it credits — back out of Oracle.
   *
   * Our own row only records what we sent. This answers the two questions that
   * actually matter: does the memo exist in Oracle with the amount we intended,
   * and has it been applied (balance driven to zero) or is it still on-account?
   */
  async verify(refundId: string): Promise<CreditMemoVerification> {
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException(`Refund ${refundId} not found`);

    const result: CreditMemoVerification = {
      refundId: refund.id,
      refundOrderNumber: refund.refundOrderNumber,
      refundAmount: Number(refund.refundAmount),
      creditMemoNumber: refund.oracleCreditMemoNumber ?? null,
      creditMemoFound: false,
      creditMemo: null,
      amountMatches: false,
      applied: false,
      invoiceNumber: null,
      invoice: null,
      problems: [],
    };

    if (!refund.oracleCreditMemoNumber) {
      result.problems.push('No credit memo has been created for this refund yet.');
      return result;
    }

    const memo = await this.restClient
      .getCreditMemoByTransactionNumber(refund.oracleCreditMemoNumber)
      .catch((err: unknown) => {
        result.problems.push(
          `Could not read the credit memo from Oracle: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });

    if (!memo) {
      if (result.problems.length === 0) {
        result.problems.push(
          `Oracle has no credit memo ${refund.oracleCreditMemoNumber} — our row ` +
            `records one, so the create did not land. Re-push this refund.`,
        );
      }
      return result;
    }

    result.creditMemoFound = true;
    result.creditMemo = memo;

    const expected = this.round2(Math.abs(Number(refund.refundAmount)));
    const actual =
      memo.enteredAmount != null ? this.round2(Math.abs(memo.enteredAmount)) : null;
    result.amountMatches = actual != null && Math.abs(actual - expected) < 0.01;
    if (!result.amountMatches) {
      result.problems.push(
        `Amount mismatch: refund is ${expected} ${memo.currencyCode ?? ''} but ` +
          `Oracle holds ${actual ?? 'an unreadable amount'}.`,
      );
    }

    // A zero balance is the proof of application — stronger than trusting our
    // own note, which only records what the apply call returned at the time.
    result.applied = memo.balanceAmount != null && Math.abs(memo.balanceAmount) < 0.01;
    if (!result.applied) {
      result.problems.push(
        `Credit memo is still on-account (balance ${memo.balanceAmount ?? 'unknown'}) — ` +
          `it has not been applied to an invoice.`,
      );
    }

    const invoiceNumber = await this.resolveOriginalInvoiceNumber(refund);
    result.invoiceNumber = invoiceNumber;
    if (invoiceNumber) {
      result.invoice = await this.restClient
        .getInvoiceByTransactionNumber(invoiceNumber)
        .catch(() => null);
      if (!result.invoice) {
        result.problems.push(
          `Could not read the credited invoice ${invoiceNumber} back from Oracle.`,
        );
      }
    } else {
      result.problems.push(
        'No original Oracle invoice is linked to this refund, so the memo can ' +
          'only ever sit on-account.',
      );
    }

    return result;
  }

  /** branchCode from the refund, falling back to its order-sync row. */
  private async resolveBranchCode(refund: {
    branchCode: string | null;
    refundOrderId: string;
  }): Promise<string | null> {
    return (
      refund.branchCode ??
      (
        await this.orders.findOne({
          where: { odooOrderId: refund.refundOrderId },
          select: { branchCode: true },
        })
      )?.branchCode ??
      null
    );
  }

  /**
   * Applies a freshly-created credit memo to the invoice it credits. Returns a
   * human-readable note when the memo was left on-account (application disabled,
   * no original invoice, or Oracle rejected the application) so it surfaces on
   * the Refunds page; returns null when fully applied. Never throws — the memo
   * already exists and must not be lost over an application hiccup.
   */
  private async applyToInvoice(req: {
    creditMemoNumber: string;
    originalTransactionNumber: string | null;
    amount: number;
    businessUnit: string;
    applyDate: Date;
  }): Promise<string | null> {
    const { creditMemoNumber, originalTransactionNumber, applyDate } = req;
    if (!originalTransactionNumber) {
      return 'Credit memo created on-account — no original Oracle invoice found to apply against.';
    }
    if (!this.oracleClient.isCreditMemoApplicationEnabled()) {
      return `Credit memo ${creditMemoNumber} created on-account; auto-application to invoice ${originalTransactionNumber} is switched off (ORACLE_CM_APPLY_ENABLED=false).`;
    }
    try {
      await this.oracleClient.applyCreditMemo({
        applyDate,
        transactionNumber: originalTransactionNumber,
        creditMemoNumber,
        amountApplied: req.amount,
        businessUnit: req.businessUnit,
        glDate: applyDate,
      });
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const note = `Credit memo ${creditMemoNumber} created but NOT applied to invoice ${originalTransactionNumber} (apply manually in Oracle): ${msg}`;
      this.logger.warn(note);
      return note.slice(0, 1000);
    }
  }

  /**
   * Finds the Oracle invoice number of the original (credited) order so the
   * memo can be applied to it. Prefers a value already stored on the refund,
   * then looks up the original order in OrderSyncQueue. Returns null → the memo
   * is created on-account.
   */
  private async resolveOriginalInvoiceNumber(refund: {
    originalInvoiceNumber: string | null;
    originalOrderId: string;
    originalOrderNumber: string;
  }): Promise<string | null> {
    if (refund.originalInvoiceNumber) return refund.originalInvoiceNumber;

    const original = await this.orders.findOne({
      where: [
        {
          odooOrderId: refund.originalOrderId,
          oracleInvoiceNumber: Not(IsNull()),
        },
        {
          odooOrderNumber: refund.originalOrderNumber,
          oracleInvoiceNumber: Not(IsNull()),
        },
      ],
      select: { oracleInvoiceNumber: true },
    });
    return original?.oracleInvoiceNumber ?? null;
  }

  private async markFailed(
    refundId: string,
    base: CreditMemoPushResult,
    error: string,
    processingDurationMs = 0,
  ): Promise<CreditMemoPushResult> {
    this.logger.error(
      `❌ Credit memo failed for refund ${base.refundOrderNumber}: ${error}`,
    );
    await this.refunds.update(refundId, {
      creditMemoStatus: SyncStatus.FAILED,
      failureReason: error.slice(0, 1000),
    });
    // Audit is best-effort — never let it mask the original failure.
    try {
      await this.idempotency.recordOperation({
        idempotencyKey: this.idempotency.generateKey(
          base.refundId,
          AuditOperation.CREATE_CREDIT_MEMO,
          'failed',
        ),
        externalId: base.refundId,
        externalSystem: 'ODOO',
        targetSystem: 'ORACLE',
        operation: AuditOperation.CREATE_CREDIT_MEMO,
        status: AuditStatus.FAILED,
        requestPayload: { refundId: base.refundId },
        errorMessage: error.slice(0, 1000),
        processingDurationMs,
      });
    } catch {
      /* ignore audit failure */
    }
    return { ...base, status: 'FAILED', error };
  }
}
