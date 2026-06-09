const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `API error: ${res.status}`);
  }

  return res.json();
}

export const api = {
  getOverview: () => apiRequest<DashboardOverview>('/dashboard/overview'),
  getSyncTrend: (days = 7) => apiRequest<SyncTrendItem[]>(`/dashboard/sync-trend?days=${days}`),
  getFailedTransactions: (limit = 20) => apiRequest<FailedTransaction[]>(`/dashboard/failed-transactions?limit=${limit}`),
  getOrdersByBranch: () => apiRequest<BranchOrderStats[]>('/dashboard/orders-by-branch'),
  getRecentActivity: (limit = 50) => apiRequest<AuditLogItem[]>(`/dashboard/recent-activity?limit=${limit}`),
  getHealthStatus: () => apiRequest<HealthCheck[]>('/dashboard/health'),
  getNegativeInventory: () => apiRequest<InventoryItem[]>('/dashboard/negative-inventory'),
  createSyncJob: (data: CreateSyncJobDto) => apiRequest<SyncJob>('/sync/jobs', { method: 'POST', body: JSON.stringify(data) }),
  listSyncJobs: (status?: string) => apiRequest<SyncJob[]>(`/sync/jobs${status ? `?status=${status}` : ''}`),
  getSyncJob: (id: string) => apiRequest<SyncJob>(`/sync/jobs/${id}`),
  cancelSyncJob: (id: string) => apiRequest<SyncJob>(`/sync/jobs/${id}/cancel`, { method: 'POST' }),
  retrySyncJob: (id: string) => apiRequest<SyncJob>(`/sync/jobs/${id}/retry`, { method: 'POST' }),
  getQueueStats: () => apiRequest<QueueStats>('/sync/queue/stats'),
  listAlerts: (params?: { severity?: string; resolved?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.severity) qs.set('severity', params.severity);
    if (params?.resolved !== undefined) qs.set('resolved', String(params.resolved));
    const query = qs.toString();
    return apiRequest<Alert[]>(`/alerts${query ? `?${query}` : ''}`);
  },
  resolveAlert: (id: string, resolvedBy: string) =>
    apiRequest<Alert>(`/alerts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolvedBy }) }),
  listStores: (activeOnly = false) => apiRequest<StoreConfig[]>(`/store-config?activeOnly=${activeOnly}`),
  getStore: (branchCode: string) => apiRequest<StoreConfig>(`/store-config/${branchCode}`),
  validateStore: (branchCode: string) =>
    apiRequest<{ isValid: boolean; errors: string[] }>(`/store-config/${branchCode}/validate`, { method: 'POST' }),
  upsertStore: (data: UpsertStoreConfigDto) =>
    apiRequest<StoreConfig>('/store-config', { method: 'POST', body: JSON.stringify(data) }),
  updateStore: (branchCode: string, data: Partial<UpsertStoreConfigDto>) =>
    apiRequest<StoreConfig>(`/store-config/${branchCode}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteStore: (branchCode: string) =>
    apiRequest<void>(`/store-config/${branchCode}`, { method: 'DELETE' }),
  pushOrder: (orderId: string, createdBy = 'DASHBOARD_USER') =>
    apiRequest<SyncJob>('/sync/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobType: 'ORDER_SYNC', scopeType: 'SINGLE_ORDER', orderIds: [orderId], createdBy }),
    }),
  pushStore: (branchCode: string, createdBy = 'DASHBOARD_USER') =>
    apiRequest<SyncJob>('/sync/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobType: 'ORDER_SYNC', scopeType: 'BRANCH', branchCode, createdBy }),
    }),
  listPaymentMappings: () => apiRequest<PaymentMapping[]>('/payment-mappings'),
  approveMapping: (id: string, approvedBy: string) =>
    apiRequest<PaymentMapping>(`/payment-mappings/${id}/approve`, { method: 'PUT', body: JSON.stringify({ approvedBy }) }),
  listFailedTransactions: (limit = 50) => apiRequest<FailedTransaction[]>(`/sync/failed-transactions?limit=${limit}`),
  resolveFailedTransaction: (id: string, resolvedBy: string, resolutionNote?: string) =>
    apiRequest<FailedTransaction>(`/sync/failed-transactions/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolvedBy, resolutionNote }),
    }),
  listNotificationRecipients: (activeOnly = false) =>
    apiRequest<NotificationRecipient[]>(`/notifications/recipients?activeOnly=${activeOnly}`),
  createNotificationRecipient: (data: CreateNotificationRecipientDto) =>
    apiRequest<NotificationRecipient>('/notifications/recipients', { method: 'POST', body: JSON.stringify(data) }),
  updateNotificationRecipient: (id: string, data: Partial<CreateNotificationRecipientDto>) =>
    apiRequest<NotificationRecipient>(`/notifications/recipients/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNotificationRecipient: (id: string) =>
    apiRequest<void>(`/notifications/recipients/${id}`, { method: 'DELETE' }),
};

