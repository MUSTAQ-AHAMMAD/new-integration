'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getStatusColor } from '@/lib/utils';
import { ArrowRight, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function SyncJobsTable() {
  const qc = useQueryClient();
  const { data: jobs } = useQuery({
    queryKey: ['sync-jobs-table'],
    queryFn: () => api.listSyncJobs(),
    refetchInterval: 30000,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelSyncJob(id),
    onSuccess: () => {
      toast.success('Job cancelled');
      qc.invalidateQueries({ queryKey: ['sync-jobs-table'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="overflow-hidden rounded-2xl border border-white/60 bg-white shadow-md shadow-slate-200/60">
      {/* Header band */}
      <div className="border-b border-slate-100 bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-md shadow-blue-200">
              <RefreshCw className="h-5 w-5 text-white" />
            </div>
            <h3 className="text-sm font-bold text-slate-800">Recent Sync Jobs</h3>
          </div>
          <Link
            href="/sync-jobs"
            className="flex items-center gap-1.5 rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-100 hover:text-indigo-700"
          >
            View all <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/70">
              <th className="px-6 pb-3 pt-3 text-left text-xs font-bold uppercase tracking-wider text-slate-400">Type</th>
              <th className="px-4 pb-3 pt-3 text-left text-xs font-bold uppercase tracking-wider text-slate-400">Status</th>
              <th className="px-4 pb-3 pt-3 text-left text-xs font-bold uppercase tracking-wider text-slate-400">Progress</th>
              <th className="px-6 pb-3 pt-3 text-left text-xs font-bold uppercase tracking-wider text-slate-400">Created</th>
              <th className="px-4 pb-3 pt-3 text-left text-xs font-bold uppercase tracking-wider text-slate-400">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {jobs?.slice(0, 8).map((job) => {
              const pct = job.totalRecords > 0 ? Math.round((job.processedRecords / job.totalRecords) * 100) : 0;
              return (
                <tr key={job.id} className="transition-colors hover:bg-indigo-50/30">
                  <td className="px-6 py-3.5 font-semibold text-slate-800">{job.jobType}</td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${getStatusColor(job.status)}`}>
                      {job.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-slate-500">
                        {job.processedRecords}/{job.totalRecords}
                      </span>
                      {job.failedCount > 0 && (
                        <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-600">
                          +{job.failedCount} ✗
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-6 py-3.5 text-xs text-slate-400">{formatDate(job.createdAt)}</td>
                  <td className="px-4 py-3.5">
                    {['PENDING', 'PROCESSING'].includes(job.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancelMutation.mutate(job.id)}
                        disabled={cancelMutation.isPending}
                        className="h-7 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                        title="Cancel job"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {(!jobs || jobs.length === 0) && (
              <tr>
                <td colSpan={5} className="py-12 text-center">
                  <RefreshCw className="mx-auto mb-2 h-8 w-8 text-slate-200" />
                  <p className="text-sm font-medium text-slate-400">No sync jobs yet</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

