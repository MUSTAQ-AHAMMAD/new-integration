# Oracle Sync Troubleshooting Guide

## Quick Diagnosis

If orders are not syncing to Oracle, start with these diagnostic endpoints:

### 1. Check Specific Order
```bash
GET /api/v1/sync/orders/{orderId}/diagnose?branchCode={branchCode}
```

This returns:
- Current status in OrderSyncQueue
- Backup data (Odoo/IBQ/VendHQ)
- Store configuration
- **Detailed analysis** with primary issue, reasons, and recommendations
- Whether the order can be retried

**Example Response:**
```json
{
  "orderSyncQueue": {
    "odooOrderId": "162147",
    "status": "SKIPPED",
    "isPaid": false,
    "isCancelled": false,
    "validationErrors": {...}
  },
  "backupOdooOrder": {
    "state": "draft",
    "amountTotal": 500
  },
  "storeConfig": {...},
  "analysis": {
    "primaryIssue": "ORDER_SKIPPED",
    "reasons": [
      "Order is not marked as paid (isPaid=false)",
      "Source order state: 'draft'",
      "Accepted paid states: paid, done, posted, invoiced, sale, invoice"
    ],
    "recommendations": [
      "Check if the order state 'draft' should be considered paid",
      "If the state is valid, the PAID_ORDER_STATES list may need to be expanded",
      "After fixing the mapping, use POST /sync/orders/retry-skipped to re-process this order"
    ],
    "canRetry": true
  }
}
```

### 2. Check System-Wide Stats
```bash
GET /api/v1/sync/diagnostics/summary
```

Returns counts by status to identify patterns:
```json
{
  "totalOrders": 1000,
  "byStatus": {
    "skipped": 500,
    "failed": 50,
    "pending": 10,
    "synced": 440
  },
  "skippedReasons": {
    "unpaid": 480,
    "cancelled": 20
  },
  "syncRate": "44.00%"
}
```

---

## Common Issues & Solutions

### Issue 1: Orders Marked as "Unpaid" (SKIPPED)

**Symptom:** Many orders with status=SKIPPED, diagnostic shows `isPaid: false`

**Root Cause:** Order state from Odoo/IBQ doesn't match accepted paid states.

**Accepted States:**
- `paid` - Payment completed (POS orders)
- `done` - Order fulfilled/completed
- `posted` - Invoice posted to accounting
- `invoiced` - Invoice generated
- `sale` - Sales order confirmed
- `invoice` - Invoice state

**Common Invalid States:**
- `draft` - Draft order (not yet confirmed)
- `confirmed` - Order confirmed but not paid
- `validated` - Validated but not invoiced
- `cancel` / `cancelled` - Cancelled order
- Any uppercase variations if not normalized

**Solution:**

1. **Check actual order state in your Odoo/IBQ system:**
   ```sql
   SELECT state, COUNT(*) 
   FROM "BackupOdooOrder" 
   WHERE state IS NOT NULL 
   GROUP BY state
   ORDER BY COUNT(*) DESC;
   ```

2. **If you find valid states not in the list**, they need to be added to `PAID_ORDER_STATES`:
   - File: `packages/backend/src/common/odoo-utils.ts` (line 76)
   - Add the state to the array
   - Redeploy the backend

3. **Re-process skipped orders:**
   ```bash
   POST /api/v1/sync/orders/retry-skipped
   ```

---

### Issue 2: Missing Branch Code (Silently Skipped)

**Symptom:** Orders not appearing in OrderSyncQueue at all

**Root Cause:** Order has no `branch_id` field in Odoo/IBQ

**Check:**
```sql
SELECT 
  COUNT(*) as total,
  COUNT(branch_id) as with_branch,
  COUNT(*) - COUNT(branch_id) as missing_branch
FROM "BackupOdooOrder";
```

**Solution:**

1. **For Odoo POS:** Ensure every POS session is linked to a branch/location
2. **For IBQ:** Check if `config_id` (POS configuration) can be used instead
3. **Code fix:** In `sync.controller.ts`, the IBQ path already has a fallback:
   ```typescript
   branch_id: order.branch_id ?? order.config_id ?? null
   ```
   Add similar fallback for Odoo if needed

---

### Issue 3: No Backup Data (FAILED)

