'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, IntegrationRunJob, IntegrationRunOutcome } from '@/lib/api';
import { toast } from 'sonner';
import {
  Activity,
  CheckCircle2,
  Download,
  FileText,
  Play,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { downloadCsv } from '@/lib/table-export';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';

const PHASES = ['PULL', 'POST', 'DONE'] as const;

type ResultSortKey =
  | 'store'
  | 'day'
  | 'type'
  | 'status'
  | 'amount'
  | 'orders'
  | 'lines';

function resultSortVal(
  r: IntegrationRunOutcome,
  key: ResultSortKey,
): string | number {
  switch (key) {
    case 'store':
      return (r.branchName ?? r.branchCode ?? '').toLowerCase();
    case 'day':
      return r.businessDay ?? '';
    case 'type':
      return r.customerType ?? '';
    case 'status':
      return r.status ?? '';
    case 'amount':
      return r.invoiceAmount ?? 0;
    case 'orders':
      return r.sourceOrderCount ?? 0;
    case 'lines':
      return r.invoiceLineCount ?? 0;
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'PULL':
      return '1 · Pulling Odoo orders';
    case 'POST':
      return '2 · Posting Oracle invoices + cycle';
    case 'DONE':
      return '3 · Finished';
    default:
      return 'Queued';
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case 'COMPLETED':
    case 'CREATED':
    case 'SUCCESS':
      return 'bg-emerald-100 text-emerald-700';
    case 'FAILED':
      return 'bg-red-100 text-red-700';
    case 'PARTIAL':
      return 'bg-amber-100 text-amber-700';
    case 'PROCESSING':
      return 'bg-indigo-100 text-indigo-700';
    case 'SKIPPED':
      return 'bg-slate-100 text-slate-600';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function formatMoney(value: number, currency = 'AED'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('en-US', {
      maximumFractionDigits: 2,
    })}`;
  }
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: 'good' | 'bad' | 'neutral' }) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'bad'
        ? 'text-red-600'
        : 'text-slate-900';
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default function IntegrationRunPage() {
  const queryClient = useQueryClient();
  const [region, setRegion] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Results table controls (search / status filter / sort).
  const [resultSearch, setResultSearch] = useState('');
  const [resultStatus, setResultStatus] = useState('ALL');
  const [sortKey, setSortKey] = useState<ResultSortKey>('store');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Regions come from the configured Odoo credentials (the pull source).
  const { data: credentials = [] } = useQuery({
    queryKey: ['odoo-credentials'],
    queryFn: () => api.listOdooCredentials(),
  });
  const regions = useMemo(
    () =>
      [...new Set(credentials.filter((c) => c.active).map((c) => c.region))].sort(),
    [credentials],
  );

  const { data: recentRuns = [] } = useQuery({
    queryKey: ['integration-runs'],
    queryFn: () => api.listIntegrationRuns(10),
    refetchInterval: 10_000,
  });

  const { data: run } = useQuery({
    queryKey: ['integration-run', activeRunId],
    queryFn: () => api.getIntegrationRun(activeRunId as string),
    enabled: !!activeRunId,
    // Poll fast while the run is live; the 'integrationRun' websocket event
    // additionally invalidates this query for instant updates.
    refetchInterval: (q) => {
      const status = (q.state.data as IntegrationRunJob | undefined)?.status;
      return status === 'PROCESSING' || status === 'PENDING' ? 2_000 : false;
    },
  });

  const startMutation = useMutation({
    mutationFn: () =>
      api.startIntegrationRun({ region, startDate, endDate }),
    onSuccess: (job) => {
      toast.success(`Integration run started for ${region} (${startDate} → ${endDate})`);
      setActiveRunId(job.id);
      void queryClient.invalidateQueries({ queryKey: ['integration-runs'] });
    },
    onError: (e: Error) => toast.error(`Could not start run: ${e.message}`),
  });

  // Run every active region at once (they execute concurrently, per-region).
  const startAllMutation = useMutation({
    mutationFn: () => api.startIntegrationRunAll({ startDate, endDate }),
    onSuccess: (res) => {
      if (res.started.length > 0) {
        toast.success(
          `Started ${res.started.length} region(s): ${res.started
            .map((s) => s.region)
            .join(', ')}` +
            (res.skipped.length
              ? ` · skipped ${res.skipped.length}`
              : ''),
        );
        setActiveRunId(res.started[0].jobId);
      } else {
        toast.error(
          `No runs started${res.skipped.length ? ` — ${res.skipped[0].reason}` : ''}`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['integration-runs'] });
    },
    onError: (e: Error) => toast.error(`Could not start runs: ${e.message}`),
  });

  const scope = run?.scopeValue;
  const isLive = run?.status === 'PROCESSING' || run?.status === 'PENDING';
  const progressPct = scope
    ? Math.round(
        (scope.post.daysDone / Math.max(scope.post.daysPlanned, 1)) * 100,
      )
    : 0;
  const failedResults = (scope?.results ?? []).filter(
    (r) => r.status === 'FAILED',
  );

  // Revenue = net value of the invoices actually created this run. Skipped
  // (already-posted) and failed groups do not count toward the day's revenue.
  const createdResults = (scope?.results ?? []).filter(
    (r) => r.status === 'CREATED',
  );
  const currency =
    (scope?.results ?? []).find((r) => r.currencyCode)?.currencyCode ?? 'AED';
  const totalRevenue = createdResults.reduce(
    (sum, r) => sum + (r.invoiceAmount ?? 0),
    0,
  );
  // Per-business-day revenue, sorted by day, for the summary breakdown.
  const revenueByDay = Object.entries(
    createdResults.reduce<Record<string, number>>((acc, r) => {
      acc[r.businessDay] = (acc[r.businessDay] ?? 0) + (r.invoiceAmount ?? 0);
      return acc;
    }, {}),
  ).sort(([a], [b]) => a.localeCompare(b));

  // Search + status filter + sort over the results table.
  const displayResults = useMemo(() => {
    let out = scope?.results ?? [];
    const q = resultSearch.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        [
          r.branchName,
          r.branchCode,
          r.customerType,
          r.status,
          r.transactionNumber,
          r.businessDay,
          r.error,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    if (resultStatus !== 'ALL') {
      out = out.filter((r) => r.status === resultStatus);
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...out].sort((a, b) => {
      const av = resultSortVal(a, sortKey);
      const bv = resultSortVal(b, sortKey);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [scope?.results, resultSearch, resultStatus, sortKey, sortDir]);

  const toggleSort = (key: ResultSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const exportResults = () => {
    const columns = [
      { key: 'store', label: 'Store' },
      { key: 'branchCode', label: 'Branch code' },
      { key: 'day', label: 'Day' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'invoice', label: 'Invoice #' },
      { key: 'amount', label: 'Amount' },
      { key: 'currency', label: 'Currency' },
      { key: 'orders', label: 'Orders' },
      { key: 'lines', label: 'Lines' },
      { key: 'receipts', label: 'Receipts' },
      { key: 'journals', label: 'Journals' },
      { key: 'invTxns', label: 'Inv. txns' },
      { key: 'detail', label: 'Detail' },
    ];
    const rows = displayResults.map((r) => ({
      store: r.branchName ?? r.branchCode,
      branchCode: r.branchCode,
      day: r.businessDay,
      type: r.customerType,
      status: r.status,
      invoice: r.transactionNumber ?? '',
      amount: r.invoiceAmount ?? '',
      currency: r.currencyCode ?? '',
      orders: r.sourceOrderCount,
      lines: r.invoiceLineCount,
      receipts: r.standardReceipts + r.miscReceipts,
      journals: r.journals,
      invTxns: r.inventoryTransactions ?? 0,
      detail:
        r.error ??
        (r.excludedOrders?.length
          ? `${r.excludedOrders.length} order(s) held`
          : ''),
    }));
    downloadCsv(
      `integration-run-${scope?.region ?? 'run'}-${scope?.startDate ?? ''}.csv`,
      columns,
      rows,
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Integration Run</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Pull Odoo orders for a region and date range, then post one Oracle
            invoice per store per day with the complete cycle — receipts,
            applications, journals and inventory — with live progress.
          </p>
        </div>
      </div>

      {/* ── Start form ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Play className="h-5 w-5 text-indigo-600" />
            Start a run
          </CardTitle>
          <CardDescription>
            Runs are safe to repeat — days already posted to Oracle are skipped
            line-by-line, never duplicated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="run-region">Region</Label>
              <select
                id="run-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">— select region —</option>
                {regions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {regions.length === 0 && (
                <p className="mt-1 text-xs text-slate-400">
                  No active Odoo credentials. Add one via{' '}
                  <a href="/admin/odoo-credentials" className="underline">
                    Admin → Odoo Credentials
                  </a>
                  .
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="run-start">From (business day)</Label>
              <Input
                id="run-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="run-end">To (business day)</Label>
              <Input
                id="run-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                className="flex-1"
                disabled={
                  !region || !startDate || !endDate || startMutation.isPending
                }
                onClick={() => startMutation.mutate()}
              >
                <Play
                  className={`mr-2 h-4 w-4 ${startMutation.isPending ? 'animate-pulse' : ''}`}
                />
                Start
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={!startDate || !endDate || startAllMutation.isPending}
                onClick={() => startAllMutation.mutate()}
                title="Start a concurrent run for every active region"
              >
                <Play
                  className={`mr-2 h-4 w-4 ${startAllMutation.isPending ? 'animate-pulse' : ''}`}
                />
                All regions
              </Button>
            </div>
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Different regions run at the same time — you no longer have to wait
            for one to finish. To run the integration on a schedule, enable{' '}
            <a href="/admin/sync-control" className="underline">
              Automatic Integration per region
            </a>{' '}
            in the Sync Control Center.
          </p>
        </CardContent>
      </Card>

      {/* ── Live monitor ───────────────────────────────────────────────── */}
      {run && scope && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity
                  className={`h-5 w-5 text-indigo-600 ${isLive ? 'animate-pulse' : ''}`}
                />
                {scope.region} · {scope.startDate} → {scope.endDate}
              </CardTitle>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusBadge(run.status)}`}
              >
                {run.status}
              </span>
            </div>
            <CardDescription>
              Run {run.id} · started{' '}
              {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Phase stepper */}
            <div className="flex items-center gap-2">
              {PHASES.map((p, i) => {
                const reached =
                  PHASES.indexOf(scope.phase as (typeof PHASES)[number]) >= i ||
                  scope.phase === 'DONE';
                const current = scope.phase === p && isLive;
                return (
                  <div key={p} className="flex items-center gap-2">
                    {i > 0 && <div className="h-px w-8 bg-slate-300" />}
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        current
                          ? 'bg-indigo-600 text-white'
                          : reached
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {phaseLabel(p)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Day progress */}
            <div>
              <div className="mb-1 flex justify-between text-xs text-slate-500">
                <span>
                  Business days posted: {scope.post.daysDone}/{scope.post.daysPlanned}
                </span>
                <span>{progressPct}%</span>
              </div>
              <Progress value={progressPct} />
            </div>

            {/* Counters */}
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile
                label="Orders pulled from Odoo"
                value={Math.max(scope.pull.ingested, scope.pull.saved)}
              />
              <StatTile
                label="Invoices created"
                value={scope.post.invoicesCreated}
                tone="good"
              />
              <StatTile
                label="Invoices failed"
                value={scope.post.invoicesFailed}
                tone={scope.post.invoicesFailed > 0 ? 'bad' : 'neutral'}
              />
              <StatTile
                label="Receipts (std + misc)"
                value={`${scope.post.standardReceipts} + ${scope.post.miscReceipts}`}
              />
              <StatTile label="GL journals" value={scope.post.journals} />
              <StatTile
                label="Inventory transactions"
                value={scope.post.inventoryTransactions}
              />
            </div>

            {/* Revenue summary */}
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                    Total revenue invoiced{' '}
                    {scope.startDate === scope.endDate
                      ? `· ${scope.startDate}`
                      : `· ${scope.startDate} → ${scope.endDate}`}
                  </div>
                  <div className="mt-0.5 text-3xl font-bold text-emerald-700">
                    {formatMoney(totalRevenue, currency)}
                  </div>
                </div>
                <div className="text-xs text-emerald-700/80">
                  across {createdResults.length} invoice(s)
                </div>
              </div>
              {revenueByDay.length > 1 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {revenueByDay.map(([day, amount]) => (
                    <span
                      key={day}
                      className="rounded-full bg-white px-3 py-1 text-xs font-medium text-emerald-700 shadow-sm"
                    >
                      {day}: {formatMoney(amount, currency)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Live event log */}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Live log
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-slate-950 p-3 font-mono text-xs text-slate-200">
                {scope.events.length === 0 && (
                  <div className="text-slate-500">Waiting for events…</div>
                )}
                {scope.events.map((e, i) => (
                  <div key={i} className="whitespace-pre-wrap">
                    <span className="text-slate-500">
                      {new Date(e.at).toLocaleTimeString()}
                    </span>{' '}
                    <span className="text-indigo-400">[{e.phase}]</span>{' '}
                    {e.message}
                  </div>
                ))}
              </div>
            </div>

            {/* Per store/day results */}
            {scope.results.length > 0 && (
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Oracle results
                  </span>
                  <div className="flex-1" />
                  <Input
                    value={resultSearch}
                    onChange={(e) => setResultSearch(e.target.value)}
                    placeholder="Search store, code, invoice…"
                    className="h-8 w-56 text-sm"
                  />
                  <select
                    value={resultStatus}
                    onChange={(e) => setResultStatus(e.target.value)}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="ALL">All statuses</option>
                    <option value="CREATED">Created</option>
                    <option value="SKIPPED">Skipped</option>
                    <option value="FAILED">Failed</option>
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportResults}
                    disabled={displayResults.length === 0}
                  >
                    <Download className="mr-1 h-3 w-3" />
                    Export CSV
                  </Button>
                </div>
                <div className="mb-1 text-xs text-slate-400">
                  Showing {displayResults.length} of {scope.results.length}{' '}
                  row(s)
                </div>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500">
                      <tr>
                        {(
                          [
                            ['store', 'Store', ''],
                            ['day', 'Day', ''],
                            ['type', 'Type', ''],
                            ['status', 'Status', ''],
                          ] as [ResultSortKey, string, string][]
                        ).map(([key, label]) => (
                          <th
                            key={key}
                            className="cursor-pointer select-none px-3 py-2 hover:text-slate-700"
                            onClick={() => toggleSort(key)}
                          >
                            {label}
                            {sortKey === key
                              ? sortDir === 'asc'
                                ? ' ▲'
                                : ' ▼'
                              : ''}
                          </th>
                        ))}
                        <th className="px-3 py-2">Invoice #</th>
                        <th
                          className="cursor-pointer select-none px-3 py-2 text-right hover:text-slate-700"
                          onClick={() => toggleSort('amount')}
                        >
                          Amount
                          {sortKey === 'amount'
                            ? sortDir === 'asc'
                              ? ' ▲'
                              : ' ▼'
                            : ''}
                        </th>
                        <th
                          className="cursor-pointer select-none px-3 py-2 text-right hover:text-slate-700"
                          onClick={() => toggleSort('orders')}
                        >
                          Orders
                          {sortKey === 'orders'
                            ? sortDir === 'asc'
                              ? ' ▲'
                              : ' ▼'
                            : ''}
                        </th>
                        <th className="px-3 py-2 text-right">Lines</th>
                        <th className="px-3 py-2 text-right">Receipts</th>
                        <th className="px-3 py-2 text-right">Journals</th>
                        <th className="px-3 py-2 text-right">Inv. txns</th>
                        <th className="px-3 py-2">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayResults.map((r: IntegrationRunOutcome, i) => (
                        <tr key={`${r.groupKey}-${i}`} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium">
                            <div>{r.branchName ?? r.branchCode}</div>
                            {r.branchName && (
                              <div className="text-xs font-normal text-slate-400">
                                {r.branchCode}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2">{r.businessDay}</td>
                          <td className="px-3 py-2">{r.customerType}</td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(r.status)}`}
                            >
                              {r.status === 'CREATED' ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : r.status === 'FAILED' ? (
                                <XCircle className="h-3 w-3" />
                              ) : null}
                              {r.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {r.transactionNumber ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">
                            {r.status === 'CREATED' && r.invoiceAmount != null
                              ? formatMoney(r.invoiceAmount, r.currencyCode ?? currency)
                              : '—'}
                          </td>
                          <td className="px-3 py-2 text-right">{r.sourceOrderCount}</td>
                          <td className="px-3 py-2 text-right">{r.invoiceLineCount}</td>
                          <td className="px-3 py-2 text-right">
                            {r.standardReceipts + r.miscReceipts}
                          </td>
                          <td className="px-3 py-2 text-right">{r.journals}</td>
                          <td className="px-3 py-2 text-right">
                            {r.inventoryTransactions ?? 0}
                          </td>
                          <td className="max-w-md px-3 py-2 text-xs text-slate-500">
                            {r.error ??
                              (r.excludedOrders?.length
                                ? `${r.excludedOrders.length} order(s) held: ${r.excludedOrders
                                    .map((e) => e.orderNumber)
                                    .join(', ')}`
                                : '')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                        <td className="px-3 py-2" colSpan={5}>
                          Total revenue ({createdResults.length} invoice
                          {createdResults.length === 1 ? '' : 's'})
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                          {formatMoney(totalRevenue, currency)}
                        </td>
                        <td className="px-3 py-2" colSpan={6} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {failedResults.length > 0 && (
                  <p className="mt-2 text-xs text-red-600">
                    {failedResults.length} group(s) failed — fix the reported
                    cause and re-run the same range; posted days are skipped
                    automatically.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Recent runs ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-5 w-5 text-indigo-600" />
            Recent runs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-slate-500">No integration runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Region</th>
                    <th className="px-3 py-2">Range</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Invoices ✓</th>
                    <th className="px-3 py-2 text-right">Failed</th>
                    <th className="px-3 py-2">Started</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((j) => {
                    const s = j.scopeValue;
                    return (
                      <tr key={j.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium">{s?.region ?? '—'}</td>
                        <td className="px-3 py-2">
                          {s ? `${s.startDate} → ${s.endDate}` : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(j.status)}`}
                          >
                            {j.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">{j.successCount}</td>
                        <td className="px-3 py-2 text-right">{j.failedCount}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">
                          {new Date(j.createdAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setActiveRunId(j.id)}
                          >
                            <RefreshCw className="mr-1 h-3 w-3" />
                            View
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
