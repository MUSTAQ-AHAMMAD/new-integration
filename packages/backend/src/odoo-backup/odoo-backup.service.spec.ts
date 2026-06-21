/**
 * OdooBackupService tests
 *
 * Primary goal: diagnose why POST /sync/fetch-odoo returns fetched:0 even
 * when the Odoo API shows records in Postman.
 *
 * The three most common causes are tested here:
 *  1. Response-envelope mismatch — extractOrderList() silently returns []
 *     for envelopes it does not recognise.
 *  2. lastSyncAt watermark filters out all records (start_date sent to Odoo
 *     is newer than any available order).
 *  3. Credential baseUrl / apiPath misconfiguration.
 */

import axios, { AxiosError } from 'axios';
import { OdooBackupService } from './odoo-backup.service';

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    name: 'POS/2024/00001',
    date_order: '2024-03-10 09:00:00',
    amount_total: 210.0,
    amount_tax: 10.0,
    branch_id: [3, 'Dubai Branch'],
    state: 'done',
    lines: [],
    statement_ids: [],
    ...overrides,
  };
}

function makePrisma() {
  return {
    odooBackupState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    odooCredential: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    backupOdooOrder: {
      upsert: jest.fn().mockResolvedValue({ id: 'order-db-001' }),
    },
    backupOdooOrderLine: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    backupOdooOrderPayment: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeOdooClient() {
  return {
    getOrders: jest.fn().mockResolvedValue([]),
  };
}

function makeOrderSyncService() {
  return {
    ingestOrder: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(
  prisma = makePrisma(),
  odooClient = makeOdooClient(),
  orderSyncService = makeOrderSyncService(),
) {
  const service = new OdooBackupService(
    prisma as never,
    odooClient as never,
    orderSyncService as never,
  );
  return { service, prisma, odooClient, orderSyncService };
}

function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-001',
    baseUrl: 'https://odoo.example.com',
    apiKey: 'test-api-key',
    region: 'AE',
    apiPath: null,
    lastSyncAt: null,
    active: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// backupOrders (legacy global env-var path used by fetch-odoo without credentialId)
// ---------------------------------------------------------------------------

describe('OdooBackupService.backupOrders (global env-var client)', () => {
  it('returns fetched:0 when OdooClient returns empty array — no orders in window', async () => {
    const { service, odooClient } = makeService();
    odooClient.getOrders.mockResolvedValue([]);

    const result = await service.backupOrders({ limit: 100 });

    expect(result.orders).toHaveLength(0);
    expect(result.saved).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('returns correct counts when OdooClient returns orders', async () => {
    const { service, odooClient } = makeService();
    odooClient.getOrders.mockResolvedValue([makeOrder(), makeOrder({ id: 1002 })]);

    const result = await service.backupOrders({ limit: 100 });

    expect(result.orders).toHaveLength(2);
    expect(result.saved).toBe(2);
  });

  it('passes startDate to OdooClient so the watermark filter is applied', async () => {
    const { service, odooClient } = makeService();
    odooClient.getOrders.mockResolvedValue([]);

    await service.backupOrders({ startDate: '2024-01-01T00:00:00Z', limit: 100 });

    expect(odooClient.getOrders).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2024-01-01T00:00:00Z' }),
    );
  });

  it('does NOT pass startDate when not provided — first-run fetches everything', async () => {
    const { service, odooClient } = makeService();
    odooClient.getOrders.mockResolvedValue([]);

    await service.backupOrders({ limit: 100 });

    const call = odooClient.getOrders.mock.calls[0][0] as Record<string, unknown>;
    expect(call.startDate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// backupOrdersForCredential — response-envelope parsing (root cause of fetched:0)
// ---------------------------------------------------------------------------

describe('OdooBackupService.backupOrdersForCredential — response envelope parsing', () => {
  const mockAxiosGet = jest.spyOn(axios, 'get');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('✅ plain array response → orders extracted correctly', async () => {
    const { service, prisma } = makeService();
    mockAxiosGet.mockResolvedValue({ data: [makeOrder()] });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(result.orders).toHaveLength(1);
    expect(result.saved).toBe(1);
  });

  it('✅ {records:[...]} envelope (Odoo 16+ REST) → orders extracted correctly', async () => {
    const { service } = makeService();
    mockAxiosGet.mockResolvedValue({ data: { records: [makeOrder(), makeOrder({ id: 1002 })] } });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(result.orders).toHaveLength(2);
  });

  it('✅ {result:[...]} envelope → orders extracted correctly', async () => {
    const { service } = makeService();
    mockAxiosGet.mockResolvedValue({ data: { result: [makeOrder()] } });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(result.orders).toHaveLength(1);
  });

  it('✅ {data:[...]} envelope → orders extracted correctly', async () => {
    const { service } = makeService();
    mockAxiosGet.mockResolvedValue({ data: { data: [makeOrder()] } });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(result.orders).toHaveLength(1);
  });

  // ── KNOWN GAPS — envelopes that return fetched:0 silently ────────────────

  it('handles {result:{records:[...]}} nested envelope (Odoo 17/18 REST API)', async () => {
    // Odoo 17/18 often wraps results as { result: { records: [...], length: N } }.
    const { service } = makeService();
    mockAxiosGet.mockResolvedValue({
      data: { result: { records: [makeOrder(), makeOrder({ id: 1002 })], length: 2 } },
    });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(result.orders).toHaveLength(2);
  });

  it('handles {result:{data:[...]}} nested envelope', async () => {
    const { service } = makeService();
    mockAxiosGet.mockResolvedValue({
      data: { result: { data: [makeOrder()], count: 1 } },
    });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(result.orders).toHaveLength(1);
  });

  it('handles {result:{orders:[...]}} nested envelope', async () => {
    const { service } = makeService();
    mockAxiosGet.mockResolvedValue({
      data: { result: { orders: [makeOrder()] } },
    });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(result.orders).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// backupOrdersForCredential — watermark / start_date behaviour
// ---------------------------------------------------------------------------

describe('OdooBackupService.backupOrdersForCredential — watermark filter', () => {
  const mockAxiosGet = jest.spyOn(axios, 'get');

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosGet.mockResolvedValue({ data: [] });
  });

  it('sends start_date param when lastSyncAt is set on the credential', async () => {
    const { service } = makeService();
    const lastSyncAt = new Date('2024-06-01T00:00:00Z');

    await service.backupOrdersForCredential(
      makeCredential({ lastSyncAt }),
      { startDate: lastSyncAt.toISOString(), limit: 100 },
    );

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('/api/pos/order'),
      expect.objectContaining({
        params: expect.objectContaining({ start_date: lastSyncAt.toISOString() }),
      }),
    );
  });

  it('does NOT send start_date when no startDate param is passed (first run)', async () => {
    const { service } = makeService();

    await service.backupOrdersForCredential(makeCredential({ lastSyncAt: null }), { limit: 100 });

    const call = mockAxiosGet.mock.calls[0][1] as { params: Record<string, unknown> };
    expect(call.params).not.toHaveProperty('start_date');
  });

  it('watermark set to future time causes fetched:0 — orders filtered out server-side', async () => {
    // This simulates the most common real-world cause of fetched:0:
    // the cron already ran and advanced lastSyncAt beyond all available orders.
    // The service faithfully sends the watermark; Odoo returns nothing.
    const { service } = makeService();
    const futureDate = new Date('2099-01-01T00:00:00Z');
    mockAxiosGet.mockResolvedValue({ data: [] }); // Odoo returns 0 orders

    const result = await service.backupOrdersForCredential(
      makeCredential({ lastSyncAt: futureDate }),
      { startDate: futureDate.toISOString(), limit: 100 },
    );

    expect(result.orders).toHaveLength(0);
    // Fix: call the endpoint WITHOUT a startDate (or with an earlier date)
  });
});

// ---------------------------------------------------------------------------
// backupOrdersForCredential — credential / URL configuration
// ---------------------------------------------------------------------------

describe('OdooBackupService.backupOrdersForCredential — URL and auth', () => {
  const mockAxiosGet = jest.spyOn(axios, 'get');

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosGet.mockResolvedValue({ data: [] });
  });

  it('uses x-api-key header from the credential', async () => {
    const { service } = makeService();

    await service.backupOrdersForCredential(
      makeCredential({ apiKey: 'my-secret-key' }),
      { limit: 100 },
    );

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'my-secret-key' }),
      }),
    );
  });

  it('calls the correct baseUrl + default /api/pos/order path', async () => {
    const { service } = makeService();

    await service.backupOrdersForCredential(
      makeCredential({ baseUrl: 'https://myodoo.example.com', apiPath: null }),
      { limit: 100 },
    );

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://myodoo.example.com/api/pos/order',
      expect.anything(),
    );
  });

  it('uses the configured apiPath instead of the default when set', async () => {
    const { service } = makeService();

    await service.backupOrdersForCredential(
      makeCredential({ baseUrl: 'https://myodoo.example.com', apiPath: '/api/sale.order' }),
      { limit: 100 },
    );

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://myodoo.example.com/api/sale.order',
      expect.anything(),
    );
  });

  it('prepends https:// when baseUrl has no scheme', async () => {
    const { service } = makeService();

    await service.backupOrdersForCredential(
      makeCredential({ baseUrl: 'myodoo.example.com' }),
      { limit: 100 },
    );

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('https://myodoo.example.com'),
      expect.anything(),
    );
  });

  it('strips trailing slash from baseUrl', async () => {
    const { service } = makeService();

    await service.backupOrdersForCredential(
      makeCredential({ baseUrl: 'https://myodoo.example.com/' }),
      { limit: 100 },
    );

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://myodoo.example.com/api/pos/order',
      expect.anything(),
    );
  });

  it('auto-falls back to /api/sale.order when /api/pos/order returns 404', async () => {
    const { service, prisma } = makeService();
    const notFound = new AxiosError('Not Found');
    (notFound as AxiosError).response = { status: 404 } as never;

    mockAxiosGet
      .mockRejectedValueOnce(notFound)   // first call: 404 on /api/pos/order
      .mockResolvedValueOnce({ data: [makeOrder()] }); // second call: /api/sale.order succeeds

    const result = await service.backupOrdersForCredential(
      makeCredential({ apiPath: null }),
      { limit: 100 },
    );

    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    expect(mockAxiosGet.mock.calls[1][0]).toContain('/api/sale.order');
    expect(result.orders).toHaveLength(1);
    // The discovered path should be persisted so future runs skip discovery
    expect(prisma.odooCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ apiPath: '/api/sale.order' }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// backupOrdersForCredential — branch name extraction
// ---------------------------------------------------------------------------

describe('OdooBackupService.backupOrdersForCredential — branch name extraction', () => {
  const mockAxiosGet = jest.spyOn(axios, 'get');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('extracts branchName from the part before "/" in orderName when branch_id has no name', async () => {
    const { service, prisma } = makeService();
    // branch_id is a plain integer — resolveName returns null.
    // branchName should fall back to the order name prefix.
    const order = makeOrder({ branch_id: 246, name: 'CCNTRBHR/2139' });
    mockAxiosGet.mockResolvedValue({ data: [order] });

    await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(prisma.backupOdooOrder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ branchName: 'CCNTRBHR' }),
      }),
    );
  });

  it('uses the Many2one branch name when the API returns [id, name]', async () => {
    const { service, prisma } = makeService();
    const order = makeOrder({ branch_id: [246, 'Bahrain Branch'], name: 'CCNTRBHR/2139' });
    mockAxiosGet.mockResolvedValue({ data: [order] });

    await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(prisma.backupOdooOrder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ branchName: 'Bahrain Branch' }),
      }),
    );
  });

  it('leaves branchName null when branch_id is absent and order name has no "/"', async () => {
    const { service, prisma } = makeService();
    const order = makeOrder({ branch_id: null, name: 'ORDER-001' });
    mockAxiosGet.mockResolvedValue({ data: [order] });

    await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(prisma.backupOdooOrder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ branchName: null }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// backupOrdersForCredential — pagination
// ---------------------------------------------------------------------------

describe('OdooBackupService.backupOrdersForCredential — pagination', () => {
  const mockAxiosGet = jest.spyOn(axios, 'get');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches a second page when the first page is exactly CREDENTIAL_PAGE_SIZE (100) records', async () => {
    const { service } = makeService();
    // Build 100 distinct orders for page 1 and 2 orders for page 2.
    const page1 = Array.from({ length: 100 }, (_, i) => makeOrder({ id: 1000 + i }));
    const page2 = [makeOrder({ id: 2000 }), makeOrder({ id: 2001 })];

    mockAxiosGet
      .mockResolvedValueOnce({ data: page1 }) // page 1 (offset=0)
      .mockResolvedValueOnce({ data: page2 }); // page 2 (offset=100)

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    expect(result.orders).toHaveLength(102);
    expect(result.saved).toBe(102);
  });

  it('sends correct offset param for each page', async () => {
    const { service } = makeService();
    const page1 = Array.from({ length: 100 }, (_, i) => makeOrder({ id: 1000 + i }));
    mockAxiosGet
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: [] }); // empty page 2 → stop

    await service.backupOrdersForCredential(
      makeCredential({ baseUrl: 'https://odoo.example.com', apiPath: '/api/pos/order' }),
      { limit: 100 },
    );

    const [, firstCallConfig] = mockAxiosGet.mock.calls[0] as [string, { params: Record<string, unknown> }];
    const [, secondCallConfig] = mockAxiosGet.mock.calls[1] as [string, { params: Record<string, unknown> }];
    expect(firstCallConfig.params).toMatchObject({ limit: 100, offset: 0 });
    expect(secondCallConfig.params).toMatchObject({ limit: 100, offset: 100 });
  });

  it('stops after one page when page returns fewer than PAGE_SIZE records', async () => {
    const { service } = makeService();
    mockAxiosGet.mockResolvedValueOnce({ data: [makeOrder(), makeOrder({ id: 1002 })] });

    const result = await service.backupOrdersForCredential(makeCredential(), { limit: 100 });

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(result.orders).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// runCredentialBackupJob — cron watermark advancement
// ---------------------------------------------------------------------------

describe('OdooBackupService.runCredentialBackupJob', () => {
  const mockAxiosGet = jest.spyOn(axios, 'get');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips silently when no active credentials are configured', async () => {
    const { service, prisma } = makeService();
    prisma.odooCredential.findMany.mockResolvedValue([]);

    await service.runCredentialBackupJob();

    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('advances lastSyncAt watermark after a successful backup', async () => {
    const { service, prisma } = makeService();
    prisma.odooCredential.findMany.mockResolvedValue([makeCredential()]);
    mockAxiosGet.mockResolvedValue({ data: [] });

    await service.runCredentialBackupJob();

    expect(prisma.odooCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSyncAt: expect.any(Date) }),
      }),
    );
  });

  it('ingests fetched orders into OrderSyncQueue', async () => {
    const { service, prisma, orderSyncService } = makeService();
    prisma.odooCredential.findMany.mockResolvedValue([makeCredential()]);
    mockAxiosGet.mockResolvedValue({ data: [makeOrder()] });

    await service.runCredentialBackupJob();

    expect(orderSyncService.ingestOrder).toHaveBeenCalledTimes(1);
  });

  it('skips ingest for orders missing branch_id and still advances watermark', async () => {
    const { service, prisma, orderSyncService } = makeService();
    prisma.odooCredential.findMany.mockResolvedValue([makeCredential()]);
    // Order without branch_id — normalizeOrderForIngestion returns null
    mockAxiosGet.mockResolvedValue({ data: [makeOrder({ branch_id: null })] });

    await service.runCredentialBackupJob();

    expect(orderSyncService.ingestOrder).not.toHaveBeenCalled();
    // Watermark should still advance so we don't re-fetch this order forever
    expect(prisma.odooCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSyncAt: expect.any(Date) }),
      }),
    );
  });
});
