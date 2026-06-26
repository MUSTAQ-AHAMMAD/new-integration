# Oracle Sync Fix - Complete Verification Guide

## Overview

This guide provides comprehensive verification steps for the Oracle sync fix that ensures all orders fetched from Odoo/IBQ API are correctly marked as paid (except cancelled orders).

## Implementation Summary

### Changes Made

1. **Updated Order Normalization Logic** (`packages/backend/src/common/odoo-utils.ts`)
   - All orders from Odoo/IBQ API are now marked as `isPaid=true` by default
   - Only explicitly cancelled orders are marked as `isPaid=false`
   - Removed dependency on state-based filtering since API pre-filters paid orders

2. **Created Fix Script** (`packages/backend/scripts/fix-skipped-orders.ts`)
   - Updates existing skipped orders to `isPaid=true` and `status=PENDING`
   - Allows re-processing of previously skipped orders

3. **Added Retry Endpoint** (`packages/backend/src/sync/sync.service.ts`)
   - `POST /api/v1/sync/orders/retry-skipped` endpoint
   - Re-queues skipped orders that should be synced

4. **Created Verification Script** (`packages/backend/scripts/verify-oracle-sync-fix.ts`)
   - Comprehensive checks for all verification points
   - Database connection, order logic, queue stats, and error tracking

5. **Added Unit Tests** (`packages/backend/src/common/odoo-utils.spec.ts`)
   - Tests for all order states (paid, cancelled, draft, etc.)
   - Edge case handling
   - Backwards compatibility verification

## Verification Checklist

### ✅ Point 1: Backend Service Restarted Successfully

**What to check:**
- Database connection is working
- All services start without errors
- No missing dependencies or configuration issues

**How to verify:**

```bash
# Start backend service
cd packages/backend
pnpm dev

# OR with Docker
docker compose up -d backend

# Check logs for startup
pm2 logs backend | grep "Application is running"

# Verify health endpoint
curl http://localhost:3001/api/v1/health
```

**Expected result:**
```json
{
  "status": "ok",
  "info": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  }
}
```

**Automated check:**
```bash
# Run verification script
cd packages/backend
npx ts-node scripts/verify-oracle-sync-fix.ts
```

---

### ✅ Point 2: New Orders Being Marked as isPaid=true

**What to check:**
- Order normalization logic correctly identifies paid orders
- All states except "cancel"/"cancelled" are marked as paid
- Logic handles edge cases (null states, unknown states)

**How to verify:**

```bash
# Run unit tests
cd packages/backend
pnpm test odoo-utils.spec.ts

# Check test results for isPaid logic
```

**Manual verification:**

```typescript
// Test in Node REPL
import { normalizeOrderForIngestion } from './src/common/odoo-utils';

const testOrder = {
  id: 12345,
  name: 'TEST-001',
  branch_id: [1, 'Test Branch'],
  state: 'draft', // Try various states
  amount_total: 100,
};

const result = normalizeOrderForIngestion(testOrder);
console.log(result?.isPaid); // Should be true for all except 'cancel'/'cancelled'
```

**Expected results:**
- ✅ `paid` → `isPaid=true`
- ✅ `done` → `isPaid=true`
- ✅ `posted` → `isPaid=true`
- ✅ `invoiced` → `isPaid=true`
- ✅ `draft` → `isPaid=true` (NEW: API pre-filters)
- ✅ `unknown_state` → `isPaid=true` (NEW: API pre-filters)
- ✅ `cancel` → `isPaid=false`
- ✅ `cancelled` → `isPaid=false`

**Automated check:**
```bash
npx ts-node scripts/verify-oracle-sync-fix.ts
# Look for: "All order state tests passed!"
```

---

### ✅ Point 3: Previously Skipped Orders Have Been Re-queued

**What to check:**
- Skipped orders with `isPaid=false` have been updated
- Updated orders are set to `status=PENDING`
- Orders are enqueued for processing

**How to verify:**

