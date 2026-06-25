# Odoo Backup Data Issue: Missing Order Lines and Payments - RESOLVED

## Problem
Data was being stored in the `BackupOdooOrder` table (967 records) but **NOT** in the `BackupOdooOrderLine` and `BackupOdooOrderPayment` tables.

## Root Cause (CORRECTED)

The issue was in how the code handled the **IBQ Unified API v2 response structure**.

Your Odoo/IBQ API returns:
```json
{
  "results": [
    {
      "order": { 
        "order_id": 125254,
        "name": "JEDNUJOD/2919",
        ...
      },
      "lines": [ 
        { "id": 544467, "product_id": [...], ... }
      ],
      "payments": [
        { "id": 137891, "amount": 0.01, ... }
      ]
    }
  ]
}
```

The `normalizeOrderItems()` method was extracting the `order` object but **discarding** the sibling `lines` and `payments` arrays. The `upsertOrder()` method never received the line items and payments, so they were never stored in the database.

## Solution Implemented

Updated `/packages/backend/src/odoo-backup/odoo-backup.service.ts` in the `normalizeOrderItems()` method to:

1. Detect when the API response uses the IBQ structure with separate `order`, `lines`, and `payments` fields
2. Merge the `lines` array into the normalized order object
3. Map the `payments` array to `statement_ids` (which `upsertOrder` expects)

### Code Changes

```typescript
// IBQ unified API v2: merge sibling `lines` and `payments` arrays into the order.
if (hasIbqStructure) {
  if (Array.isArray(raw['lines'])) {
    normalised['lines'] = raw['lines'];
  }
  if (Array.isArray(raw['payments'])) {
    normalised['statement_ids'] = raw['payments'];
  }
}
```

## What to Do Next

1. **Pull the latest code** with this fix
2. **Re-fetch your orders**:
   ```bash
   POST /odoo-backup/trigger
   ```
   Or:
   ```bash
   POST /sync/fetch-odoo
   ```

3. **Verify the fix** using the diagnostic endpoints:
   ```bash
   GET /odoo-backup/diagnostics/summary
   ```

4. **Check your data**:
   - Go to http://localhost:3000/admin/backup-odoo
   - Switch to the "Order Lines" and "Payments" tabs
   - You should now see data in all three tables

## API Structure Support

The code now handles three different API response patterns:

1. **Standard Odoo REST**: Orders with nested `lines` and `statement_ids`
2. **IBQ Unified API v1**: Wrapped orders with field name aliases
3. **IBQ Unified API v2**: Separate `order`, `lines`, and `payments` fields at the same level (your case)

## Technical Details

### What Was Wrong
The `normalizeOrderItems()` method at line 948-970 was only extracting the inner `order` object and ignoring the sibling arrays.

### What Changed
- Added detection for IBQ structure (`hasIbqStructure`)
- After normalizing field names, merge sibling `lines` and `payments` arrays into the order
- Map `payments` → `statement_ids` for compatibility with `upsertOrder()`

### Diagnostic Tools

Use the new diagnostic endpoints to verify:
- `/odoo-backup/diagnostics/summary` - Shows totals and data quality
- `/odoo-backup/diagnostics/analyze-order/:orderId` - Analyzes specific order structure

These will now show that your orders have proper embedded objects and will be stored correctly.

