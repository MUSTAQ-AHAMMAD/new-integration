# Oracle Sync Fix - Implementation Guide

## Problem Summary

Sync jobs were showing orders as "SKIPPED" because the TypeScript implementation was too restrictive about which order states qualify as "paid". The Java integration processes all orders from backup tables without state filtering, while TypeScript required `isPaid=true`.

## Root Cause

The `normalizeOrderForIngestion` function in `common/odoo-utils.ts` only marked orders as paid if their state was in `['paid', 'done', 'posted']`. However, Odoo/IBQ systems use additional states like:
- `'invoiced'` - Invoice generated
- `'sale'` - Sales order confirmed
- `'invoice'` - Invoice state (some Odoo versions)

## Solution Implemented

### 1. Expanded State Mapping

**File:** `packages/backend/src/common/odoo-utils.ts`

```typescript
const PAID_ORDER_STATES = [
  'paid',      // Payment completed (POS orders)
  'done',      // Order fulfilled/completed
  'posted',    // Invoice posted to accounting
  'invoiced',  // Invoice generated (common in IBQ)
  'sale',      // Sales order confirmed (Odoo Sales workflow)
  'invoice',   // Invoice state (some Odoo versions)
];
```

**Key improvements:**
- Added more valid order states based on Odoo/IBQ documentation
- Made state comparison **case-insensitive** for robustness
- Added comprehensive documentation

### 2. Added Diagnostic Logging

**File:** `packages/backend/src/sync/order-sync.service.ts`

Added debug logging to track order ingestion:
```typescript
this.logger.debug(
  `Ingesting order ${processedData.odooOrderNumber}: isPaid=${processedData.isPaid}, ` +
    `isCancelled=${processedData.isCancelled}, status=${statusReason}`,
);
```

### 3. Added Retry Mechanism

**File:** `packages/backend/src/sync/sync.service.ts`

New method `retrySkippedOrders()` allows re-processing of orders that were previously skipped:
- Finds orders with `status=SKIPPED` AND `isPaid=true` AND `isCancelled=false`
- Updates their status to `PENDING`
- Re-queues them for Oracle sync

**Exposed via API:**
```
POST /sync/orders/retry-skipped?branchCode=<optional>&limit=<optional>
```

## Deployment Steps

### Step 1: Deploy the Changes

```bash
# Pull the latest changes
git pull origin main

# Install dependencies (if needed)
pnpm install

# Generate Prisma client
cd packages/backend
npx prisma generate

# Restart the backend service
pm2 restart backend  # or your deployment method
```

### Step 2: Test with New Orders

1. **Trigger a new Odoo/IBQ backup:**
   ```bash
   curl -X POST http://your-api/odoo-backup/fetch-orders
   # or
   curl -X POST http://your-api/ibq-backup/fetch-orders
   ```

2. **Check order ingestion logs:**
   ```bash
   # Look for the new debug logs
   pm2 logs backend --lines 100 | grep "Ingesting order"
   ```

3. **Verify orders are now marked as paid:**
   ```bash
   curl http://your-api/sync/order-queue?status=PENDING&limit=10
   ```

### Step 3: Re-process Previously Skipped Orders

**IMPORTANT:** This will re-attempt to sync ALL previously skipped orders that are now marked as paid.

```bash
# Retry all skipped orders
curl -X POST http://your-api/sync/orders/retry-skipped

# Or retry for specific branch only
curl -X POST "http://your-api/sync/orders/retry-skipped?branchCode=YOUR_BRANCH"

# Or limit the number processed
curl -X POST "http://your-api/sync/orders/retry-skipped?limit=500"
```

**Expected response:**
```json
{
  "updated": 876,
  "enqueued": 876
}
```

### Step 4: Monitor Oracle Sync Progress

1. **Check sync job status:**
   ```bash
   curl http://your-api/sync/jobs?limit=10
   ```

