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
import { PaymentMethodMapping } from '../database/entities/payment-method-mapping.entity';

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
    'addGroupBy',
    'orderBy',
    'take',
    'skip',
    'limit',
    'offset',
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
  /** Rows of { headerId, orders } — how many Odoo orders each invoice bills. */
  headerOrderCounts?: unknown[];
  /** Rows of { orderId, method, cnt, total } for the tender breakdown. */
  odooPaymentsByMethod?: unknown[];
  /** Standard receipts matched by transaction number, for the tender view. */
  standardReceiptsByTxn?: unknown[];
  /** Misc (fee) receipts matched by transaction number. */
  miscReceiptsByTxn?: unknown[];
  paymentMappings?: Partial<PaymentMethodMapping>[];
  orphans?: unknown[];
}

/** Stands in for the Oracle REST client in liveVerify tests. */
interface MockOracle {
  getInvoiceByTransactionNumber: jest.Mock;
  getInvoiceLines: jest.Mock;
}

function makeService(fx: Fixture, oracle?: MockOracle) {
  const odooOrders = makeRepo([fx.orders ?? []]);
  const odooLines = makeRepo([fx.odooLineAgg ?? []]);
  // Read twice: the per-order total for reconcile(), then the per-method
  // split for tenderBreakdown().
  const odooPayments = makeRepo([
    fx.odooPaymentAgg ?? [],
    fx.odooPaymentsByMethod ?? [],
  ]);
  // invoiceLines answers four queries in order: the aggregate, the
  // error-status pass, the per-header order count, then the orphan hunt.
  const invoiceLines = makeRepo([
    fx.oracleLineAgg ?? [],
    fx.oracleErrorLines ?? [],
    fx.headerOrderCounts ?? [],
    fx.orphans ?? [],
  ]);
  const invoiceHeaders = makeRepo([fx.headers ?? []]);
  // Read twice: matched by order name for reconcile(), then by transaction
  // number for tenderBreakdown().
  const standardReceipts = makeRepo([
    fx.standardReceipts ?? [],
    fx.standardReceiptsByTxn ?? [],
  ]);
  const miscReceipts = makeRepo([
    fx.miscReceipts ?? [],
    fx.miscReceiptsByTxn ?? [],
  ]);
  // Read twice during liveVerify: once by buildRows for the queue status,
  // then again by order name for the transaction number.
  const queue = makeRepo([fx.queueRows ?? [], fx.queueRows ?? []]);
  const paymentMappings = makeRepo([fx.paymentMappings ?? []]);

  const service = new ReconciliationService(
    odooOrders as unknown as Repository<BackupOdooOrder>,
    odooLines as unknown as Repository<BackupOdooOrderLine>,
    odooPayments as unknown as Repository<BackupOdooOrderPayment>,
    invoiceHeaders as unknown as Repository<FusionInvoiceHeader>,
    invoiceLines as unknown as Repository<FusionInvoiceLine>,
    standardReceipts as unknown as Repository<FusionStandardReceipt>,
    miscReceipts as unknown as Repository<FusionMiscReceipt>,
    queue as unknown as Repository<OrderSyncQueue>,
    paymentMappings as unknown as Repository<PaymentMethodMapping>,
    oracle as unknown as never,
  );
  return { service, odooOrders, invoiceLines, queue };
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

describe('ReconciliationService.liveVerify', () => {
  /**
   * One stored order: total 105 including 5 tax, so 100 net — the basis Oracle
   * reports its LineAmount on. Two Odoo lines, already pushed as txn 2975516.
   */
  function liveFixture(): Fixture {
    return {
      orders: [order({ orderId: 101, orderName: 'DXB/0001' })],
      odooLineAgg: [{ orderId: 101, cnt: '2', total: '105' }],
      odooPaymentAgg: [{ orderId: 101, cnt: '1', total: '105' }],
      oracleLineAgg: [
        {
          salesOrder: 'DXB/0001',
          cnt: '2',
          headerId: 'h1',
          invoiceNumber: 'INV-1',
          status: 'SUCCESS',
        },
      ],
      headers: [{ id: 'h1', status: 'SUCCESS', totalAmount: 105 as never }],
      queueRows: [
        { odooOrderNumber: 'DXB/0001', oracleInvoiceNumber: '2975516' },
      ],
    };
  }

  const oracleInvoice = (over: Record<string, unknown> = {}) => ({
    transactionNumber: '2975516',
    customerTransactionId: 300000237358653,
    documentNumber: 414884,
    status: 'Complete',
    transactionDate: '2026-08-01',
    accountingDate: '2026-08-01',
    currencyCode: 'SAR',
    transactionType: 'Vend Invoice',
    transactionSource: 'Vend',
    businessUnit: 'AlQurashi-KSA',
    billToCustomerName: 'KHJTHEZONE',
    billToCustomerNumber: '163018',
    enteredAmount: 120.75,
    balanceAmount: 0,
    ...over,
  });

  const line = (salesOrder: string, lineAmount: number, lineNumber = 1) => ({
    lineNumber,
    description: 'Item',
    itemNumber: 'SKU',
    quantity: 1,
    unitSellingPrice: lineAmount,
    lineAmount,
    taxClassificationCode: 'OUTPUT-GOODS-DOM-15%',
    salesOrder,
    unitOfMeasure: 'Each',
  });

  /** Two lines totalling the order's 100 net. */
  const ownLines = () => [line('DXB/0001', 50, 1), line('DXB/0001', 50, 2)];

  const mockOracle = (
    invoice: unknown,
    lines: unknown[] = ownLines(),
    totalCount?: number,
  ): MockOracle => ({
    getInvoiceByTransactionNumber: jest.fn().mockResolvedValue(invoice),
    getInvoiceLines: jest.fn().mockResolvedValue({
      totalCount: totalCount ?? lines.length,
      lines,
    }),
  });

  it('verifies an order Oracle agrees with', async () => {
    const { service } = makeService(liveFixture(), mockOracle(oracleInvoice()));
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('VERIFIED');
    expect(result.issues).toEqual([]);
    expect(result.odoo.net).toBe(100);
    expect(result.live?.orderNet).toBe(100);
    expect(result.amountDifference).toBe(0);
  });

  it("compares only this order's lines on a shared daily invoice", async () => {
    // The real shape: one Oracle invoice billing a whole store-day. Counting
    // the other orders' lines would report this one as massively short.
    const shared = [
      ...ownLines(),
      line('DXB/0002', 173.04, 3),
      line('DXB/0003', 433.06, 4),
    ];
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice({ enteredAmount: 2402.52 }), shared),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('VERIFIED');
    expect(result.live?.orderNet).toBe(100);
    expect(result.live?.lineCount).toBe(2);
    expect(result.live?.invoice.isAggregate).toBe(true);
    expect(result.live?.invoice.coversOrders).toBe(3);
    // The invoice-wide total is still reported, just not compared against.
    expect(result.live?.enteredAmount).toBe(2402.52);
  });

  it('looks the invoice up by the transaction number the queue recorded', async () => {
    const oracle = mockOracle(oracleInvoice());
    const { service } = makeService(liveFixture(), oracle);
    await service.liveVerify('DXB/0001');

    expect(oracle.getInvoiceByTransactionNumber).toHaveBeenCalledWith(
      '2975516',
    );
    expect(oracle.getInvoiceLines).toHaveBeenCalledWith(300000237358653, 500);
  });

  it('falls back to the order name when no transaction number was recorded', async () => {
    const fx = liveFixture();
    fx.queueRows = [];
    fx.oracleLineAgg = [];
    fx.headers = [];
    const oracle = mockOracle(null);
    const { service } = makeService(fx, oracle);
    await service.liveVerify('DXB/0001');

    expect(oracle.getInvoiceByTransactionNumber).toHaveBeenCalledWith(
      'DXB/0001',
    );
  });

  it("reports a real shortfall in this order's own lines", async () => {
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice(), [line('DXB/0001', 60, 1)]),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('MISMATCH');
    expect(result.amountDifference).toBe(40);
    expect(result.issues.join(' ')).toContain('40');
  });

  it('flags an invoice Oracle has not fully receipted', async () => {
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice({ balanceAmount: 7.45 })),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('MISMATCH');
    expect(result.issues.join(' ')).toContain('7.45');
  });

  it('attributes an outstanding balance to the shared invoice, not the order', async () => {
    const shared = [...ownLines(), line('DXB/0002', 173.04, 3)];
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice({ balanceAmount: 7.45 }), shared),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.issues.join(' ')).toContain('shared by 2 orders');
  });

  it('flags an invoice left incomplete in Oracle', async () => {
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice({ status: 'Incomplete' })),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('MISMATCH');
    expect(result.issues.join(' ')).toContain('Incomplete');
  });

  it('reports a line count that disagrees with Oracle', async () => {
    const five = [
      line('DXB/0001', 20, 1),
      line('DXB/0001', 20, 2),
      line('DXB/0001', 20, 3),
      line('DXB/0001', 20, 4),
      line('DXB/0001', 20, 5),
    ];
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice(), five),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('MISMATCH');
    expect(result.lineDifference).toBe(-3);
    // Money still agrees — 5 x 20 is the same 100.
    expect(result.amountDifference).toBe(0);
  });

  it('treats an empty Oracle result as not-in-Oracle, not an error', async () => {
    const oracle = mockOracle(null);
    const { service } = makeService(liveFixture(), oracle);
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('NOT_IN_ORACLE');
    expect(result.live).toBeNull();
    expect(oracle.getInvoiceLines).not.toHaveBeenCalled();
  });

  it('reports an invoice that carries no line for this order', async () => {
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice(), [line('DXB/0099', 500, 1)]),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('NOT_IN_ORACLE');
    expect(result.issues.join(' ')).toContain('no line for sales order');
  });

  it('refuses to total a share it could not read in full', async () => {
    // More lines exist than one page returned, so this order's share is unknown.
    const { service } = makeService(
      liveFixture(),
      mockOracle(oracleInvoice(), ownLines(), 900),
    );
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('MISMATCH');
    expect(result.amountDifference).toBeNull();
    expect(result.issues.join(' ')).toContain('cannot be totalled');
  });

  it('reports an unreachable pod without failing the whole request', async () => {
    const oracle: MockOracle = {
      getInvoiceByTransactionNumber: jest
        .fn()
        .mockRejectedValue(new Error('timeout of 30000ms exceeded')),
      getInvoiceLines: jest.fn(),
    };
    const { service } = makeService(liveFixture(), oracle);
    const result = await service.liveVerify('DXB/0001');

    expect(result.status).toBe('LOOKUP_FAILED');
    expect(result.issues.join(' ')).toContain('timeout');
    expect(result.odoo.total).toBe(105);
  });

  it('refuses when no Oracle client is configured', async () => {
    const { service } = makeService(liveFixture());
    await expect(service.liveVerify('DXB/0001')).rejects.toThrow(
      /not available/i,
    );
  });

  it('404s for an order that was never stored', async () => {
    const { service } = makeService(
      { orders: [] },
      mockOracle(oracleInvoice()),
    );
    await expect(service.liveVerify('NOPE/1')).rejects.toThrow(/No Odoo order/);
  });

  it('honours a caller-supplied tolerance', async () => {
    // A fresh service per call: the mock repositories hand out each queued
    // result once, so one instance cannot answer two runs.
    const near = () => [line('DXB/0001', 50, 1), line('DXB/0001', 50.4, 2)];
    const lenient = makeService(
      liveFixture(),
      mockOracle(oracleInvoice(), near()),
    ).service;
    const strict = makeService(
      liveFixture(),
      mockOracle(oracleInvoice(), near()),
    ).service;

    expect((await lenient.liveVerify('DXB/0001', 0.5)).status).toBe('VERIFIED');
    expect((await strict.liveVerify('DXB/0001', 0.01)).status).toBe('MISMATCH');
  });
});

