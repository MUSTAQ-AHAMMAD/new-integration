# Oracle SOAP Debugging Tools

Comprehensive diagnostic tools for troubleshooting Oracle Status E errors and invoice creation failures.

## Quick Start

### 1. Analyze Failed Orders

Get an overview of all failures and identify patterns:

```bash
cd packages/backend
npm run query:failed-orders
```

This will show:
- Summary statistics (success/failure rates)
- Failed orders grouped by branch
- Common error message patterns
- Recent failures with details
- Store configuration issues
- Invoice audit failures

### 2. Debug Specific Order

Diagnose why a specific order failed:

```bash
# Debug the most recent failed order
npm run debug:oracle

# Debug a specific order
npm run debug:oracle -- --orderId=12345 --branch=CCNTRBHR

# Dry run (don't actually call Oracle)
npm run debug:oracle -- --dryRun

# Show full SOAP XML preview
npm run debug:oracle -- --showXml
```

The debug script will:
- ✅ Show complete order details
- ✅ Display store configuration
- ✅ Transform order to Oracle invoice payload
- ✅ Validate all required fields
- ✅ Check for common configuration issues
- ✅ Attempt invoice creation (unless --dryRun)
- ✅ Provide actionable recommendations

## Understanding the Output

### 1. Field Validation

The debug script validates all required Oracle fields:

```
🔍 Field Validation:
─────────────────────────────────────────────────────────────

❌ ERRORS (2):
   • billToLocation: Missing or empty
     → Set billToLocation in StoreConfiguration
   • businessUnit: Missing or empty
     → Set oracleBusinessUnit in StoreConfiguration

⚠️  WARNINGS (1):
   • conversionRate: Not set
     → Should default to 1 for Corporate rate type
```

**Actions:**
- **ERRORS** must be fixed before the order can sync
- **WARNINGS** are optional but recommended

### 2. Common Issues Detection

The script checks for known problems:

```
⚠️  Common Issue Checks:
─────────────────────────────────────────────────────────────
⚠️  Business Unit appears to be a placeholder value
⚠️  Store configuration was auto-created and needs manual validation
⚠️  Order is 120 days old - Oracle may reject old transactions
```

### 3. Oracle API Response

When the script attempts invoice creation:

```
✅ SUCCESS! Invoice created successfully

   Service Status: SUCCESS
   Transaction Number: 123456
   Customer Trx ID: 789012

📊 This means:
   • The SOAP request was valid
   • Oracle accepted all field values
   • The invoice was created in Oracle EBS
```

Or if it fails:

```
❌ FAILED! Oracle returned an error

   Error Message: Oracle invoice creation failed with Status E: 
   Business Unit US_BU not found

📊 Error Analysis:
   • Oracle rejected the invoice with Status E
   • Check the error message above for specific details
   • The full SOAP XML response should be in backend logs
```

## Common Problems and Solutions

### Problem 1: Missing Required Fields

**Symptoms:**
```
❌ billToLocation: Missing or empty
```

**Solution:**
```sql
UPDATE "StoreConfiguration"
SET "billToLocation" = 'Main Branch'
WHERE "branchCode" = 'CCNTRBHR';
```

### Problem 2: Invalid Business Unit

**Symptoms:**
```
Error: Business Unit XYZ_BU not found
```

**Solution:**
1. Check valid business units in Oracle:
   ```sql
   SELECT business_unit_name 
   FROM hr_business_units 
   WHERE status = 'A';
   ```

2. Update store configuration:
   ```sql
   UPDATE "StoreConfiguration"
   SET "oracleBusinessUnit" = 'VALID_BU_NAME'
   WHERE "branchCode" = 'CCNTRBHR';
   ```

### Problem 3: Invalid Transaction Source/Type

**Symptoms:**
```
Error: Transaction Source MANUAL not found
```

**Solution:**
1. Check valid transaction sources in Oracle:
   ```sql
   SELECT name 
   FROM ra_batch_sources_all 
   WHERE status = 'A';
   ```

2. Update store configuration:
   ```sql
   UPDATE "StoreConfiguration"
   SET "transactionSource" = 'VALID_SOURCE',
       "transactionType" = 'VALID_TYPE'
   WHERE "branchCode" = 'CCNTRBHR';
   ```

### Problem 4: Auto-Created Store Config

**Symptoms:**
```
⚠️  Store configuration was auto-created and needs manual validation
```

**Solution:**
1. Review the auto-created configuration:
   ```sql
   SELECT * FROM "StoreConfiguration"
   WHERE "branchCode" = 'CCNTRBHR';
   ```

2. Update placeholder values with real Oracle values

3. Mark as validated:
   ```sql
   UPDATE "StoreConfiguration"
   SET "validationStatus" = 'VALID'
   WHERE "branchCode" = 'CCNTRBHR';
   ```

## Analyzing Backend Logs

