'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, RegionStatusRow } from '@/lib/api';
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Download,
  Store,
} from 'lucide-react';
import { downloadCsv } from '@/lib/table-export';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

function formatWhen(iso: string | null): { label: string; stale: boolean } {
  if (!iso) return { label: '—', stale: true };
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const hours = ms / 3_600_000;
  const rel =
    hours < 1
      ? `${Math.max(1, Math.round(ms / 60_000))}m ago`
      : hours < 48
        ? `${Math.round(hours)}h ago`
        : `${Math.round(hours / 24)}d ago`;
  return { label: `${d.toLocaleString()} · ${rel}`, stale: hours > 24 };
}

function WhenCell({ iso }: { iso: string | null }) {
  const { label, stale } = formatWhen(iso);
  return (
    <span className={stale ? 'text-amber-600' : 'text-slate-700'}>{label}</span>
  );
}

export default function RegionStatusPage() {
  const {
    data: rows = [],
    isFetching,
    refetch,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['region-status'],
    queryFn: () => api.getRegionStatus(),
    refetchInterval: 30_000,
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.ordersFetched += r.ordersFetched;
      acc.odooRevenue += r.odooRevenue;
      acc.invoicesPushed += r.invoicesPushed;
      acc.oracleRevenue += r.oracleRevenue;
      acc.failedOrders += r.failedOrders;
      return acc;
    },
    {
      ordersFetched: 0,
      odooRevenue: 0,
      invoicesPushed: 0,
      oracleRevenue: 0,
      failedOrders: 0,
    },
  );

  // Store-wise revenue (from the Odoo backup) with a search filter + CSV export.
  const { data: storeRevenue = [] } = useQuery({
    queryKey: ['store-revenue'],
    queryFn: () => api.getStoreRevenue(),
    refetchInterval: 60_000,
  });
  const [storeSearch, setStoreSearch] = useState('');
  const filteredStores = useMemo(() => {
    const q = storeSearch.trim().toLowerCase();
    if (!q) return storeRevenue;
    return storeRevenue.filter(
      (s) =>
        s.store.toLowerCase().includes(q) ||
        s.region.toLowerCase().includes(q),
    );
  }, [storeRevenue, storeSearch]);
  const exportStores = () =>
    downloadCsv(
      'store-revenue.csv',
      [
        { key: 'store', label: 'Store' },
        { key: 'region', label: 'Region' },
        { key: 'orders', label: 'Orders' },
        { key: 'odooRevenue', label: 'Odoo revenue' },
      ],
      filteredStores as unknown as Record<string, unknown>[],
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">Region Status</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Every region at a glance — last Odoo pull, last Oracle push, orders
            fetched vs. invoices posted, revenue on each side, and failures.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw
            className={`mr-1 h-3 w-3 ${isFetching ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-5 w-5 text-indigo-600" />
              Per-region overview
            </CardTitle>
            <CardDescription>
              Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">
              No region data yet. Run an Integration Run or a pull to populate.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Region</th>
                    <th className="px-3 py-2">Odoo</th>
                    <th className="px-3 py-2">Last Odoo sync</th>
                    <th className="px-3 py-2">Last Oracle push</th>
                    <th className="px-3 py-2 text-right">Orders fetched</th>
                    <th className="px-3 py-2 text-right">Odoo revenue</th>
                    <th className="px-3 py-2 text-right">Invoices pushed</th>
                    <th className="px-3 py-2 text-right">Oracle revenue</th>
                    <th className="px-3 py-2 text-right">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: RegionStatusRow) => (
                    <tr key={r.region} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-semibold text-slate-900">
                        {r.region}
                      </td>
                      <td className="px-3 py-2">
                        {r.odooActive ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" /> active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-slate-400">
                            <XCircle className="h-3.5 w-3.5" /> inactive
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <WhenCell iso={r.lastOdooSync} />
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <WhenCell iso={r.lastOraclePush} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.ordersFetched.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMoney(r.odooRevenue)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.invoicesPushed.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMoney(r.oracleRevenue)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${
                          r.failedOrders > 0 ? 'text-red-600' : 'text-slate-400'
                        }`}
                      >
                        {r.failedOrders}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                    <td className="px-3 py-2" colSpan={4}>
                      All regions
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {totals.ordersFetched.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(totals.odooRevenue)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {totals.invoicesPushed.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(totals.oracleRevenue)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600">
                      {totals.failedOrders}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Amber timestamps are more than 24h old. &quot;Odoo revenue&quot; is
            net of refunds (Σ order totals); &quot;Oracle revenue&quot; sums
            successfully posted invoice totals.
          </p>
        </CardContent>
      </Card>

      {/* Store-wise revenue */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Store className="h-5 w-5 text-indigo-600" />
              Revenue by store
            </CardTitle>
            <div className="flex items-center gap-2">
              <Input
                value={storeSearch}
                onChange={(e) => setStoreSearch(e.target.value)}
                placeholder="Search store or region…"
                className="h-8 w-56 text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={exportStores}
                disabled={filteredStores.length === 0}
              >
                <Download className="mr-1 h-3 w-3" />
                Export CSV
              </Button>
            </div>
          </div>
          <CardDescription>
            From the Odoo backup — all pulled orders, sorted by revenue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredStores.length === 0 ? (
            <p className="text-sm text-slate-500">No store revenue yet.</p>
          ) : (
            <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Store</th>
                    <th className="px-3 py-2">Region</th>
                    <th className="px-3 py-2 text-right">Orders</th>
                    <th className="px-3 py-2 text-right">Odoo revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStores.map((s, i) => (
                    <tr
                      key={`${s.store}-${s.region}-${i}`}
                      className="border-t border-slate-100"
                    >
                      <td className="px-3 py-2 font-medium text-slate-800">
                        {s.store}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{s.region}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {s.orders.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMoney(s.odooRevenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">
            Showing {filteredStores.length} of {storeRevenue.length} store(s).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
