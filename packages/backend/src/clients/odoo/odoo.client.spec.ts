/**
 * OdooClient tests
 *
 * Focuses on the extractList() response-envelope logic which is the
 * root cause of getOrders() returning [] even when Odoo has records.
 *
 * We spy on the private axios instance (`(client as any).http`) so
 * that no real network calls are made regardless of how jest.mock hoisting
 * interacts with the module.
 */

import { ConfigService } from '@nestjs/config';
import { OdooClient } from './odoo.client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    name: 'POS/2024/00001',
    date_order: '2024-03-10 09:00:00',
    amount_total: 210.0,
    branch_id: [3, 'Dubai Branch'],
    state: 'done',
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ODOO_BASE_URL: 'https://odoo.example.com',
    ODOO_API_KEY: 'test-api-key',
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

/**
 * Creates a client and returns both the client and a jest spy on the
 * internal axios `http.get` so we can control the response without making
 * real HTTP calls.
 */
function makeClient(config = makeConfig()) {
  const client = new OdooClient(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const httpGet = jest.spyOn((client as any).http, 'get');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const httpPost = jest.spyOn((client as any).http, 'post');
  return { client, httpGet, httpPost };
}

// ---------------------------------------------------------------------------
// extractList envelope tests (exercised via getOrders)
// ---------------------------------------------------------------------------

describe('OdooClient.getOrders — response envelope parsing', () => {
  it('✅ plain array response → orders extracted correctly', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: [makeOrder(), makeOrder({ id: 1002 })] });

    const orders = await client.getOrders({ limit: 100 });

    expect(orders).toHaveLength(2);
  });

  it('✅ {records:[...]} envelope (Odoo 16+ REST) → orders extracted correctly', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: { records: [makeOrder()] } });

    const orders = await client.getOrders({ limit: 100 });

    expect(orders).toHaveLength(1);
  });

  it('✅ {result:[...]} envelope → orders extracted correctly', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: { result: [makeOrder()] } });

    const orders = await client.getOrders({ limit: 100 });

    expect(orders).toHaveLength(1);
  });

  it('✅ {data:[...]} envelope → orders extracted correctly', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: { data: [makeOrder()] } });

    const orders = await client.getOrders({ limit: 100 });

    expect(orders).toHaveLength(1);
  });

  // ── KNOWN GAPS — envelopes that silently produce fetched:0 ────────────────

  it('✅ {result:{records:[...]}} nested envelope (Odoo 17/18 REST API) → orders extracted correctly', async () => {
    // Odoo 17/18 wraps POS orders as { result: { records: [...], length: N } }.
    // extractList() unwraps the nested object and returns the records array.
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({
      data: { result: { records: [makeOrder(), makeOrder({ id: 1002 })], length: 2 } },
    });

    const orders = await client.getOrders({ limit: 100 });

    expect(orders).toHaveLength(2);
  });

  it('✅ {result:{data:[...]}} nested envelope → orders extracted correctly', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: { result: { data: [makeOrder()], count: 1 } } });

    const orders = await client.getOrders({ limit: 100 });

    expect(orders).toHaveLength(1);
  });

  it('empty / unrecognised response returns empty array without throwing', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: {} });

    const orders = await client.getOrders({ limit: 100 });

    expect(orders).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getOrders — HTTP call parameters
// ---------------------------------------------------------------------------

describe('OdooClient.getOrders — HTTP parameters', () => {
  it('calls /api/pos/order when ODOO_API_KEY is configured', async () => {
    const { client, httpGet } = makeClient(makeConfig({ ODOO_API_KEY: 'my-key' }));
    httpGet.mockResolvedValue({ data: [] });

    await client.getOrders({ limit: 50 });

    expect(httpGet).toHaveBeenCalledWith(
      '/api/pos/order',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'my-key' }),
        params: expect.objectContaining({ limit: 50 }),
      }),
    );
  });

  it('sends start_date param when startDate is provided', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: [] });

    await client.getOrders({ startDate: '2024-01-01T00:00:00Z', limit: 100 });

    expect(httpGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({ start_date: '2024-01-01T00:00:00Z' }),
      }),
    );
  });

  it('does NOT send start_date when startDate is not provided (first run)', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: [] });

    await client.getOrders({ limit: 100 });

    const call = httpGet.mock.calls[0][1] as { params: Record<string, unknown> };
    expect(call.params).not.toHaveProperty('start_date');
  });

  it('sends branch_id param when branchId is provided', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: [] });

    await client.getOrders({ branchId: 5, limit: 100 });

    expect(httpGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({ branch_id: 5 }),
      }),
    );
  });

  it('does NOT send branch_id when branchId is not provided', async () => {
    const { client, httpGet } = makeClient();
    httpGet.mockResolvedValue({ data: [] });

    await client.getOrders({ limit: 100 });

    const call = httpGet.mock.calls[0][1] as { params: Record<string, unknown> };
    expect(call.params).not.toHaveProperty('branch_id');
  });

  it('falls back to /api/sale.order when ODOO_API_KEY is not set', async () => {
    const { client, httpGet, httpPost } = makeClient(
      makeConfig({ ODOO_API_KEY: undefined }),
    );
    // Simulate session authentication response
    httpPost.mockResolvedValue({
      headers: { 'set-cookie': ['session_id=abc; Path=/'] },
    });
    httpGet.mockResolvedValue({ data: [] });

    await client.getOrders({ limit: 100 });

    expect(httpGet).toHaveBeenCalledWith('/api/sale.order', expect.anything());
  });
});