**Symptom:** Diagnostic shows `primaryIssue: "SYNC_FAILED"`, processor logs show "No backup data found"

**Root Cause:** Order in OrderSyncQueue but no corresponding BackupOdooOrder/BackupIbqOrder

**Check:**
```sql
SELECT 
  osq.odooOrderId,
  osq.odooBackupOrderId,
  bo.id as backup_exists
FROM "OrderSyncQueue" osq
LEFT JOIN "BackupOdooOrder" bo ON bo.id = osq.odooBackupOrderId
WHERE osq.status = 'FAILED'
  AND osq.odooBackupOrderId IS NOT NULL
  AND bo.id IS NULL
LIMIT 10;
```

**Solution:**

1. **Run backup fetch to populate missing data:**
   ```bash
   # For Odoo
   POST /api/v1/sync/fetch-odoo
   {
     "credentialId": "your-cred-id",
     "startDate": "2026-06-01",
     "endDate": "2026-06-30"
   }

   # For IBQ
   POST /api/v1/sync/fetch-ibq
   {
     "credentialId": "your-cred-id",
     "startDate": "2026-06-01",
     "endDate": "2026-06-30"
   }
   ```

2. **Retry failed orders:**
   ```bash
   POST /api/v1/sync/retry-failed
   ```

---

### Issue 4: Store Configuration Missing or Invalid (FAILED)

**Symptom:** Orders fail with "Store configuration error" or "Store invalid"

**Root Cause:** StoreConfiguration not created or missing required fields

**Required Fields:**
- `billToSiteName` - Oracle customer name
- `bankAccountName` - Bank account for receipts
- `cashAccountName` - Cash GL account
- `paymentTermsName` - Oracle payment terms (e.g., "IMMEDIATE")
- `oracleBusinessUnit` - Oracle business unit
- `oracleOperatingUnitId` - Oracle operating unit ID
- `isActive: true` - Must be enabled
- `validationStatus: VALIDATED` - Must pass validation

**Check:**
```sql
SELECT 
  branchCode,
  isActive,
  validationStatus,
  validationErrors,
  billToSiteName IS NOT NULL as has_bill_to,
  bankAccountName IS NOT NULL as has_bank,
  cashAccountName IS NOT NULL as has_cash,
  paymentTermsName IS NOT NULL as has_payment_terms,
  oracleBusinessUnit IS NOT NULL as has_business_unit
FROM "StoreConfiguration"
WHERE branchCode IN (
  SELECT DISTINCT branchCode FROM "OrderSyncQueue" WHERE status = 'FAILED'
);
```

**Solution:**

1. **Create missing store configurations:**
   - Navigate to `/admin/store-configurations` in dashboard
   - Or use API: `POST /api/v1/store-config`

2. **Validate configuration:**
   ```bash
   POST /api/v1/store-config/{branchCode}/validate
   ```

3. **Retry failed orders:**
   ```bash
   POST /api/v1/sync/retry-failed?branchCode={branchCode}
   ```

---

### Issue 5: Oracle Credentials Missing (FAILED)

**Symptom:** Orders fail during Oracle SOAP call, logs show "401 Unauthorized" or "Oracle SOAP connectivity check failed"

**Root Cause:** No Oracle credentials in database or environment

**Check Credentials:**
```sql
SELECT 
  id,
  hostName,
  username,
  active,
  createdAt
FROM "FusionCredential"
WHERE active = true
LIMIT 1;
```

**Solution:**

**Option A: Database Credentials (Recommended)**
1. Create FusionCredential record:
   ```sql
   INSERT INTO "FusionCredential" (
     id, hostName, server, username, password, active
   ) VALUES (
     gen_random_uuid(),
     'your-oracle-cloud.com',
     'PROD',
     'integration_user',
     'encrypted_password',
     true
   );
   ```

**Option B: Environment Variables**
Add to `.env`:
```env
ORACLE_SOAP_BASE_URL=https://your-oracle-cloud.com:443
ORACLE_REST_BASE_URL=https://your-oracle-cloud.com/fscmRestApi/resources/11.13.18.05
ORACLE_USERNAME=integration_user
ORACLE_PASSWORD=your_password
```

2. **Test connectivity:**
   ```bash
   GET /api/v1/admin/oracle/health
   ```

