'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ADMIN_TABLE_CONFIGS } from '@/components/admin/table-configs';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronLeft, ChevronRight, Download, Upload, Database, ServerCrash, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'boolean' | 'date' | 'textarea';
  readOnly?: boolean;   // shown but not editable
  hidden?: boolean;     // never shown in form
  tableHidden?: boolean; // not shown in table
  required?: boolean;
}

interface GenericAdminTableProps {
  table: string;
  title: string;
  fields: FieldDef[];
  readOnly?: boolean; // no create/edit (e.g. backup tables)
  pageSize?: number;
}

type RecordRow = Record<string, unknown>;

function RecordForm({
  fields,
  initial,
  onSave,
  isPending,
}: {
  fields: FieldDef[];
  initial: RecordRow;
  onSave: (data: RecordRow) => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<RecordRow>(initial);
  const set = (key: string, value: unknown) => setForm((p) => ({ ...p, [key]: value }));

  const formFields = fields.filter((f) => !f.hidden && !f.readOnly);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {formFields.map((f) => (
          <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
            <Label htmlFor={f.key} className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              {f.label}
              {f.required && <span className="ml-0.5 text-red-500">*</span>}
            </Label>
            {f.type === 'boolean' ? (
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="checkbox"
                  id={f.key}
                  checked={!!form[f.key]}
                  onChange={(e) => set(f.key, e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                <span className="text-sm text-slate-500">{form[f.key] ? 'Enabled' : 'Disabled'}</span>
              </div>
            ) : f.type === 'textarea' ? (
              <textarea
                id={f.key}
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                rows={3}
                value={String(form[f.key] ?? '')}
                onChange={(e) => set(f.key, e.target.value)}
              />
            ) : (
              <Input
                id={f.key}
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                value={f.type === 'date'
                  ? (form[f.key] ? String(form[f.key]).slice(0, 10) : '')
                  : String(form[f.key] ?? '')}
                onChange={(e) =>
                  set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)
                }
                className="mt-1.5"
              />
            )}
          </div>
        ))}
      </div>
      <Button
        className="w-full bg-indigo-600 hover:bg-indigo-700"
        onClick={() => onSave(form)}
        disabled={isPending}
      >
        {isPending ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}

export function GenericAdminTable({
  table,
  title,
  fields,
  readOnly = false,
  pageSize = 20,
}: GenericAdminTableProps) {
  const qc = useQueryClient();
  const [skip, setSkip] = useState(0);
  const [region, setRegion] = useState('');
  const [editRecord, setEditRecord] = useState<RecordRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [oracleOpen, setOracleOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Look up oracle table name from config — avoids auto-generating mismatched names
  const oracleTable = ADMIN_TABLE_CONFIGS[table]?.oracleTable;

  const { data, isLoading } = useQuery({
    queryKey: ['admin', table, skip, region],
    queryFn: () => api.adminList(table, { skip, take: pageSize, region: region || undefined }),
  });

  const createMutation = useMutation({
    mutationFn: (body: RecordRow) => api.adminCreate(table, body),
    onSuccess: () => {
      toast.success('Record created');
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ['admin', table] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: RecordRow }) =>
      api.adminUpdate(table, id, body),
    onSuccess: () => {
      toast.success('Record updated');
      setEditRecord(null);
      qc.invalidateQueries({ queryKey: ['admin', table] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.adminDelete(table, id),
    onSuccess: () => {
      toast.success('Record deleted');
      qc.invalidateQueries({ queryKey: ['admin', table] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const oracleImportMutation = useMutation({
    mutationFn: () => api.oracleImport(oracleTable ? [oracleTable] : undefined),
    onSuccess: (result) => {
      const r = result.results[0];
      if (r) {
        toast.success(`Oracle import: ${r.imported} imported, ${r.skipped} skipped`);
        if (r.errors.length > 0) {
          toast.warning(`${r.errors.length} row error(s) — check logs for details`);
        }
      } else {
        toast.info('Oracle import complete — no matching Oracle table found in schema');
      }
      setOracleOpen(false);
      qc.invalidateQueries({ queryKey: ['admin', table] });
    },
    onError: (e: Error) => toast.error(`Oracle import failed: ${e.message}`),
  });

  const handleExportCsv = () => {
    const url = api.adminExportCsvUrl(table, region || undefined);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${table}-export.csv`;
    link.click();
  };

  const handleImportCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await api.adminImportCsv(table, file);
      toast.success(`Imported ${result.imported} records (${result.skipped} skipped)`);
      if (result.errors.length > 0) {
        toast.warning(`${result.errors.length} rows had errors`);
      }
      qc.invalidateQueries({ queryKey: ['admin', table] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const tableFields = fields.filter((f) => !f.tableHidden);
  const emptyRecord = Object.fromEntries(
    fields.filter((f) => !f.hidden && !f.readOnly).map((f) => [f.key, f.type === 'boolean' ? false : f.type === 'number' ? 0 : '']),
  );
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const currentPage = Math.floor(skip / pageSize) + 1;

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {readOnly ? 'Read-only archive — export & view only' : 'Full CRUD · create, edit, delete, import & export'}
          </p>
        </div>
      </div>

      {/* Hidden file input for CSV import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleImportCsv}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Region filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Region:</label>
          <input
            type="text"
            placeholder="All regions"
            value={region}
            onChange={(e) => { setRegion(e.target.value); setSkip(0); }}
            className="h-8 w-36 rounded-lg border border-slate-200 bg-white px-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Export CSV */}
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportCsv}
            disabled={total === 0}
            className="h-8 border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
          </Button>

          {/* Import CSV */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="h-8 border-slate-200 text-slate-600 hover:border-emerald-300 hover:text-emerald-700"
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" /> Import CSV
          </Button>

          {/* Import from Oracle DB — only shown for tables with an oracle mapping */}
          {oracleTable && (
            <Dialog open={oracleOpen} onOpenChange={setOracleOpen}>
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-slate-200 text-slate-600 hover:border-purple-300 hover:text-purple-700"
                >
                  <Database className="mr-1.5 h-3.5 w-3.5" /> Import from Oracle
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Database className="h-5 w-5 text-purple-600" />
                    Import from Oracle DB
                  </DialogTitle>
                  <DialogDescription>
                    Connect to Oracle and upsert records into the <strong>{title}</strong> table.
                  </DialogDescription>
                </DialogHeader>

                <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-600 space-y-2">
                  <p>
                    This will connect to the Oracle <code className="rounded bg-slate-200 px-1 py-0.5 text-xs font-mono">ODOO_INTEGRATION</code> schema
                    and import the <code className="rounded bg-purple-100 px-1 py-0.5 text-xs font-mono text-purple-700">{oracleTable}</code> table.
                    Existing records will be updated (upserted).
                  </p>
                  <p className="text-xs text-slate-400">
                    Requires <code className="font-mono">ORACLE_DB_HOST</code>, <code className="font-mono">ORACLE_DB_SERVICE</code>,{' '}
                    <code className="font-mono">ORACLE_DB_USERNAME</code> and <code className="font-mono">ORACLE_DB_PASSWORD</code> to be
                    configured in the backend environment.
                  </p>
                </div>

                {oracleImportMutation.isError && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    <ServerCrash className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{(oracleImportMutation.error as Error).message}</span>
                  </div>
                )}

                <Button
                  className="w-full bg-purple-600 hover:bg-purple-700"
                  onClick={() => oracleImportMutation.mutate()}
                  disabled={oracleImportMutation.isPending}
                >
                  {oracleImportMutation.isPending ? 'Connecting to Oracle…' : 'Start Oracle Import'}
                </Button>
              </DialogContent>
            </Dialog>
          )}

          {/* New record */}
          {!readOnly && (
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="h-8 bg-indigo-600 hover:bg-indigo-700">
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> New
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Create {title}</DialogTitle>
                  <DialogDescription>Fill in the fields below to create a new record.</DialogDescription>
                </DialogHeader>
                <RecordForm
                  fields={fields}
                  initial={emptyRecord}
                  onSave={(body) => createMutation.mutate(body)}
                  isPending={createMutation.isPending}
                />
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Table card */}
      <Card className="overflow-hidden border-slate-200 shadow-sm">
        <CardHeader className="border-b border-slate-100 bg-slate-50/60 px-5 py-3">
          <CardTitle className="text-sm font-semibold text-slate-700">
            {total > 0
              ? `${total.toLocaleString()} record${total !== 1 ? 's' : ''}${total > pageSize ? ` · page ${currentPage} of ${totalPages}` : ''}`
              : 'Records'}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-slate-400">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/40">
                      {tableFields.map((f) => (
                        <th key={f.key} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">
                          {f.label}
                        </th>
                      ))}
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data?.data.map((row: RecordRow, idx: number) => (
                      <tr key={String(row.id)} className={idx % 2 === 0 ? 'bg-white hover:bg-indigo-50/30' : 'bg-slate-50/40 hover:bg-indigo-50/30'}>
                        {tableFields.map((f) => (
                          <td key={f.key} className="px-4 py-2.5 max-w-[200px] truncate text-slate-700">
                            {f.type === 'boolean' ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${row[f.key] ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-slate-100 text-slate-500'}`}>
                                {row[f.key] ? 'Yes' : 'No'}
                              </span>
                            ) : f.type === 'date' ? (
                              <span className="text-slate-500 text-xs font-mono">
                                {row[f.key] ? String(row[f.key]).slice(0, 10) : <span className="text-slate-300">—</span>}
                              </span>
                            ) : (
                              <span title={String(row[f.key] ?? '')}>
                                {row[f.key] != null && row[f.key] !== ''
                                  ? String(row[f.key])
                                  : <span className="text-slate-300">—</span>}
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1.5">
                            {!readOnly && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditRecord(row)}
                                className="h-7 w-7 p-0 border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 w-7 p-0 border-slate-200 text-slate-400 hover:border-red-300 hover:text-red-600"
                              onClick={() => {
                                if (confirm('Delete this record?')) {
                                  deleteMutation.mutate(String(row.id));
                                }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {(!data?.data || data.data.length === 0) && (
                      <tr>
                        <td
                          colSpan={tableFields.length + 1}
                          className="py-16 text-center"
                        >
                          <div className="flex flex-col items-center gap-2 text-slate-400">
                            <Inbox className="h-8 w-8 text-slate-300" />
                            <span className="text-sm">No records found</span>
                            {region && (
                              <span className="text-xs text-slate-400">
                                Filtered by region: <span className="font-medium">{region}</span>
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {total > pageSize && (
                <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/40 px-5 py-3 text-sm text-slate-500">
                  <span className="text-xs">
                    Showing <span className="font-semibold text-slate-700">{skip + 1}–{Math.min(skip + pageSize, total)}</span>{' '}
                    of <span className="font-semibold text-slate-700">{total.toLocaleString()}</span>
                  </span>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={skip === 0}
                      onClick={() => setSkip(Math.max(0, skip - pageSize))}
                      className="h-7 border-slate-200"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={skip + pageSize >= total}
                      onClick={() => setSkip(skip + pageSize)}
                      className="h-7 border-slate-200"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Edit dialog */}
      {editRecord && (
        <Dialog open onOpenChange={(v) => !v && setEditRecord(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Edit {title}</DialogTitle>
              <DialogDescription>Update the fields below and save your changes.</DialogDescription>
            </DialogHeader>
            <RecordForm
              fields={fields}
              initial={editRecord}
              onSave={(body) =>
                updateMutation.mutate({ id: String(editRecord.id), body })
              }
              isPending={updateMutation.isPending}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

