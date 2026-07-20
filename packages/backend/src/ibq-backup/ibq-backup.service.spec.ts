import axios from 'axios';
import { Repository } from 'typeorm';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupIbqOrderLine } from '../database/entities/backup-ibq-order-line.entity';
import { BackupIbqOrderPayment } from '../database/entities/backup-ibq-order-payment.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
import { IbqBackupService } from './ibq-backup.service';

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeOrder(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 101,
    name: 'Order 00001-001-0001',
    pos_reference: 'Order 00001-001-0001',
    date_order: '2024-01-15 10:00:00',
    amount_total: 105.0,
    amount_tax: 5.0,
    amount_paid: 105.0,
    state: 'done',
    company_id: [1, 'Test Company'],
    config_id: [5, 'Main POS'],
    partner_id: null,
    lines: [],
    statement_ids: [],
    ...overrides,
  };
}

function makeRepos() {
  const credentials = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve(x)),
  };
  const integrationStatus = {
    findOne: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve(x)),
  };
  const orders = {
    findOne: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({ id: 'order-db-001' }),
    update: jest.fn().mockResolvedValue({}),
  };
  const orderLines = {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const orderPayments = {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  return { credentials, integrationStatus, orders, orderLines, orderPayments };
}

function makeCred(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-001',
    baseUrl: 'https://ibq.example.com',
    apiKey: 'secret-key',
    companyId: 1,
    active: true,
    region: 'SA',
    lastSyncAt: null,
    ...overrides,
  };
}

function makeOrderSyncService() {
  return {
    ingestOrder: jest.fn().mockResolvedValue(undefined),
  };
}