3. **Retry failed orders:**
   ```bash
   POST /api/v1/sync/retry-failed
   ```

---

### Issue 6: Negative Inventory (HELD)

**Symptom:** Orders stuck with status=NEGATIVE_INVENTORY_HOLD

**Root Cause:** Order contains items with negative stock in Oracle

**Check:**
```sql
SELECT 
  odooOrderId,
  odooOrderNumber,
  branchCode,
  negativeInventoryItems,
  createdAt
FROM "OrderSyncQueue"
WHERE status = 'NEGATIVE_INVENTORY_HOLD'
ORDER BY createdAt DESC
LIMIT 20;
```

**Solution:**

1. **Finance team corrects inventory in Oracle:**
   - Adjust stock levels for affected SKUs
   - Or create inventory adjustment transactions

2. **Retry held orders:**
   ```bash
   POST /api/v1/sync/orders/retry-negative-inventory
   # Optional: filter by branch
   POST /api/v1/sync/orders/retry-negative-inventory?branchCode={branchCode}
   ```

---

### Issue 7: Orders Stuck in PENDING

**Symptom:** Many orders with status=PENDING but not processing

**Root Cause:** BullMQ workers not running or queue stalled

**Check Queue Stats:**
```bash
GET /api/v1/sync/queue/stats
```

Expected response:
```json
{
  "active": 10,
  "waiting": 50,
  "completed": 1000,
  "failed": 5,
  "delayed": 0
}
```

**Solution:**

1. **Check backend logs for worker errors:**
   ```bash
   pm2 logs backend | grep "OrderSyncProcessor"
   ```

2. **Restart backend workers:**
   ```bash
   pm2 restart backend
   ```

3. **Check Redis connectivity:**
   ```bash
   redis-cli PING
   ```

4. **Manually trigger job processing** (if queue is stuck):
   ```bash
   # This will mark stalled jobs and re-queue them
   POST /api/v1/sync/jobs/{jobId}/retry
   ```

---

## Diagnostic SQL Queries

### Overall Sync Health
```sql
SELECT 
  status,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
FROM "OrderSyncQueue"
GROUP BY status
ORDER BY count DESC;
```

### Top Branches by Failure Rate
```sql
SELECT 
  branchCode,
  COUNT(*) as total_orders,
  SUM(CASE WHEN status = 'SYNCED' THEN 1 ELSE 0 END) as synced,
  SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
  SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) as skipped,
  ROUND(100.0 * SUM(CASE WHEN status = 'SYNCED' THEN 1 ELSE 0 END) / COUNT(*), 2) as sync_rate
FROM "OrderSyncQueue"
GROUP BY branchCode
HAVING COUNT(*) > 10
ORDER BY sync_rate ASC
LIMIT 10;
```

### Recent Failed Transactions
```sql
SELECT 
  ft.createdAt,
  osq.odooOrderNumber,
  osq.branchCode,
  ft.errorType,
  ft.errorMessage
FROM "FailedTransaction" ft
JOIN "OrderSyncQueue" osq ON ft.orderSyncQueueId = osq.id
WHERE ft.createdAt > NOW() - INTERVAL '24 hours'
ORDER BY ft.createdAt DESC
LIMIT 20;
```

### Orders That Need Retry
```sql
-- Skipped orders that are now paid
SELECT COUNT(*) FROM "OrderSyncQueue"
WHERE status = 'SKIPPED' 
  AND isPaid = true 
  AND isCancelled = false;

-- Failed orders (retryable)
SELECT COUNT(*) FROM "OrderSyncQueue"
WHERE status = 'FAILED'
  AND syncAttempts < 3;

-- Held orders (need manual intervention)
SELECT COUNT(*) FROM "OrderSyncQueue"
WHERE status = 'NEGATIVE_INVENTORY_HOLD';
```

---

## API Endpoints Reference

### Diagnostic Endpoints
- `GET /api/v1/sync/orders/{orderId}/diagnose` - Detailed order diagnosis
- `GET /api/v1/sync/diagnostics/summary` - System-wide statistics

### Retry Endpoints
- `POST /api/v1/sync/orders/retry-skipped` - Retry orders marked as skipped
- `POST /api/v1/sync/orders/retry-failed` - Retry failed orders
- `POST /api/v1/sync/orders/retry-negative-inventory` - Retry held orders

