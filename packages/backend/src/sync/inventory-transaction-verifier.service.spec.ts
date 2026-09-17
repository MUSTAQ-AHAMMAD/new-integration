import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { OracleClient } from '../clients/oracle/oracle.client';
import { CircuitBreakerService } from '../clients/circuit-breaker.service';
import { InventoryTransactionVerifierService } from './inventory-transaction-verifier.service';

/**
 * Every branch here decides whether stock is believed to have moved, so a wrong
 * verdict is worse than no verdict: SUCCESS makes the dedupe skip the line
 * forever. These cover each way Oracle can answer, including the ones where the
 * only correct action is to leave the row alone.
 */
describe('InventoryTransactionVerifierService', () => {
  let service: InventoryTransactionVerifierService;
  let invTxns: { find: jest.Mock; update: jest.Mock };
  let oracle: { getStagedInventoryTransaction: jest.Mock };

  const HOUR = 3_600_000;

  const makeRow = (over: Partial<FusionInvTxn> = {}): FusionInvTxn =>
    ({
      id: 'txn-1',
      status: 'PENDING',
      txnInterfaceId: 4242,
      itemNumber: 'ITEM-1',
      sourceLineRef: 'SO-1#1',
      subInventory: 'BR001',
      txnQty: -3,
      // Well past the grace window, inside the abandon window.
      requestDate: new Date(Date.now() - 2 * HOUR),
      ...over,
    }) as FusionInvTxn;

  beforeEach(async () => {
    invTxns = { find: jest.fn().mockResolvedValue([]), update: jest.fn() };
    oracle = { getStagedInventoryTransaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryTransactionVerifierService,
        { provide: getRepositoryToken(FusionInvTxn), useValue: invTxns },
        { provide: OracleClient, useValue: oracle },
        {
          provide: CircuitBreakerService,
          useValue: { isAnyOpen: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    service = module.get(InventoryTransactionVerifierService);
  });

  it('confirms a row Oracle has purged from the interface', async () => {
    invTxns.find.mockResolvedValue([makeRow()]);
    oracle.getStagedInventoryTransaction.mockResolvedValue({
      found: false,
      processStatus: null,
      errorExplanation: null,
      raw: {},
    });

    const summary = await service.verifyPending();

    expect(summary.confirmed).toBe(1);
    expect(invTxns.update).toHaveBeenCalledWith(
      'txn-1',
      expect.objectContaining({ status: 'SUCCESS', message: null }),
    );
    expect(invTxns.update.mock.calls[0][1].verifiedAt).toBeInstanceOf(Date);
  });

  it('fails a row Oracle rejected, keeping Oracle’s own reason', async () => {
    // The negative-balance case: invoice posted, stock never relieved.
    invTxns.find.mockResolvedValue([makeRow()]);
    oracle.getStagedInventoryTransaction.mockResolvedValue({
      found: true,
      processStatus: 3,
      errorExplanation:
        'INV_NEGATIVE_BALANCE: insufficient quantity on hand for item ITEM-1',
      raw: {},
    });

    const summary = await service.verifyPending();

    expect(summary.rejected).toBe(1);
    expect(summary.confirmed).toBe(0);
    const patch = invTxns.update.mock.calls[0][1];
    expect(patch.status).toBe('ERROR');
    expect(patch.message).toContain('INV_NEGATIVE_BALANCE');
  });

  it('leaves a row still queued in the interface alone', async () => {
    invTxns.find.mockResolvedValue([makeRow()]);
    oracle.getStagedInventoryTransaction.mockResolvedValue({
      found: true,
      processStatus: 1,
      errorExplanation: null,
      raw: {},
    });

    const summary = await service.verifyPending();

    expect(summary.stillPending).toBe(1);
    expect(invTxns.update).not.toHaveBeenCalled();
  });

  it('abandons a row Oracle never processed, naming the likely cause', async () => {
    invTxns.find.mockResolvedValue([
      makeRow({ requestDate: new Date(Date.now() - 48 * HOUR) }),
    ]);
    oracle.getStagedInventoryTransaction.mockResolvedValue({
      found: true,
      processStatus: 1,
      errorExplanation: null,
      raw: {},
    });

    const summary = await service.verifyPending();

    expect(summary.abandoned).toBe(1);
    const patch = invTxns.update.mock.calls[0][1];
    expect(patch.status).toBe('ERROR');
    expect(patch.message).toContain('Manage Inventory Transactions');
  });

  it('leaves the row PENDING when the lookup itself fails', async () => {
    // A failed call says nothing about the transaction — inventing SUCCESS here
    // would permanently hide a rejected issue.
    invTxns.find.mockResolvedValue([makeRow()]);
    oracle.getStagedInventoryTransaction.mockRejectedValue(
      new Error('Oracle timeout'),
    );

    const summary = await service.verifyPending();

    expect(summary.unverifiable).toBe(1);
    expect(summary.confirmed).toBe(0);
    expect(invTxns.update).not.toHaveBeenCalled();
  });

  it('only looks at PENDING rows that carry an interface id', async () => {
    await service.verifyPending();

    const where = invTxns.find.mock.calls[0][0].where;
    expect(where.status).toBe('PENDING');
    expect(where.txnInterfaceId).toBeDefined();
    expect(where.requestDate).toBeDefined();
  });

  it('settles a mixed batch independently', async () => {
    invTxns.find.mockResolvedValue([
      makeRow({ id: 'a', txnInterfaceId: 1 }),
      makeRow({ id: 'b', txnInterfaceId: 2 }),
      makeRow({ id: 'c', txnInterfaceId: 3 }),
    ]);
    oracle.getStagedInventoryTransaction
      .mockResolvedValueOnce({
        found: false,
        processStatus: null,
        errorExplanation: null,
        raw: {},
      })
      .mockResolvedValueOnce({
        found: true,
        processStatus: 3,
        errorExplanation: 'insufficient quantity',
        raw: {},
      })
      .mockResolvedValueOnce({
        found: true,
        processStatus: 1,
        errorExplanation: null,
        raw: {},
      });

    const summary = await service.verifyPending();

    expect(summary).toMatchObject({
      checked: 3,
      confirmed: 1,
      rejected: 1,
      stillPending: 1,
    });
  });

  it('skips the scheduled run while the Oracle breaker is open', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryTransactionVerifierService,
        { provide: getRepositoryToken(FusionInvTxn), useValue: invTxns },
        { provide: OracleClient, useValue: oracle },
        {
          provide: CircuitBreakerService,
          useValue: { isAnyOpen: jest.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();

    await module.get(InventoryTransactionVerifierService).runScheduled();

    expect(invTxns.find).not.toHaveBeenCalled();
  });
});
