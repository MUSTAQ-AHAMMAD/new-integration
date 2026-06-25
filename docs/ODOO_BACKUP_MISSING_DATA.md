# Odoo Backup Data Issue: Missing Order Lines and Payments

## Problem
Data is being stored in the `BackupOdooOrder` table (967 records) but **NOT** in the `BackupOdooOrderLine` and `BackupOdooOrderPayment` tables.

## Root Cause
The Odoo REST API is returning `line_ids` and `statement_ids`/`payment_ids` as **integer ID arrays** instead of **embedded object arrays**.

When the API returns:
```json
{
  "id": 161815,
  "name": "JUBHUWYLYT/1167",
  "line_ids": [12345, 12346, 12347],  // ❌ PROBLEM: Just IDs
  "statement_ids": [67890, 67891]      // ❌ PROBLEM: Just IDs
}
```

Instead of:
```json
{
  "id": 161815,
  "name": "JUBHUWYLYT/1167",
  "lines": [                           // ✓ CORRECT: Full objects
    {
      "id": 12345,
      "product_id": [100, "Product A"],
      "qty": 2,
      "price_unit": 50.0,
      ...
    },
    ...
  ],
  "statement_ids": [                   // ✓ CORRECT: Full objects
    {
      "id": 67890,
      "name": "Cash",
      "amount": 100.0,
      ...
    },
    ...
  ]
}
```

The backend code (in `odoo-backup.service.ts` lines 1099-1106 and 1175-1182) filters out integer-only entries and logs warnings when this happens:

```typescript
// If only integer IDs are received, lines won't be stored
if (lines.length === 0 && rawLineItems.length > 0) {
  this.logger.warn(
    `Odoo order id=${order.id}: API returned ${rawLineItems.length} line item IDs 
     but no embedded objects — order lines will not be stored.`
  );
}
```

## Diagnostic Steps

### 1. Check Backend Logs
Look for warnings like:
```
Odoo order id=161815 region=unknown: API returned X line item IDs but no embedded objects — order lines will not be stored.
Odoo order id=161815 region=unknown: API returned Y payment IDs but no embedded objects — payments will not be stored.
```

### 2. Use the New Diagnostic Endpoint

I've added a diagnostic controller. After starting your backend, call:

**Check Summary:**
```bash
GET http://localhost:3000/odoo-backup/diagnostics/summary
```

This will show:
- Total counts of orders, lines, and payments
- Diagnosis of the issue
- Sample data analysis
- Suggested solutions

**Analyze a Specific Order:**
```bash
GET http://localhost:3000/odoo-backup/diagnostics/analyze-order/161815
```

This will show:
- What fields are present in the raw JSON (`lines`, `order_line`, `line_ids`, etc.)
- Whether they contain integer IDs or embedded objects
- Actual stored counts

## Solutions

### Option 1: Configure Odoo API Endpoint to Expand Fields

Your Odoo instance needs to be configured to return embedded child records. This depends on your Odoo version and REST API module:

**For Odoo POS REST API (`/api/pos/order`):**
- Check if your endpoint supports a `fields` parameter to expand relations
- Example: `/api/pos/order?fields=lines,statement_ids`
- Some REST API modules support automatic expansion of One2many/Many2many fields

**For Odoo Sale Order REST API (`/api/sale.order`):**
- This endpoint might have different embedding behavior
- Try updating the `apiPath` in your OdooCredential to `/api/sale.order`

### Option 2: Update the OdooCredential API Path

1. Go to: `http://localhost:3000/odoo-backup/credentials`
2. Edit your credential
3. Set `apiPath` to the endpoint that returns embedded data:
   - Try `/api/pos/order` (default for POS)
   - Try `/api/sale.order` (for sale orders)
   - Try `/api/pos/order?expand=lines,statement_ids` (if expansion supported)

### Option 3: Use the Probe Endpoint

Test what your Odoo API actually returns:

```bash
POST http://localhost:3000/odoo-backup/credentials/{credentialId}/probe
```

This makes a test request with `limit=1` and shows you exactly what structure Odoo returns.

### Option 4: Custom Odoo REST API Module

If your Odoo instance uses a custom REST API module, you may need to:
1. Modify the Odoo module to automatically embed child records
2. Configure the module's `read` method to include related fields
3. Or use a different Odoo API endpoint (XML-RPC, JSON-RPC) that supports field expansion

## Checking Your Odoo Version

The field names vary by Odoo version:
- **Odoo v15**: Uses `statement_ids` for payments, `order_line` for lines
- **Odoo v16-17**: May use `lines` for POS, `order_line` for sale orders  
- **Odoo v18**: May use `payment_ids` for payments

The backend code handles all these variations, but **all** require embedded objects, not just IDs.

## Next Steps

1. **Run the diagnostic endpoint** to confirm the issue
2. **Check your backend logs** for the specific warnings
3. **Contact your Odoo administrator** to configure the REST API to return expanded child records
4. **Test with the probe endpoint** after making changes
5. **Re-fetch orders** once configured: `POST /odoo-backup/trigger` or `POST /sync/fetch-odoo`

## Technical Details

The issue is in how Odoo's ORM serializes related records. By default, many REST APIs only return IDs for One2many and Many2many relationships to avoid deep nesting. You need to explicitly configure field expansion.

### Prisma Schema
The three tables:
- `BackupOdooOrder` - Main order header (967 records ✓)
- `BackupOdooOrderLine` - Order line items (0 records ❌)
- `BackupOdooOrderPayment` - Payment entries (0 records ❌)

Relations use `parentOrderId` foreign key linking to `BackupOdooOrder.id`.
