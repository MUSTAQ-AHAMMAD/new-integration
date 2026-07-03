# Data Synchronization Issues - Complete Fix Guide

## Overview

This guide explains the data synchronization issues you were experiencing and how to use the new diagnostic tools to resolve them.

## Issues Fixed

### 1. CSV Import Errors (ROW_ID and Unknown Fields)

**Problem:** CSV imports were failing silently with generic "Unknown argument" errors.

**Root Cause:** 
- CSV files contained columns that don't exist in the Prisma schema (e.g., `ROW_ID`)
- Error messages didn't indicate which row or field caused the problem
- No validation of field names before attempting import

**Solution:**
```bash
# Enhanced error messages now show:
# - Row number where error occurred
# - List of unknown fields
# - List of valid fields for the table
```

**Example Error (Before):**
```
Unknown argument ROW_ID
```

**Example Error (After):**
```
Row 5: Unknown fields [ROW_ID, INVALID_FIELD]. Valid fields: itemId, sku, name, region, description, active, lastUpdateDate
```

**How to Fix Your CSV:**
1. Export a sample from the system to see correct format:
   ```bash
   curl "http://localhost:3000/admin/vendhq-item-meta/export" > template.csv
   ```

2. Match your CSV headers to the exported template

3. Remove any `ROW_ID` columns - the system auto-generates IDs

### 2. Oracle Import Skipping Rows

**Problem:** Oracle imports were silently skipping rows with no indication of which rows or why.

**Root Cause:**
- Row-level errors were logged but not associated with row identifiers
- No context about which data caused the failure

**Solution:**
```bash
# Enhanced error reporting now shows:
# - Row number
# - Row identifier (e.g., ITEM_ID=12345, OUTLET_NAME=EXBSA)
# - Specific error message
# - Full row data in logs for debugging
```

**Example Error (Before):**
```
Invalid `prisma.vendHqItemMeta.upsert()` invocation
```

**Example Error (After):**
```
Row 42 (ITEM_ID=VDN-12345): Invalid `prisma.vendHqItemMeta.upsert()` invocation: Field 'region' is required but was null
```

**How to Debug:**
```bash
# Import from Oracle with enhanced errors
curl -X POST http://localhost:3000/admin/oracle-import

# Response now shows detailed error messages:
{
  "results": [
    {
      "table": "VendHqItemMeta",
      "imported": 45,
      "skipped": 3,
      "errors": [
        "Row 5 (ITEM_ID=123): Field 'region' is required",
        "Row 12 (NAME=Product X): Invalid price format",
        "Row 18 (OUTLET_NAME=EXBSA): Duplicate key violation"
      ]
    }
  ]
}
```

### 3. Order Sync Skipping Orders

**Problem:** Orders were being marked as `SKIPPED` with no clear explanation.

**Root Cause:**
- Orders marked as `isPaid=false` are automatically skipped
- No diagnostic tools to check why an order was marked as unpaid
- isPaid logic is complex (checks order state, payment data)

**Solution:**
New diagnostic endpoints:

```bash
# Check why orders are being skipped
curl http://localhost:3000/admin/diagnostics/sync/skipped-orders?limit=50

# Response:
{
  "total": 25,
  "summary": {
    "notPaid": 20,
    "cancelled": 3,
    "validationErrors": 2
  },
  "orders": [
    {
      "odooOrderId": "12345",
      "odooOrderNumber": "SO-001",
      "branchCode": "EXBSA",
      "isPaid": false,
      "isCancelled": false,
      "skipReasons": [
        "Order is not marked as paid (isPaid=false)"
      ]
    }
  ]
}

# Check specific order status
curl http://localhost:3000/admin/diagnostics/sync/order-status/12345

# Response:
{
  "found": true,
  "order": { ... },
  "skipReasons": ["Order is marked as isPaid=false"],
  "recommendations": [
    "Check if the order state in Odoo/IBQ indicates payment.",
    "Use POST /sync/orders/retry-skipped to re-evaluate."
  ],
  "canRetry": true
}
```

**How to Fix:**

1. **Check if order state is in PAID_ORDER_STATES:**
   The system recognizes these states as "paid":
   - 'paid', 'done', 'posted', 'invoiced', 'sale', 'invoice'
   - 'confirmed', 'validated', 'sent', 'open'
   - 'to_invoice', 'progress', 'in_payment', 'processing'
   - 'complete', 'closed', 'finalized'

2. **If your orders use a different state:**
   - Check what state your orders have in Odoo/IBQ
   - If it's a valid paid state, add it to `PAID_ORDER_STATES` in `odoo-utils.ts`
   - Use `POST /sync/orders/retry-skipped` to re-evaluate

3. **If orders have payment data but wrong state:**
   - The system will detect payment data as backup
   - Use retry endpoint to re-process

### 4. Item Sync Not Working

**Problem:** Items from Oracle Fusion weren't appearing in VendHqItemMeta table.

**Root Cause:**
- Sync service might be disabled
- No active VendHQ credentials
- Items being filtered out (no ItemNumber or MarketPrice)
- VendHQ API errors not clearly logged

**Solution:**
New diagnostic endpoints:

