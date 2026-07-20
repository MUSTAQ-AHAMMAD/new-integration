import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { AlertSeverity, AlertType, ValidationStatus } from '../database/enums';
import { StoreConfigService } from './store-config.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeStoreConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    branchCode: 'CCNTRBHR',
    branchName: 'Central Branch',
    isActive: true,
    validationStatus: ValidationStatus.VALIDATED,
    validationErrors: null,
    billToSiteName: 'Acme Corp',
    bankAccountName: 'Main Bank',
    cashAccountName: 'Main Cash',
    paymentTermsName: '30 Net',
    oracleBusinessUnit: 'BU-AE',
    bankAccountId: 1,
    cashAccountId: 2,
    region: 'AE',
    version: 1,
    ...overrides,
  };
}

function makeStoresRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(makeStoreConfig()),
    find: jest.fn().mockResolvedValue([makeStoreConfig()]),
    create: jest.fn().mockImplementation((x) => x),
    save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
}

function makeRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((x) => x),
    save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
    createQueryBuilder: jest.fn(),
  };
}

function makeAlerts() {
  return { createAlert: jest.fn().mockResolvedValue({}) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StoreConfigService', () => {
  let service: StoreConfigService;
  let stores: ReturnType<typeof makeStoresRepo>;
  let salesMetadata: ReturnType<typeof makeRepo>;
  let businessUnitMaps: ReturnType<typeof makeRepo>;
  let registers: ReturnType<typeof makeRepo>;
  let odooOrders: ReturnType<typeof makeRepo>;
  let ibqOrders: ReturnType<typeof makeRepo>;
  let alerts: ReturnType<typeof makeAlerts>;

  beforeEach(() => {
    stores = makeStoresRepo();
    salesMetadata = makeRepo();
    businessUnitMaps = makeRepo();
    registers = makeRepo();
    odooOrders = makeRepo();
    ibqOrders = makeRepo();
    alerts = makeAlerts();
    service = new StoreConfigService(
      stores as unknown as Repository<StoreConfiguration>,
      salesMetadata as unknown as Repository<FusionSalesMetadata>,
      businessUnitMaps as unknown as Repository<FusionBusinessUnitMap>,
      registers as unknown as Repository<VendHqRegister>,
      odooOrders as unknown as Repository<BackupOdooOrder>,
      ibqOrders as unknown as Repository<BackupIbqOrder>,
      alerts as unknown as AlertsService,
    );
    jest.clearAllMocks();
  });

  // ── getRawConfig ─────────────────────────────────────────────────────────

  describe('getRawConfig', () => {
    it('returns the config when found', async () => {
      const config = await service.getRawConfig('CCNTRBHR');
      expect(config).toMatchObject({ branchCode: 'CCNTRBHR' });
    });

    it('throws NotFoundException when not found', async () => {
      stores.findOne.mockResolvedValueOnce(null);
      await expect(service.getRawConfig('MISSING')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── getValidatedConfig ───────────────────────────────────────────────────

  describe('getValidatedConfig', () => {
    it('returns the config when active and valid', async () => {
      const config = await service.getValidatedConfig('CCNTRBHR');
      expect(config.branchCode).toBe('CCNTRBHR');
    });

    it('throws when store is inactive', async () => {
      stores.findOne.mockResolvedValueOnce(
        makeStoreConfig({ isActive: false }),
      );
      await expect(service.getValidatedConfig('CCNTRBHR')).rejects.toThrow(
        'inactive',
      );
    });

    it('throws when validation status is INVALID', async () => {
      stores.findOne.mockResolvedValueOnce(
        makeStoreConfig({ validationStatus: ValidationStatus.INVALID }),
      );
      await expect(service.getValidatedConfig('CCNTRBHR')).rejects.toThrow(
        'invalid configuration',
      );
    });
  });

  // ── deleteStore ──────────────────────────────────────────────────────────

  describe('deleteStore', () => {
    it('deletes the store when found', async () => {
      await service.deleteStore('CCNTRBHR');
      expect(stores.delete).toHaveBeenCalledWith({ branchCode: 'CCNTRBHR' });
    });

    it('throws NotFoundException when store is not found', async () => {
      stores.findOne.mockResolvedValueOnce(null);
      await expect(service.deleteStore('MISSING')).rejects.toThrow(
        NotFoundException,
      );
      expect(stores.delete).not.toHaveBeenCalled();
    });
  });

  // ── validateConfig ───────────────────────────────────────────────────────

  describe('validateConfig', () => {
    it('returns isValid=true when all required fields are present', async () => {
      const result = await service.validateConfig('CCNTRBHR');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns isValid=false and lists missing fields', async () => {
      stores.findOne.mockResolvedValueOnce(
        makeStoreConfig({
          billToSiteName: null,
          bankAccountName: null,
          oracleBusinessUnit: null,
        }),
      );
      const result = await service.validateConfig('CCNTRBHR');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('billToSiteName is required');
      expect(result.errors).toContain('bankAccountName is required');
      expect(result.errors).toContain('oracleBusinessUnit is required');
    });

    it('returns isValid=false when store not found', async () => {
      stores.findOne.mockResolvedValueOnce(null);
      const result = await service.validateConfig('MISSING');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Store config not found');
    });

    it('fires an alert when validation fails', async () => {
      stores.findOne.mockResolvedValueOnce(
        makeStoreConfig({ billToSiteName: null }),
      );
      await service.validateConfig('CCNTRBHR');
      expect(alerts.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: AlertType.STORE_CONFIG_INVALID,
          severity: AlertSeverity.ERROR,
        }),
      );
    });

    it('does not fire an alert when validation passes', async () => {
      await service.validateConfig('CCNTRBHR');
      expect(alerts.createAlert).not.toHaveBeenCalled();
    });

    it('updates validationStatus to VALIDATED in DB on success', async () => {
      await service.validateConfig('CCNTRBHR');
      expect(stores.update).toHaveBeenCalledWith(
        { branchCode: 'CCNTRBHR' },
        expect.objectContaining({
          validationStatus: ValidationStatus.VALIDATED,
        }),
      );
    });

    it('updates validationStatus to INVALID in DB on failure', async () => {
      stores.findOne.mockResolvedValueOnce(
        makeStoreConfig({ billToSiteName: null }),
      );
      await service.validateConfig('CCNTRBHR');
      expect(stores.update).toHaveBeenCalledWith(
        { branchCode: 'CCNTRBHR' },
        expect.objectContaining({
          validationStatus: ValidationStatus.INVALID,
        }),
      );
    });
  });

  // ── listStores ───────────────────────────────────────────────────────────

  describe('listStores', () => {
    it('returns all stores when activeOnly is false', async () => {
      await service.listStores(false);
      expect(stores.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters to active only when activeOnly is true', async () => {
      await service.listStores(true);
      expect(stores.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  // ── upsertStore ──────────────────────────────────────────────────────────

  describe('upsertStore', () => {
    const input = {
      branchCode: 'CCNTRBHR',
      branchName: 'Central',
      odooBranchId: 3,
      oracleOperatingUnitId: 101,
      oracleBusinessUnit: 'BU-AE',
      billToSiteName: 'Acme Corp',
      bankAccountName: 'Main Bank',
      cashAccountName: 'Main Cash',
      paymentTermsName: '30 Net',
      createdBy: 'admin',
    };

    it('updates and bumps version when the store exists', async () => {
      stores.findOne.mockResolvedValueOnce(
        makeStoreConfig({ branchCode: 'CCNTRBHR', version: 4 }),
      );
      const result = (await service.upsertStore(input)) as { version: number };
      expect(stores.save).toHaveBeenCalled();
      expect(result.version).toBe(5);
    });

    it('creates a new store when none exists', async () => {
      stores.findOne.mockResolvedValueOnce(null);
      await service.upsertStore(input);
      expect(stores.create).toHaveBeenCalledWith(
        expect.objectContaining({ branchCode: 'CCNTRBHR' }),
      );
      expect(stores.save).toHaveBeenCalled();
    });
  });

  // ── populateAllBranches ──────────────────────────────────────────────────

  describe('populateAllBranches', () => {
    function makeQb(rows: unknown[]) {
      const qb: Record<string, jest.Mock> = {};
      for (const m of [
        'select',
        'addSelect',
        'where',
        'groupBy',
        'orderBy',
        'addOrderBy',
      ]) {
        qb[m] = jest.fn().mockReturnValue(qb);
      }
      qb.getRawMany = jest.fn().mockResolvedValue(rows);
      return qb;
    }

    beforeEach(() => {
      odooOrders.createQueryBuilder = jest.fn().mockReturnValue(
        makeQb([
          { branchId: 3, branchName: 'Branch 3', region: 'AE', orderCount: 100 },
          { branchId: 5, branchName: 'Branch 5', region: 'KW', orderCount: 50 },
        ]),
      );
      ibqOrders.createQueryBuilder = jest.fn().mockReturnValue(
        makeQb([
          {
            branchId: 3,
            branchName: 'Branch 3 IBQ',
            region: 'AE',
            orderCount: 25,
          },
          { branchId: 7, branchName: 'Branch 7', region: 'OM', orderCount: 30 },
        ]),
      );

      salesMetadata.find.mockResolvedValue([
        {
          id: '1',
          billToName: 'AE Store',
          customerType: 'NORMAL',
          billToAccount: BigInt(101),
          businessUnit: 'BU-AE',
          txnSource: 'Manual',
          txnType: 'SALE',
          region: 'AE',
          siteNumber: 'SITE-AE',
        },
        {
          id: '2',
          billToName: 'KW Store',
          customerType: 'NORMAL',
          billToAccount: BigInt(102),
          businessUnit: 'BU-KW',
          txnSource: 'Manual',
          txnType: 'SALE',
          region: 'KW',
          siteNumber: 'SITE-KW',
        },
        {
          id: '3',
          billToName: 'OM Store',
          customerType: 'NORMAL',
          billToAccount: BigInt(103),
          businessUnit: 'BU-OM',
          txnSource: 'Manual',
          txnType: 'SALE',
          region: 'OM',
          siteNumber: 'SITE-OM',
        },
      ]);

      // VendHqRegister account IDs by region (buildRegionAccountMap)
      registers.find.mockResolvedValue([
        {
          region: 'AE',
          bankAccountId: BigInt(2001),
          cashAccountId: BigInt(2002),
          createdAt: new Date(),
        },
      ]);

      // By default no branch has an existing configuration.
      stores.findOne.mockReset().mockResolvedValue(null);
      stores.save.mockReset().mockResolvedValue({});
      stores.create.mockImplementation((x) => x);
    });

    it('creates configurations for all unique branches', async () => {
      const result = await service.populateAllBranches();

      expect(result.totalBranches).toBe(3); // 3, 5, 7 (deduplicated)
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('skips branches that already have configurations', async () => {
      stores.findOne
        .mockResolvedValueOnce(makeStoreConfig({ branchCode: '3' }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.populateAllBranches();

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it('throws error when no FusionSalesMetadata exists', async () => {
      salesMetadata.find.mockResolvedValue([]);

      await expect(service.populateAllBranches()).rejects.toThrow(
        'No FusionSalesMetadata records found',
      );
    });

    it('matches branches to FusionSalesMetadata by region', async () => {
      await service.populateAllBranches();

      const createCalls = stores.create.mock.calls;

      // Branch 3 (AE) should use AE metadata
      expect(createCalls[0][0].billToSiteName).toBe('AE Store');
      // Branch 5 (KW) should use KW metadata
      expect(createCalls[1][0].billToSiteName).toBe('KW Store');
      // Branch 7 (OM) uses its own OM metadata — no silent fallback to AE.
      expect(createCalls[2][0].billToSiteName).toBe('OM Store');
    });

    it('deduplicates branches across Odoo and IBQ sources', async () => {
      const result = await service.populateAllBranches();
      expect(result.totalBranches).toBe(3); // 3, 5, 7
    });

    it('handles create errors gracefully', async () => {
      stores.save
        .mockRejectedValueOnce(new Error('Database error'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await service.populateAllBranches();

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Database error');
    });
  });
});
