'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type StoreConfig, type UpsertStoreConfigDto } from '@/lib/api';
import { getStatusColor } from '@/lib/utils';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ShieldCheck, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState } from '@/components/ui/error-state';

const EMPTY_FORM: UpsertStoreConfigDto = {
  branchCode: '',
  branchName: '',
  odooBranchId: 0,
  oracleOperatingUnitId: 0,
  oracleBusinessUnit: '',
  billToSiteName: '',
  billToLocation: '',
  bankAccountName: '',
  cashAccountName: '',
  paymentTermsName: '',
  taxClassificationCode: '',
  transactionSource: 'Manual',
  transactionType: 'PASA CONSULTING SALE',
  invoiceCurrencyCode: 'AED',
  isActive: true,
  createdBy: 'DASHBOARD_USER',
};

function StoreFormDialog({
  trigger,
  initial,
  mode,
  onSaved,
}: {
  trigger: React.ReactNode;
  initial?: UpsertStoreConfigDto;
  mode: 'create' | 'edit';
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<UpsertStoreConfigDto>(initial ?? EMPTY_FORM);

  const set = (key: keyof UpsertStoreConfigDto, value: string | number | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const mutation = useMutation({
    mutationFn: () =>
      mode === 'create'
        ? api.upsertStore(form)
        : api.updateStore(form.branchCode, form),
    onSuccess: () => {
      toast.success(mode === 'create' ? 'Store created' : 'Store updated');
      setOpen(false);
      if (mode === 'create') setForm(EMPTY_FORM);
      onSaved();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const field = (
    id: keyof UpsertStoreConfigDto,
    label: string,
    opts?: { type?: string; required?: boolean; disabled?: boolean; placeholder?: string },
  ) => (
    <div>
      <Label htmlFor={id}>{label}{opts?.required && <span className="ml-0.5 text-red-500">*</span>}</Label>
      <Input
        id={id}
        type={opts?.type ?? 'text'}
        disabled={opts?.disabled}
        placeholder={opts?.placeholder}
        value={String(form[id] ?? '')}
        onChange={(e) =>
          set(id, opts?.type === 'number' ? Number(e.target.value) : e.target.value)
        }
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v && initial) setForm(initial); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New Store Configuration' : `Edit ${form.branchCode}`}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          {field('branchCode', 'Branch Code', { required: true, disabled: mode === 'edit', placeholder: 'STORE-001' })}
          {field('branchName', 'Branch Name', { required: true, placeholder: 'Main Store' })}
          {field('odooBranchId', 'Odoo Branch ID', { type: 'number', required: true })}
          {field('oracleOperatingUnitId', 'Oracle Operating Unit ID', { type: 'number', required: true })}
          {field('oracleBusinessUnit', 'Oracle Business Unit', { required: true })}
          {field('billToSiteName', 'Bill-To Site Name', { required: true })}
          {field('billToLocation', 'Bill-To Location')}
          {field('bankAccountName', 'Bank Account Name', { required: true })}
          {field('cashAccountName', 'Cash Account Name', { required: true })}
          {field('paymentTermsName', 'Payment Terms Name', { required: true })}
          {field('taxClassificationCode', 'Tax Classification Code')}
          {field('transactionSource', 'Transaction Source')}
          {field('transactionType', 'Transaction Type')}
          {field('invoiceCurrencyCode', 'Invoice Currency Code')}
          <div className="col-span-2 flex items-center gap-2">
            <input
              id="isActive"
              type="checkbox"
              checked={!!form.isActive}
              onChange={(e) => set('isActive', e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <Label htmlFor="isActive">Active</Label>
          </div>
        </div>
        <Button className="w-full" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving...' : mode === 'create' ? 'Create Store' : 'Save Changes'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function storeToFormDto(store: StoreConfig): UpsertStoreConfigDto {
  return {
    branchCode: store.branchCode,
    branchName: store.branchName,
    odooBranchId: store.odooBranchId,
    oracleOperatingUnitId: store.oracleOperatingUnitId,
    oracleBusinessUnit: store.oracleBusinessUnit,
    billToSiteName: store.billToSiteName,
    billToLocation: store.billToLocation ?? '',
    bankAccountName: store.bankAccountName,
    cashAccountName: store.cashAccountName,
    paymentTermsName: store.paymentTermsName,
    taxClassificationCode: store.taxClassificationCode ?? '',
    transactionSource: store.transactionSource,
    transactionType: store.transactionType,
    invoiceCurrencyCode: store.invoiceCurrencyCode,
    isActive: store.isActive,
    createdBy: store.createdBy,
  };
}

export default function StoresPage() {
  const qc = useQueryClient();

  const { data: stores, isLoading, isError } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api.listStores(),
  });

  const validateMutation = useMutation({
    mutationFn: (code: string) => api.validateStore(code),
    onSuccess: (result, code) => {
      const message = result.isValid ? `Store ${code} is valid` : `Store ${code} has errors: ${result.errors.join(', ')}`;
      if (result.isValid) toast.success(message);
      else toast.error(message);
      qc.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (code: string) => api.deleteStore(code),
    onSuccess: (_, code) => {
      toast.success(`Store ${code} deleted`);
      qc.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const pushStoreMutation = useMutation({
    mutationFn: (code: string) => api.pushStore(code),
    onSuccess: (_, code) => {
      toast.success(`Sync job queued for store ${code}`);
      qc.invalidateQueries({ queryKey: ['sync-jobs'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['stores'] });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Store Configurations</h1>
          <p className="text-sm text-gray-500">Manage store branch configuration (admin panel)</p>
        </div>
        <StoreFormDialog
          trigger={
            <Button>
              <Plus className="mr-1 h-4 w-4" /> New Store
            </Button>
          }
          mode="create"
          onSaved={refresh}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Stores ({stores?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : isError ? (
            <ErrorState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="pb-3 pr-4">Branch Code</th>
                    <th className="pb-3 pr-4">Branch Name</th>
                    <th className="pb-3 pr-4">Oracle BU</th>
                    <th className="pb-3 pr-4">Currency</th>
                    <th className="pb-3 pr-4">Validation</th>
                    <th className="pb-3 pr-4">Active</th>
                    <th className="pb-3 pr-4">Version</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stores?.map((store) => (
                    <tr key={store.id} className="hover:bg-gray-50">
                      <td className="py-3 pr-4 font-mono font-medium">{store.branchCode}</td>
                      <td className="py-3 pr-4">{store.branchName}</td>
                      <td className="py-3 pr-4 text-gray-500">{store.oracleBusinessUnit}</td>
                      <td className="py-3 pr-4 text-gray-500">{store.invoiceCurrencyCode}</td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(store.validationStatus)}`}>
                          {store.validationStatus}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={store.isActive ? 'text-green-600' : 'text-red-500'}>
                          {store.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-gray-400">v{store.version}</td>
                      <td className="py-3">
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            title="Validate"
                            onClick={() => validateMutation.mutate(store.branchCode)}
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            title="Push store sync"
                            onClick={() => pushStoreMutation.mutate(store.branchCode)}
                          >
                            <Send className="h-3.5 w-3.5" />
                          </Button>
                          <StoreFormDialog
                            trigger={
                              <Button size="sm" variant="outline" title="Edit">
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            }
                            mode="edit"
                            initial={storeToFormDto(store)}
                            onSaved={refresh}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            title="Delete"
                            className="text-red-500 hover:text-red-700"
                            onClick={() => {
                              if (confirm(`Delete store ${store.branchCode}? This cannot be undone.`)) {
                                deleteMutation.mutate(store.branchCode);
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {(!stores || stores.length === 0) && (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-gray-400">
                        No store configurations yet. Click &ldquo;New Store&rdquo; to add one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

