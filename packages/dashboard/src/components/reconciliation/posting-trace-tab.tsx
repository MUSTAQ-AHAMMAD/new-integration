'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Radio,
  Scale,
  XCircle,
} from 'lucide-react';
import {
  api,
  type OdooVsBackupReport,
  type ReconciliationReport,
  type ReconDayStatus,
  type ReconStoreDay,
} from '@/lib/api';
import { useRegion } from '@/providers/region-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// ── formatting ──────────────────────────────────────────────────────────────

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 4 });

function isOff(v: number, tol: number) {
  return Math.abs(v) > tol;
}

/** A variance cell: green tick when within tolerance, red signed figure otherwise. */
function Delta({ value, tol, format = money }: { value: number; tol: number; format?: (n: number) => string }) {
  if (!isOff(value, tol)) return <span className="text-emerald-600">✓</span>;
  return (
    <span className="font-semibold text-red-600 tabular-nums">
      {value > 0 ? '+' : ''}
      {format(value)}
    </span>
  );
}

const STATUS_STYLE: Record<ReconDayStatus, string> = {
  MATCHED: 'bg-emerald-100 text-emerald-700',
  VARIANCE: 'bg-amber-100 text-amber-800',
  NOT_POSTED: 'bg-red-100 text-red-700',
  NO_ACTIVITY: 'bg-slate-100 text-slate-500',
};
const STATUS_LABEL: Record<ReconDayStatus, string> = {
  MATCHED: 'Matched',
  VARIANCE: 'Variance',
  NOT_POSTED: 'Not posted',
  NO_ACTIVITY: 'No sales',
};

const EXCEPTION_LABEL: Record<string, string> = {
  UNMAPPED_BRANCH: 'Branch not mapped',
  NOT_INVOICED: 'Not invoiced',
  INVOICE_FAILED: 'Invoice failed',
  CREDIT_MEMO_MISSING: 'Credit memo missing',
  CREDIT_MEMO_PENDING: 'Credit memo pending',
  CREDIT_MEMO_FAILED: 'Credit memo failed',
  INVENTORY_NEGATIVE: 'Inventory: negative stock',
  INVENTORY_ERROR: 'Inventory: error',
  INVENTORY_NOT_POSTED: 'Inventory not posted',
  INVENTORY_QTY_MISMATCH: 'Inventory qty mismatch',
};

const DIFF_LABEL: Record<string, string> = {
  MISSING_IN_BACKUP: 'Missing in backup',
  STORED_UNDER_OTHER_DAY: 'Stored under another day',
  NOT_IN_ODOO: 'Not in Odoo',
  AMOUNT_MISMATCH: 'Amount differs',
  STATE_MISMATCH: 'State differs',
  LINES_MISMATCH: 'Line count differs',
  PAYMENTS_MISMATCH: 'Payment count differs',
};

function downloadCsv(filename: string, header: string[], rows: Array<Array<unknown>>) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ── page ────────────────────────────────────────────────────────────────────

/**
 * Posting trace: every Odoo order of a store × store-local business day traced
 * to the Oracle documents the integration created for it (invoice, receipts,
 * credit memos, inventory), plus an order-by-order Odoo API ↔ backup check.
 * Backed by /reconciliation/summary and /reconciliation/odoo-vs-backup.
 */
