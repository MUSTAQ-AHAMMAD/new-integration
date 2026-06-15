'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RotateCcw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api, type FailedTransaction, type SyncJob } from '@/lib/api';
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface OrderRow {
  id: string;
  orderNumber: string;
  branchCode: string;
  status: string;
  totalAmount?: number;
  customerName?: string;
  createdAt: string;
  validationErrors?: unknown;
  failedCount: number;
}

interface SyncJobRecord extends SyncJob {
  scopeValue: Record<string, unknown>;
  skippedCount?: number;
}

interface FailedTransactionRecord extends FailedTransaction {
  errorDetails?: unknown;
}

const PAGE_SIZE = 50;
const TIMEZONES = ['UTC', 'Asia/Dubai', 'America/New_York', 'Europe/London'] as const;
const STATUS_OPTIONS = ['ALL', 'PENDING', 'PROCESSING', 'SYNCED', 'FAILED', 'SKIPPED'] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function getStatus(job: SyncJobRecord): string {
  if (job.status === 'FAILED' || job.failedCount > 0) return 'FAILED';
  if (job.status === 'PROCESSING') return 'PROCESSING';
  if (job.status === 'PENDING') return 'PENDING';
  if ((job.skippedCount ?? 0) > 0 && job.successCount === 0) return 'SKIPPED';
  if (job.status === 'CANCELLED') return 'SKIPPED';
  return 'SYNCED';
}

