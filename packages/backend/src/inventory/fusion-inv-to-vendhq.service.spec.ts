import { Repository } from 'typeorm';
import { FusionInvToVendHqService } from './fusion-inv-to-vendhq.service';
import { OracleClient } from '../clients/oracle/oracle.client';
import { VendHqClient } from '../clients/vendhq/vendhq.client';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { VendHqOutlet } from '../database/entities/vend-hq-outlet.entity';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeOnHand(overrides: Record<string, unknown> = {}) {
  return {
    ItemNumber: 'SKU-001',
    OnHandQuantity: 50,
    SubinventoryCode: 'STORES',
    UOMCode: 'EA',
    ...overrides,
  };
}

function makeRepos() {
  const credentials = {
    find: jest.fn().mockResolvedValue([{ region: 'AE', active: true }]),
  };
  const outlets = {
    findOne: jest
      .fn()
      .mockResolvedValue({ outletId: 'outlet-001', outletName: 'MAIN' }),
  };
  const itemMeta = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 'meta-001', itemId: 'vend-item-001' }),
  };
  const invTxns = {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
  };
  return { credentials, outlets, itemMeta, invTxns };
}

function makeOracle() {
  return {
    getInventoryOnHand: jest.fn().mockResolvedValue([makeOnHand()]),
  };
}

