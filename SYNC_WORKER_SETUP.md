# Sync Worker Setup Guide

## ⚠️ CRITICAL: The Worker Process is REQUIRED for Sync Jobs

### Problem Statement
Based on the logs, **NO SYNC ACTIVITY** was detected because:
1. The cron jobs run in the **Worker process**, not the API server
2. The worker process may not be running or properly configured
3. Without the worker, all scheduled backups and sync jobs are dormant

---

## Architecture Overview

This application uses a **dual-process architecture**:

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN API SERVER                          │
│  (packages/backend/src/main.ts)                                 │
│                                                                 │
│  - HTTP REST endpoints                                          │
│  - GraphQL API                                                  │
│  - WebSocket Gateway                                            │
│  - Swagger documentation                                        │
│  - Authentication/Authorization                                 │
│                                                                 │
│  ❌ DOES NOT run cron jobs (except health checks)              │
│  ❌ DOES NOT process BullMQ queues                             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      WORKER PROCESS                             │
│  (packages/backend/src/worker.ts)                               │
│                                                                 │
│  ✅ Runs ALL scheduled cron jobs:                              │
│     • Odoo backup (every 15 min)                                │
│     • IBQ backup (every 15 min)                                 │
│     • VendHQ backup (every 10 min)                              │
│     • Pipeline scheduler (every 5 min)                          │
│     • VendHQ→Oracle sync (every 10 min)                         │
│     • Inventory sync (every 30 min)                             │
│     • Item sync (hourly)                                        │
│     • Stalled orders check (daily 1 AM)                         │
│                                                                 │
│  ✅ Processes BullMQ queue jobs:                                │
│     • ORDER_SYNC queue                                          │
│     • INVENTORY_SYNC queue                                      │
│     • RETRY queue                                               │
│     • NOTIFICATIONS queue                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## How to Run the Worker

### Option 1: Docker Compose (Recommended)

The `docker-compose.yml` already includes a worker service:

```bash
# Start all services including worker
docker compose up -d

# Or start only specific services
docker compose up -d postgres redis-master backend worker

# Check worker logs
docker compose logs -f worker

# Verify worker is running
docker compose ps worker
```

Expected worker logs:
```
🔧 BullMQ worker process started — processing queues…
✅ Automatic pipeline is ENABLED (min batch size: 1)
Redis connected
```

### Option 2: Development Mode (Local)

```bash
cd packages/backend

# Terminal 1: Run the API server
pnpm run dev

# Terminal 2: Run the worker process
pnpm run start:worker:dev
```

### Option 3: Production Build

```bash
cd packages/backend

# Build the application
pnpm run build

# Terminal 1: API server
pnpm run start

# Terminal 2: Worker process
pnpm run start:worker
```

---

## Verifying Sync is Working

### 1. Check Worker Process is Running

**Docker:**
```bash
docker compose ps worker
# Should show: integration_worker (running)
```

**Local:**
```bash
ps aux | grep "nest start --watch --entryFile worker"
# Should show the worker process
```

### 2. Check Worker Logs for Cron Activity

```bash
# Docker
docker compose logs -f worker | grep -E "backup|sync|pipeline"

# Expected output every few minutes:
# [08:30:00] Odoo backup+ingest done: backup.saved=5 ingest.queued=5
# [08:35:00] 🔄 Automatic pipeline triggered: 5 pending orders found
# [08:35:01] ✅ Automatic sync job created: cmqv31wwx000ds034do43tuco (5 orders)
```

### 3. Check SyncControl Status via API

```bash
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/sync-control

# Expected response:
[
  {
    "serviceName": "odoo-backup",
    "enabled": true,
    "isRunning": false,
    "lastRunAt": "2026-06-27T08:30:00.000Z",
    "lastStatus": "success",
    "runCount": 12
  },
  {
    "serviceName": "pipeline-scheduler",
    "enabled": true,
    "isRunning": false,
    "lastRunAt": "2026-06-27T08:35:00.000Z",
    "lastStatus": "success",
    "runCount": 24
  },
  ...
]
```

### 4. Check OrderSyncQueue has Pending Orders

```bash
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/queue/stats

# Expected response:
{
  "PENDING": 10,
  "PROCESSING": 2,
  "COMPLETED": 150,
  "FAILED": 0
}
```

### 5. Monitor BullMQ Queue Dashboard

Visit: http://localhost:3001/queues (if Bull Board is enabled)

You should see:
- Active jobs being processed
- Completed jobs count increasing
- Low failure rate

---

## Troubleshooting

### Issue: Worker logs show "No active credentials"

**Symptoms:**
```
No active Odoo credentials found — backup skipped
No active IBQ credentials found — backup skipped
No active VendHQ credentials found — backup skipped
```

**Solution:**
1. Configure credentials in the database via admin panel
2. Or set environment variables (ODOO_BASE_URL, ODOO_API_KEY, etc.)

---

### Issue: Cron jobs not running

**Symptoms:**
- No logs from worker process
- SyncControl shows `lastRunAt: null`

**Check:**
1. Is worker process running?
   ```bash
   docker compose ps worker
   ```

2. Is ScheduleModule enabled?
   - Already verified: ✅ YES (worker-app.module.ts line 55)

3. Are services disabled in SyncControl?
   ```sql
   SELECT * FROM "SyncControl" WHERE enabled = false;
   ```

