'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, OdooOrderAnalysis, LiveReconcileResult } from '@/lib/api';
import { ShieldCheck, Search, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

function healthTone(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('healthy')) return 'bg-emerald-100 text-emerald-700';
  if (t.startsWith('no ')) return 'bg-red-100 text-red-700';
  return 'bg-amber-100 text-amber-700';
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{label}</div>
    </div>
  );
}

function KvBlock({
  title,
  data,
}: {
  title: string;
  data?: Record<string, unknown>;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-1 text-xs font-semibold text-slate-600">{title}</div>
      {!data ? (
        <div className="text-xs text-slate-400">—</div>
      ) : (
        <div className="space-y-0.5">
          {Object.entries(data).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 text-xs">
              <span className="text-slate-500">{k}</span>
              <span className="font-mono text-slate-800">
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ReconciliationPage() {
  const { data } = useQuery({
    queryKey: ['odoo-reconciliation'],
    queryFn: () => api.getOdooReconciliation(),
    refetchInterval: 60_000,
  });

  const [orderId, setOrderId] = useState('');
  const [analysis, setAnalysis] = useState<OdooOrderAnalysis | null>(null);
  const analyze = useMutation({
    mutationFn: (id: string) => api.analyzeOdooOrder(id),
    onSuccess: (res) => setAnalysis(res),
    onError: () => setAnalysis(null),
  });

  // Live fetch-vs-stored reconciliation (best for the live region, SN).
  const [region, setRegion] = useState('SN');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [live, setLive] = useState<LiveReconcileResult | null>(null);
  const reconcile = useMutation({
    mutationFn: () => api.liveReconcile(region, startDate, endDate),
    onSuccess: (res) => setLive(res),
    onError: () => setLive(null),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            Odoo Data Reconciliation
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Confirm the data fetched from Odoo was stored accurately — embedded
            line/payment coverage, and a per-order fetched-vs-stored comparison.
          </p>
        </div>
      </div>

      {/* Live fetch-vs-stored reconciliation */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="h-5 w-5 text-emerald-600" />
            Live reconcile — Odoo API vs stored
          </CardTitle>
          <CardDescription>
            Asks Odoo how many orders exist for a region + date range and compares
            it to what&apos;s stored. Read-only. Works for live regions (SN);
            expired tenants report unreachable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="text-xs text-slate-500">Region</label>
              <Input
                value={region}
                onChange={(e) => setRegion(e.target.value.toUpperCase())}
                className="mt-1 h-9 w-24"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500">From</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500">To</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <Button
              disabled={
                !region || !startDate || !endDate || reconcile.isPending
              }
              onClick={() => reconcile.mutate()}
            >
              {reconcile.isPending ? 'Checking…' : 'Reconcile'}
            </Button>
          </div>

          {reconcile.isError && (
            <p className="text-sm text-red-600">
              Reconcile failed — check the region has an active credential.
            </p>
          )}

          {live && (
            <div className="rounded-lg border border-slate-200 p-4">
              {!live.apiReachable ? (
                <p className="text-sm text-amber-600">
                  {live.note ?? 'Odoo API not reachable for this region.'}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Tile
                      label="Odoo API says"
                      value={live.apiTotal ?? '—'}
                    />
                    <Tile label="Stored" value={live.storedCount} />
                    <div
                      className={`rounded-lg border px-4 py-3 ${
                        live.inSync
                          ? 'border-emerald-200 bg-emerald-50'
                          : 'border-red-200 bg-red-50'
                      }`}
                    >
                      <div
                        className={`text-2xl font-bold ${
                          live.inSync ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {live.inSync
                          ? 'In sync'
                          : live.difference != null
                            ? `${live.difference > 0 ? '+' : ''}${live.difference}`
                            : '—'}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {live.inSync
                          ? 'API matches stored'
                          : 'difference (API − stored)'}
                      </div>
                    </div>
                  </div>
                  {live.note && (
                    <p className="mt-2 text-xs text-amber-600">{live.note}</p>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-indigo-600" />
            Backup integrity
          </CardTitle>
          <CardDescription>
            Across all stored Odoo orders — are lines and payments coming through?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!data ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Tile label="Orders stored" value={data.summary.totalOrders} />
                <Tile label="Line items" value={data.summary.totalLines} />
                <Tile label="Payments" value={data.summary.totalPayments} />
                <Tile
                  label="Avg lines/order"
                  value={data.summary.avgLinesPerOrder.toFixed(1)}
                />
                <Tile
                  label="Avg payments/order"
                  value={data.summary.avgPaymentsPerOrder.toFixed(1)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${healthTone(
                    data.diagnosis.linesIssue,
                  )}`}
                >
                  Lines: {data.diagnosis.linesIssue}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${healthTone(
                    data.diagnosis.paymentsIssue,
                  )}`}
                >
                  Payments: {data.diagnosis.paymentsIssue}
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="h-5 w-5 text-indigo-600" />
            Verify one order
          </CardTitle>
          <CardDescription>
            Enter an Odoo order id to compare what the API returned (embedded in
            the stored raw payload) against the parsed rows actually stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="Odoo order id (e.g. 12345)"
              className="h-9 w-64"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && orderId.trim())
                  analyze.mutate(orderId.trim());
              }}
            />
            <Button
              disabled={!orderId.trim() || analyze.isPending}
              onClick={() => analyze.mutate(orderId.trim())}
            >
              <Search className="mr-1 h-4 w-4" />
              Analyze
            </Button>
          </div>

          {analyze.isError && (
            <p className="text-sm text-red-600">
              Could not analyze that order — check the id exists in the backup.
            </p>
          )}

          {analysis && (
            <div>
              <div className="mb-2 text-sm font-medium text-slate-700">
                Order {analysis.orderName ?? analysis.orderId}
              </div>
              {analysis.error ? (
                <p className="text-sm text-amber-600">{analysis.error}</p>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <KvBlock
                    title="Line items (from API payload)"
                    data={analysis.lineItems}
                  />
                  <KvBlock
                    title="Payments (from API payload)"
                    data={analysis.payments}
                  />
                  <KvBlock
                    title="Stored counts"
                    data={analysis.actualCounts}
                  />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
