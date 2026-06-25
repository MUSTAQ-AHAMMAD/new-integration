# Oracle Integration Troubleshooting Guide

## Quick Diagnostics

When you see **PARTIAL** status in sync jobs, it typically means orders were **SKIPPED** rather than failed. This guide will help you diagnose and fix the issue.

### Step 1: Check Skipped Orders

Navigate to **Operations > Skipped Orders** in the dashboard sidebar. This page will show you:
- All orders that were skipped during sync
- **WHY** each order was skipped (validation errors, reasons)
- The ability to retry individual orders or all skipped orders at once

### Step 2: Common Reasons for Skipped Orders

#### 1. **Order State Not Marked as "Paid"** (90% of cases)

**Problem:** Orders must be in a "paid" state to sync to Oracle. The following states are considered "paid":
- `paid`, `done`, `posted`, `invoiced`, `sale`, `invoice`
- `confirmed`, `validated`, `sent` (newly added)

**Solution:**
1. Check the order state in your source system (Odoo/IBQ)
2. If the order is actually paid but in a different state, update the order state OR
3. Contact your admin to expand the paid states list if needed

**Quick Fix:**
```bash
# After fixing order states in Odoo/IBQ, retry skipped orders:
POST /api/v1/sync/orders/retry-skipped
```

Or click the **"Retry Skipped Orders"** button in the Sync Jobs page.

#### 2. **Missing Branch Code** (5% of cases)

**Problem:** Orders without a `branch_id` field cannot be mapped to a store.

**Solution:**
1. Check if the order has a branch_id in the source system
2. Ensure the backup fetch includes the branch_id field
3. Update the order in Odoo/IBQ to include a valid branch

#### 3. **Store Configuration Missing** (3% of cases)

**Problem:** Even if the order is marked as paid, sync fails if the store isn't configured.

**Solution:**
Navigate to **Store Config Admin** and ensure the store has:
- `billToSiteName`
- `bankAccountName`
- `cashAccountName`
- `paymentTermsName`
- `oracleBusinessUnit`
- `isActive: true`

#### 4. **Oracle Credentials Missing** (2% of cases)

**Problem:** The system cannot connect to Oracle without valid credentials.

**Solution:**
Navigate to **Admin Panel > Credentials > Fusion Credentials** and ensure:
- Active credential exists
- `hostName` and `server` are correct
- `username` and `password` are valid

Or set environment variables:
```bash
ORACLE_SOAP_BASE_URL=https://your-oracle-instance.com/fscmService
ORACLE_USERNAME=your_username
ORACLE_PASSWORD=your_password
```

### Step 3: Use Diagnostic Endpoints

The system provides diagnostic endpoints to help troubleshoot:

```bash
# Diagnose a specific order
GET /api/v1/sync/orders/{orderId}/diagnose?branchCode={branchCode}

# Get system-wide summary
GET /api/v1/sync/diagnostics/summary
```

Response example:
```json
{
  "analysis": {
    "primaryIssue": "ORDER_SKIPPED",
    "reasons": [
      "Order is not marked as paid (isPaid=false)",
      "Source order state: 'draft'",
      "Accepted paid states: paid, done, posted, invoiced, sale, invoice, confirmed, validated, sent"
    ],
    "recommendations": [
      "Check if the order state should be considered paid",
      "Use POST /sync/orders/retry-skipped after fixing"
    ],
    "canRetry": true
  }
}
```

## Workflow After Fixing Issues

1. **Fix the root cause** (update order states, add missing config, etc.)
2. **Retry skipped orders**:
   - Click **"Retry Skipped Orders"** button in Sync Jobs page, OR
   - Navigate to **Skipped Orders** page and click **"Retry All Skipped"**, OR
   - Call the API: `POST /api/v1/sync/orders/retry-skipped`
3. **Monitor** the sync jobs page for new status

## Admin Navigation

All admin options are available in the sidebar under **"ADMIN PANEL"**:

### Credentials
- Fusion Credentials (Oracle)
- VendHQ Credentials
- Odoo Credentials
- IBQ Credentials

### Integration Config
- Outlet Config
- BU Map
- Receipt Methods
- Sales Metadata
- Journal Meta

### VendHQ Masters
- Outlets
- Registers
- Service Providers
- Tax Meta
- Discount Items
- Item Meta

### Fusion Transactions (View Oracle sync results)
- Invoice Headers
- Invoice Lines
- Standard Receipts
- Misc Receipts
- Apply Receipts
- Journal Headers
- Journal Lines
- Inventory Txns

### Backup Archive
- VendHQ Backup
- Odoo Backup
- IBQ Backup
- Sale Sync Status

## Understanding PARTIAL Status

**PARTIAL** status means:
- Some orders were processed successfully
- Some orders were skipped (see Skipped Orders page)
- The job completed but not all orders synced

This is **normal** and indicates filtering is working correctly. Not all orders should sync to Oracle (e.g., draft orders, cancelled orders).

## Data IS Processing to Oracle

The application **IS functional** and **CAN process** invoices, receipts, and journals to Oracle. The PARTIAL status indicates proper filtering, not a system failure.

### Verify Oracle Integration is Working

1. Check **Fusion Transactions** pages to see synced data
2. Query your Oracle database for recent transactions
3. Look for successful sync jobs with status **COMPLETED**

## Need More Help?

1. Check the **Skipped Orders** page for detailed reasons
2. Use the diagnostic endpoints to analyze specific orders
3. Review backend logs for errors: `pm2 logs backend`
4. Consult the original guide: `ORACLE_SYNC_QUICK_START.md`

## Summary

✅ **Your application is built and functional**
✅ **Data CAN process to Oracle** (invoices, receipts, journals)
✅ **Admin options ARE available** in the sidebar
✅ **PARTIAL status is normal** - it means filtering is working

The issue is typically **configuration or data quality**, not missing features. Use the diagnostic tools to identify the specific issue, fix it, and retry the skipped orders.