---

### Issue: Duplicate orders in OrderSyncQueue

**Symptoms:**
- Same order appears multiple times
- Duplicate Oracle sync attempts

**Solution:**
✅ **FIXED** in this PR:
- Odoo credential backup offset by 7 minutes
- Both backup jobs check SyncControl
- Idempotency service prevents duplicate processing

---

### Issue: Pipeline not creating sync jobs

**Symptoms:**
```
No pending orders to process
Pending orders (3) below minimum batch size (1)
```

**Check:**
1. Are orders being marked as `isPaid: true`?
   ```sql
   SELECT status, "isPaid", "isCancelled", COUNT(*)
   FROM "OrderSyncQueue"
   GROUP BY status, "isPaid", "isCancelled";
   ```

2. Is PIPELINE_ENABLED set to false?
   ```bash
   echo $PIPELINE_ENABLED
   # Should be empty or "true"
   ```

3. Is pipeline-scheduler disabled?
   ```bash
   curl -H "Authorization: ******" \
     http://localhost:3001/api/v1/admin/sync-control/pipeline-scheduler
   ```

---

## Environment Variables

### Required for Worker

```bash
# Database (same as API server)
DATABASE_URL="postgresql://..."
DIRECT_DATABASE_URL="postgresql://..."

# Redis (required for BullMQ)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Optional: Oracle credentials (if not in database)
ODOO_BASE_URL=
ODOO_API_KEY=

# Optional: Pipeline control
PIPELINE_ENABLED=true           # Set to "false" to disable auto-pipeline
PIPELINE_MIN_BATCH_SIZE=1       # Minimum orders before creating job
```

### Optional for Advanced Configuration

```bash
# Logging
LOG_LEVEL=debug                 # Use "debug" to see cron execution logs
NODE_ENV=production

# JWT (same as API server for consistency)
JWT_SECRET=your-secret-key
```

---

## Scaling Considerations

### Horizontal Scaling

You can run **multiple worker processes** to increase throughput:

```yaml
# docker-compose.yml
services:
  worker-1:
    # ... same config as worker
    container_name: integration_worker_1

  worker-2:
    # ... same config as worker
    container_name: integration_worker_2

  worker-3:
    # ... same config as worker
    container_name: integration_worker_3
```

**Important:**
- ✅ Cron jobs use Redis-based locking (only ONE worker executes each cron)
- ✅ BullMQ distributes queue jobs across all workers automatically
- ✅ Multiple workers = faster queue processing, same cron frequency

### Vertical Scaling

For large order volumes:

```yaml
worker:
  environment:
    # Increase connection pool
    DATABASE_URL: "...?connection_limit=20"
  deploy:
    resources:
      limits:
        cpus: '2.0'
        memory: 4G
      reservations:
        cpus: '1.0'
        memory: 2G
```

---

## Monitoring

### Recommended Metrics to Track

1. **Cron Job Health**
   - Endpoint: `GET /api/v1/admin/sync-control`
   - Monitor: `lastRunAt`, `runCount`, `errorCount`

2. **Queue Stats**
   - Endpoint: `GET /api/v1/sync/queue/stats`
   - Monitor: PENDING count (should not grow unbounded)

3. **Worker Process**
   - Docker: `docker compose ps worker` (should be "Up")
   - Process: `ps aux | grep worker` (should show running process)

4. **BullMQ Dashboard**
   - URL: http://localhost:3001/queues
   - Monitor active/completed/failed jobs

### Alerting Rules

Set up alerts for:
- Worker process down > 5 minutes
- SyncControl.lastRunAt > 30 minutes ago (for critical services)
- OrderSyncQueue PENDING count > 1000
- BullMQ failed job count > 100

---

## Summary

### ✅ What We Fixed

1. **Duplicate Odoo cron jobs** → Offset by 7 minutes + SyncControl check
2. **FusionInvToVendHq missing SyncControl** → Added control checks
3. **Inventory sync not in worker** → Already present ✓
4. **Missing SyncControl initialization** → Added fusion-inv-to-vendhq

### ⚠️ What You Must Do

1. **Ensure worker process is running** (docker compose up -d worker)
2. **Configure credentials** (Odoo, IBQ, VendHQ via admin panel or env vars)
3. **Monitor SyncControl dashboard** to verify cron jobs are running
4. **Check logs** for any errors during sync operations

### 📊 Expected Behavior After Fixes

- **Every 5 minutes:** Pipeline scheduler checks for pending orders
- **Every 10 minutes:** VendHQ backup runs
- **Every 15 minutes:** Odoo/IBQ backups run (at different times)
- **Every 30 minutes:** Inventory sync runs
- **Continuous:** BullMQ processes queued orders → Oracle

---

## Quick Start Checklist

- [ ] Start worker process (`docker compose up -d worker`)
- [ ] Configure at least one credential (Odoo/IBQ/VendHQ)
- [ ] Verify SyncControl shows services enabled
- [ ] Check worker logs for cron activity
- [ ] Monitor OrderSyncQueue for pending orders
- [ ] Verify Oracle sync completes successfully

---

**Last Updated:** 2026-06-27  
**Related Files:**
- `packages/backend/src/worker.ts`
- `packages/backend/src/worker-app.module.ts`
- `packages/backend/src/sync/pipeline-scheduler.service.ts`
- `docker-compose.yml` (lines 264-289)
