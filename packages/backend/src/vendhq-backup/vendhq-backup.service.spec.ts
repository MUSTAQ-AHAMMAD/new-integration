import axios from 'axios';
import { SaleStatus } from '@prisma/client';
import { VendHqSalesBackupService } from './vendhq-backup.service';

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeSale(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'sale-001',
    invoice_number: 'INV-001',
    sale_date: '2024-01-15T10:00:00Z',
    outlet_id: 'outlet-1',
    outlet_name: 'Main Outlet',
    register_name: 'Register 1',
    status: 'CLOSED',
    total_price: 100,
    total_tax: 10,
    total_price_incl_tax: 110,
    version: 5,
    line_items: [],
    payments: [],
    ...overrides,
  };
}

function makePrisma() {
  return {
    vendHqCredential: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    salesIntegrationStatus: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    backupVendHqSale: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'sale-db-001', invoiceNumber: 'INV-001' }),
    },
    backupVendHqLineItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    backupVendHqPayment: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    saleSyncStatus: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest
      .fn()
      .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
}

function makeCred(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-001',
    domainName: 'mystore',
    personalToken: 'tok-secret',
    active: true,
    region: 'SA',
    timezoneOffset: 3,
    currency: 'SAR',
    lastSyncVersion: 0,
    lastSyncAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a service with mocked Prisma and optionally mocked axios
// ---------------------------------------------------------------------------

function makeService(prisma = makePrisma()) {
  const syncControl = {
    isEnabled: jest.fn().mockResolvedValue(true),
    markRunning: jest.fn().mockResolvedValue(undefined),
    markStopped: jest.fn().mockResolvedValue(undefined),
  };
  const service = new VendHqSalesBackupService(
    prisma as never,
    syncControl as never,
  );
  return { service, prisma, syncControl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VendHqSalesBackupService', () => {
  describe('resolveVendHqBaseUrl', () => {
    it('appends .vendhq.com to a bare store prefix', () => {
      const { service } = makeService();
      expect(service.resolveVendHqBaseUrl('mystore')).toBe(
        'https://mystore.vendhq.com',
      );
    });

    it('uses a full hostname verbatim (no .vendhq.com suffix)', () => {
      const { service } = makeService();
      expect(service.resolveVendHqBaseUrl('www.ibqpos.com')).toBe(
        'https://www.ibqpos.com',
      );
      expect(service.resolveVendHqBaseUrl('ibraqperfumes.odoo.com')).toBe(
        'https://ibraqperfumes.odoo.com',
      );
    });

    it('preserves an explicit scheme and trims trailing slashes', () => {
      const { service } = makeService();
      expect(service.resolveVendHqBaseUrl('https://store.retail.lightspeed.app/')).toBe(
        'https://store.retail.lightspeed.app',
      );
    });
  });

  describe('isRegionEnabled', () => {
    it('returns true when no SalesIntegrationStatus record exists', async () => {
      const { service, prisma } = makeService();
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue(null);
      await expect(service.isRegionEnabled('SA')).resolves.toBe(true);
    });

    it('returns true when status is ENABLED', async () => {
      const { service, prisma } = makeService();
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'ENABLED',
      });
      await expect(service.isRegionEnabled('SA')).resolves.toBe(true);
    });

    it('returns false when status is DISABLED', async () => {
      const { service, prisma } = makeService();
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'DISABLED',
      });
      await expect(service.isRegionEnabled('SA')).resolves.toBe(false);
    });
  });

  describe('enableRegion', () => {
    it('upserts SalesIntegrationStatus with status ENABLED', async () => {
      const { service, prisma } = makeService();
      prisma.salesIntegrationStatus.upsert.mockResolvedValue({
        id: 'sis-1',
        region: 'KW',
        integMode: 'BACKUP',
        status: 'ENABLED',
        updatedAt: new Date(),
      });

      const result = await service.enableRegion('KW');

      expect(prisma.salesIntegrationStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { region_integMode: { region: 'KW', integMode: 'BACKUP' } },
          update: { status: 'ENABLED' },
        }),
      );
      expect(result.status).toBe('ENABLED');
    });
  });

  describe('disableRegion', () => {
    it('upserts SalesIntegrationStatus with status DISABLED', async () => {
      const { service, prisma } = makeService();
      prisma.salesIntegrationStatus.upsert.mockResolvedValue({
        id: 'sis-1',
        region: 'SA',
        integMode: 'BACKUP',
        status: 'DISABLED',
        updatedAt: new Date(),
      });

      const result = await service.disableRegion('SA');

      expect(prisma.salesIntegrationStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { region_integMode: { region: 'SA', integMode: 'BACKUP' } },
          update: { status: 'DISABLED' },
        }),
      );
      expect(result.status).toBe('DISABLED');
    });
  });

  describe('getRegionStatus', () => {
    it('returns ENABLED when no status record exists', async () => {
      const { service, prisma } = makeService();
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue(null);
      prisma.vendHqCredential.findMany.mockResolvedValue([]);

      const result = await service.getRegionStatus('OM');
      expect(result.integrationStatus).toBe('ENABLED');
      expect(result.region).toBe('OM');
    });

    it('returns credential list with lastSyncVersion and lastSyncAt', async () => {
      const { service, prisma } = makeService();
      const now = new Date();
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'ENABLED',
      });
      prisma.vendHqCredential.findMany.mockResolvedValue([
        {
          id: 'cred-001',
          domainName: 'mystore',
          active: true,
          lastSyncVersion: 42,
          lastSyncAt: now,
        },
      ]);

      const result = await service.getRegionStatus('SA');
      expect(result.credentials).toHaveLength(1);
      expect(result.credentials[0].lastSyncVersion).toBe(42);
      expect(result.credentials[0].lastSyncAt).toBe(now);
    });
  });

  describe('backupRegion', () => {
    const mockAxios = jest.spyOn(axios, 'get');

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('skips a sale when incoming version is not newer than stored version', async () => {
      const { service, prisma } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 3 })] },
      });

      // DB already has version 5 — incoming 3 should be skipped
      prisma.backupVendHqSale.findMany.mockResolvedValue([
        { invoiceNumber: 'INV-001', version: 5 },
      ]);

      const result = await service.backupRegion(makeCred());
      expect(result.skipped).toBe(1);
      expect(result.saved).toBe(0);
      expect(prisma.backupVendHqSale.upsert).not.toHaveBeenCalled();
    });

    it('upserts a new sale record when it does not exist yet', async () => {
      const { service, prisma } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 10 })] },
      });

      // No existing record
      prisma.backupVendHqSale.findMany.mockResolvedValue([]);

      const result = await service.backupRegion(makeCred());
      expect(result.saved).toBe(1);
      expect(result.skipped).toBe(0);
      expect(prisma.backupVendHqSale.upsert).toHaveBeenCalled();
    });

    it('upserts an existing sale when incoming version is higher', async () => {
      const { service, prisma } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 10 })] },
      });

      // DB has older version
      prisma.backupVendHqSale.findMany.mockResolvedValue([
        { invoiceNumber: 'INV-001', version: 3 },
      ]);

      const result = await service.backupRegion(makeCred());
      expect(result.saved).toBe(1);
      expect(prisma.backupVendHqSale.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            invoiceNumber_region: { invoiceNumber: 'INV-001', region: 'SA' },
          },
        }),
      );
    });

    it('sends the after=lastSyncVersion parameter to the VendHQ API', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { data: [] } });

      await service.backupRegion(makeCred({ lastSyncVersion: 99 }));

      expect(mockAxios).toHaveBeenCalledWith(
        expect.stringContaining('/api/2.0/sales'),
        expect.objectContaining({
          params: expect.objectContaining({ after: 99 }),
        }),
      );
    });

    it('does NOT send the after param when lastSyncVersion is 0', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { data: [] } });

      await service.backupRegion(makeCred({ lastSyncVersion: 0 }));

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params).not.toHaveProperty('after');
    });

    it('advances lastSyncVersion after a successful run', async () => {
      const { service, prisma } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 55 })] },
      });
      prisma.backupVendHqSale.findMany.mockResolvedValue([]);

      await service.backupRegion(makeCred({ lastSyncVersion: 10 }));

      expect(prisma.vendHqCredential.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastSyncVersion: 55 }),
        }),
      );
    });

    it('does not push duplicate SaleSyncStatus for the same sale', async () => {
      const { service, prisma } = makeService();
      const sale = makeSale({ version: 5 });
      mockAxios.mockResolvedValue({ data: { data: [sale] } });
      prisma.backupVendHqSale.findMany.mockResolvedValue([]);

      await service.backupRegion(makeCred());

      // saleSyncStatus.upsert should be called exactly once per sale
      expect(prisma.saleSyncStatus.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.saleSyncStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: SaleStatus.PENDING }),
          update: expect.objectContaining({ status: SaleStatus.PENDING }),
        }),
      );
    });

    it('persists line items via deleteMany + createMany', async () => {
      const { service, prisma } = makeService();
      mockAxios.mockResolvedValue({
        data: {
          data: [
            makeSale({
              version: 5,
              line_items: [
                { sku: 'SKU-1', name: 'Item A', quantity: 2, total_price: 50 },
                { sku: 'SKU-2', name: 'Item B', quantity: 1, total_price: 25 },
              ],
            }),
          ],
        },
      });
      prisma.backupVendHqSale.findMany.mockResolvedValue([]);

      await service.backupRegion(makeCred());

      expect(prisma.backupVendHqLineItem.deleteMany).toHaveBeenCalled();
      expect(prisma.backupVendHqLineItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ itemNumber: 'SKU-1', quantity: 2 }),
            expect.objectContaining({ itemNumber: 'SKU-2', quantity: 1 }),
          ]),
        }),
      );
    });

    it('persists payments via deleteMany + createMany', async () => {
      const { service, prisma } = makeService();
      mockAxios.mockResolvedValue({
        data: {
          data: [
            makeSale({
              version: 5,
              payments: [{ name: 'Cash', amount: 110 }],
            }),
          ],
        },
      });
      prisma.backupVendHqSale.findMany.mockResolvedValue([]);

      await service.backupRegion(makeCred());

      expect(prisma.backupVendHqPayment.deleteMany).toHaveBeenCalled();
      expect(prisma.backupVendHqPayment.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ paymentType: 'Cash', amount: 110 }),
          ]),
        }),
      );
    });

    it('paginates: fetches second page when first page is full', async () => {
      const { service, prisma } = makeService();
      // First call returns 200 sales (full page), second returns 0 (end)
      const fullPage = Array.from({ length: 200 }, (_, i) =>
        makeSale({
          id: `sale-${i}`,
          invoice_number: `INV-${i}`,
          version: i + 1,
        }),
      );
      mockAxios
        .mockResolvedValueOnce({ data: { data: fullPage } })
        .mockResolvedValueOnce({ data: { data: [] } });
      prisma.backupVendHqSale.findMany.mockResolvedValue([]);
      prisma.backupVendHqSale.upsert.mockImplementation(({ create }) =>
        Promise.resolve({
          id: `db-${create.invoiceNumber}`,
          invoiceNumber: create.invoiceNumber,
        }),
      );

      await service.backupRegion(makeCred({ lastSyncVersion: 0 }));

      expect(mockAxios).toHaveBeenCalledTimes(2);
    });
  });

  describe('runBackupJob', () => {
    const mockAxios = jest.spyOn(axios, 'get');

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('skips a region when integration is DISABLED', async () => {
      const { service, prisma } = makeService();
      prisma.vendHqCredential.findMany.mockResolvedValue([
        makeCred({ region: 'SA' }),
      ]);
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'DISABLED',
      });

      await service.runBackupJob();

      // axios.get should never be called because the region is disabled
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('processes a region when integration is ENABLED', async () => {
      const { service, prisma } = makeService();
      prisma.vendHqCredential.findMany.mockResolvedValue([
        makeCred({ region: 'KW' }),
      ]);
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue({
        region: 'KW',
        integMode: 'BACKUP',
        status: 'ENABLED',
      });
      mockAxios.mockResolvedValue({ data: { data: [] } });

      await service.runBackupJob();

      expect(mockAxios).toHaveBeenCalled();
    });

    it('processes a region when no status record exists (default ENABLED)', async () => {
      const { service, prisma } = makeService();
      prisma.vendHqCredential.findMany.mockResolvedValue([
        makeCred({ region: 'AE' }),
      ]);
      prisma.salesIntegrationStatus.findUnique.mockResolvedValue(null);
      mockAxios.mockResolvedValue({ data: { data: [] } });

      await service.runBackupJob();

      expect(mockAxios).toHaveBeenCalled();
    });
  });
});