```bash
# Check current skipped order count
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/order-queue?status=SKIPPED

# Run the fix script
cd packages/backend
npx ts-node scripts/fix-skipped-orders.ts

# OR use the API endpoint
curl -X POST \
  -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/orders/retry-skipped

# Verify orders were updated
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/order-queue?status=PENDING
```

**SQL verification:**

```sql
-- Check skipped orders before fix
SELECT COUNT(*) FROM "OrderSyncQueue" 
WHERE status = 'SKIPPED' AND "isPaid" = false;

-- After running fix, this should be 0
SELECT COUNT(*) FROM "OrderSyncQueue" 
WHERE status = 'SKIPPED' AND "isPaid" = false;

-- Check updated orders
SELECT COUNT(*) FROM "OrderSyncQueue" 
WHERE status = 'PENDING' AND "isPaid" = true;
```

**Expected result:**
```json
{
  "updated": 200,  // Number of orders updated
  "enqueued": 200  // Number of orders enqueued
}
```

**Automated check:**
```bash
npx ts-node scripts/verify-oracle-sync-fix.ts
# Look for: "Skipped orders status: 0 retryable"
```

---

### ✅ Point 4: Oracle Sync Processor is Running

**What to check:**
- BullMQ queue is processing jobs
- Pipeline scheduler is creating sync jobs
- Workers are active and processing orders

**How to verify:**

```bash
# Check queue statistics
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/queue-stats

# Check recent sync jobs
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/jobs?limit=10

# Check worker logs
pm2 logs backend | grep "Processing order"
```

**Expected result:**
```json
{
  "queues": {
    "order-sync": {
      "waiting": 50,
      "active": 10,
      "completed": 1000,
      "failed": 5
    }
  }
}
```

**SQL verification:**

```sql
-- Check recent sync jobs
SELECT "jobType", status, "createdAt" 
FROM "SyncJob" 
WHERE "createdAt" > NOW() - INTERVAL '24 hours'
ORDER BY "createdAt" DESC
LIMIT 10;

-- Check processing queue
SELECT status, COUNT(*) 
FROM "OrderSyncQueue" 
GROUP BY status;
```

**Automated check:**
```bash
npx ts-node scripts/verify-oracle-sync-fix.ts
# Look for: "Oracle sync processor has work queued"
```

---

### ✅ Point 5: Orders Successfully Pushing to Oracle

**What to check:**
- Orders are transitioning from PENDING → PROCESSING → SYNCED
- Oracle API calls are succeeding
- Invoice and receipt numbers are being generated

**How to verify:**

```bash
# Check synced orders
curl -H "Authorization: ******" \
  "http://localhost:3001/api/v1/sync/order-queue?status=SYNCED&limit=10"

# Check specific order details
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/order-queue/162147

# Check audit log for Oracle calls
curl -H "Authorization: ******" \
  "http://localhost:3001/api/v1/dashboard/audit-log?limit=10"
```

**Expected result:**
```json
{
  "orders": [
    {
      "odooOrderNumber": "Order162147",
      "status": "SYNCED",
      "oracleInvoiceNumber": "INV-2026-001",
      "oracleReceiptNumber": "RCT-2026-001",
      "lastSyncAt": "2026-06-26T10:30:00Z"
    }
  ]
}
```

**SQL verification:**

```sql
-- Check synced orders in last 24 hours
SELECT 
  "odooOrderNumber",
  "oracleInvoiceNumber",
  "oracleReceiptNumber",
  "lastSyncAt"
FROM "OrderSyncQueue"
WHERE status = 'SYNCED' 
  AND "lastSyncAt" > NOW() - INTERVAL '24 hours'
ORDER BY "lastSyncAt" DESC
LIMIT 20;

-- Check sync success rate
SELECT 
  status,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM "OrderSyncQueue"
WHERE "createdAt" > NOW() - INTERVAL '7 days'
GROUP BY status;
```

