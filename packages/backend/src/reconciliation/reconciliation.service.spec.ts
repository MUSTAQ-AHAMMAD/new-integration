import { Repository } from 'typeorm';
import { ReconciliationService } from './reconciliation.service';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';

/**
 * A query-builder stand-in: every chainable call returns itself, and the
 * terminal calls pop the next queued result. Queues are per-repository, and
 * each repository issues its queries in a fixed order, so a queue is enough to
 * script a whole reconcile() run without a database.
 */
function makeRepo(results: unknown[][] = []) {
  const queue = [...results];
  const next = () => queue.shift() ?? [];
  const builder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'take',
    'skip',
  ]) {
    builder[method] = jest.fn(() => builder);
  }
  builder.getRawMany = jest.fn(() => Promise.resolve(next()));
  builder.getMany = jest.fn(() => Promise.resolve(next()));

  return {
    createQueryBuilder: jest.fn(() => builder),
    find: jest.fn(() => Promise.resolve(next())),
    findOne: jest.fn(() => Promise.resolve(next()[0] ?? null)),
    builder,
  };
}

interface Fixture {
  orders?: Partial<BackupOdooOrder>[];
  odooLineAgg?: unknown[];
  odooPaymentAgg?: unknown[];
  oracleLineAgg?: unknown[];
  oracleErrorLines?: unknown[];
  headers?: Partial<FusionInvoiceHeader>[];
  standardReceipts?: unknown[];
  miscReceipts?: unknown[];
  queueRows?: Partial<OrderSyncQueue>[];
  orphans?: unknown[];
}

function makeService(fx: Fixture) {
  const odooOrders = makeRepo([fx.orders ?? []]);
  const odooLines = makeRepo([fx.odooLineAgg ?? []]);
  const odooPayments = makeRepo([fx.odooPaymentAgg ?? []]);
  // invoiceLines answers three queries in order: the aggregate, the
  // error-status pass, then the orphan hunt.
  const invoiceLines = makeRepo([
    fx.oracleLineAgg ?? [],
    fx.oracleErrorLines ?? [],
    fx.orphans ?? [],
  ]);
  const invoiceHeaders = makeRepo([fx.headers ?? []]);
  const standardReceipts = makeRepo([fx.standardReceipts ?? []]);
  const miscReceipts = makeRepo([fx.miscReceipts ?? []]);
  const queue = makeRepo([fx.queueRows ?? []]);

  const service = new ReconciliationService(
    odooOrders as unknown as Repository<BackupOdooOrder>,
    odooLines as unknown as Repository<BackupOdooOrderLine>,
    odooPayments as unknown as Repository<BackupOdooOrderPayment>,
    invoiceHeaders as unknown as Repository<FusionInvoiceHeader>,
    invoiceLines as unknown as Repository<FusionInvoiceLine>,
    standardReceipts as unknown as Repository<FusionStandardReceipt>,
    miscReceipts as unknown as Repository<FusionMiscReceipt>,
    queue as unknown as Repository<OrderSyncQueue>,
  );
  return { service, odooOrders, invoiceLines };
}

const order = (
  over: Partial<BackupOdooOrder> = {},
): Partial<BackupOdooOrder> => ({
  id: 'backup-1',
  orderId: 101,
  orderName: 'POS/0001',
  branchName: 'Dubai Mall',
  region: 'AE',
  dateOrder: new Date('2026-08-20T10:00:00Z'),
  amountTotal: 105,
  amountUntaxed: 100,
  amountTax: 5,
  amountDiscount: 0,
  state: 'paid',
  ...over,
});

const matchedFixture = (): Fixture => ({
  orders: [order()],
  odooLineAgg: [{ orderId: 101, cnt: '2', total: '105' }],
  odooPaymentAgg: [{ orderId: 101, cnt: '1', total: '105' }],
  oracleLineAgg: [
    {
      salesOrder: 'POS/0001',
      cnt: '2',
      headerId: 'hdr-1',
      invoiceNumber: '900001',
      status: 'SUCCESS',
    },
  ],
  headers: [
    {
      id: 'hdr-1',
      status: 'SUCCESS',
      totalAmount: 105 as never,
      txnDate: new Date('2026-08-20T10:00:00Z'),
    },
  ],
  standardReceipts: [{ receiptNumber: 'CASH-POS/0001', receiptAmount: '105' }],
  queueRows: [{ odooOrderNumber: 'POS/0001', status: 'SUCCESS' as never }],
});

