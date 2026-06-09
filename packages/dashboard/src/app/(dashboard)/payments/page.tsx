'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';

export default function PaymentMappingsPage() {
  const qc = useQueryClient();
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Payment Method Mappings</h1>
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
