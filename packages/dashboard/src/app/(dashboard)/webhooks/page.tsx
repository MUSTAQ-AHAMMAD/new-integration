'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/ui/error-state';

export default function WebhookEventsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data: events, isLoading, isError } = useQuery({
    queryKey: ['webhook-events'],
    queryFn: () => api.getWebhookEvents(200),
    refetchInterval: 10000,
  });

  const filtered = useMemo(() => {
    if (!events) return [];
    return events.filter((ev) => {
      const matchesSearch =
        !search ||
        ev.eventType.toLowerCase().includes(search.toLowerCase()) ||
        ev.sourceSystem.toLowerCase().includes(search.toLowerCase()) ||
        ev.id.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = !statusFilter || ev.processingStatus === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [events, search, statusFilter]);

  const statuses = useMemo(
    () => [...new Set((events ?? []).map((e) => e.processingStatus))].sort(),
    [events],
  );

  const pendingCount = events?.filter((e) => e.processingStatus === 'PENDING').length ?? 0;
  const failedCount = events?.filter((e) => e.processingStatus === 'FAILED').length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Webhook Events</h1>
        <p className="mt-1 text-sm text-gray-500">Inbound events received from Odoo and other systems</p>
      </div>

      {(pendingCount > 0 || failedCount > 0) && (
        <div className="flex gap-3">
          {pendingCount > 0 && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
              ⏳ {pendingCount} event{pendingCount !== 1 ? 's' : ''} pending processing
            </div>
          )}
          {failedCount > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              ⚠️ {failedCount} event{failedCount !== 1 ? 's' : ''} failed processing
            </div>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>
              Recent Events
              {events && (
                <span className="ml-2 text-sm font-normal text-gray-400">
                  {filtered.length} / {events.length}
                </span>
              )}
            </CardTitle>
            <div className="flex gap-2">
              <Input
                placeholder="Search type, system, ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-52 text-sm"
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
                    <th className="pb-3 pr-4">Event Type</th>
                    <th className="pb-3 pr-4">Source</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3 pr-4">Received</th>
                    <th className="pb-3 pr-4">Processed</th>
                    <th className="pb-3">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((ev) => (
                    <tr
                      key={ev.id}
                      className={`hover:bg-gray-50 ${ev.processingStatus === 'FAILED' ? 'bg-red-50' : ''}`}
                    >
                      <td className="py-3 pr-4 font-medium">{ev.eventType}</td>
                      <td className="py-3 pr-4 text-gray-500">{ev.sourceSystem}</td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(ev.processingStatus)}`}>
                          {ev.processingStatus}
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-3 pr-4 text-gray-400">{formatDate(ev.receivedAt)}</td>
                      <td className="whitespace-nowrap py-3 pr-4 text-gray-400">
                        {ev.processedAt ? formatDate(ev.processedAt) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="max-w-xs truncate py-3 text-xs text-red-600" title={ev.processingError ?? undefined}>
                        {ev.processingError ?? <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-gray-400">
                        {search || statusFilter ? 'No events match your filters' : 'No webhook events yet'}
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
