'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export interface SeriesDef {
  key: string;
  label: string;
}

interface ReportChartProps {
  rows: Array<Record<string, unknown>>;
  /** Category axis field (first group-by dimension). */
  xKey: string;
  /** Optional second dimension — pivots into one series per distinct value. */
  seriesKey?: string;
  /** Measures to plot when not pivoting by a second dimension. */
  measures: SeriesDef[];
  chartType: ChartType;
}

// Palette tuned to the dashboard's indigo/violet/emerald identity.
const PALETTE = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#10b981',
  '#f59e0b',
  '#0ea5e9',
  '#ef4444',
  '#14b8a6',
  '#a855f7',
  '#84cc16',
];

const tooltipStyle = {
  borderRadius: '12px',
  border: '1px solid #e2e8f0',
  fontSize: '12px',
  boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.15)',
  background: 'white',
} as const;

function truncate(v: unknown): string {
  const s = v == null || v === '' ? '—' : String(v);
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

/** Pivots rows into one series per distinct seriesKey value (first measure). */
function pivot(
  rows: Array<Record<string, unknown>>,
  xKey: string,
  seriesKey: string,
  valueKey: string,
): { data: Array<Record<string, unknown>>; series: SeriesDef[] } {
  const seriesValues = [
    ...new Set(rows.map((r) => String(r[seriesKey] ?? '—'))),
  ].slice(0, 10);
  const byX = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const x = String(r[xKey] ?? '—');
    const s = String(r[seriesKey] ?? '—');
    if (!byX.has(x)) byX.set(x, { [xKey]: x });
    const bucket = byX.get(x)!;
    bucket[s] = (Number(bucket[s]) || 0) + (Number(r[valueKey]) || 0);
  }
  return {
    data: [...byX.values()],
    series: seriesValues.map((s) => ({ key: s, label: s })),
  };
}

export function ReportChart({
  rows,
  xKey,
  seriesKey,
  measures,
  chartType,
}: ReportChartProps) {
  if (!rows.length) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-slate-400">
        No data to plot for the current filters.
      </div>
    );
  }

  const usePivot = !!seriesKey && measures.length > 0;
  const { data, series } = usePivot
    ? pivot(rows, xKey, seriesKey!, measures[0].key)
    : { data: rows, series: measures };

  const commonAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
      <XAxis
        dataKey={xKey}
        tickFormatter={truncate}
        tick={{ fontSize: 11, fill: '#94a3b8' }}
        axisLine={false}
        tickLine={false}
        interval="preserveStartEnd"
        angle={data.length > 8 ? -25 : 0}
        textAnchor={data.length > 8 ? 'end' : 'middle'}
        height={data.length > 8 ? 60 : 30}
      />
      <YAxis
        tick={{ fontSize: 11, fill: '#94a3b8' }}
        axisLine={false}
        tickLine={false}
      />
      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#f8fafc' }} />
      <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
    </>
  );

  if (chartType === 'pie') {
    const measure = measures[0];
    const pieData = data.map((r) => ({
      name: String(r[xKey] ?? '—'),
      value: Number(r[measure?.key]) || 0,
    }));
    return (
      <ResponsiveContainer width="100%" height={320}>
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={110}
            innerRadius={55}
            paddingAngle={2}
            label={(e) => truncate((e as { name?: string }).name)}
            labelLine={false}
          >
            {pieData.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'line') {
    return (
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          {commonAxes}
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.4} />
                <stop offset="100%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          {commonAxes}
          {series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2.5}
              fill={`url(#grad-${i})`}
              stackId={usePivot ? '1' : undefined}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // Bar (default)
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        {commonAxes}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={PALETTE[i % PALETTE.length]}
            radius={[6, 6, 0, 0]}
            maxBarSize={56}
            stackId={usePivot ? '1' : undefined}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