export function PostingTraceTab() {
  const { selectedRegion } = useRegion();
  const [region, setRegion] = useState(selectedRegion ?? 'SN');
  const [startDate, setStartDate] = useState(today(-1));
  const [endDate, setEndDate] = useState(today(-1));

  useEffect(() => {
    if (selectedRegion) setRegion(selectedRegion);
  }, [selectedRegion]);

  const summary = useMutation({
    mutationFn: () => api.reconciliationSummary({ region, startDate, endDate }),
  });
  const live = useMutation({
    mutationFn: () => api.reconciliationOdooVsBackup({ region, startDate, endDate }),
  });

  const canRun = !!region && !!startDate && !!endDate && endDate >= startDate;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div>
            <label className="text-xs text-slate-500">Region</label>
            <Input value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} className="mt-1 h-9 w-24" />
          </div>
          <div>
            <label className="text-xs text-slate-500">From (business day)</label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 h-9" />
          </div>
          <div>
            <label className="text-xs text-slate-500">To</label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1 h-9" />
          </div>
          <Button className="bg-indigo-600 hover:bg-indigo-700" disabled={!canRun || summary.isPending} onClick={() => summary.mutate()}>
            <Scale className="mr-1.5 h-4 w-4" />
            {summary.isPending ? 'Reconciling…' : 'Odoo ↔ Oracle'}
          </Button>
          <Button variant="outline" disabled={!canRun || live.isPending} onClick={() => live.mutate()}>
            <Radio className="mr-1.5 h-4 w-4" />
            {live.isPending ? 'Fetching Odoo…' : 'Odoo API ↔ Backup'}
          </Button>
          <p className="w-full text-xs text-slate-400">
            Up to 31 days. Days are the store&apos;s local calendar day — the same grouping the daily invoice uses.
          </p>
        </CardContent>
      </Card>

      {summary.isError && <ErrorBox text={(summary.error as Error).message} />}
      {summary.data && <SummarySection report={summary.data} />}

      {live.isError && <ErrorBox text={(live.error as Error).message} />}
      {live.data && <OdooVsBackupSection report={live.data} />}

    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <XCircle className="h-4 w-4" /> {text}
    </div>
  );
}

// ── Odoo ↔ Oracle ───────────────────────────────────────────────────────────

