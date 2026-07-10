'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  api,
  type ReportDataset,
  type ReportFieldMeta,
  type ReportFilter,
  type ReportFilterOp,
  type ReportMeasure,
  type ReportMeasureFn,
  type ReportQueryDto,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ReportChart, type ChartType } from '@/components/reports/report-chart';
import {
  AreaChart,
  BarChart3,
  Download,
  Filter,
  LineChart,
  Loader2,
  PieChart,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Table2,
  Trash2,
  X,
} from 'lucide-react';

// ── Small styled primitives ──────────────────────────────────────────────────

const selectCls =
  'h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-700 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';
const inputCls =
  'h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-700 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400';

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
      {children}
    </label>
  );
}

// ── Operator metadata ────────────────────────────────────────────────────────

const OP_LABELS: Record<ReportFilterOp, string> = {
  eq: 'equals',
  ne: 'not equals',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contains',
  startsWith: 'starts with',
  in: 'in (list)',
  between: 'between',
  isNull: 'is empty',
};

function opsForField(f: ReportFieldMeta): ReportFilterOp[] {
  switch (f.role) {
    case 'measure':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull'];
    case 'date':
      return ['gte', 'lte', 'between'];
    case 'boolean':
      return ['eq'];
    default:
      return ['eq', 'ne', 'contains', 'startsWith', 'in', 'isNull'];
  }
}

const MEASURE_FNS: { fn: ReportMeasureFn; label: string }[] = [
  { fn: 'count', label: 'Count' },
  { fn: 'sum', label: 'Sum' },
  { fn: 'avg', label: 'Average' },
  { fn: 'min', label: 'Min' },
  { fn: 'max', label: 'Max' },
];

const CHART_TYPES: { type: ChartType | 'table'; label: string; icon: React.ElementType }[] = [
  { type: 'bar', label: 'Bar', icon: BarChart3 },
  { type: 'line', label: 'Line', icon: LineChart },
  { type: 'area', label: 'Area', icon: AreaChart },
  { type: 'pie', label: 'Pie', icon: PieChart },
  { type: 'table', label: 'Table', icon: Table2 },
];

const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
function fmt(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return numberFmt.format(v);
  const s = String(v);
  // ISO date → short date
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 19).replace('T', ' ');
  return s;
}

function measureAlias(m: ReportMeasure): string {
  return m.fn === 'count' ? 'count' : `${m.fn}_${m.field}`;
}
function measureLabel(m: ReportMeasure, fields: ReportFieldMeta[]): string {
  if (m.fn === 'count') return 'Count';
  const f = fields.find((x) => x.name === m.field);
  const fn = MEASURE_FNS.find((x) => x.fn === m.fn)?.label ?? m.fn;
  return `${fn} of ${f?.label ?? m.field}`;
}

// ── Draft config ─────────────────────────────────────────────────────────────

interface DraftConfig {
  mode: 'aggregate' | 'records';
  groupBy: string[];
  measures: ReportMeasure[];
  filters: ReportFilter[];
  dateField: string;
  dateFrom: string;
  dateTo: string;
  chartType: ChartType | 'table';
  sortDir: 'asc' | 'desc';
}

interface SavedView {
  name: string;
  dataset: string;
  config: DraftConfig;
}

const SAVED_KEY = 'report-saved-views-v1';

function loadSavedViews(): SavedView[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]') as SavedView[];
  } catch {
    return [];
  }
}

function defaultConfig(ds: ReportDataset): DraftConfig {
  const dims = ds.fields.filter((f) => f.role === 'dimension' || f.role === 'boolean');
  const dates = ds.fields.filter((f) => f.role === 'date');
  return {
    mode: 'aggregate',
    groupBy: dims.length ? [dims[0].name] : [],
    measures: [{ fn: 'count' }],
    filters: [],
    dateField: ds.defaultDateField ?? (dates[0]?.name ?? ''),
    dateFrom: '',
    dateTo: '',
    chartType: 'bar',
    sortDir: 'desc',
  };
}

