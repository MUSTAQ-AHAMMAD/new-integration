'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FlaskConical, Play, RefreshCw, Save, Zap } from 'lucide-react';
import {
  api,
  type AutomationHealth,
  type AutomationPreview,
  type AutomationRegionStatus,
  type AutomationSettingsInput,
} from '@/lib/api';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/error-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const HEALTH_STYLE: Record<AutomationHealth, string> = {
  HEALTHY: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  RUNNING: 'bg-sky-100 text-sky-700 border-sky-200',
  ATTENTION: 'bg-amber-100 text-amber-800 border-amber-200',
  FAILING: 'bg-red-100 text-red-700 border-red-200',
  STALE: 'bg-orange-100 text-orange-700 border-orange-200',
  NEVER_RAN: 'bg-slate-100 text-slate-600 border-slate-200',
  DISABLED: 'bg-slate-100 text-slate-500 border-slate-200',
  SCHEDULER_DOWN: 'bg-red-100 text-red-700 border-red-200',
};
const HEALTH_LABEL: Record<AutomationHealth, string> = {
  HEALTHY: 'Healthy',
  RUNNING: 'Running',
  ATTENTION: 'Needs attention',
  FAILING: 'Failing',
  STALE: 'Stale',
  NEVER_RAN: 'Waiting for first run',
  DISABLED: 'Off',
  SCHEDULER_DOWN: 'Scheduler down',
};

const RUN_STYLE: Record<string, string> = {
  COMPLETED: 'text-emerald-700',
  PARTIAL: 'text-amber-700',
  FAILED: 'text-red-700',
  NOT_STARTED: 'text-red-700',
  RUNNING: 'text-sky-700',
  PROCESSING: 'text-sky-700',
  PENDING: 'text-slate-500',
};

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

