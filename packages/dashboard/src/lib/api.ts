const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

// ── Auth token storage ────────────────────────────────────────────
const TOKEN_KEY = 'integration_hub_token';

export const authStorage = {
  getToken: (): string | null =>
    typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null,
  setToken: (token: string) =>
    typeof window !== 'undefined' && localStorage.setItem(TOKEN_KEY, token),
  clearToken: () =>
    typeof window !== 'undefined' && localStorage.removeItem(TOKEN_KEY),
};

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const token = authStorage.getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
    ...options,
  });

  if (res.status === 401) {
    // Only treat a 401 as an expired session when we actually sent a token.
    // A 401 with no token is a failed login (bad credentials) — surface the
    // server's real message instead of a misleading "Session expired" that
    // bounces the user straight back to the login page.
    if (token) {
      authStorage.clearToken();
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
      throw new Error('Session expired. Please log in again.');
    }
    const error = await res
      .json()
      .catch(() => ({ message: 'Invalid email or password' }));
    throw new Error(error.message || 'Invalid email or password');
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `API error: ${res.status}`);
  }

  return res.json();
}

// ── Register-account refresh utility types ─────────────────────────
export interface AccountOption {
  bankAccountId: number;
  name: string;
  currency?: string;
  isCash: boolean;
}
export interface RegisterProposal {
  registerId: string;
  registerName: string;
  region: string;
  currentBankAccountId: number | null;
  currentCashAccountId: number | null;
  proposedBankAccountId: number | null;
  proposedBankName: string | null;
  proposedCashAccountId: number | null;
  proposedCashName: string | null;
  score: number;
}
export interface RegisterAccountsPreview {
  accounts: AccountOption[];
  proposals: RegisterProposal[];
  summary: {
    registers: number;
    oracleAccounts: number;
    autoMatched: number;
    unmatched: number;
  };
}
export interface RegisterAccountAssignment {
  registerId: string;
  bankAccountId?: number | null;
  cashAccountId?: number | null;
}

export interface SyncControlRow {
  id: string;
  serviceName: string;
  displayName: string;
  description: string | null;
  region: string | null;
  enabled: boolean;
  isRunning: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  runCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  // ── Auth ───────────────────────────────────────────────────────
  login: (email: string, password: string) =>
    apiRequest<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  // ── Region Integration ────────────────────────────────────────
  listVendHqRegions: () => apiRequest<VendHqRegionCredential[]>('/vendhq-backup/regions'),
  triggerVendHqBackupAll: () =>
    apiRequest<{ ok: boolean; message: string }>('/vendhq-backup/trigger', { method: 'POST' }),
  triggerVendHqBackupByRegion: (region: string) =>
    apiRequest<{ ok: boolean; region: string; triggered: number }>(`/vendhq-backup/trigger-region/${encodeURIComponent(region)}`, { method: 'POST' }),
  triggerVendHqToOracleSyncAll: () =>
    apiRequest<{ ok: boolean; processed: number; succeeded: number; failed: number }>('/vendhq-backup/sync-to-oracle', { method: 'POST' }),
  triggerVendHqToOracleSyncByRegion: (region: string) =>
    apiRequest<{ ok: boolean; region: string; processed: number; succeeded: number; failed: number }>(`/vendhq-backup/sync-to-oracle/${encodeURIComponent(region)}`, { method: 'POST' }),
  triggerItemSyncAll: () =>
    apiRequest<{ ok: boolean; message: string }>('/item-sync/trigger', { method: 'POST' }),
  triggerItemSyncByRegion: (region: string) =>
    apiRequest<{ ok: boolean }>(`/item-sync/trigger/${encodeURIComponent(region)}`, { method: 'POST' }),
  getItemSyncStatus: (region?: string) => {
    const qs = region ? `?region=${encodeURIComponent(region)}` : '';
    return apiRequest<unknown[]>(`/item-sync/status${qs}`);
  },

