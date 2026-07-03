# Disaster Recovery Procedures

## Overview

This document provides comprehensive disaster recovery procedures for the store configuration and order sync system. It covers backup strategies, rollback procedures, and emergency recovery scenarios.

## Table of Contents

1. [Backup Procedures](#backup-procedures)
2. [Rollback Procedures](#rollback-procedures)
3. [Emergency Recovery Scenarios](#emergency-recovery-scenarios)
4. [Data Integrity Verification](#data-integrity-verification)
5. [Monitoring and Alerts](#monitoring-and-alerts)

---

## 1. Backup Procedures

### Automatic Backups

The system creates automatic backups before any batch operation:

```bash
# Automatic backup created when running:
POST /store-config/batch/populate-accounts
```

Backups include:
- All affected store configurations
- Branch codes
- Account IDs (bank and cash)
- Validation status
- Timestamp and reason

### Manual Backups

Create a manual backup before making critical changes:

```bash
# Create manual backup
POST /store-config/batch/backup
{
  "reason": "pre_maintenance_backup"
}

# Response includes backup ID:
{
  "backupId": "uuid-here",
  "recordCount": 50,
  "timestamp": "2026-07-03T12:00:00Z"
}
```

### Scheduled Backups

Add to crontab for daily backups:

```bash
# Daily backup at 2 AM
0 2 * * * curl -X POST http://localhost:3000/store-config/batch/backup \
  -H "Authorization: ******
  -H "Content-Type: application/json" \
  -d '{"reason":"scheduled_daily_backup"}' \
  >> /var/log/store-config-backup.log 2>&1
```

### Database-Level Backups

PostgreSQL continuous archiving:

```bash
# Full database backup
pg_dump -h localhost -U postgres -d integration_db \
  -F c -f /backups/integration_db_$(date +%Y%m%d_%H%M%S).dump

# Restore from backup
pg_restore -h localhost -U postgres -d integration_db \
  -c /backups/integration_db_20260703_120000.dump
```

---

## 2. Rollback Procedures

### Standard Rollback

Roll back from the most recent backup:

```bash
# 1. List available backups
GET /store-config/batch/backups?limit=10

# 2. Review backup details
# Find the backup ID from Step 1

# 3. Execute rollback
POST /store-config/batch/rollback/{backupId}

# 4. Verify rollback success
GET /store-config/health/check
```

### Emergency Rollback

If automatic rollback fails during a batch operation:

```bash
# System will auto-rollback if autoRollbackOnError=true
# If manual intervention needed:

# 1. Check backup logs
tail -f /var/log/store-config-backup.log

# 2. Identify failed backup ID from error message
# Example: "Backup ID for manual recovery: abc-123-def"

# 3. Manually execute rollback
POST /store-config/batch/rollback/abc-123-def

# 4. If rollback fails, restore from database backup
pg_restore -h localhost -U postgres -d integration_db \
  -c /backups/integration_db_pre_batch_update.dump
```

### Partial Rollback

Roll back specific stores only:

```sql
-- Direct SQL rollback (use with caution)
BEGIN;

-- Get backup data
SELECT "backupData" 
FROM "ConfigurationBackup" 
WHERE id = 'backup-id-here';

-- Manually update specific stores
UPDATE "StoreConfiguration"
SET 
  "bankAccountId" = previous_value,
  "cashAccountId" = previous_value,
  "updatedAt" = NOW()
WHERE "branchCode" IN ('STORE001', 'STORE002');

COMMIT;
```

---

## 3. Emergency Recovery Scenarios

### Scenario 1: Database Corruption

**Symptoms:** Null pointer exceptions, data inconsistency errors

**Recovery Steps:**

```bash
# 1. Stop all services
docker-compose stop backend worker

# 2. Assess damage
psql -h localhost -U postgres -d integration_db << EOF
SELECT COUNT(*) as total,
       COUNT(*) FILTER (WHERE "bankAccountId" IS NULL) as missing_bank,
       COUNT(*) FILTER (WHERE "cashAccountId" IS NULL) as missing_cash
FROM "StoreConfiguration"
WHERE "isActive" = true;
EOF

# 3. Restore from most recent backup
pg_restore -h localhost -U postgres -d integration_db -c \
  /backups/integration_db_latest.dump

# 4. Verify data integrity
GET /store-config/health/check

# 5. Restart services
docker-compose up -d backend worker
```

### Scenario 2: Failed Batch Update

**Symptoms:** 50 alerts, inconsistent account IDs

**Recovery Steps:**

```bash
# 1. Check if auto-rollback occurred
GET /store-config/batch/backups?limit=1

# 2. If rollback failed, execute manual rollback
POST /store-config/batch/rollback/{latest-backup-id}

# 3. Clear failed alerts
UPDATE "AlertLog"
SET "isResolved" = true,
    "resolvedAt" = NOW(),
    "resolvedBy" = 'MANUAL_DR_RECOVERY'
WHERE "alertType" = 'STORE_CONFIG_INVALID'
  AND "isResolved" = false;

# 4. Re-run batch update with dry-run first
POST /store-config/batch/populate-accounts
{
  "dryRun": true,
  "autoRollbackOnError": true
}

# 5. If dry-run successful, run live
POST /store-config/batch/populate-accounts
{
  "dryRun": false,
  "autoRollbackOnError": true
}
```

### Scenario 3: 5000 Failed Transactions

**Symptoms:** Sync queue backed up, transactions failing

**Recovery Steps:**

```bash
# 1. Check failed transaction stats
GET /sync/orders/failed-stats

# 2. Identify root cause
# Check most recent errors
SELECT "errorMessage", COUNT(*) as count
FROM "OrderSyncQueue"
WHERE "syncStatus" IN ('FAILED', 'PARTIAL_SUCCESS')
GROUP BY "errorMessage"
ORDER BY count DESC
LIMIT 10;

# 3. Fix root cause (e.g., store config issue)
POST /store-config/batch/populate-accounts

# 4. Dry-run bulk retry
POST /sync/orders/retry-all-failed
{
  "maxTransactions": 5000,
  "dryRun": true
}

# 5. Execute bulk retry
POST /sync/orders/retry-all-failed
{
  "maxTransactions": 5000,
  "dryRun": false
}

# 6. Monitor progress
watch -n 5 'curl -s http://localhost:3000/sync/orders/failed-stats'
```

### Scenario 4: Service Outage

**Symptoms:** VendHQ/Oracle API down, circuit breaker open

**Recovery Steps:**

```bash
# 1. Check circuit breaker status
GET /health/circuit-breakers

# 2. Verify external services
curl -I https://vendhq-api-endpoint
curl -I https://oracle-api-endpoint

# 3. Wait for circuit breaker auto-recovery (30 seconds)
# Or manually reset (if available)

# 4. Once services restored, retry failed transactions
POST /sync/orders/retry-all-failed
{
  "maxTransactions": 10000
}
```

---

## 4. Data Integrity Verification

### Pre-Deployment Verification

Run before any production deployment:

```bash
# 1. Store configuration integrity
GET /store-config/health/check

# 2. Verify no NULL account IDs
SELECT "branchCode", "bankAccountId", "cashAccountId"
FROM "StoreConfiguration"
WHERE "isActive" = true
  AND ("bankAccountId" IS NULL OR "cashAccountId" IS NULL);

# Expected: 0 rows

# 3. Verify all stores have region
SELECT "branchCode", "region"
FROM "StoreConfiguration"
WHERE "isActive" = true
  AND "region" IS NULL;

# Expected: 0 rows

# 4. Check for orphaned sync jobs
SELECT "syncStatus", COUNT(*)
FROM "OrderSyncQueue"
WHERE "createdAt" < NOW() - INTERVAL '7 days'
  AND "syncStatus" IN ('QUEUED', 'PROCESSING')
GROUP BY "syncStatus";

# Expected: Low counts or 0
```

### Post-Deployment Verification

Run after batch operations:

```bash
# 1. Verify batch operation success
GET /store-config/batch/backups?limit=1

# 2. Check for new alerts
SELECT COUNT(*) 
FROM "AlertLog"
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
  AND "alertType" = 'STORE_CONFIG_INVALID'
  AND "isResolved" = false;

# Expected: 0

# 3. Verify transaction processing
SELECT "syncStatus", COUNT(*)
FROM "OrderSyncQueue"
WHERE "updatedAt" > NOW() - INTERVAL '1 hour'
GROUP BY "syncStatus";

# Expected: High COMPLETED count, low FAILED count

# 4. Check queue health
GET /queues/health
```

---

## 5. Monitoring and Alerts

### Critical Metrics to Monitor

1. **Store Configuration Health**
   - Active stores with NULL account IDs: **MUST be 0**
   - Validation errors: **Target < 5**
   - Recent configuration changes: Monitor for unexpected changes

2. **Transaction Processing**
   - Failed transaction count: **Target < 100**
   - Queue depth: **Target < 1000**
   - Average processing time: **Target < 30s**

3. **System Health**
   - Circuit breaker status: **All CLOSED**
   - API response times: **P95 < 2s**
   - Database connection pool: **Utilization < 80%**

### Alert Configuration

```bash
# Add to alerting system (e.g., Prometheus/Grafana)

# Alert: Store Config Invalid
alert: StoreConfigInvalid
expr: store_config_missing_account_ids > 0
for: 5m
labels:
  severity: critical
annotations:
  summary: "Stores have missing account IDs"

# Alert: High Failed Transaction Count
alert: HighFailedTransactions
expr: failed_transactions_count > 100
for: 10m
labels:
  severity: warning
annotations:
  summary: "High number of failed transactions"

# Alert: Circuit Breaker Open
alert: CircuitBreakerOpen
expr: circuit_breaker_state{state="OPEN"} == 1
for: 2m
labels:
  severity: critical
annotations:
  summary: "Circuit breaker open for {{ $labels.service }}"
```

### Health Check Endpoints

Monitor these endpoints:

```bash
# Overall system health
GET /health

# Store configuration health
GET /store-config/health/check

# Sync queue health
GET /sync/health

# Circuit breaker status
GET /health/circuit-breakers

# Failed transaction stats
GET /sync/orders/failed-stats
```

---

## Emergency Contacts

**On-Call Engineer:** [Contact Info]
**Database Admin:** [Contact Info]
**System Admin:** [Contact Info]

## Recovery Time Objectives (RTO)

- **Store Configuration Rollback:** < 5 minutes
- **Full Database Restore:** < 30 minutes
- **Bulk Transaction Retry:** < 2 hours (for 5000 transactions)
- **Service Recovery:** < 15 minutes

## Recovery Point Objectives (RPO)

- **Configuration Data:** < 1 hour (hourly backups)
- **Transaction Data:** < 5 minutes (continuous replication)
- **Backup Data:** 0 (synchronous writes)

---

## Revision History

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2026-07-03 | 1.0 | Initial disaster recovery procedures | System |

