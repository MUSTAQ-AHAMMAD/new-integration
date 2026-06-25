'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RotateCcw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api, type OrderQueueEntry } from '@/lib/api';
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

const PAGE_SIZE = 50;
const TIMEZONES = ['UTC', 'Asia/Dubai', 'America/New_York', 'Europe/London'] as const;
const STATUS_OPTIONS = ['ALL', 'PENDING', 'PROCESSING', 'SYNCED', 'FAILED', 'SKIPPED'] as const;

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
  const [detailRow, setDetailRow] = useState<OrderQueueEntry | null>(null);

  const { data: orders = [], isLoading, isError } = useQuery({
    queryKey: ['order-queue'],
    queryFn: () => api.listOrderQueue({ limit: 500 }),
    refetchInterval: 15000,
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.retryOrderQueueEntry(id),
    onSuccess: () => {
      toast.success('Order retry queued');
      void queryClient.invalidateQueries({ queryKey: ['order-queue'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retrySelectedMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.retryOrderQueueEntry(id)));
      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      return { successCount, failedCount: results.length - successCount };
    },
    onSuccess: ({ successCount, failedCount }: { successCount: number; failedCount: number }) => {
      if (successCount > 0) toast.success(`Queued ${successCount} order ${successCount === 1 ? 'retry' : 'retries'}`);
      if (failedCount > 0) toast.error(`${failedCount} retry ${failedCount === 1 ? 'request failed' : 'requests failed'}`);
      setSelectedIds([]);
      void queryClient.invalidateQueries({ queryKey: ['order-queue'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const branchOptions = useMemo(() => {
    return Array.from(new Set(orders.map((o) => o.branchCode).filter(Boolean))).sort();
  }, [orders]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (normalizedSearch) {
        const match = order.odooOrderNumber.toLowerCase().includes(normalizedSearch)
          || (order.customerName ?? '').toLowerCase().includes(normalizedSearch);
        if (!match) return false;
      }
      if (branchFilter !== 'ALL' && order.branchCode !== branchFilter) return false;
      if (statusFilter !== 'ALL' && order.status !== statusFilter) return false;
      const dateKey = getDateKey(order.createdAt, timezone);
      if (startDate && dateKey < startDate) return false;
      if (endDate && dateKey > endDate) return false;
      return true;
    });
  }, [orders, search, branchFilter, statusFilter, startDate, endDate, timezone]);

  const visibleRows = filteredRows.slice(0, visibleCount);
  const visibleIds = visibleRows.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleSelectAllVisible = (checked: boolean) => {
    if (checked) {
      setSelectedIds(Array.from(new Set([...selectedIds, ...visibleIds])));
    } else {
      setSelectedIds(selectedIds.filter((id) => !visibleIds.includes(id)));
    }
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((cur) => (checked ? Array.from(new Set([...cur, id])) : cur.filter((v) => v !== id)));
  };

  const exportVisibleRows = () => {
    downloadCsv(
      'orders.csv',
      ['Order Number', 'Branch', 'Status', 'Amount', 'Currency', 'Customer', 'Date', 'Failed Count'],
      visibleRows.map((r) => [
        r.odooOrderNumber,
        r.branchCode,
        r.status,
        r.totalAmount,
        r.currency,
        r.customerName ?? '',
        formatDate(r.createdAt),
        String(r.failedTransactions.length),
      ]),
    );
  };

  if (isLoading) return <div className="py-16 text-center text-gray-500">Loading...</div>;
  if (isError) return <ErrorState />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Order Sync Manager</h1>
            <p className="mt-0.5 text-sm text-slate-500">Search, filter, retry, and export order synchronisation activity.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{filteredRows.length} visible</Badge>
          <Button variant="outline" onClick={exportVisibleRows} disabled={visibleRows.length === 0}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            onClick={() => retrySelectedMutation.mutate(
              selectedIds.filter((id) => orders.find((o) => o.id === id)?.status === 'FAILED'),
            )}
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
                  onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
                  placeholder="Search by order number or customer"
                  className="pl-9"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="start-date">Start date</Label>
              <Input id="start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-2" />
            </div>
            <div>
              <Label htmlFor="end-date">End date</Label>
              <Input id="end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-2" />
            </div>
            <div>
              <Label>Timezone</Label>
              <Select value={timezone} onValueChange={(v) => setTimezone(v as (typeof TIMEZONES)[number])}>
                <SelectTrigger className="mt-2"><SelectValue placeholder="Select timezone" /></SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <Label>Branch</Label>
              <Select value={branchFilter} onValueChange={setBranchFilter}>
                <SelectTrigger className="mt-2"><SelectValue placeholder="All branches" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All branches</SelectItem>
                  {branchOptions.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as (typeof STATUS_OPTIONS)[number])}>
                <SelectTrigger className="mt-2"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => <SelectItem key={s} value={s}>{s === 'ALL' ? 'All statuses' : s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                Showing <span className="font-semibold text-gray-900">{visibleRows.length}</span> of{' '}
                <span className="font-semibold text-gray-900">{filteredRows.length}</span> records · Dates as {timezone}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Orders</CardTitle>
          <CardDescription>Select failed rows to retry in bulk or inspect error details.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(e) => toggleSelectAllVisible(e.target.checked)}
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
                      onChange={(e) => toggleSelected(row.id, e.target.checked)}
                      aria-label={`Select ${row.odooOrderNumber}`}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </TableCell>
                  <TableCell className="font-medium">{row.odooOrderNumber}</TableCell>
                  <TableCell className="font-mono text-xs text-gray-600">{row.branchCode}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getStatusColor(row.status)}`}>
                      {row.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-gray-700">
                    {formatCurrency(Number(row.totalAmount))}
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
                        onClick={() => setDetailRow(row)}
                        disabled={row.failedTransactions.length === 0}
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
              <Button variant="outline" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                Load More
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!detailRow} onOpenChange={(open) => { if (!open) setDetailRow(null); }}>
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Error Details</DialogTitle>
            <DialogDescription>
              {detailRow?.odooOrderNumber ? `Errors for ${detailRow.odooOrderNumber}` : 'Error details'}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
            {JSON.stringify(detailRow?.failedTransactions ?? [], null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
