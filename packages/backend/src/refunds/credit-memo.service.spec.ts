import { SyncStatus } from '../database/enums';
import { CreditMemoService } from './credit-memo.service';

function makeRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt-1',
    originalOrderId: 'ORD-ORIG',
    originalOrderNumber: 'S001',
    originalInvoiceNumber: null,
    refundOrderId: 'REF-1',
    refundOrderNumber: 'S001-R',
    branchCode: 'DXB',
    refundAmount: 100,
    refundReason: 'Customer return',
    refundDate: new Date('2026-07-10T00:00:00Z'),
    creditMemoStatus: SyncStatus.PENDING,
    ...overrides,
  };
}

describe('CreditMemoService', () => {
  let service: CreditMemoService;
  let refundsRepo: any;
  let ordersRepo: any;
  let storesRepo: any;
  let backupsRepo: any;
  let odooTransformation: any;
  let oracleClient: any;
  let restClient: any;
  let idempotency: any;

  beforeEach(() => {
    refundsRepo = {
      findOne: jest.fn().mockResolvedValue(makeRefund()),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    };
    // Used both for branch resolution (select branchCode) and original-invoice
    // lookup (select oracleInvoiceNumber). Default returns the original invoice.
    ordersRepo = {
      findOne: jest.fn().mockResolvedValue({ oracleInvoiceNumber: 'INV-999' }),
    };
    storesRepo = {
      getOrCreateStoreConfig: jest.fn().mockResolvedValue({ region: 'AE' }),
    };
    backupsRepo = { findOne: jest.fn().mockResolvedValue({ id: 'backup-1' }) };
    odooTransformation = {
      buildCreditMemoPayload: jest.fn().mockResolvedValue({
        creditMemoLines: [],
        transactionType: 'CM',
        invoiceCurrencyCode: 'AED',
        businessUnit: 'BU-AE',
        billToCustomerName: 'DXB Store',
        billToAccountNumber: '87035',
        memoDate: new Date('2026-07-10T00:00:00Z'),
      }),
      resolveStoreCostCenterPublic: jest.fn().mockResolvedValue('0177'),
    };
    oracleClient = {
      createCreditMemo: jest.fn().mockResolvedValue({
        serviceStatus: 'SUCCESS',
        transactionNumber: 'CM-123',
        customerTrxId: '55',
      }),
      isCreditMemoApplicationEnabled: jest.fn().mockReturnValue(false),
      applyCreditMemo: jest.fn().mockResolvedValue({
        serviceStatus: 'SUCCESS',
        applicationId: 'app-1',
      }),
    };
    idempotency = {
      generateKey: jest.fn().mockReturnValue('key-1'),
      isDuplicate: jest.fn().mockResolvedValue(false),
      recordOperation: jest.fn().mockResolvedValue({}),
    };

    restClient = {
      createCreditMemoViaRest: jest.fn().mockResolvedValue({
        transactionNumber: 'CM-1',
        customerTransactionId: 'ctx-1',
      }),
      getInvoiceRevenueAccount: jest
        .fn()
        .mockResolvedValue('01-4011001-00-0177-01-01-00'),
      itemExists: jest.fn().mockResolvedValue(true),
    };
    const invoiceHeadersRepo = {
      findOne: jest.fn().mockResolvedValue({ customerTxnId: 'ctx-1' }),
    };
    service = new CreditMemoService(
      refundsRepo,
      ordersRepo,
      storesRepo,
      backupsRepo,
      odooTransformation,
      oracleClient,
      restClient as never,
      invoiceHeadersRepo as never,
      idempotency,
    );
  });

  it('pushes a pending refund as a credit memo applied to the original invoice', async () => {
    const result = await service.pushRefund('rt-1');

    expect(result.status).toBe('SYNCED');
    expect(result.creditMemoNumber).toBe('CM-1');
    expect(odooTransformation.buildCreditMemoPayload).toHaveBeenCalledWith(
      'backup-1',
      'DXB',
      'AE',
      expect.objectContaining({
        originalTransactionNumber: 'INV-999',
        refundAmount: 100,
      }),
    );
    expect(refundsRepo.update).toHaveBeenCalledWith(
      'rt-1',
      expect.objectContaining({
        oracleCreditMemoNumber: 'CM-1',
        creditMemoStatus: SyncStatus.SYNCED,
      }),
    );
  });

  it('applies the credit memo to the original invoice when application is enabled', async () => {
    oracleClient.isCreditMemoApplicationEnabled.mockReturnValue(true);

    const result = await service.pushRefund('rt-1');

    expect(result.status).toBe('SYNCED');
    expect(oracleClient.applyCreditMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        creditMemoNumber: 'CM-1',
        transactionNumber: 'INV-999',
        amountApplied: 100,
      }),
    );
    expect(refundsRepo.update).toHaveBeenCalledWith(
      'rt-1',
      expect.objectContaining({
        creditMemoStatus: SyncStatus.SYNCED,
        failureReason: null,
      }),
    );
  });

  it('keeps the memo SYNCED with a note when application fails', async () => {
    oracleClient.isCreditMemoApplicationEnabled.mockReturnValue(true);
    oracleClient.applyCreditMemo.mockRejectedValue(new Error('APPLY_REJECTED'));

    const result = await service.pushRefund('rt-1');

    expect(result.status).toBe('SYNCED');
    expect(refundsRepo.update).toHaveBeenCalledWith(
      'rt-1',
      expect.objectContaining({
        creditMemoStatus: SyncStatus.SYNCED,
        oracleCreditMemoNumber: 'CM-1',
        failureReason: expect.stringContaining('APPLY_REJECTED'),
      }),
    );
  });

  it('marks the refund FAILED when Oracle rejects the credit memo', async () => {
    restClient.createCreditMemoViaRest.mockRejectedValue(
      new Error('AR_INVALID'),
    );

    const result = await service.pushRefund('rt-1');

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('AR_INVALID');
    expect(refundsRepo.update).toHaveBeenCalledWith(
      'rt-1',
      expect.objectContaining({ creditMemoStatus: SyncStatus.FAILED }),
    );
  });

  it('skips a second push when the refund was already posted (idempotent)', async () => {
    idempotency.isDuplicate.mockResolvedValue(true);

    const result = await service.pushRefund('rt-1');

    expect(result.status).toBe('SYNCED');
    expect(restClient.createCreditMemoViaRest).not.toHaveBeenCalled();
    expect(refundsRepo.update).toHaveBeenCalledWith(
      'rt-1',
      expect.objectContaining({ creditMemoStatus: SyncStatus.SYNCED }),
    );
  });

  it('drops the item number for items Oracle does not know (description-only line)', async () => {
    odooTransformation.buildCreditMemoPayload.mockResolvedValue({
      creditMemoLines: [
        {
          lineNumber: 1,
          description: 'Known',
          quantity: 1,
          unitSellingPrice: 40,
          itemNumber: 'KNOWN-1',
        },
        {
          lineNumber: 2,
          description: 'Unknown',
          quantity: 1,
          unitSellingPrice: 60,
          itemNumber: 'GHOST-9',
        },
      ],
      transactionType: 'CM',
      invoiceCurrencyCode: 'AED',
      businessUnit: 'BU-AE',
      billToCustomerName: 'DXB Store',
      billToAccountNumber: '87035',
      memoDate: new Date('2026-07-10T00:00:00Z'),
    });
    restClient.itemExists.mockImplementation((item: string) =>
      Promise.resolve(item === 'KNOWN-1'),
    );

    const result = await service.pushRefund('rt-1');

    expect(result.status).toBe('SYNCED');
    const lines = restClient.createCreditMemoViaRest.mock.calls[0][0].lines;
    expect(lines[0].itemNumber).toBe('KNOWN-1');
    expect(lines[1].itemNumber).toBeUndefined();
  });

  it('fails clearly when no branch can be resolved for the refund', async () => {
    refundsRepo.findOne.mockResolvedValue(makeRefund({ branchCode: null }));
    ordersRepo.findOne.mockResolvedValue(null);

    const result = await service.pushRefund('rt-1');

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('branchCode');
    expect(oracleClient.createCreditMemo).not.toHaveBeenCalled();
  });
});
