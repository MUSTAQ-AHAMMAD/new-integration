'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, History, Play, TableProperties } from 'lucide-react';
import { toast } from 'sonner';
import { api, authStorage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  branchCode?: string;
  userId?: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  errorMessage?: string;
  statusCode?: number;
  durationMs?: number;
  correlationId?: string;
  createdAt: string;
}

const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
const PAGE_SIZE = 50;
const ACTION_OPTIONS = ['ALL', 'CREATE', 'UPDATE', 'SYNC', 'RETRY', 'RESOLVE', 'WEBHOOK'] as const;
const ENTITY_OPTIONS = ['ALL', 'ORDER', 'PAYMENT', 'STORE', 'REFUND', 'SYSTEM'] as const;
const STATUS_OPTIONS = ['ALL', 'SUCCESS', 'FAILED'] as const;

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const token = authStorage.getToken();
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
    ...options,
  });

  if (response.status === 401) {
    authStorage.clearToken();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function getStatusLabel(entry: AuditEntry): 'SUCCESS' | 'FAILED' {
  return (entry.statusCode ?? 200) < 400 ? 'SUCCESS' : 'FAILED';
}

function downloadCsv(filename: string, headers: string[], rows: string[][]): void {
  const escapeCell = (cell: string) => `"${cell.replaceAll('"', '""')}"`;
  const csv = [headers.map(escapeCell).join(','), ...rows.map((row) => row.map((cell) => escapeCell(cell)).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(url);
}

export default function AuditPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [orderId, setOrderId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [actionFilter, setActionFilter] = useState<(typeof ACTION_OPTIONS)[number]>('ALL');
  const [entityFilter, setEntityFilter] = useState<(typeof ENTITY_OPTIONS)[number]>('ALL');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_OPTIONS)[number]>('ALL');
  const [timelineView, setTimelineView] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);

  const { data: auditEntries, isLoading, isError } = useQuery({
    queryKey: ['audit-entries'],
    queryFn: () => apiRequest<AuditEntry[]>('/audit'),
  });

  const replayMutation = useMutation({
    mutationFn: (entry: AuditEntry) => api.createSyncJob({
      jobType: 'ORDER_SYNC',
      scopeType: 'SINGLE_ORDER',
      orderIds: entry.entityId ? [entry.entityId] : undefined,
      branchCode: entry.branchCode,
      createdBy: 'DASHBOARD_USER',
    }),
    onSuccess: () => {
      toast.success('Replay sync job created');
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const filteredEntries = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (auditEntries ?? []).filter((entry) => {
      if (normalizedSearch) {
        const haystack = [entry.correlationId, entry.action, entry.entityType, entry.entityId, entry.branchCode]
          .filter((value): value is string => typeof value === 'string')
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(normalizedSearch)) return false;
      }

      if (orderId.trim() && !(entry.entityId ?? '').toLowerCase().includes(orderId.trim().toLowerCase())) return false;
      if (actionFilter !== 'ALL' && entry.action !== actionFilter) return false;
      if (entityFilter !== 'ALL' && entry.entityType !== entityFilter) return false;
      if (statusFilter !== 'ALL' && getStatusLabel(entry) !== statusFilter) return false;

      const dayKey = new Intl.DateTimeFormat('en-CA').format(new Date(entry.createdAt));
      if (startDate && dayKey < startDate) return false;
      if (endDate && dayKey > endDate) return false;
      return true;
    });
  }, [actionFilter, auditEntries, endDate, entityFilter, orderId, search, startDate, statusFilter]);

  const visibleEntries = filteredEntries.slice(0, visibleCount);

  const exportCsv = () => {
    downloadCsv(
      'audit-trail.csv',
      ['Correlation ID', 'Action', 'Entity Type', 'Entity ID', 'Status', 'Duration (ms)', 'Date'],
      visibleEntries.map((entry) => [
        entry.correlationId ?? '',
        entry.action,
        entry.entityType,
        entry.entityId ?? '',
        getStatusLabel(entry),
        String(entry.durationMs ?? 0),
        formatDate(entry.createdAt),
      ]),
    );
  };

  if (isLoading) {
    return <div className="py-16 text-center text-gray-500">Loading...</div>;
  }

  if (isError) {
    return <ErrorState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Audit Trail</h1>
            <p className="mt-0.5 text-sm text-slate-500">Search, export, and replay integration events across the order lifecycle.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={visibleEntries.length === 0}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button variant="outline" onClick={() => setTimelineView((value) => !value)}>
            {timelineView ? <TableProperties className="h-4 w-4" /> : <History className="h-4 w-4" />}
            {timelineView ? 'Table View' : 'Timeline View'}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search & Filters</CardTitle>
          <CardDescription>Use the filters below to narrow audit events by order, entity, action, status, and date range.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="audit-search">Search</Label>
            <Input
              id="audit-search"
              className="mt-2"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              placeholder="Search by correlation ID, action, entity, or branch"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <div>
              <Label htmlFor="audit-order-id">Order ID</Label>
              <Input id="audit-order-id" className="mt-2" value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="Order ID" />
            </div>
            <div>
              <Label htmlFor="audit-start">Start date</Label>
              <Input id="audit-start" className="mt-2" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="audit-end">End date</Label>
              <Input id="audit-end" className="mt-2" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </div>
            <div>
              <Label>Action</Label>
              <Select value={actionFilter} onValueChange={(value) => setActionFilter(value as (typeof ACTION_OPTIONS)[number])}>
                <SelectTrigger className="mt-2"><SelectValue placeholder="All actions" /></SelectTrigger>
                <SelectContent>
                  {ACTION_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option === 'ALL' ? 'All actions' : option}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Entity Type</Label>
              <Select value={entityFilter} onValueChange={(value) => setEntityFilter(value as (typeof ENTITY_OPTIONS)[number])}>
                <SelectTrigger className="mt-2"><SelectValue placeholder="All entities" /></SelectTrigger>
                <SelectContent>
                  {ENTITY_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option === 'ALL' ? 'All entities' : option}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as (typeof STATUS_OPTIONS)[number])}>
                <SelectTrigger className="mt-2"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option === 'ALL' ? 'All statuses' : option}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit Events</CardTitle>
          <CardDescription>{filteredEntries.length} event(s) match the current filters.</CardDescription>
        </CardHeader>
        <CardContent>
          {timelineView ? (
            <div className="space-y-6">
              {visibleEntries.length === 0 ? (
                <div className="py-10 text-center text-gray-500">No audit events found.</div>
              ) : (
                visibleEntries.map((entry) => (
                  <div key={entry.id} className="relative border-l border-gray-200 pl-6">
                    <div className="absolute left-[-7px] top-2 h-3.5 w-3.5 rounded-full bg-blue-600" />
                    <div className="rounded-lg border border-gray-200 p-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-gray-900">{entry.action}</span>
                            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getStatusLabel(entry) === 'SUCCESS' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                              {getStatusLabel(entry)}
                            </span>
                          </div>
                          <p className="text-sm text-gray-600">{entry.entityType} · {entry.entityId ?? 'No entity ID'} · {formatDate(entry.createdAt)}</p>
                          <p className="font-mono text-xs text-gray-500">{entry.correlationId ?? 'No correlation ID'}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => setSelectedEntry(entry)}>
                            <Eye className="h-4 w-4" /> View
                          </Button>
                          {entry.entityType === 'ORDER' && entry.entityId && (
                            <Button size="sm" onClick={() => replayMutation.mutate(entry)} disabled={replayMutation.isPending}>
                              <Play className="h-4 w-4" /> Replay Order
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Correlation ID</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity Type</TableHead>
                  <TableHead>Entity ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleEntries.map((entry) => (
                  <TableRow key={entry.id} className="cursor-pointer" onClick={() => setSelectedEntry(entry)}>
                    <TableCell className="max-w-[180px] truncate font-mono text-xs">{entry.correlationId ?? '—'}</TableCell>
                    <TableCell className="font-medium">{entry.action}</TableCell>
                    <TableCell>{entry.entityType}</TableCell>
                    <TableCell>{entry.entityId ?? '—'}</TableCell>
                    <TableCell>
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getStatusLabel(entry) === 'SUCCESS' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                        {getStatusLabel(entry)}
                      </span>
                    </TableCell>
                    <TableCell>{entry.durationMs ?? 0} ms</TableCell>
                    <TableCell className="whitespace-nowrap text-gray-500">{formatDate(entry.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); setSelectedEntry(entry); }}>
                          View
                        </Button>
                        {entry.entityType === 'ORDER' && entry.entityId && (
                          <Button
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation();
                              replayMutation.mutate(entry);
                            }}
                            disabled={replayMutation.isPending}
                          >
                            Replay Order
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {visibleEntries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-10 text-center text-gray-500">No audit events found.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}

          {filteredEntries.length > visibleCount && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                Load More
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedEntry} onOpenChange={(open) => { if (!open) setSelectedEntry(null); }}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Audit Event Details</DialogTitle>
            <DialogDescription>Full request and response payloads for the selected integration event.</DialogDescription>
          </DialogHeader>
          {selectedEntry && (
            <div className="space-y-4 overflow-y-auto pr-1">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Correlation ID', selectedEntry.correlationId ?? '—'],
                  ['Action', selectedEntry.action],
                  ['Entity', `${selectedEntry.entityType}${selectedEntry.entityId ? ` · ${selectedEntry.entityId}` : ''}`],
                  ['Status', getStatusLabel(selectedEntry)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-gray-200 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
                    <p className="mt-1 break-all text-sm text-gray-800">{value}</p>
                  </div>
                ))}
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-700">Request Payload</p>
                  <pre className="max-h-[320px] overflow-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
                    {JSON.stringify(selectedEntry.requestPayload ?? {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-700">Response Payload</p>
                  <pre className="max-h-[320px] overflow-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
                    {JSON.stringify(selectedEntry.responsePayload ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
              {selectedEntry.errorMessage && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  <span className="font-semibold">Error Message:</span> {selectedEntry.errorMessage}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