describe('ReconciliationService aggregated daily invoices', () => {
  /** Two Odoo orders billed on one Oracle invoice, as the daily path does. */
  function sharedInvoiceFixture(): Fixture {
    return {
      orders: [order({ orderId: 101, orderName: 'DXB/0001' })],
      odooLineAgg: [{ orderId: 101, cnt: '2', total: '105' }],
      odooPaymentAgg: [{ orderId: 101, cnt: '1', total: '105' }],
      oracleLineAgg: [
        {
          salesOrder: 'DXB/0001',
          cnt: '2',
          headerId: 'h1',
          invoiceNumber: 'INV-DAY',
          status: 'SUCCESS',
        },
      ],
      // The invoice totals the whole store-day, not this one order.
      headers: [{ id: 'h1', status: 'SUCCESS', totalAmount: 2089.16 as never }],
      headerOrderCounts: [{ headerId: 'h1', orders: '11' }],
    };
  }

  it('does not call an order short against an invoice it shares', async () => {
    const { service } = makeService(sharedInvoiceFixture());
    const result = await service.reconcile({ status: 'ALL' });

    expect(result.rows[0].status).not.toBe('AMOUNT_MISMATCH');
    expect(result.rows[0].amountDifference).toBeNull();
    expect(result.rows[0].oracle?.isAggregate).toBe(true);
    expect(result.rows[0].oracle?.coversOrders).toBe(11);
    expect(result.rows[0].issues.join(' ')).toContain('shared invoice');
  });

  it('still compares money when the invoice bills one order alone', async () => {
    const fx = sharedInvoiceFixture();
    fx.headerOrderCounts = [{ headerId: 'h1', orders: '1' }];
    fx.headers = [{ id: 'h1', status: 'SUCCESS', totalAmount: 105 as never }];

    const { service } = makeService(fx);
    const result = await service.reconcile({ status: 'ALL' });

    expect(result.rows[0].oracle?.isAggregate).toBe(false);
    expect(result.rows[0].amountDifference).toBe(0);
    expect(result.rows[0].status).toBe('MATCHED');
  });

  it('counts a shared invoice once in the summary, not once per order', async () => {
    const { service } = makeService(sharedInvoiceFixture());
    const result = await service.reconcile({ status: 'ALL' });

    // One order scanned, one invoice counted — 2089.16, not a multiple of it.
    expect(result.summary.oracleTotal).toBe(2089.16);
  });
});

