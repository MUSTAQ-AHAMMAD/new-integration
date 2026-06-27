# Oracle ERP Cloud Integration - Complete Implementation Guide

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Error Codes and Resolutions](#error-codes-and-resolutions)
4. [API Payload Examples](#api-payload-examples)
5. [Testing Procedures](#testing-procedures)
6. [Rollback Plan](#rollback-plan)
7. [Monitoring and Alerts](#monitoring-and-alerts)
8. [Critical Checklist](#critical-checklist)
9. [Troubleshooting Guide](#troubleshooting-guide)

---

## System Overview

### Components
1. **Order Sync Engine** - Manages order synchronization from Odoo/IBQ to Oracle
2. **Invoice Generator** - Creates AR invoices in Oracle Fusion
3. **Receipt Processor** - Generates standard and miscellaneous receipts
4. **Apply Receipts** - Applies receipts to invoices in Oracle
5. **Journal Creator** - Posts journal entries for service providers
6. **Inventory Updater** - Synchronizes inventory transactions

### New Features
- **Dead-Letter Queue** - Automatically handles orders that exceed max retry attempts
- **Enhanced Retry Logic** - Exponential backoff with error-specific configurations
- **Pre-Flight Validation** - Validates all data before sending to Oracle
- **Error Resolution System** - Comprehensive error codes with guided resolutions
- **Real-Time Health Monitoring** - Oracle REST/SOAP API health checks
- **Real-Time Dashboard** - Live sync status with manual retry capabilities

---

## Architecture

### Data Flow
```
Odoo/IBQ Order → Backup Service → Order Normalization → OrderSyncQueue
                                                              ↓
                                                    Validation Service
                                                              ↓
                                                    Pre-Flight Validation
                                                              ↓
                                                    Oracle Transformation
                                                              ↓
                                                    Oracle SOAP/REST API
                                                              ↓
                                                    Response Processing
                                                              ↓
                                         Success → Mark as SYNCED
                                         Failure → Enhanced Retry Logic
                                                   ↓
                                         Max Retries → Dead-Letter Queue
```

### Queue System
- **ORDER_SYNC** - Main processing queue (concurrency: 10)
- **RETRY** - Retry queue with exponential backoff (concurrency: 5)
- **INVENTORY_SYNC** - Inventory synchronization queue
- **NOTIFICATIONS** - Email/webhook notifications queue

---

## Error Codes and Resolutions

### Connection Errors

#### ORACLE_CONN_001: Oracle Connection Timeout
**Severity:** HIGH | **Retryable:** Yes

**Symptoms:**
- Connection to Oracle times out
- Network unreachable errors
- "ETIMEDOUT" or "ECONNABORTED" errors

**Resolution Steps:**
1. Check Oracle server status:
   ```bash
   curl -I https://your-oracle-instance.com
   ```

2. Verify network connectivity:
   ```bash
   ping your-oracle-instance.com
   telnet your-oracle-instance.com 443
   ```

3. Check firewall rules:
   - Ensure ports 80/443 are open
   - Verify IP whitelist includes your server
   - Check VPN connection if required

4. Increase timeout in `.env`:
   ```
   ORACLE_TIMEOUT=120000  # 120 seconds
   ```

5. Contact Oracle DBA if issue persists

**Prevention:**
- Set timeout ≥ 60 seconds
- Implement connection pooling
- Use circuit breaker pattern
- Monitor Oracle server health

---

#### ORACLE_CONN_002: Oracle Authentication Failed
**Severity:** CRITICAL | **Retryable:** No

**Symptoms:**
- 401 Unauthorized responses
- "Invalid username or password"
- "Authentication failed" errors

**Resolution Steps:**
1. Verify credentials in `.env`:
   ```
   ORACLE_USERNAME=your_username
   ORACLE_PASSWORD=your_password
   ```

2. Test credentials manually:
   ```bash
   curl -u username:password \
     https://your-oracle-instance.com/fscmRestApi/resources/11.13.18.05/items?limit=1
   ```

3. Check Oracle user account:
   - Account not locked
   - Password not expired
   - User has API access permissions

4. Verify required Oracle roles:
   - Receivables Manager
   - AR Receivables Specialist
   - Inventory Manager

5. Contact Oracle administrator to reset credentials

**Prevention:**
- Use AWS Secrets Manager or Azure Key Vault
- Implement credential rotation
- Set up authentication failure alerts
- Document required permissions

---

### Data Validation Errors

#### DATA_VAL_001: Missing Required Field
**Severity:** MEDIUM | **Retryable:** No

**Symptoms:**
- "Required field missing" errors
- NULL values in required fields
- Validation errors from Oracle

**Resolution Steps:**
1. Review error message for field name
2. Check source data (Odoo/IBQ) for completeness
3. Update transformation logic in `fusion-transformation.service.ts`
4. Add default values for optional fields
5. Contact data source admin to fix at origin

**Example Error:**
```json
{
  "error": "Missing required field: billToCustomerNumber",
  "payload": {
    "transactionNumber": "INV-12345",
    "transactionDate": "2024-01-15",
    // billToCustomerNumber missing
  }
}
```

**Prevention:**
- Implement pre-flight validation
- Add comprehensive data quality checks
- Use JSON schema validation
- Test with NULL/empty values

---

#### DATA_VAL_002: Invalid Date Format
**Severity:** MEDIUM | **Retryable:** No

**Symptoms:**
- "Invalid date format" errors
- Date parsing failures
- Timezone conversion errors

**Resolution Steps:**
1. Convert all dates to UTC:
   ```typescript
   const utcDate = new Date(dateString).toISOString();
   ```

2. Use ISO 8601 format: `YYYY-MM-DDTHH:mm:ss.sssZ`

3. Check timezone conversion in `timezone.service.ts`

4. Verify Odoo/IBQ date format and add conversion

**Valid Examples:**
```javascript
// ✓ Correct
"2024-01-15T00:00:00.000Z"
"2024-01-15T14:30:00.000Z"

// ✗ Wrong
"01/15/2024"
"15-01-2024"
"2024-01-15"  // Missing time component
```

**Prevention:**
- Always store dates in UTC
- Use moment.js or date-fns
- Validate format before Oracle API call
- Document expected format

---

#### DATA_VAL_003: Invalid Currency Precision
**Severity:** MEDIUM | **Retryable:** No

**Symptoms:**
- "Invalid decimal precision" errors
- Rounding errors
- Amount validation failures

**Resolution Steps:**
1. Round to correct precision:
   ```typescript
   // AED, USD: 2 decimals
   const amount = Math.round(value * 100) / 100;
   
   // KWD, OMR, BHD: 3 decimals
   const amount = Math.round(value * 1000) / 1000;
   ```

2. Use Decimal.js for precise calculations:
   ```typescript
   import Decimal from 'decimal.js';
   const amount = new Decimal(value).toDecimalPlaces(2);
   ```

3. Verify currency code matches Oracle

**Currency Precision Rules:**
| Currency | Decimals | Example |
|----------|----------|---------|
| AED      | 2        | 123.45  |
| USD      | 2        | 123.45  |
| KWD      | 3        | 123.456 |
| OMR      | 3        | 123.456 |
| BHD      | 3        | 123.456 |

**Prevention:**
- Use Decimal type for currency
- Always round to correct precision
- Validate in pre-flight checks

---

### Mapping Errors

#### MAPPING_001: Payment Method Not Mapped
**Severity:** MEDIUM | **Retryable:** No

**Symptoms:**
- "Payment method not found" errors
- Unable to create receipt
- Missing payment method mapping

**Resolution Steps:**
1. Go to **Admin > Payment Method Mapping**
2. Click **"Add New Mapping"**
3. Fill in required fields:
   - Source System: ODOO/IBQ/VENDHQ
   - Source Payment Name: (exact name from source)
   - Oracle Receipt Method ID: (from Oracle)
   - Oracle Bank Account ID: (optional)
4. Save and retry order

**Finding Oracle Receipt Method ID:**
```bash
# Query Oracle for receipt methods
curl -u username:password \
  "https://instance.com/fscmRestApi/resources/11.13.18.05/receiptMethods"
```

**Prevention:**
- Configure all payment methods during setup
- Enable auto-create for missing methods
- Monitor alerts for unmapped methods
- Review quarterly

---

### Inventory Errors

#### INVENTORY_001: Negative Inventory Detected
**Severity:** MEDIUM | **Retryable:** Yes

**Symptoms:**
- "Insufficient stock" errors
- Negative inventory warnings
- Inventory hold status

**Resolution Steps:**
1. Check Oracle inventory:
   ```sql
   SELECT * FROM INV_QUANTITIES_ONHAND
   WHERE ITEM_NUMBER = 'ITEM123'
   AND ORGANIZATION_CODE = 'ORG01';
   ```

2. Perform inventory adjustment in Oracle

3. Contact inventory manager to reconcile

4. Use **"Retry Negative Inventory Orders"** after correction

5. Enable `allowNegativeInventory` in store config if appropriate

**Prevention:**
- Real-time inventory sync
- Low stock alerts
- Regular inventory audits
- Configure thresholds

---

## API Payload Examples

### 1. Create Invoice (Standard)

**Request:**
```typescript
const invoicePayload = {
  billToCustomerName: "CUSTOMER_001",
  billToLocation: "LOCATION_001",
  billToAccountNumber: "ACC123456",
  businessUnit: "AE_BU_001",
  outletName: "Dubai Main Branch",
  saleDate: new Date("2024-01-15T14:30:00.000Z"),
  paymentTermsName: "Immediate",
  transactionSource: "Manual",
  transactionType: "PASA CONSULTING SALE",
  invoiceCurrencyCode: "AED",
  conversionRateType: "Corporate",
  invoiceLines: [
    {
      lineNumber: 1,
      itemNumber: "ITEM001",
      memoLineName: "DEFAULT",
      description: "Product 1",
      quantity: 2,
      uomCode: "EA",
      unitSellingPrice: 100.00,
      currencyCode: "AED",
      salesOrder: "SO-12345",
      salesOrderLine: "1",
      taxClassificationCode: "VAT_STANDARD"
    },
    {
      lineNumber: 2,
      itemNumber: "ITEM002",
      description: "Product 2",
      quantity: 1,
      uomCode: "EA",
      unitSellingPrice: 50.00,
      currencyCode: "AED",
      salesOrder: "SO-12345",
      salesOrderLine: "2"
    }
  ]
};

const response = await oracleSoapClient.createInvoice(invoicePayload);
```

**Successful Response:**
```json
{
  "serviceStatus": "SUCCESS",
  "transactionNumber": "INV-AE-2024-001234",
  "customerTrxId": "300000123456789"
}
```

**Error Response:**
```json
{
  "serviceStatus": "ERROR",
  "errorCode": "RA-00001",
  "errorMessage": "Invalid customer account number: ACC123456",
  "details": {
    "fieldName": "billToAccountNumber",
    "providedValue": "ACC123456"
  }
}
```

---

### 2. Create Standard Receipt

**Request:**
```typescript
const receiptPayload = {
  currencyCode: "AED",
  saleDate: new Date("2024-01-15T14:30:00.000Z"),
  receiptMethodId: 20001,  // From payment method mapping
  receiptNumber: "RCT-AE-2024-001234",
  remittanceBankAccountId: 30001,
  accountValue: "CUSTOMER_001",
  region: "AE",
  orgId: 101,
  customerId: 300000123456,
  receiptAmount: 250.00
};

const response = await oracleSoapClient.createStandardReceipt(receiptPayload);
```

**Successful Response:**
```json
{
  "receiptNumber": "RCT-AE-2024-001234",
  "customerReceiptReference": "300000789012345"
}
```

---

### 3. Apply Receipt to Invoice

**Request:**
```typescript
const applyPayload = {
  transactionNumber: "INV-AE-2024-001234",
  receiptNumber: "RCT-AE-2024-001234",
  amountApplied: 250.00,
  receiptCurrency: "AED",
  transactionSource: "Manual",
  accountingDate: new Date("2024-01-15"),
  applicationDate: new Date("2024-01-15")
};

const response = await oracleSoapClient.applyReceipt(applyPayload);
```

---

### 4. Create Credit Memo (Refund)

**Request:**
```typescript
const creditMemoPayload = {
  creditMemoNumber: "CM-AE-2024-000123",
  transactionDate: new Date("2024-01-15T14:30:00.000Z"),
  amount: 100.00,
  reason: "Product return - damaged",
  relatedInvoiceNumber: "INV-AE-2024-001234",
  customerAccountNumber: "ACC123456",
  businessUnit: "AE_BU_001",
  currencyCode: "AED",
  lines: [
    {
      lineNumber: 1,
      itemNumber: "ITEM001",
      description: "Refund - Product 1",
      quantity: 1,
      unitPrice: 100.00,
      currencyCode: "AED"
    }
  ]
};

const response = await oracleSoapClient.createCreditMemo(creditMemoPayload);
```

---

## Testing Procedures

### 1. End-to-End Invoice Creation Test

**Test Case:** Create invoice from Odoo order to Oracle

**Prerequisites:**
- Odoo order marked as paid
- Store configuration exists
- Payment method mapped
- Items exist in Oracle inventory

**Steps:**
1. Create test order in Odoo:
   ```bash
   POST /api/v1/odoo-backup/fetch
   {
     "region": "AE",
     "startDate": "2024-01-15",
     "endDate": "2024-01-15",
     "states": ["paid", "done"]
   }
   ```

2. Verify order in OrderSyncQueue:
   ```bash
   GET /api/v1/sync/orders?odooOrderNumber=POS/2024/001234
   ```

3. Trigger manual sync:
   ```bash
   POST /api/v1/sync/orders/{orderId}/retry
   ```

4. Monitor processing:
   ```bash
   GET /api/v1/sync/orders/{orderId}
   ```
   Expected: `status: "PROCESSING"` → `status: "SYNCED"`

5. Verify in Oracle:
   ```sql
   SELECT * FROM RA_CUSTOMER_TRX_ALL
   WHERE TRX_NUMBER = 'INV-AE-2024-001234';
   ```

6. Check audit log:
   ```bash
   GET /api/v1/audit?orderId={odooOrderId}
   ```

**Expected Result:**
- Order status: SYNCED
- Oracle invoice created
- Receipt created and applied
- Audit log entry present

---

### 2. Error Handling Test

**Test Case:** Handle validation errors gracefully

**Steps:**
1. Create order with missing required field
2. Expect validation error in OrderSyncQueue
3. Verify error message is clear and actionable
4. Fix data and retry
5. Verify successful sync

---

### 3. Retry Logic Test

**Test Case:** Automatic retry on transient errors

**Steps:**
1. Simulate Oracle timeout (disconnect network temporarily)
2. Verify order moves to QUEUED_FOR_RETRY
3. Verify exponential backoff (check delay)
4. Restore network
5. Verify order eventually syncs

**Expected Delays:**
- Attempt 1: Immediate
- Attempt 2: ~5 seconds
- Attempt 3: ~10 seconds
- Attempt 4: ~20 seconds
- Attempt 5: ~40 seconds

---

### 4. Dead-Letter Queue Test

**Test Case:** Orders move to dead-letter after max retries

**Steps:**
1. Create order with permanent error (invalid customer)
2. Verify order fails immediately (no retries)
3. Check dead-letter statistics
4. Fix issue (add customer mapping)
5. Manual retry from dead-letter queue
6. Verify successful sync

---

### 5. Health Check Test

**Test Case:** Oracle health monitoring

**Steps:**
1. Check health status:
   ```bash
   GET /api/v1/health/oracle
   ```

2. Verify response includes:
   - REST API status
   - SOAP API status
   - Response times
   - Consecutive failures count

3. Simulate Oracle down:
   - Stop Oracle or block network
   - Wait 5 minutes for health check
   - Verify alert created

4. Restore Oracle:
   - Verify recovery alert

---

## Rollback Plan

### Scenario 1: New Code Deployment Fails

**Symptoms:**
- High error rate after deployment
- Orders stuck in PROCESSING
- Oracle API errors

**Rollback Steps:**
1. Stop all sync workers:
   ```bash
   pm2 stop worker
   ```

2. Rollback code to previous version:
   ```bash
   git checkout previous-stable-tag
   npm install
   npm run build
   ```

3. Restart services:
   ```bash
   pm2 restart all
   ```

4. Monitor error rates:
   ```bash
   GET /api/v1/sync/statistics
   ```

5. If stable, mark failed orders for retry:
   ```bash
   POST /api/v1/sync/orders/bulk-retry
   {
     "status": "FAILED",
     "since": "2024-01-15T10:00:00Z"
   }
   ```

---

### Scenario 2: Oracle Schema Change

**Symptoms:**
- Validation errors for all orders
- "Invalid field" errors
- Schema mismatch

**Rollback Steps:**
1. Pause sync processing
2. Revert Oracle schema changes (contact Oracle DBA)
3. OR update transformation service to match new schema
4. Test with single order
5. Resume sync processing

---

### Scenario 3: Database Migration Failure

**Symptoms:**
- Prisma errors
- Database connection failures
- Missing tables/columns

**Rollback Steps:**
1. Rollback database migration:
   ```bash
   cd packages/backend
   npx prisma migrate resolve --rolled-back <migration-name>
   ```

2. Verify database state:
   ```bash
   npx prisma db pull
   npx prisma validate
   ```

3. Restart services

---

## Monitoring and Alerts

### Key Metrics to Monitor

1. **Sync Success Rate**
   - Target: > 95%
   - Alert if < 90% for 15 minutes

2. **Processing Time**
   - Target: < 30 seconds per order
   - Alert if > 60 seconds average

3. **Queue Length**
   - Target: < 1000 orders pending
   - Alert if > 5000 orders

4. **Failed Orders**
   - Target: < 5% failure rate
   - Alert if > 10% failure rate

5. **Dead-Letter Queue**
   - Target: 0 orders
   - Alert if > 50 orders

6. **Oracle Health**
   - Target: < 3 seconds response time
   - Alert if > 5 consecutive failures

### Alert Configuration

**Prometheus Alerts:**
```yaml
groups:
  - name: oracle_sync
    interval: 30s
    rules:
      - alert: HighFailureRate
        expr: sync_failure_rate > 0.10
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "High sync failure rate: {{ $value }}%"
          
      - alert: OracleDown
        expr: oracle_health_status == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Oracle API is unreachable"
          
      - alert: DeadLetterQueueGrowing
        expr: dead_letter_queue_size > 50
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Dead-letter queue has {{ $value }} orders"
```

---

## Critical Checklist

Before deploying to production, verify each item:

### Configuration
- [ ] `ORACLE_REST_BASE_URL` configured correctly
- [ ] `ORACLE_SOAP_BASE_URL` and `ORACLE_SOAP_WSDL_URL` configured
- [ ] `ORACLE_USERNAME` and `ORACLE_PASSWORD` valid and not expired
- [ ] `DATABASE_URL` points to correct database
- [ ] `REDIS_HOST` and `REDIS_PORT` configured
- [ ] All environment variables set in production

### Oracle Setup
- [ ] Oracle user has required permissions (Receivables Manager, AR Specialist, Inventory Manager)
- [ ] API access enabled for Oracle user
- [ ] Network/firewall rules allow traffic to Oracle
- [ ] SSL certificates valid (if using HTTPS)
- [ ] Oracle timezone set to UTC

### Database
- [ ] Prisma migrations applied: `npx prisma migrate deploy`
- [ ] Database indexes created
- [ ] Connection pool size appropriate (min: 10, max: 50)
- [ ] Database backup configured

### Store Configuration
- [ ] All branches configured in StoreConfiguration table
- [ ] Business Unit mapped for each branch
- [ ] Transaction Source and Type set correctly
- [ ] Bank accounts configured for each branch
- [ ] Tax classification codes set

### Payment Methods
- [ ] All payment methods mapped in PaymentMethodMapping table
- [ ] Oracle Receipt Method IDs verified
- [ ] Bank Account IDs configured
- [ ] Test payments processed successfully

### Data Validation
- [ ] Date formats in UTC ISO 8601
- [ ] Currency precision correct (2 decimals for AED, 3 for KWD)
- [ ] NULL vs empty string handled correctly
- [ ] Primary keys and sequences configured

### Monitoring
- [ ] Prometheus metrics enabled
- [ ] Alert rules configured
- [ ] Dashboard accessible
- [ ] Health checks running every 5 minutes
- [ ] Log aggregation configured

### Testing
- [ ] End-to-end invoice creation tested
- [ ] Receipt creation and application tested
- [ ] Credit memo tested
- [ ] Journal entry tested
- [ ] Error handling tested
- [ ] Retry logic tested
- [ ] Dead-letter queue tested

---

## Troubleshooting Guide

### Problem: Orders Stuck in PENDING

**Possible Causes:**
1. Queue worker not running
2. Redis connection lost
3. Database connection issues

**Diagnosis:**
```bash
# Check worker status
pm2 list

# Check Redis
redis-cli ping

# Check queue stats
GET /api/v1/queues/stats
```

**Solution:**
```bash
# Restart worker
pm2 restart worker

# Flush stuck jobs
redis-cli FLUSHDB  # Use with caution!
```

---

### Problem: All Orders Failing with Same Error

**Possible Causes:**
1. Oracle credentials expired
2. Oracle service down
3. Configuration error

**Diagnosis:**
```bash
# Test Oracle connection
GET /api/v1/health/oracle

# Validate credentials
POST /api/v1/health/oracle/validate-credentials

# Check recent errors
GET /api/v1/audit?status=FAILED&limit=10
```

**Solution:**
1. Update Oracle credentials if expired
2. Wait for Oracle service to recover
3. Fix configuration and redeploy

---

### Problem: Slow Performance

**Possible Causes:**
1. Oracle API slow
2. Database queries slow
3. Queue backed up

**Diagnosis:**
```bash
# Check Oracle response times
GET /api/v1/health/oracle/statistics

# Check database performance
EXPLAIN ANALYZE <slow-query>

# Check queue length
GET /api/v1/queues/stats
```

**Solution:**
1. Increase timeout settings
2. Add database indexes
3. Scale workers horizontally
4. Implement rate limiting

---

## Support Contacts

**For Oracle Issues:**
- Oracle Support Portal: https://support.oracle.com
- Oracle Cloud Status: https://status.cloud.oracle.com

**For System Issues:**
- System Admin: admin@example.com
- Development Team: dev-team@example.com
- On-Call: +1-XXX-XXX-XXXX

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2024-01-15 | System | Initial comprehensive documentation |

---

*This document should be reviewed and updated monthly to reflect system changes.*
