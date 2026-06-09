// ─── Sync / Order types ────────────────────────────────────────────────────

export type SyncStatus = 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'SKIPPED';
export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'CANCELLED';
export type JobType = 'ORDER_SYNC' | 'INVENTORY_SYNC' | 'PAYMENT_SYNC' | 'CONFIG_SYNC' | 'REFUND_SYNC';
export type ScopeType = 'SINGLE_ORDER' | 'DATE_RANGE' | 'BRANCH' | 'ALL' | 'FAILED_ONLY';

export interface SyncJob {
  id: string;
  jobType: JobType;
  scopeType: ScopeType;
  scopeValue: Record<string, unknown>;
  status: JobStatus;
  totalRecords: number;
  processedRecords: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  createdBy: string;
  errorMessage?: string;
}

export interface OrderSyncQueue {
  id: string;
  odooOrderId: string;
  odooOrderNumber: string;
  branchCode: string;
  branchName?: string;
  orderDate: string;
  orderDateUtc: string;
  originalTimezone: string;
  customerName?: string;
  customerEmail?: string;
  totalAmount: string;
  currency: string;
  status: SyncStatus;
  validationErrors?: unknown;
  syncAttempts: number;
  lastSyncAt?: string;
  isPaid: boolean;
  isCancelled: boolean;
  isRefund: boolean;
  refundReferenceId?: string;
  oracleInvoiceNumber?: string;
  oracleCreditMemoNumber?: string;
  negativeInventoryFlag: boolean;
  negativeInventoryItems?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface FailedTransaction {
  id: string;
  errorType: string;
  errorMessage: string;
  errorDetails?: unknown;
  retryCount: number;
  maxRetries: number;
  isResolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  createdAt: string;
  orderSyncQueue?: {
    odooOrderNumber: string;
    branchCode: string;
  };
}

// ─── Refund types ──────────────────────────────────────────────────────────

export type CreditMemoStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface RefundTracking {
  id: string;
  originalOrderId: string;
  originalOrderNumber: string;
  refundOrderId: string;
  refundOrderNumber: string;
  refundAmount: string;
  refundReason?: string;
  refundDate: string;
  oracleCreditMemoNumber?: string;
  creditMemoStatus: CreditMemoStatus;
  isReconciled: boolean;
  reconcileNote?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Inventory types ───────────────────────────────────────────────────────

export interface InventorySyncTracker {
  id: string;
  orderSyncQueueId?: string;
  productSku: string;
  productName?: string;
  branchCode: string;
  quantityChange: number;
  currentQuantity: number;
  isNegativeInventory: boolean;
  negativeInventoryAlertSent: boolean;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  createdAt: string;
}

// ─── Audit types ───────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  branchCode?: string;
  userId?: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  errorMessage?: string;
  statusCode?: number;
  durationMs?: number;
  correlationId?: string;
  createdAt: string;
}

// ─── Health types ──────────────────────────────────────────────────────────

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
export type ServiceName = 'ODOO' | 'ORACLE' | 'REDIS' | 'DATABASE' | 'QUEUE';

export interface IntegrationHealthCheck {
  id: string;
  serviceName: ServiceName;
  status: HealthStatus;
  responseTimeMs: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureReason?: string;
  consecutiveFailures: number;
  createdAt: string;
}

// ─── Alert types ───────────────────────────────────────────────────────────

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertType = 'SYNC_FAILURE' | 'VALIDATION_ERROR' | 'PAYMENT_UNMAPPED' | 'INVENTORY_WARNING' | 'HEALTH_CHECK' | 'SYSTEM';

export interface AlertLog {
  id: string;
  alertType: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  relatedEntityId?: string;
  relatedEntityType?: string;
  isResolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
}

// ─── Payment types ─────────────────────────────────────────────────────────

export type MappingStatus = 'ACTIVE' | 'PENDING' | 'REJECTED' | 'INACTIVE';

export interface PaymentMethodMapping {
  id: string;
  odooPaymentMethodId: string;
  odooPaymentMethodName: string;
  sourceSystem: string;
  oracleReceiptMethodId?: string;
  oracleReceiptMethodName?: string;
  requiresApproval: boolean;
  approvedAt?: string;
  approvedBy?: string;
  status?: MappingStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Store types ───────────────────────────────────────────────────────────

export interface StoreConfiguration {
  id: string;
  branchCode: string;
  branchName: string;
  odooBranchId: number;
  oracleOperatingUnitId: number;
  oracleBusinessUnit: string;
  billToSiteName: string;
  billToLocation: string;
  bankAccountName: string;
  cashAccountName: string;
  paymentTermsName: string;
  taxClassificationCode: string;
  transactionSource: string;
  transactionType: string;
  invoiceCurrencyCode: string;
  isActive: boolean;
  createdBy: string;
  lastModifiedBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Notification types ────────────────────────────────────────────────────

export interface NotificationRecipient {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  receiveFailureAlerts: boolean;
  receiveDailyReports: boolean;
  receiveInventoryAlerts: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Settings types ────────────────────────────────────────────────────────

export interface AlertThresholds {
  failureRateThreshold: number;
  latencyThreshold: number;
  maxQueueDepth: number;
  alertCooldownMinutes: number;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

export interface SyncSchedule {
  orderSync: string;
  retryFailed: string;
  healthCheck: string;
}