function makeVendHq() {
  return {
    updateInventory: jest.fn().mockResolvedValue({}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FusionInvToVendHqService', () => {
  let service: FusionInvToVendHqService;
  let repos: ReturnType<typeof makeRepos>;
  let oracle: ReturnType<typeof makeOracle>;
  let vendHq: ReturnType<typeof makeVendHq>;

  beforeEach(() => {
    repos = makeRepos();
    oracle = makeOracle();
    vendHq = makeVendHq();
    const syncControl = {
      isEnabled: jest.fn().mockResolvedValue(true),
      markRunning: jest.fn().mockResolvedValue(undefined),
      markStopped: jest.fn().mockResolvedValue(undefined),
    };
    service = new FusionInvToVendHqService(
      repos.credentials as unknown as Repository<VendHqCredential>,
      repos.outlets as unknown as Repository<VendHqOutlet>,
      repos.itemMeta as unknown as Repository<VendHqItemMeta>,
      repos.invTxns as unknown as Repository<FusionInvTxn>,
      oracle as unknown as OracleClient,
      vendHq as unknown as VendHqClient,
      syncControl as never,
    );
    jest.clearAllMocks();
  });

  // ── runInventorySync ───────────────────────────────────────────────────────

  describe('runInventorySync', () => {
    it('skips sync when no active VendHQ credentials are found', async () => {
      repos.credentials.find.mockResolvedValueOnce([]);
      await service.runInventorySync();
      expect(oracle.getInventoryOnHand).not.toHaveBeenCalled();
    });

    it('runs sync for each active credential region', async () => {
      repos.credentials.find.mockResolvedValueOnce([
        { region: 'AE' },
        { region: 'KW' },
      ]);
      oracle.getInventoryOnHand
        .mockResolvedValueOnce([]) // AE — empty, stops loop
        .mockResolvedValueOnce([]); // KW — empty
      await service.runInventorySync();
      expect(oracle.getInventoryOnHand).toHaveBeenCalledTimes(2);
    });

    it('catches per-region errors and continues to next region', async () => {
      repos.credentials.find.mockResolvedValueOnce([
        { region: 'AE' },
        { region: 'KW' },
      ]);
      // AE throws, KW succeeds
      repos.outlets.findOne
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(null); // KW — no outlet → skipped

      await expect(service.runInventorySync()).resolves.toBeUndefined();
    });
  });

  // ── syncInventoryForRegion ─────────────────────────────────────────────────

  describe('syncInventoryForRegion', () => {
    it('returns skipped=1 when no outlet found for region', async () => {
      repos.outlets.findOne.mockResolvedValueOnce(null);
      const result = await service.syncInventoryForRegion('XX');
      expect(result.skipped).toBe(1);
      expect(result.synced).toBe(0);
      expect(oracle.getInventoryOnHand).not.toHaveBeenCalled();
    });

    it('skips items with no ItemNumber', async () => {
      oracle.getInventoryOnHand.mockResolvedValueOnce([
        makeOnHand({ ItemNumber: null }),
      ]);
      const result = await service.syncInventoryForRegion('AE');
      expect(result.skipped).toBe(1);
      expect(vendHq.updateInventory).not.toHaveBeenCalled();
    });

    it('skips items not found in VendHqItemMeta', async () => {
      oracle.getInventoryOnHand.mockResolvedValueOnce([makeOnHand()]);
      repos.itemMeta.findOne.mockResolvedValueOnce(null);
      const result = await service.syncInventoryForRegion('AE');
      expect(result.skipped).toBe(1);
      expect(vendHq.updateInventory).not.toHaveBeenCalled();
    });

    it('successfully syncs an item and records a SUCCESS txn', async () => {
      oracle.getInventoryOnHand.mockResolvedValueOnce([makeOnHand()]);
      repos.itemMeta.findOne.mockResolvedValueOnce({
        itemId: 'vend-001',
      });
      vendHq.updateInventory.mockResolvedValueOnce({});

      const result = await service.syncInventoryForRegion('AE');

      expect(result.synced).toBe(1);
      expect(result.failed).toBe(0);
      expect(vendHq.updateInventory).toHaveBeenCalledWith({
        productId: 'vend-001',
        outletId: 'outlet-001',
        current: 50,
      });
      expect(repos.invTxns.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'SUCCESS' }),
      );
      expect(repos.invTxns.save).toHaveBeenCalled();
    });

    it('increments failed and records an ERROR txn when updateInventory throws', async () => {
      oracle.getInventoryOnHand.mockResolvedValueOnce([makeOnHand()]);
      repos.itemMeta.findOne.mockResolvedValueOnce({
        itemId: 'vend-001',
      });
      vendHq.updateInventory.mockRejectedValueOnce(new Error('VendHQ 500'));

      const result = await service.syncInventoryForRegion('AE');

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('SKU-001');
      expect(repos.invTxns.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ERROR' }),
      );
    });

    it('paginates when oracle returns a full page', async () => {
      const fullPage = Array.from({ length: 500 }, (_, i) =>
        makeOnHand({ ItemNumber: `SKU-${i}` }),
      );
      const emptyPage: typeof fullPage = [];
      oracle.getInventoryOnHand
        .mockResolvedValueOnce(fullPage) // page 1 — triggers another fetch
        .mockResolvedValueOnce(emptyPage); // page 2 — stops pagination
      // Simulate items not in VendHqItemMeta so we don't need updateInventory mocks for 500 items
      repos.itemMeta.findOne.mockResolvedValue(null);

      await service.syncInventoryForRegion('AE');

      expect(oracle.getInventoryOnHand).toHaveBeenCalledTimes(2);
    });

    it('uses region as organizationCode fallback when no outlet name', async () => {
      repos.outlets.findOne.mockResolvedValueOnce({
        outletId: 'outlet-001',
        outletName: null,
      });
      oracle.getInventoryOnHand.mockResolvedValueOnce([]);
      await service.syncInventoryForRegion('AE');
      const [call] = oracle.getInventoryOnHand.mock.calls;
      expect(call[0].organizationCode).toBe('AE');
    });
  });

  // ── getInventoryTransactions ───────────────────────────────────────────────

  describe('getInventoryTransactions', () => {
    it('returns transactions without region filter when region is omitted', async () => {
      repos.invTxns.find.mockResolvedValueOnce([{}]);
      const result = await service.getInventoryTransactions();
      expect(repos.invTxns.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
      expect(result).toHaveLength(1);
    });

    it('filters by region when provided', async () => {
      repos.invTxns.find.mockResolvedValueOnce([]);
      await service.getInventoryTransactions('AE');
      expect(repos.invTxns.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { region: 'AE' } }),
      );
    });
  });
});
