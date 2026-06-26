# How to Fix Existing Orders - Complete Guide

This guide explains how to apply the latest payment detection fixes to existing orders that may have been processed with outdated logic.

## What Was Fixed

The system now has **comprehensive payment detection** with:
- **22+ paid order states** (previously only 3: paid, done, posted)
- **Payment data fallback** - checks actual payment records when state is unknown/null
- **Multi-layered detection** - explicit state checks, then payment data, then safe defaults

See [ORACLE_SYNC_PAYMENT_FIX.md](./ORACLE_SYNC_PAYMENT_FIX.md) for full technical details.

## Quick Start - Fix All Orders

### Option 1: Auto-Fix Skipped Orders (Recommended)
This automatically diagnoses and fixes orders that were incorrectly skipped:

```bash
# Fix all skipped orders
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders"

# Fix skipped orders for a specific branch
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders?branchCode=270"

# Fix a specific order
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders?odooOrderId=160909"
```

**What it does:**
- Analyzes each skipped order to determine why it was skipped
- Re-checks payment status using the latest detection logic
- Re-queues orders that should be synced
- Reports detailed results for each order

### Option 2: Retry Skipped Orders
If orders are already marked as `isPaid=true` but status is `SKIPPED`:

```bash
# Retry all skipped orders
curl -X POST "http://localhost:3001/api/v1/sync/orders/retry-skipped"

# Retry for specific branch
curl -X POST "http://localhost:3001/api/v1/sync/orders/retry-skipped?branchCode=270"

# Set a limit
curl -X POST "http://localhost:3001/api/v1/sync/orders/retry-skipped?limit=500"
```

**What it does:**
- Finds orders with `status=SKIPPED`, `isPaid=true`, `isCancelled=false`
- Changes their status to `PENDING`
- Re-enqueues them for Oracle sync

### Option 3: Re-Ingest from Backup (For Orders Not Yet in Queue)
If orders exist in backup tables but haven't been ingested into the sync queue:

```bash
# Re-ingest all backup orders
curl -X POST "http://localhost:3001/api/v1/odoo-backup/reingest-from-backup"

# Re-ingest with filters
curl -X POST "http://localhost:3001/api/v1/odoo-backup/reingest-from-backup" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2026-06-01",
    "endDate": "2026-06-27",
    "region": "AE",
    "limit": 1000
  }'
```

**What it does:**
- Reads orders from `BackupOdooOrder` tables
- Re-runs payment detection using the latest logic
- Creates/updates entries in `OrderSyncQueue`
- Does NOT hit the Odoo API (uses existing backup data)

## Step-by-Step Process

### Step 1: Diagnose Current State

Check what states are present in skipped orders:

```bash
curl "http://localhost:3001/api/v1/sync/auto-fix/suggest-states"
```

This shows:
- Which order states are causing skips
- How many orders have each state
- Recommendations for which states to add to PAID_ORDER_STATES

### Step 2: Fix Skipped Orders

Run the auto-fix to correct orders that were incorrectly skipped:

```bash
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders"
```

Expected response:
```json
{
  "totalProcessed": 200,
  "fixed": 195,
  "couldNotFix": 5,
  "results": [
    {
      "orderSyncQueueId": "...",
      "odooOrderId": "160909",
      "branchCode": "3",
      "issue": "not_marked_as_paid",
      "action": "reingest",
      "success": true,
      "message": "Order state \"invoiced\" indicates payment, re-ingested and queued"
    }
  ]
}
```

### Step 3: Re-Ingest Missing Orders

If some orders aren't in the queue at all, re-ingest from backup:

```bash
curl -X POST "http://localhost:3001/api/v1/odoo-backup/reingest-from-backup" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1000}'
```

### Step 4: Monitor Progress

Watch the sync progress:

```bash
# Get sync statistics
curl "http://localhost:3001/api/v1/sync/diagnostics/summary"

# Check order queue status
curl "http://localhost:3001/api/v1/sync/order-queue?status=PENDING"

# Check specific order
curl "http://localhost:3001/api/v1/sync/orders/160909/diagnose"
```

Or use the dashboard:
- **Sync Jobs**: http://localhost:3000/sync-jobs
- **Skipped Orders**: http://localhost:3000/skipped-orders
- **Dashboard**: http://localhost:3000/

### Step 5: Verify Results

Check that orders are syncing to Oracle:

```bash
# Check recent sync job results
curl "http://localhost:3001/api/v1/sync/jobs?limit=10"

# Check specific order status
curl "http://localhost:3001/api/v1/sync/order-queue/{orderSyncQueueId}"
```