export interface DashboardOverview {
  totalOrders: number;
  syncedOrders: number;
  failedOrders: number;
  pendingOrders: number;
  processingOrders: number;
  syncRate: number;
  unresolvedAlerts: number;
  activeJobs: number;
  storeCount: number;
}

export interface SyncTrendItem {
  status: string;
  _count: { id: number };
}

export interface FailedTransaction {
  id: string;
  errorType: string;
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  isResolved: boolean;
  createdAt: string;
  orderSyncQueue?: { odooOrderNumber: string; branchCode: string } | null;
}

export interface BranchOrderStats {
  branchCode: string;
  status: string;
  _count: { id: number };
}

export interface AuditLogItem {
  id: string;
  externalId: string;
  operation: string;
  status: string;
  externalSystem: string;
  processingDurationMs: number;
  createdAt: string;
}

export interface HealthCheck {
  id: string;
  serviceName: string;
  status: string;
  responseTimeMs: number;
  lastSuccessAt: string;
  lastFailureAt: string | null;
  consecutiveFailures: number;
}

export interface InventoryItem {
  id: string;
  productSku: string;
  productName: string | null;
  branchCode: string;
  quantityChange: number;
  newQuantity: number;
  transactionDate: string;
}

export interface SyncJob {
  id: string;
  jobType: string;
  scopeType: string;
  scopeValue: object;
  status: string;
  totalRecords: number;
  processedRecords: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
  createdBy: string;
  errorMessage: string | null;
}

export interface QueueStats {
  orderSync: { waiting: number; active: number; failed: number; completed: number };
}

export interface Alert {
  id: string;
  alertType: string;
  severity: string;
  title: string;
  message: string;
  isResolved: boolean;
  createdAt: string;
  relatedEntityId: string | null;
}

export interface StoreConfig {
  id: string;
  branchCode: string;
  branchName: string;
  odooBranchId: number;
  oracleOperatingUnitId: number;
  oracleBusinessUnit: string;
  billToSiteName: string;
  billToLocation: string | null;
  bankAccountName: string;
  cashAccountName: string;
  paymentTermsName: string;
  taxClassificationCode: string | null;
  transactionSource: string;
  transactionType: string;
  invoiceCurrencyCode: string;
  isActive: boolean;
  validationStatus: string;
  validationErrors: string[] | null;
  lastValidatedAt: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertStoreConfigDto {
  branchCode: string;
  branchName: string;
  odooBranchId: number;
  oracleOperatingUnitId: number;
  oracleBusinessUnit: string;
  billToSiteName: string;
  billToLocation?: string;
  bankAccountName: string;
  cashAccountName: string;
  paymentTermsName: string;
  taxClassificationCode?: string;
  transactionSource?: string;
  transactionType?: string;
  invoiceCurrencyCode?: string;
  isActive?: boolean;
  createdBy: string;
}

export interface PaymentMapping {
  id: string;
  sourceSystem: string;
  sourcePaymentName: string;
  oracleReceiptMethodName: string;
  isActive: boolean;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface CreateSyncJobDto {
  jobType: string;
  scopeType: string;
  orderIds?: string[];
  branchCode?: string;
  startDate?: string;
  endDate?: string;
  createdBy?: string;
}

export interface NotificationRecipient {
  id: string;
  email: string;
  name: string;
  role: string;
  receiveErrorAlerts: boolean;
  receiveDailyReports: boolean;
  receiveInventoryAlerts: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface CreateNotificationRecipientDto {
  email: string;
  name: string;
  role: string;
  receiveErrorAlerts?: boolean;
  receiveDailyReports?: boolean;
  receiveInventoryAlerts?: boolean;
}