**Automated check:**
```bash
npx ts-node scripts/verify-oracle-sync-fix.ts
# Look for: "Orders are successfully syncing to Oracle"
```

---

### ✅ Point 6: No New Errors in Failed Transactions

**What to check:**
- Failed transaction count is not increasing
- No new error patterns introduced by the fix
- Existing errors are documented and expected

**How to verify:**

```bash
# Check failed transactions
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/failed-transactions?limit=20

# Check error distribution
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/dashboard/stats
```

**Expected result:**
```json
{
  "recentFailures": 0,  // Last 24 hours
  "totalFailures": 5,   // Historical
  "commonErrors": [
    {
      "errorType": "MISSING_STORE_CONFIG",
      "count": 3
    }
  ]
}
```

**SQL verification:**

```sql
-- Check recent failed transactions
SELECT 
  "errorType",
  "errorMessage",
  "createdAt"
FROM "FailedTransaction"
WHERE "createdAt" > NOW() - INTERVAL '24 hours'
ORDER BY "createdAt" DESC;

-- Group errors by type
SELECT 
  "errorType",
  COUNT(*) as count,
  MAX("createdAt") as "lastOccurrence"
FROM "FailedTransaction"
GROUP BY "errorType"
ORDER BY count DESC;

-- Check if specific orders are repeatedly failing
SELECT 
  osq."odooOrderNumber",
  COUNT(ft.id) as "failureCount",
  array_agg(DISTINCT ft."errorType") as "errorTypes"
FROM "FailedTransaction" ft
JOIN "OrderSyncQueue" osq ON ft."orderSyncQueueId" = osq.id
WHERE ft."createdAt" > NOW() - INTERVAL '7 days'
GROUP BY osq."odooOrderNumber"
HAVING COUNT(ft.id) > 3
ORDER BY "failureCount" DESC;
```

**Automated check:**
```bash
npx ts-node scripts/verify-oracle-sync-fix.ts
# Look for: "No new errors in failed transactions"
```

---

## Complete Verification Workflow

### Step 1: Run Automated Verification

```bash
cd packages/backend

# Install dependencies (if needed)
pnpm install

# Generate Prisma client (if needed)
pnpm db:generate

# Run verification script
npx ts-node scripts/verify-oracle-sync-fix.ts
```

This will output a comprehensive report covering all 6 verification points.

### Step 2: Review Test Coverage

```bash
# Run unit tests
pnpm test odoo-utils.spec.ts

# Check coverage
pnpm test --coverage
```

### Step 3: Manual Dashboard Checks

1. **Orders Page**: http://localhost:3000/orders
   - Check for orders in PENDING/PROCESSING/SYNCED status
   - Verify no unusual SKIPPED count

2. **Skipped Orders Page**: http://localhost:3000/skipped-orders
   - Should show 0 or very few orders
   - Any skipped orders should have clear reasons (cancelled, missing config)

3. **Sync Jobs**: http://localhost:3000/sync-jobs
   - Check recent job statuses
   - Verify PARTIAL status has acceptable skipped counts

4. **Failed Transactions**: http://localhost:3000/failed-transactions
   - Check for new error patterns
   - Verify no increase in failure rate

### Step 4: Backend Logs Review

```bash
# Check for errors
pm2 logs backend --err | tail -50

# Check for successful syncs
pm2 logs backend | grep "Successfully synced order"

# Check order ingestion logs
pm2 logs backend | grep "Ingesting order"
```

### Step 5: Database Verification

Run these SQL queries to verify data integrity:

```sql
-- Overall sync status distribution
SELECT status, COUNT(*), 
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as pct
FROM "OrderSyncQueue"
GROUP BY status;

-- Check for orders that should be retried
SELECT COUNT(*) 
FROM "OrderSyncQueue"
WHERE status = 'SKIPPED' 
  AND "isPaid" = true 
  AND "isCancelled" = false;

-- Recent sync activity
SELECT 
  DATE("lastSyncAt") as date,
  COUNT(*) as synced_count
FROM "OrderSyncQueue"
WHERE status = 'SYNCED' 
  AND "lastSyncAt" > NOW() - INTERVAL '7 days'
GROUP BY DATE("lastSyncAt")
ORDER BY date DESC;
```

