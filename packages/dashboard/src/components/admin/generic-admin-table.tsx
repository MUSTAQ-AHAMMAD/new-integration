'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
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
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {formFields.map((f) => (
          <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
            <Label htmlFor={f.key}>
              {f.label}
              {f.required && <span className="ml-0.5 text-red-500">*</span>}
            </Label>
            {f.type === 'boolean' ? (
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  id={f.key}
                  checked={!!form[f.key]}
                  onChange={(e) => set(f.key, e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </div>
            ) : f.type === 'textarea' ? (
              <textarea
                id={f.key}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
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
              />
            )}
          </div>
        ))}
      </div>
      <Button className="w-full" onClick={() => onSave(form)} disabled={isPending}>
        {isPending ? 'Saving...' : 'Save'}
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
  const [editRecord, setEditRecord] = useState<RecordRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', table, skip],
    queryFn: () => api.adminList(table, { skip, take: pageSize }),
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

  const tableFields = fields.filter((f) => !f.tableHidden);
  const emptyRecord = Object.fromEntries(
    fields.filter((f) => !f.hidden && !f.readOnly).map((f) => [f.key, f.type === 'boolean' ? false : f.type === 'number' ? 0 : '']),
  );
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const currentPage = Math.floor(skip / pageSize) + 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">{title}</h2>
        {!readOnly && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1 h-4 w-4" /> New
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Create {title}</DialogTitle>
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

      <Card>
        <CardHeader>
          <CardTitle>
            {total} record{total !== 1 ? 's' : ''}
            {total > pageSize && ` — page ${currentPage} of ${totalPages}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      {tableFields.map((f) => (
                        <th key={f.key} className="pb-3 pr-4 whitespace-nowrap">
                          {f.label}
                        </th>
                      ))}
                      <th className="pb-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data?.data.map((row: RecordRow) => (
                      <tr key={String(row.id)} className="hover:bg-gray-50">
                        {tableFields.map((f) => (
                          <td key={f.key} className="py-2 pr-4 max-w-[200px] truncate">
                            {f.type === 'boolean' ? (
                              <span className={row[f.key] ? 'text-green-600' : 'text-gray-400'}>
                                {row[f.key] ? 'Yes' : 'No'}
                              </span>
                            ) : f.type === 'date' ? (
                              <span className="text-gray-500 text-xs">
                                {row[f.key] ? String(row[f.key]).slice(0, 10) : '—'}
                              </span>
                            ) : (
                              <span title={String(row[f.key] ?? '')}>
                                {row[f.key] != null && row[f.key] !== '' ? String(row[f.key]) : <span className="text-gray-300">—</span>}
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="py-2">
                          <div className="flex gap-1">
                            {!readOnly && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditRecord(row)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-red-500 hover:text-red-700"
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
                          className="py-8 text-center text-gray-400"
                        >
                          No records found
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {total > pageSize && (
                <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
                  <span>
                    {skip + 1}–{Math.min(skip + pageSize, total)} of {total}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={skip === 0}
                      onClick={() => setSkip(Math.max(0, skip - pageSize))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={skip + pageSize >= total}
                      onClick={() => setSkip(skip + pageSize)}
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
