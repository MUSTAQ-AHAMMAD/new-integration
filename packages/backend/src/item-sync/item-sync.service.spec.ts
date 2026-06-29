import { ItemSyncService } from './item-sync.service';
import { OracleClient } from '../clients/oracle/oracle.client';
import { VendHqClient } from '../clients/vendhq/vendhq.client';
import { PrismaService } from '../prisma/prisma.service';
import { SyncControlService } from '../sync/sync-control.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeOracleItem(overrides: Record<string, unknown> = {}) {
  return {
    ItemNumber: 'ITEM-001',
    ItemDescription: 'Widget A',
    LongDescription: 'Widget A Long',
    MarketPrice: 29.99,
    InventoryItemStatusCode: 'Active',
    ...overrides,
  };
}

function makeVendProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vend-prod-001',
    name: 'Widget A',
    handle: 'widget-a',
    tax_id: 'tax-1',
    ...overrides,
  };
}

function makePrisma() {
  return {
    vendHqCredential: {
      findMany: jest.fn().mockResolvedValue([{ region: 'AE', active: true }]),
      // Returns null by default → fusionOrgCode falls back to region string
      findFirst: jest.fn().mockResolvedValue(null),
    },
    vendHqItemMeta: {
      // Default: null for both the watermark call and any item-tracking calls
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeOracle() {
  return {
    getInventoryItems: jest.fn().mockResolvedValue([makeOracleItem()]),
  };
}

function makeVendHq() {
  return {
    upsertProduct: jest.fn().mockResolvedValue(makeVendProduct()),
  };
}

function makeSyncControl() {
  return {
    isEnabled: jest.fn().mockResolvedValue(true),
    markRunning: jest.fn().mockResolvedValue(undefined),
    markStopped: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ItemSyncService', () => {
  let service: ItemSyncService;
  let prisma: ReturnType<typeof makePrisma>;
  let oracle: ReturnType<typeof makeOracle>;
  let vendHq: ReturnType<typeof makeVendHq>;
  let syncControl: ReturnType<typeof makeSyncControl>;

  beforeEach(() => {
    prisma = makePrisma();
    oracle = makeOracle();
    vendHq = makeVendHq();
    syncControl = makeSyncControl();
    service = new ItemSyncService(
      prisma as unknown as PrismaService,
      oracle as unknown as OracleClient,
      vendHq as unknown as VendHqClient,
      syncControl as unknown as SyncControlService,
    );
    jest.clearAllMocks();
  });

  // ── runItemSync ────────────────────────────────────────────────────────────

  describe('runItemSync', () => {
    it('skips sync when no active VendHQ credentials', async () => {
      prisma.vendHqCredential.findMany.mockResolvedValueOnce([]);
      await service.runItemSync();
      expect(oracle.getInventoryItems).not.toHaveBeenCalled();
    });

    it('runs sync for each active credential region', async () => {
      prisma.vendHqCredential.findMany.mockResolvedValueOnce([
        { region: 'AE' },
        { region: 'KW' },
      ]);
      // findFirst is called once per syncItemsForRegion: credential lookup + watermark
      prisma.vendHqCredential.findFirst.mockResolvedValue(null);
      oracle.getInventoryItems.mockResolvedValue([]); // both empty
      await service.runItemSync();
      expect(oracle.getInventoryItems).toHaveBeenCalledTimes(2);
    });

    it('catches per-region errors without rethrowing', async () => {
      prisma.vendHqCredential.findMany.mockResolvedValueOnce([
        { region: 'AE' },
      ]);
      oracle.getInventoryItems.mockRejectedValueOnce(new Error('Oracle down'));
      await expect(service.runItemSync()).resolves.toBeUndefined();
    });
  });

  // ── syncItemsForRegion ─────────────────────────────────────────────────────

  describe('syncItemsForRegion', () => {
    it('skips items with no ItemNumber', async () => {
      oracle.getInventoryItems.mockResolvedValueOnce([
        makeOracleItem({ ItemNumber: null }),
      ]);
      const result = await service.syncItemsForRegion('AE');
      expect(result.skipped).toBe(1);
      expect(vendHq.upsertProduct).not.toHaveBeenCalled();
    });

    it('creates VendHqItemMeta when item is new', async () => {
      // First findFirst call = watermark (null → use fallback date)
      prisma.vendHqItemMeta.findFirst.mockResolvedValueOnce(null); // watermark
      const result = await service.syncItemsForRegion('AE');
      expect(result.synced).toBe(1);
      expect(prisma.vendHqItemMeta.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            itemId_region: expect.objectContaining({
              itemId: expect.any(String),
              region: 'AE',
            }),
          },
          create: expect.objectContaining({ status: 'SUCCESS', sku: 'ITEM-001' }),
          update: expect.objectContaining({ status: 'SUCCESS', sku: 'ITEM-001' }),
        }),
      );
    });

    it('updates VendHqItemMeta when item exists', async () => {
      // First call = watermark (null → use fallback date)
      prisma.vendHqItemMeta.findFirst.mockResolvedValueOnce(null); // watermark
      const result = await service.syncItemsForRegion('AE');
      expect(result.synced).toBe(1);
      expect(prisma.vendHqItemMeta.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            itemId_region: expect.objectContaining({
              itemId: expect.any(String),
              region: 'AE',
            }),
          },
          create: expect.objectContaining({ status: 'SUCCESS' }),
          update: expect.objectContaining({ status: 'SUCCESS' }),
        }),
      );
    });

    it('increments failed and records ERROR on upsertProduct failure', async () => {
      vendHq.upsertProduct.mockRejectedValueOnce(new Error('VendHQ 422'));
      const result = await service.syncItemsForRegion('AE');
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('ITEM-001');
    });

    it('upserts product as inactive when InventoryItemStatusCode is not Active', async () => {
      oracle.getInventoryItems.mockResolvedValueOnce([
        makeOracleItem({ InventoryItemStatusCode: 'Inactive' }),
      ]);
      await service.syncItemsForRegion('AE');
      const [call] = vendHq.upsertProduct.mock.calls;
      expect(call[0].is_active).toBe(false);
    });

    it('paginates when oracle returns a full page', async () => {
      const fullPage = Array.from({ length: 500 }, (_, i) =>
        makeOracleItem({ ItemNumber: `ITEM-${i}` }),
      );
      oracle.getInventoryItems
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce([]); // second page empty — stop
      // avoid actual upsert calls by making VendHQ return quickly
      vendHq.upsertProduct.mockResolvedValue(makeVendProduct());
      prisma.vendHqItemMeta.findFirst.mockResolvedValue(null);

      await service.syncItemsForRegion('AE');

      expect(oracle.getInventoryItems).toHaveBeenCalledTimes(2);
    });

    it('uses the region as organizationCode when no credential fusionOrgCode found', async () => {
      prisma.vendHqCredential.findFirst.mockResolvedValueOnce(null);
      oracle.getInventoryItems.mockResolvedValueOnce([]);
      await service.syncItemsForRegion('KW');
      const [call] = oracle.getInventoryItems.mock.calls;
      expect(call[0].organizationCode).toBe('KW');
    });
  });

  // ── getItemSyncStatus ─────────────────────────────────────────────────────

  describe('getItemSyncStatus', () => {
    it('fetches all items without region filter when omitted', async () => {
      prisma.vendHqItemMeta = {
        findMany: jest.fn().mockResolvedValue([{}]),
      } as unknown as typeof prisma.vendHqItemMeta;
      const result = await service.getItemSyncStatus();
      expect(
        (prisma.vendHqItemMeta as unknown as { findMany: jest.Mock }).findMany,
      ).toHaveBeenCalledWith(expect.objectContaining({ where: undefined }));
      expect(result).toHaveLength(1);
    });

    it('filters by region when provided', async () => {
      prisma.vendHqItemMeta = {
        findMany: jest.fn().mockResolvedValue([]),
      } as unknown as typeof prisma.vendHqItemMeta;
      await service.getItemSyncStatus('AE');
      expect(
        (prisma.vendHqItemMeta as unknown as { findMany: jest.Mock }).findMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ where: { region: 'AE' } }),
      );
    });
  });
});
