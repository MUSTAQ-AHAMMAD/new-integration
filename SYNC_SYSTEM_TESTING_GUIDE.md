# Order Sync System - Complete Testing & Deployment Guide

## 🚀 Quick Start

This guide provides complete testing instructions for the order sync system fixes implemented to resolve critical production issues.

## 📋 Issues Fixed

1. **Odoo Pagination Failure** - Enhanced logging and detection (was only fetching 3.5% of data)
2. **Orders Not Syncing** - Added detailed step-by-step logging throughout the process
3. **SSL Certificate Issues** - Enhanced warnings and security messaging
4. **Missing Monitoring** - Added comprehensive health checks and metrics
5. **Failed Order Management** - Added retry and export functionality

---

## 🧪 Testing Instructions

### 1. Test Oracle Connectivity

```bash
# Check Oracle health
curl -X GET http://localhost:3000/health/check

# Check detailed service health
curl -X GET http://localhost:3000/health/services

# Trigger health check manually
curl -X POST http://localhost:3000/health/check
```

**Expected Response:**
```json
{
  "status": "ok",
  "info": {
    "database": { "status": "up" }
  }
}
```

---

### 2. Test Odoo Pagination Fix

```bash
# Test manual Odoo fetch with pagination logging
curl -X POST http://localhost:3000/sync/fetch-odoo \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": 1167,
    "startDate": "2024-01-01",
    "endDate": "2024-01-31"
  }'
```

**What to Look For in Logs:**
```
[Odoo Pagination] Starting order fetch: branchId=1167, startDate=2024-01-01, endDate=2024-01-31
[Odoo Pagination] Server reports 2866 total records
[Odoo Pagination] Fetched page 1: 100 orders, cumulative: 100/2866
[Odoo Pagination] Fetched page 2: 100 orders, cumulative: 200/2866
...
[Odoo Pagination] ✅ Successfully fetched all 2866/2866 records
```

**If Pagination Breaks (Expected Behavior):**
```
[Odoo Pagination] CRITICAL: page at offset=100 is identical to the previous page!
Offset pagination is not supported by this endpoint.
Fetched 100 of 2866 records (3.5%).
```

---

### 3. Test Single Order Sync

```bash
# Sync a specific order
curl -X POST http://localhost:3000/sync/order-queue/{orderSyncQueueId}/retry

# Check order status
curl -X GET http://localhost:3000/sync/orders/182264
```

**What to Look For in Logs:**
```
[182264] ========================================
[182264] Starting order sync process
[182264]   Branch: 1167
[182264] ========================================
[182264] 📋 Order details:
  - Order Number: SO001234
  - Total Amount: 125.50 AED
  - Is Paid: true
[182264] Step 1/14: Checking payment/cancellation status...
[182264] ✅ Step 1/14: Order is paid and not cancelled
[182264] Step 2/14: Running business-rule validation...
[182264] ✅ Step 2/14: Validation passed
[182264] Step 3/14: Checking store configuration...
[182264] ✅ Step 3/14: Store configuration valid
[182264] Step 4/14: Marking order as PROCESSING...
[182264] ✅ Step 4/14: Status updated to PROCESSING (attempt 1)
[182264] Step 5/14: Resolving payment method...
[182264] ✅ Step 5/14: Payment method resolved
[182264] Step 6/14: Checking idempotency...
[182264] ✅ Step 6/14: Not a duplicate, proceeding with sync
[182264] Step 7/14: Resolving backup source...
[182264] Step 8/14: Pushing Oracle payloads:
  - Invoice Lines: 3
  - Standard Receipts: 1
  - Misc Receipts: 0
  - Apply Receipts: 1
  - Journal Entries: 1
[182264] Step 8a/14: Creating Oracle invoice...
[182264] ✅ Step 8a/14: Oracle invoice created
  - Transaction Number: INV-2024-001234
  - Status: SUCCESS
```

---

### 4. Test Batch Sync

```bash
# Create a sync job for all orders in date range
curl -X POST http://localhost:3000/sync/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "jobType": "ORDER_SYNC",
    "scopeType": "DATE_RANGE",
    "startDate": "2024-01-01",
    "endDate": "2024-01-31",
    "createdBy": "API"
  }'

# Check job status
curl -X GET http://localhost:3000/sync/jobs/{jobId}
```

