import { Injectable, Logger } from '@nestjs/common';
import { StoreConfigService } from '../store-config/store-config.service';
import { PaymentMappingService } from '../payment-mapping/payment-mapping.service';
import { SyncService } from '../sync/sync.service';
import { AutoFixService } from '../sync/auto-fix.service';
import type {
  RemediationOptions,
  RemediationResult,
  RemediationStepResult,
} from './ai-monitor.types';

/**
 * Guided, ordered remediation of the issues the AI monitor surfaces.
 *
 * It automates the operational runbook in the exact order the diagnostics
 * require:
 *
 *   Step 2 — populate store configuration (fixes VALIDATION/CONFIG failures)
 *   Step 3 — resolve unmapped payment methods (clears the payment alerts)
 *   Step 4 — retry the failed/dead-letter backlog — **only** after 2 & 3 are
 *            clean, otherwise the retried orders re-fail on the same root cause
 *   Step 5 — auto-fix + retry skipped orders (informational, lowest priority)
 *
 * Step 1 of the runbook (restarting the worker container) is an infrastructure
 * action that cannot be performed from inside the application, so it is out of
 * scope here; the response notes it explicitly.
 */
@Injectable()
export class RemediationService {
  private readonly logger = new Logger(RemediationService.name);

  constructor(
    private readonly storeConfig: StoreConfigService,
    private readonly paymentMapping: PaymentMappingService,
    private readonly sync: SyncService,
    private readonly autoFix: AutoFixService,
  ) {}

  async remediate(
    options: RemediationOptions = {},
  ): Promise<RemediationResult> {
    const dryRun = options.dryRun ?? false;
    const includeSkipped = options.includeSkipped ?? true;
    const skippedLimit = options.skippedLimit ?? 1000;
    const startedAt = new Date().toISOString();

    this.logger.log(
      `Starting guided remediation (dryRun=${dryRun}, includeSkipped=${includeSkipped})`,
    );

    const steps: RemediationStepResult[] = [];

    // ── Step 2: populate store configuration ─────────────────────────────────
    const configStep = await this.runStoreConfig(dryRun);
    steps.push(configStep);

    // ── Step 3: resolve unmapped payment methods ─────────────────────────────
    const paymentStep = await this.runPaymentMappings(
      dryRun,
      options.approvePaymentMappingsBy,
    );
    steps.push(paymentStep);

    // ── Step 4: retry the failed backlog — gated behind steps 2 & 3 ──────────
    // In a dry run nothing mutated, so there is nothing to gate on; preview the
    // step instead. Otherwise block it whenever config or mappings are not ok.
    const gateBlockers: string[] = [];
    if (!dryRun) {
      if (configStep.status !== 'ok') gateBlockers.push('store configuration');
      if (paymentStep.status !== 'ok') gateBlockers.push('payment mappings');
    }

    if (gateBlockers.length > 0) {
      steps.push({
        id: 'retry-failed',
        step: 4,
        title: 'Retry failed transactions',
        status: 'blocked',
        message: `Skipped to avoid re-failing orders: resolve ${gateBlockers.join(
          ' and ',
        )} first (steps 2 & 3).`,
        details: { blockedBy: gateBlockers },
      });
    } else {
      steps.push(await this.runRetryFailed(dryRun));
    }

    // ── Step 5: auto-fix + retry skipped orders (informational) ──────────────
    if (includeSkipped) {
      steps.push(await this.runSkipped(dryRun, skippedLimit));
    } else {
      steps.push({
        id: 'skipped-orders',
        step: 5,
        title: 'Auto-fix and retry skipped orders',
        status: 'skipped',
        message: 'Skipped because includeSkipped=false.',
      });
    }

    const finishedAt = new Date().toISOString();
    const attempted = steps.filter((s) => s.status !== 'skipped');
    const ok =
      attempted.length > 0 && attempted.every((s) => s.status === 'ok');

    const result: RemediationResult = {
      startedAt,
      finishedAt,
      dryRun,
      ok,
      steps,
      summary: this.buildSummary(steps, dryRun),
    };

    this.logger.log(
      `Guided remediation finished: ok=${ok} ${steps
        .map((s) => `${s.id}=${s.status}`)
        .join(' ')}`,
    );

    return result;
  }

