'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight } from 'lucide-react';

export function SyncJobsTable() {
  const { data: jobs } = useQuery({
    queryKey: ['sync-jobs-table'],
    queryFn: () => api.listSyncJobs(),
    refetchInterval: 5000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <CardTitle>Recent Sync Jobs</CardTitle>
        <Link
          href="/sync-jobs"
          className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/70">
                <th className="px-6 pb-3 pt-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Type</th>
                <th className="px-4 pb-3 pt-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
                <th className="px-4 pb-3 pt-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Progress</th>
                <th className="px-6 pb-3 pt-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs?.slice(0, 8).map((job) => {
                const pct = job.totalRecords > 0 ? Math.round((job.processedRecords / job.totalRecords) * 100) : 0;
                return (
                  <tr key={job.id} className="transition-colors hover:bg-slate-50/60">
                    <td className="px-6 py-3 font-medium text-slate-800">{job.jobType}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${getStatusColor(job.status)}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-indigo-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-slate-500">
                          {job.processedRecords}/{job.totalRecords}
                        </span>
                        {job.failedCount > 0 && (
                          <span className="text-xs font-semibold text-red-500">+{job.failedCount}✗</span>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-6 py-3 text-xs text-slate-400">{formatDate(job.createdAt)}</td>
                  </tr>
                );
              })}
              {(!jobs || jobs.length === 0) && (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-sm text-slate-400">
                    No sync jobs yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
