# Order Sync Issue Fix Guide

## Overview

This guide helps you diagnose and fix order sync issues, specifically when orders are skipped during the Oracle sync process.

## Common Issue: Order Skipped (PARTIAL Status)

When you see a sync job with:
- `status: "PARTIAL"`
- `skippedCount: 1+`
- `successCount: 0`
- `failedCount: 0`

This means orders were processed but intentionally skipped due to:
1. Order not marked as paid (`isPaid = false`)
2. Order is cancelled (`isCancelled = true`)
3. Missing store configuration
4. Validation errors

## Quick Fix for Order 160909

### Step 1: Run the Diagnostic Script

From Docker:
```bash
docker exec -it integration_backend sh
cd /app/packages/backend
npx ts-node -r tsconfig-paths/register src/scripts/diagnose-order-160909.ts
```

From local development:
```bash
cd packages/backend
npx ts-node -r tsconfig-paths/register src/scripts/diagnose-order-160909.ts
```

This will show you:
- Whether the order exists in OrderSyncQueue
- The order's current status (isPaid, isCancelled)
- The source order state from backup tables
- Whether the state is in PAID_ORDER_STATES
- Store configuration status
- Specific recommendations

### Step 2: Use the Diagnostics API

```bash
# Diagnose specific order
curl http://localhost:3001/api/v1/sync/orders/160909/diagnose

# With branch code if known
curl http://localhost:3001/api/v1/sync/orders/160909/diagnose?branchCode=YOUR_BRANCH
```

### Step 3: Auto-Fix the Issue

```bash
# Auto-fix a specific order
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders?odooOrderId=160909"

# Auto-fix all skipped orders
curl -X POST http://localhost:3001/api/v1/sync/auto-fix/skipped-orders

# Auto-fix skipped orders for a specific branch
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders?branchCode=YOUR_BRANCH"

# Limit the number of orders to fix
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders?limit=50"
```

### Step 4: Verify the Fix

```bash
# Check order status
curl http://localhost:3001/api/v1/sync/orders/160909

# Check sync job status
curl http://localhost:3001/api/v1/sync/jobs?limit=10

# Check queue stats
curl http://localhost:3001/api/v1/sync/queue/stats
```

## Root Cause Analysis

### Issue 1: Order State Not in PAID_ORDER_STATES

**Symptom:** Order has a state like `"invoiced"`, `"sale"`, or custom state, but `isPaid = false`

**Supported Paid States:**
```
paid, done, posted, invoiced, sale, invoice, confirmed, validated, 
sent, open, to invoice, to_invoice, progress, in_payment, in payment, 
processing, complete, completed, closed, finalized, finalised
```

**Solution:**
1. Check if your order state should indicate payment
2. If yes, use the auto-fix endpoint:
   ```bash
   curl -X POST http://localhost:3001/api/v1/sync/auto-fix/skipped-orders?odooOrderId=160909
   ```
3. If the state is truly a new paid state, add it to `PAID_ORDER_STATES` in `packages/backend/src/common/odoo-utils.ts`

### Issue 2: Order Has Payment Data But Wrong State

**Symptom:** Order has `statement_ids`, `payment_ids`, or `payments` data, but state is unknown

**How It Works:**
The payment detection has 3 layers:
1. Check if state is explicitly unpaid (draft, quotation, cancelled)
2. Check if state is in PAID_ORDER_STATES
3. **Fallback:** Check for payment data in statement_ids/payment_ids/payments

**Solution:**
The auto-fix service will detect this and re-ingest the order with correct `isPaid` flag.

### Issue 3: Missing Order State

**Symptom:** Order state is not in PAID_ORDER_STATES and has no payment data

**Get Suggestions:**
```bash
# See which states are commonly skipped
curl http://localhost:3001/api/v1/sync/auto-fix/suggest-states
```

This will show you:
- Which states appear in skipped orders
- How many orders have each state
- Sample order data for each state

**Solution:**
If a state appears frequently and should be paid:
1. Add it to `PAID_ORDER_STATES` in `packages/backend/src/common/odoo-utils.ts`
2. Re-ingest orders from backup:
   ```bash
   curl -X POST http://localhost:3001/api/v1/odoo-backup/reingest-from-backup
   ```
3. Or use auto-fix to update existing orders

## Enhanced Debugging

### Enable Payment Detection Logging

Set environment variable:
```bash
# In .env file
ODOO_UTILS_DEBUG=true
```

Or in Docker Compose:
```yaml
backend:
  environment:
    ODOO_UTILS_DEBUG: "true"
```

This will log detailed information about each order's payment detection:
```
[odoo-utils] Order 160909: isPaid=false - unknown state "pending" with no payment data
[odoo-utils] Order 160909: Consider adding "pending" to PAID_ORDER_STATES if this state indicates payment
```

### Check Backend Logs