function makeSyncControl() {
  return {
    isEnabled: jest.fn().mockResolvedValue(true),
    markRunning: jest.fn().mockResolvedValue(undefined),
    markStopped: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(
  repos = makeRepos(),
  orderSyncService = makeOrderSyncService(),
  syncControl = makeSyncControl(),
) {
  const service = new IbqBackupService(
    repos.credentials as unknown as Repository<IbqCredential>,
    repos.integrationStatus as unknown as Repository<SalesIntegrationStatus>,
    repos.orders as unknown as Repository<BackupIbqOrder>,
    repos.orderLines as unknown as Repository<BackupIbqOrderLine>,
    repos.orderPayments as unknown as Repository<BackupIbqOrderPayment>,
    orderSyncService as never,
    syncControl as never,
  );
  return { service, repos, orderSyncService, syncControl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IbqBackupService', () => {
  describe('backupRegion', () => {
    const mockAxios = jest.spyOn(axios, 'get');

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('calls the IBQ /api/pos/order endpoint with x-api-key header', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred());

      expect(mockAxios).toHaveBeenCalledWith(
        'https://ibq.example.com/api/pos/order',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-api-key': 'secret-key' }),
        }),
      );
    });

    it('sends company_id param when set on credential', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred({ companyId: 3 }));

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params).toHaveProperty('company_id', 3);
    });

    it('does NOT send company_id param when companyId is null', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred({ companyId: null }));

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params).not.toHaveProperty('company_id');
    });

    it('sends start_date param when lastSyncAt is set', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(
        makeCred({ lastSyncAt: new Date('2024-01-15T10:00:00Z') }),
      );

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params).toHaveProperty('start_date');
      expect(typeof callParams.params['start_date']).toBe('string');
      // Must be YYYY-MM-DD HH:MM:SS (not the old MM/DD/YYYY format)
      expect(callParams.params['start_date']).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      );
    });

    it('appends 00:00:00 to a date-only startDate override from the UI', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred(), { startDate: '2026-02-01' });

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params['start_date']).toBe('2026-02-01 00:00:00');
    });

    it('appends 23:59:59 to a date-only endDate override from the UI', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred(), { endDate: '2026-02-01' });

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params['end_date']).toBe('2026-02-01 23:59:59');
    });

    it('does not modify a startDate override that already has a time component', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred(), {
        startDate: '2026-02-01 21:00:00',
      });

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params['start_date']).toBe('2026-02-01 21:00:00');
    });

    it('does NOT send start_date param on first run (lastSyncAt null)', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred({ lastSyncAt: null }));

      const callParams = mockAxios.mock.calls[0][1] as {
        params: Record<string, unknown>;
      };
      expect(callParams.params).not.toHaveProperty('start_date');
    });

    it('persists a new order as BackupIbqOrder', async () => {
      const { service, repos } = makeService();
      const order = makeOrder();
      mockAxios.mockResolvedValue({ data: { result: [order] } });
      repos.orders.findOne.mockResolvedValue(null);

      const result = await service.backupRegion(makeCred());

      expect(repos.orders.save).toHaveBeenCalledTimes(1);
      expect(result.saved).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('updates an existing order rather than creating a duplicate', async () => {
      const { service, repos } = makeService();
      const order = makeOrder();
      mockAxios.mockResolvedValue({ data: { result: [order] } });
      repos.orders.findOne.mockResolvedValue({ id: 'existing-id' });

      const result = await service.backupRegion(makeCred());

      expect(repos.orders.update).toHaveBeenCalledTimes(1);
      expect(repos.orders.save).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('persists order lines when present', async () => {
      const { service, repos } = makeService();
      const order = makeOrder({
        lines: [
          {
            id: 1,
            product_id: [789, 'Test Product'],
            qty: 2,
            price_unit: 50,
            price_subtotal: 100,
            price_subtotal_incl: 105,
            discount: 0,
          },
          {
            id: 2,
            product_id: [790, 'Another Product'],
            qty: 1,
            price_unit: 5,
            price_subtotal: 5,
            price_subtotal_incl: 5,
            discount: 0,
          },
        ],
      });
      mockAxios.mockResolvedValue({ data: { result: [order] } });
      repos.orders.findOne.mockResolvedValue(null);

      await service.backupRegion(makeCred());

      expect(repos.orderLines.delete).toHaveBeenCalled();
      expect(repos.orderLines.insert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ lineId: 1, qty: 2 }),
          expect.objectContaining({ lineId: 2, qty: 1 }),
        ]),
      );
    });

    it('persists payments from statement_ids when present', async () => {
      const { service, repos } = makeService();
      const order = makeOrder({
        statement_ids: [{ id: 10, name: 'Cash', amount: 105.0 }],
      });
      mockAxios.mockResolvedValue({ data: { result: [order] } });
      repos.orders.findOne.mockResolvedValue(null);

      await service.backupRegion(makeCred());

      expect(repos.orderPayments.delete).toHaveBeenCalled();
      expect(repos.orderPayments.insert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ paymentName: 'Cash', amount: 105.0 }),
        ]),
      );
    });

    it('falls back to payment_ids when statement_ids is absent', async () => {
      const { service, repos } = makeService();
      const order = makeOrder({
        statement_ids: undefined,
        payment_ids: [{ id: 20, name: 'Card', amount: 50.0 }],
      });
      mockAxios.mockResolvedValue({ data: { result: [order] } });
      repos.orders.findOne.mockResolvedValue(null);

      await service.backupRegion(makeCred());

      expect(repos.orderPayments.delete).toHaveBeenCalled();
      expect(repos.orderPayments.insert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ paymentName: 'Card', amount: 50.0 }),
        ]),
      );
    });

    it('advances lastSyncAt watermark after a successful run', async () => {
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(makeCred());

      expect(repos.credentials.update).toHaveBeenCalledWith(
        { id: 'cred-001' },
        expect.objectContaining({ lastSyncAt: expect.any(Date) }),
      );
    });

    it('handles result wrapped in {data: [...]} envelope', async () => {
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({ data: { data: [makeOrder()] } });
      repos.orders.findOne.mockResolvedValue(null);

      const result = await service.backupRegion(makeCred());

      expect(result.saved).toBe(1);
    });

    it('handles unwrapped array response', async () => {
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({ data: [makeOrder()] });
      repos.orders.findOne.mockResolvedValue(null);

      const result = await service.backupRegion(makeCred());

      expect(result.saved).toBe(1);
    });

    it('strips trailing slash from baseUrl before calling the API', async () => {
      const { service } = makeService();
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.backupRegion(
        makeCred({ baseUrl: 'https://ibq.example.com/' }),
      );

      expect(mockAxios).toHaveBeenCalledWith(
        'https://ibq.example.com/api/pos/order',
        expect.anything(),
      );
    });

    it('increments skipped count when individual order persistence fails', async () => {
      const { service, repos } = makeService();
      mockAxios.mockResolvedValue({
        data: { result: [makeOrder(), makeOrder({ id: 102 })] },
      });
      repos.orders.findOne
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await service.backupRegion(makeCred());

      expect(result.skipped).toBeGreaterThanOrEqual(1);
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
        integMode: 'IBQ_BACKUP',
        status: 'DISABLED',
      });

      await service.runBackupJob();

      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('processes a region when integration is ENABLED', async () => {
      const { service, repos } = makeService();
      repos.credentials.find.mockResolvedValue([makeCred({ region: 'SA' })]);
      repos.integrationStatus.findOne.mockResolvedValue({
        region: 'SA',
        integMode: 'IBQ_BACKUP',
        status: 'ENABLED',
      });
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.runBackupJob();

      expect(mockAxios).toHaveBeenCalled();
    });

    it('processes a region when no status record exists (default ENABLED)', async () => {
      const { service, repos } = makeService();
      repos.credentials.find.mockResolvedValue([makeCred({ region: 'AE' })]);
      repos.integrationStatus.findOne.mockResolvedValue(null);
      mockAxios.mockResolvedValue({ data: { result: [] } });

      await service.runBackupJob();

      expect(mockAxios).toHaveBeenCalled();
    });

    it('logs a warning and returns early when there are no active credentials', async () => {
      const { service, repos } = makeService();
      repos.credentials.find.mockResolvedValue([]);
      const logSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => {});

      await service.runBackupJob();

      expect(mockAxios).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('enableRegion / disableRegion', () => {
    it('upserts SalesIntegrationStatus to ENABLED', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue(null);
      repos.integrationStatus.save.mockResolvedValue({
        region: 'SA',
        integMode: 'IBQ_BACKUP',
        status: 'ENABLED',
      });

      const result = await service.enableRegion('SA');

      expect(repos.integrationStatus.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ENABLED' }),
      );
      expect(result.status).toBe('ENABLED');
    });

    it('upserts SalesIntegrationStatus to DISABLED', async () => {
      const { service, repos } = makeService();
      repos.integrationStatus.findOne.mockResolvedValue(null);
      repos.integrationStatus.save.mockResolvedValue({
        region: 'SA',
        integMode: 'IBQ_BACKUP',
        status: 'DISABLED',
      });

      const result = await service.disableRegion('SA');

      expect(repos.integrationStatus.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'DISABLED' }),
      );
      expect(result.status).toBe('DISABLED');
    });

    it('updates an existing status record in place', async () => {
      const { service, repos } = makeService();
      const existing = {
        region: 'SA',
        integMode: 'IBQ_BACKUP',
        status: 'ENABLED',
      };
      repos.integrationStatus.findOne.mockResolvedValue(existing);
      repos.integrationStatus.save.mockImplementation((x) =>
        Promise.resolve(x),
      );

      const result = await service.disableRegion('SA');

      expect(repos.integrationStatus.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'DISABLED' }),
      );
      expect(result.status).toBe('DISABLED');
    });
  });
});