**Expected Response:**
```json
{
  "id": "clx...",
  "jobType": "ORDER_SYNC",
  "scopeType": "DATE_RANGE",
  "status": "PROCESSING",
  "totalRecords": 2866,
  "processedRecords": 150,
  "successCount": 145,
  "failedCount": 5,
  "skippedCount": 0
}
```

---

### 5. Test System Health & Metrics

```bash
# Get comprehensive sync system status
curl -X GET http://localhost:3000/health/sync-status

# Get system metrics
curl -X GET http://localhost:3000/health/metrics
```

**Expected Response (sync-status):**
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "overallStatus": "HEALTHY",
  "alerts": [],
  "orderQueue": {
    "total": 5000,
    "pending": 50,
    "processing": 10,
    "synced": 4800,
    "failed": 100,
    "skipped": 40
  },
  "performance": {
    "processedLastHour": 200,
    "failedLastHour": 5,
    "failureRatePercent": 2.5,
    "processingRate": "200 orders/hour"
  },
  "failures": {
    "unresolved": 50,
    "today": 10
  }
}
```

**Expected Response (metrics):**
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "orders": {
    "ingestedToday": 500,
    "ingestedThisWeek": 2866,
    "syncedToday": 480,
    "syncedThisWeek": 2750,
    "failedToday": 20,
    "failedThisWeek": 116
  },
  "performance": {
    "averageProcessingTimeMs": 1500,
    "successRateToday": 96.0,
    "successRateWeek": 95.9
  }
}
```

---

### 6. Test Failed Orders Management

```bash
# List failed orders
curl -X GET http://localhost:3000/sync/failed-orders?limit=100

# Export failed orders to CSV
curl -X GET http://localhost:3000/sync/failed-transactions/export-csv > failed_orders.csv

# Retry all failed orders
curl -X POST http://localhost:3000/sync/retry-all-failed

# Retry specific order
curl -X POST http://localhost:3000/sync/order-queue/{id}/retry
```

**Expected Response (failed-orders):**
```json
[
  {
    "id": "clx...",
    "orderNumber": "SO001234",
    "orderId": "182264",
    "branchCode": "1167",
    "totalAmount": "125.50",
    "syncAttempts": 3,
    "errorDetails": {
      "errorType": "NETWORK_ERROR",
      "errorMessage": "Oracle timeout after 30s",
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  }
]
```

---

### 7. Test Dashboard

Open your browser to:
- **Main Dashboard**: http://localhost:3001/realtime-sync
- **Sync Jobs**: http://localhost:3001/sync-jobs
- **Failed Transactions**: http://localhost:3001/failed-transactions

**What to Check:**
- ✅ Real-time order counts update via WebSocket
- ✅ Failed orders table displays with error details
- ✅ Retry button works for individual orders
- ✅ Export CSV button downloads failed orders
- ✅ Search/filter functionality works
- ✅ Charts and graphs display correctly

---

## 🔍 Monitoring & Alerts

### Check for Critical Issues

```bash
# Check if failure rate is > 10% (WARNING)
curl -X GET http://localhost:3000/health/sync-status | jq '.performance.failureRatePercent'

# Check for large backlog (>1000 pending)
curl -X GET http://localhost:3000/health/sync-status | jq '.orderQueue.pending'

# Check unresolved failures
curl -X GET http://localhost:3000/health/sync-status | jq '.failures.unresolved'
```

### Alert Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Failure Rate | > 10% | > 25% | Check logs, investigate errors |
| Pending Queue | > 1000 | > 5000 | Scale workers, check processing |
| Unresolved Failures | > 100 | > 500 | Review and resolve manually |
| Processing Time | > 5s | > 30s | Check Oracle connectivity |

---

## 🐛 Troubleshooting

### Issue: "Only 100 of 2866 records fetched"

**Symptom:**
```
[Odoo Pagination] ⚠️ INCOMPLETE FETCH: got 100 of 2866 expected records (3.5%)
```

**Root Cause:** Odoo API doesn't support offset pagination for this endpoint.

