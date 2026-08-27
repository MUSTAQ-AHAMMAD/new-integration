'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  authStorage,
  type BreakdownGroupBy,
  type BreakdownRow,
  type ReconcileQuery,
  type ReconciliationRow,
  type ReconciliationStatus,
} from '@/lib/api';
import { useRegion } from '@/providers/region-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertTriangle,
  CalendarDays,
  Download,
  Scale,
  Search,
  Store,
  X,
} from 'lucide-react';

const STATUS_META: Record<
  ReconciliationStatus,
  { label: string; tone: string; short: string }
> = {
  ORACLE_ERROR: {
    label: 'Oracle error',
    tone: 'bg-red-100 text-red-700 ring-red-200',
    short: 'Oracle rejected the invoice',
  },
  MISSING_IN_ORACLE: {
    label: 'Missing in Oracle',
    tone: 'bg-red-100 text-red-700 ring-red-200',
    short: 'Booked in Odoo, never invoiced',
  },
  UNEXPECTED_IN_ORACLE: {
    label: 'Unexpected in Oracle',
    tone: 'bg-fuchsia-100 text-fuchsia-700 ring-fuchsia-200',
    short: 'Cancelled or unpaid, yet invoiced',
  },
  AMOUNT_MISMATCH: {
    label: 'Amount mismatch',
    tone: 'bg-amber-100 text-amber-800 ring-amber-200',
    short: 'Totals disagree',
  },
  PAYMENT_MISMATCH: {
    label: 'Payment mismatch',
    tone: 'bg-orange-100 text-orange-700 ring-orange-200',
    short: 'Receipts do not match payments',
  },
  LINE_MISMATCH: {
    label: 'Line mismatch',
    tone: 'bg-yellow-100 text-yellow-800 ring-yellow-200',
    short: 'Line counts disagree',
  },
  NOT_SYNCABLE: {
    label: 'Not syncable',
    tone: 'bg-slate-100 text-slate-600 ring-slate-200',
    short: 'Cancelled or unpaid — correctly absent',
  },
  MATCHED: {
    label: 'Matched',
    tone: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
    short: 'Both sides agree',
  },
};

const STATUS_ORDER: ReconciliationStatus[] = [
  'ORACLE_ERROR',
  'MISSING_IN_ORACLE',
  'UNEXPECTED_IN_ORACLE',
  'AMOUNT_MISMATCH',
  'PAYMENT_MISMATCH',
  'LINE_MISMATCH',
  'NOT_SYNCABLE',
  'MATCHED',
];

