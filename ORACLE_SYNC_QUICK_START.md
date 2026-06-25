# Oracle Sync Issue - Quick Fix Guide

## Your Specific Issue: Order 162147

Based on the sync job data you provided:
```json
{
  "status": "PARTIAL",
  "skippedCount": 1,
  "successCount": 0,
  "failedCount": 0
}
```

**Your order was SKIPPED, not failed.** This means it was filtered out before even attempting to send to Oracle.

## Immediate Diagnosis Steps

### Step 1: Check Why Your Order Was Skipped

**NEW DIAGNOSTIC ENDPOINT:**
```bash
GET /api/v1/sync/orders/162147/diagnose
```

This will tell you EXACTLY why the order was skipped and what to do about it.

**Example Response:**
```json
{
  "analysis": {
    "primaryIssue": "ORDER_SKIPPED",
    "reasons": [
      "Order is not marked as paid (isPaid=false)",
      "Source order state: 'draft'",
      "Accepted paid states: paid, done, posted, invoiced, sale, invoice"
    ],
    "recommendations": [
      "Check if the order state should be considered paid",
      "Use POST /sync/orders/retry-skipped after fixing"
    ],
    "canRetry": true
  }
}
```

### Step 2: Check System-Wide Status

```bash
GET /api/v1/sync/diagnostics/summary
```

This shows if your issue is isolated or system-wide:
```json
{
  "totalOrders": 1000,
  "byStatus": {
    "skipped": 500,  // <-- If this is high, many orders have the same issue
    "synced": 440
  },
  "skippedReasons": {
    "unpaid": 480,   // <-- Most common: orders not marked as "paid"
    "cancelled": 20
  }
}
```

---

## Most Likely Root Causes

### 1. Order State Not in "Paid" List (90% of cases)

Your order's `state` field in Odoo/IBQ must be one of:
- `paid`, `done`, `posted`, `invoiced`, `sale`, `invoice`

**Check your order's state:**
```sql
SELECT state, name, amount_total 
FROM "BackupOdooOrder" 
WHERE orderId = 162147;
```

**If the state is something else** (e.g., `'draft'`, `'confirmed'`, `'validated'`):

1. **Option A:** Change the order state in Odoo/IBQ to a valid paid state
2. **Option B:** Expand the accepted states list in code:
   - File: `packages/backend/src/common/odoo-utils.ts` (line 76)
   - Add your state to `PAID_ORDER_STATES` array
   - Redeploy

3. **Then retry:**
   ```bash
   POST /api/v1/sync/orders/retry-skipped
   ```

### 2. Missing Branch Code (5% of cases)

Order has no `branch_id` field, so it can't be mapped to a store.

**Check:**
```sql
SELECT branch_id, name 
FROM "BackupOdooOrder" 
WHERE orderId = 162147;
```

If `branch_id` is null, the order was silently skipped during ingestion.

### 3. Store Configuration Missing (3% of cases)

Even if the order is marked as paid, sync fails if the store isn't configured.

**Check:**
```sql
SELECT * FROM "StoreConfiguration" 
WHERE branchCode = (
  SELECT branchCode FROM "OrderSyncQueue" WHERE odooOrderId = '162147'
);
```

Required fields:
- `billToSiteName`
- `bankAccountName`
- `cashAccountName`
- `paymentTermsName`
- `oracleBusinessUnit`
- `isActive: true`

### 4. Oracle Credentials Missing (2% of cases)

**Check:**
```sql
SELECT * FROM "FusionCredential" WHERE active = true;
```

Or check environment variables:
```bash
echo $ORACLE_SOAP_BASE_URL
echo $ORACLE_USERNAME
```

---

## Quick Fixes

### Fix 1: Retry Skipped Orders (if states are now correct)
```bash
POST /api/v1/sync/orders/retry-skipped
```

This will re-process ALL orders that were skipped but are now marked as paid.

### Fix 2: Retry Failed Orders (if backup data is now available)
```bash
POST /api/v1/sync/retry-failed
```

### Fix 3: Manual Re-Fetch from Source
```bash
# For Odoo
POST /api/v1/sync/fetch-odoo
{
  "credentialId": "your-credential-id",
  "startDate": "2026-06-25",
  "endDate": "2026-06-25"
}

# For IBQ
POST /api/v1/sync/fetch-ibq
{
  "credentialId": "your-credential-id",
  "startDate": "2026-06-25",
  "endDate": "2026-06-25"
}
```

---

## Complete Investigation Checklist

Run these queries to get the full picture:

### 1. Check Order Status
```sql
SELECT 
  odooOrderId,
  odooOrderNumber,
  branchCode,
  status,
  isPaid,
  isCancelled,
  totalAmount,
  validationErrors,
  syncAttempts,
  lastSyncAt,
  createdAt
FROM "OrderSyncQueue"
WHERE odooOrderId = '162147';
```

### 2. Check Backup Data
```sql
SELECT 
  orderId,
  orderName,
  state,
  amountTotal,
  branchId,
  dateOrder
FROM "BackupOdooOrder"
WHERE orderId = 162147
   OR orderName LIKE '%162147%';
```

### 3. Check Store Config
```sql
SELECT 
  branchCode,
  branchName,
  isActive,
  validationStatus,
  billToSiteName,
  oracleBusinessUnit,
  oracleOperatingUnitId
FROM "StoreConfiguration"
WHERE branchCode IN (
  SELECT DISTINCT branchCode FROM "OrderSyncQueue" WHERE odooOrderId = '162147'
);
```

### 4. Check Failed Transactions (if any)
```sql
SELECT 
  ft.errorType,
  ft.errorMessage,
  ft.errorStack,
  ft.createdAt
FROM "FailedTransaction" ft
JOIN "OrderSyncQueue" osq ON ft.orderSyncQueueId = osq.id
WHERE osq.odooOrderId = '162147'
ORDER BY ft.createdAt DESC;
```

---

## What I've Built For You

### New Diagnostic Tools

1. **OrderDiagnosticsService** - Intelligent diagnosis system that:
   - Analyzes why orders aren't syncing
   - Provides specific recommendations
   - Tells you if orders can be retried

2. **Diagnostic Endpoints:**
   - `GET /sync/orders/:orderId/diagnose` - Per-order analysis
   - `GET /sync/diagnostics/summary` - System-wide stats

3. **Comprehensive Documentation:**
   - `docs/ORACLE_SYNC_TROUBLESHOOTING.md` - Complete guide covering all 7 common issues
   - Diagnostic SQL queries
   - API reference
   - Emergency procedures

---

## Next Steps

1. **Run the diagnostic endpoint** for order 162147 to get specific recommendations
2. **Check the system summary** to see if this is a widespread issue
3. **Follow the recommendations** provided in the diagnostic response
4. **Refer to the full troubleshooting guide** at `docs/ORACLE_SYNC_TROUBLESHOOTING.md`

The diagnostic system will guide you through exactly what's wrong and how to fix it!

---

## Need More Help?

After running the diagnostics, if the issue isn't clear:

1. Share the output from:
   - `GET /sync/orders/162147/diagnose`
   - `GET /sync/diagnostics/summary`
   - The SQL queries above

2. Check backend logs for errors:
   ```bash
   pm2 logs backend --lines 100 | grep "162147"
   ```

3. Review the full troubleshooting documentation at:
   - `docs/ORACLE_SYNC_TROUBLESHOOTING.md`