### View Recent Logs

```bash
pm2 logs backend --lines 100
```

### Search for Status E Errors

```bash
pm2 logs backend | grep -A 50 "Status E"
```

### Search for Full XML Responses

```bash
pm2 logs backend | grep -A 100 "FULL Response XML"
```

### Search for Specific Order

```bash
pm2 logs backend | grep "12345"
```

## Database Queries for Analysis

### Find All Failed Orders

```sql
SELECT 
  "odooOrderId",
  "odooOrderNumber",
  "branchCode",
  "region",
  "status",
  "syncAttempts",
  "lastErrorMessage",
  "updatedAt"
FROM "OrderSyncQueue"
WHERE status = 'FAILED'
  AND "lastErrorMessage" LIKE '%Status E%'
ORDER BY "updatedAt" DESC
LIMIT 20;
```

### Check Store Configuration

```sql
SELECT 
  "branchCode",
  "billToSiteName",
  "billToLocation",
  "oracleBusinessUnit",
  "transactionSource",
  "transactionType",
  "invoiceCurrencyCode",
  "isActive",
  "validationStatus",
  "validationErrors"
FROM "StoreConfiguration"
WHERE "branchCode" IN (
  SELECT DISTINCT "branchCode" 
  FROM "OrderSyncQueue" 
  WHERE status = 'FAILED'
);
```

### Find Similar Successful Orders

```sql
SELECT 
  o."odooOrderId",
  o."branchCode",
  o."status",
  i."txnNumber",
  i."businessUnit",
  i."txnSource",
  i."txnType"
FROM "OrderSyncQueue" o
LEFT JOIN "FusionInvoiceHeader" i ON o."odooOrderId" = CAST(i."txnNumber" AS TEXT)
WHERE o."branchCode" = 'CCNTRBHR'
  AND o.status = 'COMPLETED'
ORDER BY o."completedAt" DESC
LIMIT 5;
```

### Audit Failed Invoices

```sql
SELECT 
  "id",
  "status",
  "billToCustName",
  "businessUnit",
  "txnSource",
  "txnType",
  "txnNumber",
  "customerTxnId",
  "region",
  "requestDate"
FROM "FusionInvoiceHeader"
WHERE status = 'E'
ORDER BY "requestDate" DESC
LIMIT 20;
```

## Retry Failed Orders

After fixing the configuration:

### Retry Single Order

```bash
curl -X POST http://localhost:3000/sync/orders/retry \
  -H "Content-Type: application/json" \
  -d '{
    "odooOrderId": "12345",
    "branchCode": "CCNTRBHR"
  }'
```

### Retry All Failed Orders for a Branch

```bash
curl -X POST http://localhost:3000/sync/orders/retry-failed-branch \
  -H "Content-Type: application/json" \
  -d '{
    "branchCode": "CCNTRBHR"
  }'
```

### Retry All Skipped Orders

```bash
curl -X POST http://localhost:3000/sync/orders/retry-skipped
```

## Advanced Debugging

### Enable Debug Logging

In `packages/backend/.env`:

```bash
LOG_LEVEL=debug
```

Then restart the backend:

```bash
pm2 restart backend
```

### Test Oracle Connection

```typescript
// Use the debug script to test connectivity
npm run debug:oracle -- --dryRun

// Check logs for connection errors:
// - ECONNREFUSED: Oracle endpoint not reachable
// - 401 Unauthorized: Invalid credentials
// - Timeout: Oracle is slow or network issues
```

### Compare Working vs Failed Orders

1. Find a working order:
   ```bash
   npm run debug:oracle -- --orderId=99999 --branch=CCNTRBHR
   ```

2. Find a failed order:
   ```bash
   npm run debug:oracle -- --orderId=12345 --branch=CCNTRBHR
   ```

3. Compare the invoice headers field by field

## Escalation Checklist

If the debugging tools don't resolve the issue:

1. ✅ Run `npm run query:failed-orders` and save output
2. ✅ Run `npm run debug:oracle` and save output
3. ✅ Collect backend logs with full SOAP XML
4. ✅ Document the specific error message from Oracle
5. ✅ Verify similar orders succeed in Oracle EBS directly
6. ✅ Check Oracle EBS AR setup documentation
7. ✅ Open support ticket with Oracle (include transaction number)

## Files Created

- `src/scripts/debug-oracle-invoice.ts` - Main diagnostic script
- `src/scripts/query-failed-orders.ts` - Database analysis tool
- `package.json` - Updated with new npm scripts

## Related Documentation

- [Oracle SOAP Status E Fix](../docs/ORACLE_SOAP_STATUS_E_FIX.md)
- [Oracle Invoice Missing Fields Fix](../docs/ORACLE_INVOICE_MISSING_FIELDS_FIX.md)
- [Store Configuration Population](../docs/STORE_CONFIG_POPULATION.md)
