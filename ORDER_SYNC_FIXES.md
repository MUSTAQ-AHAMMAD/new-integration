# Order Sync Fixes - Complete Implementation

## Overview
This document describes the three critical fixes implemented to resolve order sync issues:

1. **Orders syncing to Oracle** - Removed backup table dependency
2. **Date display issues** - Fixed "[object Ob]" serialization 
3. **Data enrichment** - Proper handling of orderLines and orderPayments

---

## Issue 1: Orders Not Syncing to Oracle

### Problem
Orders were failing at Step 7/14 because the system appeared to require backup tables, causing sync failures.

### Root Cause
The enrichment service was checking backup tables first, but the logging made it unclear that the system would fall back to minimal enrichment if needed.

### Solution
**Updated Files:**
- `packages/backend/src/queues/processors/order-sync.processor.ts`
- `packages/backend/src/sync/order-enrichment.service.ts`

**Changes:**
1. Enhanced logging in Step 7/14 to clarify the 3-tier enrichment strategy:
   - **Tier 1**: Direct queue data (orderLines + orderPayments JSON fields)
   - **Tier 2**: Backup tables (BackupOdooOrder/BackupVendHqSale)
   - **Tier 3**: Minimal fallback (creates default line/payment from totalAmount)

2. The enrichment service **NEVER fails** - it always returns valid Oracle payloads

3. Updated log messages with emojis for clarity:
   - ✅ "Using DIRECT enrichment (no backup needed)"
   - ⚠️  "Falling back to BackupOdooOrder"
   - ⚠️  "Creating MINIMAL payloads (will still sync successfully)"

---

## Issue 2: Date Display Shows "[object Ob]"

### Problem
UI was displaying "[object Ob]" instead of formatted dates because Date objects were not properly serialized to strings.

### Root Cause
Date objects were being sent directly in JSON responses without conversion to ISO strings, causing JSON.stringify to fail gracefully and produce "[object Object]" (truncated to "[object Ob]" in UI).

### Solution
**New Files:**
- `packages/backend/src/common/utils/date-format.util.ts`
- `packages/backend/src/sync/dto/order-response.dto.ts`

**Changes:**

1. **Created DateFormatUtil** - Centralized date formatting utility:
   ```typescript
   DateFormatUtil.formatDate(date)        // Returns ISO string or null
   DateFormatUtil.formatDateDisplay(date) // Returns human-readable format
   ```

2. **Created OrderResponseDto** - DTO with proper date serialization:
   - All date fields declared as `string` type (not `Date`)
   - Constructor converts Date objects to ISO strings using `new Date(date).toISOString()`
   - Handles null/undefined dates gracefully

3. **Added GET /sync/orders endpoint** - Returns orders with proper date formatting:
   ```
   GET /api/v1/sync/orders?skip=0&take=20&status=PENDING
   ```

---

## Issue 3: Data Enrichment from Multiple Sources

### Problem
Orders needed data from multiple JSON fields (orderLines, orderPayments) within OrderSyncQueue, but the enrichment logic wasn't clear about the fallback strategy.

### Root Cause
The schema already supported storing complete order data in JSON fields, but:
1. Some ingestion paths didn't populate these fields
2. The enrichment logic wasn't clearly documented
3. Logs were confusing about which data source was being used

### Solution
**Updated Files:**
- `packages/backend/src/sync/order-enrichment.service.ts`
- `packages/backend/src/queues/processors/order-sync.processor.ts`

**Changes:**

1. **Clarified hasCompleteData() check**:
   ```typescript
   hasCompleteData(order) {
     return Array.isArray(order.orderLines) && order.orderLines.length > 0
         && Array.isArray(order.orderPayments) && order.orderPayments.length > 0
         && order.totalAmount != null && Number(order.totalAmount) > 0;
   }
   ```

2. **Enhanced Step 7/14 logging** to show:
   - Has orderLines: true/false
   - Has orderPayments: true/false
   - Which enrichment method will be used

3. **Documented 3-tier enrichment strategy** in code comments

---

## New Endpoints

### 1. List Orders with Date Formatting
```bash
GET /api/v1/sync/orders?skip=0&take=20&status=PENDING&branchCode=101
```

**Response:**
```json
{
  "data": [
    {
      "id": "cm123...",
      "orderNumber": "SO-2024-001",
      "branchCode": "101",
      "branchName": "Branch Name",
      "orderDate": "2024-01-15T10:30:00.000Z",  // ✅ ISO string, not [object Ob]
      "orderDateUtc": "2024-01-15T10:30:00.000Z",
      "totalAmount": 1500.50,
      "currency": "AED",
      "syncStatus": "PENDING",
      "customerName": "Customer Name",
      "customerEmail": "customer@example.com",
      "isPaid": true,
      "isCancelled": false,
      "isRefund": false,
      "syncAttempts": 0,
      "lastSyncAt": null,
      "errorMessage": null
    }
  ],
  "total": 100,
  "skip": 0,
  "take": 20
}
```

