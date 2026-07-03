'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRegion } from '@/providers/region-provider';
import { api, OrderQueueEntry } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, RefreshCw, Globe } from 'lucide-react';

export default function SkippedOrdersPage() {
  const qc = useQueryClient();
  const { selectedRegion } = useRegion();
  const [searchTerm, setSearchTerm] = useState('');

  const { data: orders, isLoading, isError } = useQuery({
    queryKey: ['order-queue', 'SKIPPED', searchTerm, selectedRegion],
    queryFn: () => api.listOrderQueue({ status: 'SKIPPED', search: searchTerm }),
    refetchInterval: 10000,
  });

  // Filter orders by region on the client side
  const filteredOrders = selectedRegion
    ? orders?.filter(order => order.region === selectedRegion)
    : orders;

  const retrySkippedMutation = useMutation({
    mutationFn: () => api.retrySkippedOrders(),
    onSuccess: (data) => {
      toast.success(`${data.updated || 0} skipped orders re-queued for processing`);
      qc.invalidateQueries({ queryKey: ['order-queue'] });
    },
    onError: (error: Error) => toast.error(`Failed to retry: ${error.message}`),
  });

  const retryOrderMutation = useMutation({
    mutationFn: (orderId: string) => api.retryOrderQueueEntry(orderId),
    onSuccess: () => {
      toast.success('Order re-queued for processing');
      qc.invalidateQueries({ queryKey: ['order-queue'] });
    },
    onError: (error: Error) => toast.error(`Failed to retry order: ${error.message}`),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-8 w-1 shrink-0 rounded-full bg-yellow-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Skipped Orders</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {selectedRegion 
                ? `Orders that were skipped during sync in region: ${selectedRegion}` 
                : 'Orders that were skipped during sync - review and retry'}
            </p>
          </div>
        </div>
        <Button
          onClick={() => retrySkippedMutation.mutate()}
          disabled={retrySkippedMutation.isPending}
          className="flex items-center gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          {retrySkippedMutation.isPending ? 'Retrying...' : 'Retry All Skipped'}
        </Button>
      </div>

      {selectedRegion && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            <span>Filtered to region: <strong>{selectedRegion}</strong></span>
            <span className="text-xs text-indigo-600">
              (Use the region selector in the header to view all regions)
            </span>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Skipped Orders ({filteredOrders?.length || 0})</CardTitle>
            <input
              type="text"
              placeholder="Search by order ID or number..."
              className="rounded border px-3 py-1.5 text-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : isError ? (
            <ErrorState />
          ) : (
            <div className="space-y-4">
              {filteredOrders && filteredOrders.length > 0 ? (
                filteredOrders.map((order: OrderQueueEntry) => (
                  <div 
                    key={order.id}
                    className="rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-3">
                          <h3 className="font-semibold text-gray-900">
                            {order.odooOrderNumber}
                          </h3>
                          <Badge variant="secondary" className="text-xs">
                            Branch: {order.branchCode}
                          </Badge>
                          {order.region && (
                            <Badge variant="outline" className="text-xs">
                              {order.region}
                            </Badge>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-4 text-sm text-gray-600">
                          <span>Amount: {order.currency || 'AED'} {Number(order.totalAmount).toFixed(2)}</span>
                          <span>•</span>
                          <span>Created: {formatDate(order.createdAt)}</span>
                          {order.syncAttempts > 0 && (
                            <>
                              <span>•</span>
                              <span>Attempts: {order.syncAttempts}</span>
                            </>
                          )}
                        </div>

                        {order.validationErrors && (
                          <div className="mt-2 flex items-start gap-2 rounded-md bg-yellow-50 p-3">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
                            <div className="flex-1">
                              <p className="text-sm font-medium text-yellow-900">
                                Why was this order skipped?
                              </p>
                              <div className="mt-1 text-xs text-yellow-800">
                                {typeof order.validationErrors === 'object' && order.validationErrors.reasons ? (
                                  <ul className="list-disc list-inside space-y-0.5">
                                    {order.validationErrors.reasons.map((reason: string, idx: number) => (
                                      <li key={idx}>{reason}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p>{JSON.stringify(order.validationErrors)}</p>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="flex items-center gap-3 text-xs text-gray-500">
                          <span className={order.isPaid ? 'text-green-600' : 'text-red-600'}>
                            {order.isPaid ? '✓ Paid' : '✗ Not Paid'}
                          </span>
                          {order.isCancelled && (
                            <span className="text-red-600">✗ Cancelled</span>
                          )}
                          {order.isRefund && (
                            <span className="text-blue-600">⟲ Refund</span>
                          )}
                          {order.negativeInventoryFlag && (
                            <span className="text-orange-600">⚠ Negative Inventory</span>
                          )}
                        </div>
                      </div>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => retryOrderMutation.mutate(order.id)}
                        disabled={retryOrderMutation.isPending}
                      >
                        Retry
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-12 text-center">
                  <p className="text-gray-400">No skipped orders found</p>
                  <p className="mt-1 text-sm text-gray-500">
                    All orders are being processed successfully!
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="pt-6">
          <h3 className="font-semibold text-blue-900 mb-2">Common Reasons for Skipped Orders</h3>
          <ul className="space-y-1.5 text-sm text-blue-800">
            <li>• <strong>Order is not paid/posted:</strong> Only orders in finalized states are synced. Accepted states include: paid, done, posted, invoiced, sale, confirmed, validated, open, to_invoice, progress, in_payment, processing, complete, closed, finalized</li>
            <li>• <strong>Orders with payments:</strong> Even if the state is unusual, orders with payment data (statement_ids/payment_ids/payments) will now be detected as paid</li>
            <li>• <strong>Order is cancelled:</strong> Cancelled orders are not synced to Oracle</li>
            <li>• <strong>Draft/Quotation orders:</strong> Orders in draft, quotation, or sent_quotation states are not synced</li>
            <li>• <strong>Missing branch code:</strong> Order doesn&apos;t have a valid branch/store identifier</li>
            <li>• <strong>Negative inventory:</strong> Order contains items with negative stock (held until corrected)</li>
            <li>• <strong>Missing configuration:</strong> Store configuration is incomplete or missing required fields</li>
          </ul>
          <div className="mt-3 text-xs text-blue-700">
            💡 Tip: After fixing the underlying issues (e.g., updating order states in Odoo/IBQ), use the &quot;Retry All Skipped&quot; button to re-process these orders.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
