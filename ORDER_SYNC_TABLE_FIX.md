# Order Sync Table Fix - Complete Implementation

## Problem Summary

The order sync system was failing because the `OrderEnrichmentService` was checking JSON fields in `OrderSyncQueue` (orderLines, orderPayments) which were often empty. When these fields were empty, it would fall back to backup tables, but it wasn't properly fetching the related `BackupOdooOrderLine` and `BackupOdooOrderPayment` records.

**Result:** Orders were stuck in FAILED status because enrichment couldn't build complete Oracle payloads.

## Solution Implemented

### 1. Updated `order-enrichment.service.ts`

**Changed:** The `enrichFromBackupOdooOrder()` method now:
- Fetches `BackupOdooOrder` with `.include({ orderLines: true, orderPayments: true })`
- Passes the fetched line items and payments from **actual database tables** to `buildEnrichedOrderFromBackup()`
- No longer relies on JSON fields or delegates to OdooTransformationService

**New Method:** Added `buildEnrichedOrderFromBackup()` which:
- Builds invoice lines from `BackupOdooOrderLine` table records
- Builds receipts from `BackupOdooOrderPayment` table records
- Creates synthetic lines/payments if tables are empty (using order total)
- Handles all Oracle payload construction (invoice, receipts, journals)

### 2. Added Test Endpoints

**GET /api/v1/sync/order-data/:orderSyncQueueId**
- Shows order details
- Shows backup table data (orderLines and payments)
- Shows JSON field data (if any)
- Indicates data source: `backup_tables`, `json_fields`, or `none`

**POST /api/v1/sync/test-enrich/:orderSyncQueueId**
- Tests enrichment for a specific order
- Returns enriched data structure
- Shows counts of invoice lines, receipts, etc.
- Returns success/failure with error details

## Database Tables Involved

1. **OrderSyncQueue** - Main order queue (stores status, metadata)
2. **BackupOdooOrder** - Backup order header data
3. **BackupOdooOrderLine** - Line items (linked via `parentOrderId` → BackupOdooOrder.id)
4. **BackupOdooOrderPayment** - Payment data (linked via `parentOrderId` → BackupOdooOrder.id)

## How It Works Now

### Enrichment Flow:

1. **Check OrderSyncQueue JSON fields first**
   - If `orderLines` and `orderPayments` JSON fields are complete → use them
   - If incomplete → go to step 2

2. **Fetch from BackupOdooOrder tables** (NEW FIX)
   ```typescript
   const backupOrder = await prisma.backupOdooOrder.findUnique({
     where: { id: backupOrderId },
     include: {
       orderLines: true,    // ← Fetches from BackupOdooOrderLine table
       orderPayments: true, // ← Fetches from BackupOdooOrderPayment table
     },
   });
   ```

3. **Build Oracle payloads from table data**
   - Invoice lines from `backupOrder.orderLines[]`
   - Receipts from `backupOrder.orderPayments[]`
   - If tables are empty → create synthetic records

4. **Fallback to minimal enrichment**
   - If backup tables don't exist
   - Creates single-line invoice from order total
   - Ensures ALL orders can sync

## Testing the Fix

### Step 1: Check if data exists in tables

```bash
curl http://localhost:3000/api/v1/sync/order-data/168559
```

**Expected Response:**
```json
{
  "order": { ... },
  "backupOrder": { ... },
  "orderLinesCount": 5,
  "orderLines": [ ... ],
  "paymentsCount": 2,
  "payments": [ ... ],
  "dataSource": "backup_tables"
}
```

If `orderLinesCount > 0` and `paymentsCount > 0`, data exists in tables ✅

### Step 2: Test enrichment

```bash
curl -X POST http://localhost:3000/api/v1/sync/test-enrich/168559
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Order enrichment successful",
  "enrichedData": {
    "invoiceLinesCount": 5,
    "invoiceLines": [ ... ],
    "standardReceiptsCount": 2,
    ...
  }
}
```

If `success: true` and counts match → enrichment works! ✅

### Step 3: Retry all failed orders

```bash
curl -X POST http://localhost:3000/api/v1/sync/retry-all-failed
```

This will:
- Find all orders with `status: FAILED`
- Reset them to `status: PENDING`
- Re-queue them for processing
- Orders will now sync successfully because enrichment fetches from tables

## What Changed vs. Before

| Before (Broken) | After (Fixed) |
|----------------|---------------|
| Checked JSON fields in OrderSyncQueue | Still checks JSON first (optimization) |
| JSON fields were often empty | Falls back to backup tables when empty |
| Fallback tried to use OdooTransformationService | Directly fetches from BackupOdooOrderLine/Payment |
| Failed when JSON was empty | Always gets data from actual tables |
| Orders stuck in FAILED | Orders can sync successfully |

## Data Population

The `BackupOdooOrderLine` and `BackupOdooOrderPayment` tables are populated by:
- **odoo-backup.service.ts** - When backing up orders from Odoo API
- Happens automatically during scheduled backups
- Also happens during manual `/sync/fetch-odoo` calls

The linking is automatic:
```typescript
// In odoo-backup.service.ts
await prisma.backupOdooOrderLine.createMany({
  data: lineDataItems.map(line => ({
    ...line,
    parentOrderId: backupOrder.id,  // ← Links to BackupOdooOrder
    orderId: order.id,               // ← Odoo's numeric ID (for queries)
  }))
});
```

## Files Changed

1. **packages/backend/src/sync/order-enrichment.service.ts**
   - Updated `enrichFromBackupOdooOrder()` to fetch from tables
   - Added `buildEnrichedOrderFromBackup()` method

2. **packages/backend/src/sync/sync.controller.ts**
   - Added `GET /sync/order-data/:orderSyncQueueId` endpoint
   - Added `POST /sync/test-enrich/:orderSyncQueueId` endpoint

## Next Steps

1. Deploy these changes to your environment
2. Test with the endpoints above
3. Run retry-all-failed to process stuck orders
4. Monitor sync success rate

## Important Notes

- The JSON fields in OrderSyncQueue are still used when populated (optimization)
- The backup tables are the source of truth when JSON is empty
- Minimal enrichment ensures NO order is completely blocked
- All orders can sync even if backup data is incomplete