  getOverview: (region?: string) => {
    const qs = region ? `?region=${encodeURIComponent(region)}` : '';
    return apiRequest<DashboardOverview>(`/dashboard/overview${qs}`);
  },
  getSyncTrend: (days = 7) => apiRequest<SyncTrendItem[]>(`/dashboard/sync-trend?days=${days}`),
  getFailedTransactions: (limit = 20) => apiRequest<FailedTransaction[]>(`/dashboard/failed-transactions?limit=${limit}`),
  getOrdersByBranch: () => apiRequest<BranchOrderStats[]>('/dashboard/orders-by-branch'),
  getRecentActivity: (limit = 50) => apiRequest<AuditLogItem[]>(`/dashboard/recent-activity?limit=${limit}`),
  getHealthStatus: () => apiRequest<HealthCheck[]>('/dashboard/health'),
  getNegativeInventory: () => apiRequest<InventoryItem[]>('/dashboard/negative-inventory'),
  getWebhookEvents: (limit = 100) => apiRequest<WebhookEvent[]>(`/dashboard/webhook-events?limit=${limit}`),
  // ── Integration run: pull Odoo → one invoice/store/day → full Oracle cycle ──
  startIntegrationRun: (data: { region: string; startDate: string; endDate: string }) =>
    apiRequest<IntegrationRunJob>('/sync/integration-run', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  listIntegrationRuns: (limit?: number) =>
    apiRequest<IntegrationRunJob[]>(`/sync/integration-run${limit ? `?limit=${limit}` : ''}`),
  getIntegrationRun: (id: string) =>
    apiRequest<IntegrationRunJob>(`/sync/integration-run/${id}`),

  createSyncJob: (data: CreateSyncJobDto) => apiRequest<SyncJob>('/sync/jobs', { method: 'POST', body: JSON.stringify(data) }),
  listSyncJobs: (status?: string) => apiRequest<SyncJob[]>(`/sync/jobs${status ? `?status=${status}` : ''}`),
  getSyncJob: (id: string) => apiRequest<SyncJob>(`/sync/jobs/${id}`),
  cancelSyncJob: (id: string) => apiRequest<SyncJob>(`/sync/jobs/${id}/cancel`, { method: 'POST' }),
  retrySyncJob: (id: string) => apiRequest<SyncJob>(`/sync/jobs/${id}/retry`, { method: 'POST' }),
  getQueueStats: () => apiRequest<QueueStats>('/sync/queue/stats'),
  listOrderQueue: (params?: { status?: string; branchCode?: string; search?: string; limit?: number; isCancelled?: boolean; isRefund?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.status && params.status !== 'ALL') qs.set('status', params.status);
    if (params?.branchCode && params.branchCode !== 'ALL') qs.set('branchCode', params.branchCode);
    if (params?.search) qs.set('search', params.search);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (typeof params?.isCancelled === 'boolean') qs.set('isCancelled', String(params.isCancelled));
    if (typeof params?.isRefund === 'boolean') qs.set('isRefund', String(params.isRefund));
    const q = qs.toString();
    return apiRequest<OrderQueueEntry[]>(`/sync/order-queue${q ? `?${q}` : ''}`);
  },
  retryOrderQueueEntry: (id: string) =>
    apiRequest<{ ok: boolean; id: string }>(`/sync/order-queue/${id}/retry`, { method: 'POST' }),
  retrySkippedOrders: (branchCode?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (branchCode) params.set('branchCode', branchCode);
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return apiRequest<{ updated: number; enqueued: number }>(`/sync/orders/retry-skipped${query ? `?${query}` : ''}`, { method: 'POST' });
  },
  retryNegativeInventoryOrders: (branchCode?: string) => {
    const query = branchCode ? `?branchCode=${branchCode}` : '';
    return apiRequest<{ enqueued: number }>(`/sync/orders/retry-negative-inventory${query}`, { method: 'POST' });
  },
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

  // ── Generic Admin CRUD ──────────────────────────────────────────
  adminListTables: () => apiRequest<AdminTableMeta[]>('/admin/tables'),
  adminList: <T = Record<string, unknown>>(table: string, opts?: { skip?: number; take?: number; region?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.skip !== undefined) qs.set('skip', String(opts.skip));
    if (opts?.take !== undefined) qs.set('take', String(opts.take));
    if (opts?.region) qs.set('region', opts.region);
    const q = qs.toString();
    return apiRequest<AdminListResult<T>>(`/admin/${table}${q ? `?${q}` : ''}`);
  },
  adminGetOne: <T = Record<string, unknown>>(table: string, id: string) =>
    apiRequest<T>(`/admin/${table}/${id}`),
  adminCreate: <T = Record<string, unknown>>(table: string, body: Record<string, unknown>) =>
    apiRequest<T>(`/admin/${table}`, { method: 'POST', body: JSON.stringify(body) }),
  adminUpdate: <T = Record<string, unknown>>(table: string, id: string, body: Record<string, unknown>) =>
    apiRequest<T>(`/admin/${table}/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  adminDelete: (table: string, id: string) =>
    apiRequest<void>(`/admin/${table}/${id}`, { method: 'DELETE' }),

  /** Download all records for an admin table as a CSV blob URL */
  adminExportCsvUrl: (table: string, region?: string) => {
    const qs = region ? `?region=${encodeURIComponent(region)}` : '';
    return `${API_BASE}/admin/${table}/export${qs}`;
  },

  /** Upload a CSV file to bulk-import records into an admin table */
  adminImportCsv: (table: string, file: File): Promise<{ imported: number; skipped: number; errors: string[] }> => {
    const form = new FormData();
    form.append('file', file);
    const token = authStorage.getToken();
    return fetch(`${API_BASE}/admin/${table}/import`, {
      method: 'POST',
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (res) => {
      if (res.status === 401) {
        authStorage.clearToken();
        if (typeof window !== 'undefined') window.location.href = '/login';
        throw new Error('Session expired. Please log in again.');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error((err as { message?: string }).message || `API error: ${res.status}`);
      }
      return res.json() as Promise<{ imported: number; skipped: number; errors: string[] }>;
    });
  },

  /** Trigger Oracle ODOO_INTEGRATION schema import */
  oracleImport: (tables?: string[]) =>
    apiRequest<OracleImportSummary>('/admin/oracle-import', {
      method: 'POST',
      body: JSON.stringify({ tables }),
    }),

  /** Preview proposed VendHqRegister → Oracle bank/cash account matches */
  registerAccountsPreview: (region?: string) =>
    apiRequest<RegisterAccountsPreview>('/admin/register-accounts/preview', {
      method: 'POST',
      body: JSON.stringify({ region }),
    }),

  /** Write confirmed bank/cash account IDs onto VendHqRegister rows */
  registerAccountsApply: (assignments: RegisterAccountAssignment[]) =>
    apiRequest<{ updated: number; skipped: number }>(
      '/admin/register-accounts/apply',
      { method: 'POST', body: JSON.stringify({ assignments }) },
    ),

  /** List sync-control services (optionally per region) */
  syncControlList: (region?: string | null) =>
    apiRequest<SyncControlRow[]>(
      `/admin/sync-control${region ? `?region=${encodeURIComponent(region)}` : ''}`,
    ),

  /** Toggle a sync-control service on/off */
  syncControlToggle: (serviceName: string, region?: string | null) =>
    apiRequest<{ serviceName: string; enabled: boolean }>(
      `/admin/sync-control/${encodeURIComponent(serviceName)}/toggle${region ? `?region=${encodeURIComponent(region)}` : ''}`,
      { method: 'POST' },
    ),

  /** Manually pull orders from Odoo and ingest them into the sync queue */
  fetchOdooOrders: (params?: { credentialId?: string; branchId?: number; startDate?: string; endDate?: string; limit?: number }) =>
    apiRequest<{ ok: boolean; fetched: number; backedUp: number; backupSkipped: number; ingested: number; skipped: number; errors: string[] }>('/sync/fetch-odoo', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    }),

  /** List all per-region Odoo credentials (API keys are masked) */
  listOdooCredentials: () =>
    apiRequest<OdooCredential[]>('/odoo-backup/credentials'),

  /** Probe an Odoo credential (limit=1 test request) — returns diagnostic info */
  probeOdooCredential: (id: string) =>
    apiRequest<{ ok: boolean; url: string; status: number | null; parsedCount: number; bodySnippet: string; error: string | null }>(
      `/odoo-backup/credentials/${id}/probe`,
      { method: 'POST' },
    ),

  /** List all IBQ credentials (API keys are masked) */
  listIbqCredentials: () =>
    apiRequest<IbqCredential[]>('/ibq-backup/credentials'),

  /** Manually pull orders from IBQ, persist backup, and ingest them into the sync queue */
  fetchIbqOrders: (params: { credentialId: string; startDate?: string; endDate?: string; branchId?: number; companyId?: number; limit?: number }) =>
    apiRequest<{ ok: boolean; fetched: number; backedUp: number; backupSkipped: number; ingested: number; skipped: number; errors: string[] }>('/sync/fetch-ibq', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  /** Export payment mappings as CSV */
  exportPaymentMappingsCsvUrl: () => `${API_BASE}/payment-mappings/export`,

  /** Export store configs as CSV */
  exportStoresCsvUrl: () => `${API_BASE}/store-config/export`,

  // ─── AI Monitor ───────────────────────────────────────────────────
  /** Run the AI-powered diagnostic analysis of the whole integration */
  aiMonitorAnalyze: () => apiRequest<AiAnalysisResult>('/ai-monitor/analyze'),

  // ─── Reports & Analytics ──────────────────────────────────────────
  /** List reportable datasets + their fields for the report builder */
  reportDatasets: () => apiRequest<ReportDataset[]>('/reports/datasets'),
  /** Run a flexible report query (aggregate or records mode) */
  runReport: (dto: ReportQueryDto) =>
    apiRequest<ReportResult>('/reports/query', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  /** POST the query to the export endpoint and trigger a CSV file download */
  exportReport: async (dto: ReportQueryDto): Promise<void> => {
    const token = authStorage.getToken();
    const res = await fetch(`${API_BASE}/reports/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(dto),
    });
    if (res.status === 401) {
      authStorage.clearToken();
      if (typeof window !== 'undefined') window.location.href = '/login';
      throw new Error('Session expired. Please log in again.');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(
        (err as { message?: string }).message || `Export failed: ${res.status}`,
      );
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `report-${dto.dataset}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  },
};

// ─── Reports & Analytics types ─────────────────────────────────────
export type ReportFieldRole = 'dimension' | 'measure' | 'date' | 'boolean';

export interface ReportFieldMeta {
  name: string;
  label: string;
  role: ReportFieldRole;
  type: string;
  enumValues?: string[];
}

export interface ReportDataset {
  slug: string;
  label: string;
  description: string;
  defaultDateField?: string;
  fields: ReportFieldMeta[];
}

export type ReportFilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'in'
  | 'between'
  | 'isNull';

export interface ReportFilter {
  field: string;
  op: ReportFilterOp;
  value?: unknown;
  value2?: unknown;
}

export type ReportMeasureFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface ReportMeasure {
  fn: ReportMeasureFn;
  field?: string;
}

export interface ReportQueryDto {
  dataset: string;
  filters?: ReportFilter[];
  dateField?: string;
  dateFrom?: string;
  dateTo?: string;
  groupBy?: string[];
  measures?: ReportMeasure[];
  sort?: { field: string; dir?: 'asc' | 'desc' };
  page?: number;
  pageSize?: number;
}

export interface ReportResult {
  mode: 'aggregate' | 'records';
  dataset: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  summary?: Record<string, number>;
  measures?: ReportMeasure[];
  groupBy?: string[];
}

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
  /** Set when region filter is active — indicates the data source used */
  dataSource?: string;
  /** Echo of the region filter applied, if any */
  region?: string;
}

export interface SyncTrendItem {
  status: string;
  count: number;
}

export interface FailedTransaction {
  id: string;
  errorType: string;
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  isResolved: boolean;
  createdAt: string;
  originalPayload: unknown;
  errorStack: string | null;
  errorCode: string | null;
  nextRetryAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  orderSyncQueue?: { odooOrderNumber: string; branchCode: string } | null;
}

export interface BranchOrderStats {
  branchCode: string;
  status: string;
  count: number;
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

export interface WebhookEvent {
  id: string;
  eventType: string;
  sourceSystem: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  processedAt: string | null;
  processingStatus: string;
  processingError: string | null;
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
  skippedCount: number;
  createdAt: string;
  createdBy: string;
  errorMessage: string | null;
  errorDetails: unknown;
}

export interface IntegrationRunOutcome {
  branchCode: string;
  businessDay: string;
  groupKey: string;
  customerType: string;
  status: 'CREATED' | 'SKIPPED' | 'FAILED';
  transactionNumber?: string;
  sourceOrderCount: number;
  invoiceLineCount: number;
  standardReceipts: number;
  miscReceipts: number;
  journals: number;
  inventoryTransactions?: number;
  excludedOrders?: Array<{ orderNumber: string; reason: string }>;
  error?: string;
}

export interface IntegrationRunScope {
  kind: 'INTEGRATION_RUN';
  region: string;
  startDate: string;
  endDate: string;
  phase: 'PENDING' | 'PULL' | 'POST' | 'DONE';
  pull: {
    credentials: number;
    saved: number;
    skipped: number;
    ingested: number;
    ingestSkipped: number;
  };
  post: {
    daysPlanned: number;
    daysDone: number;
    invoicesCreated: number;
    invoicesFailed: number;
    invoicesSkipped: number;
    standardReceipts: number;
    miscReceipts: number;
    journals: number;
    inventoryTransactions: number;
  };
  results: IntegrationRunOutcome[];
  events: Array<{ at: string; phase: string; message: string }>;
}

export interface IntegrationRunJob extends Omit<SyncJob, 'scopeValue'> {
  scopeValue: IntegrationRunScope;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface OrderQueueEntry {
  id: string;
  odooOrderId: string;
  odooOrderNumber: string;
  branchCode: string;
  branchName: string | null;
  region: string | null;
  orderDate: string;
  orderDateUtc: string;
  customerName: string | null;
  customerEmail: string | null;
  totalAmount: string;
  currency: string;
  status: string;
  isPaid: boolean;
  isCancelled: boolean;
  isRefund: boolean;
  negativeInventoryFlag: boolean;
  syncAttempts: number;
  validationErrors?: {
    reasons?: string[];
    errors?: string[];
    warnings?: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
  failedTransactions: Array<{
    id: string;
    errorType: string;
    errorMessage: string;
    retryCount: number;
    createdAt: string;
  }>;
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
  timezone?: string;
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

// ─── Generic Admin interfaces ──────────────────────────────────────
export interface AdminTableMeta {
  slug: string;
  model: string;
}

export interface AdminListResult<T = Record<string, unknown>> {
  data: T[];
  total: number;
  skip: number;
  take: number;
}

// ─── Oracle Integration Table types ────────────────────────────────
export interface FusionCredential {
  id: string;
  hostName: string;
  server: string;
  username: string;
  password: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendHqCredential {
  id: string;
  domainName: string;
  personalToken: string;
  active: boolean;
  region: string;
  fusionOrgCode: string | null;
  timezoneOffset: number;
  fusionTaxCode: string | null;
  businessStartDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OdooCredential {
  id: string;
  baseUrl: string;
  apiKey: string;
  region: string;
  active: boolean;
  apiPath: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IbqCredential {
  id: string;
  baseUrl: string;
  apiKey: string;
  companyId: number | null;
  region: string;
  active: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutletIntegrationConfig {
  id: string;
  outletName: string;
  integMode: string;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface FusionBusinessUnitMap {
  id: string;
  businessUnitId: number;
  businessUnitName: string;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface FusionReceiptMethod {
  id: string;
  receiptMethodId: number;
  receiptMethodName: string;
  receiptIsCash: boolean;
  receiptBankCharge: number;
  receiptMethodTax: number;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface FusionSalesMetadata {
  id: string;
  billToName: string;
  billToAccount: number;
  siteNumber: string | null;
  businessUnit: string;
  txnSource: string;
  txnType: string;
  rateIsCorporate: boolean;
  recActivityNameBank: string | null;
  subinventory: string | null;
  integrationSource: string;
  distributionAccId: number | null;
  recActivityNameCash: string | null;
  region: string;
  customerType: string;
  costCenterCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceProviderJournalMeta {
  id: string;
  region: string;
  ledgerId: number;
  taxGroupId: number | null;
  chartOfAccountsId: number;
  serviceProvider: string;
  creditDebit: string | null;
  costIssue: string | null;
  costRma: string | null;
  company: string | null;
  account: string | null;
  department: string | null;
  productCategory: string | null;
  interCompany: string | null;
  jeCategory: string | null;
  jeSource: string | null;
  isCash: boolean;
  summaryFlag: boolean;
  fixedFreightCharge: number;
  bankChargeRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface SalesIntegrationStatus {
  id: string;
  region: string;
  integMode: string;
  status: string;
  updatedAt: string;
}

export interface VendHqDiscountItem {
  id: string;
  discountItemId: string;
  region: string;
  createdAt: string;
}

export interface VendHqTaxMeta {
  id: string;
  taxId: string;
  taxName: string;
  version: number;
  fusionName: string | null;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface VendHqOutlet {
  id: string;
  outletId: string;
  outletName: string;
  currency: string;
  version: number;
  deletedAt: string | null;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface VendHqRegister {
  id: string;
  registerId: string;
  outletId: string;
  registerName: string;
  cashAccount: string | null;
  cashAccountId: number | null;
  bankAccount: string | null;
  bankAccountId: number | null;
  giftAccount: string | null;
  giftAccountId: number | null;
  version: number;
  deletedAt: string | null;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface VendHqServiceProvider {
  id: string;
  region: string;
  serviceProvider: string;
  vendHqCustomerId: string | null;
  isCash: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendHqItemMeta {
  id: string;
  itemId: string;
  name: string;
  sku: string | null;
  active: boolean;
  region: string;
  retailPrice: number | null;
  taxId: string | null;
  uomCode: string | null;
  itemType: string | null;
  createdAt: string;
  updatedAt: string;
}



// ─── Oracle Import ─────────────────────────────────────────────────
export interface OracleImportResult {
  table: string;
  oracleTable: string;
  imported: number;
  skipped: number;
  errors: string[];
}

export interface OracleImportSummary {
  connectedAs: string;
  tablesFound: string[];
  results: OracleImportResult[];
  totalImported: number;
  totalErrors: number;
}

// ─── Region / Integration Trigger types ────────────────────────────
export interface VendHqRegionCredential {
  id: string;
  region: string;
  domainName: string;
}

// ─── API Endpoint Configuration ────────────────────────────────────
export interface ApiEndpointConfig {
  id: string;
  service: string;
  name: string;
  path: string;
  method: string;
  description: string | null;
  apiVersion: string | null;
  region: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── AI Monitor ────────────────────────────────────────────────────
export type FindingSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
export type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface AiFinding {
  id: string;
  severity: FindingSeverity;
  category: string;
  title: string;
  detail: string;
  recommendation: string;
  evidence?: Record<string, unknown>;
}

export interface AiAnalysisResult {
  status: OverallStatus;
  healthScore: number;
  generatedAt: string;
  findings: AiFinding[];
  counts: { critical: number; warning: number; info: number };
  summary: string;
  summarySource: 'ai' | 'rule-based';
  signals: {
    collectedAt: string;
    credentials: Record<string, { active: number; total: number }>;
    queue: { pending: number; processing: number; skipped: number; failed: number; synced: number };
    recentJobs: { windowHours: number; total: number; failed: number; partial: number; completed: number; stale: number };
    failedTransactions: { unresolved: number; byType: Record<string, number> };
    itemSyncErrors: number;
  };
}