function SummarySection({ report }: { report: ReconciliationReport }) {
  const t = report.totals;
  const tol = report.tolerance.amount;
  const qtol = report.tolerance.quantity;
  const [statusFilter, setStatusFilter] = useState<ReconDayStatus | 'ISSUES' | 'ALL'>('ISSUES');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return report.rows.filter((r) => {
      if (statusFilter === 'ISSUES' && (r.status === 'MATCHED' || r.status === 'NO_ACTIVITY')) return false;
      if (statusFilter !== 'ISSUES' && statusFilter !== 'ALL' && r.status !== statusFilter) return false;
      if (q && !`${r.branchName} ${r.branchCode}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [report.rows, statusFilter, search]);

  const exportRows = () =>
    downloadCsv(
      `reconciliation_${report.region}_${report.startDate}_${report.endDate}.csv`,
      [
        'Business day', 'Store', 'Branch code', 'Status', 'Sales orders', 'Refund orders', 'Excluded orders',
        'Odoo gross', 'Odoo net', 'Odoo tax', 'Invoiced orders', 'Invoice numbers', 'Invoiced net', 'Δ Invoice net',
        'Pricing gap', 'Till payments', 'Receipts (std − misc)', 'Δ Receipts', 'Provider payments', 'Credit payments',
        'Refunds', 'Credit memos', 'Δ Credit memos', 'Inventory expected', 'Inventory posted', 'Δ Inventory',
        'Inventory held', 'Inventory errors', 'Issues',
      ],
      report.rows.map((r) => [
        r.businessDay, r.branchName, r.branchCode, STATUS_LABEL[r.status], r.expected.salesOrders, r.expected.refundOrders,
        r.expected.excludedOrders, r.expected.salesGross, r.expected.salesNet, r.expected.salesTax, r.posted.invoicedOrders,
        r.posted.invoiceNumbers.join(' '), r.posted.invoiceNet, r.variance.invoiceNet, r.variance.pricingGap,
        r.expected.expectedReceipts, r.posted.receiptsGross, r.variance.receipts, r.expected.providerPayments,
        r.expected.creditPayments, r.expected.refundGross, r.posted.creditMemoAmount, r.variance.creditMemos,
        r.expected.inventoryQty, r.posted.inventoryQty, r.variance.inventoryQty, r.posted.inventoryHeld,
        r.posted.inventoryErrors, r.issues.join('; '),
      ]),
    );

  return (
    <>
      {/* Headline checks */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CheckTile
          title="Sales → Invoices (net)"
          expected={t.expected.salesNet}
          posted={t.posted.invoiceNet}
          variance={t.variance.invoiceNet}
          tol={tol}
          foot={`${t.posted.invoicedOrders} of ${t.expected.salesOrders} sales orders invoiced`}
        />
        <CheckTile
          title="Till payments → Receipts"
          expected={t.expected.expectedReceipts}
          posted={t.posted.receiptsGross}
          variance={t.variance.receipts}
          tol={tol}
          foot={`Excludes provider ${money(t.expected.providerPayments)} and credit ${money(t.expected.creditPayments)} (no receipt by design)`}
        />
        <CheckTile
          title="Refunds → Credit memos"
          expected={t.expected.refundGross}
          posted={t.posted.creditMemoAmount}
          variance={t.variance.creditMemos}
          tol={tol}
          foot={`${t.posted.creditMemos} of ${t.expected.refundOrders} refunds have a credit memo`}
        />
        <CheckTile
          title="Inventory quantity"
          expected={t.expected.inventoryQty}
          posted={t.posted.inventoryQty}
          variance={t.variance.inventoryQty}
          tol={qtol}
          format={qty}
          foot={`${t.posted.inventoryHeld} held for negative stock · ${t.posted.inventoryErrors} failed`}
        />
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {(['MATCHED', 'VARIANCE', 'NOT_POSTED', 'NO_ACTIVITY'] as ReconDayStatus[]).map((s) => (
          <span key={s} className={`rounded-full px-3 py-1 font-semibold ${STATUS_STYLE[s]}`}>
            {STATUS_LABEL[s]}: {t.storeDays[s]} store-day(s)
          </span>
        ))}
        {t.expected.excludedOrders > 0 && (
          <span className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-600">
            {t.expected.excludedOrders} draft/cancelled order(s) excluded ({money(t.expected.excludedAmount)})
          </span>
        )}
      </div>

      {report.notes.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          {report.notes.map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      )}

      {/* Store × day */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Store × business day</CardTitle>
            <CardDescription>
              Δ = expected from Odoo − posted in Oracle. ✓ means within ±{tol.toFixed(2)}. Click a row for the full breakdown.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
            >
              <option value="ISSUES">Needs attention</option>
              <option value="ALL">All</option>
              <option value="MATCHED">Matched</option>
              <option value="VARIANCE">Variance</option>
              <option value="NOT_POSTED">Not posted</option>
              <option value="NO_ACTIVITY">No sales</option>
            </select>
            <Input placeholder="Search store" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 w-44" />
            <Button variant="outline" size="sm" onClick={exportRows}>
              <Download className="mr-1.5 h-4 w-4" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Day</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Odoo net</TableHead>
                  <TableHead className="text-right">Invoiced net</TableHead>
                  <TableHead className="text-right">Δ Invoice</TableHead>
                  <TableHead className="text-right">Δ Receipts</TableHead>
                  <TableHead className="text-right">Δ Credit memos</TableHead>
                  <TableHead className="text-right">Δ Inventory</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center text-sm text-slate-400">
                      {statusFilter === 'ISSUES' ? 'Nothing needs attention 🎉' : 'No rows'}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => {
                    const key = `${r.branchCode}|${r.businessDay}`;
                    const isOpen = open === key;
                    return (
                      <Fragment key={key}>
                        <TableRow className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(isOpen ? null : key)}>
                          <TableCell>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{r.businessDay}</TableCell>
                          <TableCell className="text-sm">
                            {r.branchName}
                            {!r.isActive && r.branchCode !== '__UNMAPPED__' && (
                              <span className="ml-1 text-[10px] text-slate-400">(inactive)</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>
                              {STATUS_LABEL[r.status]}
                            </span>
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {r.expected.salesOrders}
                            {r.expected.refundOrders > 0 && <span className="text-slate-400"> / {r.expected.refundOrders}R</span>}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{money(r.expected.salesNet)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{money(r.posted.invoiceNet)}</TableCell>
                          <TableCell className="text-right text-xs">
                            <Delta value={r.variance.invoiceNet} tol={tol} />
                            {r.variance.ordersNotInvoiced > 0 && (
                              <div className="text-[10px] text-red-500">{r.variance.ordersNotInvoiced} not invoiced</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs"><Delta value={r.variance.receipts} tol={tol} /></TableCell>
                          <TableCell className="text-right text-xs"><Delta value={r.variance.creditMemos} tol={tol} /></TableCell>
                          <TableCell className="text-right text-xs"><Delta value={r.variance.inventoryQty} tol={qtol} format={qty} /></TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow>
                            <TableCell colSpan={11} className="bg-slate-50">
                              <RowDetail row={r} tol={tol} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <ExceptionsCard report={report} />
    </>
  );
}

function CheckTile({
  title,
  expected,
  posted,
  variance,
  tol,
  foot,
  format = money,
}: {
  title: string;
  expected: number;
  posted: number;
  variance: number;
  tol: number;
  foot: string;
  format?: (n: number) => string;
}) {
  const ok = !isOff(variance, tol);
  return (
    <div className={`rounded-xl border px-4 py-3 ${ok ? 'border-emerald-200 bg-emerald-50/50' : 'border-red-200 bg-red-50/50'}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</span>
        {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-red-600" />}
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-sm tabular-nums">
        <div>
          <dt className="text-[11px] text-slate-500">Odoo</dt>
          <dd className="font-semibold text-slate-900">{format(expected)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Oracle</dt>
          <dd className="font-semibold text-slate-900">{format(posted)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Δ</dt>
          <dd className={`font-semibold ${ok ? 'text-emerald-700' : 'text-red-700'}`}>
            {ok ? '✓' : `${variance > 0 ? '+' : ''}${format(variance)}`}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-slate-500">{foot}</p>
    </div>
  );
}

function RowDetail({ row, tol }: { row: ReconStoreDay; tol: number }) {
  const e = row.expected;
  const p = row.posted;
  const v = row.variance;
  const line = (label: string, odoo: string, oracle: string, delta?: React.ReactNode) => (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-1 pr-4 text-slate-600">{label}</td>
      <td className="py-1 pr-4 text-right tabular-nums">{odoo}</td>
      <td className="py-1 pr-4 text-right tabular-nums">{oracle}</td>
      <td className="py-1 text-right">{delta}</td>
    </tr>
  );
  return (
    <div className="grid gap-4 py-2 lg:grid-cols-[2fr_1fr]">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[11px] uppercase text-slate-400">
            <th className="pb-1 text-left font-medium">Check</th>
            <th className="pb-1 text-right font-medium">Odoo</th>
            <th className="pb-1 text-right font-medium">Oracle</th>
            <th className="pb-1 text-right font-medium">Δ</th>
          </tr>
        </thead>
        <tbody>
          {line('Sales orders → invoiced', String(e.salesOrders), String(p.invoicedOrders),
            v.ordersNotInvoiced ? <span className="font-semibold text-red-600">{v.ordersNotInvoiced} missing</span> : <span className="text-emerald-600">✓</span>)}
          {line('Sales gross (incl. tax)', money(e.salesGross), '—')}
          {line('Sales tax', money(e.salesTax), '—')}
          {line('Sales net → invoice total', money(e.salesNet), money(p.invoiceNet), <Delta value={v.invoiceNet} tol={tol} />)}
          {line('Invoice line pricing basis', money(e.invoiceBasis), '—', <Delta value={-v.pricingGap} tol={tol} />)}
          {line('Till payments → receipts', money(e.expectedReceipts), money(p.receiptsGross), <Delta value={v.receipts} tol={tol} />)}
          {line('  standard / bank charges / cash rounding', '', `${money(p.receiptsStandard)} / ${money(p.receiptsMisc)} / ${money(p.receiptsRounding)}`)}
          {line('Provider / credit payments (no receipt)', `${money(e.providerPayments)} / ${money(e.creditPayments)}`, '—')}
          {line('Refunds → credit memos', `${money(e.refundGross)} (${e.refundOrders})`, `${money(p.creditMemoAmount)} (${p.creditMemos})`, <Delta value={v.creditMemos} tol={tol} />)}
          {line('Inventory qty', qty(e.inventoryQty), qty(p.inventoryQty), <Delta value={v.inventoryQty} tol={0.0001} format={qty} />)}
          {line('Excluded (draft/cancelled)', `${e.excludedOrders} · ${money(e.excludedAmount)}`, '—')}
        </tbody>
      </table>
      <div className="space-y-2 text-xs">
        <div>
          <div className="font-semibold text-slate-600">Oracle invoice(s)</div>
          <div className="font-mono text-slate-800">{p.invoiceNumbers.length ? p.invoiceNumbers.join(', ') : '—'}</div>
        </div>
        {row.issues.length > 0 && (
          <div>
            <div className="font-semibold text-slate-600">Issues</div>
            <ul className="list-disc pl-4 text-red-700">
              {row.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
        {Math.abs(v.pricingGap) > tol && (
          <p className="rounded bg-amber-50 p-2 text-amber-800">
            Invoice lines are priced {money(v.pricingGap)} {v.pricingGap > 0 ? 'above' : 'below'} Odoo net — line discounts or
            tax-inclusive unit prices aren&apos;t reflected in the unit price sent to Oracle.
          </p>
        )}
      </div>
    </div>
  );
}

function ExceptionsCard({ report }: { report: ReconciliationReport }) {
  const [type, setType] = useState('ALL');
  const types = Object.entries(report.exceptionCounts).sort((a, b) => b[1] - a[1]);
  const list = type === 'ALL' ? report.exceptions : report.exceptions.filter((x) => x.type === type);
  const exportCsv = () =>
    downloadCsv(
      `reconciliation_exceptions_${report.region}_${report.startDate}_${report.endDate}.csv`,
      ['Type', 'Business day', 'Store', 'Order', 'Amount', 'Quantity', 'Detail'],
      list.map((x) => [EXCEPTION_LABEL[x.type] ?? x.type, x.businessDay, x.branchName, x.orderName, x.amount, x.quantity, x.detail]),
    );
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Order-level exceptions</CardTitle>
          <CardDescription>The exact orders behind every variance.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={list.length === 0}>
          <Download className="mr-1.5 h-4 w-4" /> CSV
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Chip active={type === 'ALL'} onClick={() => setType('ALL')} label={`All (${types.reduce((s, [, n]) => s + n, 0)})`} />
          {types.map(([t, n]) => (
            <Chip key={t} active={type === t} onClick={() => setType(t)} label={`${EXCEPTION_LABEL[t] ?? t} (${n})`} />
          ))}
        </div>
        {report.exceptionsTruncated && (
          <p className="text-xs text-amber-600">Showing the first {report.exceptions.length} exceptions — narrow the date range for the rest.</p>
        )}
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-emerald-600">No exceptions 🎉</p>
        ) : (
          <div className="max-h-[480px] overflow-auto rounded-lg border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Day</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.slice(0, 1000).map((x, i) => (
                  <TableRow key={`${x.type}-${x.orderName}-${i}`}>
                    <TableCell className="whitespace-nowrap text-xs font-medium">{EXCEPTION_LABEL[x.type] ?? x.type}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{x.businessDay}</TableCell>
                    <TableCell className="text-xs">{x.branchName}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{x.orderName ?? '—'}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{x.amount == null ? '' : money(x.amount)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{x.quantity == null ? '' : qty(x.quantity)}</TableCell>
                    <TableCell className="max-w-lg text-xs text-slate-600">{x.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {list.length > 1000 && <p className="text-xs text-slate-500">First 1000 shown — export CSV for all {list.length}.</p>}
      </CardContent>
    </Card>
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
        active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

// ── Odoo API ↔ Backup ───────────────────────────────────────────────────────

function OdooVsBackupSection({ report }: { report: OdooVsBackupReport }) {
  const [type, setType] = useState('ALL');
  if (!report.apiReachable) {
    return <ErrorBox text={`Odoo API not reachable for ${report.region}: ${report.error ?? 'unknown error'}`} />;
  }
  const t = report.totals;
  const inSync = t.missingInBackup === 0 && t.notInOdoo === 0 && t.mismatched === 0 && t.apiOrders === t.storedOrders;
  const counts = report.differences.reduce<Record<string, number>>((m, d) => ((m[d.type] = (m[d.type] ?? 0) + 1), m), {});
  const list = type === 'ALL' ? report.differences : report.differences.filter((d) => d.type === type);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="h-5 w-5 text-emerald-600" /> Odoo API ↔ Backup
          </CardTitle>
          <CardDescription>Every order Odoo returns, compared to what the pull stored (amount, state, lines, payments).</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={report.differences.length === 0}
          onClick={() =>
            downloadCsv(
              `odoo_vs_backup_${report.region}_${report.startDate}_${report.endDate}.csv`,
              ['Type', 'Business day', 'Branch', 'Odoo id', 'Order', 'Odoo', 'Stored'],
              list.map((d) => [DIFF_LABEL[d.type] ?? d.type, d.businessDay, d.branch, d.odooOrderId, d.orderName, d.odoo, d.stored]),
            )
          }
        >
          <Download className="mr-1.5 h-4 w-4" /> CSV
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <MiniTile label="Odoo orders" value={String(t.apiOrders)} />
          <MiniTile label="Stored orders" value={String(t.storedOrders)} />
          <MiniTile label="Odoo amount" value={money(t.apiAmount)} />
          <MiniTile label="Stored amount" value={money(t.storedAmount)} />
          <div className={`rounded-lg border px-4 py-3 ${inSync ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
            <div className={`text-lg font-bold ${inSync ? 'text-emerald-700' : 'text-red-700'}`}>{inSync ? 'In sync' : 'Differences'}</div>
            <div className="text-[11px] text-slate-500">
              {t.missingInBackup} missing · {t.notInOdoo} extra · {t.mismatched} mismatched
            </div>
          </div>
        </div>
        {report.notes.map((n) => (
          <p key={n} className="text-xs text-slate-500">• {n}</p>
        ))}

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Odoo orders</TableHead>
                <TableHead className="text-right">Stored</TableHead>
                <TableHead className="text-right">Odoo amount</TableHead>
                <TableHead className="text-right">Stored amount</TableHead>
                <TableHead className="text-right">Missing</TableHead>
                <TableHead className="text-right">Extra</TableHead>
                <TableHead className="text-right">Mismatched</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.days.map((d) => (
                <TableRow key={d.businessDay}>
                  <TableCell className="text-xs">{d.businessDay}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{d.apiOrders}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{d.storedOrders}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{money(d.apiAmount)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{money(d.storedAmount)}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${d.missingInBackup ? 'font-semibold text-red-600' : ''}`}>{d.missingInBackup}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${d.notInOdoo ? 'font-semibold text-red-600' : ''}`}>{d.notInOdoo}</TableCell>
                  <TableCell className={`text-right text-xs tabular-nums ${d.mismatched ? 'font-semibold text-amber-600' : ''}`}>{d.mismatched}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {report.differences.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              <Chip active={type === 'ALL'} onClick={() => setType('ALL')} label={`All (${report.differences.length})`} />
              {Object.entries(counts).map(([k, n]) => (
                <Chip key={k} active={type === k} onClick={() => setType(k)} label={`${DIFF_LABEL[k] ?? k} (${n})`} />
              ))}
            </div>
            <div className="max-h-96 overflow-auto rounded-lg border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Day</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Odoo</TableHead>
                    <TableHead>Stored</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.slice(0, 1000).map((d, i) => (
                    <TableRow key={`${d.type}-${d.odooOrderId}-${i}`}>
                      <TableCell className="whitespace-nowrap text-xs font-medium">{DIFF_LABEL[d.type] ?? d.type}</TableCell>
                      <TableCell className="text-xs">{d.businessDay ?? '—'}</TableCell>
                      <TableCell className="text-xs">{d.branch ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{d.orderName ?? d.odooOrderId}</TableCell>
                      <TableCell className="text-xs">{d.odoo}</TableCell>
                      <TableCell className="text-xs">{d.stored}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MiniTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-lg font-bold text-slate-900 tabular-nums">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
