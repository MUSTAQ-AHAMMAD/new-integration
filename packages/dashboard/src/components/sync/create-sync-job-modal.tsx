'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CreateSyncJobDto } from '@/lib/api';
import { toast } from 'sonner';
import {
  CalendarRange,
  ChevronDown,
  Layers,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Settings2,
  Store,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

type ScopeType = 'ALL' | 'BRANCH' | 'DATE_RANGE' | 'BRANCH_DATE_RANGE' | 'SINGLE_ORDER' | 'FAILED_ONLY';

interface ScopeOption {
  value: ScopeType;
  label: string;
  description: string;
  icon: React.ElementType;
  needsBranch?: boolean;
  needsDates?: boolean;
  needsOrders?: boolean;
}

// Visual scope picker — each card reveals only the inputs it needs, replacing the
// old dropdown + conditional-field soup.
const SCOPE_OPTIONS: ScopeOption[] = [
  { value: 'ALL', label: 'All pending', description: 'Queue every pending order across all stores', icon: Layers },
  { value: 'BRANCH', label: 'By store', description: 'Only a single store’s pending orders', icon: Store, needsBranch: true },
  { value: 'DATE_RANGE', label: 'By date range', description: 'Orders within a date window', icon: CalendarRange, needsDates: true },
  { value: 'BRANCH_DATE_RANGE', label: 'Store + dates', description: 'One store within a date window', icon: CalendarRange, needsBranch: true, needsDates: true },
  { value: 'SINGLE_ORDER', label: 'Specific orders', description: 'Paste one or more order numbers', icon: ListChecks, needsOrders: true },
  { value: 'FAILED_ONLY', label: 'Retry failed', description: 'Re-queue previously failed orders', icon: RotateCcw },
];

const JOB_TYPES = ['ORDER_SYNC', 'INVENTORY_SYNC', 'PAYMENT_SYNC', 'CONFIG_SYNC', 'REFUND_SYNC'];
const TIMEZONES = ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Muscat', 'Asia/Kuwait', 'UTC', 'Europe/London', 'America/New_York'];

const PREFS_KEY = 'integration_hub_sync_defaults';

interface SyncPrefs {
  jobType: string;
  timezone: string;
  createdBy: string;
  scopeType: ScopeType;
}

const DEFAULT_PREFS: SyncPrefs = {
  jobType: 'ORDER_SYNC',
  timezone: 'Asia/Dubai',
  createdBy: 'DASHBOARD_USER',
  scopeType: 'ALL',
};

function loadPrefs(): SyncPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<SyncPrefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function CreateSyncJobModal() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Customizable, remembered defaults.
  const [prefs, setPrefs] = useState<SyncPrefs>(DEFAULT_PREFS);
  const [rememberDefaults, setRememberDefaults] = useState(true);

  // Scope-specific inputs.
  const [scopeType, setScopeType] = useState<ScopeType>('ALL');
  const [branchCode, setBranchCode] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [ordersText, setOrdersText] = useState('');

  // Load remembered defaults once the dialog first opens.
  useEffect(() => {
    if (!open) return;
    const p = loadPrefs();
    setPrefs(p);
    setScopeType(p.scopeType);
  }, [open]);

  const selectedScope = SCOPE_OPTIONS.find((s) => s.value === scopeType)!;

  const orderIds = useMemo(
    () =>
      ordersText
        .split(/[\s,]+/)
        .map((v) => v.trim())
        .filter(Boolean),
    [ordersText],
  );

  // Stores for the branch picker (active only) — a real dropdown instead of a
  // free-text branch code.
  const { data: stores, isLoading: storesLoading } = useQuery({
    queryKey: ['stores', 'active'],
    queryFn: () => api.listStores(true),
    enabled: open && (selectedScope.needsBranch ?? false),
  });

  // Live estimate of how many orders this scope will queue, so the user sees the
  // impact before committing. Date-window filtering is applied server-side, so
  // for date scopes we show the store/all pending count as an upper bound.
  const previewStatus = scopeType === 'FAILED_ONLY' ? 'FAILED' : 'PENDING';
  const { data: previewOrders, isFetching: previewLoading } = useQuery({
    queryKey: ['sync-preview', previewStatus, branchCode, scopeType],
    queryFn: () =>
      api.listOrderQueue({
        status: previewStatus,
        branchCode: selectedScope.needsBranch ? branchCode : undefined,
        limit: 1000,
      }),
    enabled: open && scopeType !== 'SINGLE_ORDER' && !(selectedScope.needsBranch && !branchCode),
  });

  const estimate = scopeType === 'SINGLE_ORDER' ? orderIds.length : previewOrders?.length;

  const mutation = useMutation({
    mutationFn: api.createSyncJob,
    onSuccess: () => {
      toast.success('Sync job created — orders are being queued');
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
      if (rememberDefaults && typeof window !== 'undefined') {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, scopeType }));
      }
      resetAndClose();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function resetAndClose() {
    setOpen(false);
    setBranchCode('');
    setStartDate('');
    setEndDate('');
    setOrdersText('');
    setShowAdvanced(false);
  }

  // Validation — Create is blocked until the chosen scope has what it needs.
  const validationError = useMemo(() => {
    if (selectedScope.needsBranch && !branchCode) return 'Select a store.';
    if (selectedScope.needsDates && (!startDate || !endDate)) return 'Pick both start and end dates.';
    if (selectedScope.needsDates && startDate && endDate && startDate > endDate) return 'Start date must be before end date.';
    if (selectedScope.needsOrders && orderIds.length === 0) return 'Enter at least one order number.';
    return null;
  }, [selectedScope, branchCode, startDate, endDate, orderIds.length]);

  const summary = useMemo(() => {
    const store = stores?.find((s) => s.branchCode === branchCode);
    const storeLabel = store ? `${store.branchCode} (${store.branchName})` : branchCode || 'the selected store';
    const range = startDate && endDate ? ` from ${startDate} to ${endDate}` : '';
    switch (scopeType) {
      case 'ALL':
        return 'Queue all pending orders across every store.';
      case 'BRANCH':
        return `Queue pending orders for ${storeLabel}.`;
      case 'DATE_RANGE':
        return `Queue pending orders${range}.`;
      case 'BRANCH_DATE_RANGE':
        return `Queue pending orders for ${storeLabel}${range}.`;
      case 'SINGLE_ORDER':
        return `Queue ${orderIds.length} specific order${orderIds.length === 1 ? '' : 's'}.`;
      case 'FAILED_ONLY':
        return 'Re-queue all previously failed orders.';
    }
  }, [scopeType, stores, branchCode, startDate, endDate, orderIds.length]);

  function submit() {
    const dto: CreateSyncJobDto = {
      jobType: prefs.jobType,
      scopeType,
      createdBy: prefs.createdBy || 'DASHBOARD_USER',
      ...(selectedScope.needsBranch ? { branchCode } : {}),
      ...(selectedScope.needsDates ? { startDate, endDate, timezone: prefs.timezone } : {}),
      ...(selectedScope.needsOrders ? { orderIds } : {}),
    };
    mutation.mutate(dto);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : resetAndClose())}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> New Sync Job
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a sync</DialogTitle>
          <DialogDescription>Choose what to sync. Only the fields you need appear.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* ── Scope cards ─────────────────────────────────────── */}
          <div>
            <Label className="mb-2 block">What do you want to sync?</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SCOPE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = scopeType === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setScopeType(opt.value)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all',
                      active
                        ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50',
                    )}
                  >
                    <Icon className={cn('h-4 w-4', active ? 'text-indigo-600' : 'text-slate-400')} />
                    <span className={cn('text-sm font-semibold', active ? 'text-indigo-900' : 'text-slate-800')}>{opt.label}</span>
                    <span className="text-[11px] leading-tight text-slate-500">{opt.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Scope-specific inputs ───────────────────────────── */}
          {selectedScope.needsBranch && (
            <div>
              <Label>Store</Label>
              <Select value={branchCode} onValueChange={setBranchCode}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder={storesLoading ? 'Loading stores…' : 'Choose a store'} />
                </SelectTrigger>
                <SelectContent>
                  {(stores ?? []).map((s) => (
                    <SelectItem key={s.branchCode} value={s.branchCode}>
                      {s.branchCode} — {s.branchName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {selectedScope.needsDates && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="startDate">Start date</Label>
                <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="endDate">End date</Label>
                <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1" />
              </div>
            </div>
          )}

          {selectedScope.needsOrders && (
            <div>
              <Label htmlFor="orders">Order numbers</Label>
              <Textarea
                id="orders"
                placeholder={'Paste order numbers — separated by commas, spaces, or new lines\ne.g. S00123, S00124'}
                value={ordersText}
                onChange={(e) => setOrdersText(e.target.value)}
                className="mt-1 font-mono text-xs"
                rows={4}
              />
              <p className="mt-1 text-xs text-slate-400">{orderIds.length} order{orderIds.length === 1 ? '' : 's'} detected.</p>
            </div>
          )}

          {/* ── Live preview / summary ──────────────────────────── */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-sm text-slate-700">{summary}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
              {scopeType === 'SINGLE_ORDER' ? (
                <span>{estimate} order{estimate === 1 ? '' : 's'} to queue</span>
              ) : selectedScope.needsBranch && !branchCode ? (
                <span>Select a store to estimate matching orders</span>
              ) : previewLoading ? (
                <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Estimating…</span>
              ) : estimate === undefined ? (
                <span>Estimate unavailable</span>
              ) : (
                <span>
                  ≈ <strong>{estimate}</strong> {previewStatus === 'FAILED' ? 'failed' : 'pending'} order{estimate === 1 ? '' : 's'} match
                  {selectedScope.needsDates ? ' (before date filter)' : ''}
                </span>
              )}
            </div>
          </div>

          {/* ── Advanced / customizable options ─────────────────── */}
          <div className="rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              <span className="flex items-center gap-2"><Settings2 className="h-4 w-4" /> Advanced options</span>
              <ChevronDown className={cn('h-4 w-4 transition-transform', showAdvanced && 'rotate-180')} />
            </button>
            {showAdvanced && (
              <div className="space-y-4 border-t border-slate-200 px-4 py-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Job type</Label>
                    <Select value={prefs.jobType} onValueChange={(v) => setPrefs((p) => ({ ...p, jobType: v }))}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {JOB_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Timezone {selectedScope.needsDates ? '' : '(dates only)'}</Label>
                    <Select value={prefs.timezone} onValueChange={(v) => setPrefs((p) => ({ ...p, timezone: v }))}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIMEZONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="createdBy">Created by (label)</Label>
                  <Input id="createdBy" value={prefs.createdBy} onChange={(e) => setPrefs((p) => ({ ...p, createdBy: e.target.value }))} className="mt-1" />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={rememberDefaults} onChange={(e) => setRememberDefaults(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                  Remember these as my defaults
                </label>
              </div>
            )}
          </div>

          {validationError && <p className="text-sm text-red-600">{validationError}</p>}

          {/* ── Actions ─────────────────────────────────────────── */}
          <div className="flex gap-2">
            <Button className="flex-1" onClick={submit} disabled={mutation.isPending || !!validationError}>
              {mutation.isPending ? (
                <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Creating…</>
              ) : (
                'Create sync job'
              )}
            </Button>
            <Button type="button" variant="outline" onClick={resetAndClose} disabled={mutation.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