2. **Monitor order queue:**
   ```bash
   # Check pending orders
   curl http://your-api/sync/order-queue?status=PENDING

   # Check synced orders
   curl http://your-api/sync/order-queue?status=SYNCED

   # Check failed orders
   curl http://your-api/sync/order-queue?status=FAILED
   ```

3. **Watch backend logs:**
   ```bash
   pm2 logs backend --lines 500
   ```

## Verification Checklist

- [ ] Backend service restarted successfully
- [ ] New orders are being marked as `isPaid=true` (check logs)
- [ ] Previously skipped orders have been re-queued
- [ ] Oracle sync processor is running (check queue stats)
- [ ] Orders are successfully pushing to Oracle (check `status=SYNCED`)
- [ ] No new errors in failed transactions

## Troubleshooting

### Issue: Orders still showing as SKIPPED

**Check 1: Verify order state in backup table**
```sql
SELECT state, COUNT(*) 
FROM "BackupOdooOrder" 
WHERE state IS NOT NULL 
GROUP BY state;
```

If you see states not in our list, add them to `PAID_ORDER_STATES`.

**Check 2: Verify OrderSyncQueue entries**
```sql
SELECT "isPaid", "isCancelled", status, COUNT(*) 
FROM "OrderSyncQueue" 
GROUP BY "isPaid", "isCancelled", status;
```

### Issue: Retry endpoint returns 0 orders

This means:
- All skipped orders are actually cancelled or unpaid
- OR orders need to be re-ingested from backup tables

**Solution:** Re-run the backup fetch to re-ingest with new state mapping:
```bash
curl -X POST http://your-api/odoo-backup/fetch-orders?credentialId=YOUR_CRED_ID
```

### Issue: Oracle sync still failing

**Check Oracle credentials:**
```bash
curl http://your-api/admin/fusion-credentials
```

**Check failed transactions:**
```bash
curl http://your-api/sync/failed-transactions?limit=20
```

## Comparing with Java Implementation

### Java Approach (Reference)
```java
// Java processes ALL sales from backup table for a specific date range
List<BackupVendhqSales> salesHeaders = session.getSalesOutletBtwDate(
    outlet.getOutletName(), region, processDate, timeZoneOffset
);
// No state filtering - assumes backup table only has valid sales
```

### TypeScript Approach (After Fix)
```typescript
// TypeScript now accepts multiple valid states
const isPaid = PAID_ORDER_STATES.includes(normalizedState);
// Orders marked as paid are queued for Oracle sync
```

**Key Alignment:**
- Java: Processes all backup records (pre-filtered at backup stage)
- TypeScript: Explicitly validates states during ingestion

Both approaches now achieve the same result: valid orders are synced to Oracle.

## Additional Enhancements (Optional)

### Add Custom State Configuration

If your Odoo instance uses custom states, you can add environment variable support:

```typescript
// In odoo-utils.ts
const CUSTOM_PAID_STATES = process.env.CUSTOM_PAID_STATES?.split(',') || [];
const PAID_ORDER_STATES = [
  'paid', 'done', 'posted', 'invoiced', 'sale', 'invoice',
  ...CUSTOM_PAID_STATES,
];
```

Then in your `.env`:
```
CUSTOM_PAID_STATES=custom_paid,custom_invoiced
```

## Success Metrics

After deployment, you should see:

1. **Reduced SKIPPED count** in sync jobs
2. **Increased SYNCED count** in OrderSyncQueue
3. **Orders appearing in Oracle** with correct invoice numbers
4. **No increase in FAILED transactions**

## Support

If you encounter issues:

1. Check the logs: `pm2 logs backend`
2. Review failed transactions: `GET /sync/failed-transactions`
3. Verify Oracle credentials: `GET /admin/fusion-credentials`
4. Check queue stats: `GET /sync/queue-stats`

## Rollback Plan

If issues occur, you can rollback the state mapping:

```typescript
// Revert to original restrictive list
const PAID_ORDER_STATES = ['paid', 'done', 'posted'];
```

Then redeploy. Previously queued orders will complete, but new orders will use the old logic.
