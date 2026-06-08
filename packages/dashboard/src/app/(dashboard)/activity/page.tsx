'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function ActivityPage() {
  const { data: logs, isLoading } = useQuery({
    queryKey: ['recent-activity'],
    queryFn: () => api.getRecentActivity(100),
    refetchInterval: 15000,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="pb-3 pr-4">External ID</th>
                    <th className="pb-3 pr-4">Operation</th>
                    <th className="pb-3 pr-4">System</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3 pr-4">Duration</th>
                    <th className="pb-3">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {logs?.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="py-3 pr-4 font-mono text-xs">{log.externalId}</td>
                      <td className="py-3 pr-4">{log.operation}</td>
                      <td className="py-3 pr-4 text-gray-500">{log.externalSystem}</td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(log.status)}`}>
                          {log.status}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-gray-500">{log.processingDurationMs}ms</td>
                      <td className="whitespace-nowrap py-3 text-gray-400">{formatDate(log.createdAt)}</td>
                    </tr>
                  ))}
                  {(!logs || logs.length === 0) && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-gray-400">
                        No activity yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
