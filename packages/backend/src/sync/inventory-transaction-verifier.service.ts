/**
 * InventoryTransactionVerifierService — asks Oracle what actually happened to
 * the inventory issues we queued.
 *
 * DailyInvoiceService posts each issue into Oracle's staging interface with
 * TransactionMode 3, so the POST returns as soon as the row is queued. Whether
 * the stock actually moved is decided minutes later by Oracle's transaction
 * manager, and a rejection — insufficient quantity on a subinventory that does
 * not permit negative balances being the usual one — is written onto the
 * interface row, never returned on the original call.
 *
 * Before this service existed, every queued row was recorded SUCCESS on the
 * strength of that 200. A rejected issue looked identical to a good one, the
 * invoice stayed posted, the stock never moved, and the per-line dedupe then
 * skipped the line forever. This closes that loop: rows stay PENDING until
 * Oracle confirms them, and a rejection becomes a visible, retryable ERROR
 * carrying Oracle's own reason.
 *
 * Reading the interface is the only honest signal available. Oracle purges a
 * row once it is processed, so an absent row means success — but only after
 * enough time has passed that "not there yet" is ruled out, which is what
 * VERIFY_GRACE_MINUTES is for.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { OracleClient } from '../clients/oracle/oracle.client';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';

/**
 * How long Oracle gets before an absent interface row is read as "processed".
 * Too short and a row still waiting in the queue is called a success; the
 * transaction manager normally runs on a few-minute cycle, so 10 is generous
 * without letting a real failure sit unnoticed for long.
 */
const VERIFY_GRACE_MINUTES = Math.max(
  1,
  parseInt(process.env.INVENTORY_VERIFY_GRACE_MINUTES ?? '10', 10),
);

/**
 * A row still unconfirmed after this long is not "pending", it is lost — the
 * ESS transaction-manager job is probably not scheduled. Fail it loudly rather
 * than leaving it PENDING forever, where the dedupe would keep skipping it.
 */
const VERIFY_ABANDON_HOURS = Math.max(
  1,
  parseInt(process.env.INVENTORY_VERIFY_ABANDON_HOURS ?? '24', 10),
);

/** Rows checked per tick — the interface read is one REST call each. */
const VERIFY_BATCH = Math.max(
  1,
  parseInt(process.env.INVENTORY_VERIFY_BATCH ?? '200', 10),
);

export interface VerifySummary {
  checked: number;
  confirmed: number;
  rejected: number;
  stillPending: number;
  abandoned: number;
  unverifiable: number;
}

@Injectable()
export class InventoryTransactionVerifierService {
  private readonly logger = new Logger(InventoryTransactionVerifierService.name);
  private isRunning = false;

  constructor(
    @InjectRepository(FusionInvTxn)
    private readonly invTxns: Repository<FusionInvTxn>,
    private readonly oracleClient: OracleClient,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /** Every 15 minutes, in step with Oracle's own interface processing. */
  @Cron('0 */15 * * * *')
  async runScheduled(): Promise<void> {
    if (this.isRunning) return;
    if (await this.circuitBreaker.isAnyOpen('oracle:')) {
      this.logger.warn(
        '⛔ Oracle circuit breaker is OPEN — skipping inventory verification.',
      );
      return;
    }
    this.isRunning = true;
    try {
      const summary = await this.verifyPending();
      if (summary.checked > 0) {
        this.logger.log(
          `Inventory verification: ${summary.confirmed} confirmed, ` +
            `${summary.rejected} REJECTED by Oracle, ${summary.stillPending} still pending, ` +
            `${summary.abandoned} abandoned of ${summary.checked} checked.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Inventory verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Checks every PENDING issue old enough to have been processed, and settles
   * it. Safe to call manually and safe to call concurrently with a posting run
   * — a row is only ever moved out of PENDING, never back into it.
   */
  async verifyPending(limit = VERIFY_BATCH): Promise<VerifySummary> {
    const graceCutoff = new Date(Date.now() - VERIFY_GRACE_MINUTES * 60_000);
    const abandonCutoff = new Date(
      Date.now() - VERIFY_ABANDON_HOURS * 3_600_000,
    );

    const pending = await this.invTxns.find({
      where: {
        status: 'PENDING',
        txnInterfaceId: Not(IsNull()),
        requestDate: LessThan(graceCutoff),
      },
      order: { requestDate: 'ASC' },
      take: limit,
    });

    const summary: VerifySummary = {
      checked: pending.length,
      confirmed: 0,
      rejected: 0,
      stillPending: 0,
      abandoned: 0,
      unverifiable: 0,
    };

    for (const row of pending) {
      try {
        const result = await this.oracleClient.getStagedInventoryTransaction(
          row.txnInterfaceId as number,
        );

        if (result.errorExplanation) {
          // Oracle rejected it outright. This is the negative-balance case:
          // the invoice is posted but the stock was never relieved.
          await this.settle(
            row,
            'ERROR',
            `Oracle rejected the inventory issue: ${result.errorExplanation}`,
          );
          summary.rejected += 1;
          this.logger.error(
            `❌ Inventory issue rejected by Oracle — ${row.itemNumber} ` +
              `(${row.sourceLineRef}, ${row.subInventory}, qty ${row.txnQty}): ` +
              result.errorExplanation,
          );
          continue;
        }

        if (!result.found) {
          // Processed and purged from the interface. The row is past the grace
          // window, so absence is the success signal rather than "not yet".
          await this.settle(row, 'SUCCESS', null);
          summary.confirmed += 1;
          continue;
        }

        // Still sitting in the interface. Give it until the abandon cutoff,
        // then stop calling it pending — an unprocessed row usually means the
        // "Manage Inventory Transactions" ESS job is not running at all.
        if (row.requestDate && row.requestDate < abandonCutoff) {
          await this.settle(
            row,
            'ERROR',
            `Still unprocessed in Oracle's staging interface after ` +
              `${VERIFY_ABANDON_HOURS}h (ProcessStatus ` +
              `${result.processStatus ?? 'unknown'}). Check that the ` +
              `"Manage Inventory Transactions" ESS job is scheduled.`,
          );
          summary.abandoned += 1;
          continue;
        }

        summary.stillPending += 1;
      } catch (err) {
        // A failed lookup says nothing about the transaction — leave the row
        // PENDING so the next tick tries again rather than inventing a verdict.
        summary.unverifiable += 1;
        this.logger.warn(
          `Could not verify inventory issue ${row.txnInterfaceId} ` +
            `(${row.sourceLineRef}): ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    }

    return summary;
  }

  /**
   * Issues Oracle rejected, newest first — the queue an operator has to work
   * through, because each one is stock that was sold but never relieved.
   */
  async listRejected(limit = 100): Promise<FusionInvTxn[]> {
    return this.invTxns.find({
      where: { status: 'ERROR' },
      order: { requestDate: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /** Counts by status, for the dashboard tile. */
  async statusCounts(): Promise<Record<string, number>> {
    const rows = await this.invTxns
      .createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.status')
      .getRawMany<{ status: string; count: string | number }>();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.count);
    return out;
  }

  private async settle(
    row: FusionInvTxn,
    status: 'SUCCESS' | 'ERROR',
    message: string | null,
  ): Promise<void> {
    await this.invTxns.update(row.id, {
      status,
      message,
      verifiedAt: new Date(),
    });
  }
}