describe('ReconciliationService.reconcile', () => {
  it('reports MATCHED when both sides agree', async () => {
    const { service } = makeService(matchedFixture());
    const result = await service.reconcile({});

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('MATCHED');
    expect(result.summary.problems).toBe(0);
    expect(result.summary.matchRate).toBe(100);
    expect(result.summary.variance).toBe(0);
  });

  it('flags an order that never reached Oracle', async () => {
    const fx = matchedFixture();
    fx.oracleLineAgg = [];
    fx.headers = [];
    fx.standardReceipts = [];
    fx.queueRows = [{ odooOrderNumber: 'POS/0001', status: 'FAILED' as never }];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('MISSING_IN_ORACLE');
    expect(result.rows[0].issues[0]).toContain('FAILED');
    expect(result.summary.problems).toBe(1);
  });

  it('flags a total that differs beyond the tolerance', async () => {
    const fx = matchedFixture();
    fx.headers = [
      { id: 'hdr-1', status: 'SUCCESS', totalAmount: 100 as never },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('AMOUNT_MISMATCH');
    expect(result.rows[0].amountDifference).toBe(5);
    expect(result.summary.variance).toBe(5);
  });

  it('accepts a sub-tolerance rounding difference as matched', async () => {
    const fx = matchedFixture();
    fx.headers = [
      { id: 'hdr-1', status: 'SUCCESS', totalAmount: 104.995 as never },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({ tolerance: 0.01 });

    expect(result.rows[0].status).toBe('MATCHED');
  });

  it('honours a caller-supplied tolerance', async () => {
    const fx = matchedFixture();
    fx.headers = [
      { id: 'hdr-1', status: 'SUCCESS', totalAmount: 104 as never },
    ];

    const { service } = makeService(fx);
    await expect(
      service.reconcile({ tolerance: 2 }).then((r) => r.rows[0].status),
    ).resolves.toBe('MATCHED');
  });

  it('surfaces an Oracle rejection above every other difference', async () => {
    const fx = matchedFixture();
    fx.oracleErrorLines = [
      { salesOrder: 'POS/0001', message: 'ORA-20001: tax engine unavailable' },
    ];
    fx.headers = [{ id: 'hdr-1', status: 'ERROR', totalAmount: 0 as never }];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('ORACLE_ERROR');
    expect(result.rows[0].issues.join(' ')).toContain('tax engine');
  });

  it('treats a cancelled order absent from Oracle as expected, not a problem', async () => {
    const fx = matchedFixture();
    fx.orders = [order({ state: 'cancel' })];
    fx.oracleLineAgg = [];
    fx.headers = [];
    fx.standardReceipts = [];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('NOT_SYNCABLE');
    expect(result.summary.problems).toBe(0);
  });

  it('flags a cancelled order that nonetheless reached Oracle', async () => {
    const fx = matchedFixture();
    fx.orders = [order({ state: 'cancel' })];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('UNEXPECTED_IN_ORACLE');
    expect(result.summary.problems).toBe(1);
  });

  it('reports payments as unverifiable rather than zero when no receipt links', async () => {
    const fx = matchedFixture();
    fx.standardReceipts = [];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].oracle?.receiptTotal).toBeNull();
    expect(result.rows[0].status).toBe('MATCHED');
  });

  it('flags linked receipts that do not add up to the Odoo payments', async () => {
    const fx = matchedFixture();
    fx.standardReceipts = [
      { receiptNumber: 'CASH-POS/0001', receiptAmount: '80' },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('PAYMENT_MISMATCH');
    expect(result.rows[0].paymentDifference).toBe(25);
  });

  it('flags a line-count difference', async () => {
    const fx = matchedFixture();
    fx.oracleLineAgg = [
      {
        salesOrder: 'POS/0001',
        cnt: '1',
        headerId: 'hdr-1',
        invoiceNumber: '900001',
        status: 'SUCCESS',
      },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('LINE_MISMATCH');
    expect(result.rows[0].lineDifference).toBe(1);
  });

  it('ranks the money problem above the line problem on the same order', async () => {
    const fx = matchedFixture();
    fx.headers = [{ id: 'hdr-1', status: 'SUCCESS', totalAmount: 90 as never }];
    fx.oracleLineAgg = [
      {
        salesOrder: 'POS/0001',
        cnt: '1',
        headerId: 'hdr-1',
        invoiceNumber: '900001',
        status: 'SUCCESS',
      },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.rows[0].status).toBe('AMOUNT_MISMATCH');
    // The line difference is still reported, just not as the headline.
    expect(result.rows[0].issues.join(' ')).toContain('Line count differs');
  });

  it('does not let one order name claim another receipt by prefix', async () => {
    const fx = matchedFixture();
    fx.orders = [
      order(),
      order({
        id: 'backup-2',
        orderId: 102,
        orderName: 'POS/00012',
        amountTotal: 50,
        amountUntaxed: 50,
        amountTax: 0,
      }),
    ];
    fx.odooLineAgg = [
      { orderId: 101, cnt: '2', total: '105' },
      { orderId: 102, cnt: '1', total: '50' },
    ];
    fx.odooPaymentAgg = [
      { orderId: 101, cnt: '1', total: '105' },
      { orderId: 102, cnt: '1', total: '50' },
    ];
    fx.oracleLineAgg = [
      {
        salesOrder: 'POS/0001',
        cnt: '2',
        headerId: 'hdr-1',
        invoiceNumber: '900001',
        status: 'SUCCESS',
      },
      {
        salesOrder: 'POS/00012',
        cnt: '1',
        headerId: 'hdr-2',
        invoiceNumber: '900002',
        status: 'SUCCESS',
      },
    ];
    fx.headers = [
      { id: 'hdr-1', status: 'SUCCESS', totalAmount: 105 as never },
      { id: 'hdr-2', status: 'SUCCESS', totalAmount: 50 as never },
    ];
    fx.standardReceipts = [
      { receiptNumber: 'CASH-POS/0001', receiptAmount: '105' },
      { receiptNumber: 'CASH-POS/00012', receiptAmount: '50' },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    const longer = result.rows.find((r) => r.orderName === 'POS/00012');
    expect(longer?.oracle?.receiptTotal).toBe(50);
    expect(result.summary.problems).toBe(0);
  });

  it('filters rows to problems while the summary still counts everything', async () => {
    const fx = matchedFixture();
    fx.orders = [
      order(),
      order({ id: 'backup-2', orderId: 102, orderName: 'POS/0002' }),
    ];
    fx.odooLineAgg = [
      { orderId: 101, cnt: '2', total: '105' },
      { orderId: 102, cnt: '1', total: '50' },
    ];
    fx.odooPaymentAgg = [{ orderId: 101, cnt: '1', total: '105' }];

    const { service } = makeService(fx);
    const result = await service.reconcile({ status: 'PROBLEMS' });

    expect(result.summary.scanned).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].orderName).toBe('POS/0002');
  });

  it('reports orphan Oracle invoices with no Odoo order behind them', async () => {
    const fx = matchedFixture();
    fx.orphans = [
      {
        salesOrder: 'GHOST/0009',
        cnt: '3',
        invoiceNumber: '900500',
        region: 'AE',
        firstSeen: new Date('2026-08-21T00:00:00Z'),
      },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({});

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].lineCount).toBe(3);
    expect(result.summary.orphanCount).toBe(1);
  });

  it('marks the run truncated when the window exceeds maxScan', async () => {
    const fx = matchedFixture();
    fx.orders = [
      order(),
      order({ id: 'backup-2', orderId: 102, orderName: 'POS/0002' }),
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({ maxScan: 1 });

    expect(result.summary.truncated).toBe(true);
    expect(result.summary.scanned).toBe(1);
  });

  it('paginates without changing the summary', async () => {
    const fx = matchedFixture();
    fx.orders = [
      order(),
      order({ id: 'backup-2', orderId: 102, orderName: 'POS/0002' }),
    ];
    fx.odooLineAgg = [
      { orderId: 101, cnt: '2', total: '105' },
      { orderId: 102, cnt: '2', total: '105' },
    ];

    const { service } = makeService(fx);
    const result = await service.reconcile({ limit: 1, offset: 1 });

    expect(result.summary.scanned).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.pagination).toEqual({ total: 2, limit: 1, offset: 1 });
  });

  it('returns an empty, well-formed result for a window with no orders', async () => {
    const { service } = makeService({ orders: [] });
    const result = await service.reconcile({});

    expect(result.rows).toEqual([]);
    expect(result.summary.scanned).toBe(0);
    expect(result.summary.matchRate).toBe(100);
  });

  it('extends an end date to the end of that day', async () => {
    const { service, odooOrders } = makeService({ orders: [] });
    await service.reconcile({ endDate: '2026-08-27' });

    const endCall = odooOrders.builder.andWhere.mock.calls.find(
      ([sql]: [string]) => String(sql).includes('o.dateOrder <='),
    );
    expect((endCall?.[1] as { end: Date }).end.toISOString()).toBe(
      '2026-08-27T23:59:59.999Z',
    );
  });
});