```bash
# Docker
docker compose logs -f backend --tail=100

# Filter for specific order
docker compose logs backend | grep "160909"

# Filter for payment detection logs
docker compose logs backend | grep "odoo-utils"
```

## Manual Fixes

### Fix 1: Update Order Status Directly

```sql
-- Connect to database
docker exec -it integration_postgres psql -U integration -d integration_db

-- Check order status
SELECT "odooOrderId", "branchCode", status, "isPaid", "isCancelled"
FROM "OrderSyncQueue"
WHERE "odooOrderId" = '160909';

-- Manually mark as paid and pending (if appropriate)
UPDATE "OrderSyncQueue"
SET "isPaid" = true, 
    status = 'PENDING',
    "validationErrors" = NULL,
    "updatedAt" = NOW()
WHERE "odooOrderId" = '160909';
```

### Fix 2: Re-ingest from Backup

```bash
# Re-ingest specific order from backup
curl -X POST "http://localhost:3001/api/v1/odoo-backup/reingest-from-backup?limit=1000"

# Or re-ingest from IBQ backup
curl -X POST "http://localhost:3001/api/v1/ibq-backup/reingest-from-backup?limit=1000"
```

### Fix 3: Retry Skipped Orders

```bash
# After fixing state mapping, retry all skipped orders
curl -X POST http://localhost:3001/api/v1/sync/orders/retry-skipped

# For specific branch
curl -X POST "http://localhost:3001/api/v1/sync/orders/retry-skipped?branchCode=YOUR_BRANCH"

# With limit
curl -X POST "http://localhost:3001/api/v1/sync/orders/retry-skipped?limit=500"
```

## Adding New Paid States

If you need to add a new state to PAID_ORDER_STATES:

1. **Edit** `packages/backend/src/common/odoo-utils.ts`:

```typescript
const PAID_ORDER_STATES = [
  'paid',
  'done',
  'posted',
  'invoiced',
  'sale',
  'invoice',
  'confirmed',
  'validated',
  'sent',
  'open',
  'to invoice',
  'to_invoice',
  'progress',
  'in_payment',
  'in payment',
  'processing',
  'complete',
  'completed',
  'closed',
  'finalized',
  'finalised',
  'YOUR_NEW_STATE',  // Add your state here (lowercase)
] as const;
```

2. **Restart the backend**:
```bash
docker compose restart backend
```

3. **Re-process skipped orders**:
```bash
curl -X POST http://localhost:3001/api/v1/sync/auto-fix/skipped-orders
```

## Testing the Fix

1. **Check Order Status:**
   ```bash
   curl http://localhost:3001/api/v1/sync/orders/160909
   ```

2. **Monitor Queue:**
   ```bash
   curl http://localhost:3001/api/v1/sync/order-queue?status=PENDING&limit=10
   curl http://localhost:3001/api/v1/sync/order-queue?status=SKIPPED&limit=10
   curl http://localhost:3001/api/v1/sync/order-queue?status=SYNCED&limit=10
   ```

3. **Check Sync Jobs:**
   ```bash
   curl http://localhost:3001/api/v1/sync/jobs?limit=10
   ```

4. **Watch Logs:**
   ```bash
   docker compose logs -f backend --tail=100
   ```

## Troubleshooting

### Issue: Auto-fix returns 0 orders fixed

**Possible Reasons:**
1. Orders are actually cancelled or unpaid (intentionally skipped)
2. Missing store configuration
3. Orders not in OrderSyncQueue yet (need to run backup fetch first)

**Solution:**
1. Run diagnostics on specific order
2. Check if order exists in backup tables
3. Run backup fetch if needed
4. Check store configuration

### Issue: Order keeps getting skipped

**Check:**
1. Store configuration exists: `GET /admin/store-configurations`
2. Store is active and valid
3. Oracle credentials are configured
4. Queue workers are running

### Issue: Order synced but not appearing in Oracle

**Check:**
1. Oracle SOAP connectivity
2. Failed transactions table
3. Fusion invoice headers table
4. Oracle instance credentials

## Support

If you still have issues:

1. Export diagnostics:
   ```bash
   curl http://localhost:3001/api/v1/sync/orders/160909/diagnose > order-160909-diagnostic.json
   curl http://localhost:3001/api/v1/sync/diagnostics/summary > diagnostics-summary.json
   curl http://localhost:3001/api/v1/sync/auto-fix/suggest-states > suggested-states.json
   ```

2. Export logs:
   ```bash
   docker compose logs backend > backend-logs.txt
   ```

3. Share these files with the development team

## Related Documentation

- [ORACLE_SYNC_FIX_GUIDE.md](./ORACLE_SYNC_FIX_GUIDE.md) - Original fix guide
- [ORACLE_SYNC_PAYMENT_FIX.md](./ORACLE_SYNC_PAYMENT_FIX.md) - Payment detection details
- [ORACLE_SYNC_TROUBLESHOOTING.md](./ORACLE_SYNC_TROUBLESHOOTING.md) - General troubleshooting
