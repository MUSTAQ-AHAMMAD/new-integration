# Automatic Sync Pipeline

## Overview

The sync pipeline automatically processes orders from Odoo to Oracle Fusion, mimicking the Java reference implementation's Quartz scheduler architecture.

## Architecture

```
┌─────────────────────────────────────────────────┐
│          Odoo/IBQ External Systems              │
└───────────────────┬─────────────────────────────┘
                    │ REST API calls (every 15 min)
                    ▼
┌─────────────────────────────────────────────────┐
│      OdooBackupService (Cron - 15 min)          │
│      IbqBackupService (Cron - 15 min)           │
│  - Fetches orders from external systems         │
│  - Saves to backup tables (BackupOdooOrder)     │
│  - Calls OrderSyncService.ingestOrder()         │
└───────────────────┬─────────────────────────────┘
                    │ Ingestion
                    ▼
┌─────────────────────────────────────────────────┐
│           OrderSyncQueue Table                  │
│  - Stores orders waiting to be synced           │
│  - Status: PENDING → PROCESSING → SYNCED        │
│  - Deduplication via unique constraint          │
└───────────────────┬─────────────────────────────┘
                    │ Automatic (every 5 min)
                    ▼
┌─────────────────────────────────────────────────┐
│   PipelineSchedulerService (Cron - 5 min)       │
│  - Finds all PENDING orders                     │
│  - Creates SyncJob with createdBy="PIPELINE"    │
│  - Monitors pipeline health                     │
│  - Retries negative inventory orders (30 min)   │
└───────────────────┬─────────────────────────────┘
                    │ Job creation
                    ▼
┌─────────────────────────────────────────────────┐
│              SyncJob Table                      │
│  - Manages batch processing                     │
│  - Status: PENDING → PROCESSING → COMPLETED     │
│  - Tracks progress: processedRecords/totalRecords│
└───────────────────┬─────────────────────────────┘
                    │ Enqueues orders
                    ▼
┌─────────────────────────────────────────────────┐
│         BullMQ Queue (order-sync)               │
│  - Distributed task queue (Redis-backed)        │
│  - Retry with exponential backoff               │
│  - Concurrency: 10 workers                      │
└───────────────────┬─────────────────────────────┘
                    │ Process
                    ▼
┌─────────────────────────────────────────────────┐
│       OrderSyncProcessor (Worker)               │
│  - Validates order (paid, not cancelled)        │
│  - Checks store configuration                   │
│  - Transforms Odoo → Oracle format              │
│  - Calls Oracle SOAP/REST APIs                  │
│  - Updates status to SYNCED/FAILED              │
└───────────────────┬─────────────────────────────┘
                    │ SOAP/REST calls
                    ▼
┌─────────────────────────────────────────────────┐
│           Oracle Fusion ERP                     │
│  - Creates invoices (AR)                        │
│  - Creates receipts                             │
│  - Creates journal entries                      │
└─────────────────────────────────────────────────┘
```

## Pipeline Components

### 1. Data Ingestion (Cron - Every 15 Minutes)

**OdooBackupService** and **IbqBackupService**:
- Fetch new/updated orders from Odoo/IBQ APIs
- Store raw data in backup tables (`BackupOdooOrder`, `BackupIbqOrder`)
- Call `OrderSyncService.ingestOrder()` to add orders to the sync queue
- Track watermarks (`lastSyncAt`) to avoid re-fetching

### 2. Order Queue Management

**OrderSyncQueue** table:
- Central queue of all orders waiting to be synced
- Fields:
  - `odooOrderId`, `branchCode` - unique identifier
  - `status` - PENDING, PROCESSING, SYNCED, FAILED, SKIPPED
  - `isPaid`, `isCancelled` - business rules
  - `region`, `odooBackupOrderId` - links to backup data
  - `oracleInvoiceNumber` - result of sync

### 3. Automatic Pipeline (Cron - Every 5 Minutes)

**PipelineSchedulerService**:
- `runAutomaticPipeline()`: Creates sync jobs for all PENDING orders
- `retryNegativeInventoryOrders()`: Retries orders that failed due to inventory issues (every 30 min)
- `monitorPipelineHealth()`: Alerts on large backlogs or high failure rates (every 1 min)

This mimics the Java implementation's **VendHQIntegrationScheduler** that uses Quartz to automatically trigger jobs.

### 4. Batch Job Management

**SyncJob** table:
- Represents a batch of orders to process
- Created by:
  - `PipelineSchedulerService` (automatic, every 5 min)
  - Manual API calls (dashboard UI)
- Tracks:
  - `totalRecords`, `processedRecords`, `successCount`, `failedCount`
  - `status`: PENDING → PROCESSING → COMPLETED/PARTIAL/FAILED

### 5. Queue Processing (BullMQ Workers)

**OrderSyncProcessor**:
- Processes individual orders from the queue
- Steps:
  1. Validate (skip unpaid/cancelled)
  2. Check store configuration
  3. Idempotency check (prevent duplicates)
  4. Transform order data (Odoo → Oracle format)
  5. Call Oracle SOAP/REST APIs
  6. Update order status
  7. Record audit trail

