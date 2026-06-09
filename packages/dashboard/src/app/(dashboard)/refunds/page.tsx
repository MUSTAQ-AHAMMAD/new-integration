'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, PlusCircle } from 'lucide-react';
import { toast } from 'sonner';
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface Refund {
  id: string;
  originalOrderId: string;
  originalOrderNumber: string;
  refundOrderId: string;
  refundOrderNumber: string;
  refundAmount: string;
  refundReason?: string;
  refundDate: string;
  oracleCreditMemoNumber?: string;
  creditMemoStatus: string;
  isReconciled: boolean;
  reconcileNote?: string;
  createdAt: string;
  updatedAt: string;
  branchCode?: string;
}

interface ManualCreditMemoForm {
  originalOrderId: string;
  originalOrderNumber: string;
  refundOrderId: string;
  refundOrderNumber: string;
  refundAmount: string;
  refundReason: string;
  refundDate: string;
}

const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
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

function getBranchCode(refund: Refund): string {
  if (refund.branchCode) return refund.branchCode;
  const orderNumber = refund.refundOrderNumber || refund.originalOrderNumber;
  const match = orderNumber.match(/^[A-Za-z]+\d+-([A-Za-z0-9]+)/);
  return match?.[1] ?? '—';
}

function getTableStatus(refund: Refund): 'Reconciled' | 'Pending' | 'Failed' {
  if (refund.isReconciled) return 'Reconciled';
  if (refund.creditMemoStatus === 'FAILED') return 'Failed';
  return 'Pending';
}

const currentDate = new Date();
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1),
  label: new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(2024, index, 1)),
}));
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, index) => String(currentDate.getFullYear() - 3 + index));
const EMPTY_MANUAL_FORM: ManualCreditMemoForm = {
  originalOrderId: '',
  originalOrderNumber: '',
  refundOrderId: '',
  refundOrderNumber: '',
  refundAmount: '',
  refundReason: '',
  refundDate: '',
};

