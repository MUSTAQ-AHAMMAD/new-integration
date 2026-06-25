# Sync Job Pipeline Implementation - Summary

## Problem Statement

The sync job system was not working properly:
1. Jobs showed "PARTIAL" status immediately without actual processing
2. No automatic pipeline to process newly ingested orders
3. Cron jobs fetched data from Odoo but didn't trigger Oracle sync automatically
4. Missing scheduler service similar to Java's Quartz implementation

## Solution Implemented

### 1. Automatic Pipeline Scheduler

Created `PipelineSchedulerService` that mimics the Java reference implementation's `VendHQIntegrationScheduler`:

```typescript
@Injectable()
export class PipelineSchedulerService {
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runAutomaticPipeline(): Promise<void>

  @Cron('0 */30 * * * *')
  async retryNegativeInventoryOrders(): Promise<void>

  @Cron(CronExpression.EVERY_MINUTE)
  async monitorPipelineHealth(): Promise<void>
}
```

**Features:**
- Runs every 5 minutes to process PENDING orders
- Auto-creates sync jobs with `createdBy="DASHBOARD_PIPELINE"`
- Retries negative inventory orders every 30 minutes
- Monitors pipeline health every minute with backlog/failure alerts
- Configurable via environment variables

### 2. Configuration

Added environment variables for pipeline control:

```bash
# Enable/disable the automatic sync pipeline
PIPELINE_ENABLED=true

# Minimum number of pending orders before creating a sync job
PIPELINE_MIN_BATCH_SIZE=1
```

### 3. Dashboard UI

Created `PipelineStatus` component showing:
- Pipeline health status (healthy/warning/error)
- Real-time queue statistics (pending, processing, failed, completed)
- Last automatic run information
- Auto-refresh every 5 seconds

### 4. Documentation

- `docs/PIPELINE_ARCHITECTURE.md` - Complete pipeline architecture guide
- Updated `README.md` with pipeline overview
- Inline code documentation

## Architecture

```
┌─────────────────────────────────────────────┐
│    Odoo/IBQ APIs (External Systems)         │
└────────────────┬────────────────────────────┘
                 │ REST API (every 15 min)
                 ▼
┌─────────────────────────────────────────────┐
│  OdooBackupService (Cron - 15 min)          │
│  - Fetches orders from Odoo                 │
│  - Saves to BackupOdooOrder table           │
│  - Calls OrderSyncService.ingestOrder()     │
└────────────────┬────────────────────────────┘
                 │ Ingestion
                 ▼
┌─────────────────────────────────────────────┐
│      OrderSyncQueue (PENDING status)        │
└────────────────┬────────────────────────────┘
                 │ Automatic (every 5 min)
                 ▼
┌─────────────────────────────────────────────┐
│  PipelineSchedulerService (NEW!)            │
│  - Finds PENDING orders                     │
│  - Creates SyncJob automatically            │
│  - Monitors health                          │
└────────────────┬────────────────────────────┘
                 │ Job creation
                 ▼
┌─────────────────────────────────────────────┐
│         SyncJob → BullMQ Queue              │
└────────────────┬────────────────────────────┘
                 │ Process (10 workers)
                 ▼
┌─────────────────────────────────────────────┐
│      OrderSyncProcessor                     │
│  - Validates & transforms                   │
│  - Calls Oracle SOAP/REST APIs              │
└────────────────┬────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────┐
│          Oracle Fusion ERP                  │
│  - Invoice creation                         │
│  - Receipt creation                         │
└─────────────────────────────────────────────┘
```

## Key Differences from Java Implementation

| Aspect | Java (Quartz) | Node.js (NestJS) |
|--------|---------------|------------------|
| Scheduler | `VendHQIntegrationScheduler` | `PipelineSchedulerService` |
| Jobs | Quartz `SimpleTrigger` | `@Cron` decorators |
| Workers | `BackgroundTaskExecutor` (4 threads) | BullMQ (10 workers) |
| Queue | In-memory | Redis-backed (BullMQ) |
| Retry | Manual | Exponential backoff |
| Config | Properties files | Environment variables |
| Monitoring | Logs + Email | Dashboard + WebSocket |

## Testing

