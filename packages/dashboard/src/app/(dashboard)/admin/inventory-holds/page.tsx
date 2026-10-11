'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PackageX, RefreshCw, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, type InventoryHoldRow } from '@/lib/api';
import { useRegion } from '@/providers/region-provider';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/error-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PAGE_SIZE = 50;

const STATUS_TABS: Array<{ status: string; label: string; hint: string }> = [
  {
    status: 'NEGATIVE_INVENTORY',
    label: 'Negative stock',
    hint: 'Oracle refused the issue because the subinventory would go negative. Fix the stock in Oracle, then reprocess.',
  },
  {
    status: 'ERROR',
    label: 'Other errors',
    hint: 'Rejected for another reason (unknown item, UoM, subinventory mapping, Oracle outage). Fix the cause, then reprocess.',
  },
  {
    status: 'SUCCESS',
    label: 'Posted',
    hint: 'Rows Oracle accepted. Shown for reference only.',
  },
];

function fmtDate(v: string | null) {
  return v ? new Date(v).toISOString().slice(0, 10) : '—';
}

export default function InventoryHoldsPage() {
  const qc = useQueryClient();
  const { selectedRegion } = useRegion();
  const [status, setStatus] = useState('NEGATIVE_INVENTORY');
  const [skip, setSkip] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['inventory-holds', status, selectedRegion, skip],
    queryFn: () =>
      api.listInventoryHolds({ status, region: selectedRegion, skip, take: PAGE_SIZE }),
  });

  const reprocess = useMutation({
    mutationFn: (body: { ids?: string[]; statuses?: string[]; region?: string | null }) =>
      api.reprocessInventoryHolds(body),
    onSuccess: (r) => {
      const parts = [`${r.success} posted`];
      if (r.negativeHeld) parts.push(`${r.negativeHeld} still negative`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.skipped) parts.push(`${r.skipped} already posted`);
      const msg = `Reprocessed ${r.selected} row(s): ${parts.join(', ')}`;
      if (r.success > 0 && r.negativeHeld + r.failed === 0) toast.success(msg);
      else toast.warning(msg);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['inventory-holds'] });
    },
    onError: (e: Error) => toast.error(`Reprocess failed: ${e.message}`),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const canReprocess = status !== 'SUCCESS';
  const tab = STATUS_TABS.find((t) => t.status === status) ?? STATUS_TABS[0];
  const allOnPageSelected = items.length > 0 && items.every((r) => selected.has(r.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) items.forEach((r) => next.delete(r.id));
      else items.forEach((r) => next.add(r.id));
      return next;
    });

  const switchTab = (s: string) => {
    setStatus(s);
    setSkip(0);
    setSelected(new Set());
    setExpanded(null);
  };

  const reprocessAll = () => {
    const scope = selectedRegion ? `region ${selectedRegion}` : 'ALL regions';
    if (!window.confirm(`Re-send every "${tab.label}" row for ${scope} to Oracle (up to 2000 per run)?`)) return;
    reprocess.mutate({ statuses: [status], region: selectedRegion });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventory Holds"
        subtitle="Inventory rows Oracle refused during integration. The rest of the day still posted; reprocess these once the cause is fixed."
        icon={PackageX}
        iconColor="bg-amber-500"
      >
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t.status}
            type="button"
            onClick={() => switchTab(t.status)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              status === t.status
                ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t.label}
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-700">
              {data?.counts?.[t.status] ?? '…'}
            </span>
          </button>
        ))}
        {canReprocess && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || reprocess.isPending}
              onClick={() => reprocess.mutate({ ids: [...selected], statuses: [status] })}
            >
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Reprocess selected ({selected.size})
            </Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={total === 0 || reprocess.isPending}
              onClick={reprocessAll}
            >
              <RotateCcw className={`mr-1.5 h-4 w-4 ${reprocess.isPending ? 'animate-spin' : ''}`} />
              {reprocess.isPending ? 'Reprocessing…' : `Reprocess all ${tab.label.toLowerCase()}`}
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-slate-500">{tab.hint}</p>

      <Card>
        <CardContent className="p-0">
          {isError ? (
            <ErrorState message={(error as Error)?.message} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {canReprocess && (
                      <TableHead className="w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all rows on this page"
                          checked={allOnPageSelected}
                          onChange={togglePage}
                        />
                      </TableHead>
                    )}
                    <TableHead>Txn date</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Order ref</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Subinventory</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Retries</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-sm text-slate-400">
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-sm text-slate-400">
                        Nothing here{selectedRegion ? ` for ${selectedRegion}` : ''}.
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map((r: InventoryHoldRow) => (
                      <HoldRow
                        key={r.id}
                        row={r}
                        selectable={canReprocess}
                        selected={selected.has(r.id)}
                        onToggle={() => toggle(r.id)}
                        expanded={expanded === r.id}
                        onExpand={() => setExpanded(expanded === r.id ? null : r.id)}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          {total === 0 ? '0 rows' : `${skip + 1}–${Math.min(skip + PAGE_SIZE, total)} of ${total}`}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" disabled={skip + PAGE_SIZE >= total} onClick={() => setSkip(skip + PAGE_SIZE)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function HoldRow({
  row,
  selectable,
  selected,
  onToggle,
  expanded,
  onExpand,
}: {
  row: InventoryHoldRow;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  expanded: boolean;
  onExpand: () => void;
}) {
  const qty = row.txnQty ?? 0;
  return (
    <>
      <TableRow className={selected ? 'bg-indigo-50/50' : undefined}>
        {selectable && (
          <TableCell>
            <input type="checkbox" aria-label={`Select ${row.txnSourceName} ${row.itemNumber}`} checked={selected} onChange={onToggle} />
          </TableCell>
        )}
        <TableCell className="whitespace-nowrap text-xs">{fmtDate(row.txnDate)}</TableCell>
        <TableCell className="text-xs">{row.region}</TableCell>
        <TableCell className="whitespace-nowrap font-mono text-xs">{row.txnSourceName ?? '—'}</TableCell>
        <TableCell className="font-mono text-xs">{row.itemNumber ?? '—'}</TableCell>
        <TableCell className="text-xs">{row.subInventory ?? '—'}</TableCell>
        <TableCell className="whitespace-nowrap text-xs">{row.txnType ?? '—'}</TableCell>
        <TableCell className={`text-right font-mono text-xs tabular-nums ${qty < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
          {qty} {row.txnUom ?? ''}
        </TableCell>
        <TableCell className="max-w-md text-xs text-slate-700">
          <button type="button" onClick={onExpand} className="text-left hover:underline" title="Show request / response">
            {row.holdReason || row.message?.split('\n')[0] || '—'}
          </button>
        </TableCell>
        <TableCell className="text-right text-xs tabular-nums">{row.retryCount ?? 0}</TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={selectable ? 10 : 9} className="bg-slate-50">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-[11px] text-slate-700">
              {row.message ?? 'No request/response recorded.'}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
