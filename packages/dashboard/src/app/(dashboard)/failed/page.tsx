'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate, getSeverityColor } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface FailedTx {
  id: string;
  errorType: string;
  errorMessage: string;
  originalPayload: unknown;
  retryCount: number;
  maxRetries: number;
  isResolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  createdAt: string;
  orderSyncQueue?: { odooOrderNumber: string; branchCode: string };
}

const ERROR_TYPES = ['ALL', 'VALIDATION', 'NETWORK', 'ORACLE', 'UNKNOWN'] as const;
const CHART_COLORS: Record<string, string> = {
  VALIDATION: '#f59e0b',
  NETWORK: '#3b82f6',
  ORACLE: '#ef4444',
  UNKNOWN: '#6b7280',
};

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function extractRetryValues(transaction: FailedTx, payloadText?: string): { orderId: string; branchCode?: string } {
  const parsed = payloadText ? (JSON.parse(payloadText) as Record<string, unknown>) : {};
  const orderId = typeof parsed.odooOrderId === 'string'
    ? parsed.odooOrderId
    : typeof parsed.orderId === 'string'
      ? parsed.orderId
      : typeof parsed.odooOrderNumber === 'string'
        ? parsed.odooOrderNumber
        : typeof parsed.orderNumber === 'string'
          ? parsed.orderNumber
          : transaction.orderSyncQueue?.odooOrderNumber;

  if (!orderId) {
    throw new Error('Unable to determine an order identifier for retry.');
  }

  const branchCode = typeof parsed.branchCode === 'string' ? parsed.branchCode : transaction.orderSyncQueue?.branchCode;
  return { orderId, branchCode };
}

async function resolveAndRetryTransaction(transaction: FailedTx, payloadText?: string): Promise<void> {
  const { orderId, branchCode } = extractRetryValues(transaction, payloadText);
  await api.resolveFailedTransaction(transaction.id, 'DASHBOARD_USER', 'Retried from dashboard');
  await api.createSyncJob({
    jobType: 'ORDER_SYNC',
    scopeType: 'SINGLE_ORDER',
    orderIds: [orderId],
    branchCode,
    createdBy: 'DASHBOARD_USER',
  });
}