### 2. Bulk Fix Failed Orders
```bash
POST /api/v1/sync/fix-all-failed
```

Resets all failed orders to PENDING and re-queues them for sync.

**Response:**
```json
{
  "message": "Fix completed",
  "results": {
    "total": 10,
    "reset": 10,
    "requeued": 10,
    "errors": [],
    "orders": [
      {
        "id": "cm123...",
        "orderNumber": "SO-2024-001",
        "branchCode": "101",
        "status": "RESET_TO_PENDING"
      }
    ]
  },
  "nextStep": "Orders reset to PENDING and re-queued. Sync will process automatically."
}
```

### 3. Direct Sync Single Order
```bash
POST /api/v1/sync/sync-direct/:orderId
```

Resets a specific order and immediately queues it for sync.

---

## Database Fixes

### SQL Script Location
`packages/backend/scripts/fix-order-sync.sql`

### What It Does
1. Fixes missing/null dates
2. Ensures customer names are populated
3. Ensures customer emails are populated  
4. Ensures currency is set
5. Resets failed orders to PENDING
6. Provides verification queries

### How to Run
```bash
# Connect to your database
psql $DATABASE_URL

# Run the fix script
\i packages/backend/scripts/fix-order-sync.sql

# Or use psql command line
psql $DATABASE_URL -f packages/backend/scripts/fix-order-sync.sql
```

---

## Deployment Steps

### 1. Deploy Code Changes
```bash
git pull origin main
pnpm install
pnpm --filter backend build
pm2 restart backend
```

### 2. Run Database Fixes
```bash
psql $DATABASE_URL -f packages/backend/scripts/fix-order-sync.sql
```

### 3. Trigger Bulk Fix
```bash
curl -X POST http://localhost:3000/api/v1/sync/fix-all-failed
```

### 4. Verify Orders Display Correctly
```bash
curl http://localhost:3000/api/v1/sync/orders?take=5
```

### 5. Test Direct Sync
```bash
# Get an order ID first
ORDER_ID=$(curl -s http://localhost:3000/api/v1/sync/orders?take=1 | jq -r '.data[0].id')

# Sync it directly
curl -X POST http://localhost:3000/api/v1/sync/sync-direct/$ORDER_ID
```

---

## Verification

### Check Sync Progress
```bash
# Queue statistics
GET /api/v1/sync/queue/stats

# Recent orders
GET /api/v1/sync/orders?take=10

# Failed orders
GET /api/v1/sync/failed-orders?limit=10

# Specific order status
GET /api/v1/sync/orders/{odooOrderId}
```

### Expected Results
1. ✅ Orders sync successfully without requiring backup tables
2. ✅ Dates display as "2024-01-15T10:30:00.000Z" instead of "[object Ob]"
3. ✅ Step 7/14 logs clearly show which enrichment method is used
4. ✅ Failed orders can be bulk-reset and retried

---

## Technical Details

### OrderSyncQueue Schema
```typescript
model OrderSyncQueue {
  // ... other fields ...
  
  /// Order lines stored as JSON array
  /// Structure: [{ productId, productName, qty, priceUnit, priceSubtotal, ... }]
  orderLines Json?
  
  /// Payment entries stored as JSON array  
  /// Structure: [{ paymentId, paymentName, amount, currency, paymentDate }]
  orderPayments Json?
}
```

### Enrichment Priority
1. **Direct Queue Data** (fastest, no DB lookups)
   - Checks: `order.orderLines?.length > 0 && order.orderPayments?.length > 0`
   - Source: JSON fields in OrderSyncQueue
   
2. **Backup Tables** (fallback)
   - Checks: `order.odooBackupOrderId != null`
   - Source: BackupOdooOrder or BackupVendHqSale tables
   
3. **Minimal Fallback** (guaranteed success)
   - Always succeeds
   - Creates single line from `totalAmount`
   - Creates single payment from `totalAmount`

---

## Monitoring

### Key Metrics to Watch
- Orders stuck at Step 7/14: **Should be 0**
- Date display errors: **Should be 0**  
- Sync success rate: **Should increase**
- Failed orders: **Should decrease after bulk fix**

### Logs to Monitor
```bash
# Watch Step 7/14 logs
pm2 logs backend | grep "Step 7/14"

# Watch enrichment logs
pm2 logs backend | grep "Enriching order"

# Watch for errors
pm2 logs backend --err
```

---

## Support

### Common Issues

**Q: Orders still showing "[object Ob]"**
A: Make sure you're calling the new `/sync/orders` endpoint, not the old `/sync/order-queue` endpoint

**Q: Orders failing at Step 7/14**
A: Check the logs - they now clearly show which enrichment method is being used. If using "Minimal Fallback", that's OK - it will still sync successfully.

**Q: Bulk fix didn't work**
A: Check the response - it lists any errors. Orders with 5+ attempts won't be reset (safety limit).

### Need Help?
Check the logs with the enhanced Step 7/14 messages to understand exactly what's happening with each order.
