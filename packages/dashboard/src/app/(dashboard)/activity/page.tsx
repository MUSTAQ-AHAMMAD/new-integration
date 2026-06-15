'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/ui/error-state';

export default function ActivityPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data: logs, isLoading, isError } = useQuery({
    queryKey: ['recent-activity'],
    queryFn: () => api.getRecentActivity(200),
    refetchInterval: 15000,
  });

  const filtered = useMemo(() => {
    if (!logs) return [];
    return logs.filter((log) => {
      const matchesSearch =
        !search ||
        log.externalId.toLowerCase().includes(search.toLowerCase()) ||
        log.operation.toLowerCase().includes(search.toLowerCase()) ||
        log.externalSystem.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = !statusFilter || log.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [logs, search, statusFilter]);

  const statuses = useMemo(
    () => [...new Set((logs ?? []).map((l) => l.status))].sort(),
    [logs],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <h1 className="text-xl font-bold text-slate-900">Audit Log</h1>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>
              Recent Activity
              {logs && (
                <span className="ml-2 text-sm font-normal text-gray-400">
                  {filtered.length} / {logs.length}
                </span>
              )}
            </CardTitle>
            <div className="flex gap-2">
              <Input
                placeholder="Search ID, operation, system…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-56 text-sm"
              />
              <select
                className="rounded border px-2 py-1 text-sm"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All Status</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
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
                    <th className="pb-3 pr-4">External ID</th>
                    <th className="pb-3 pr-4">Operation</th>
                    <th className="pb-3 pr-4">System</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3 pr-4">Duration</th>
                    <th className="pb-3">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((log) => (
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
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-gray-400">
                        {search || statusFilter ? 'No records match your filters' : 'No activity yet'}
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
