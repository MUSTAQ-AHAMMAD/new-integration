'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';

export default function FailedTransactionsPage() {
  const qc = useQueryClient();
  const { data: transactions, isLoading, isError } = useQuery({
    queryKey: ['failed-transactions'],
    queryFn: () => api.listFailedTransactions(100),
    refetchInterval: 15000,
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) =>
      api.resolveFailedTransaction(id, 'DASHBOARD_USER', 'Manually resolved via dashboard'),
    onSuccess: () => {
      toast.success('Transaction resolved');
      void qc.invalidateQueries({ queryKey: ['failed-transactions'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-overview'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="h-8 w-1 shrink-0 rounded-full bg-indigo-500" />
        <h1 className="text-xl font-bold text-slate-900">Failed Transactions</h1>
      </div>
      {(transactions?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          ⚠️ {transactions?.length} unresolved failed transaction(s) require attention.
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Unresolved Failures ({transactions?.length ?? 0})</CardTitle>
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
                    <th className="pb-3 pr-4">Order</th>
                    <th className="pb-3 pr-4">Branch</th>
                    <th className="pb-3 pr-4">Error Type</th>
                    <th className="pb-3 pr-4">Error Message</th>
                    <th className="pb-3 pr-4">Retries</th>
                    <th className="pb-3 pr-4">Date</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {transactions?.map((tx) => (
                    <tr key={tx.id} className="hover:bg-red-50">
                      <td className="py-3 pr-4 font-mono text-xs">
                        {tx.orderSyncQueue?.odooOrderNumber ?? '—'}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs">
                        {tx.orderSyncQueue?.branchCode ?? '—'}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                          {tx.errorType}
                        </span>
                      </td>
                      <td className="max-w-xs truncate py-3 pr-4 text-gray-600" title={tx.errorMessage}>
                        {tx.errorMessage}
                      </td>
                      <td className="py-3 pr-4 text-center text-gray-500">
                        {tx.retryCount}/{tx.maxRetries}
                      </td>
                      <td className="whitespace-nowrap py-3 pr-4 text-gray-400">{formatDate(tx.createdAt)}</td>
                      <td className="py-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resolveMutation.isPending}
                          onClick={() => resolveMutation.mutate(tx.id)}
                        >
                          Resolve
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(!transactions || transactions.length === 0) && (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-green-500">
                        ✓ No unresolved failed transactions
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
