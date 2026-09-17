import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { DailyAggregationService } from './daily-aggregation.service';
import { IntegrationCoverageService } from './integration-coverage.service';

/**
 * Coverage is what stops days going missing, so these tests are written against
 * the failure modes that actually lost data: a day nobody posted, an order that
 * only posted half its lines, and a late arrival landing on a day the scheduler
 * had already moved past.
 */
describe('IntegrationCoverageService', () => {
  let service: IntegrationCoverageService;
  let orders: { find: jest.Mock };
  let lines: { find: jest.Mock };
  let invoiceLines: { find: jest.Mock };

  // A fixed "now" so business-day arithmetic is deterministic.
  const NOW = new Date('2026-03-10T09:00:00.000Z');

  const makeOrder = (
    over: Partial<BackupOdooOrder> & { orderId: number },
  ): BackupOdooOrder =>
    ({
      orderName: `SO-${over.orderId}`,
      dateOrder: new Date('2026-03-09T10:00:00.000Z'),
      state: 'paid',
      amountTotal: 100,
      resolvedBranchCode: 'BR001',
      branchName: 'Main Store',
      region: 'SA',
      ...over,
    }) as BackupOdooOrder;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    orders = { find: jest.fn().mockResolvedValue([]) };
    lines = { find: jest.fn().mockResolvedValue([]) };
    invoiceLines = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntegrationCoverageService,
        { provide: getRepositoryToken(BackupOdooOrder), useValue: orders },
        { provide: getRepositoryToken(BackupOdooOrderLine), useValue: lines },
        { provide: getRepositoryToken(FusionInvoiceLine), useValue: invoiceLines },
        {
          provide: DailyAggregationService,
          useValue: {
            timeZoneForRegion: () => 'Asia/Riyadh',
            localDayOf: (at: Date, tz: string) =>
              new Date(
                at.getTime() + (tz === 'Asia/Riyadh' ? 3 : 0) * 3_600_000,
              )
                .toISOString()
                .slice(0, 10),
          },
        },
      ],
    }).compile();

    service = module.get(IntegrationCoverageService);
  });

  afterEach(() => jest.useRealTimers());

  it('reports nothing when no orders are backed up', async () => {
    await expect(service.regionCoverage('SA')).resolves.toEqual([]);
    await expect(service.outstandingDays('SA')).resolves.toEqual([]);
  });

  it('counts a fully posted day as complete', async () => {
    orders.find.mockResolvedValue([makeOrder({ orderId: 1 })]);
    lines.find.mockResolvedValue([
      { orderId: 1, qty: 2 },
      { orderId: 1, qty: 1 },
    ]);
    invoiceLines.find.mockResolvedValue([
      { salesOrder: 'SO-1', salesOrderLine: 1, invoiceNumber: 'INV-1' },
      { salesOrder: 'SO-1', salesOrderLine: 2, invoiceNumber: 'INV-1' },
    ]);

    const [day] = await service.regionCoverage('SA');

    expect(day.ordersTotal).toBe(1);
    expect(day.ordersComplete).toBe(1);
    expect(day.linesOutstanding).toBe(0);
    await expect(service.outstandingDays('SA')).resolves.toEqual([]);
  });

  it('flags an order Oracle never received at all', async () => {
    orders.find.mockResolvedValue([makeOrder({ orderId: 2 })]);
    lines.find.mockResolvedValue([{ orderId: 2, qty: 1 }]);
    invoiceLines.find.mockResolvedValue([]);

    const [day] = await service.regionCoverage('SA');

    expect(day.ordersMissing).toBe(1);
    expect(day.ordersPartial).toBe(0);
    expect(day.linesOutstanding).toBe(1);
    expect(day.amountOutstanding).toBe(100);
    expect(day.branches).toEqual(['BR001']);
    expect(day.sampleOrderNumbers).toEqual(['SO-2']);
    await expect(service.outstandingDays('SA')).resolves.toEqual([
      day.businessDay,
    ]);
  });

  it('flags a half-posted order — the gap a per-order check would miss', async () => {
    orders.find.mockResolvedValue([makeOrder({ orderId: 3 })]);
    lines.find.mockResolvedValue([
      { orderId: 3, qty: 1 },
      { orderId: 3, qty: 1 },
      { orderId: 3, qty: 1 },
    ]);
    invoiceLines.find.mockResolvedValue([
      { salesOrder: 'SO-3', salesOrderLine: 1, invoiceNumber: 'INV-9' },
    ]);

    const [day] = await service.regionCoverage('SA');

    expect(day.ordersPartial).toBe(1);
    expect(day.ordersMissing).toBe(0);
    expect(day.linesOutstanding).toBe(2);
  });

  it('ignores zero-quantity lines, which the aggregator never posts', async () => {
    // Otherwise every day with a zero-qty line would look outstanding forever.
    orders.find.mockResolvedValue([makeOrder({ orderId: 4 })]);
    lines.find.mockResolvedValue([
      { orderId: 4, qty: 1 },
      { orderId: 4, qty: 0 },
    ]);
    invoiceLines.find.mockResolvedValue([
      { salesOrder: 'SO-4', salesOrderLine: 1, invoiceNumber: 'INV-4' },
    ]);

    const [day] = await service.regionCoverage('SA');

    expect(day.ordersComplete).toBe(1);
    expect(day.linesOutstanding).toBe(0);
  });

  it('does not count a re-posted line twice', async () => {
    orders.find.mockResolvedValue([makeOrder({ orderId: 5 })]);
    lines.find.mockResolvedValue([
      { orderId: 5, qty: 1 },
      { orderId: 5, qty: 1 },
    ]);
    // Same line recorded by two runs — the order is still only half posted.
    invoiceLines.find.mockResolvedValue([
      { salesOrder: 'SO-5', salesOrderLine: 1, invoiceNumber: 'INV-5' },
      { salesOrder: 'SO-5', salesOrderLine: 1, invoiceNumber: 'INV-6' },
    ]);

    const [day] = await service.regionCoverage('SA');

    expect(day.ordersPartial).toBe(1);
    expect(day.linesOutstanding).toBe(1);
  });

  it('excludes states the aggregator refuses to invoice', async () => {
    // A cancelled order is not a gap; reporting it would be a gap that can
    // never close.
    orders.find.mockResolvedValue([
      makeOrder({ orderId: 6, state: 'cancel' }),
      makeOrder({ orderId: 7, state: 'draft' }),
    ]);
    lines.find.mockResolvedValue([
      { orderId: 6, qty: 1 },
      { orderId: 7, qty: 1 },
    ]);

    await expect(service.regionCoverage('SA')).resolves.toEqual([]);
  });

  it('excludes refunds — those go down the credit-memo path', async () => {
    orders.find.mockResolvedValue([
      makeOrder({ orderId: 8, amountTotal: -50 }),
    ]);
    lines.find.mockResolvedValue([{ orderId: 8, qty: 1 }]);

    await expect(service.regionCoverage('SA')).resolves.toEqual([]);
  });

  it('keeps an old unposted day outstanding — the late-arrival case', async () => {
    // An order for 5 days ago that reached Odoo only now. The old scheduler
    // anchored on the newest posted invoice and would never revisit this day.
    orders.find.mockResolvedValue([
      makeOrder({
        orderId: 9,
        dateOrder: new Date('2026-03-05T10:00:00.000Z'),
      }),
      makeOrder({ orderId: 10 }),
    ]);
    lines.find.mockResolvedValue([
      { orderId: 9, qty: 1 },
      { orderId: 10, qty: 1 },
    ]);
    invoiceLines.find.mockResolvedValue([
      { salesOrder: 'SO-10', salesOrderLine: 1, invoiceNumber: 'INV-10' },
    ]);

    const outstanding = await service.outstandingDays('SA');

    expect(outstanding).toEqual(['2026-03-05']);
  });

  it('reports work that has fallen outside the catch-up window', async () => {
    orders.find.mockResolvedValue([
      makeOrder({
        orderId: 11,
        dateOrder: new Date('2026-02-20T10:00:00.000Z'),
      }),
    ]);
    lines.find.mockResolvedValue([{ orderId: 11, qty: 1 }]);
    invoiceLines.find.mockResolvedValue([]);

    const stale = await service.hasWorkOlderThanWindow('SA', 7);

    expect(stale.found).toBe(true);
    expect(stale.oldestDay).toBe('2026-02-20');
    expect(stale.orders).toBe(1);
  });

  it('buckets orders by the store-local day, not by UTC', async () => {
    // 22:30 UTC on the 8th is 01:30 on the 9th in Riyadh — a UTC-based window
    // would file this sale under the wrong business day and post it twice or
    // not at all.
    orders.find.mockResolvedValue([
      makeOrder({
        orderId: 12,
        dateOrder: new Date('2026-03-08T22:30:00.000Z'),
      }),
    ]);
    lines.find.mockResolvedValue([{ orderId: 12, qty: 1 }]);

    const [day] = await service.regionCoverage('SA');

    expect(day.businessDay).toBe('2026-03-09');
  });
});
