'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import { useRegion } from '@/providers/region-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PageHeader } from '@/components/ui/page-header';
import { RefreshCw, Save, Store } from 'lucide-react';
import {
  api,
  type BillToRow,
  type RegionBillToSummary,
  type StoreBillTo,
} from '@/lib/api';

const STATUS_LABEL: Record<StoreBillTo['status'], string> = {
  MAPPED: 'Mapped',
  REGION_DEFAULT: 'Region default',
  MISSING: 'Missing',
};

/** "KHURAISSQ → acct 83012 · site 68003 (SA)" — subinventory is the store key. */
function templateLabel(t: BillToRow): string {
  return (
    `${t.subinventory ?? '—'} → ${t.billToName} · acct ${t.billToAccount}` +
    ` · site ${t.siteNumber ?? '—'} (${t.region})`
  );
}

function billToSummary(b: BillToRow | null): string {
  if (!b) return '—';
  return `${b.billToName} · acct ${b.billToAccount} · site ${b.siteNumber ?? '—'}`;
}

export default function BillToMappingPage() {
  const { selectedRegion } = useRegion();
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [includeProviders, setIncludeProviders] = useState(true);
  /** storeId → chosen template id (seeded from suggestions). */
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTemplate, setBulkTemplate] = useState('');

  const status = useQuery({
    queryKey: ['bill-to-mapping', selectedRegion],
    queryFn: () => api.billToMappingStatus(selectedRegion ?? undefined),
  });
  const data = status.data;

  // Seed each unmapped store's picker with the suggested bill-to.
  useEffect(() => {
    if (!data) return;
    setChoice((prev) => {
      const next = { ...prev };
      for (const s of data.stores) {
        if (!next[s.storeId] && s.suggestion) {
          next[s.storeId] = s.suggestion.templateId;
        }
      }
      return next;
    });
  }, [data]);

  const applyMut = useMutation({
    mutationFn: api.billToMappingApply,
    onSuccess: (r) => {
      toast.success(
        `Saved: ${r.created} created, ${r.updated} updated` +
          (r.providerRowsCopied
            ? `, ${r.providerRowsCopied} delivery-platform rows copied`
            : ''),
      );
      setSelected(new Set());
      void status.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Templates sorted so the same business unit comes first for a region.
  const templatesFor = (region: string, bu: string | null) =>
    [...(data?.templates ?? [])].sort((a, b) => {
      const rank = (t: BillToRow) =>
        (t.region === region ? 0 : t.businessUnit === bu ? 1 : 2);
      return rank(a) - rank(b) || templateLabel(a).localeCompare(templateLabel(b));
    });

  const buByRegion = useMemo(
    () => new Map((data?.regions ?? []).map((r) => [r.region, r.businessUnit])),
    [data],
  );

  const rows = useMemo(() => {
    const q = search.trim().toUpperCase();
    return (data?.stores ?? []).filter(
      (s) =>
        (showAll || s.status === 'MISSING') &&
        (!q ||
          s.branchName.toUpperCase().includes(q) ||
          s.branchCode.toUpperCase().includes(q)),
    );
  }, [data, showAll, search]);

  const missingTotal = (data?.stores ?? []).filter(
    (s) => s.status === 'MISSING',
  ).length;

  const saveStores = (ids: string[], templateFor: (id: string) => string) => {
    const stores = ids
      .map((storeId) => ({ storeId, templateId: templateFor(storeId) }))
      .filter((a) => a.templateId);
    if (stores.length === 0) {
      toast.error('Pick a bill-to for at least one store first');
      return;
    }
    applyMut.mutate({ stores, includeProviders });
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selected.has(r.storeId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bill-to Mapping"
        subtitle="Every invoice needs a Fusion Sales Metadata row whose Subinventory is the store name — that row supplies the Bill-To Account and Site Number. Stores without one fail to post. Fix them here by picking an existing bill-to; no account numbers to type."
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <Button
            variant="outline"
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${status.isFetching ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeProviders}
              onChange={(e) => setIncludeProviders(e.target.checked)}
            />
            Also copy delivery-platform bill-tos (TABBY, TAMARA, …) where missing
          </label>
          <span className="text-sm text-muted-foreground">
            {selectedRegion ? `Region: ${selectedRegion}` : 'All regions'} ·{' '}
            {missingTotal} store(s) missing a bill-to
          </span>
          <Link
            href="/admin/fusion-sales-metadata"
            className="ml-auto text-sm underline"
          >
            Edit raw Sales Metadata
          </Link>
        </CardContent>
      </Card>

      {status.isError && (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {(status.error as Error).message}
          </CardContent>
        </Card>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.regions.map((r) => (
            <RegionCard
              key={r.region}
              summary={r}
              templates={templatesFor(r.region, r.businessUnit)}
              busy={applyMut.isPending}
              onSetDefault={(templateId) =>
                applyMut.mutate({
                  regionDefaults: [{ region: r.region, templateId }],
                  includeProviders,
                })
              }
            />
          ))}
        </div>
      )}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Store className="h-5 w-5" /> Stores
            </CardTitle>
            <CardDescription>
              Pick the bill-to each store should use and save. A suggestion is
              pre-selected when the same store name exists elsewhere.
            </CardDescription>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Input
                placeholder="Search store name or code"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                Show mapped stores too
              </label>
              <Button
                onClick={() => saveStores([...selected], (id) => choice[id])}
                disabled={applyMut.isPending || selected.size === 0}
              >
                <Save className="mr-2 h-4 w-4" />
                Save selected ({selected.size})
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <span className="text-sm text-muted-foreground">
                Map all selected to one bill-to:
              </span>
              <TemplateSelect
                value={bulkTemplate}
                templates={data.templates}
                onChange={setBulkTemplate}
              />
              <Button
                variant="outline"
                disabled={
                  applyMut.isPending || selected.size === 0 || !bulkTemplate
                }
                onClick={() => saveStores([...selected], () => bulkTemplate)}
              >
                Apply to selected
              </Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={() =>
                        setSelected(
                          allVisibleSelected
                            ? new Set()
                            : new Set(rows.map((r) => r.storeId)),
                        )
                      }
                    />
                  </TableHead>
                  <TableHead>Store (Subinventory)</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Current bill-to</TableHead>
                  <TableHead>Map to</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                      {showAll ? 'No stores.' : 'Every store has a bill-to. 🎉'}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((s) => (
                  <TableRow key={s.storeId}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(s.storeId)}
                        onChange={() => toggle(s.storeId)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{s.branchName}</TableCell>
                    <TableCell>{s.branchCode}</TableCell>
                    <TableCell>{s.region}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          s.status === 'MISSING'
                            ? 'destructive'
                            : s.status === 'REGION_DEFAULT'
                              ? 'secondary'
                              : 'default'
                        }
                      >
                        {STATUS_LABEL[s.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {billToSummary(s.billTo)}
                    </TableCell>
                    <TableCell>
                      <TemplateSelect
                        value={choice[s.storeId] ?? ''}
                        templates={templatesFor(
                          s.region,
                          buByRegion.get(s.region) ?? null,
                        )}
                        onChange={(v) =>
                          setChoice((prev) => ({ ...prev, [s.storeId]: v }))
                        }
                      />
                      {s.suggestion &&
                        choice[s.storeId] === s.suggestion.templateId && (
                          <div className="pt-1 text-xs text-muted-foreground">
                            Suggested: {s.suggestion.reason}
                          </div>
                        )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={applyMut.isPending || !choice[s.storeId]}
                        onClick={() =>
                          saveStores([s.storeId], (id) => choice[id])
                        }
                      >
                        Save
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TemplateSelect({
  value,
  templates,
  onChange,
}: {
  value: string;
  templates: BillToRow[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      className="w-full max-w-[420px] rounded-md border border-input bg-background px-2 py-1 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">— choose a bill-to —</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>
          {templateLabel(t)}
        </option>
      ))}
    </select>
  );
}

function RegionCard({
  summary,
  templates,
  busy,
  onSetDefault,
}: {
  summary: RegionBillToSummary;
  templates: BillToRow[];
  busy: boolean;
  onSetDefault: (templateId: string) => void;
}) {
  const [templateId, setTemplateId] = useState('');
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>
            {summary.region}
            {summary.businessUnit ? ` · ${summary.businessUnit}` : ''}
          </span>
          {summary.missing > 0 ? (
            <Badge variant="destructive">{summary.missing} missing</Badge>
          ) : (
            <Badge>all mapped</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {summary.stores} active stores · {summary.mapped} own bill-to ·{' '}
          {summary.viaDefault} via region default
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div>
          <span className="text-muted-foreground">Region default: </span>
          {summary.regionDefault ? billToSummary(summary.regionDefault) : 'none'}
        </div>
        <div className="text-xs text-muted-foreground">
          Any store in {summary.region} without its own row will use the region
          default — new stores never fail.
        </div>
        <div className="flex items-center gap-2">
          <TemplateSelect
            value={templateId}
            templates={templates}
            onChange={setTemplateId}
          />
          <Button
            size="sm"
            disabled={busy || !templateId}
            onClick={() => onSetDefault(templateId)}
          >
            Set default
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