## Success Criteria

All verification points should show:

- ✅ Backend service healthy and running
- ✅ Unit tests passing (100% for isPaid logic)
- ✅ 0 orders with `status=SKIPPED AND isPaid=false AND isCancelled=false`
- ✅ Active queue processing (PENDING/PROCESSING orders being handled)
- ✅ Recent SYNCED orders (within last 24 hours)
- ✅ No increase in failed transaction rate
- ✅ No new error patterns in logs

## Troubleshooting

### Issue: Tests Not Running

**Problem:** `jest: not found` or `ts-jest` missing

**Solution:**
```bash
cd packages/backend
pnpm install
pnpm test
```

### Issue: pnpm Version Mismatch

**Problem:** `Expected version: >=9.0.0 <10.0.0, Got: 11.5.2`

**Solution:**
```bash
# Install pnpm 9
npm install -g pnpm@9

# OR use npx with specific version
npx pnpm@9 install
```

### Issue: Prisma Client Not Generated

**Problem:** `Cannot find module '@prisma/client'`

**Solution:**
```bash
cd packages/backend
pnpm db:generate
# OR
npx prisma generate
```

### Issue: Database Connection Failed

**Problem:** Verification script fails with connection error

**Solution:**
```bash
# Check if Postgres is running
docker compose ps postgres

# Start if not running
docker compose up -d postgres

# Check .env file has correct DATABASE_URL
cat .env | grep DATABASE_URL
```

### Issue: Still Seeing Skipped Orders

**Problem:** Orders remain SKIPPED after running fix

**Solution:**
```bash
# Check if orders are actually paid
SELECT "odooOrderNumber", "isPaid", "isCancelled", status 
FROM "OrderSyncQueue" 
WHERE status = 'SKIPPED' 
LIMIT 10;

# If isPaid=true, re-run retry endpoint
curl -X POST http://localhost:3001/api/v1/sync/orders/retry-skipped

# If isPaid=false, they may be legitimately cancelled
SELECT state FROM "BackupOdooOrder" WHERE "orderName" = 'OrderXXXXX';
```

## Next Steps After Verification

1. **Monitor for 24 hours**
   - Watch dashboard metrics
   - Check for any new error patterns
   - Verify sync success rate remains stable

2. **Document any issues**
   - Note any edge cases discovered
   - Update troubleshooting guide
   - File bugs for unexpected behavior

3. **Update team**
   - Share verification results
   - Document any manual steps taken
   - Update runbooks with new procedures

4. **Plan for production deployment**
   - Create deployment checklist
   - Schedule deployment window
   - Prepare rollback plan

## Rollback Plan

If issues are discovered after verification:

1. **Revert code changes:**
   ```bash
   git revert HEAD
   git push
   ```

2. **Restore restrictive logic:**
   - Edit `odoo-utils.ts`
   - Change back to state-based filtering
   - Redeploy

3. **Update skipped orders:**
   ```sql
   UPDATE "OrderSyncQueue" 
   SET status = 'SKIPPED', "isPaid" = false
   WHERE status = 'PENDING' 
     AND "createdAt" > NOW() - INTERVAL '1 hour';
   ```

## Support Contacts

- **Backend Lead**: [Your Name]
- **DevOps**: [DevOps Team]
- **Oracle Integration**: [Integration Team]

## Documentation References

- [PAID_ORDER_FIX.md](./PAID_ORDER_FIX.md) - Problem and solution overview
- [ORACLE_SYNC_FIX_GUIDE.md](./ORACLE_SYNC_FIX_GUIDE.md) - Implementation details
- [ORACLE_INTEGRATION_TROUBLESHOOTING.md](./ORACLE_INTEGRATION_TROUBLESHOOTING.md) - Troubleshooting guide
