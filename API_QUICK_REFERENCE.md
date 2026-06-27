# Order Sync System - Quick Reference API Guide

## 🚀 New API Endpoints

All endpoints are prefixed with `http://localhost:3000` (adjust for your environment)

---

## Health & Monitoring Endpoints

### 1. Get Sync System Status
```bash
GET /health/sync-status
```

**Description:** Comprehensive real-time status of the order sync system with automatic alerts.

**Response:**
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

**Alert Thresholds:**
- `DEGRADED`: Failure rate > 10% or pending > 1000
- `UNHEALTHY`: Failure rate > 25%

**curl Example:**
```bash
curl -X GET http://localhost:3000/health/sync-status | jq
```

---

### 2. Get System Metrics
```bash
GET /health/metrics
```

**Description:** Daily and weekly counters with success rates.

**Response:**
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

**curl Example:**
```bash
curl -X GET http://localhost:3000/health/metrics | jq
```

---

## Failed Order Management Endpoints

### 3. List Failed Orders
```bash
GET /sync/failed-orders?limit=100
```

**Query Parameters:**
- `limit` (optional): Number of records to return (default: 100)

**Description:** Get detailed information about failed orders including error details.

**Response:**
```json
[
  {
    "id": "clx...",
    "orderNumber": "SO001234",
    "orderId": "182264",
    "branchCode": "1167",
    "branchName": "Dubai Mall Store",
    "region": "AE",
    "totalAmount": "125.50",
    "currency": "AED",
    "syncAttempts": 3,
    "lastAttemptAt": "2024-01-15T10:00:00.000Z",
    "status": "FAILED",
    "errorDetails": {
      "errorType": "NETWORK_ERROR",
      "errorMessage": "Oracle connection timeout after 30s",
      "errorStack": "Error: timeout...",
      "createdAt": "2024-01-15T10:00:00.000Z",
      "retryCount": 3
    }
  }
]
```

**curl Example:**
```bash
curl -X GET "http://localhost:3000/sync/failed-orders?limit=50" | jq
```

---

### 4. Export Failed Transactions to CSV
```bash
GET /sync/failed-transactions/export-csv
```

**Description:** Download all failed transactions as a CSV file (max 5000 records).

**CSV Columns:**
- ID
- Order Number
- Branch Code
- Total Amount
- Currency
- Sync Attempts
- Error Type
- Error Message
- Error Stack
- Created At
- Last Attempt At

**curl Example:**
```bash
curl -X GET http://localhost:3000/sync/failed-transactions/export-csv > failed_orders.csv
```

**PowerShell Example:**
```powershell
Invoke-WebRequest -Uri "http://localhost:3000/sync/failed-transactions/export-csv" -OutFile "failed_orders.csv"
```

---

### 5. Retry All Failed Orders
```bash
POST /sync/retry-all-failed
```

**Description:** Create a sync job to retry all failed orders.

**Response:**
```json
{
  "message": "Retry initiated for 50 failed orders",
  "jobId": "clx...",
  "failedCount": 50
}
```

**curl Example:**
```bash
curl -X POST http://localhost:3000/sync/retry-all-failed | jq
```

---

### 6. Retry Specific Order
```bash
POST /sync/order-queue/{orderSyncQueueId}/retry
```

**Description:** Retry a specific failed order.

**Path Parameters:**
- `orderSyncQueueId`: The ID of the order in OrderSyncQueue table

**Response:**
```json
{
  "message": "Order queued for retry",
  "orderId": "clx..."
}
```

**curl Example:**
```bash
curl -X POST http://localhost:3000/sync/order-queue/clx123/retry | jq
```

---

## Testing Workflow

### 1. Check System Health
```bash
# Get overall health
curl -X GET http://localhost:3000/health/sync-status | jq '.overallStatus'

# Check failure rate
curl -X GET http://localhost:3000/health/sync-status | jq '.performance.failureRatePercent'

# Check pending queue
curl -X GET http://localhost:3000/health/sync-status | jq '.orderQueue.pending'
```

### 2. Monitor Metrics
```bash
# Get today's stats
curl -X GET http://localhost:3000/health/metrics | jq '.orders'

# Check success rate
curl -X GET http://localhost:3000/health/metrics | jq '.performance.successRateToday'
```

### 3. Handle Failed Orders
```bash
# List failed orders
curl -X GET http://localhost:3000/sync/failed-orders?limit=10 | jq '.[].orderNumber'

# Export to CSV
curl -X GET http://localhost:3000/sync/failed-transactions/export-csv > failed.csv

# Retry all failed
curl -X POST http://localhost:3000/sync/retry-all-failed | jq '.jobId'
```