## All Available Endpoints

### Diagnostic Endpoints
- `GET /sync/orders/:odooOrderId/diagnose` - Detailed order analysis
- `GET /sync/diagnostics/summary` - System-wide sync statistics
- `GET /sync/auto-fix/suggest-states` - Find missing paid states
- `GET /sync/order-queue` - List orders in sync queue

### Fix Endpoints
- `POST /sync/auto-fix/skipped-orders` - Auto-fix skipped orders
- `POST /sync/orders/retry-skipped` - Retry skipped but paid orders
- `POST /odoo-backup/reingest-from-backup` - Re-ingest from backup tables
- `POST /sync/orders/retry-negative-inventory` - Retry orders held for inventory

### Manual Fetch Endpoints
- `POST /sync/fetch-odoo` - Fetch new orders from Odoo API
- `POST /sync/fetch-ibq` - Fetch new orders from IBQ API

## VendHQ Orders

VendHQ orders use a different sync pipeline. To fix VendHQ orders:

1. **Check for unsynchronized sales:**
   ```bash
   # Query BackupVendHqSale where fusionSynced=false
   ```

2. **Trigger manual sync:**
   The VendHQ→Oracle sync runs automatically every 10 minutes via cron.
   Check `VendHqToOracleSyncService` logs for any failures.

3. **Re-trigger failed syncs:**
   Update `fusionSynced=false` and `lastSyncAttempt=null` for failed records,
   and the cron will pick them up on the next run.

## Troubleshooting

### Orders Still Skipped After Auto-Fix

1. **Check the diagnostic output:**
   ```bash
   curl "http://localhost:3001/api/v1/sync/orders/{odooOrderId}/diagnose"
   ```

2. **Common reasons:**
   - Order is cancelled (`isCancelled=true`)
   - Order is truly unpaid (draft/quotation state, no payment data)
   - Missing store configuration for the branch
   - Invalid branch code

3. **If order should be paid:**
   - Check if the state is in PAID_ORDER_STATES
   - Check if payment data exists in the backup
   - Enable debug logging: `ODOO_UTILS_DEBUG=true`

### Auto-Fix Reports "Could Not Fix"

Orders that cannot be auto-fixed usually fall into these categories:

- **Cancelled orders** - Correctly marked as unpaid
- **Draft/quotation orders** - Not yet finalized
- **Missing payment data** - No state or payment records to determine status
- **Missing store config** - Cannot route to Oracle without valid branch mapping

Review the `results` array in the auto-fix response to see specific reasons.

### Payment Detection Still Wrong

1. **Check what detection logic was used:**
   Enable debug mode by setting `ODOO_UTILS_DEBUG=true` in backend `.env`

2. **Add missing states:**
   If you find a state that should be marked as paid, add it to `PAID_ORDER_STATES` in:
   `packages/backend/src/common/odoo-utils.ts`

3. **Check payment data:**
   Verify that `statement_ids`, `payment_ids`, or `payments` arrays contain actual payment objects (not just IDs)

4. **Re-run ingestion:**
   After updating states, run reingest or auto-fix again to apply changes

## Best Practices

1. **Always run auto-fix first** - it's the safest and most comprehensive approach
2. **Review the results** - check what actions were taken before proceeding
3. **Monitor sync progress** - watch for new failures or issues
4. **Enable debug logging** - helps identify edge cases and missing states
5. **Re-run as needed** - safe to run multiple times, idempotent operations

## Related Documentation

- [ORACLE_SYNC_PAYMENT_FIX.md](./ORACLE_SYNC_PAYMENT_FIX.md) - Technical details of the payment detection fix
- [ORACLE_SYNC_FIX_GUIDE.md](./ORACLE_SYNC_FIX_GUIDE.md) - Implementation guide
- [ORDER_SYNC_ISSUE_FIX.md](./ORDER_SYNC_ISSUE_FIX.md) - Original issue fix documentation
- [SYNC_FIX_SUMMARY.md](../SYNC_FIX_SUMMARY.md) - Complete summary of all fixes

## Support

If issues persist after following this guide:

1. Collect diagnostic data:
   - Auto-fix results
   - Diagnostic summary output
   - Backend logs with debug enabled
   - Specific order diagnostics

2. Check for:
   - New order states not in PAID_ORDER_STATES
   - Store configuration issues
   - Oracle API connectivity problems

3. Review memories and documentation for similar issues