/**
 * Two stores trading on two days, one clean and one short by 5.00, so every
 * grouping has something to separate and the totals have something to add up.
 */
function twoStoreFixture(): Fixture {
  const orders: Partial<BackupOdooOrder>[] = [
    order({
      id: 'b1',
      orderId: 101,
      orderName: 'DXB/0001',
      branchName: 'Dubai Mall',
      resolvedBranchCode: 'DXB',
      dateOrder: new Date('2026-08-20T10:00:00Z'),
    }),
    order({
      id: 'b2',
      orderId: 102,
      orderName: 'DXB/0002',
      branchName: 'Dubai Mall',
      resolvedBranchCode: 'DXB',
      dateOrder: new Date('2026-08-21T10:00:00Z'),
    }),
    order({
      id: 'b3',
      orderId: 103,
      orderName: 'AUH/0001',
      branchName: 'Abu Dhabi',
      resolvedBranchCode: 'AUH',
      dateOrder: new Date('2026-08-20T10:00:00Z'),
    }),
  ];

  const agg = (id: number) => ({ orderId: id, cnt: '2', total: '105' });
  const pay = (id: number) => ({ orderId: id, cnt: '1', total: '105' });
  const oracleLine = (name: string, headerId: string) => ({
    salesOrder: name,
    cnt: '2',
    headerId,
    invoiceNumber: `INV-${name}`,
    status: 'SUCCESS',
  });

  return {
    orders,
    odooLineAgg: [agg(101), agg(102), agg(103)],
    odooPaymentAgg: [pay(101), pay(102), pay(103)],
    oracleLineAgg: [
      oracleLine('DXB/0001', 'h1'),
      oracleLine('DXB/0002', 'h2'),
      oracleLine('AUH/0001', 'h3'),
    ],
    headers: [
      { id: 'h1', status: 'SUCCESS', totalAmount: 105 as never },
      // Abu Dhabi is short by 5.00 — the variance the breakdown must localise.
      { id: 'h2', status: 'SUCCESS', totalAmount: 105 as never },
      { id: 'h3', status: 'SUCCESS', totalAmount: 100 as never },
    ],
    standardReceipts: [
      { receiptNumber: 'CASH-DXB/0001', receiptAmount: '105' },
      { receiptNumber: 'CASH-DXB/0002', receiptAmount: '105' },
      { receiptNumber: 'CASH-AUH/0001', receiptAmount: '105' },
    ],
  };
}

