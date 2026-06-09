'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getStatusColor } from '@/lib/utils';
import { toast } from 'sonner';
import { CreateSyncJobModal } from '@/components/sync/create-sync-job-modal';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';

export default function SyncJobsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('');

  const { data: jobs, isLoading, isError } = useQuery({
    queryKey: ['sync-jobs', statusFilter],
    queryFn: () => api.listSyncJobs(statusFilter || undefined),
    refetchInterval: 5000,
  });

  const { data: queueStats } = useQuery({
    queryKey: ['queue-stats'],
    queryFn: api.getQueueStats,
    refetchInterval: 5000,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelSyncJob(id),
    onSuccess: () => {
      toast.success('Job cancelled');
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.retrySyncJob(id),
    onSuccess: () => {
      toast.success('Job queued for retry');
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Jobs</h1>
          <p className="text-sm text-gray-500">Manage and monitor synchronization jobs</p>
        </div>
        <CreateSyncJobModal />
      </div>

      {queueStats && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: 'Waiting', value: queueStats.orderSync.waiting, color: 'text-yellow-600 bg-yellow-50' },
            { label: 'Active', value: queueStats.orderSync.active, color: 'text-blue-600 bg-blue-50' },
            { label: 'Failed (Queue)', value: queueStats.orderSync.failed, color: 'text-red-600 bg-red-50' },
            { label: 'Completed (Queue)', value: queueStats.orderSync.completed, color: 'text-green-600 bg-green-50' },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500">{label}</p>
              <p className={`mt-1 text-2xl font-bold ${color.split(' ')[0]}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle>All Jobs</CardTitle>
            <select
              className="rounded border px-2 py-1 text-sm"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">All Status</option>
              {['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL', 'CANCELLED'].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : isError ? (
            <ErrorState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="pb-3 pr-4">Job Type</th>
                    <th className="pb-3 pr-4">Scope</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3 pr-4">Progress</th>
                    <th className="pb-3 pr-4">Created By</th>
                    <th className="pb-3 pr-4">Created</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {jobs?.map((job) => (
                    <tr key={job.id} className="hover:bg-gray-50">
                      <td className="py-3 pr-4 font-medium">{job.jobType}</td>
                      <td className="py-3 pr-4 text-gray-500">{job.scopeType}</td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(job.status)}`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="text-xs text-gray-500">
                          {job.processedRecords}/{job.totalRecords}
                          {job.failedCount > 0 && <span className="ml-1 text-red-500">({job.failedCount} failed)</span>}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-gray-500">{job.createdBy}</td>
                      <td className="whitespace-nowrap py-3 pr-4 text-gray-500">{formatDate(job.createdAt)}</td>
                      <td className="flex gap-1 py-3">
                        {['PENDING', 'PROCESSING'].includes(job.status) && (
                          <Button size="sm" variant="outline" onClick={() => cancelMutation.mutate(job.id)}>
                            Cancel
                          </Button>
                        )}
                        {job.status === 'FAILED' && (
                          <Button size="sm" variant="outline" onClick={() => retryMutation.mutate(job.id)}>
                            Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(!jobs || jobs.length === 0) && <div className="py-8 text-center text-gray-400">No sync jobs found</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
