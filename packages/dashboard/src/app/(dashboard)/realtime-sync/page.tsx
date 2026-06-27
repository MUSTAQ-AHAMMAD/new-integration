'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  XCircle,
  RefreshCw,
  Download,
  Search,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';

interface SyncOrder {
  id: string;
  odooOrderId: string;
  odooOrderNumber: string;
  branchCode: string;
  branchName: string;
  region: string;
  orderDate: string;
  customerName: string;
  totalAmount: number;
  currency: string;
  status: string;
  syncAttempts: number;
  lastSyncAt: string | null;
  validationErrors: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface SyncStatistics {
  total: number;
  pending: number;
  processing: number;
  synced: number;
  failed: number;
  skipped: number;
  queuedForRetry: number;
  negativeInventoryHold: number;
}

interface DeadLetterStatistics {
  totalDeadLetters: number;
  byErrorType: Record<string, number>;
  byBranch: Array<{ branchCode: string; count: number }>;
  oldestEntry: string | null;
  newestEntry: string | null;
}

const statusColors = {
  PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  PROCESSING: 'bg-blue-100 text-blue-800 border-blue-300',
  SYNCED: 'bg-green-100 text-green-800 border-green-300',
  FAILED: 'bg-red-100 text-red-800 border-red-300',
  SKIPPED: 'bg-gray-100 text-gray-800 border-gray-300',
  QUEUED_FOR_RETRY: 'bg-orange-100 text-orange-800 border-orange-300',
  NEGATIVE_INVENTORY_HOLD: 'bg-purple-100 text-purple-800 border-purple-300',
};

const statusIcons = {
  PENDING: Clock,
  PROCESSING: Loader2,
  SYNCED: CheckCircle,
  FAILED: XCircle,
  SKIPPED: AlertCircle,
  QUEUED_FOR_RETRY: RefreshCw,
  NEGATIVE_INVENTORY_HOLD: AlertCircle,
};

export default function RealTimeSyncStatusPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [branchFilter, setBranchFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);

  // Fetch sync statistics
  const { data: stats } = useQuery<SyncStatistics>({
    queryKey: ['sync-statistics'],
    queryFn: async () => {
      const response = await fetch('/api/v1/sync/statistics');
      if (!response.ok) throw new Error('Failed to fetch statistics');
      return response.json();
    },
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  // Fetch dead letter statistics
  const { data: deadLetterStats } = useQuery<DeadLetterStatistics>({
    queryKey: ['dead-letter-statistics'],
    queryFn: async () => {
      const response = await fetch('/api/v1/sync/dead-letter/statistics');
      if (!response.ok) throw new Error('Failed to fetch dead letter statistics');
      return response.json();
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // Fetch orders
  const { data: ordersData, isLoading: ordersLoading } = useQuery({
    queryKey: ['sync-orders', statusFilter, branchFilter, searchQuery, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      });
      if (statusFilter && statusFilter !== 'ALL') params.append('status', statusFilter);
      if (branchFilter) params.append('branchCode', branchFilter);
      if (searchQuery) params.append('search', searchQuery);

      const response = await fetch(`/api/v1/sync/orders?${params}`);
      if (!response.ok) throw new Error('Failed to fetch orders');
      return response.json();
    },
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  // Retry single order mutation
  const retryMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const response = await fetch(`/api/v1/sync/orders/${orderId}/retry`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Failed to retry order');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-orders'] });
      queryClient.invalidateQueries({ queryKey: ['sync-statistics'] });
      toast.success('Order queued for retry');
    },
    onError: (error) => {
      toast.error(`Failed to retry order: ${(error as Error).message}`);
    },
  });