function getDateKey(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
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

export default function OrdersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [timezone, setTimezone] = useState<(typeof TIMEZONES)[number]>('UTC');
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_OPTIONS)[number]>('ALL');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [errorRow, setErrorRow] = useState<OrderRow | null>(null);

  const { data: jobs, isLoading: jobsLoading, isError: jobsError } = useQuery({
    queryKey: ['order-sync-jobs'],
    queryFn: () => api.listSyncJobs() as Promise<SyncJobRecord[]>,
    refetchInterval: 15000,
  });

  const { data: failedTransactions } = useQuery({
    queryKey: ['order-sync-failures'],
    queryFn: () => api.listFailedTransactions(200) as Promise<FailedTransactionRecord[]>,
    refetchInterval: 15000,
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.retrySyncJob(jobId),
    onSuccess: () => {
      toast.success('Order retry queued');
      void queryClient.invalidateQueries({ queryKey: ['order-sync-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['order-sync-failures'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retrySelectedMutation = useMutation({
    mutationFn: async (jobIds: string[]) => {
      const results = await Promise.allSettled(jobIds.map((jobId) => api.retrySyncJob(jobId)));
      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedCount = results.length - successCount;
      return { successCount, failedCount };
    },
    onSuccess: ({ successCount, failedCount }) => {
      if (successCount > 0) {
        toast.success(`Queued ${successCount} order ${successCount === 1 ? 'retry' : 'retries'}`);
      }
      if (failedCount > 0) {
        toast.error(`${failedCount} retry ${failedCount === 1 ? 'request failed' : 'requests failed'}`);
      }
      setSelectedIds([]);
      void queryClient.invalidateQueries({ queryKey: ['order-sync-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['order-sync-failures'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = useMemo<OrderRow[]>(() => {
    const failedByOrderNumber = new Map<string, FailedTransactionRecord[]>();

    (failedTransactions ?? []).forEach((transaction) => {
      const orderNumber = transaction.orderSyncQueue?.odooOrderNumber;
      if (!orderNumber) return;
      const current = failedByOrderNumber.get(orderNumber) ?? [];
      current.push(transaction);
      failedByOrderNumber.set(orderNumber, current);
    });

    return (jobs ?? []).map((job) => {
      const scope = asObject(job.scopeValue);
      const orderIds = getStringArray(scope.orderIds);
      const orderNumber = orderIds[0] ?? getString(scope.orderNumber) ?? getString(scope.odooOrderNumber) ?? `JOB-${job.id.slice(0, 8)}`;
      const relatedFailures = failedByOrderNumber.get(orderNumber) ?? [];
      const firstFailure = relatedFailures[0];
      const validationErrors = relatedFailures.length > 0
        ? relatedFailures.map((transaction) => ({
            id: transaction.id,
            errorType: transaction.errorType,
            errorMessage: transaction.errorMessage,
            errorDetails: transaction.errorDetails ?? null,
            retryCount: transaction.retryCount,
            createdAt: transaction.createdAt,
          }))
        : job.errorMessage
          ? { errorMessage: job.errorMessage }
          : undefined;

      return {
        id: job.id,
        orderNumber,
        branchCode: getString(scope.branchCode) ?? firstFailure?.orderSyncQueue?.branchCode ?? '—',
        status: getStatus(job),
        totalAmount: getNumber(scope.totalAmount),
        customerName: getString(scope.customerName) ?? getString(scope.customer) ?? getString(scope.customerNameAr) ?? undefined,
        createdAt: job.createdAt,
        validationErrors,
        failedCount: relatedFailures.length > 0 ? relatedFailures.length : job.failedCount,
      };
    });
  }, [failedTransactions, jobs]);

  const branchOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.branchCode).filter((branch) => branch && branch !== '—'))).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (normalizedSearch) {
        const matchesSearch = row.orderNumber.toLowerCase().includes(normalizedSearch)
          || (row.customerName ?? '').toLowerCase().includes(normalizedSearch);
        if (!matchesSearch) return false;
      }

      if (branchFilter !== 'ALL' && row.branchCode !== branchFilter) return false;
      if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;

      const dateKey = getDateKey(row.createdAt, timezone);
      if (startDate && dateKey < startDate) return false;
      if (endDate && dateKey > endDate) return false;
      return true;
    });
  }, [branchFilter, endDate, rows, search, startDate, statusFilter, timezone]);

  const visibleRows = filteredRows.slice(0, visibleCount);
  const visibleIds = visibleRows.map((row) => row.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleSelectAllVisible = (checked: boolean) => {
    if (checked) {
      setSelectedIds(Array.from(new Set([...selectedIds, ...visibleIds])));
      return;
    }
    setSelectedIds(selectedIds.filter((id) => !visibleIds.includes(id)));
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((current) => (checked ? Array.from(new Set([...current, id])) : current.filter((value) => value !== id)));
  };

  const exportVisibleRows = () => {
    downloadCsv(
      'orders.csv',
      ['Order Number', 'Branch', 'Status', 'Amount', 'Customer', 'Date', 'Failed Count'],
      visibleRows.map((row) => [
        row.orderNumber,
        row.branchCode,
        row.status,
        row.totalAmount !== undefined ? String(row.totalAmount) : '',
        row.customerName ?? '',
        formatDate(row.createdAt),
        String(row.failedCount),
      ]),
    );
  };

  if (jobsLoading) {
    return <div className="py-16 text-center text-gray-500">Loading...</div>;
  }

  if (jobsError) {
    return <ErrorState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Order Sync Manager</h1>
            <p className="mt-0.5 text-sm text-slate-500">Search, filter, retry, and export order synchronization activity.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{filteredRows.length} visible</Badge>
          <Button variant="outline" onClick={exportVisibleRows} disabled={visibleRows.length === 0}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            onClick={() => retrySelectedMutation.mutate(selectedIds)}
            disabled={selectedIds.length === 0 || retrySelectedMutation.isPending}
          >
            <RotateCcw className="h-4 w-4" /> Retry Selected ({selectedIds.length})
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Refine orders by branch, date window, status, and customer or order search.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <Label htmlFor="order-search">Search</Label>
              <div className="relative mt-2">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  id="order-search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setVisibleCount(PAGE_SIZE);
                  }}
                  placeholder="Search by order number or customer"
                  className="pl-9"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="start-date">Start date</Label>
              <Input id="start-date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-2" />
            </div>
            <div>
              <Label htmlFor="end-date">End date</Label>
              <Input id="end-date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-2" />
            </div>
            <div>
              <Label>Timezone</Label>
              <Select value={timezone} onValueChange={(value) => setTimezone(value as (typeof TIMEZONES)[number])}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((item) => (
                    <SelectItem key={item} value={item}>{item}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <Label>Branch</Label>
              <Select value={branchFilter} onValueChange={setBranchFilter}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="All branches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All branches</SelectItem>
                  {branchOptions.map((branch) => (
                    <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as (typeof STATUS_OPTIONS)[number])}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((status) => (
                    <SelectItem key={status} value={status}>{status === 'ALL' ? 'All statuses' : status}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                Showing <span className="font-semibold text-gray-900">{visibleRows.length}</span> of <span className="font-semibold text-gray-900">{filteredRows.length}</span> records · Dates shown as {timezone}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Orders</CardTitle>
          <CardDescription>Select failed rows to retry in bulk or inspect validation details.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => toggleSelectAllVisible(event.target.checked)}
                    aria-label="Select all visible orders"
                    className="h-4 w-4 rounded border-gray-300"
                  />
                </TableHead>
                <TableHead>Order Number</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(row.id)}
                      onChange={(event) => toggleSelected(row.id, event.target.checked)}
                      aria-label={`Select ${row.orderNumber}`}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </TableCell>
                  <TableCell className="font-medium">{row.orderNumber}</TableCell>
                  <TableCell className="font-mono text-xs text-gray-600">{row.branchCode}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getStatusColor(row.status)}`}>
                      {row.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-gray-700">
                    {row.totalAmount !== undefined ? formatCurrency(row.totalAmount) : '—'}
                  </TableCell>
                  <TableCell>{row.customerName ?? '—'}</TableCell>
                  <TableCell className="whitespace-nowrap text-gray-500">{formatDate(row.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {row.status === 'FAILED' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => retryMutation.mutate(row.id)}
                          disabled={retryMutation.isPending}
                        >
                          Retry
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setErrorRow(row)}
                        disabled={!row.validationErrors}
                      >
                        View Errors
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {visibleRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-gray-500">
                    No orders matched the current filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {filteredRows.length > visibleCount && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                Load More
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!errorRow} onOpenChange={(open) => { if (!open) setErrorRow(null); }}>
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Validation Errors</DialogTitle>
            <DialogDescription>
              {errorRow?.orderNumber ? `Details for ${errorRow.orderNumber}` : 'Validation details'}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
            {JSON.stringify(errorRow?.validationErrors ?? { message: 'No validation errors available.' }, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