describe('ReconciliationService.tenderBreakdown', () => {
  /**
   * One store-day: an order taking 60 in Mada and 45 in Cash, billed on Oracle
   * invoice 2975516, which receipted the same two tenders.
   */
  function tenderFixture(): Fixture {
    return {
      orders: [
        order({
          orderId: 101,
          orderName: 'KHJ/3039',
          branchName: 'Khobar',
          resolvedBranchCode: 'KHJ',
          dateOrder: new Date('2026-08-01T06:51:33Z'),
        }),
      ],
      odooLineAgg: [{ orderId: 101, cnt: '2', total: '105' }],
      odooPaymentAgg: [{ orderId: 101, cnt: '2', total: '105' }],
      odooPaymentsByMethod: [
        { orderId: 101, method: 'Mada', cnt: '1', total: '60' },
        { orderId: 101, method: 'Cash', cnt: '1', total: '45' },
      ],
      oracleLineAgg: [
        {
          salesOrder: 'KHJ/3039',
          cnt: '2',
          headerId: 'h1',
          invoiceNumber: '2975516',
          status: 'SUCCESS',
        },
      ],
      headers: [{ id: 'h1', status: 'SUCCESS', totalAmount: 105 as never }],
      standardReceiptsByTxn: [
        { receiptNumber: 'Mada-2975516', receiptAmount: '60' },
        { receiptNumber: 'Cash-2975516', receiptAmount: '45' },
      ],
      paymentMappings: [
        {
          sourcePaymentName: 'Mada',
          oracleReceiptMethodName: 'Mada',
          isActive: true,
        },
        {
          sourcePaymentName: 'Cash',
          oracleReceiptMethodName: 'Cash',
          isActive: true,
        },
      ],
    };
  }

  it('reconciles each tender for a store on a day', async () => {
    const { service } = makeService(tenderFixture());
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows).toHaveLength(2);
    const mada = result.rows.find((r) => r.method === 'Mada');
    expect(mada?.branchCode).toBe('KHJ');
    expect(mada?.date).toBe('2026-08-01');
    expect(mada?.odooTotal).toBe(60);
    expect(mada?.oracleTotal).toBe(60);
    expect(mada?.variance).toBe(0);
    expect(mada?.status).toBe('MATCHED');
  });

  it('flags a tender Oracle receipted short', async () => {
    const fx = tenderFixture();
    fx.standardReceiptsByTxn = [
      { receiptNumber: 'Mada-2975516', receiptAmount: '50' },
      { receiptNumber: 'Cash-2975516', receiptAmount: '45' },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    const mada = result.rows.find((r) => r.method === 'Mada');
    expect(mada?.variance).toBe(10);
    expect(mada?.status).toBe('SHORT_IN_ORACLE');
    // Worst gap first.
    expect(result.rows[0].method).toBe('Mada');
  });

  it('flags a tender Oracle never receipted at all', async () => {
    const fx = tenderFixture();
    fx.standardReceiptsByTxn = [
      { receiptNumber: 'Cash-2975516', receiptAmount: '45' },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    const mada = result.rows.find((r) => r.method === 'Mada');
    expect(mada?.status).toBe('MISSING_IN_ORACLE');
    expect(mada?.oracleCount).toBe(0);
  });

  it('flags a tender Oracle receipted but the till never reported', async () => {
    const fx = tenderFixture();
    fx.standardReceiptsByTxn = [
      { receiptNumber: 'Mada-2975516', receiptAmount: '60' },
      { receiptNumber: 'Cash-2975516', receiptAmount: '45' },
      { receiptNumber: 'Amex-2975516', receiptAmount: '30' },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    const amex = result.rows.find((r) => r.method === 'Amex');
    expect(amex?.status).toBe('UNEXPECTED_IN_ORACLE');
    expect(amex?.odooCount).toBe(0);
    expect(amex?.mappingStatus).toBe('ORACLE_ONLY');
  });

  it('keeps settlement fees out of the takings column', async () => {
    const fx = tenderFixture();
    // Card fees arrive as negative misc receipts against the same tender.
    fx.miscReceiptsByTxn = [
      { receiptNumber: 'Mada-2975516-MISC', receiptAmount: '-5.93' },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    const mada = result.rows.find((r) => r.method === 'Mada');
    expect(mada?.oracleTotal).toBe(60);
    expect(mada?.oracleFees).toBe(-5.93);
    // A fee is not a shortfall against the till.
    expect(mada?.status).toBe('MATCHED');
  });

  it('treats one tender spelled two ways as one tender', async () => {
    const fx = tenderFixture();
    fx.standardReceiptsByTxn = [
      { receiptNumber: 'MADA-2975516', receiptAmount: '60' },
      { receiptNumber: 'Cash-2975516', receiptAmount: '45' },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows).toHaveLength(2);
    const mada = result.rows.find((r) => r.method.toUpperCase() === 'MADA');
    expect(mada?.odooTotal).toBe(60);
    expect(mada?.oracleTotal).toBe(60);
  });

  it('recovers a hyphenated tender name from the receipt number', async () => {
    const fx = tenderFixture();
    fx.odooPaymentsByMethod = [
      { orderId: 101, method: 'Credit-Card', cnt: '1', total: '105' },
    ];
    fx.standardReceiptsByTxn = [
      { receiptNumber: 'Credit-Card-2975516', receiptAmount: '105' },
    ];
    fx.paymentMappings = [];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    // Splitting on the first '-' would have produced "Credit".
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].method).toBe('Credit-Card');
    expect(result.rows[0].oracleTotal).toBe(105);
  });

  it('names the tenders that have no usable Oracle receipt method', async () => {
    const fx = tenderFixture();
    fx.paymentMappings = [
      {
        sourcePaymentName: 'Mada',
        oracleReceiptMethodName: 'PENDING_MAPPING',
        isActive: false,
      },
      {
        sourcePaymentName: 'Cash',
        oracleReceiptMethodName: 'Cash',
        isActive: true,
      },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    const mada = result.rows.find((r) => r.method === 'Mada');
    // The stale mapping row is surfaced on the tender itself...
    expect(mada?.mappingStatus).toBe('PENDING');
    // ...but Oracle is receipting Mada here, so it is not blocking anything and
    // does not belong in the headline list of stuck tenders.
    expect(result.unmappedMethods).toEqual([]);
  });

  it('headlines a PENDING tender that is genuinely stuck', async () => {
    const fx = tenderFixture();
    fx.paymentMappings = [
      {
        sourcePaymentName: 'Mada',
        oracleReceiptMethodName: 'PENDING_MAPPING',
        isActive: false,
      },
    ];
    // Nothing receipted for Mada anywhere in the window.
    fx.standardReceiptsByTxn = [
      { receiptNumber: 'Cash-2975516', receiptAmount: '45' },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.unmappedMethods).toEqual(['Mada']);
  });

  it('rolls every store and day up to one row per tender', async () => {
    const { service } = makeService(tenderFixture());
    const result = await service.tenderBreakdown({}, 'method');

    expect(result.rows).toHaveLength(2);
    // A method-only roll-up claims neither a store nor a day.
    expect(result.rows[0].branchCode).toBeNull();
    expect(result.rows[0].date).toBeNull();
  });

  it('totals every tender in the window', async () => {
    const { service } = makeService(tenderFixture());
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.totals.odooTotal).toBe(105);
    expect(result.totals.oracleTotal).toBe(105);
    expect(result.totals.variance).toBe(0);
    expect(result.scanned).toBe(1);
  });

  it('labels a payment row with no tender name rather than dropping it', async () => {
    const fx = tenderFixture();
    fx.odooPaymentsByMethod = [
      { orderId: 101, method: null, cnt: '1', total: '105' },
    ];
    fx.standardReceiptsByTxn = [];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows[0].method).toBe('UNKNOWN');
    expect(result.rows[0].odooTotal).toBe(105);
  });

  it('returns an empty, well-formed result for a quiet window', async () => {
    const { service } = makeService({ orders: [] });
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows).toEqual([]);
    expect(result.totals.odooTotal).toBe(0);
    expect(result.unmappedMethods).toEqual([]);
  });
});

