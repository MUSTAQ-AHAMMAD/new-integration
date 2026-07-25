'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  RefreshCcw,
  Globe,
  Landmark,
  Clock,
  Building2,
  Coins,
} from 'lucide-react';

/** Region → ISO currency, for splitting the mixed-currency top line. */
const REGION_CURRENCY: Record<string, string> = {
  SN: 'SAR',
  SA: 'SAR',
  AE: 'AED',
  BH: 'BHD',
  OM: 'OMR',
  KW: 'KWD',
  QA: 'QAR',
};

/**
 * Region → VAT rate, mirroring VendHqTaxMeta (the rate folded into invoices).
 * Used only for an ESTIMATE of tax posted, back-calculated from tax-inclusive
 * revenue: vat = gross × rate / (1 + rate).
 */
const REGION_VAT_RATE: Record<string, number> = {
  SN: 0.15,
  SA: 0.15,
  AE: 0.05,
  OM: 0.05,
  BH: 0.1,
  KW: 0,
  QA: 0,
};

function compact(n: number): string {
  const v = n ?? 0;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
}

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const toneText: Record<Tone, string> = {
  good: 'text-emerald-600',
  warn: 'text-amber-600',
  bad: 'text-red-600',
  neutral: 'text-slate-900',
};
const toneRing: Record<Tone, string> = {
  good: 'border-emerald-200 bg-emerald-50',
  warn: 'border-amber-200 bg-amber-50',
  bad: 'border-red-200 bg-red-50',
  neutral: 'border-slate-200 bg-white',
};

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 shadow-sm ${toneRing[tone]}`}>
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${toneText[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function ExecutiveOverview() {
  const { data } = useQuery({
    queryKey: ['executive-summary'],
    queryFn: () => api.getExecutiveSummary(),
    refetchInterval: 30_000,
  });

  if (!data) return null;
  const { revenue, orders, refunds, regions, stores, byRegion, revenueTrend, topFailures } =
    data;

  const trendMax = Math.max(1, ...revenueTrend.map((d) => d.posted));
  const topRegions = [...byRegion]
    .sort((a, b) => b.oracleRevenue - a.oracleRevenue)
    .slice(0, 5);
  const regionMax = Math.max(1, ...topRegions.map((r) => r.oracleRevenue));
  const failMax = Math.max(1, ...topFailures.map((f) => f.count));

  // Per-currency subtotals (from the per-region breakdown, each single-currency).
  const byCurrency = Object.entries(
    byRegion.reduce<Record<string, { odoo: number; oracle: number }>>(
      (acc, r) => {
        const ccy = REGION_CURRENCY[r.region] ?? r.region;
        const cur = acc[ccy] ?? { odoo: 0, oracle: 0 };
        cur.odoo += r.odooRevenue;
        cur.oracle += r.oracleRevenue;
        acc[ccy] = cur;
        return acc;
      },
      {},
    ),
  ).sort(([, a], [, b]) => b.oracle - a.oracle);

  const momUp = data.revenueMoM.growthPct >= 0;

  // Estimated VAT posted, back-calculated from tax-inclusive Oracle revenue per
  // region at that region's known rate. Labelled "est." — it is derived, not a
  // stored tax figure.
  const vatEstimate = byRegion.reduce((sum, r) => {
    const rate = REGION_VAT_RATE[r.region] ?? 0;
    return rate > 0 ? sum + (r.oracleRevenue * rate) / (1 + rate) : sum;
  }, 0);

  const completenessTone: Tone =
    revenue.completenessPct >= 95
      ? 'good'
      : revenue.completenessPct >= 80
        ? 'warn'
        : 'bad';
  const riskTone: Tone = orders.valueAtRisk > 0 ? 'bad' : 'good';
  const staleTone: Tone = regions.stale > 0 ? 'warn' : 'good';

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
            Executive Overview
          </h2>
          <p className="text-xs text-slate-500">
            Revenue reaching the ERP, money at risk, and coverage across regions
          </p>
        </div>
        <span className="text-xs text-slate-400">
          {new Date(data.generatedAt).toLocaleTimeString()}
        </span>
      </div>

      {/* Revenue-completeness headline */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-gradient-to-r from-slate-50 to-white p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Revenue reaching Oracle
            </div>
            <div className={`text-4xl font-black ${toneText[completenessTone]}`}>
              {revenue.completenessPct}%
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {compact(revenue.oraclePosted)} of {compact(revenue.odooFetched)}{' '}
              posted · <span className="font-semibold text-red-600">
                {compact(revenue.gap)} not yet in Oracle
              </span>
            </div>
          </div>
          <div className="text-right text-xs text-slate-500">
            <div className="text-lg font-bold text-slate-900">
              {compact(revenue.oraclePosted30d)}
            </div>
            posted last 30 days
          </div>
        </div>
        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full rounded-full ${
              completenessTone === 'good'
                ? 'bg-emerald-500'
                : completenessTone === 'warn'
                  ? 'bg-amber-500'
                  : 'bg-red-500'
            }`}
            style={{ width: `${Math.min(100, revenue.completenessPct)}%` }}
          />
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi
          icon={AlertTriangle}
          label="Value at risk"
          value={compact(orders.valueAtRisk)}
          sub={`${orders.pending + orders.failed} stuck · oldest ${
            orders.oldestPendingHours != null
              ? `${orders.oldestPendingHours}h`
              : '—'
          }`}
          tone={riskTone}
        />
        <Kpi
          icon={TrendingUp}
          label="Order sync"
          value={`${orders.syncedPct}%`}
          sub={`${compact(orders.synced)} / ${compact(orders.fetched)} fetched`}
          tone={
            orders.syncedPct >= 95 ? 'good' : orders.syncedPct >= 70 ? 'warn' : 'bad'
          }
        />
        <Kpi
          icon={RefreshCcw}
          label="Refund exposure"
          value={compact(refunds.pendingValue)}
          sub={`${refunds.pendingCount} credit memo(s) pending`}
          tone={refunds.pendingCount > 0 ? 'warn' : 'good'}
        />
        <Kpi
          icon={Globe}
          label="Regions current"
          value={`${regions.current}/${regions.total}`}
          sub={regions.stale > 0 ? `${regions.stale} stale (>24h)` : 'all fresh'}
          tone={staleTone}
        />
        <Kpi
          icon={Clock}
          label="Backlog age"
          value={
            orders.oldestPendingHours != null
              ? `${orders.oldestPendingHours}h`
              : '—'
          }
          sub={`${compact(orders.pending)} pending`}
          tone={
            (orders.oldestPendingHours ?? 0) > 24
              ? 'bad'
              : (orders.oldestPendingHours ?? 0) > 6
                ? 'warn'
                : 'good'
          }
        />
        <Kpi
          icon={Building2}
          label="Stores to review"
          value={compact(stores.needsReview)}
          sub={`${compact(stores.active)} active`}
          tone={stores.needsReview > 0 ? 'warn' : 'good'}
        />
        <Kpi
          icon={momUp ? TrendingUp : TrendingDown}
          label="Revenue MoM"
          value={`${momUp ? '+' : ''}${data.revenueMoM.growthPct}%`}
          sub={`${compact(data.revenueMoM.thisMonth)} vs ${compact(
            data.revenueMoM.lastMonth,
          )} last mo`}
          tone={momUp ? 'good' : 'bad'}
        />
        <Kpi
          icon={Coins}
          label="VAT posted (est.)"
          value={compact(vatEstimate)}
          sub="from tax-inclusive revenue"
          tone="neutral"
        />
      </div>

      {/* Per-currency subtotals — honest split of the mixed-currency top line */}
      {byCurrency.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600">
            <Coins className="h-3.5 w-3.5" />
            Revenue by currency (Odoo → Oracle)
          </div>
          <div className="flex flex-wrap gap-2">
            {byCurrency.map(([ccy, v]) => (
              <div
                key={ccy}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
              >
                <span className="font-bold text-slate-800">{ccy}</span>{' '}
                <span className="text-slate-500">
                  {compact(v.odoo)} → {compact(v.oracle)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trend · Top regions · Failure taxonomy */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Revenue trend (14d) */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-xs font-semibold text-slate-600">
            Oracle revenue · last 14 days
          </div>
          <div className="flex h-20 items-end gap-1">
            {revenueTrend.map((d) => (
              <div
                key={d.date}
                className="group relative flex-1"
                title={`${d.date}: ${compact(d.posted)}`}
              >
                <div
                  className="w-full rounded-sm bg-indigo-500/80 transition-all group-hover:bg-indigo-600"
                  style={{
                    height: `${Math.max(2, (d.posted / trendMax) * 72)}px`,
                  }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-400">
            <span>{revenueTrend[0]?.date.slice(5)}</span>
            <span>{revenueTrend[revenueTrend.length - 1]?.date.slice(5)}</span>
          </div>
        </div>

        {/* Top regions by Oracle revenue */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-xs font-semibold text-slate-600">
            Top regions by revenue
          </div>
          {topRegions.length === 0 ? (
            <p className="text-xs text-slate-400">No revenue yet.</p>
          ) : (
            <div className="space-y-1.5">
              {topRegions.map((r) => (
                <div key={r.region} className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 font-medium text-slate-700">
                    {r.region}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{
                        width: `${(r.oracleRevenue / regionMax) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right tabular-nums text-slate-600">
                    {compact(r.oracleRevenue)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Failure taxonomy */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-xs font-semibold text-slate-600">
            Top failure reasons
          </div>
          {topFailures.length === 0 ? (
            <p className="text-xs text-emerald-600">No unresolved failures 🎉</p>
          ) : (
            <div className="space-y-1.5">
              {topFailures.map((f) => (
                <div key={f.reason} className="flex items-center gap-2 text-xs">
                  <span
                    className="w-28 shrink-0 truncate font-medium text-slate-700"
                    title={f.reason}
                  >
                    {f.reason}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-red-500"
                      style={{ width: `${(f.count / failMax) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right tabular-nums text-slate-600">
                    {f.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
        <Landmark className="h-3 w-3" />
        Top-line amounts are summed across regions (mixed currency) as an
        indicative figure — see Region Status for per-region, single-currency
        detail.
      </p>
    </section>
  );
}
