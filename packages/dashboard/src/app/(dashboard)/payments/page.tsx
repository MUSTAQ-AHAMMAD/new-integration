'use client';

import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';

export default function PaymentMappingsPage() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: mappings, isLoading, isError } = useQuery({
    queryKey: ['payment-mappings'],
    queryFn: () => api.listPaymentMappings(),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.approveMapping(id, 'DASHBOARD_USER'),
    onSuccess: () => {
      toast.success('Mapping approved');
      qc.invalidateQueries({ queryKey: ['payment-mappings'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const pendingCount = mappings?.filter((mapping) => mapping.requiresApproval && !mapping.approvedAt).length ?? 0;

  const handleExportCsv = () => {
    const url = api.exportPaymentMappingsCsvUrl();
    const link = document.createElement('a');
    link.href = url;
    link.download = 'payment-mappings.csv';
    link.click();
  };

  const handleImportCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // Payment mappings share the same generic admin endpoint under 'payment-mappings'
      const result = await api.adminImportCsv('payment-mappings', file);
      toast.success(`Imported ${result.imported} mappings (${result.skipped} skipped)`);
      if (result.errors.length > 0) toast.warning(`${result.errors.length} rows had errors`);
      qc.invalidateQueries({ queryKey: ['payment-mappings'] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-6">
      <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportCsv} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Payment Method Mappings</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={handleExportCsv} disabled={!mappings?.length}>
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-1 h-4 w-4" /> Import CSV
          </Button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-yellow-800">
          ⚠️ {pendingCount} payment method(s) require approval before orders can sync
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>All Mappings ({mappings?.length ?? 0})</CardTitle>
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
                    <th className="pb-3 pr-4">Source System</th>
                    <th className="pb-3 pr-4">Odoo Payment Name</th>
                    <th className="pb-3 pr-4">Oracle Method</th>
                    <th className="pb-3 pr-4">Active</th>
                    <th className="pb-3 pr-4">Approved By</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {mappings?.map((mapping) => (
                    <tr
                      key={mapping.id}
                      className={`hover:bg-gray-50 ${mapping.requiresApproval && !mapping.approvedAt ? 'bg-yellow-50' : ''}`}
                    >
                      <td className="py-3 pr-4">{mapping.sourceSystem}</td>
                      <td className="py-3 pr-4 font-medium">{mapping.sourcePaymentName}</td>
                      <td className="py-3 pr-4 text-gray-500">{mapping.oracleReceiptMethodName}</td>
                      <td className="py-3 pr-4">
                        <span className={mapping.isActive ? 'text-green-600' : 'text-red-500'}>{mapping.isActive ? 'Yes' : 'No'}</span>
                      </td>
                      <td className="py-3 pr-4 text-gray-500">
                        {mapping.approvedBy || (mapping.requiresApproval ? '⏳ Pending' : '—')}
                      </td>
                      <td className="py-3">
                        {mapping.requiresApproval && !mapping.approvedAt && (
                          <Button size="sm" onClick={() => approveMutation.mutate(mapping.id)}>
                            Approve
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
