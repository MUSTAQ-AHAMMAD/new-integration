import { ItemSyncService } from './item-sync.service';
import { OracleNativeService } from '../admin/oracle-native.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncControlService } from '../sync/sync-control.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeImportSummary(overrides: Record<string, unknown> = {}) {
  return {
    connectedAs: 'SYS@oracle-host:1521/ProdDB',
    tablesFound: ['VENDHQ_ITEM_META'],
    results: [
      {
        table: 'VendHqItemMeta',
        oracleTable: 'VENDHQ_ITEM_META',
        imported: 3,
        skipped: 1,
        errors: [],
      },
    ],
    totalImported: 3,
    totalErrors: 0,
    ...overrides,
  };
}

function makePrisma() {
  return {
    vendHqItemMeta: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function makeOracleNative() {
  return {
    importFromOracle: jest.fn().mockResolvedValue(makeImportSummary()),
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
  let oracleNative: ReturnType<typeof makeOracleNative>;
  let syncControl: ReturnType<typeof makeSyncControl>;

  beforeEach(() => {
    prisma = makePrisma();
    oracleNative = makeOracleNative();
    syncControl = makeSyncControl();
    service = new ItemSyncService(
      prisma as unknown as PrismaService,
      oracleNative as unknown as OracleNativeService,
      syncControl as unknown as SyncControlService,
    );
    jest.clearAllMocks();
  });

  describe('runItemSync', () => {
    it('skips the run when the service is disabled', async () => {
      syncControl.isEnabled.mockResolvedValueOnce(false);
      await service.runItemSync();
      expect(oracleNative.importFromOracle).not.toHaveBeenCalled();
      expect(syncControl.markRunning).not.toHaveBeenCalled();
    });

    it('imports VENDHQ_ITEM_META and marks success', async () => {
      await service.runItemSync();
      expect(syncControl.markRunning).toHaveBeenCalledWith('item-sync');
      expect(oracleNative.importFromOracle).toHaveBeenCalledWith([
        'VENDHQ_ITEM_META',
      ]);
      expect(syncControl.markStopped).toHaveBeenCalledWith(
        'item-sync',
        'success',
      );
    });

    it('marks error when the import reports row failures', async () => {
      oracleNative.importFromOracle.mockResolvedValueOnce(
        makeImportSummary({
          results: [
            {
              table: 'VendHqItemMeta',
              oracleTable: 'VENDHQ_ITEM_META',
              imported: 1,
              skipped: 0,
              errors: ['Row 2: bad data'],
            },
          ],
        }),
      );
      await service.runItemSync();
      expect(syncControl.markStopped).toHaveBeenCalledWith('item-sync', 'error');
    });

    it('marks error and does not throw when the import throws', async () => {
      oracleNative.importFromOracle.mockRejectedValueOnce(
        new Error('Oracle DB down'),
      );
      await expect(service.runItemSync()).resolves.toBeUndefined();
      expect(syncControl.markStopped).toHaveBeenCalledWith('item-sync', 'error');
    });
  });

  describe('syncItemsForRegion', () => {
    it('delegates to the DB import and echoes the region', async () => {
      const result = await service.syncItemsForRegion('AE');
      expect(oracleNative.importFromOracle).toHaveBeenCalledWith([
        'VENDHQ_ITEM_META',
      ]);
      expect(result).toEqual({
        region: 'AE',
        synced: 3,
        skipped: 1,
        failed: 0,
        errors: [],
      });
    });

    it('maps import errors onto failed/errors', async () => {
      oracleNative.importFromOracle.mockResolvedValueOnce(
        makeImportSummary({
          results: [
            {
              table: 'VendHqItemMeta',
              oracleTable: 'VENDHQ_ITEM_META',
              imported: 0,
              skipped: 0,
              errors: ['Row 1: boom', 'Row 2: boom'],
            },
          ],
        }),
      );
      const result = await service.syncItemsForRegion('KW');
      expect(result.failed).toBe(2);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('getItemSyncStatus', () => {
    it('queries VendHqItemMeta filtered by region', async () => {
      await service.getItemSyncStatus('SA');
      expect(prisma.vendHqItemMeta.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { region: 'SA' } }),
      );
    });
  });
});
