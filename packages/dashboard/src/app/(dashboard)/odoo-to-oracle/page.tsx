'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SyncJob } from '@/lib/api';
import { toast } from 'sonner';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Info,
  Loader2,
  Play,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate, getStatusColor } from '@/lib/utils';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL']);

const SCOPE_OPTIONS = [
  { value: 'ALL', label: 'All pending orders' },
  { value: 'BRANCH', label: 'Single branch' },
  { value: 'DATE_RANGE', label: 'Date range' },
  { value: 'BRANCH_DATE_RANGE', label: 'Branch + date range' },
  { value: 'FAILED_ONLY', label: 'Failed orders only' },
] as const;

type ScopeType = (typeof SCOPE_OPTIONS)[number]['value'];

function StepBadge({ step, label, active }: { step: number; label: string; active: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
        active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'
      }`}
    >
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${
          active ? 'bg-white/20' : 'bg-slate-200'
        }`}
      >
        {step}
      </span>
      {label}
    </div>
  );
}

function FetchResultCard({
  result,
}: {
  result: { fetched: number; ingested: number; skipped: number; errors: string[] };
}) {
  return (
    <Card className="border-green-200 bg-green-50/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-green-800">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          Step 1 Complete — Fetched from Odoo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-white p-3 shadow-sm">
            <p className="text-xl font-bold text-slate-900">{result.fetched}</p>
            <p className="text-xs text-slate-500">Orders Fetched</p>
          </div>
          <div className="rounded-lg bg-white p-3 shadow-sm">
            <p className="text-xl font-bold text-green-700">{result.ingested}</p>
            <p className="text-xs text-slate-500">Ingested</p>
          </div>
          <div className="rounded-lg bg-white p-3 shadow-sm">
            <p className="text-xl font-bold text-yellow-700">{result.skipped}</p>
            <p className="text-xs text-slate-500">Skipped</p>
          </div>
        </div>
        {result.errors.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="mb-1 text-xs font-semibold text-red-700">
              Errors ({result.errors.length})
            </p>
            <ul className="space-y-0.5 text-xs text-red-600">
              {result.errors.slice(0, 8).map((err, i) => (
                <li key={i} className="truncate">
                  • {err}
                </li>
              ))}
              {result.errors.length > 8 && (
                <li className="text-red-500">…and {result.errors.length - 8} more</li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SyncJobCard({ job }: { job: SyncJob }) {
  const isRunning = !TERMINAL_STATUSES.has(job.status);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-semibold">Step 2 — Oracle Sync Job</CardTitle>
        {isRunning && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-500">Job ID</dt>
            <dd className="font-mono text-xs text-gray-700">{job.id}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Status</dt>
            <dd>
              <span
                className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(job.status)}`}
              >
                {job.status}
              </span>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Records processed</dt>
            <dd className="font-medium text-gray-800">
              {job.processedRecords} / {job.totalRecords || '—'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="flex items-center gap-1 text-gray-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Succeeded
            </dt>
            <dd className="font-medium text-green-700">{job.successCount}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="flex items-center gap-1 text-gray-500">
              <XCircle className="h-3.5 w-3.5 text-red-500" /> Failed
            </dt>
            <dd className="font-medium text-red-700">{job.failedCount}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Skipped</dt>
            <dd className="font-medium text-yellow-700">{job.skippedCount}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Created at</dt>
            <dd className="text-gray-400">{formatDate(job.createdAt)}</dd>
          </div>
          {job.errorMessage && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <span className="font-semibold">Error: </span>
              {job.errorMessage}
            </div>
          )}
        </dl>
        <div className="mt-3 border-t pt-3">
          <Link
            href="/sync-jobs"
            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
          >
            View all sync jobs <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OdooToOraclePage() {
  const qc = useQueryClient();

  // ── Fetch (Step 1) params ─────────────────────────────────────────
  const [credentialId, setCredentialId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [fetchStart, setFetchStart] = useState('');
  const [fetchEnd, setFetchEnd] = useState('');
  const [limit, setLimit] = useState('100');

  // ── Sync (Step 2) params ──────────────────────────────────────────
  const [scopeType, setScopeType] = useState<ScopeType>('ALL');
  const [syncBranchCode, setSyncBranchCode] = useState('');
  const [syncStart, setSyncStart] = useState('');
  const [syncEnd, setSyncEnd] = useState('');
  const [timezone, setTimezone] = useState('Asia/Dubai');
  const [autoPush, setAutoPush] = useState(true);

  // ── Results ───────────────────────────────────────────────────────
  const [fetchResult, setFetchResult] = useState<{
    fetched: number;
    ingested: number;
    skipped: number;
    errors: string[];
  } | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const needsBranch = scopeType === 'BRANCH' || scopeType === 'BRANCH_DATE_RANGE';
  const needsDates = scopeType === 'DATE_RANGE' || scopeType === 'BRANCH_DATE_RANGE';

  // ── Load available Odoo credentials ──────────────────────────────
  const { data: credentials = [], isLoading: loadingCreds } = useQuery({
    queryKey: ['odoo-credentials'],
    queryFn: () => api.listOdooCredentials(),
  });

  // ── Step 2 — Oracle sync job mutation ─────────────────────────────
  const syncMutation = useMutation({
    mutationFn: () =>
      api.createSyncJob({
        jobType: 'ORDER_SYNC',
        scopeType,
        ...(needsBranch && syncBranchCode ? { branchCode: syncBranchCode } : {}),
        ...(needsDates && syncStart ? { startDate: syncStart } : {}),
        ...(needsDates && syncEnd ? { endDate: syncEnd } : {}),
        ...(timezone ? { timezone } : {}),
        createdBy: 'DASHBOARD_PIPELINE',
      }),
    onSuccess: (job) => {
      toast.success('Oracle sync job created — monitoring progress…');
      setActiveJobId(job.id);
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (e: Error) => toast.error(`Oracle sync failed: ${e.message}`),
  });

  // ── Step 1 — Fetch from Odoo mutation ─────────────────────────────
  const fetchMutation = useMutation({
    mutationFn: () =>
      api.fetchOdooOrders({
        credentialId: credentialId || undefined,
        branchId: branchId ? Number(branchId) : undefined,
        startDate: fetchStart || undefined,
        endDate: fetchEnd || undefined,
        limit: limit ? Number(limit) : 100,
      }),
    onSuccess: (result) => {
      setFetchResult(result);
      toast.success(`Fetched ${result.fetched} orders from Odoo — ${result.ingested} ingested`);
      if (autoPush) {
        syncMutation.mutate();
      }
    },
    onError: (e: Error) => toast.error(`Odoo fetch failed: ${e.message}`),
  });

  // ── Poll sync job ─────────────────────────────────────────────────
  const { data: polledJob } = useQuery({
    queryKey: ['sync-job-poll', activeJobId],
    queryFn: () => api.getSyncJob(activeJobId!),
    enabled: !!activeJobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : 3000;
    },
  });

  useEffect(() => {
    if (polledJob && TERMINAL_STATUSES.has(polledJob.status)) {
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    }
  }, [polledJob, qc]);

  const isPipelineRunning = fetchMutation.isPending || syncMutation.isPending;

  function handleReset() {
    setFetchResult(null);
    setActiveJobId(null);
    fetchMutation.reset();
    syncMutation.reset();
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-gradient-to-b from-indigo-500 to-purple-600" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Odoo → Oracle Pipeline</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Fetch orders from Odoo and automatically send them to Oracle Fusion in one operation.
          </p>
        </div>
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <StepBadge step={1} label="Fetch from Odoo" active={fetchMutation.isPending} />
          <ArrowRight className="h-4 w-4 text-slate-300" />
          <StepBadge step={2} label="Push to Oracle" active={syncMutation.isPending} />
        </div>
      </div>

      {/* How it works */}
      <Card className="border-blue-100 bg-blue-50">
        <CardContent className="pt-4">
          <div className="flex gap-2 text-sm text-blue-800">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
            <div className="space-y-1">
              <p className="font-semibold">How it works</p>
              <ol className="list-inside list-decimal space-y-0.5 text-blue-700">
                <li>
                  Configure <strong>Fetch Parameters</strong> to control which orders are pulled
                  from Odoo.
                </li>
                <li>
                  Choose the <strong>Oracle Sync Scope</strong> to decide which ingested orders get
                  pushed to Oracle Fusion.
                </li>
                <li>
                  Enable <strong>Auto-push to Oracle</strong> (default on) to run both steps
                  back-to-back automatically.
                </li>
                <li>
                  Click <strong>Run Pipeline</strong> — Step 1 fetches &amp; ingests, Step 2
                  creates a sync job and pushes to Oracle.
                </li>
                <li>
                  Monitor the sync job progress below in real time (updates every 3 seconds).
                </li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Step 1 — Fetch Parameters */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                1
              </span>
              Fetch Parameters
            </CardTitle>
            <CardDescription>
              Filter which orders are pulled from Odoo. All fields are optional.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Credential selector */}
            <div>
              <Label htmlFor="credentialId">Region / Credential</Label>
              <select
                id="credentialId"
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                disabled={isPipelineRunning}
              >
                <option value="">
                  {loadingCreds ? 'Loading credentials…' : '— Global (env var) —'}
                </option>
                {credentials.map((cred) => (
                  <option key={cred.id} value={cred.id}>
                    {cred.region} — {cred.baseUrl}
                    {!cred.active ? ' [inactive]' : ''}
                  </option>
                ))}
              </select>
              {credentials.length === 0 && !loadingCreds && (
                <p className="mt-1 text-xs text-slate-400">
                  No per-region credentials configured. Uses global Odoo env vars. Add via{' '}
                  <a href="/admin/odoo-credentials" className="underline">
                    Admin → Odoo Credentials
                  </a>
                  .
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="branchId">Branch ID (Odoo)</Label>
                <Input
                  id="branchId"
                  type="number"
                  placeholder="e.g. 5"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  className="mt-1.5"
                  disabled={isPipelineRunning}
                />
              </div>
              <div>
                <Label htmlFor="fetchLimit">Fetch Limit</Label>
                <Input
                  id="fetchLimit"
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className="mt-1.5"
                  disabled={isPipelineRunning}
                />
              </div>
              <div>
                <Label htmlFor="fetchStart">Start Date</Label>
                <Input
                  id="fetchStart"
                  type="date"
                  value={fetchStart}
                  onChange={(e) => setFetchStart(e.target.value)}
                  className="mt-1.5"
                  disabled={isPipelineRunning}
                />
              </div>
              <div>
                <Label htmlFor="fetchEnd">End Date</Label>
                <Input
                  id="fetchEnd"
                  type="date"
                  value={fetchEnd}
                  onChange={(e) => setFetchEnd(e.target.value)}
                  className="mt-1.5"
                  disabled={isPipelineRunning}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 2 — Oracle Sync Scope */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-100 text-xs font-bold text-purple-700">
                2
              </span>
              Oracle Sync Scope
            </CardTitle>
            <CardDescription>
              Which orders should be included in the Oracle Fusion push.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="scopeType">Scope</Label>
              <div className="relative mt-1.5">
                <select
                  id="scopeType"
                  className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                  value={scopeType}
                  onChange={(e) => setScopeType(e.target.value as ScopeType)}
                  disabled={isPipelineRunning}
                >
                  {SCOPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-slate-400" />
              </div>
            </div>

            {needsBranch && (
              <div>
                <Label htmlFor="syncBranch">Branch Code</Label>
                <Input
                  id="syncBranch"
                  placeholder="e.g. BRANCH-001"
                  value={syncBranchCode}
                  onChange={(e) => setSyncBranchCode(e.target.value)}
                  className="mt-1.5"
                  disabled={isPipelineRunning}
                />
              </div>
            )}

            {needsDates && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="syncStart">Start Date</Label>
                  <Input
                    id="syncStart"
                    type="date"
                    value={syncStart}
                    onChange={(e) => setSyncStart(e.target.value)}
                    className="mt-1.5"
                    disabled={isPipelineRunning}
                  />
                </div>
                <div>
                  <Label htmlFor="syncEnd">End Date</Label>
                  <Input
                    id="syncEnd"
                    type="date"
                    value={syncEnd}
                    onChange={(e) => setSyncEnd(e.target.value)}
                    className="mt-1.5"
                    disabled={isPipelineRunning}
                  />
                </div>
              </div>
            )}

            <div>
              <Label htmlFor="timezone">Timezone</Label>
              <Input
                id="timezone"
                placeholder="e.g. Asia/Dubai"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="mt-1.5"
                disabled={isPipelineRunning}
              />
              <p className="mt-1 text-xs text-slate-400">
                IANA timezone used to interpret date filters (default: Asia/Dubai)
              </p>
            </div>

            {/* Auto-push toggle */}
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-700">Auto-push to Oracle</p>
                <p className="text-xs text-slate-400">
                  Automatically start Step 2 after Odoo fetch completes
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoPush}
                onClick={() => setAutoPush((v) => !v)}
                disabled={isPipelineRunning}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 ${
                  autoPush ? 'bg-indigo-600' : 'bg-slate-200'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    autoPush ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Run button row */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          onClick={() => {
            handleReset();
            fetchMutation.mutate();
          }}
          disabled={isPipelineRunning}
          className="gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 px-8 hover:from-indigo-700 hover:to-purple-700"
        >
          {isPipelineRunning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {fetchMutation.isPending ? 'Fetching from Odoo…' : 'Pushing to Oracle…'}
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              Run Pipeline
            </>
          )}
        </Button>

        {!autoPush && fetchResult && !syncMutation.isPending && !activeJobId && (
          <Button
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Push to Oracle Now
          </Button>
        )}

        {(fetchResult || activeJobId) && !isPipelineRunning && (
          <Button variant="ghost" size="sm" onClick={handleReset} className="text-slate-500">
            Reset
          </Button>
        )}
      </div>

      {/* Step 1 result */}
      {fetchResult && <FetchResultCard result={fetchResult} />}

      {/* Step 2 sync job progress */}
      {polledJob && <SyncJobCard job={polledJob} />}
    </div>
  );
}