**Solution:**
1. Check logs for exact error message
2. Use date-range slicing to fetch data in smaller batches:
```bash
curl -X POST http://localhost:3000/sync/fetch-odoo \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": 1167,
    "startDate": "2024-01-01",
    "endDate": "2024-01-07"
  }'

# Then fetch next week
curl -X POST http://localhost:3000/sync/fetch-odoo \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": 1167,
    "startDate": "2024-01-08",
    "endDate": "2024-01-14"
  }'
```

---

### Issue: "Orders stuck in PENDING status"

**Check Queue Worker:**
```bash
# Check if worker is running
docker ps | grep backend-worker

# Check worker logs
docker logs backend-worker --tail=100 -f

# Restart worker if needed
docker restart backend-worker
```

**Manual Queue Processing:**
```bash
# Check queue stats
curl -X GET http://localhost:3000/sync/queue/stats

# Retry pending orders
curl -X POST http://localhost:3000/sync/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "jobType": "ORDER_SYNC",
    "scopeType": "ALL"
  }'
```

---

### Issue: "SSL Certificate Verification Failed"

**Check Logs:**
```
⚠️ SECURITY WARNING: OdooCredential region=AE: SSL certificate verification is DISABLED!
```

**Fix:**
1. Update OdooCredential to enable SSL:
```bash
# Via API
curl -X PATCH http://localhost:3000/odoo-backup/credentials/{id} \
  -H "Content-Type: application/json" \
  -d '{"rejectUnauthorizedSsl": true}'

# Via Dashboard
# Go to Admin > Odoo Credentials > Edit > Set "Reject Unauthorized SSL" to true
```

---

### Issue: "Oracle 404 Error"

**Note:** The error mentioned in requirements (`/api/v1/item-sync/trigger/SA`) is for **item sync** (VendHQ items), not order sync.

**For Order Sync:** Oracle SOAP endpoints are already correctly configured (`/fscmRestApi/resources/...`)

**For Item Sync:** Check `ApiEndpointConfig` table for correct endpoints.

---

## 📊 Performance Benchmarks

Expected performance (depends on infrastructure):

| Metric | Target | Good | Poor |
|--------|--------|------|------|
| Orders/hour | 500+ | 200-500 | < 200 |
| Avg Processing Time | < 2s | 2-5s | > 5s |
| Success Rate | > 95% | 90-95% | < 90% |
| API Response Time | < 500ms | 500ms-2s | > 2s |

---

## 🔄 Rollback Procedure

If issues arise after deployment:

### 1. Stop Order Processing
```bash
# Pause all sync jobs
curl -X POST http://localhost:3000/sync/control/pause-all

# Or via database
docker exec -it postgres psql -U user -d dbname -c \
  "UPDATE sync_control SET enabled=false WHERE service_name LIKE 'order%';"
```

### 2. Revert Code Changes
```bash
git revert HEAD~1
git push origin main
```

### 3. Restart Services
```bash
docker-compose restart backend backend-worker
```

### 4. Resume Processing
```bash
# Resume sync jobs
curl -X POST http://localhost:3000/sync/control/resume-all
```

---

## 📞 Support

For issues or questions:
1. Check logs: `docker logs backend --tail=500`
2. Check dashboard: http://localhost:3001/realtime-sync
3. Review this guide
4. Check system health: `curl http://localhost:3000/health/sync-status`

---

## ✅ Post-Deployment Checklist

- [ ] All health checks return "HEALTHY"
- [ ] Dashboard loads without errors
- [ ] Single order sync works with detailed logs
- [ ] Batch sync job completes successfully
- [ ] Failed orders can be retried
- [ ] CSV export works
- [ ] Pagination logging is visible
- [ ] SSL warnings appear when disabled
- [ ] Metrics endpoint returns data
- [ ] No errors in application logs

---

## 🎯 Success Criteria

The deployment is successful when:
- ✅ Odoo pagination issues are **detected and logged** clearly
- ✅ Order sync has **detailed step-by-step logging**
- ✅ SSL warnings are **prominent** (ERROR level)
- ✅ Failed orders can be **retried and exported**
- ✅ Health/metrics endpoints provide **actionable data**
- ✅ Dashboard shows **real-time sync status**
- ✅ System maintains **> 95% success rate**