describe('ReconciliationService.breakdown', () => {
  it('rolls up per store', async () => {
    const { service } = makeService(twoStoreFixture());
    const result = await service.breakdown({}, 'store');

    expect(result.rows).toHaveLength(2);
    const auh = result.rows.find((r) => r.branchCode === 'AUH');
    const dxb = result.rows.find((r) => r.branchCode === 'DXB');

    expect(dxb?.orders).toBe(2);
    expect(dxb?.problems).toBe(0);
    expect(dxb?.variance).toBe(0);

    expect(auh?.orders).toBe(1);
    expect(auh?.problems).toBe(1);
    expect(auh?.variance).toBe(5);
    expect(auh?.counts.AMOUNT_MISMATCH).toBe(1);
  });

  it('names the store even when only the branch name is known', async () => {
    const fx = twoStoreFixture();
    fx.orders = [
      order({
        orderId: 101,
        orderName: 'DXB/0001',
        branchName: 'Dubai Mall',
        resolvedBranchCode: null,
      }),
    ];
    const { service } = makeService(fx);
    const result = await service.breakdown({}, 'store');

    expect(result.rows[0].key).toBe('Dubai Mall');
    expect(result.rows[0].branchName).toBe('Dubai Mall');
  });

  it('rolls up per trading day, merging stores', async () => {
    const { service } = makeService(twoStoreFixture());
    const result = await service.breakdown({}, 'date');

    expect(result.rows.map((r) => r.date).sort()).toEqual([
      '2026-08-20',
      '2026-08-21',
    ]);
    const day20 = result.rows.find((r) => r.date === '2026-08-20');
    expect(day20?.orders).toBe(2);
    expect(day20?.variance).toBe(5);
    // A date grouping spans stores, so it must not claim one.
    expect(day20?.branchCode).toBeNull();
  });

  it('rolls up per store and day together', async () => {
    const { service } = makeService(twoStoreFixture());
    const result = await service.breakdown({}, 'store-date');

    expect(result.rows).toHaveLength(3);
    const cell = result.rows.find((r) => r.key === 'AUH :: 2026-08-20');
    expect(cell?.orders).toBe(1);
    expect(cell?.variance).toBe(5);
    expect(cell?.date).toBe('2026-08-20');
    expect(cell?.branchCode).toBe('AUH');
  });

  it('puts the worst group first', async () => {
    const { service } = makeService(twoStoreFixture());
    const result = await service.breakdown({}, 'store');
    expect(result.rows[0].branchCode).toBe('AUH');
  });

  it('reports totals that cover every scanned order', async () => {
    const { service } = makeService(twoStoreFixture());
    const result = await service.breakdown({}, 'store');

    expect(result.totals.orders).toBe(3);
    expect(result.totals.odooTotal).toBe(315);
    expect(result.totals.oracleTotal).toBe(310);
    expect(result.totals.variance).toBe(5);
    expect(result.scanned).toBe(3);
  });

  it('keeps store totals whole when the caller filters to problems', async () => {
    const { service } = makeService(twoStoreFixture());
    // A store's money column has to cover every order it booked, otherwise the
    // variance stops reconciling against the POS Z-report.
    const result = await service.breakdown({ status: 'PROBLEMS' }, 'store');

    const dxb = result.rows.find((r) => r.branchCode === 'DXB');
    expect(dxb?.orders).toBe(2);
    expect(result.totals.orders).toBe(3);
  });

  it('counts orders whose receipts could not be linked instead of scoring them zero', async () => {
    const fx = twoStoreFixture();
    fx.standardReceipts = [
      { receiptNumber: 'CASH-DXB/0001', receiptAmount: '105' },
    ];

    const { service } = makeService(fx);
    const result = await service.breakdown({}, 'store');

    const dxb = result.rows.find((r) => r.branchCode === 'DXB');
    expect(dxb?.oracleReceipts).toBe(105);
    expect(dxb?.unlinkedReceiptOrders).toBe(1);
  });

  it('filters to one store on any of its identifiers', async () => {
    const { service, odooOrders } = makeService(twoStoreFixture());
    await service.breakdown({ store: 'Dubai Mall' }, 'store');

    const storeCall = odooOrders.builder.andWhere.mock.calls.find(
      ([sql]: [string]) =>
        String(sql).includes('o.resolvedBranchCode = :store'),
    );
    expect(storeCall).toBeDefined();
    expect(String(storeCall?.[0])).toContain('o.branchName = :store');
    expect(String(storeCall?.[0])).toContain('o.posConfigName = :store');
  });

  it('returns an empty, well-formed roll-up for a quiet window', async () => {
    const { service } = makeService({ orders: [] });
    const result = await service.breakdown({}, 'store');

    expect(result.rows).toEqual([]);
    expect(result.totals.orders).toBe(0);
    expect(result.totals.matchRate).toBe(100);
  });
});
