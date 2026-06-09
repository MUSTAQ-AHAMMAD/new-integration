'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';

export default function InventoryPage() {
  const { data: items, isLoading, isError } = useQuery({
    queryKey: ['negative-inventory'],
    queryFn: api.getNegativeInventory,
    refetchInterval: 30000,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Inventory Alerts</h1>
      {(items?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-orange-800">
          ⚠️ {items?.length} product(s) with negative inventory detected. Orders are syncing but inventory team should review.
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Negative Inventory Items ({items?.length ?? 0})</CardTitle>
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
                    <th className="pb-3 pr-4">SKU</th>
                    <th className="pb-3 pr-4">Product</th>
                    <th className="pb-3 pr-4">Branch</th>
                    <th className="pb-3 pr-4">Current Qty</th>
                    <th className="pb-3 pr-4">Change</th>
                    <th className="pb-3">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items?.map((item) => (
                    <tr key={item.id} className="hover:bg-red-50">
                      <td className="py-3 pr-4 font-mono">{item.productSku}</td>
                      <td className="py-3 pr-4">{item.productName || '—'}</td>
                      <td className="py-3 pr-4 font-mono">{item.branchCode}</td>
                      <td className="py-3 pr-4 font-medium text-red-600">{formatNumber(Number(item.newQuantity))}</td>
                      <td className="py-3 pr-4 text-red-500">{formatNumber(Number(item.quantityChange))}</td>
                      <td className="py-3 text-gray-400">{formatDate(item.transactionDate)}</td>
                    </tr>
                  ))}
                  {(!items || items.length === 0) && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-green-500">
                        ✓ No negative inventory detected
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
