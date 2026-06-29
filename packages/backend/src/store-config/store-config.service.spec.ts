import { NotFoundException } from '@nestjs/common';
import {
  AlertSeverity,
  AlertType,
  ValidationStatus,
  Prisma,
} from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreConfigService } from './store-config.service';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeStoreConfig(overrides: Record<string, unknown> = {}) {
  return {
    branchCode: 'CCNTRBHR',
    branchName: 'Central Branch',
    isActive: true,
    validationStatus: ValidationStatus.VALIDATED,
    validationErrors: Prisma.JsonNull,
    billToSiteName: 'Acme Corp',
    bankAccountName: 'Main Bank',
    cashAccountName: 'Main Cash',
    paymentTermsName: '30 Net',
    oracleBusinessUnit: 'BU-AE',
    ...overrides,
  };
}

function makePrisma() {
  return {
    storeConfiguration: {
      findUnique: jest.fn().mockResolvedValue(makeStoreConfig()),
      findMany: jest.fn().mockResolvedValue([makeStoreConfig()]),
      update: jest.fn().mockResolvedValue(makeStoreConfig()),
      delete: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue(makeStoreConfig()),
    },
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
  let prisma: ReturnType<typeof makePrisma>;
  let alerts: ReturnType<typeof makeAlerts>;

  beforeEach(() => {
    prisma = makePrisma();
    alerts = makeAlerts();
    service = new StoreConfigService(
      prisma as unknown as PrismaService,
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
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(null);
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
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(
        makeStoreConfig({ isActive: false }),
      );
      await expect(service.getValidatedConfig('CCNTRBHR')).rejects.toThrow(
        'inactive',
      );
    });

    it('throws when validation status is INVALID', async () => {
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(
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
      expect(prisma.storeConfiguration.delete).toHaveBeenCalledWith({
        where: { branchCode: 'CCNTRBHR' },
      });
    });

    it('throws NotFoundException when store is not found', async () => {
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(null);
      await expect(service.deleteStore('MISSING')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.storeConfiguration.delete).not.toHaveBeenCalled();
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
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(
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
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(null);
      const result = await service.validateConfig('MISSING');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Store config not found');
    });

    it('fires an alert when validation fails', async () => {
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(
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
      expect(prisma.storeConfiguration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            validationStatus: ValidationStatus.VALIDATED,
          }),
        }),
      );
    });

    it('updates validationStatus to INVALID in DB on failure', async () => {
      prisma.storeConfiguration.findUnique.mockResolvedValueOnce(
        makeStoreConfig({ billToSiteName: null }),
      );
      await service.validateConfig('CCNTRBHR');
      expect(prisma.storeConfiguration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            validationStatus: ValidationStatus.INVALID,
          }),
        }),
      );
    });
  });

  // ── listStores ───────────────────────────────────────────────────────────

  describe('listStores', () => {
    it('returns all stores when activeOnly is false', async () => {
      await service.listStores(false);
      expect(prisma.storeConfiguration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters to active only when activeOnly is true', async () => {
      await service.listStores(true);
      expect(prisma.storeConfiguration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  // ── upsertStore ──────────────────────────────────────────────────────────

  describe('upsertStore', () => {
    it('calls prisma upsert with the correct branchCode', async () => {
      await service.upsertStore({
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
      });
      expect(prisma.storeConfiguration.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { branchCode: 'CCNTRBHR' } }),
      );
    });
  });

  // ── populateAllBranches ──────────────────────────────────────────────────

  describe('populateAllBranches', () => {
    beforeEach(() => {
      // Mock $queryRaw for branch queries
      (prisma as unknown as Record<string, jest.Mock>).$queryRaw = jest
        .fn()
        .mockResolvedValueOnce([
          // BackupOdooOrder branches
          {
            branchId: 3,
            branchName: 'Branch 3',
            region: 'AE',
            orderCount: 100,
          },
          {
            branchId: 5,
            branchName: 'Branch 5',
            region: 'KW',
            orderCount: 50,
          },
        ])
        .mockResolvedValueOnce([
          // BackupIbqOrder branches
          {
            branchId: 3,
            branchName: 'Branch 3 IBQ',
            region: 'AE',
            orderCount: 25,
          },
          {
            branchId: 7,
            branchName: 'Branch 7',
            region: 'OM',
            orderCount: 30,
          },
        ]);

      // Mock fusionSalesMetadata
      (
        prisma as unknown as Record<string, { findMany: jest.Mock }>
      ).fusionSalesMetadata = {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '1',
            billToName: 'AE Store',
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
            billToAccount: BigInt(102),
            businessUnit: 'BU-KW',
            txnSource: 'Manual',
            txnType: 'SALE',
            region: 'KW',
            siteNumber: 'SITE-KW',
          },
        ]),
      };

      // Mock storeConfiguration.create
      (
        prisma as unknown as Record<string, { create: jest.Mock }>
      ).storeConfiguration.create = jest.fn().mockResolvedValue({});
    });

    it('creates configurations for all unique branches', async () => {
      const result = await service.populateAllBranches();

      expect(result.totalBranches).toBe(3); // 3, 5, 7 (deduplicated)
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('skips branches that already have configurations', async () => {
      // First branch already exists
      prisma.storeConfiguration.findUnique
        .mockResolvedValueOnce(makeStoreConfig({ branchCode: '3' }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.populateAllBranches();

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it('throws error when no FusionSalesMetadata exists', async () => {
      (
        prisma as unknown as Record<string, { findMany: jest.Mock }>
      ).fusionSalesMetadata.findMany = jest.fn().mockResolvedValue([]);

      await expect(service.populateAllBranches()).rejects.toThrow(
        'No FusionSalesMetadata records found',
      );
    });

    it('matches branches to FusionSalesMetadata by region', async () => {
      await service.populateAllBranches();

      const createCalls = (prisma.storeConfiguration.create as jest.Mock).mock
        .calls;

      // Branch 3 (AE) should use AE metadata
      expect(createCalls[0][0].data.billToSiteName).toBe('AE Store');

      // Branch 5 (KW) should use KW metadata
      expect(createCalls[1][0].data.billToSiteName).toBe('KW Store');

      // Branch 7 (OM) should fall back to AE (no OM metadata)
      expect(createCalls[2][0].data.billToSiteName).toBe('AE Store');
    });

    it('deduplicates branches across Odoo and IBQ sources', async () => {
      const result = await service.populateAllBranches();

      // Branch 3 appears in both Odoo and IBQ — should only create once
      expect(result.totalBranches).toBe(3); // 3, 5, 7
    });

    it('handles create errors gracefully', async () => {
      (prisma.storeConfiguration.create as jest.Mock)
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