function buildDto(dataset: string, c: DraftConfig): ReportQueryDto {
  const cleanFilters = c.filters.filter((f) => f.field && f.op);
  const base: ReportQueryDto = {
    dataset,
    filters: cleanFilters.length ? cleanFilters : undefined,
    dateField: c.dateField || undefined,
    dateFrom: c.dateFrom || undefined,
    dateTo: c.dateTo || undefined,
  };
  if (c.mode === 'aggregate') {
    return {
      ...base,
      groupBy: c.groupBy.filter(Boolean),
      measures: c.measures,
      sort: c.groupBy[0]
        ? { field: measureAlias(c.measures[0]), dir: c.sortDir }
        : undefined,
      pageSize: 200,
    };
  }
  return { ...base, page: 1, pageSize: 100 };
}

// ── Main component ───────────────────────────────────────────────────────────

export function ReportBuilder() {
  const { data: datasets, isLoading: dsLoading, isError: dsError } = useQuery({
    queryKey: ['report-datasets'],
    queryFn: () => api.reportDatasets(),
    staleTime: 5 * 60 * 1000,
  });

  const [slug, setSlug] = useState<string>('');
  const [draft, setDraft] = useState<DraftConfig | null>(null);
  const [applied, setApplied] = useState<ReportQueryDto | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [exporting, setExporting] = useState(false);

  useEffect(() => setSavedViews(loadSavedViews()), []);

  // Initialise on first dataset load.
  useEffect(() => {
    if (!datasets?.length || slug) return;
    const first = datasets[0];
    setSlug(first.slug);
    const cfg = defaultConfig(first);
    setDraft(cfg);
    setApplied(buildDto(first.slug, cfg));
  }, [datasets, slug]);

  const dataset = useMemo(
    () => datasets?.find((d) => d.slug === slug),
    [datasets, slug],
  );

  const dims = useMemo(
    () => dataset?.fields.filter((f) => f.role === 'dimension' || f.role === 'boolean') ?? [],
    [dataset],
  );
  const measureFields = useMemo(
    () => dataset?.fields.filter((f) => f.role === 'measure') ?? [],
    [dataset],
  );
  const dateFields = useMemo(
    () => dataset?.fields.filter((f) => f.role === 'date') ?? [],
    [dataset],
  );

  const { data: result, isFetching, isError, error } = useQuery({
    queryKey: ['report-run', applied],
    queryFn: () => api.runReport(applied!),
    enabled: !!applied,
    placeholderData: (prev) => prev,
  });

  function onChangeDataset(newSlug: string) {
    const ds = datasets?.find((d) => d.slug === newSlug);
    if (!ds) return;
    setSlug(newSlug);
    const cfg = defaultConfig(ds);
    setDraft(cfg);
    setApplied(buildDto(newSlug, cfg));
  }

  function patch(p: Partial<DraftConfig>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  function run() {
    if (!draft || !dataset) return;
    if (draft.mode === 'aggregate' && draft.groupBy.filter(Boolean).length === 0) {
      toast.error('Pick at least one “Group by” dimension, or switch to Records mode.');
      return;
    }
    setApplied(buildDto(dataset.slug, draft));
  }

  async function onExport() {
    if (!applied) return;
    setExporting(true);
    try {
      await api.exportReport(applied);
      toast.success('CSV exported');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  function saveView() {
    if (!draft || !dataset) return;
    const name = window.prompt('Save this report view as:');
    if (!name?.trim()) return;
    const next = [
      ...savedViews.filter((v) => v.name !== name.trim()),
      { name: name.trim(), dataset: dataset.slug, config: draft },
    ];
    setSavedViews(next);
    localStorage.setItem(SAVED_KEY, JSON.stringify(next));
    toast.success(`Saved “${name.trim()}”`);
  }

  function loadView(name: string) {
    const v = savedViews.find((x) => x.name === name);
    if (!v) return;
    setSlug(v.dataset);
    setDraft(v.config);
    setApplied(buildDto(v.dataset, v.config));
  }

  function deleteView(name: string) {
    const next = savedViews.filter((v) => v.name !== name);
    setSavedViews(next);
    localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  }

  // ── Filter row editing ──
  function addFilter() {
    if (!dataset) return;
    const first = dataset.fields.find((f) => f.role !== 'date') ?? dataset.fields[0];
    if (!first) return;
    patch({
      filters: [
        ...(draft?.filters ?? []),
        { field: first.name, op: opsForField(first)[0], value: '' },
      ],
    });
  }
  function updateFilter(i: number, p: Partial<ReportFilter>) {
    const filters = [...(draft?.filters ?? [])];
    filters[i] = { ...filters[i], ...p };
    patch({ filters });
  }
  function removeFilter(i: number) {
    patch({ filters: (draft?.filters ?? []).filter((_, idx) => idx !== i) });
  }

  if (dsLoading || !draft) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading report engine…
      </div>
    );
  }
  if (dsError || !datasets) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-600">
        Failed to load report datasets. Check that the backend is reachable.
      </div>
    );
  }

  const measures = draft.measures;
  const seriesMeasures = measures.map((m) => ({
    key: measureAlias(m),
    label: measureLabel(m, dataset?.fields ?? []),
  }));
  const isAggregate = result?.mode === 'aggregate';

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 p-8 shadow-xl shadow-indigo-900/20">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 left-32 h-64 w-64 rounded-full bg-purple-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1">
              <Sparkles className="h-3.5 w-3.5 text-indigo-300" />
              <span className="text-xs font-semibold text-indigo-300">Custom Reporting</span>
            </div>
            <h1 className="bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-3xl font-black tracking-tight text-transparent">
              Reports &amp; Analytics
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              Slice any dataset by dimensions, measures and filters — then chart or export it.
            </p>
          </div>
          {/* Saved views */}
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-lg border border-white/10 bg-white/10 px-2.5 text-sm text-white shadow-sm backdrop-blur focus:outline-none"
              value=""
              onChange={(e) => e.target.value && loadView(e.target.value)}
            >
              <option value="" className="text-slate-700">
                {savedViews.length ? 'Load saved view…' : 'No saved views'}
              </option>
              {savedViews.map((v) => (
                <option key={v.name} value={v.name} className="text-slate-700">
                  {v.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Config panel */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {/* Row 1: dataset + mode + date range */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <FieldLabel>Dataset</FieldLabel>
            <select
              className={cn(selectCls, 'w-full')}
              value={slug}
              onChange={(e) => onChangeDataset(e.target.value)}
            >
              {datasets.map((d) => (
                <option key={d.slug} value={d.slug}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel>View mode</FieldLabel>
            <div className="flex gap-1.5 rounded-lg bg-slate-100 p-1">
              {(['aggregate', 'records'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => patch({ mode: m })}
                  className={cn(
                    'flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition',
                    draft.mode === m
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-500 hover:text-slate-700',
                  )}
                >
                  {m === 'aggregate' ? 'Summary' : 'Records'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>Date field</FieldLabel>
            <select
              className={cn(selectCls, 'w-full')}
              value={draft.dateField}
              onChange={(e) => patch({ dateField: e.target.value })}
              disabled={!dateFields.length}
            >
              <option value="">— none —</option>
              {dateFields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>From</FieldLabel>
              <input
                type="date"
                className={cn(inputCls, 'w-full')}
                value={draft.dateFrom}
                onChange={(e) => patch({ dateFrom: e.target.value })}
                disabled={!draft.dateField}
              />
            </div>
            <div>
              <FieldLabel>To</FieldLabel>
              <input
                type="date"
                className={cn(inputCls, 'w-full')}
                value={draft.dateTo}
                onChange={(e) => patch({ dateTo: e.target.value })}
                disabled={!draft.dateField}
              />
            </div>
          </div>
        </div>

        {/* Row 2: group by + measures (aggregate only) */}
        {draft.mode === 'aggregate' && (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
              <FieldLabel>Group by (dimensions)</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className={cn(selectCls, 'min-w-[10rem]')}
                  value={draft.groupBy[0] ?? ''}
                  onChange={(e) =>
                    patch({ groupBy: [e.target.value, draft.groupBy[1]].filter(Boolean) as string[] })
                  }
                >
                  {dims.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-400">then</span>
                <select
                  className={cn(selectCls, 'min-w-[10rem]')}
                  value={draft.groupBy[1] ?? ''}
                  onChange={(e) =>
                    patch({ groupBy: [draft.groupBy[0], e.target.value].filter(Boolean) as string[] })
                  }
                >
                  <option value="">— none —</option>
                  {dims
                    .filter((f) => f.name !== draft.groupBy[0])
                    .map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
              <div className="mb-1 flex items-center justify-between">
                <FieldLabel>Measures</FieldLabel>
                <button
                  onClick={() => patch({ measures: [...measures, { fn: 'count' }] })}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </button>
              </div>
              <div className="space-y-2">
                {measures.map((m, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      className={cn(selectCls, 'w-28')}
                      value={m.fn}
                      onChange={(e) => {
                        const fn = e.target.value as ReportMeasureFn;
                        const next = [...measures];
                        next[i] = {
                          fn,
                          field: fn === 'count' ? undefined : m.field ?? measureFields[0]?.name,
                        };
                        patch({ measures: next });
                      }}
                    >
                      {MEASURE_FNS.map((f) => (
                        <option key={f.fn} value={f.fn}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className={cn(selectCls, 'flex-1')}
                      value={m.field ?? ''}
                      disabled={m.fn === 'count' || !measureFields.length}
                      onChange={(e) => {
                        const next = [...measures];
                        next[i] = { ...m, field: e.target.value };
                        patch({ measures: next });
                      }}
                    >
                      {m.fn === 'count' ? (
                        <option value="">records</option>
                      ) : (
                        measureFields.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.label}
                          </option>
                        ))
                      )}
                    </select>
                    {measures.length > 1 && (
                      <button
                        onClick={() => patch({ measures: measures.filter((_, idx) => idx !== i) })}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Row 3: filters */}
        <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <Filter className="h-3.5 w-3.5" /> Filters
            </span>
            <button
              onClick={addFilter}
              className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add filter
            </button>
          </div>
          {draft.filters.length === 0 ? (
            <p className="py-1 text-xs text-slate-400">
              No filters — showing all records{draft.dateField ? ' in the selected date range' : ''}.
            </p>
          ) : (
            <div className="space-y-2">
              {draft.filters.map((flt, i) => {
                const meta = dataset?.fields.find((f) => f.name === flt.field);
                const ops = meta ? opsForField(meta) : (['eq'] as ReportFilterOp[]);
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select
                      className={cn(selectCls, 'min-w-[9rem]')}
                      value={flt.field}
                      onChange={(e) => {
                        const nf = dataset?.fields.find((f) => f.name === e.target.value);
                        updateFilter(i, {
                          field: e.target.value,
                          op: nf ? opsForField(nf)[0] : 'eq',
                          value: '',
                          value2: '',
                        });
                      }}
                    >
                      {dataset?.fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className={cn(selectCls, 'w-32')}
                      value={flt.op}
                      onChange={(e) => updateFilter(i, { op: e.target.value as ReportFilterOp })}
                    >
                      {ops.map((o) => (
                        <option key={o} value={o}>
                          {OP_LABELS[o]}
                        </option>
                      ))}
                    </select>
                    <FilterValue
                      meta={meta}
                      filter={flt}
                      onChange={(p) => updateFilter(i, p)}
                    />
                    <button
                      onClick={() => removeFilter(i)}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={run} className="bg-indigo-600 hover:bg-indigo-700">
            {isFetching ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            Run report
          </Button>
          <Button
            variant="outline"
            onClick={onExport}
            disabled={!applied || exporting}
            className="border-slate-200 text-slate-600 hover:border-emerald-300 hover:text-emerald-700"
          >
            <Download className="mr-1.5 h-4 w-4" /> {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
          <Button
            variant="outline"
            onClick={saveView}
            className="border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
          >
            <Save className="mr-1.5 h-4 w-4" /> Save view
          </Button>
          <Button
            variant="outline"
            onClick={() => dataset && onChangeDataset(dataset.slug)}
            className="border-slate-200 text-slate-500 hover:text-slate-700"
          >
            <RotateCcw className="mr-1.5 h-4 w-4" /> Reset
          </Button>
          {/* Chart type switcher */}
          {draft.mode === 'aggregate' && (
            <div className="ml-auto flex gap-1 rounded-lg bg-slate-100 p-1">
              {CHART_TYPES.map(({ type, label, icon: Icon }) => (
                <button
                  key={type}
                  title={label}
                  onClick={() => patch({ chartType: type })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition',
                    draft.chartType === type
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-500 hover:text-slate-700',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {savedViews.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Saved:
            </span>
            {savedViews.map((v) => (
              <span
                key={v.name}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2.5 pr-1 text-xs text-slate-600"
              >
                <button onClick={() => loadView(v.name)} className="hover:text-indigo-700">
                  {v.name}
                </button>
                <button
                  onClick={() => deleteView(v.name)}
                  className="rounded-full p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Error */}
      {isError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          {error instanceof Error ? error.message : 'Report query failed.'}
        </div>
      )}

      {/* KPI summary */}
      {result && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <SummaryCard
            label={isAggregate ? 'Groups' : 'Records'}
            value={fmt(result.total)}
            accent="from-indigo-500 to-purple-600"
          />
          {isAggregate &&
            result.measures?.map((m) => (
              <SummaryCard
                key={measureAlias(m)}
                label={`Total · ${measureLabel(m, dataset?.fields ?? [])}`}
                value={fmt(result.summary?.[measureAlias(m)])}
                accent="from-emerald-500 to-teal-500"
              />
            ))}
        </div>
      )}

      {/* Chart */}
      {result && isAggregate && draft.chartType !== 'table' && result.groupBy?.length ? (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-purple-50 px-6 py-4">
            <h3 className="text-sm font-bold text-slate-800">
              {dataset?.label} · grouped by{' '}
              {result.groupBy.map((g) => dataset?.fields.find((f) => f.name === g)?.label).join(' → ')}
            </h3>
          </div>
          <div className="p-5">
            <ReportChart
              rows={result.rows}
              xKey={result.groupBy[0]}
              seriesKey={result.groupBy[1]}
              measures={seriesMeasures}
              chartType={draft.chartType}
            />
          </div>
        </div>
      ) : null}

      {/* Data table */}
      {result && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-700">
              {isAggregate ? 'Aggregated rows' : 'Records'} ·{' '}
              <span className="text-slate-400">{result.rows.length} shown</span>
            </h3>
            {isFetching && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> refreshing
              </span>
            )}
          </div>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-slate-100 bg-slate-50">
                  {result.columns.map((c) => (
                    <th
                      key={c}
                      className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      {dataset?.fields.find((f) => f.name === c)?.label ??
                        c.replace(/_/g, ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.rows.map((row, idx) => (
                  <tr key={idx} className={idx % 2 ? 'bg-slate-50/40' : 'bg-white'}>
                    {result.columns.map((c) => (
                      <td
                        key={c}
                        className="max-w-[280px] truncate px-4 py-2 text-slate-700"
                        title={fmt(row[c])}
                      >
                        {fmt(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={Math.max(1, result.columns.length)}
                      className="py-16 text-center text-sm text-slate-400"
                    >
                      No data for the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/60 bg-white p-5 shadow-md shadow-slate-200/60">
      <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', accent)} />
      <p className="truncate text-[11px] font-bold uppercase tracking-wider text-slate-400" title={label}>
        {label}
      </p>
      <p className="mt-2 text-3xl font-black tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function FilterValue({
  meta,
  filter,
  onChange,
}: {
  meta: ReportFieldMeta | undefined;
  filter: ReportFilter;
  onChange: (p: Partial<ReportFilter>) => void;
}) {
  if (filter.op === 'isNull') return null;

  if (meta?.role === 'boolean') {
    return (
      <select
        className={cn(selectCls, 'w-28')}
        value={String(filter.value ?? 'true')}
        onChange={(e) => onChange({ value: e.target.value })}
      >
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  if (meta?.enumValues && (filter.op === 'eq' || filter.op === 'ne')) {
    return (
      <select
        className={cn(selectCls, 'min-w-[9rem]')}
        value={String(filter.value ?? '')}
        onChange={(e) => onChange({ value: e.target.value })}
      >
        <option value="">— select —</option>
        {meta.enumValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }

  const inputType =
    meta?.role === 'measure' ? 'number' : meta?.role === 'date' ? 'date' : 'text';

  if (filter.op === 'between') {
    return (
      <div className="flex items-center gap-1">
        <input
          type={inputType}
          className={cn(inputCls, 'w-28')}
          value={String(filter.value ?? '')}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="min"
        />
        <span className="text-xs text-slate-400">–</span>
        <input
          type={inputType}
          className={cn(inputCls, 'w-28')}
          value={String(filter.value2 ?? '')}
          onChange={(e) => onChange({ value2: e.target.value })}
          placeholder="max"
        />
      </div>
    );
  }

  return (
    <input
      type={inputType}
      className={cn(inputCls, 'min-w-[10rem] flex-1')}
      value={String(filter.value ?? '')}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder={filter.op === 'in' ? 'a, b, c' : 'value'}
    />
  );
}