  private async runStoreConfig(
    dryRun: boolean,
  ): Promise<RemediationStepResult> {
    const base: RemediationStepResult = {
      id: 'store-config',
      step: 2,
      title: 'Populate store configuration',
      status: 'ok',
      message: '',
    };
    if (dryRun) {
      return {
        ...base,
        status: 'skipped',
        message:
          'Dry run: would populate all branches and backfill bank/cash account IDs.',
      };
    }
    try {
      const branches = await this.storeConfig.populateAllBranches();
      const accounts = await this.storeConfig.populateBankCashAccountIds();
      return {
        ...base,
        message: 'Store configuration populated for all branches.',
        details: { populateAllBranches: branches, bankCashAccounts: accounts },
      };
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        message: `Failed to populate store configuration: ${this.errMsg(err)}`,
      };
    }
  }

  private async runPaymentMappings(
    dryRun: boolean,
    approveBy?: string,
  ): Promise<RemediationStepResult> {
    const base: RemediationStepResult = {
      id: 'payment-mappings',
      step: 3,
      title: 'Resolve unmapped payment methods',
      status: 'ok',
      message: '',
    };
    try {
      const mappings = await this.paymentMapping.listMappings();
      const pending = mappings.filter(
        (m: { requiresApproval: boolean }) => m.requiresApproval,
      );

      if (pending.length === 0) {
        return {
          ...base,
          message: 'No payment methods are awaiting mapping/approval.',
          details: { pending: 0 },
        };
      }

      const pendingNames = pending.map(
        (m: { sourceSystem: string; sourcePaymentName: string }) =>
          `${m.sourceSystem}:${m.sourcePaymentName}`,
      );

      if (dryRun) {
        return {
          ...base,
          status: 'skipped',
          message: `Dry run: ${pending.length} payment mapping(s) awaiting approval${
            approveBy ? ' would be approved.' : '.'
          }`,
          details: { pending: pending.length, pendingNames },
        };
      }

      if (!approveBy) {
        return {
          ...base,
          status: 'blocked',
          message: `${pending.length} payment method(s) need mapping/approval. Provide approvePaymentMappingsBy to approve them, or map them on the Payment Mappings page.`,
          details: { pending: pending.length, pendingNames },
        };
      }

      let approved = 0;
      const errors: string[] = [];
      for (const m of pending) {
        try {
          await this.paymentMapping.approvePendingMapping(m.id, approveBy);
          approved++;
        } catch (err) {
          errors.push(`${m.sourcePaymentName}: ${this.errMsg(err)}`);
        }
      }

      if (errors.length > 0) {
        return {
          ...base,
          status: 'failed',
          message: `Approved ${approved}/${pending.length} mapping(s); ${errors.length} failed.`,
          details: { approved, pending: pending.length, errors },
        };
      }

      return {
        ...base,
        message: `Approved ${approved} pending payment mapping(s).`,
        details: { approved, pendingNames },
      };
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        message: `Failed to resolve payment mappings: ${this.errMsg(err)}`,
      };
    }
  }

  private async runRetryFailed(
    dryRun: boolean,
  ): Promise<RemediationStepResult> {
    const base: RemediationStepResult = {
      id: 'retry-failed',
      step: 4,
      title: 'Retry failed transactions',
      status: 'ok',
      message: '',
    };
    if (dryRun) {
      return {
        ...base,
        status: 'skipped',
        message:
          'Dry run: would re-queue all FAILED orders now that config and payment mappings are clean.',
      };
    }
    try {
      const res = await this.sync.retryAllFailedOrders();
      return {
        ...base,
        message: `Re-queued ${res.enqueued} failed order(s) (${res.updated} reset).`,
        details: { ...res },
      };
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        message: `Failed to retry failed orders: ${this.errMsg(err)}`,
      };
    }
  }

  private async runSkipped(
    dryRun: boolean,
    limit: number,
  ): Promise<RemediationStepResult> {
    const base: RemediationStepResult = {
      id: 'skipped-orders',
      step: 5,
      title: 'Auto-fix and retry skipped orders',
      status: 'ok',
      message: '',
    };
    if (dryRun) {
      return {
        ...base,
        status: 'skipped',
        message:
          'Dry run: would auto-fix skipped orders and retry those now eligible.',
      };
    }
    try {
      const autoFixed = await this.autoFix.autoFixSkippedOrders(
        undefined,
        undefined,
        limit,
      );
      const retried = await this.sync.retrySkippedOrders(undefined, limit);
      return {
        ...base,
        message: `Auto-fixed skipped orders and re-queued ${retried.enqueued} eligible order(s).`,
        details: { autoFixed, retried },
      };
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        message: `Failed to process skipped orders: ${this.errMsg(err)}`,
      };
    }
  }

  private buildSummary(
    steps: RemediationStepResult[],
    dryRun: boolean,
  ): string {
    const prefix = dryRun ? 'Dry run — no changes made. ' : '';
    const parts = steps.map((s) => `Step ${s.step} (${s.title}): ${s.status}`);
    return `${prefix}${parts.join('; ')}. Note: restarting the worker (runbook step 1) is an infrastructure action and must be performed separately.`;
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown error';
  }
}