---

## Monitoring Dashboard URLs

- **Real-time Sync**: http://localhost:3001/realtime-sync
- **Sync Jobs**: http://localhost:3001/sync-jobs
- **Failed Transactions**: http://localhost:3001/failed-transactions
- **Skipped Orders**: http://localhost:3001/skipped-orders

---

## Alert Conditions

| Condition | Threshold | Status | Action Required |
|-----------|-----------|--------|-----------------|
| Failure Rate | > 10% | DEGRADED | Investigate errors |
| Failure Rate | > 25% | UNHEALTHY | Immediate action |
| Pending Queue | > 1000 | DEGRADED | Check processing |
| Processing Count | > 100 | INFO | Monitor capacity |
| Unresolved Failures | > 100 | WARNING | Review and resolve |

---

## Common Use Cases

### Daily Health Check
```bash
#!/bin/bash
STATUS=$(curl -s http://localhost:3000/health/sync-status)
OVERALL=$(echo $STATUS | jq -r '.overallStatus')
FAILURE_RATE=$(echo $STATUS | jq -r '.performance.failureRatePercent')
PENDING=$(echo $STATUS | jq -r '.orderQueue.pending')

echo "Overall Status: $OVERALL"
echo "Failure Rate: $FAILURE_RATE%"
echo "Pending Orders: $PENDING"

if [ "$OVERALL" != "HEALTHY" ]; then
  echo "⚠️ System is not healthy!"
  echo $STATUS | jq '.alerts'
fi
```

### Export Weekly Failed Orders
```bash
#!/bin/bash
DATE=$(date +%Y-%m-%d)
curl -X GET http://localhost:3000/sync/failed-transactions/export-csv > "failed_orders_$DATE.csv"
echo "Exported failed orders to failed_orders_$DATE.csv"
```

### Retry Failed Orders (with notification)
```bash
#!/bin/bash
RESULT=$(curl -s -X POST http://localhost:3000/sync/retry-all-failed)
MESSAGE=$(echo $RESULT | jq -r '.message')
JOB_ID=$(echo $RESULT | jq -r '.jobId')

echo "✅ $MESSAGE"
echo "📋 Job ID: $JOB_ID"

# Optional: Send notification
# curl -X POST https://hooks.slack.com/... -d "{\"text\": \"$MESSAGE\"}"
```

---

## Integration Examples

### Prometheus Metrics (Future Enhancement)
```yaml
# Example prometheus.yml
scrape_configs:
  - job_name: 'order-sync'
    metrics_path: '/health/metrics'
    static_configs:
      - targets: ['localhost:3000']
```

### Grafana Dashboard Query Examples
```
# Failure Rate
100 * (order_sync_failed_count / order_sync_total_count)

# Processing Rate
rate(order_sync_processed_total[1h])

# Queue Depth
order_sync_pending_count
```

---

## Troubleshooting

### High Failure Rate
```bash
# Get failed orders
curl http://localhost:3000/sync/failed-orders?limit=10 | jq '.[].errorDetails.errorType' | sort | uniq -c

# Check specific error
curl http://localhost:3000/sync/failed-orders | jq '.[] | select(.errorDetails.errorType == "NETWORK_ERROR")'
```

### Large Backlog
```bash
# Check queue stats
curl http://localhost:3000/health/sync-status | jq '.orderQueue'

# Check processing rate
curl http://localhost:3000/health/sync-status | jq '.performance.processingRate'
```

### System Status
```bash
# Quick health check
curl http://localhost:3000/health/check

# Detailed service health
curl http://localhost:3000/health/services
```

---

## Security Notes

- All endpoints require authentication in production
- Use API keys or JWT tokens
- Enable HTTPS for production deployments
- Rate limit the retry endpoints to prevent abuse
- CSV exports are limited to 5000 records to prevent memory issues

---

## Rate Limits (Recommended)

| Endpoint | Suggested Limit | Window |
|----------|----------------|--------|
| /health/sync-status | 60 requests | 1 minute |
| /health/metrics | 60 requests | 1 minute |
| /sync/failed-orders | 30 requests | 1 minute |
| /sync/retry-all-failed | 5 requests | 5 minutes |
| /sync/failed-transactions/export-csv | 10 requests | 10 minutes |

---

## Additional Resources

- [Complete Testing Guide](./SYNC_SYSTEM_TESTING_GUIDE.md)
- [Technical Summary](./SYNC_SYSTEM_FIXES_SUMMARY.md)
- [Backend README](./packages/backend/README.md)
- [Dashboard README](./packages/dashboard/README.md)
