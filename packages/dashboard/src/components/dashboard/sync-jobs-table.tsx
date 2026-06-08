'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function SyncJobsTable() {
  const { data: jobs } = useQuery({
    queryKey: ['sync-jobs-table'],
    queryFn: () => api.listSyncJobs(),
    refetchInterval: 5000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Recent Sync Jobs</CardTitle>
        <Link href="/sync-jobs" className="text-xs text-blue-600 hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="pb-2 pr-4">Type</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Progress</th>
                <th className="pb-2">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs?.slice(0, 8).map((job) => (
                <tr key={job.id} className="hover:bg-gray-50">
                  <td className="py-2 pr-4 font-medium">{job.jobType}</td>
                  <td className="py-2 pr-4">
                    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(job.status)}`}>
                      {job.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-xs text-gray-500">
                    {job.processedRecords}/{job.totalRecords}
                    {job.failedCount > 0 && <span className="ml-1 text-red-500">({job.failedCount}✗)</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 text-xs text-gray-400">{formatDate(job.createdAt)}</td>
                </tr>
              ))}
              {(!jobs || jobs.length === 0) && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-gray-400">
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
