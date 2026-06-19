'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function FetchOdooPage() {
  const [branchId, setBranchId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [limit, setLimit] = useState('100');

  const fetchMutation = useMutation({
    mutationFn: () =>
      api.fetchOdooOrders({
        branchId: branchId ? Number(branchId) : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit: limit ? Number(limit) : 100,
      }),
    onSuccess: (result) => {
      toast.success(
        `Fetched ${result.fetched} orders from Odoo — ingested: ${result.ingested}, skipped: ${result.skipped}`,
      );
    },
    onError: (e: Error) => toast.error(`Odoo fetch failed: ${e.message}`),
  });

  const result = fetchMutation.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Fetch Orders from Odoo</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Manually pull orders from the Odoo REST API and ingest them into the sync queue.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-5 w-5 text-indigo-600" />
            Fetch Parameters
          </CardTitle>
          <CardDescription>
            All parameters are optional. Leave blank to fetch up to <strong>limit</strong> recent orders across all branches.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="branch-id">Branch ID</Label>
              <Input
                id="branch-id"
                type="number"
                placeholder="e.g. 5"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="start-date">Start Date</Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="end-date">End Date</Label>
              <Input
                id="end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="limit">Limit</Label>
              <Input
                id="limit"
                type="number"
                min={1}
                max={1000}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                className="mt-1.5"
              />
            </div>
          </div>

          <Button
            onClick={() => fetchMutation.mutate()}
            disabled={fetchMutation.isPending}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${fetchMutation.isPending ? 'animate-spin' : ''}`} />
            {fetchMutation.isPending ? 'Fetching from Odoo…' : 'Fetch Orders'}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fetch Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-2xl font-bold text-slate-900">{result.fetched}</p>
                <p className="text-xs text-slate-500">Orders Fetched</p>
              </div>
              <div className="rounded-lg bg-green-50 p-4">
                <p className="text-2xl font-bold text-green-700">{result.ingested}</p>
                <p className="text-xs text-slate-500">Ingested</p>
              </div>
              <div className="rounded-lg bg-yellow-50 p-4">
                <p className="text-2xl font-bold text-yellow-700">{result.skipped}</p>
                <p className="text-xs text-slate-500">Skipped / Errors</p>
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
      )}
    </div>
  );
}
