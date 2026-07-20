import axios from 'axios';
import { DataSource, Repository } from 'typeorm';
import { SaleStatus } from '../database/enums';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { BackupVendHqLineItem } from '../database/entities/backup-vend-hq-line-item.entity';
import { BackupVendHqPayment } from '../database/entities/backup-vend-hq-payment.entity';
import { SaleSyncStatus } from '../database/entities/sale-sync-status.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
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

/**
 * A transaction manager that records the delete/insert calls the service
 * makes on the child tables inside dataSource.transaction().
 */
function makeManager() {
  return {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    insert: jest.fn().mockResolvedValue({}),
  };
}

function makeRepos() {
  const manager = makeManager();
  const credentials = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  };
  const integrationStatus = {
    findOne: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve(x)),
  };
  const sales = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => x),
    merge: jest.fn((a, b) => ({ ...a, ...b })),
    save: jest
      .fn()
      .mockResolvedValue({ id: 'sale-db-001', invoiceNumber: 'INV-001' }),
  };
  const lineItems = {};
  const payments = {};
  const saleSyncStatus = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve(x)),
  };
  const dataSource = {
    transaction: jest.fn((cb: (mgr: unknown) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  return {
    credentials,
    integrationStatus,
    sales,
    lineItems,
    payments,
    saleSyncStatus,
    dataSource,
    manager,
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
// Helper: build a service with mocked repositories and optionally mocked axios
// ---------------------------------------------------------------------------

function makeService(repos = makeRepos()) {
  const syncControl = {
    isEnabled: jest.fn().mockResolvedValue(true),
    markRunning: jest.fn().mockResolvedValue(undefined),
    markStopped: jest.fn().mockResolvedValue(undefined),
  };
  const service = new VendHqSalesBackupService(
    repos.credentials as unknown as Repository<VendHqCredential>,
    repos.integrationStatus as unknown as Repository<SalesIntegrationStatus>,
    repos.sales as unknown as Repository<BackupVendHqSale>,
    repos.lineItems as unknown as Repository<BackupVendHqLineItem>,
    repos.payments as unknown as Repository<BackupVendHqPayment>,
    repos.saleSyncStatus as unknown as Repository<SaleSyncStatus>,
    repos.dataSource as unknown as DataSource,
    syncControl as never,
  );
  return { service, repos, syncControl };
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
      expect(
        service.resolveVendHqBaseUrl('https://store.retail.lightspeed.app/'),
      ).toBe('https://store.retail.lightspeed.app');
    });
  });

  describe('isRegionEnabled', () => {
    it('returns true when no SalesIntegrationStatus record exists', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue(null);
      await expect(service.isRegionEnabled('SA')).resolves.toBe(true);
    });

    it('returns true when status is ENABLED', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'ENABLED',
      });
      await expect(service.isRegionEnabled('SA')).resolves.toBe(true);
    });

    it('returns false when status is DISABLED', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'DISABLED',
      });
      await expect(service.isRegionEnabled('SA')).resolves.toBe(false);
    });
  });

  describe('enableRegion', () => {
    it('upserts SalesIntegrationStatus with status ENABLED', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue(null);
      repos.integrationStatus.save.mockResolvedValue({
        id: 'sis-1',
        region: 'KW',
        integMode: 'BACKUP',
        status: 'ENABLED',
        updatedAt: new Date(),
      });

      const result = await service.enableRegion('KW');

      expect(repos.integrationStatus.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ENABLED' }),
      );
      expect(result.status).toBe('ENABLED');
    });
  });

  describe('disableRegion', () => {
    it('upserts SalesIntegrationStatus with status DISABLED', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue(null);
      repos.integrationStatus.save.mockResolvedValue({
        id: 'sis-1',
        region: 'SA',
        integMode: 'BACKUP',
        status: 'DISABLED',
        updatedAt: new Date(),
      });

      const result = await service.disableRegion('SA');

      expect(repos.integrationStatus.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'DISABLED' }),
      );
      expect(result.status).toBe('DISABLED');
    });
  });

  describe('getRegionStatus', () => {
    it('returns ENABLED when no status record exists', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue(null);
      repos.credentials.find.mockResolvedValue([]);

      const result = await service.getRegionStatus('OM');
      expect(result.integrationStatus).toBe('ENABLED');
      expect(result.region).toBe('OM');
    });

    it('returns credential list with lastSyncVersion and lastSyncAt', async () => {
      const { service, repos } = makeService();
      const now = new Date();
      repos.integrationStatus.findOne.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'ENABLED',
      });
      repos.credentials.find.mockResolvedValue([
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
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 3 })] },
      });

      // DB already has version 5 — incoming 3 should be skipped
      repos.sales.find.mockResolvedValue([
        { invoiceNumber: 'INV-001', version: 5 },
      ]);

      const result = await service.backupRegion(makeCred());
      expect(result.skipped).toBe(1);
      expect(result.saved).toBe(0);
      expect(repos.sales.save).not.toHaveBeenCalled();
    });

    it('upserts a new sale record when it does not exist yet', async () => {
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 10 })] },
      });

      // No existing record
      repos.sales.find.mockResolvedValue([]);
      repos.sales.findOne.mockResolvedValue(null);

      const result = await service.backupRegion(makeCred());
      expect(result.saved).toBe(1);
      expect(result.skipped).toBe(0);
      expect(repos.sales.save).toHaveBeenCalled();
    });

    it('upserts an existing sale when incoming version is higher', async () => {
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 10 })] },
      });

      // Page-level version check says process; per-sale findOne returns existing row
      repos.sales.find.mockResolvedValue([
        { invoiceNumber: 'INV-001', version: 3 },
      ]);
      repos.sales.findOne.mockResolvedValue({
        id: 'sale-db-001',
        invoiceNumber: 'INV-001',
        version: 3,
      });

      const result = await service.backupRegion(makeCred());
      expect(result.saved).toBe(1);
      expect(repos.sales.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { invoiceNumber: 'INV-001', region: 'SA' },
        }),
      );
      expect(repos.sales.save).toHaveBeenCalled();
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
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({
        data: { data: [makeSale({ version: 55 })] },
      });
      repos.sales.find.mockResolvedValue([]);
      repos.sales.findOne.mockResolvedValue(null);

      await service.backupRegion(makeCred({ lastSyncVersion: 10 }));

      expect(repos.credentials.update).toHaveBeenCalledWith(
        { id: 'cred-001' },
        expect.objectContaining({ lastSyncVersion: 55 }),
      );
    });

    it('does not push duplicate SaleSyncStatus for the same sale', async () => {
      const { service, repos } = makeService();
      const sale = makeSale({ version: 5 });
      mockAxios.mockResolvedValue({ data: { data: [sale] } });
      repos.sales.find.mockResolvedValue([]);
      repos.sales.findOne.mockResolvedValue(null);

      await service.backupRegion(makeCred());

      // saleSyncStatus.save should be called exactly once per sale
      expect(repos.saleSyncStatus.save).toHaveBeenCalledTimes(1);
      expect(repos.saleSyncStatus.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SaleStatus.PENDING }),
      );
    });

    it('persists line items via delete + insert', async () => {
      const { service, repos } = makeService();
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
      repos.sales.find.mockResolvedValue([]);
      repos.sales.findOne.mockResolvedValue(null);

      await service.backupRegion(makeCred());

      expect(repos.manager.delete).toHaveBeenCalled();
      expect(repos.manager.insert).toHaveBeenCalledWith(
        BackupVendHqLineItem,
        expect.arrayContaining([
          expect.objectContaining({ itemNumber: 'SKU-1', quantity: 2 }),
          expect.objectContaining({ itemNumber: 'SKU-2', quantity: 1 }),
        ]),
      );
    });

    it('persists payments via delete + insert', async () => {
      const { service, repos } = makeService();
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
      repos.sales.find.mockResolvedValue([]);
      repos.sales.findOne.mockResolvedValue(null);

      await service.backupRegion(makeCred());

      expect(repos.manager.insert).toHaveBeenCalledWith(
        BackupVendHqPayment,
        expect.arrayContaining([
          expect.objectContaining({ paymentType: 'Cash', amount: 110 }),
        ]),
      );
    });

    it('paginates: fetches second page when first page is full', async () => {
      const { service, repos } = makeService();
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
      repos.sales.find.mockResolvedValue([]);
      repos.sales.findOne.mockResolvedValue(null);
      repos.sales.save.mockImplementation((entity: { invoiceNumber: string }) =>
        Promise.resolve({
          id: `db-${entity.invoiceNumber}`,
          invoiceNumber: entity.invoiceNumber,
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
      const { service, repos } = makeService();
      repos.credentials.find.mockResolvedValue([makeCred({ region: 'SA' })]);
      repos.integrationStatus.findOne.mockResolvedValue({
        region: 'SA',
        integMode: 'BACKUP',
        status: 'DISABLED',
      });

      await service.runBackupJob();

      // axios.get should never be called because the region is disabled
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('processes a region when integration is ENABLED', async () => {
      const { service, repos } = makeService();
      repos.credentials.find.mockResolvedValue([makeCred({ region: 'KW' })]);
      repos.integrationStatus.findOne.mockResolvedValue({
        region: 'KW',
        integMode: 'BACKUP',
        status: 'ENABLED',
      });
      mockAxios.mockResolvedValue({ data: { data: [] } });

      await service.runBackupJob();

      expect(mockAxios).toHaveBeenCalled();
    });

    it('processes a region when no status record exists (default ENABLED)', async () => {
      const { service, repos } = makeService();
      repos.credentials.find.mockResolvedValue([makeCred({ region: 'AE' })]);
      repos.integrationStatus.findOne.mockResolvedValue(null);
      mockAxios.mockResolvedValue({ data: { data: [] } });

      await service.runBackupJob();

      expect(mockAxios).toHaveBeenCalled();
    });
  });
});