export default function RefundsPage() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(String(currentDate.getMonth() + 1));
  const [year, setYear] = useState(String(currentDate.getFullYear()));
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'Reconciled' | 'Pending' | 'Failed'>('ALL');
  const [selectedRefund, setSelectedRefund] = useState<Refund | null>(null);
  const [reconcileRefund, setReconcileRefund] = useState<Refund | null>(null);
  const [reconcileNote, setReconcileNote] = useState('');
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [manualForm, setManualForm] = useState<ManualCreditMemoForm>(EMPTY_MANUAL_FORM);

  const { data: refunds, isLoading, isError } = useQuery({
    queryKey: ['refunds'],
    queryFn: () => apiRequest<Refund[]>('/refunds'),
  });

  const refundsForPeriod = useMemo(() => {
    return (refunds ?? []).filter((refund) => {
      const date = new Date(refund.refundDate);
      return String(date.getMonth() + 1) === month && String(date.getFullYear()) === year;
    });
  }, [month, refunds, year]);

  const filteredRefunds = useMemo(() => {
    return refundsForPeriod.filter((refund) => statusFilter === 'ALL' || getTableStatus(refund) === statusFilter);
  }, [refundsForPeriod, statusFilter]);

  const stats = useMemo(() => {
    return {
      total: refundsForPeriod.length,
      reconciled: refundsForPeriod.filter((refund) => refund.isReconciled).length,
      pending: refundsForPeriod.filter((refund) => !refund.isReconciled && refund.creditMemoStatus !== 'FAILED').length,
      failed: refundsForPeriod.filter((refund) => refund.creditMemoStatus === 'FAILED').length,
    };
  }, [refundsForPeriod]);

  const reconcileMutation = useMutation({
    mutationFn: ({ refundId, note }: { refundId: string; note: string }) =>
      apiRequest<Refund>(`/refunds/${refundId}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ note, reconciledBy: 'DASHBOARD_USER' }),
      }),
    onSuccess: () => {
      toast.success('Refund reconciled');
      setReconcileRefund(null);
      setReconcileNote('');
      void queryClient.invalidateQueries({ queryKey: ['refunds'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const manualCreditMemoMutation = useMutation({
    mutationFn: (payload: ManualCreditMemoForm) =>
      apiRequest<Refund>('/refunds/manual-credit-memo', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      toast.success('Manual credit memo request submitted');
      setManualDialogOpen(false);
      setManualForm(EMPTY_MANUAL_FORM);
      void queryClient.invalidateQueries({ queryKey: ['refunds'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const exportFilteredRefunds = () => {
    downloadCsv(
      'refunds.csv',
      ['Refund Order #', 'Original Order #', 'Branch', 'Amount', 'Reason', 'Credit Memo #', 'Status', 'Date'],
      filteredRefunds.map((refund) => [
        refund.refundOrderNumber,
        refund.originalOrderNumber,
        getBranchCode(refund),
        refund.refundAmount,
        refund.refundReason ?? '',
        refund.oracleCreditMemoNumber ?? '',
        refund.creditMemoStatus,
        formatDate(refund.refundDate),
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
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Refund Reconciliation</h1>
          <p className="text-sm text-gray-500">Manage refund credit memo status, manual interventions, and reconciliation notes.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportFilteredRefunds} disabled={filteredRefunds.length === 0}>
            <Download className="h-4 w-4" /> Export to Excel
          </Button>
          <Button onClick={() => setManualDialogOpen(true)}>
            <PlusCircle className="h-4 w-4" /> Create Manual Credit Memo
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Total', value: stats.total },
          { label: 'Reconciled', value: stats.reconciled },
          { label: 'Pending', value: stats.pending },
          { label: 'Failed', value: stats.failed },
        ].map((item) => (
          <Card key={item.label}>
            <CardHeader className="pb-2">
              <CardDescription>{item.label}</CardDescription>
              <CardTitle className="text-2xl">{item.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>Month</Label>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="mt-2"><SelectValue placeholder="Select month" /></SelectTrigger>
              <SelectContent>
                {MONTH_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Year</Label>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="mt-2"><SelectValue placeholder="Select year" /></SelectTrigger>
              <SelectContent>
                {YEAR_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as 'ALL' | 'Reconciled' | 'Pending' | 'Failed')}>
              <SelectTrigger className="mt-2"><SelectValue placeholder="All statuses" /></SelectTrigger>
              <SelectContent>
                {['ALL', 'Reconciled', 'Pending', 'Failed'].map((option) => (
                  <SelectItem key={option} value={option}>{option === 'ALL' ? 'All statuses' : option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Refunds</CardTitle>
          <CardDescription>{filteredRefunds.length} refund record(s) matched the current selection.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Refund Order #</TableHead>
                <TableHead>Original Order #</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Credit Memo #</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRefunds.map((refund) => (
                <TableRow key={refund.id}>
                  <TableCell className="font-medium">{refund.refundOrderNumber}</TableCell>
                  <TableCell>{refund.originalOrderNumber}</TableCell>
                  <TableCell className="font-mono text-xs text-gray-600">{getBranchCode(refund)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(Number(refund.refundAmount || 0))}</TableCell>
                  <TableCell>{refund.refundReason ?? '—'}</TableCell>
                  <TableCell>{refund.oracleCreditMemoNumber ?? '—'}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getStatusColor(refund.creditMemoStatus === 'SYNCED' ? 'SYNCED' : refund.creditMemoStatus)}`}>
                      {refund.creditMemoStatus}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-gray-500">{formatDate(refund.refundDate)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {!refund.isReconciled && (
                        <Button size="sm" variant="outline" onClick={() => { setReconcileRefund(refund); setReconcileNote(refund.reconcileNote ?? ''); }}>
                          Reconcile
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => setSelectedRefund(refund)}>View Details</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filteredRefunds.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-gray-500">No refunds found for the selected filters.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!selectedRefund} onOpenChange={(open) => { if (!open) setSelectedRefund(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Refund Details</DialogTitle>
            <DialogDescription>Full refund metadata for reconciliation review.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {selectedRefund && Object.entries(selectedRefund).map(([key, value]) => (
              <div key={key} className="rounded-lg border border-gray-200 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{key}</p>
                <p className="mt-1 break-all text-sm text-gray-800">{String(value ?? '—')}</p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!reconcileRefund} onOpenChange={(open) => { if (!open) { setReconcileRefund(null); setReconcileNote(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconcile Refund</DialogTitle>
            <DialogDescription>Add a reconciliation note before closing the refund workflow.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="reconcile-note">Note</Label>
              <Textarea id="reconcile-note" value={reconcileNote} onChange={(event) => setReconcileNote(event.target.value)} className="mt-2" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setReconcileRefund(null); setReconcileNote(''); }}>Cancel</Button>
              <Button
                onClick={() => reconcileRefund && reconcileMutation.mutate({ refundId: reconcileRefund.id, note: reconcileNote })}
                disabled={!reconcileRefund || reconcileMutation.isPending}
              >
                Save Reconciliation
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={manualDialogOpen} onOpenChange={setManualDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Manual Credit Memo</DialogTitle>
            <DialogDescription>Manually submit a credit memo for refunds that require intervention.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ['originalOrderId', 'Original Order ID'],
                ['originalOrderNumber', 'Original Order Number'],
                ['refundOrderId', 'Refund Order ID'],
                ['refundOrderNumber', 'Refund Order Number'],
                ['refundAmount', 'Refund Amount'],
                ['refundDate', 'Refund Date'],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <Label htmlFor={key}>{label}</Label>
                <Input
                  id={key}
                  type={key === 'refundDate' ? 'date' : key === 'refundAmount' ? 'number' : 'text'}
                  value={manualForm[key]}
                  onChange={(event) => setManualForm((current) => ({ ...current, [key]: event.target.value }))}
                  className="mt-2"
                />
              </div>
            ))}
            <div className="sm:col-span-2">
              <Label htmlFor="refundReason">Refund Reason</Label>
              <Textarea
                id="refundReason"
                value={manualForm.refundReason}
                onChange={(event) => setManualForm((current) => ({ ...current, refundReason: event.target.value }))}
                className="mt-2"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setManualDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => manualCreditMemoMutation.mutate(manualForm)}
              disabled={manualCreditMemoMutation.isPending || Object.values(manualForm).some((value) => value === '')}
            >
              Submit Credit Memo
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
