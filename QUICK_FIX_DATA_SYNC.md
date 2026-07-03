# Quick Fix Guide - Data Sync Issues

## 🚨 If Nothing Is Working

### 1. Check System Health (Start Here!)
```bash
curl http://localhost:3000/admin/diagnostics/system/health
```

Look for:
- `"status": "unhealthy"` or `"degraded"`
- Services with `"enabled": false`
- High `skippedOrders` count
- Non-zero `failedJobsCount`

### 2. Check Credentials
```bash
curl http://localhost:3000/admin/diagnostics/credentials/status
```

Ensure:
- At least 1 active Fusion credential
- At least 1 active VendHQ credential per region
- Credentials are not expired

### 3. Enable Disabled Services
```bash
# Enable item sync
curl -X POST http://localhost:3000/sync/control/item-sync/enable

# Enable Odoo backup
curl -X POST http://localhost:3000/sync/control/odoo-backup/enable

# Enable VendHQ backup
curl -X POST http://localhost:3000/sync/control/vendhq-backup/enable
```

## 🔍 CSV Import Failing

### Error: "Unknown argument ROW_ID"
**Fix:** Remove `ROW_ID` from your CSV. The system auto-generates IDs.

### Error: "Unknown fields [FIELD1, FIELD2]"
**Fix:** 
1. Export correct format: `curl "http://localhost:3000/admin/{table}/export"`
2. Match your CSV headers to the exported format
3. Re-import

### Get Valid Field Names
```bash
# The error message now shows: "Valid fields: field1, field2, field3"
# Match your CSV headers to those fields
```

## 📊 Oracle Import Skipping Rows

### Check Import Results
```bash
curl -X POST http://localhost:3000/admin/oracle-import | jq '.results'
```

Look for:
- `"skipped": N` where N > 0
- `"errors": [...]` array with specific error messages

### Error Messages Now Show:
- Row number: `"Row 42"`
- Row identifier: `"(ITEM_ID=12345)"`
- Specific error: `"Field 'region' is required but was null"`

### Fix Data in Oracle
Based on error messages, fix the data in your Oracle ODOO_INTEGRATION schema tables, then re-import.

## 📦 Order Sync Skipping Everything

### Check Why Orders Are Skipped
```bash
curl http://localhost:3000/admin/diagnostics/sync/skipped-orders?limit=100
```

### Common Reasons:
1. **"isPaid=false"** - Orders not marked as paid
   - **Fix:** Check if order state is in PAID_ORDER_STATES
   - **Retry:** `curl -X POST http://localhost:3000/sync/orders/retry-skipped`

2. **"isCancelled=true"** - Orders are cancelled
   - **Fix:** Don't sync cancelled orders (this is correct behavior)

3. **"Validation errors"** - Data issues
   - **Fix:** Check `validationErrors` field for details

### Check Specific Order
```bash
curl http://localhost:3000/admin/diagnostics/sync/order-status/{orderId}
```

### Retry Skipped Orders
```bash
# Re-evaluate all skipped orders with isPaid logic
curl -X POST http://localhost:3000/sync/orders/retry-skipped
```

## 🏷️ Item Sync Not Working

### Check Item Sync Status
```bash
curl http://localhost:3000/admin/diagnostics/items/sync-status?region=SA
```

### If Total = 0 (No Items)
1. **Check VendHQ credentials:**
   ```bash
   curl http://localhost:3000/admin/vendhq-credentials
   # Ensure active=true for your region
   ```

2. **Check Fusion credentials:**
   ```bash
   curl http://localhost:3000/admin/fusion-credentials
   # Ensure active=true
   ```

3. **Manually trigger sync:**
   ```bash
   curl -X POST http://localhost:3000/item-sync/trigger/SA
   ```

### If errorCount > 0
Check `recentErrors` in the response for specific error messages.

Common errors:
- **"MarketPrice is null"** - Items skipped due to missing price
- **"VendHQ API error"** - Check VendHQ credentials or API limits
- **"Invalid tax_id"** - Check VendHQ tax configuration

## 🔧 Quick Actions

### Reset and Retry Everything
```bash
# 1. Enable all services
curl -X POST http://localhost:3000/sync/control/item-sync/enable
curl -X POST http://localhost:3000/sync/control/odoo-backup/enable
curl -X POST http://localhost:3000/sync/control/vendhq-backup/enable

# 2. Retry skipped orders
curl -X POST http://localhost:3000/sync/orders/retry-skipped

# 3. Trigger item sync for all regions
curl -X POST http://localhost:3000/item-sync/trigger/SA
curl -X POST http://localhost:3000/item-sync/trigger/UAE
curl -X POST http://localhost:3000/item-sync/trigger/KSA

# 4. Re-import Oracle data
curl -X POST http://localhost:3000/admin/oracle-import

# 5. Check system health
curl http://localhost:3000/admin/diagnostics/system/health
```

### View Recent Logs
```bash
# Backend logs
docker logs <backend-container> --tail 100 -f | grep -E "WARN|ERROR|ItemSyncService|OrderSyncService"

# Look for:
# - "Skipping item" messages
# - "Failed to sync" messages
# - "isPaid=false" messages
# - Prisma validation errors
```

## 📋 Checklist

Before reporting "nothing is working", verify:

- [ ] System health endpoint shows status
- [ ] At least 1 active credential of each type
- [ ] Services are enabled (not disabled in sync control)
- [ ] Orders have isPaid=true (check diagnostics endpoint)
- [ ] CSV files match correct schema (no ROW_ID, correct field names)
- [ ] Oracle data has required fields (no nulls in required columns)
- [ ] VendHQ API is accessible and credentials valid
- [ ] Item sync has been manually triggered at least once
- [ ] Checked error messages from diagnostic endpoints

## 🆘 Still Not Working?

1. **Collect diagnostics:**
   ```bash
   curl http://localhost:3000/admin/diagnostics/system/health > health.json
   curl http://localhost:3000/admin/diagnostics/credentials/status > credentials.json
   curl http://localhost:3000/admin/diagnostics/sync/skipped-orders?limit=100 > skipped.json
   curl http://localhost:3000/admin/diagnostics/items/sync-status > items.json
   ```

2. **Check logs:**
   ```bash
   docker logs <backend-container> --tail 500 > backend.log
   ```

3. **Share:**
   - health.json
   - credentials.json
   - skipped.json
   - items.json  
   - backend.log

The diagnostic outputs will show **exactly** what's wrong.

## 📖 See Also

- [Complete Diagnostic Guide](./DATA_SYNC_DIAGNOSTICS.md) - Detailed explanations
- [Oracle Sync Fix Guide](./ORACLE_SYNC_FIX_GUIDE.md) - Order sync details
- [Item Sync Service](../packages/backend/src/item-sync/) - Item sync code