describe('ReconciliationService tender honesty guards', () => {
  function partialFixture(coversOrders: string): Fixture {
    return {
      orders: [
        order({
          orderId: 101,
          orderName: 'KHJ/3039',
          branchName: 'Khobar',
          resolvedBranchCode: 'KHJ',
          dateOrder: new Date('2026-08-01T06:51:33Z'),
        }),
      ],
      odooLineAgg: [{ orderId: 101, cnt: '2', total: '105' }],
      odooPaymentAgg: [{ orderId: 101, cnt: '1', total: '105' }],
      odooPaymentsByMethod: [
        { orderId: 101, method: 'Cash', cnt: '1', total: '105' },
      ],
      oracleLineAgg: [
        {
          salesOrder: 'KHJ/3039',
          cnt: '2',
          headerId: 'h1',
          invoiceNumber: '2975516',
          status: 'SUCCESS',
        },
      ],
      headers: [{ id: 'h1', status: 'SUCCESS', totalAmount: 105 as never }],
      headerOrderCounts: [{ headerId: 'h1', orders: coversOrders }],
      // The receipt covers the whole invoice, not just the scanned order.
      standardReceiptsByTxn: [
        { receiptNumber: 'Cash-2975516', receiptAmount: '56056' },
      ],
    };
  }

  it('does not call a store over when the window only caught part of its day', async () => {
    // The invoice bills 40 orders; the window caught 1. Oracle receipted the
    // whole day, so the "gap" is the date filter, not a discrepancy.
    const { service } = makeService(partialFixture('40'));
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows[0].partial).toBe(true);
    expect(result.rows[0].status).toBe('INCOMPLETE');
  });

  it('judges a tender normally once the whole invoice is in the window', async () => {
    const { service } = makeService(partialFixture('1'));
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows[0].partial).toBe(false);
    expect(result.rows[0].status).toBe('OVER_IN_ORACLE');
  });

  it('does not call a tender unmapped when Oracle is plainly receipting it', async () => {
    // VendHQ-sourced regions resolve receipt methods outside
    // PaymentMethodMapping, which only covers the ODOO source system.
    const fx = partialFixture('1');
    fx.paymentMappings = [];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows[0].mappingStatus).toBe('MAPPED');
    expect(result.unmappedMethods).toEqual([]);
  });

  it('blames sync, not mapping, when a tender settles fine for another store', async () => {
    // One store never synced; the same tender receipts normally elsewhere.
    const fx = partialFixture('1');
    fx.paymentMappings = [];
    fx.orders = [
      order({
        orderId: 101,
        orderName: 'KHJ/3039',
        branchName: 'Khobar',
        resolvedBranchCode: 'KHJ',
        dateOrder: new Date('2026-08-01T06:51:33Z'),
      }),
      order({
        orderId: 102,
        orderName: 'JED/1',
        branchName: 'Jeddah',
        resolvedBranchCode: 'JED',
        dateOrder: new Date('2026-08-01T07:00:00Z'),
      }),
    ];
    fx.odooPaymentsByMethod = [
      { orderId: 101, method: 'Cash', cnt: '1', total: '105' },
      { orderId: 102, method: 'Cash', cnt: '1', total: '200' },
    ];
    fx.oracleLineAgg = [
      {
        salesOrder: 'JED/1',
        cnt: '1',
        headerId: 'h1',
        invoiceNumber: '2975516',
        status: 'SUCCESS',
      },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-method');

    // Khobar receipted nothing, but Cash is clearly a working tender.
    const khobar = result.rows.find((r) => r.branchCode === 'KHJ');
    expect(khobar?.status).toBe('MISSING_IN_ORACLE');
    expect(khobar?.mappingStatus).toBe('MAPPED');
    expect(result.unmappedMethods).toEqual([]);
  });

  it('keeps a stale PENDING mapping out of the headline when Oracle receipts it', async () => {
    const fx = partialFixture('1');
    fx.paymentMappings = [
      {
        sourcePaymentName: 'Cash',
        oracleReceiptMethodName: 'PENDING_MAPPING',
        isActive: false,
      },
    ];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    // The row still says PENDING so the stale mapping is visible...
    expect(result.rows[0].mappingStatus).toBe('PENDING');
    // ...but the tender is settling, so it is not what is blocking anything.
    expect(result.unmappedMethods).toEqual([]);
  });

  it('still reports a tender that took money and receipted nothing', async () => {
    const fx = partialFixture('1');
    fx.paymentMappings = [];
    fx.standardReceiptsByTxn = [];
    const { service } = makeService(fx);
    const result = await service.tenderBreakdown({}, 'store-date-method');

    expect(result.rows[0].mappingStatus).toBe('UNMAPPED');
    expect(result.unmappedMethods).toEqual(['Cash']);
    expect(result.rows[0].status).toBe('MISSING_IN_ORACLE');
  });
});
