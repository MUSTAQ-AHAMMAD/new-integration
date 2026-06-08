'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getStatusColor } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function StoresPage() {
  const qc = useQueryClient();
  const { data: stores, isLoading } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api.listStores(),
  });

  const validateMutation = useMutation({
    mutationFn: (code: string) => api.validateStore(code),
    onSuccess: (result, code) => {
      const message = result.isValid ? `Store ${code} is valid` : `Store ${code} has errors: ${result.errors.join(', ')}`;
      if (result.isValid) {
        toast.success(message);
      } else {
        toast.error(message);
      }
      qc.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Store Configurations</h1>
      <Card>
        <CardHeader>
          <CardTitle>All Stores ({stores?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="pb-3 pr-4">Branch Code</th>
                    <th className="pb-3 pr-4">Branch Name</th>
                    <th className="pb-3 pr-4">Oracle BU</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3 pr-4">Active</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stores?.map((store) => (
                    <tr key={store.id} className="hover:bg-gray-50">
                      <td className="py-3 pr-4 font-mono font-medium">{store.branchCode}</td>
                      <td className="py-3 pr-4">{store.branchName}</td>
                      <td className="py-3 pr-4 text-gray-500">{store.oracleBusinessUnit}</td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${getStatusColor(store.validationStatus)}`}>
                          {store.validationStatus}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={store.isActive ? 'text-green-600' : 'text-red-500'}>{store.isActive ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td className="py-3">
                        <Button size="sm" variant="outline" onClick={() => validateMutation.mutate(store.branchCode)}>
                          Validate
                        </Button>
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
