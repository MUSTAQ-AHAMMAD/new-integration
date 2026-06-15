'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { formatDate, getStatusColor } from '@/lib/utils';

export default function PushStorePage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState('');
  const [lastJob, setLastJob] = useState<Awaited<ReturnType<typeof api.pushStore>> | null>(null);

  const { data: stores, isLoading: storesLoading } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api.listStores(),
  });

  const mutation = useMutation({
    mutationFn: () => api.pushStore(selected),
    onSuccess: (job) => {
      toast.success(`Sync job created for store ${selected}`);
      setLastJob(job);
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Push Single Store</h1>
          <p className="mt-0.5 text-sm text-slate-500">Manually trigger a full order sync for a specific store branch</p>
        </div>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Store Sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="storeSelect">Select Store</Label>
            {storesLoading ? (
              <div className="mt-1 text-sm text-gray-400">Loading stores...</div>
            ) : (
              <select
                id="storeSelect"
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">— Choose a store —</option>
                {stores?.map((store) => (
                  <option key={store.branchCode} value={store.branchCode}>
                    {store.branchCode} — {store.branchName}
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1 text-xs text-gray-400">All pending orders for this branch will be queued for sync</p>
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!selected || mutation.isPending}
          >
            <Send className="mr-2 h-4 w-4" />
            {mutation.isPending ? 'Pushing...' : 'Push Store'}
          </Button>
        </CardContent>
      </Card>

      {lastJob && (
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Last Job Result</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Job ID</dt>
                <dd className="font-mono text-xs">{lastJob.id}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Status</dt>
                <dd>
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(lastJob.status)}`}>
                    {lastJob.status}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Created</dt>
                <dd className="text-gray-400">{formatDate(lastJob.createdAt)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