```bash
# Check item sync status
curl http://localhost:3000/admin/diagnostics/items/sync-status?region=SA

# Response:
{
  "summary": {
    "total": 150,
    "successCount": 145,
    "errorCount": 5,
    "successRate": "96.67"
  },
  "recentItems": [ ... ],
  "recentErrors": [
    {
      "itemId": "VDN-789",
      "sku": "SKU-001",
      "status": "ERROR",
      "message": "VendHQ API error: Invalid tax_id",
      "region": "SA"
    }
  ],
  "recommendations": [
    "Review error messages in VendHqItemMeta table",
    "Check VendHQ credentials are active and valid"
  ]
}

# Manually trigger item sync
curl -X POST http://localhost:3000/item-sync/trigger/SA

# Response:
{
  "ok": true,
  "region": "SA",
  "synced": 15,
  "skipped": 3,
  "failed": 0,
  "errors": []
}
```

**How to Fix:**

1. **Enable item sync service:**
   ```bash
   curl -X POST http://localhost:3000/sync/control/item-sync/enable
   ```

2. **Check VendHQ credentials:**
   ```bash
   curl http://localhost:3000/admin/diagnostics/credentials/status
   
   # Ensure VendHQ credentials are active
   # Add credentials if missing:
   curl -X POST http://localhost:3000/admin/vendhq-credentials \
     -H "Content-Type: application/json" \
     -d '{
       "region": "SA",
       "domainName": "your-domain.vendhq.com",
       "personalToken": "your-token",
       "fusionOrgCode": "SA_ORG",
       "active": true
     }'
   ```

3. **Check Oracle Fusion credentials:**
   ```bash
   # Verify Fusion credentials are active
   curl http://localhost:3000/admin/fusion-credentials
   ```

### 5. System Health Monitoring

**New Endpoint:** Overall system health check

```bash
curl http://localhost:3000/admin/diagnostics/system/health

# Response:
{
  "status": "healthy",  // or "degraded", "unhealthy"
  "timestamp": "2026-07-03T19:40:00Z",
  "summary": {
    "pendingOrders": 120,
    "skippedOrders": 5,
    "itemSyncErrors": 2,
    "recentJobsCount": 10,
    "failedJobsCount": 0
  },
  "syncControls": [
    {
      "service": "item-sync",
      "enabled": true,
      "isRunning": false,
      "lastRunAt": "2026-07-03T18:00:00Z",
      "lastStatus": "success"
    },
    {
      "service": "odoo-backup",
      "enabled": true,
      "isRunning": false,
      "lastRunAt": "2026-07-03T19:00:00Z",
      "lastStatus": "success"
    }
  ],
  "recentJobs": [ ... ],
  "issues": [],
  "warnings": [
    "High skip rate: 50 skipped vs 120 pending orders"
  ]
}
```

## Complete Diagnostic Workflow

### Step 1: Check System Health
```bash
curl http://localhost:3000/admin/diagnostics/system/health
```

### Step 2: Check Credentials
```bash
curl http://localhost:3000/admin/diagnostics/credentials/status
```

### Step 3: Check Why Orders Are Skipped
```bash
curl http://localhost:3000/admin/diagnostics/sync/skipped-orders?limit=100
```

### Step 4: Check Item Sync Status
```bash
curl http://localhost:3000/admin/diagnostics/items/sync-status
```

### Step 5: Fix Issues and Retry

**For CSV imports:**
1. Fix your CSV file based on error messages
2. Remove unknown fields
3. Re-import

**For Oracle imports:**
1. Fix data in Oracle tables based on error messages
2. Re-run import: `curl -X POST http://localhost:3000/admin/oracle-import`

**For order sync:**
1. Fix isPaid logic if needed (add states to PAID_ORDER_STATES)
2. Retry skipped orders: `curl -X POST http://localhost:3000/sync/orders/retry-skipped`

**For item sync:**
1. Ensure credentials are active
2. Manually trigger: `curl -X POST http://localhost:3000/item-sync/trigger/{region}`

## Common Issues and Solutions

### "Row 5: Unknown fields [ROW_ID]"
**Solution:** Remove `ROW_ID` column from your CSV. The system auto-generates IDs.

### "Order is marked as isPaid=false"
**Solution:** 
1. Check order state in source system
2. Add state to PAID_ORDER_STATES if valid
3. Use retry endpoint: `POST /sync/orders/retry-skipped`

### "Item sync returning 0 items"
**Solution:**
1. Check Oracle Fusion credentials are active
2. Check watermark date isn't too recent
3. Check items have non-null ItemNumber and MarketPrice

### "No active VendHQ credentials"
**Solution:** Add credentials via `/admin/vendhq-credentials`

### "High skip rate"
**Solution:** Use diagnostics endpoints to identify why orders are being skipped, then address root cause

## Summary

All sync and import operations now provide:
- ✅ Detailed error messages with row numbers
- ✅ Field-level validation
- ✅ Row identifiers in error messages
- ✅ Diagnostic endpoints to check system health
- ✅ Actionable recommendations
- ✅ Enhanced logging for debugging

The system will now clearly tell you **exactly** why data is being skipped or rejected, rather than failing silently.