  // Bulk retry mutation - keeping for future use
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const bulkRetryMutation = useMutation({
    mutationFn: async (orderIds: string[]) => {
      const response = await fetch('/api/v1/sync/orders/bulk-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds }),
      });
      if (!response.ok) throw new Error('Failed to bulk retry orders');
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sync-orders'] });
      queryClient.invalidateQueries({ queryKey: ['sync-statistics'] });
      toast.success(`${data.queued} orders queued for retry`);
    },
    onError: (error) => {
      toast.error(`Failed to bulk retry: ${(error as Error).message}`);
    },
  });

  // Export to CSV mutation
  const exportMutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'ALL') params.append('status', statusFilter);
      if (branchFilter) params.append('branchCode', branchFilter);
      if (searchQuery) params.append('search', searchQuery);

      const response = await fetch(`/api/v1/sync/orders/export?${params}`);
      if (!response.ok) throw new Error('Failed to export orders');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sync-orders-${new Date().toISOString()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast.success('Orders exported successfully');
    },
    onError: (error) => {
      toast.error(`Export failed: ${(error as Error).message}`);
    },
  });

  const orders = ordersData?.data || [];
  const pagination = ordersData?.pagination || { total: 0, page: 1, totalPages: 1 };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Real-Time Sync Status</h1>
          <p className="text-muted-foreground mt-2">
            Monitor Oracle synchronization in real-time
          </p>
        </div>
        <Button
          onClick={() => exportMutation.mutate()}
          disabled={exportMutation.isPending}
        >
          <Download className="mr-2 h-4 w-4" />
          Export to CSV
        </Button>
      </div>

      {/* Statistics Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.total || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.pending || 0} pending
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Synced</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {stats?.synced || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.total ? Math.round((stats.synced / stats.total) * 100) : 0}% success rate
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed</CardTitle>
            <XCircle className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {stats?.failed || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {deadLetterStats?.totalDeadLetters || 0} in dead-letter queue
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Processing</CardTitle>
            <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {stats?.processing || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.queuedForRetry || 0} queued for retry
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filter Orders</CardTitle>
          <CardDescription>
            Filter and search orders by status, branch, or order number
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Status</label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Statuses</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="PROCESSING">Processing</SelectItem>
                  <SelectItem value="SYNCED">Synced</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                  <SelectItem value="SKIPPED">Skipped</SelectItem>
                  <SelectItem value="QUEUED_FOR_RETRY">Queued for Retry</SelectItem>
                  <SelectItem value="NEGATIVE_INVENTORY_HOLD">
                    Negative Inventory Hold
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Branch Code</label>
              <Input
                placeholder="Filter by branch..."
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Search</label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Order number or customer..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Orders Table */}
      <Card>
        <CardHeader>
          <CardTitle>Sync Orders</CardTitle>
          <CardDescription>
            Showing {orders.length} of {pagination.total} orders
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ordersLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No orders found
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order Number</TableHead>
                      <TableHead>Branch</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Last Sync</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order: SyncOrder) => {
                      const StatusIcon = statusIcons[order.status as keyof typeof statusIcons];
                      return (
                        <TableRow key={order.id}>
                          <TableCell className="font-medium">
                            {order.odooOrderNumber}
                          </TableCell>
                          <TableCell>
                            <div>
                              <div className="font-medium">{order.branchCode}</div>
                              <div className="text-sm text-muted-foreground">
                                {order.region}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>{order.customerName || 'N/A'}</TableCell>
                          <TableCell>
                            {order.totalAmount.toFixed(2)} {order.currency}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={statusColors[order.status as keyof typeof statusColors]}
                            >
                              {StatusIcon && <StatusIcon className="mr-1 h-3 w-3" />}
                              {order.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={order.syncAttempts > 3 ? 'destructive' : 'secondary'}>
                              {order.syncAttempts}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {order.lastSyncAt
                              ? new Date(order.lastSyncAt).toLocaleString()
                              : 'Never'}
                          </TableCell>
                          <TableCell>
                            {order.status === 'FAILED' && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => retryMutation.mutate(order.id)}
                                disabled={retryMutation.isPending}
                              >
                                <RefreshCw className="mr-1 h-3 w-3" />
                                Retry
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-4">
                <div className="text-sm text-muted-foreground">
                  Page {pagination.page} of {pagination.totalPages}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                    disabled={page === pagination.totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
