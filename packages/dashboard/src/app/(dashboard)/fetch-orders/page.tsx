'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function FetchResultCard({ result }: { result: { fetched: number; backedUp: number; backupSkipped: number; ingested: number; skipped: number; errors: string[] } }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Fetch Result</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-4 text-center sm:grid-cols-5">
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-2xl font-bold text-slate-900">{result.fetched}</p>
            <p className="text-xs text-slate-500">Fetched</p>
          </div>
          <div className="rounded-lg bg-blue-50 p-4">
            <p className="text-2xl font-bold text-blue-700">{result.backedUp}</p>
            <p className="text-xs text-slate-500">Backed Up</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-2xl font-bold text-slate-500">{result.backupSkipped}</p>
            <p className="text-xs text-slate-500">Backup Skipped</p>
          </div>
          <div className="rounded-lg bg-green-50 p-4">
            <p className="text-2xl font-bold text-green-700">{result.ingested}</p>
            <p className="text-xs text-slate-500">Ingested</p>
          </div>
          <div className="rounded-lg bg-yellow-50 p-4">
            <p className="text-2xl font-bold text-yellow-700">{result.skipped}</p>
            <p className="text-xs text-slate-500">Skipped</p>
          </div>
        </div>
        {result.errors.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="mb-1 text-xs font-semibold text-red-700">Errors ({result.errors.length})</p>
            <ul className="space-y-0.5 text-xs text-red-600">
              {result.errors.slice(0, 10).map((err, i) => (
                <li key={i} className="truncate">• {err}</li>
              ))}
              {result.errors.length > 10 && (
                <li className="text-red-500">…and {result.errors.length - 10} more</li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OdooFetchTab() {
  const [credentialId, setCredentialId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [limit, setLimit] = useState('100');

  const { data: credentials = [], isLoading: loadingCreds } = useQuery({
    queryKey: ['odoo-credentials'],
    queryFn: () => api.listOdooCredentials(),
  });

  const fetchMutation = useMutation({
    mutationFn: () =>
      api.fetchOdooOrders({
        credentialId: credentialId || undefined,
        branchId: branchId ? Number(branchId) : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit: limit ? Number(limit) : 100,
      }),
    onSuccess: (result) => {
      toast.success(`Fetched ${result.fetched} orders from Odoo — ingested: ${result.ingested}, skipped: ${result.skipped}`);
    },
    onError: (e: Error) => toast.error(`Odoo fetch failed: ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-5 w-5 text-indigo-600" />
            Fetch Parameters
          </CardTitle>
          <CardDescription>
            Select a region credential to use its specific Odoo instance, or leave blank to use
            the global instance configured via environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="odoo-credential">Region / Credential</Label>
            <select
              id="odoo-credential"
              value={credentialId}
              onChange={(e) => setCredentialId(e.target.value)}
              className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">
                {loadingCreds ? 'Loading credentials…' : '— Global (env var) —'}
              </option>
              {credentials.map((cred) => (
                <option key={cred.id} value={cred.id}>
                  {cred.region} — {cred.baseUrl}
                  {cred.apiPath ? ` (${cred.apiPath})` : ' (auto-detect)'}
                  {!cred.active ? ' [inactive]' : ''}
                </option>
              ))}
            </select>
            {credentials.length === 0 && !loadingCreds && (
              <p className="mt-1 text-xs text-slate-400">
                No per-region credentials configured. Add credentials via{' '}
                <a href="/admin/odoo-credentials" className="underline">Admin → Odoo Credentials</a>.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="odoo-branch-id">Branch ID</Label>
              <Input id="odoo-branch-id" type="number" placeholder="e.g. 5" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="odoo-start-date">Start Date</Label>
              <Input id="odoo-start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="odoo-end-date">End Date</Label>
              <Input id="odoo-end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="odoo-limit">Limit</Label>
              <Input id="odoo-limit" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} className="mt-1.5" />
            </div>
          </div>

          <Button onClick={() => fetchMutation.mutate()} disabled={fetchMutation.isPending} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${fetchMutation.isPending ? 'animate-spin' : ''}`} />
            {fetchMutation.isPending ? 'Fetching from Odoo…' : 'Fetch Orders'}
          </Button>
        </CardContent>
      </Card>

      {fetchMutation.data && <FetchResultCard result={fetchMutation.data} />}
    </div>
  );
}

function IbqFetchTab() {
  const [credentialId, setCredentialId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [branchId, setBranchId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [limit, setLimit] = useState('100');

  const { data: credentials = [], isLoading: loadingCreds } = useQuery({
    queryKey: ['ibq-credentials'],
    queryFn: () => api.listIbqCredentials(),
  });

  const fetchMutation = useMutation({
    mutationFn: () =>
      api.fetchIbqOrders({
        credentialId,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        branchId: branchId ? Number(branchId) : undefined,
        companyId: companyId ? Number(companyId) : undefined,
        limit: limit ? Number(limit) : 100,
      }),
    onSuccess: (result) => {
      toast.success(`Fetched ${result.fetched} orders from IBQ — ingested: ${result.ingested}, skipped: ${result.skipped}`);
    },
    onError: (e: Error) => toast.error(`IBQ fetch failed: ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-5 w-5 text-violet-600" />
            Fetch Parameters
          </CardTitle>
          <CardDescription>
            Select a credential and optionally filter by date range, branch, or company.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="ibq-credential">Credential</Label>
            <select
              id="ibq-credential"
              value={credentialId}
              onChange={(e) => setCredentialId(e.target.value)}
              className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">{loadingCreds ? 'Loading credentials…' : '— Select a credential —'}</option>
              {credentials.map((cred) => (
                <option key={cred.id} value={cred.id}>
                  {cred.region} — {cred.baseUrl}
                  {cred.companyId ? ` (company ${cred.companyId})` : ''}
                  {!cred.active ? ' [inactive]' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="ibq-start-date">Start Date</Label>
              <Input id="ibq-start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="ibq-end-date">End Date</Label>
              <Input id="ibq-end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="ibq-branch-id">Branch ID</Label>
              <Input id="ibq-branch-id" type="number" placeholder="e.g. 5" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="ibq-company-id">Company ID</Label>
              <Input id="ibq-company-id" type="number" placeholder="e.g. 1" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="mt-1.5" />
            </div>
          </div>

          <div className="w-40">
            <Label htmlFor="ibq-limit">Limit</Label>
            <Input id="ibq-limit" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} className="mt-1.5" />
          </div>

          <Button onClick={() => fetchMutation.mutate()} disabled={fetchMutation.isPending || !credentialId} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${fetchMutation.isPending ? 'animate-spin' : ''}`} />
            {fetchMutation.isPending ? 'Fetching from IBQ…' : 'Fetch Orders'}
          </Button>
        </CardContent>
      </Card>

      {fetchMutation.data && <FetchResultCard result={fetchMutation.data} />}
    </div>
  );
}

export default function FetchOrdersPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Fetch Orders</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Manually pull orders from Odoo or IBQ and ingest them into the sync queue.
          </p>
        </div>
      </div>

      <Tabs defaultValue="odoo">
        <TabsList>
          <TabsTrigger value="odoo">Odoo</TabsTrigger>
          <TabsTrigger value="ibq">IBQ</TabsTrigger>
        </TabsList>
        <TabsContent value="odoo">
          <OdooFetchTab />
        </TabsContent>
        <TabsContent value="ibq">
          <IbqFetchTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
