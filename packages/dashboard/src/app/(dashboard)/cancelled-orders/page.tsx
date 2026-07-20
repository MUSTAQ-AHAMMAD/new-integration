'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRegion } from '@/providers/region-provider';
import { api, OrderQueueEntry } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { Badge } from '@/components/ui/badge';
import { Ban, Globe } from 'lucide-react';

/**
 * Cancelled Orders — cancelled orders are never synced to Oracle as invoices;
 * they are skipped by the sync pipeline. This page lists them (isCancelled=true)
 * for audit and review. Refunds live on the sibling "Refunds & Credit Memos"
 * page, where they are pushed to Oracle as credit memos.
 */
export default function CancelledOrdersPage() {
  const { selectedRegion } = useRegion();
  const [searchTerm, setSearchTerm] = useState('');

  const { data: orders, isLoading, isError } = useQuery({
    queryKey: ['order-queue', 'cancelled', searchTerm, selectedRegion],
    queryFn: () => api.listOrderQueue({ isCancelled: true, search: searchTerm, limit: 500 }),
    refetchInterval: 15000,
  });

  const filteredOrders = selectedRegion
    ? orders?.filter((order) => order.region === selectedRegion)
    : orders;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-8 w-1 shrink-0 rounded-full bg-red-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Cancelled Orders</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {selectedRegion
                ? `Cancelled orders in region: ${selectedRegion} — never posted to Oracle as invoices.`
                : 'Cancelled orders are excluded from Oracle invoicing. Listed here for audit and review.'}
            </p>
          </div>
        </div>
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
            <CardTitle>Cancelled Orders ({filteredOrders?.length || 0})</CardTitle>
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
          ) : filteredOrders && filteredOrders.length > 0 ? (
            <div className="space-y-4">
              {filteredOrders.map((order: OrderQueueEntry) => (
                <div
                  key={order.id}
                  className="rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-3">
                        <h3 className="font-semibold text-gray-900">{order.odooOrderNumber}</h3>
                        <Badge variant="secondary" className="text-xs">Branch: {order.branchCode}</Badge>
                        {order.region && <Badge variant="outline" className="text-xs">{order.region}</Badge>}
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                          <Ban className="h-3 w-3" /> Cancelled
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-gray-600">
                        <span>Amount: {order.currency || 'AED'} {Number(order.totalAmount).toFixed(2)}</span>
                        <span>•</span>
                        <span>Order date: {formatDate(order.orderDate ?? order.createdAt)}</span>
                        {order.customerName && (
                          <>
                            <span>•</span>
                            <span>{order.customerName}</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-500">
                        <span className={order.isPaid ? 'text-green-600' : 'text-red-600'}>
                          {order.isPaid ? '✓ Paid' : '✗ Not Paid'}
                        </span>
                        <span>Status: {order.status}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center">
              <p className="text-gray-400">No cancelled orders found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