### Manual Sync Endpoints
- `POST /api/v1/sync/fetch-odoo` - Fetch and ingest Odoo orders
- `POST /api/v1/sync/fetch-ibq` - Fetch and ingest IBQ orders

### Queue Management
- `GET /api/v1/sync/queue/stats` - BullMQ queue statistics
- `GET /api/v1/sync/order-queue` - List orders in queue
- `POST /api/v1/sync/order-queue/{id}/retry` - Retry specific order

### Failed Transactions
- `GET /api/v1/sync/failed-transactions` - List failed transactions
- `POST /api/v1/sync/failed-transactions/{id}/resolve` - Mark as resolved

---

## Emergency Procedures

### Complete System Reset (Use with Caution)

If the sync pipeline is completely broken:

1. **Stop all processing:**
   ```bash
   pm2 stop backend
   ```

2. **Clear BullMQ queues:**
   ```bash
   redis-cli
   > KEYS bull:order-sync:*
   > DEL bull:order-sync:active
   > DEL bull:order-sync:waiting
   > DEL bull:order-sync:failed
   ```

3. **Reset order statuses:**
   ```sql
   -- Reset PROCESSING orders back to PENDING (stuck workers)
   UPDATE "OrderSyncQueue"
   SET status = 'PENDING'
   WHERE status = 'PROCESSING'
     AND lastSyncAt < NOW() - INTERVAL '1 hour';
   ```

4. **Restart backend:**
   ```bash
   pm2 restart backend
   ```

5. **Create new sync job:**
   ```bash
   POST /api/v1/sync/jobs
   {
     "jobType": "ORDER_SYNC",
     "scopeType": "DATE_RANGE",
     "startDate": "2026-06-01",
     "endDate": "2026-06-30",
     "createdBy": "MANUAL_RECOVERY"
   }
   ```

---

## Monitoring & Alerts

### Key Metrics to Monitor

1. **Sync Rate:** Should be > 90%
   ```sql
   SELECT 
     ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'SYNCED') / COUNT(*), 2) as sync_rate
   FROM "OrderSyncQueue"
   WHERE createdAt > NOW() - INTERVAL '24 hours';
   ```

2. **Processing Time:** Should be < 5 minutes per order
   ```sql
   SELECT 
     AVG(EXTRACT(EPOCH FROM (lastSyncAt - createdAt))) as avg_processing_seconds,
     MAX(EXTRACT(EPOCH FROM (lastSyncAt - createdAt))) as max_processing_seconds
   FROM "OrderSyncQueue"
   WHERE status = 'SYNCED'
     AND createdAt > NOW() - INTERVAL '24 hours';
   ```

3. **Queue Depth:** Should be < 100
   ```sql
   SELECT COUNT(*) FROM "OrderSyncQueue" WHERE status = 'PENDING';
   ```

4. **Failed Rate:** Should be < 1%
   ```sql
   SELECT 
     ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'FAILED') / COUNT(*), 2) as failed_rate
   FROM "OrderSyncQueue"
   WHERE createdAt > NOW() - INTERVAL '24 hours';
   ```

### Set Up Alerts

Create alerts for:
- Sync rate drops below 90%
- More than 100 orders in PENDING status for > 30 minutes
- Failed rate above 5%
- Any order stuck in PROCESSING for > 1 hour
- Oracle connectivity failures

---

## Support Escalation

If you've tried all the above and orders still won't sync:

1. **Collect diagnostic data:**
   ```bash
   # Order diagnosis
   GET /api/v1/sync/orders/{orderId}/diagnose

   # System summary
   GET /api/v1/sync/diagnostics/summary

   # Failed transactions
   GET /api/v1/sync/failed-transactions?limit=50

   # Backend logs
   pm2 logs backend --lines 500 > backend_logs.txt
   ```

2. **Check Oracle connectivity:**
   ```bash
   GET /api/v1/admin/oracle/health
   ```

3. **Verify all configuration:**
   - Store configurations complete
   - Oracle credentials valid
   - Odoo/IBQ credentials active
   - BullMQ workers running

4. **Contact development team** with:
   - Order ID(s) that won't sync
   - Diagnostic output
   - Backend logs
   - Database query results
   - Steps already attempted