### 6. Oracle Integration

**OracleSoapClient**:
- `createSimpleInvoice()` - Creates AR invoice
- `createStandardReceipt()` - Creates receipt
- `createMiscellaneousReceipt()` - Creates misc receipt
- `applyReceiptToInvoice()` - Applies payment

## Configuration

### Environment Variables

```bash
# Pipeline timing (optional - defaults shown)
PIPELINE_ENABLED=true                # Enable/disable automatic pipeline
PIPELINE_MIN_BATCH_SIZE=1            # Minimum orders before creating job
PIPELINE_INTERVAL_MINUTES=5          # How often to run automatic pipeline

# Note: QUEUE_RETRY_ATTEMPTS is configured in the BullMQ queue setup
# See packages/backend/src/queues/queues.module.ts for queue configuration
```

## Configuration

### Environment Variables

```bash
# Pipeline timing
PIPELINE_ENABLED=true                # Enable/disable automatic pipeline
PIPELINE_MIN_BATCH_SIZE=1            # Minimum orders before creating job
```

### Enabling/Disabling

The pipeline runs automatically when the backend starts. To disable:

1. Set `PIPELINE_ENABLED=false` in `.env`
2. Restart the backend

## Monitoring

### Dashboard

Navigate to `/sync-jobs` to see:
- Recent sync jobs
- Queue statistics (waiting, active, failed, completed)
- Individual order status
- Failed transactions

### Logs

```bash
# Pipeline execution
[PipelineSchedulerService] 🔄 Automatic pipeline triggered: 150 pending orders found
[PipelineSchedulerService] ✅ Automatic sync job created: cljxyz123 (150 orders)

# Health monitoring
[PipelineSchedulerService] ⚠️ Large backlog detected: 1200 pending orders

# Order processing
[OrderSyncProcessor] Processing order sync: ORD-12345 / CCNTRBHR
[OrderSyncProcessor] ✅ Order synced successfully: ORD-12345
```

### Alerts

The pipeline creates alerts for:
- Store configuration errors
- Payment method mapping failures
- Negative inventory holds
- High failure rates

## Manual Controls

### Trigger Sync Job Manually

```bash
# Via API
POST /api/v1/sync/jobs
{
  "jobType": "ORDER_SYNC",
  "scopeType": "DATE_RANGE",
  "startDate": "2026-06-20",
  "endDate": "2026-06-25",
  "createdBy": "DASHBOARD_USER"
}
```

### Retry Failed Orders

```bash
# Retry specific job
POST /api/v1/sync/jobs/{id}/retry

# Retry specific order
POST /api/v1/sync/order-queue/{id}/retry

# Retry all negative inventory holds
# (automatically done by pipeline every 30 min)
```

### Cancel Running Job

```bash
POST /api/v1/sync/jobs/{id}/cancel
```

## Comparison with Java Implementation

| Component | Java (Quartz) | Node.js (NestJS) |
|-----------|---------------|------------------|
| Scheduler | `VendHQIntegrationScheduler` | `PipelineSchedulerService` |
| Jobs | `SimpleTrigger` (Quartz) | `@Cron` decorators |
| Workers | `BackgroundTaskExecutor` (4 threads) | BullMQ (10 workers) |
| Queue | In-memory | Redis-backed (BullMQ) |
| Retry | Manual | Exponential backoff |
| Monitoring | Logs + Email | Logs + WebSocket + Dashboard |

## Troubleshooting

### Pipeline Not Running

1. Check backend logs for errors
2. Verify cron is enabled: `@Cron` decorators present
3. Check `@nestjs/schedule` module is imported in `AppModule`

### Orders Not Processing

1. Check `OrderSyncQueue` for PENDING orders
2. Verify BullMQ queue is running: `docker ps | grep redis`
3. Check queue stats: `GET /api/v1/sync/queue/stats`
4. Review failed transactions: `GET /api/v1/sync/failed-transactions`

### High Backlog

1. Increase queue concurrency: `QUEUE_CONCURRENCY=20`
2. Scale horizontally: Run multiple backend instances
3. Check for configuration errors blocking orders

### Jobs Show PARTIAL Status

This is **correct behavior** when:
- All orders were skipped (unpaid/cancelled)
- No orders were enqueued for Oracle processing

**PARTIAL** means "job completed but no actual Oracle syncs were performed".
**COMPLETED** means "job had no records at all".
**PENDING** means "job is waiting for processing".

## Best Practices

1. **Monitor pipeline health** - Check dashboard regularly for backlogs
2. **Fix configuration errors quickly** - They block entire branches
3. **Review failed transactions** - Address systemic issues
4. **Keep backup tables clean** - Old data archived automatically
5. **Test with manual jobs first** - Before relying on automatic pipeline
6. **Scale horizontally** - Add more backend instances for high volume

## Future Enhancements

- [ ] Admin UI to pause/resume pipeline per region
- [ ] Configurable pipeline schedule per region
- [ ] Priority queues for urgent orders
- [ ] Machine learning for failure prediction
- [ ] Real-time WebSocket notifications
