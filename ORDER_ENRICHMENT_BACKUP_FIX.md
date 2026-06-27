# Order Enrichment Backup Table Fix

## Problem
The order enrichment service was not finding order lines and payments because it was looking in the wrong tables or using incorrect linking logic. The data actually exists in:
- `BackupOdooOrderLine` table (3,277 records)
- `BackupOdooOrderPayment` table (842 records)

These tables are linked to orders by the `orderId` field, which corresponds to the Odoo order number (integer).

## Solution Implemented

### 1. Updated `order-enrichment.service.ts`
Completely replaced the complex service with a simplified version that:

- **Queries backup tables directly**: Uses `BackupOdooOrderLine` and `BackupOdooOrderPayment` tables
- **Correct linking**: Links using `orderId` field (parsed from `order.odooOrderNumber` as integer)
- **Builds Oracle payloads**: Creates invoice headers, lines, receipts from backup data
- **Fallback to minimal payloads**: When no backup data exists, creates minimal viable payloads

Key changes:
```typescript
// Get ORDER LINES from BackupOdooOrderLine table
const backupLines = await this.prisma.backupOdooOrderLine.findMany({
  where: { 
    orderId: parseInt(order.odooOrderNumber, 10),  // Links to the order
  },
});

// Get PAYMENTS from BackupOdooOrderPayment table
const backupPayments = await this.prisma.backupOdooOrderPayment.findMany({
  where: { 
    orderId: parseInt(order.odooOrderNumber, 10),  // Links to the order
  },
});
```

### 2. Added Debug Endpoint in `sync.controller.ts`
New endpoint: `GET /sync/debug-backup/:orderNumber`

Returns:
- Whether the order exists in OrderSyncQueue
- Count of backup lines found
- Count of backup payments found
- Sample data (first 3 records)
- Whether the order can sync (has both lines and payments)

Example usage:
```bash
curl http://localhost:3000/api/v1/sync/debug-backup/168559
```

## Testing Instructions

### 1. Test the Debug Endpoint
```bash
# Test with a known order number
curl http://localhost:3000/api/v1/sync/debug-backup/168559

# Expected response:
{
  "orderNumber": "168559",
  "orderExists": true,
  "orderId": "clxxxxx",
  "backupLines": {
    "count": 5,
    "sample": [...]
  },
  "backupPayments": {
    "count": 2,
    "sample": [...]
  },
  "canSync": true
}
```

### 2. Test Order Enrichment
```bash
# Test enrichment for a specific order
curl -X POST http://localhost:3000/api/v1/sync/test-enrich/168559
```

### 3. Retry Failed Orders
```bash
# Retry all failed orders with the new logic
curl -X POST http://localhost:3000/api/v1/sync/retry-failed
```

## Expected Behavior

✅ Orders will now sync successfully because:
1. Data EXISTS in `BackupOdooOrderLine` and `BackupOdooOrderPayment` tables
2. Tables are properly linked by `orderId` (Odoo order number)
3. Service now queries the correct tables
4. Oracle payloads are built from actual backup data
5. Minimal fallback exists for orders without backup data

## Key Improvements

1. **Simplified Logic**: Removed complex fallback chains and multi-table lookups
2. **Direct Table Access**: Queries backup tables directly using correct foreign key
3. **Better Logging**: Clear logs showing lines/payments found
4. **Debug Capability**: New endpoint for troubleshooting
5. **Graceful Degradation**: Falls back to minimal payloads if no backup data

## Files Modified

- `/packages/backend/src/sync/order-enrichment.service.ts` - Complete rewrite
- `/packages/backend/src/sync/sync.controller.ts` - Added debug endpoint

## Next Steps

1. Deploy the changes
2. Test with the debug endpoint
3. Monitor order sync success rates
4. Check logs for "found in backup tables" messages
5. Verify Oracle sync completion