Unit tests added for `PipelineSchedulerService`:
- ✅ Creates sync job for pending orders
- ✅ Skips when no pending orders
- ✅ Prevents concurrent runs
- ✅ Resets negative inventory holds
- ✅ Monitors pipeline health

## Usage

### Automatic Mode (Default)

The pipeline runs automatically every 5 minutes. No action required.

```bash
# Start the backend
cd packages/backend
pnpm dev
```

The logs will show:
```
[PipelineSchedulerService] ✅ Automatic pipeline is ENABLED (min batch size: 1)
[PipelineSchedulerService] 🔄 Automatic pipeline triggered: 150 pending orders found
[PipelineSchedulerService] ✅ Automatic sync job created: cljxyz123 (150 orders)
```

### Manual Mode

To disable the automatic pipeline and use manual sync jobs only:

```bash
# In .env
PIPELINE_ENABLED=false
```

Then create sync jobs manually via the dashboard or API.

### Configuration Examples

**Production (High Volume)**
```bash
PIPELINE_ENABLED=true
PIPELINE_MIN_BATCH_SIZE=10  # Wait for at least 10 orders
```

**Development (Low Volume)**
```bash
PIPELINE_ENABLED=true
PIPELINE_MIN_BATCH_SIZE=1   # Process immediately
```

**Manual Testing**
```bash
PIPELINE_ENABLED=false       # Disable automatic processing
```

## Monitoring

### Dashboard

Navigate to the main dashboard to see the **Pipeline Status** panel showing:
- Pipeline health
- Queue statistics
- Last automatic run

### Logs

```bash
# Backend logs
docker-compose logs -f backend

# Look for pipeline activity
[PipelineSchedulerService] 🔄 Automatic pipeline triggered
[PipelineSchedulerService] ✅ Automatic sync job created
[PipelineSchedulerService] ⚠️ Large backlog detected
```

### Alerts

The system creates alerts for:
- Large backlogs (>1000 pending orders)
- High failure rates (>100 failed orders)
- Store configuration errors
- Payment mapping failures

## Files Changed

### Backend
- `packages/backend/src/sync/pipeline-scheduler.service.ts` (NEW)
- `packages/backend/src/sync/pipeline-scheduler.service.spec.ts` (NEW)
- `packages/backend/src/sync/sync.module.ts` (UPDATED)
- `.env.example` (UPDATED)

### Dashboard
- `packages/dashboard/src/components/dashboard/pipeline-status.tsx` (NEW)
- `packages/dashboard/src/app/(dashboard)/page.tsx` (UPDATED)

### Documentation
- `docs/PIPELINE_ARCHITECTURE.md` (NEW)
- `README.md` (UPDATED)

## Future Enhancements

- [ ] Admin UI to pause/resume pipeline per region
- [ ] Configurable pipeline schedule per region (different intervals for different regions)
- [ ] Priority queues for urgent orders
- [ ] Machine learning for failure prediction
- [ ] Real-time WebSocket notifications when pipeline processes orders
- [ ] Pipeline metrics dashboard (throughput, latency, success rate)
- [ ] Auto-scaling based on queue depth

## Troubleshooting

**Q: Pipeline not running?**
- Check `PIPELINE_ENABLED` in `.env` (should be `true`)
- Verify backend logs for pipeline activity
- Check if `@nestjs/schedule` module is imported in `AppModule`

**Q: No orders being processed?**
- Check `OrderSyncQueue` for PENDING orders
- Verify BullMQ Redis connection: `docker ps | grep redis`
- Check queue stats: `GET /api/v1/sync/queue/stats`

**Q: Pipeline showing "Large backlog"?**
- Increase `PIPELINE_MIN_BATCH_SIZE` to reduce job frequency
- Scale horizontally: Run multiple backend instances
- Check for configuration errors blocking orders

**Q: Jobs show PARTIAL status immediately?**
- This is correct when all orders are skipped (unpaid/cancelled)
- PARTIAL means "no Oracle syncs were performed"
- Check logs to see why orders were skipped

## References

- Java implementation: https://github.com/MUSTAQ-AHAMMAD/integration-Oracle
- Architecture guide: docs/PIPELINE_ARCHITECTURE.md
- README: README.md