export default function AutomationPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['automation-status'],
    queryFn: () => api.automationStatus(),
    refetchInterval: 30_000,
  });

  const master = data?.[0]?.masterEnabled ?? false;
  const setMaster = useMutation({
    mutationFn: (enabled: boolean) => api.automationSetEnabled(null, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-status'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Automation & Cut-off"
        subtitle="When the automatic integration runs, which business days it may post, and whether it is actually working."
        icon={Zap}
        iconColor="bg-violet-500"
      >
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <div className="text-sm text-slate-600">
            <div className="font-semibold text-slate-900">Master switch — Automatic Integration</div>
            Both this AND a region&apos;s own switch must be on for the scheduler to run that region.
            Regions handled here are skipped by the legacy 03:00 &ldquo;Daily Invoice&rdquo; job, so a day never has two automatic posters.
          </div>
          <Toggle
            checked={master}
            disabled={setMaster.isPending || !data}
            onChange={(v) => setMaster.mutate(v)}
            label={master ? 'On' : 'Off'}
          />
        </CardContent>
      </Card>

      <HowItWorks />

      {isError ? (
        <ErrorState message={(error as Error)?.message} />
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !data?.length ? (
        <p className="text-sm text-slate-500">No region has an active Odoo credential.</p>
      ) : (
        data.map((r) => <RegionCard key={r.region} status={r} />)
      )}
    </div>
  );
}

function HowItWorks() {
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
      <summary className="cursor-pointer font-semibold text-slate-700">How the cut-off works</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>All times are the region&apos;s <b>local</b> time (the same clock that decides an order&apos;s business day).</li>
        <li><b>Cut-off</b>: business day D is <i>closed</i> once the clock passes the cut-off on D+1. Only closed days are posted, so each day is invoiced once, complete — never as a partial day that later gets a second invoice.</li>
        <li><b>Run time</b>: when the daily run fires. Keep it <i>after</i> the cut-off so yesterday is already closed. If the server was down at that minute, the run happens as soon as it is back.</li>
        <li><b>Lookback</b>: how many closed days each run re-checks. Re-checking is safe — anything already posted is skipped — and it retries yesterday&apos;s failures automatically.</li>
        <li><b>Outlet mode</b>: AUTOMATIC posts only outlets whose integration mode is AUTOMATIC (or not configured); ALL also posts MANUAL outlets. NONE outlets are never posted.</li>
        <li>If the Odoo pull fails, nothing is posted (unless &ldquo;post if pull fails&rdquo; is on), so no day is invoiced from incomplete data.</li>
        <li>A failed, partial or not-started run, a stalled region, or a stopped scheduler raises an alert (and emails the error-alert recipients).</li>
      </ul>
    </details>
  );
}

function RegionCard({ status: r }: { status: AutomationRegionStatus }) {
  const qc = useQueryClient();
  const s = r.schedule;
  const [form, setForm] = useState<AutomationSettingsInput>({});
  const [simulateAt, setSimulateAt] = useState('');
  const [preview, setPreview] = useState<AutomationPreview | null>(null);

  useEffect(() => {
    setForm({
      runTime: s.runTime,
      cutoffTime: s.cutoffTime,
      lookbackDays: s.lookbackDays,
      outletMode: s.outletMode,
      postIfPullFails: s.postIfPullFails,
      alertOnFailure: s.alertOnFailure,
      staleAfterHours: s.staleAfterHours,
    });
  }, [s.runTime, s.cutoffTime, s.lookbackDays, s.outletMode, s.postIfPullFails, s.alertOnFailure, s.staleAfterHours]);

  const dirty =
    form.runTime !== s.runTime ||
    form.cutoffTime !== s.cutoffTime ||
    form.lookbackDays !== s.lookbackDays ||
    form.outletMode !== s.outletMode ||
    form.postIfPullFails !== s.postIfPullFails ||
    form.alertOnFailure !== s.alertOnFailure ||
    form.staleAfterHours !== s.staleAfterHours;

  const refresh = () => qc.invalidateQueries({ queryKey: ['automation-status'] });

  const save = useMutation({
    mutationFn: () => api.automationSaveSettings(r.region, form),
    onSuccess: () => {
      toast.success(`${r.region} schedule saved`);
      setPreview(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.automationSetEnabled(r.region, enabled),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const dryRun = useMutation({
    mutationFn: () => api.automationPreview(r.region, simulateAt ? new Date(simulateAt).toISOString() : undefined),
    onSuccess: setPreview,
    onError: (e: Error) => toast.error(e.message),
  });
  const runNow = useMutation({
    mutationFn: () => api.automationRunNow(r.region),
    onSuccess: (res) => {
      if (res.started) toast.success(`${r.region}: run started for ${res.plan.window.startDate} → ${res.plan.window.endDate}`);
      else toast.error(`${r.region}: not started — ${res.reason}`);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = <K extends keyof AutomationSettingsInput>(k: K, v: AutomationSettingsInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg">
            {r.region}
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${HEALTH_STYLE[r.health]}`}>
              {HEALTH_LABEL[r.health]}
            </span>
          </CardTitle>
          <CardDescription>{r.healthReason}</CardDescription>
        </div>
        <Toggle
          checked={r.regionEnabled}
          disabled={toggle.isPending}
          onChange={(v) => toggle.mutate(v)}
          label={r.regionEnabled ? `${r.region} automation on` : `${r.region} automation off`}
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Schedule & cut-off */}
          <section className="space-y-3 rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-800">Schedule & cut-off ({r.plan.timeZone})</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Run time (local)">
                <Input type="time" value={form.runTime ?? ''} onChange={(e) => set('runTime', e.target.value)} className="h-9" />
              </Field>
              <Field label="Cut-off (local)">
                <Input type="time" value={form.cutoffTime ?? ''} onChange={(e) => set('cutoffTime', e.target.value)} className="h-9" />
              </Field>
              <Field label="Lookback (closed days)">
                <Input type="number" min={1} max={7} value={form.lookbackDays ?? 1} onChange={(e) => set('lookbackDays', Number(e.target.value))} className="h-9" />
              </Field>
              <Field label="Alert if no success for (h)">
                <Input type="number" min={1} max={168} value={form.staleAfterHours ?? 26} onChange={(e) => set('staleAfterHours', Number(e.target.value))} className="h-9" />
              </Field>
              <Field label="Outlets posted" wide>
                <select
                  value={form.outletMode}
                  onChange={(e) => set('outletMode', e.target.value as 'AUTOMATIC' | 'ALL')}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
                >
                  <option value="AUTOMATIC">AUTOMATIC outlets only</option>
                  <option value="ALL">AUTOMATIC + MANUAL outlets</option>
                </select>
              </Field>
            </div>
            <Check label="Post from backed-up data even if the Odoo pull fails" checked={!!form.postIfPullFails} onChange={(v) => set('postIfPullFails', v)} />
            <Check label="Alert + email on failure / stall" checked={!!form.alertOnFailure} onChange={(v) => set('alertOnFailure', v)} />
            {form.runTime && form.cutoffTime && form.runTime < form.cutoffTime && (
              <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
                Run time is before the cut-off — each run can only post up to the day before yesterday.
              </p>
            )}
            <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              <Save className="mr-1.5 h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save schedule'}
            </Button>
            {s.updatedBy && <p className="text-[11px] text-slate-400">Last changed by {s.updatedBy} · {fmt(s.updatedAt)}</p>}
          </section>

          {/* What happens next */}
          <section className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm">
            <h3 className="font-semibold text-slate-800">Right now</h3>
            <Kv k="Local time" v={r.plan.localNow} />
            <Kv k="Latest closed day" v={r.plan.latestClosedDay} />
            <Kv k="Next run would post" v={`${r.plan.window.startDate} → ${r.plan.window.endDate}`} />
            <Kv k="Next scheduled run" v={r.enabled ? `${r.plan.nextRunLocal} local` : 'automation off'} />
            <Kv k="Scheduler heartbeat" v={fmt(s.lastTickAt)} />
            <ul className="mt-2 space-y-1 text-xs text-slate-500">
              {r.plan.explanation.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          </section>

          {/* Last run */}
          <section className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm">
            <h3 className="font-semibold text-slate-800">Last automatic run</h3>
            <Kv k="Status" v={<span className={`font-semibold ${RUN_STYLE[s.lastRunStatus ?? ''] ?? ''}`}>{s.lastRunStatus ?? 'never'}</span>} />
            <Kv k="Business days" v={s.lastRunWindow ?? '—'} />
            <Kv k="Started" v={`${fmt(s.lastRunStartedAt)}${s.lastRunSource ? ` · ${s.lastRunSource}` : ''}`} />
            <Kv k="Finished" v={fmt(s.lastRunFinishedAt)} />
            <Kv k="Last full success" v={fmt(s.lastSuccessAt)} />
            <Kv k="Failures in a row" v={<span className={s.consecutiveFailures ? 'font-semibold text-red-600' : ''}>{s.consecutiveFailures}</span>} />
            {s.lastRunSummary && <p className="text-xs text-slate-600">{s.lastRunSummary}</p>}
            {s.lastError && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-[11px] text-red-700">{s.lastError}</pre>
            )}
          </section>
        </div>

        {/* Test */}
        <section className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/40 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Test</h3>
              <p className="text-xs text-slate-500">
                Dry run writes nothing. Set a time to check what a run at that moment would post (tests the cut-off).
              </p>
            </div>
            <Field label="Simulate at (your browser time, optional)">
              <Input type="datetime-local" value={simulateAt} onChange={(e) => setSimulateAt(e.target.value)} className="h-9" />
            </Field>
            <Button size="sm" variant="outline" disabled={dryRun.isPending} onClick={() => dryRun.mutate()}>
              <FlaskConical className="mr-1.5 h-4 w-4" /> {dryRun.isPending ? 'Checking…' : 'Dry run'}
            </Button>
            <Button
              size="sm"
              className="bg-violet-600 hover:bg-violet-700"
              disabled={runNow.isPending || r.running}
              onClick={() => {
                if (
                  window.confirm(
                    `Run ${r.region} NOW exactly like the scheduler (${r.plan.window.startDate} → ${r.plan.window.endDate})? This posts to Oracle.`,
                  )
                )
                  runNow.mutate();
              }}
            >
              <Play className="mr-1.5 h-4 w-4" /> {r.running ? 'Running…' : 'Run now (real)'}
            </Button>
          </div>
          {preview && <PreviewResult p={preview} />}
        </section>

        {/* Recent runs */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Recent runs ({r.region})</h3>
            <Link href="/integration-run" className="text-xs text-indigo-600 hover:underline">
              Open Integration Run monitor →
            </Link>
          </div>
          {r.recentRuns.length === 0 ? (
            <p className="text-xs text-slate-400">No runs yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Started</th>
                    <th className="px-3 py-2">By</th>
                    <th className="px-3 py-2">Days</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Invoices</th>
                    <th className="px-3 py-2 text-right">Failed</th>
                    <th className="px-3 py-2 text-right">Step failures</th>
                    <th className="px-3 py-2">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {r.recentRuns.map((j) => (
                    <tr key={j.id} className="border-t border-slate-100">
                      <td className="whitespace-nowrap px-3 py-1.5">{fmt(j.createdAt)}</td>
                      <td className="px-3 py-1.5">{j.source}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">{j.window}</td>
                      <td className={`px-3 py-1.5 font-semibold ${RUN_STYLE[j.status] ?? ''}`}>{j.status}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{j.invoicesCreated}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${j.invoicesFailed ? 'text-red-600' : ''}`}>{j.invoicesFailed}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${j.stepFailures ? 'text-amber-700' : ''}`}>{j.stepFailures}</td>
                      <td className="max-w-xs truncate px-3 py-1.5 text-red-600" title={j.error ?? ''}>{j.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function PreviewResult({ p }: { p: AutomationPreview }) {
  const ready = 'error' in p.readiness ? null : p.readiness;
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <div>
        <div className="font-semibold text-slate-800">
          At {p.plan.localNow} local → posts {p.plan.window.startDate} → {p.plan.window.endDate}
        </div>
        <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
          {p.verdict.map((v) => (
            <li key={v}>• {v}</li>
          ))}
        </ul>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded border border-slate-200 p-3 text-xs">
          <div className="mb-1 font-semibold text-slate-700">Odoo</div>
          {p.odoo.reachable ? (
            <span className="text-emerald-700">Reachable{p.odoo.ordersInWindow != null ? ` · ${p.odoo.ordersInWindow} order(s) in window` : ''}</span>
          ) : (
            <span className="text-red-700">Not reachable: {p.odoo.error}</span>
          )}
        </div>
        <div className="rounded border border-slate-200 p-3 text-xs">
          <div className="mb-1 font-semibold text-slate-700">Outlets</div>
          {p.outlets.willPost} of {p.outlets.stores} active store(s) will be posted.
          {p.outlets.skippedManual.length > 0 && (
            <div className="mt-1 text-amber-700">MANUAL (skipped): {p.outlets.skippedManual.join(', ')}</div>
          )}
          {p.outlets.skippedNone.length > 0 && (
            <div className="mt-1 text-slate-500">NONE (never): {p.outlets.skippedNone.join(', ')}</div>
          )}
        </div>
        <div className="rounded border border-slate-200 p-3 text-xs">
          <div className="mb-1 font-semibold text-slate-700">Oracle readiness</div>
          {!ready ? (
            <span className="text-red-700">{'error' in p.readiness ? p.readiness.error : ''}</span>
          ) : (
            <>
              <span className={ready.ready ? 'text-emerald-700' : 'text-red-700'}>
                {ready.ready ? 'Ready' : `${ready.blockers} blocker(s)`} · {ready.warnings} warning(s)
              </span>
              <ul className="mt-1 space-y-0.5">
                {ready.checks
                  .filter((c) => c.status !== 'PASS')
                  .map((c) => (
                    <li key={c.name} className={c.status === 'FAIL' ? 'text-red-700' : 'text-amber-700'}>
                      {c.status} · {c.name}: {c.detail}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-[11px] uppercase text-slate-500">
          <tr>
            <th className="py-1">Business day</th>
            <th className="py-1 text-right">Orders in backup</th>
            <th className="py-1 text-right">Amount</th>
            <th className="py-1 text-right">Already invoiced</th>
            <th className="py-1 text-right">To post</th>
          </tr>
        </thead>
        <tbody>
          {p.days.map((d) => (
            <tr key={d.businessDay} className="border-t border-slate-100">
              <td className="py-1">{d.businessDay}</td>
              <td className="py-1 text-right tabular-nums">{d.ordersInBackup}</td>
              <td className="py-1 text-right tabular-nums">{d.amountInBackup.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
              <td className="py-1 text-right tabular-nums">{d.ordersAlreadyInvoiced}</td>
              <td className="py-1 text-right font-semibold tabular-nums">{d.ordersToPost}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-400">
        Backup figures are what is stored now; a real run pulls Odoo first, so late orders are included.
      </p>
    </div>
  );
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
        checked ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500'
      }`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      {label}
    </button>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? 'col-span-2' : ''}`}>
      <span className="text-[11px] font-medium text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-600">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      {label}
    </label>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-slate-500">{k}</span>
      <span className="text-right text-slate-800">{v}</span>
    </div>
  );
}
