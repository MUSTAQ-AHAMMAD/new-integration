import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AuditOperation, AuditStatus } from '../database/enums';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { RefundTracking } from '../database/entities/refund-tracking.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { SyncStatus } from '../database/enums';
import { IdempotencyService } from '../sync/idempotency.service';
import { OdooTransformationService } from '../sync/odoo-transformation.service';

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
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(BackupOdooOrder)
    private readonly backups: Repository<BackupOdooOrder>,
    private readonly odooTransformation: OdooTransformationService,
    private readonly oracleClient: OracleSoapClient,
    private readonly idempotency: IdempotencyService,
    @Optional() private readonly circuitBreaker?: CircuitBreakerService,
  ) {
    // Auto-push shares the invoice pipeline's on/off switch by default, with its
    // own override so finance can pause credit-memo posting independently.
    this.enabled =
      process.env.CREDIT_MEMO_AUTO_PUSH_ENABLED !== 'false' &&
      process.env.PIPELINE_ENABLED !== 'false';
    this.batchSize = parseInt(
      process.env.CREDIT_MEMO_BATCH_SIZE || '50',
      10,
    );
  }

  /**
   * Cron — pushes PENDING refunds as credit memos every 5 minutes, in step with
   * the invoice pipeline. Skips when Oracle's circuit breaker is OPEN to avoid a
   * retry storm; PENDING refunds are retried on the next tick.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runAutoPush(): Promise<void> {
    if (!this.enabled || this.isRunning) return;

    if (this.circuitBreaker && (await this.circuitBreaker.isAnyOpen('oracle:'))) {
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

      const storeConfig = await this.stores.findOne({
        where: { branchCode },
        select: { region: true },
      });
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

      const response = await this.oracleClient.createCreditMemo(header);

      // Best-effort: apply the memo to the invoice it credits. The memo already
      // exists in Oracle, so an application failure must NOT fail the push — it
      // is recorded as a note and the memo stays SYNCED (left on-account) for
      // finance to apply manually.
      const applicationNote = await this.applyToInvoice(
        response.transactionNumber,
        originalTransactionNumber,
        Number(refund.refundAmount),
        header.invoiceCurrencyCode,
        refund.refundDate,
      );

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
        requestPayload: header as unknown as object,
        responsePayload: response as unknown as object,
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

  /**
   * Applies a freshly-created credit memo to the invoice it credits. Returns a
   * human-readable note when the memo was left on-account (application disabled,
   * no original invoice, or Oracle rejected the application) so it surfaces on
   * the Refunds page; returns null when fully applied. Never throws — the memo
   * already exists and must not be lost over an application hiccup.
   */
  private async applyToInvoice(
    creditMemoNumber: string,
    originalTransactionNumber: string | null,
    amount: number,
    currencyCode: string,
    applyDate: Date,
  ): Promise<string | null> {
    if (!originalTransactionNumber) {
      return 'Credit memo created on-account — no original Oracle invoice found to apply against.';
    }
    if (!this.oracleClient.isCreditMemoApplicationEnabled()) {
      return `Credit memo ${creditMemoNumber} created on-account; auto-application to invoice ${originalTransactionNumber} is disabled (set ORACLE_CM_APPLY_ENABLED=true once verified).`;
    }
    try {
      await this.oracleClient.applyCreditMemo({
        applyDate,
        transactionNumber: originalTransactionNumber,
        creditMemoNumber,
        amountApplied: amount,
        currencyCode,
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
