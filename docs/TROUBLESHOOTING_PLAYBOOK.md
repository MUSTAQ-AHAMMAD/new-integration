# Troubleshooting Playbook

**Version:** 2.0  
**Last Updated:** 2026-07-02  
**Status:** Production Ready

---

## Table of Contents

1. [Common Issues](#common-issues)
2. [Debugging Procedures](#debugging-procedures)
3. [Resolution Steps](#resolution-steps)
4. [Oracle SOAP Errors](#oracle-soap-errors)
5. [VendHQ Sync Issues](#vendhq-sync-issues)
6. [Database Issues](#database-issues)
7. [Performance Issues](#performance-issues)

---

## Common Issues

### Issue 1: "No pending sales to sync"

**Symptom:**  
Pipeline scheduler logs show "No pending sales found for sync" even though orders exist in VendHQ.

**Root Cause:**
- VendHQ backup cron job not running
- VendHQ credentials expired or invalid
- SalesIntegrationStatus disabled for region

**Resolution:**

```bash
# Step 1: Check VendHQ backup job logs
pm2 logs integration-worker --lines 100 | grep "VendHQ"

# Step 2: Verify VendHQ credentials
curl http://localhost:3000/api/v1/admin/vendhq-credentials \
  -H "Authorization: ******"

# Step 3: Check SalesIntegrationStatus
psql -U integration_user -d integration_middleware -c \
  "SELECT * FROM \"SalesIntegrationStatus\" WHERE \"integMode\" = 'BACKUP';"

# Step 4: Manually trigger VendHQ backup
curl -X POST http://localhost:3000/api/v1/vendhq-backup/trigger \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{"region":"AE"}'

# Step 5: Verify sales imported
psql -U integration_user -d integration_middleware -c \
  "SELECT COUNT(*) FROM \"BackupVendHqSale\" WHERE region = 'AE';"
```

---

### Issue 2: "FusionSalesMetadata not found"

**Symptom:**  
Sync fails with error: "FusionSalesMetadata not found for region=AE, customerType=RETAIL"

**Root Cause:**
- FusionSalesMetadata not configured for region/customerType combination

**Resolution:**

```bash
# Step 1: Check existing metadata
curl http://localhost:3000/api/v1/fusion/metadata \
  -H "Authorization: ******"

# Step 2: Create missing metadata
curl -X POST http://localhost:3000/api/v1/fusion/metadata \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "region": "AE",
    "customerType": "RETAIL",
    "billToCustomerName": "Retail Customer - UAE",
    "billToLocation": "DXB-RETAIL-SITE",
    "billToAccountNumber": "CUST-AE-RETAIL",
    "businessUnit": "BU-UAE",
    "transactionSource": "VendHQ POS",
    "transactionType": "PASA CONSULTING SALE"
  }'

# Step 3: Retry failed orders
curl -X POST http://localhost:3000/api/v1/sync/orders/retry-skipped \
  -H "Authorization: ******"
```

---

### Issue 3: "Bank/cash account not configured"

**Symptom:**  
Transformation fails with: "VendHqRegister not found for outletId=outlet-123, registerName=Main Register"

**Root Cause:**
- VendHqRegister not configured with bank/cash account names

**Resolution:**

```bash
# Step 1: Check register configuration
curl http://localhost:3000/api/v1/store-config \
  -H "Authorization: ******"

# Step 2: Auto-populate store configurations
curl -X POST http://localhost:3000/api/v1/store-config/populate/all-branches \
  -H "Authorization: ******"

# Step 3: Update specific register
curl -X PATCH http://localhost:3000/api/v1/store-config/<config-id> \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "bankAccountName": "UAE Bank Account - Main",
    "cashAccountName": "UAE Cash Account"
  }'

# Step 4: Retry failed orders
curl -X POST http://localhost:3000/api/v1/sync/orders/retry-skipped \
  -H "Authorization: ******"
```

---

### Issue 4: Oracle SOAP "Status E" Errors

**Symptom:**  
Oracle SOAP call returns Status E with error message.

**Root Cause:**
- Invalid account number
- Invalid business unit
- Invalid transaction type
- Missing required fields

**Resolution:**

See [Oracle SOAP Errors](#oracle-soap-errors) section below.

---

### Issue 5: High Queue Backlog

**Symptom:**  
BullMQ queue shows thousands of waiting jobs.

**Root Cause:**
- Worker process stopped
- Oracle API rate limiting
- Database performance issues

**Resolution:**

```bash
# Step 1: Check queue status
curl http://localhost:3000/api/v1/queues/status \
  -H "Authorization: ******"

# Step 2: Check worker process
pm2 status | grep worker

# Step 3: Restart worker if stopped
pm2 restart integration-worker

# Step 4: Check worker logs
pm2 logs integration-worker --lines 100

# Step 5: Increase worker concurrency (if needed)
# Edit ecosystem.config.js and increase instances

# Step 6: Clear failed jobs (use with caution)
curl -X POST http://localhost:3000/api/v1/queues/clear-failed \
  -H "Authorization: ******"
```

---

## Debugging Procedures

### Enable Debug Logging

**Method 1: Environment Variable**

```bash
# Edit .env
LOG_LEVEL=debug

# Restart services
pm2 restart all
```

**Method 2: Runtime API**

```bash
# Enable debug logging at runtime
curl -X POST http://localhost:3000/api/v1/settings/log-level \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{"logLevel":"debug"}'
```

### Check Sync Control Status

```bash
# Get sync control settings
curl http://localhost:3000/api/v1/sync-control \
  -H "Authorization: ******"

# Expected response:
# {
#   "isSyncEnabled": true,
#   "minBatchSize": 5,
#   "maxRetries": 3
# }
```

### Inspect BullMQ Queue

```bash
# Get queue stats
curl http://localhost:3000/api/v1/queues/status \
  -H "Authorization: ******"

# Get failed jobs
curl http://localhost:3000/api/v1/queues/failed-jobs \
  -H "Authorization: ******"

# Get job details
curl http://localhost:3000/api/v1/queues/job/<job-id> \
  -H "Authorization: ******"
```

### Query Failed Transactions

```bash
# Get failed transactions
curl http://localhost:3000/api/v1/failed-transactions \
  -H "Authorization: ******"

# Get failed transaction details
curl http://localhost:3000/api/v1/failed-transactions/<transaction-id> \
  -H "Authorization: ******"

# Via database
psql -U integration_user -d integration_middleware -c \
  "SELECT * FROM \"FailedTransaction\" WHERE \"isResolved\" = false LIMIT 10;"
```

### Database Query for Failed Orders

```bash
# Get orders with errors
psql -U integration_user -d integration_middleware -c \
  "SELECT id, \"orderNumber\", \"region\", \"syncError\", \"createdAt\" 
   FROM \"OrderSyncQueue\" 
   WHERE status = 'ERROR' 
   ORDER BY \"createdAt\" DESC 
   LIMIT 20;"

# Get VendHQ sales with sync errors
psql -U integration_user -d integration_middleware -c \
  "SELECT id, \"invoiceNumber\", region, \"fusionSyncError\", \"saleDate\" 
   FROM \"BackupVendHqSale\" 
   WHERE \"fusionSynced\" = false AND \"fusionSyncError\" IS NOT NULL 
   ORDER BY \"saleDate\" DESC 
   LIMIT 20;"
```

---

## Resolution Steps

### Retry Failed Orders

**Single Order:**

```bash
curl -X POST http://localhost:3000/api/v1/sync/orders/<order-id>/retry \
  -H "Authorization: ******"
```

**All Skipped Orders:**

```bash
curl -X POST http://localhost:3000/api/v1/sync/orders/retry-skipped \
  -H "Authorization: ******"
```

**Specific Region:**

```bash
curl -X POST http://localhost:3000/api/v1/sync/orders/retry-region \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{"region":"AE"}'
```

### Re-ingest from Backup

**Odoo Orders:**

```bash
curl -X POST http://localhost:3000/api/v1/odoo-backup/reingest-from-backup \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-06-01",
    "endDate": "2024-06-30",
    "region": "AE"
  }'
```

**VendHQ Sales:**

```bash
curl -X POST http://localhost:3000/api/v1/vendhq-backup/reingest \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-06-01",
    "endDate": "2024-06-30",
    "region": "AE"
  }'
```

### Manual Sync Single Order

**Create Manual Sync Job:**

```bash
curl -X POST http://localhost:3000/api/v1/sync/jobs \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "scopeType": "SINGLE_ORDER",
    "orderIds": ["order-uuid-123"],
    "priority": "HIGH"
  }'
```

**Monitor Job Progress:**

```bash
curl http://localhost:3000/api/v1/sync/jobs/<job-id> \
  -H "Authorization: ******"
```

---

## Oracle SOAP Errors

### Error: "Invalid account number"

**Full Error:**  
`Oracle SOAP Error: Invalid account number - Account CUST-INVALID does not exist`

**Root Cause:**
- billToAccountNumber in FusionSalesMetadata does not exist in Oracle

**Resolution:**

```bash
# Step 1: Verify Oracle customer account
# (Use Oracle Fusion UI or REST API to check valid accounts)

# Step 2: Update FusionSalesMetadata with correct account
curl -X PATCH http://localhost:3000/api/v1/fusion/metadata/<metadata-id> \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "billToAccountNumber": "VALID-ACCOUNT-123"
  }'

# Step 3: Retry failed orders
curl -X POST http://localhost:3000/api/v1/sync/orders/retry-skipped \
  -H "Authorization: ******"
```

### Error: "Business unit not valid"

**Full Error:**  
`Business unit BU-INVALID is not valid for this transaction`

**Root Cause:**
- businessUnit in FusionSalesMetadata does not exist in Oracle

**Resolution:**

```bash
# Step 1: Get valid business units from Oracle
# (Use Oracle Fusion UI or REST API)

# Step 2: Update FusionSalesMetadata
curl -X PATCH http://localhost:3000/api/v1/fusion/metadata/<metadata-id> \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "businessUnit": "VALID-BU-NAME"
  }'
```

### Error: "Transaction type not found"

**Full Error:**  
`Transaction type INVALID-TYPE not found`

**Root Cause:**
- transactionType in FusionSalesMetadata does not exist in Oracle

**Resolution:**

```bash
# Step 1: Get valid transaction types from Oracle
# Common types: "Invoice", "Credit Memo", "Debit Memo"

# Step 2: Update FusionSalesMetadata
curl -X PATCH http://localhost:3000/api/v1/fusion/metadata/<metadata-id> \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "transactionType": "Invoice"
  }'
```

### Error: "Receipt method ID invalid"

**Full Error:**  
`Receipt method ID 9999 is invalid`

**Root Cause:**
- receiptMethodId in FusionReceiptMethod does not exist in Oracle

**Resolution:**

```bash
# Step 1: Get valid receipt methods from Oracle

# Step 2: Update FusionReceiptMethod
curl -X PATCH http://localhost:3000/api/v1/fusion/receipt-methods/<method-id> \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "receiptMethodId": 1001
  }'
```

### Error: "Conversion rate type not recognized"

**Full Error:**  
`Conversion rate type 'Invalid' is not recognized`

**Root Cause:**
- Invalid conversionRateType (should be "Corporate", "User", or "Spot")

**Resolution:**

```bash
# Step 1: Check FusionSalesMetadata configuration
curl http://localhost:3000/api/v1/fusion/metadata \
  -H "Authorization: ******"

# Step 2: Update if needed (default: "Corporate")
# conversionRateType should be one of: Corporate, User, Spot
```

---

## VendHQ Sync Issues

### Issue: VendHQ API Authentication Failure

**Symptom:**  
`VendHQ API returned 401 Unauthorized`

**Resolution:**

```bash
# Step 1: Check VendHQ credentials
curl http://localhost:3000/api/v1/admin/vendhq-credentials \
  -H "Authorization: ******"

# Step 2: Update credentials
curl -X PATCH http://localhost:3000/api/v1/admin/vendhq-credentials/<credential-id> \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "personalToken": "new-valid-token"
  }'
```

### Issue: VendHQ API Rate Limiting

**Symptom:**  
`VendHQ API returned 429 Too Many Requests`

**Resolution:**

```bash
# Step 1: Check rate limit configuration
# VendHQ API limit: 10,000 requests per day

# Step 2: Reduce backup frequency temporarily
# Edit ecosystem.config.js or .env

# Step 3: Wait for rate limit reset (usually 24 hours)

# Step 4: Re-enable backup
curl -X POST http://localhost:3000/api/v1/vendhq-backup/trigger \
  -H "Authorization: ******"
```

---

## Database Issues

### Issue: High Connection Count

**Symptom:**  
`FATAL: sorry, too many clients already`

**Resolution:**

```bash
# Step 1: Check current connections
psql -U integration_user -d integration_middleware -c \
  "SELECT count(*) FROM pg_stat_activity WHERE datname = 'integration_middleware';"

# Step 2: Increase max_connections in postgresql.conf
sudo nano /etc/postgresql/15/main/postgresql.conf
# max_connections = 200

# Step 3: Restart PostgreSQL
sudo systemctl restart postgresql

# Step 4: Restart application
pm2 restart all
```

### Issue: Slow Queries

**Symptom:**  
API requests taking > 5 seconds

**Resolution:**

```bash
# Step 1: Enable query logging
psql -U integration_user -d integration_middleware -c \
  "ALTER DATABASE integration_middleware SET log_min_duration_statement = 1000;"

# Step 2: Check slow queries
sudo tail -f /var/log/postgresql/postgresql-15-main.log

# Step 3: Analyze specific query
psql -U integration_user -d integration_middleware -c \
  "EXPLAIN ANALYZE SELECT * FROM \"OrderSyncQueue\" WHERE status = 'PENDING';"

# Step 4: Add missing indexes (if needed)
# See Phase 4 of Enhancement Plan for index recommendations
```

---

## Performance Issues

### Issue: High Memory Usage

**Symptom:**  
PM2 shows memory usage > 2GB

**Resolution:**

```bash
# Step 1: Check memory usage
pm2 status

# Step 2: Restart specific process
pm2 restart integration-backend

# Step 3: Increase max_memory_restart
# Edit ecosystem.config.js:
# max_memory_restart: '4G'

# Step 4: Reload PM2
pm2 reload ecosystem.config.js
```

### Issue: High CPU Usage

**Symptom:**  
CPU usage consistently > 80%

**Resolution:**

```bash
# Step 1: Check process status
pm2 status

# Step 2: Check for stuck jobs
curl http://localhost:3000/api/v1/queues/status \
  -H "Authorization: ******"

# Step 3: Scale backend instances
# Edit ecosystem.config.js:
# instances: 4

# Step 4: Reload PM2
pm2 reload ecosystem.config.js
```

---

## Emergency Contacts

**Support Team:** integration-support@example.com  
**On-Call Engineer:** +1-XXX-XXX-XXXX  
**Oracle Support:** oracle-support@example.com  
**VendHQ Support:** support@vendhq.com

---

**Playbook Version:** 2.0  
**Last Updated:** 2026-07-02  
**Next Review:** 2026-10-02