const PAGE_SIZE = 50;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function money(value: number | null | undefined): string {
  if (value == null) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** The label a store is known by, matching the backend's fallback chain. */
function storeLabel(row: { branchCode: string | null; branchName: string | null }) {
  if (row.branchName && row.branchCode) return `${row.branchName} (${row.branchCode})`;
  return row.branchName ?? row.branchCode ?? 'Unknown store';
}

function varianceTone(variance: number, tolerance: number): string {
  if (Math.abs(variance) <= tolerance) return 'text-emerald-700';
  return variance > 0 ? 'text-amber-700' : 'text-red-700';
}

function StatusPill({ status }: { status: ReconciliationStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      title={meta.short}
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${meta.tone}`}
    >
      {meta.label}
    </span>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = 'border-slate-200 bg-white',
  valueTone = 'text-slate-900',
  onClick,
  active,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
  valueTone?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      onClick={onClick}
      className={`rounded-lg border px-4 py-3 text-left transition-shadow ${tone} ${
        onClick ? 'hover:shadow-sm' : ''
      } ${active ? 'ring-2 ring-indigo-400' : ''}`}
    >
      <div className={`text-2xl font-bold ${valueTone}`}>{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
    </Wrapper>
  );
}

/** A store / day roll-up. Clicking a row drills into the orders behind it. */
function BreakdownTable({
  groupBy,
  query,
  tolerance,
  onDrill,
}: {
  groupBy: BreakdownGroupBy;
  query: ReconcileQuery;
  tolerance: number;
  onDrill: (row: BreakdownRow) => void;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reconciliation-breakdown', groupBy, query],
    queryFn: () => api.reconciliationBreakdown({ ...query, groupBy }),
  });

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to group results'}
        onRetry={() => void refetch()}
      />
    );
  }
  if (isLoading) {
    return <p className="py-8 text-center text-sm text-slate-400">Comparing…</p>;
  }
  if (!data || data.rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-400">
        No orders in this window.
      </p>
    );
  }

  const showStore = groupBy !== 'date';
  const showDate = groupBy !== 'store';

  const totalRow = (row: BreakdownRow, isTotal: boolean) => (
    <TableRow
      key={row.key}
      className={
        isTotal
          ? 'border-t-2 border-slate-300 bg-slate-50 font-semibold'
          : 'cursor-pointer'
      }
      onClick={isTotal ? undefined : () => onDrill(row)}
    >
      {showStore && (
        <TableCell>
          <div className="font-medium text-slate-800">
            {isTotal ? 'All stores' : storeLabel(row)}
          </div>
          {!isTotal && row.region && (
            <div className="text-xs text-slate-500">{row.region}</div>
          )}
        </TableCell>
      )}
      {showDate && (
        <TableCell className="whitespace-nowrap text-sm text-slate-700">
          {isTotal ? 'All days' : (row.date ?? '—')}
        </TableCell>
      )}
      <TableCell className="text-right text-sm">{row.orders}</TableCell>
      <TableCell className="text-right">
        {row.problems > 0 ? (
          <span className="font-semibold text-red-700">{row.problems}</span>
        ) : (
          <span className="text-emerald-700">0</span>
        )}
      </TableCell>
      <TableCell className="text-right text-sm text-slate-600">
        {row.matchRate}%
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {money(row.odooTotal)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {money(row.oracleTotal)}
      </TableCell>
      <TableCell
        className={`text-right font-mono text-xs font-semibold ${varianceTone(
          row.variance,
          tolerance,
        )}`}
      >
        {money(row.variance)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs text-slate-600">
        {money(row.odooPayments)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs text-slate-600">
        {money(row.oracleReceipts)}
        {row.unlinkedReceiptOrders > 0 && (
          <span
            className="ml-1 text-amber-600"
            title={`${row.unlinkedReceiptOrders} order(s) had no linkable receipt, so this total is incomplete`}
          >
            *
          </span>
        )}
      </TableCell>
    </TableRow>
  );

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {showStore && <TableHead>Store</TableHead>}
              {showDate && <TableHead>Date</TableHead>}
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Problems</TableHead>
              <TableHead className="text-right">Match</TableHead>
              <TableHead className="text-right">Odoo total</TableHead>
              <TableHead className="text-right">Oracle total</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="text-right">Odoo paid</TableHead>
              <TableHead className="text-right">Oracle receipts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => totalRow(row, false))}
            {totalRow({ ...data.totals, key: '__totals__' }, true)}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-slate-400">
        Click any row to see the Odoo order references behind it.
        {data.totals.unlinkedReceiptOrders > 0 &&
          ' * receipts that could not be linked by number are excluded from the receipt column.'}
      </p>
    </div>
  );
}

function OrderDetailDialog({
  orderName,
  onClose,
}: {
  orderName: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['reconciliation-detail', orderName],
    queryFn: () => api.getReconciliationDetail(orderName!),
    enabled: orderName != null,
  });

  return (
    <Dialog open={orderName != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Odoo order {orderName}</DialogTitle>
          <DialogDescription>
            Line-by-line comparison of the Odoo source against the rows recorded
            when the order was pushed to Oracle.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
        {error && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : 'Could not load the order'}
          </p>
        )}

        {data && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={data.summary.status} />
              {data.summary.issues.map((issue) => (
                <span
                  key={issue}
                  className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                >
                  {issue}
                </span>
              ))}
            </div>

            <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs sm:grid-cols-4">
              <div>
                <div className="text-slate-500">Store</div>
                <div className="font-medium text-slate-800">
                  {storeLabel(data.summary.odoo)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Order date</div>
                <div className="font-medium text-slate-800">
                  {data.summary.odoo.orderDate?.slice(0, 10) ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Odoo order id</div>
                <div className="font-mono text-slate-800">
                  {data.summary.odoo.orderId}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Oracle invoice</div>
                <div className="font-mono text-slate-800">
                  {data.summary.oracle?.invoiceNumber ?? '—'}
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                  Odoo lines ({data.odooLines.length})
                </p>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Incl. tax</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.odooLines.map((l, i) => (
                        <TableRow key={`${l.lineId ?? 'line'}-${i}`}>
                          <TableCell className="text-xs">
                            {l.product ?? '—'}
                            {l.productCode && (
                              <span className="ml-1 text-slate-400">
                                ({l.productCode})
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs">{l.qty}</TableCell>
                          <TableCell className="text-right text-xs">
                            {money(l.subtotalIncl)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                  Oracle invoice lines ({data.oracleLines.length})
                </p>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead>Tax</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.oracleLines.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-xs text-slate-400">
                            Nothing recorded in Oracle for this order.
                          </TableCell>
                        </TableRow>
                      ) : (
                        data.oracleLines.map((l, i) => (
                          <TableRow key={`${l.lineNumber ?? 'l'}-${i}`}>
                            <TableCell className="text-xs">
                              {l.description ?? l.itemNumber ?? '—'}
                              {l.message && (
                                <span className="mt-0.5 block text-[11px] text-red-600">
                                  {l.message}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-xs">{l.qty}</TableCell>
                            <TableCell className="text-xs">{l.taxCode ?? '—'}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                  Odoo payments
                </p>
                <div className="space-y-1">
                  {data.odooPayments.length === 0 && (
                    <p className="text-xs text-slate-400">None recorded.</p>
                  )}
                  {data.odooPayments.map((p, i) => (
                    <div
                      key={`${p.paymentId ?? 'p'}-${i}`}
                      className="flex justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"
                    >
                      <span className="text-slate-600">{p.method ?? 'Payment'}</span>
                      <span className="font-mono text-slate-800">{money(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                  Oracle receipts
                </p>
                <div className="space-y-1">
                  {data.oracleReceipts.length === 0 && (
                    <p className="text-xs text-slate-400">
                      No receipt could be linked to this order number.
                    </p>
                  )}
                  {data.oracleReceipts.map((r, i) => (
                    <div
                      key={`${r.receiptNumber ?? 'r'}-${i}`}
                      className="flex justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"
                    >
                      <span className="text-slate-600">
                        {r.receiptNumber ?? r.kind}
                        <span className="ml-1 text-slate-400">({r.kind})</span>
                      </span>
                      <span className="font-mono text-slate-800">{money(r.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Odoo ↔ Oracle mismatch finder. Three roll-ups (store, day, store-day)
 * sit over one order list; clicking a roll-up row narrows the list to the Odoo
 * order references behind it without disturbing the window the roll-ups cover.
 */
export function OdooOracleTab() {
  const { selectedRegion } = useRegion();

  const [startDate, setStartDate] = useState(isoDaysAgo(7));
  const [endDate, setEndDate] = useState(isoDaysAgo(0));
  const [status, setStatus] = useState<string>('PROBLEMS');
  const [search, setSearch] = useState('');
  const [toleranceInput, setToleranceInput] = useState('0.01');
  const [page, setPage] = useState(0);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [view, setView] = useState('store');

  // A drill-down from a roll-up row. Kept separate from the window so the
  // store/day tables keep showing the whole period while the order list narrows.
  const [scope, setScope] = useState<{ store?: string; date?: string }>({});

  const tolerance = Number(toleranceInput) || 0;

  const baseQuery: ReconcileQuery = useMemo(
    () => ({
      startDate,
      endDate,
      region: selectedRegion ?? undefined,
      tolerance,
      search: search.trim() || undefined,
    }),
    [startDate, endDate, selectedRegion, tolerance, search],
  );

  const ordersQuery: ReconcileQuery = useMemo(
    () => ({
      ...baseQuery,
      // A drilled-in day replaces the window for the order list only.
      startDate: scope.date ?? baseQuery.startDate,
      endDate: scope.date ?? baseQuery.endDate,
      store: scope.store,
      status,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [baseQuery, scope, status, page],
  );

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['odoo-oracle-reconciliation', ordersQuery],
    queryFn: () => api.reconcileOdooOracle(ordersQuery),
  });

  const summary = data?.summary;

  const drill = (row: BreakdownRow) => {
    setScope({
      store: row.branchCode ?? row.branchName ?? undefined,
      date: row.date ?? undefined,
    });
    setPage(0);
    setView('orders');
  };

  const clearScope = () => {
    setScope({});
    setPage(0);
  };

  const download = async () => {
    // The export route is a plain GET, but it still needs the bearer token, so
    // it is fetched and turned into a blob rather than opened as a link.
    const url = api.reconciliationExportUrl({
      ...ordersQuery,
      limit: undefined,
      offset: 0,
    });
    const token = authStorage.getToken();
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `reconciliation-${ordersQuery.startDate}-to-${ordersQuery.endDate}.csv`;
    a.click();
    URL.revokeObjectURL(href);
  };

  if (error) {
    return (
      <ErrorState
        message={
          error instanceof Error ? error.message : 'Failed to run reconciliation'
        }
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-5 w-5 text-indigo-600" />
            Odoo ↔ Oracle comparison
          </CardTitle>
          <CardDescription>
            Every Odoo order in the window against the invoice, lines and
            receipts recorded when it was pushed to Oracle. Read-only — it never
            sends anything to either system.
            {selectedRegion
              ? ` Scoped to region ${selectedRegion}.`
              : ' All regions.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="text-xs text-slate-500">From</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  clearScope();
                }}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500">To</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  clearScope();
                }}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500">Show</label>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(0);
                }}
                className="mt-1 h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
              >
                <option value="PROBLEMS">Problems only</option>
                <option value="ALL">Everything</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500">Tolerance</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={toleranceInput}
                onChange={(e) => setToleranceInput(e.target.value)}
                className="mt-1 h-9 w-24"
                title="Currency difference treated as equal"
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <label className="text-xs text-slate-500">Search</label>
              <div className="relative mt-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  placeholder="Odoo order ref, id or invoice number"
                  className="h-9 pl-8"
                />
              </div>
            </div>
            <Button variant="outline" onClick={() => void download()} className="gap-1.5">
              <Download className="h-4 w-4" />
              CSV
            </Button>
          </div>

          {summary && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Tile
                  label="Orders compared"
                  value={summary.scanned}
                  hint={
                    summary.truncated
                      ? 'window truncated — narrow the dates'
                      : undefined
                  }
                />
                <Tile
                  label="Needing attention"
                  value={summary.problems}
                  tone={
                    summary.problems > 0
                      ? 'border-red-200 bg-red-50'
                      : 'border-emerald-200 bg-emerald-50'
                  }
                  valueTone={
                    summary.problems > 0 ? 'text-red-700' : 'text-emerald-700'
                  }
                  onClick={() => {
                    setStatus('PROBLEMS');
                    setPage(0);
                  }}
                  active={status === 'PROBLEMS'}
                />
                <Tile label="Match rate" value={`${summary.matchRate}%`} />
                <Tile
                  label="Variance (Odoo − Oracle)"
                  value={money(summary.variance)}
                  hint={`Odoo ${money(summary.odooTotal)} · Oracle ${money(summary.oracleTotal)}`}
                  valueTone={varianceTone(summary.variance, tolerance)}
                />
                <Tile
                  label="Orphans in Oracle"
                  value={summary.orphanCount}
                  hint="invoices with no Odoo order"
                  valueTone={
                    summary.orphanCount > 0 ? 'text-fuchsia-700' : 'text-slate-900'
                  }
                />
              </div>

              {summary.truncated && (
                <p className="flex items-center gap-1.5 text-xs text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  More orders exist in this window than were compared. Narrow the
                  date range for a complete picture.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Tabs value={view} onValueChange={setView}>
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="store">By store</TabsTrigger>
            <TabsTrigger value="date">By day</TabsTrigger>
            <TabsTrigger value="store-date">By store &amp; day</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
          </TabsList>

          {(scope.store || scope.date) && (
            <div className="flex items-center gap-1.5">
              {scope.store && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
                  <Store className="h-3 w-3" />
                  {scope.store}
                </span>
              )}
              {scope.date && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
                  <CalendarDays className="h-3 w-3" />
                  {scope.date}
                </span>
              )}
              <button
                onClick={clearScope}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
                title="Clear the drill-down"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            </div>
          )}
        </div>

        <TabsContent value="store" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Store className="h-5 w-5 text-indigo-600" />
                By store
              </CardTitle>
              <CardDescription>
                Every store that traded in the window, worst variance first.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BreakdownTable
                groupBy="store"
                query={baseQuery}
                tolerance={tolerance}
                onDrill={drill}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="date" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarDays className="h-5 w-5 text-indigo-600" />
                By day
              </CardTitle>
              <CardDescription>
                Every trading day in the window, across all stores.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BreakdownTable
                groupBy="date"
                query={baseQuery}
                tolerance={tolerance}
                onDrill={drill}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="store-date" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Store className="h-5 w-5 text-indigo-600" />
                By store &amp; day
              </CardTitle>
              <CardDescription>
                One row per store per trading day — the level a Z-report
                reconciles at.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BreakdownTable
                groupBy="store-date"
                query={baseQuery}
                tolerance={tolerance}
                onDrill={drill}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Odoo order references{' '}
                {data && (
                  <span className="text-sm font-normal text-slate-500">
                    ({data.pagination.total} matching)
                  </span>
                )}
              </CardTitle>
              <CardDescription>
                One row per Odoo order. Click a row for the line-by-line
                comparison.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <p className="py-8 text-center text-sm text-slate-400">Comparing…</p>
              ) : (data?.rows.length ?? 0) === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">
                  {status === 'PROBLEMS'
                    ? 'No mismatches here — Odoo and Oracle agree.'
                    : 'No orders match these filters.'}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Odoo order ref</TableHead>
                          <TableHead>Store</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Odoo total</TableHead>
                          <TableHead className="text-right">Oracle total</TableHead>
                          <TableHead className="text-right">Difference</TableHead>
                          <TableHead className="text-right">Paid / receipts</TableHead>
                          <TableHead className="text-right">Lines</TableHead>
                          <TableHead>Oracle invoice</TableHead>
                          <TableHead>Issue</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data?.rows.map((row: ReconciliationRow) => (
                          <TableRow
                            key={row.orderName}
                            className="cursor-pointer"
                            onClick={() => setOpenOrder(row.orderName)}
                          >
                            <TableCell>
                              <div className="font-medium text-slate-800">
                                {row.orderName}
                              </div>
                              <div className="font-mono text-[11px] text-slate-400">
                                id {row.odoo.orderId}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">
                              {storeLabel(row.odoo)}
                              {row.odoo.region && (
                                <span className="ml-1 text-slate-400">
                                  {row.odoo.region}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-slate-600">
                              {row.odoo.orderDate?.slice(0, 10) ?? '—'}
                            </TableCell>
                            <TableCell>
                              <StatusPill status={row.status} />
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {money(row.odoo.total)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {money(row.oracle?.total)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-mono text-xs ${
                                row.amountDifference != null &&
                                Math.abs(row.amountDifference) > tolerance
                                  ? 'font-semibold text-amber-700'
                                  : 'text-slate-500'
                              }`}
                            >
                              {money(row.amountDifference)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right font-mono text-xs text-slate-600">
                              {money(row.odoo.paymentTotal)} /{' '}
                              {row.oracle?.receiptTotal != null
                                ? money(row.oracle.receiptTotal)
                                : '?'}
                            </TableCell>
                            <TableCell className="text-right text-xs text-slate-600">
                              {row.odoo.lineCount}
                              {row.oracle ? ` / ${row.oracle.lineCount}` : ' / —'}
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">
                              {row.oracle?.invoiceNumber ?? '—'}
                            </TableCell>
                            <TableCell className="max-w-xs text-xs text-slate-500">
                              {row.issues[0] ?? '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-slate-500">
                      Showing {(data?.pagination.offset ?? 0) + 1}–
                      {(data?.pagination.offset ?? 0) + (data?.rows.length ?? 0)} of{' '}
                      {data?.pagination.total ?? 0}
                      {isFetching && ' · refreshing…'}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page === 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          (data?.pagination.offset ?? 0) + (data?.rows.length ?? 0) >=
                          (data?.pagination.total ?? 0)
                        }
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {(data?.orphans.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-fuchsia-600" />
              In Oracle, not in Odoo
            </CardTitle>
            <CardDescription>
              Invoice lines whose sales order has no stored Odoo order behind it.
              These overstate Oracle revenue rather than understating it.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sales order</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead>First seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.orphans.map((o) => (
                  <TableRow key={o.salesOrder}>
                    <TableCell className="font-medium text-slate-800">
                      {o.salesOrder}
                    </TableCell>
                    <TableCell className="text-xs">{o.invoiceNumber ?? '—'}</TableCell>
                    <TableCell className="text-xs">{o.region ?? '—'}</TableCell>
                    <TableCell className="text-right text-xs">{o.lineCount}</TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {o.firstSeen ? o.firstSeen.slice(0, 10) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <OrderDetailDialog orderName={openOrder} onClose={() => setOpenOrder(null)} />
    </div>
  );
}
