'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SyncJob } from '@/lib/api';
import { toast } from 'sonner';
import { ArrowRight, CheckCircle2, Info, Loader2, Send, XCircle } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate, getStatusColor } from '@/lib/utils';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function JobResultCard({ job }: { job: SyncJob }) {
  const isRunning = !TERMINAL_STATUSES.has(job.status);

  return (
    <Card className="max-w-lg">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base">Job Progress</CardTitle>
        {isRunning && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-500">Job ID</dt>
            <dd className="font-mono text-xs text-gray-700">{job.id}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Status</dt>
            <dd>
              <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(job.status)}`}>
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
            <dt className="text-gray-500">Created by</dt>
            <dd className="text-gray-600">{job.createdBy}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Created at</dt>
            <dd className="text-gray-400">{formatDate(job.createdAt)}</dd>
          </div>
          {job.errorMessage && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <span className="font-semibold">Error: </span>{job.errorMessage}
            </div>
          )}
        </dl>
        <div className="mt-4 border-t pt-3">
          <Link href="/orders" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
            View full order history <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PushOrderPage() {
  const qc = useQueryClient();
  const [orderId, setOrderId] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

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

  const mutation = useMutation({
    mutationFn: () => api.pushOrder(orderId.trim()),
    onSuccess: (job) => {
      toast.success(`Sync job created for order ${orderId.trim()}`);
      setActiveJobId(job.id);
      setOrderId('');
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const displayJob = polledJob ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Push Single Order</h1>
          <p className="mt-0.5 text-sm text-slate-500">Manually trigger sync for a specific Odoo order ID</p>
        </div>
      </div>

      <Card className="max-w-lg border-blue-100 bg-blue-50">
        <CardContent className="pt-4">
          <div className="flex gap-2 text-sm text-blue-800">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
            <div className="space-y-1">
              <p className="font-semibold">How it works</p>
              <ol className="list-inside list-decimal space-y-0.5 text-blue-700">
                <li>Enter the Odoo sale order number (e.g. <span className="font-mono">S00123</span>) and click <strong>Push Order</strong>.</li>
                <li>A sync job is created and queued — the order data is fetched from Odoo and sent to Oracle.</li>
                <li>The <strong>Job Progress</strong> card below updates automatically every 3 seconds until the job finishes.</li>
                <li>Check <strong>Succeeded / Failed</strong> counts and any error message for the result.</li>
                <li>Use the <strong>Orders</strong> page to view the full history or retry failed jobs.</li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Order Sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="orderId">Odoo Order ID</Label>
            <Input
              id="orderId"
              placeholder="e.g. S00123"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && orderId.trim()) mutation.mutate();
              }}
            />
            <p className="mt-1 text-xs text-gray-400">Enter the Odoo sale order number or internal ID</p>
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!orderId.trim() || mutation.isPending}
          >
            <Send className="mr-2 h-4 w-4" />
            {mutation.isPending ? 'Pushing...' : 'Push Order'}
          </Button>
        </CardContent>
      </Card>

      {displayJob && <JobResultCard job={displayJob} />}
    </div>
  );
}
