'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate, getStatusColor } from '@/lib/utils';

export default function PushOrderPage() {
  const qc = useQueryClient();
  const [orderId, setOrderId] = useState('');
  const [lastJob, setLastJob] = useState<Awaited<ReturnType<typeof api.pushOrder>> | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.pushOrder(orderId.trim()),
    onSuccess: (job) => {
      toast.success(`Sync job created for order ${orderId.trim()}`);
      setLastJob(job);
      setOrderId('');
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Push Single Order</h1>
          <p className="mt-0.5 text-sm text-slate-500">Manually trigger sync for a specific Odoo order ID</p>
        </div>
      </div>

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