export default function FailedPage() {
  const queryClient = useQueryClient();
  const [errorTypeFilter, setErrorTypeFilter] = useState<(typeof ERROR_TYPES)[number]>('ALL');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [openGroups, setOpenGroups] = useState<string[]>(['VALIDATION', 'NETWORK', 'ORACLE', 'UNKNOWN']);
  const [payloadTransaction, setPayloadTransaction] = useState<FailedTx | null>(null);
  const [editTransaction, setEditTransaction] = useState<FailedTx | null>(null);
  const [editPayload, setEditPayload] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});

  const { data: transactions, isLoading, isError } = useQuery({
    queryKey: ['failed-transactions-enhanced'],
    queryFn: () => api.listFailedTransactions(200) as Promise<FailedTx[]>,
    refetchInterval: 15000,
  });

  const filteredTransactions = useMemo(() => {
    return (transactions ?? [])
      .filter((transaction) => !transaction.isResolved)
      .filter((transaction) => errorTypeFilter === 'ALL' || transaction.errorType === errorTypeFilter);
  }, [errorTypeFilter, transactions]);

  const groupedTransactions = useMemo(() => {
    return filteredTransactions.reduce<Record<string, FailedTx[]>>((groups, transaction) => {
      const key = transaction.errorType || 'UNKNOWN';
      const current = groups[key] ?? [];
      current.push(transaction);
      groups[key] = current;
      return groups;
    }, {});
  }, [filteredTransactions]);

  const chartData = useMemo(() => {
    return Object.entries(groupedTransactions).map(([errorType, items]) => ({ errorType, count: items.length }));
  }, [groupedTransactions]);

  const selectedTransactions = filteredTransactions.filter((transaction) => selectedIds.includes(transaction.id));

  const resolveMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => api.resolveFailedTransaction(id, 'DASHBOARD_USER', note),
    onSuccess: () => {
      toast.success('Transaction marked as resolved');
      void queryClient.invalidateQueries({ queryKey: ['failed-transactions-enhanced'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retryMutation = useMutation({
    mutationFn: ({ transaction, payloadText }: { transaction: FailedTx; payloadText?: string }) => resolveAndRetryTransaction(transaction, payloadText),
    onSuccess: () => {
      toast.success('Transaction resolved and re-queued');
      setEditTransaction(null);
      setEditPayload('');
      setSelectedIds([]);
      void queryClient.invalidateQueries({ queryKey: ['failed-transactions-enhanced'] });
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retryManyMutation = useMutation({
    mutationFn: async (items: FailedTx[]) => {
      const results = await Promise.allSettled(items.map((transaction) => resolveAndRetryTransaction(transaction)));
      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      return { successCount, failedCount: results.length - successCount };
    },
    onSuccess: ({ successCount, failedCount }) => {
      if (successCount > 0) toast.success(`Retried ${successCount} transaction${successCount === 1 ? '' : 's'}`);
      if (failedCount > 0) toast.error(`${failedCount} transaction${failedCount === 1 ? '' : 's'} could not be retried`);
      setSelectedIds([]);
      void queryClient.invalidateQueries({ queryKey: ['failed-transactions-enhanced'] });
      void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggleGroup = (group: string) => {
    setOpenGroups((current) => (current.includes(group) ? current.filter((item) => item !== group) : [...current, group]));
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((current) => (checked ? Array.from(new Set([...current, id])) : current.filter((value) => value !== id)));
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
        <div className="flex items-start gap-3">
          <div className="mt-1 h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-slate-900">Failed Transactions</h1>
              <Badge variant="destructive">{filteredTransactions.length} unresolved</Badge>
            </div>
            <p className="text-sm text-slate-500">Inspect payloads, resolve failures, and re-queue transactions with corrected input.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => retryManyMutation.mutate(filteredTransactions)}
            disabled={filteredTransactions.length === 0 || retryManyMutation.isPending}
          >
            <RotateCcw className="h-4 w-4" /> Retry All
          </Button>
          <Button
            onClick={() => retryManyMutation.mutate(selectedTransactions)}
            disabled={selectedTransactions.length === 0 || retryManyMutation.isPending}
          >
            Retry Selected ({selectedTransactions.length})
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Failure Trend</CardTitle>
          <CardDescription>Current unresolved failure count by error type.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 max-w-xs">
            <Label>Error type</Label>
            <Select value={errorTypeFilter} onValueChange={(value) => setErrorTypeFilter(value as (typeof ERROR_TYPES)[number])}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="All error types" />
              </SelectTrigger>
              <SelectContent>
                {ERROR_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>{type === 'ALL' ? 'All error types' : type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="errorType" />
                <YAxis allowDecimals={false} />
                <ChartTooltip />
                <Bar dataKey="count" radius={[8, 8, 0, 0]}>
                  {chartData.map((entry) => (
                    <Cell key={entry.errorType} fill={CHART_COLORS[entry.errorType] ?? '#6b7280'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {Object.keys(groupedTransactions).length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-gray-500">No unresolved failed transactions.</CardContent>
        </Card>
      ) : (
        Object.entries(groupedTransactions).map(([group, items]) => {
          const isOpen = openGroups.includes(group);
          return (
            <Card key={group}>
              <CardHeader className="cursor-pointer" onClick={() => toggleGroup(group)}>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    {isOpen ? <ChevronDown className="h-4 w-4 text-gray-500" /> : <ChevronRight className="h-4 w-4 text-gray-500" />}
                    <CardTitle className="text-lg">{group}</CardTitle>
                    <Badge className={getSeverityColor(group === 'ORACLE' ? 'CRITICAL' : group === 'NETWORK' ? 'INFO' : 'WARNING')}>{items.length}</Badge>
                  </div>
                </div>
              </CardHeader>
              {isOpen && (
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12" />
                        <TableHead>Order</TableHead>
                        <TableHead>Branch</TableHead>
                        <TableHead>Error Message</TableHead>
                        <TableHead>Retries</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Resolution Note</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((transaction) => (
                        <TableRow key={transaction.id}>
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(transaction.id)}
                              onChange={(event) => toggleSelected(transaction.id, event.target.checked)}
                              className="h-4 w-4 rounded border-gray-300"
                              aria-label={`Select ${transaction.id}`}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">{transaction.orderSyncQueue?.odooOrderNumber ?? '—'}</TableCell>
                          <TableCell className="font-mono text-xs text-gray-600">{transaction.orderSyncQueue?.branchCode ?? '—'}</TableCell>
                          <TableCell className="max-w-md truncate text-gray-700" title={transaction.errorMessage}>{transaction.errorMessage}</TableCell>
                          <TableCell className="text-gray-600">{transaction.retryCount}/{transaction.maxRetries}</TableCell>
                          <TableCell className="whitespace-nowrap text-gray-500">{formatDate(transaction.createdAt)}</TableCell>
                          <TableCell>
                            <Input
                              value={resolutionNotes[transaction.id] ?? ''}
                              onChange={(event) => setResolutionNotes((current) => ({ ...current, [transaction.id]: event.target.value }))}
                              placeholder="Optional note"
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="outline" onClick={() => setPayloadTransaction(transaction)}>
                                View Payload
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditTransaction(transaction);
                                  setEditPayload(prettyJson(transaction.originalPayload ?? transaction));
                                }}
                              >
                                Edit & Retry
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => resolveMutation.mutate({ id: transaction.id, note: resolutionNotes[transaction.id] ?? 'Resolved from dashboard' })}
                                disabled={resolveMutation.isPending}
                              >
                                Mark Resolved
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              )}
            </Card>
          );
        })
      )}

      <Dialog open={!!payloadTransaction} onOpenChange={(open) => { if (!open) setPayloadTransaction(null); }}>
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Payload Viewer</DialogTitle>
            <DialogDescription>Raw payload and error detail snapshot for the selected failed transaction.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
            {prettyJson(payloadTransaction?.originalPayload ?? payloadTransaction)}
          </pre>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTransaction} onOpenChange={(open) => { if (!open) { setEditTransaction(null); setEditPayload(''); } }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Edit Payload & Retry</DialogTitle>
            <DialogDescription>Update the payload JSON, then resolve the failure and create a new sync job.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-payload">Payload JSON</Label>
              <Textarea id="edit-payload" value={editPayload} onChange={(event) => setEditPayload(event.target.value)} className="mt-2 min-h-[320px] font-mono text-xs" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setEditTransaction(null); setEditPayload(''); }}>Cancel</Button>
              <Button
                onClick={() => {
                  if (!editTransaction) return;
                  retryMutation.mutate({ transaction: editTransaction, payloadText: editPayload });
                }}
                disabled={retryMutation.isPending || !editTransaction}
              >
                Save & Retry
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
