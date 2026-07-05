import { RemediationService } from './remediation.service';

/**
 * Unit tests for the guided remediation orchestration. These focus on the two
 * behaviours that matter most: the steps run in the correct order, and step 4
 * (retry failed) is gated behind steps 2 & 3 so orders are never retried
 * against a broken configuration or unmapped payment method.
 */
describe('RemediationService', () => {
  let storeConfig: {
    populateAllBranches: jest.Mock;
    populateBankCashAccountIds: jest.Mock;
  };
  let paymentMapping: {
    listMappings: jest.Mock;
    approvePendingMapping: jest.Mock;
  };
  let sync: {
    retryAllFailedOrders: jest.Mock;
    retrySkippedOrders: jest.Mock;
  };
  let autoFix: { autoFixSkippedOrders: jest.Mock };
  let service: RemediationService;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    storeConfig = {
      populateAllBranches: jest.fn(() => {
        callOrder.push('populateAllBranches');
        return Promise.resolve({ updated: 3 });
      }),
      populateBankCashAccountIds: jest.fn(() => {
        callOrder.push('populateBankCashAccountIds');
        return Promise.resolve({ updated: 2 });
      }),
    };
    paymentMapping = {
      listMappings: jest.fn(() => {
        callOrder.push('listMappings');
        return Promise.resolve([]);
      }),
      approvePendingMapping: jest.fn(() => {
        callOrder.push('approvePendingMapping');
        return Promise.resolve({});
      }),
    };
    sync = {
      retryAllFailedOrders: jest.fn(() => {
        callOrder.push('retryAllFailedOrders');
        return Promise.resolve({ updated: 10, enqueued: 10 });
      }),
      retrySkippedOrders: jest.fn(() => {
        callOrder.push('retrySkippedOrders');
        return Promise.resolve({ updated: 5, enqueued: 5 });
      }),
    };
    autoFix = {
      autoFixSkippedOrders: jest.fn(() => {
        callOrder.push('autoFixSkippedOrders');
        return Promise.resolve({ total: 5, fixed: 3 });
      }),
    };

    service = new RemediationService(
      storeConfig as never,
      paymentMapping as never,
      sync as never,
      autoFix as never,
    );
  });

  it('runs all steps in runbook order when config and mappings are clean', async () => {
    const result = await service.remediate();

    expect(callOrder).toEqual([
      'populateAllBranches',
      'populateBankCashAccountIds',
      'listMappings',
      'retryAllFailedOrders',
      'autoFixSkippedOrders',
      'retrySkippedOrders',
    ]);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([2, 3, 4, 5]);
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
  });

  it('blocks step 4 (retry failed) when store config fails', async () => {
    storeConfig.populateAllBranches.mockRejectedValueOnce(new Error('db down'));

    const result = await service.remediate();

    const configStep = result.steps.find((s) => s.step === 2)!;
    const retryStep = result.steps.find((s) => s.step === 4)!;
    expect(configStep.status).toBe('failed');
    expect(retryStep.status).toBe('blocked');
    expect(retryStep.details?.blockedBy).toContain('store configuration');
    expect(sync.retryAllFailedOrders).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('blocks step 4 when payment mappings are pending and no approver given', async () => {
    paymentMapping.listMappings.mockResolvedValueOnce([
      {
        id: 'm1',
        sourceSystem: 'odoo',
        sourcePaymentName: 'Loyalty',
        requiresApproval: true,
      },
    ]);

    const result = await service.remediate();

    const paymentStep = result.steps.find((s) => s.step === 3)!;
    const retryStep = result.steps.find((s) => s.step === 4)!;
    expect(paymentStep.status).toBe('blocked');
    expect(retryStep.status).toBe('blocked');
    expect(retryStep.details?.blockedBy).toContain('payment mappings');
    expect(sync.retryAllFailedOrders).not.toHaveBeenCalled();
  });

  it('approves pending mappings when an approver is provided, then retries', async () => {
    paymentMapping.listMappings.mockResolvedValueOnce([
      {
        id: 'm1',
        sourceSystem: 'odoo',
        sourcePaymentName: 'Loyalty',
        requiresApproval: true,
      },
    ]);

    const result = await service.remediate({
      approvePaymentMappingsBy: 'ops@example.com',
    });

    expect(paymentMapping.approvePendingMapping).toHaveBeenCalledWith(
      'm1',
      'ops@example.com',
    );
    const paymentStep = result.steps.find((s) => s.step === 3)!;
    expect(paymentStep.status).toBe('ok');
    expect(sync.retryAllFailedOrders).toHaveBeenCalledTimes(1);
    // Approval happens before the retry.
    expect(callOrder.indexOf('approvePendingMapping')).toBeLessThan(
      callOrder.indexOf('retryAllFailedOrders'),
    );
  });

  it('does not mutate anything on a dry run', async () => {
    const result = await service.remediate({ dryRun: true });

    expect(storeConfig.populateAllBranches).not.toHaveBeenCalled();
    expect(storeConfig.populateBankCashAccountIds).not.toHaveBeenCalled();
    expect(paymentMapping.approvePendingMapping).not.toHaveBeenCalled();
    expect(sync.retryAllFailedOrders).not.toHaveBeenCalled();
    expect(sync.retrySkippedOrders).not.toHaveBeenCalled();
    expect(autoFix.autoFixSkippedOrders).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    // No step performed a mutating action.
    expect(result.steps.some((s) => s.status === 'ok' && s.step !== 3)).toBe(
      false,
    );
  });

  it('skips step 5 when includeSkipped is false', async () => {
    const result = await service.remediate({ includeSkipped: false });

    const skippedStep = result.steps.find((s) => s.step === 5)!;
    expect(skippedStep.status).toBe('skipped');
    expect(autoFix.autoFixSkippedOrders).not.toHaveBeenCalled();
    expect(sync.retrySkippedOrders).not.toHaveBeenCalled();
    // Steps 2-4 still ran.
    expect(sync.retryAllFailedOrders).toHaveBeenCalledTimes(1);
  });
});
