# Quick Start: Debugging Oracle Status E Errors

This guide will help you quickly diagnose and fix Oracle Status E errors in 5 minutes.

## Step 1: Identify the Problem (30 seconds)

Run the failed orders analysis:

```bash
cd packages/backend
npm run query:failed-orders
```

Look for:
- **High failure rates** for specific branches
- **Common error patterns** (e.g., "Business Unit not found")
- **Recent failures** with Status E

## Step 2: Debug a Specific Order (2 minutes)

Debug the most recent failed order:

```bash
npm run debug:oracle
```

Or debug a specific order:

```bash
npm run debug:oracle -- --orderId=12345 --branch=CCNTRBHR
```

**Look for these issues:**

### ❌ Critical Errors (Must Fix)
- Missing `billToLocation`
- Missing `businessUnit`
- Missing `transactionSource` or `transactionType`
- Invalid `invoiceCurrencyCode`
- No invoice lines

### ⚠️ Warnings (Should Fix)
- Missing `conversionRate`
- Missing `conversionDate`
- Placeholder values in configuration

## Step 3: Check Store Configuration (1 minute)

```sql
SELECT * FROM "StoreConfiguration"
WHERE "branchCode" = 'YOUR_BRANCH_CODE';
```

**Required fields must be set:**
- ✅ `billToSiteName` - Customer name in Oracle
- ✅ `billToLocation` - Customer location
- ✅ `oracleOperatingUnitId` - Valid Oracle OU ID
- ✅ `oracleBusinessUnit` - Valid Oracle BU name
- ✅ `transactionSource` - Valid Oracle transaction source
- ✅ `transactionType` - Valid Oracle transaction type
- ✅ `invoiceCurrencyCode` - Valid currency code (e.g., "AED", "SAR")

## Step 4: Fix the Issue (1 minute)

### Fix Missing Configuration

```sql
UPDATE "StoreConfiguration"
SET 
  "billToLocation" = 'Main Branch',
  "oracleBusinessUnit" = 'AE_BU',  -- Use actual Oracle BU
  "transactionSource" = 'MANUAL',   -- Use actual Oracle source
  "transactionType" = 'Invoice',    -- Use actual Oracle type
  "validationStatus" = 'VALID'
WHERE "branchCode" = 'YOUR_BRANCH_CODE';
```

### Fix Invalid Oracle Values

If Oracle says "Business Unit not found":

1. Check valid business units in Oracle EBS
2. Update configuration with correct value

```sql
UPDATE "StoreConfiguration"
SET "oracleBusinessUnit" = 'CORRECT_BU_NAME'
WHERE "branchCode" = 'YOUR_BRANCH_CODE';
```

## Step 5: Retry the Order (30 seconds)

```bash
curl -X POST http://localhost:3000/sync/orders/retry \
  -H "Content-Type: application/json" \
  -d '{
    "odooOrderId": "12345",
    "branchCode": "YOUR_BRANCH_CODE"
  }'
```

Or retry all failed orders for the branch:

```bash
curl -X POST http://localhost:3000/sync/orders/retry-failed-branch \
  -H "Content-Type: application/json" \
  -d '{"branchCode": "YOUR_BRANCH_CODE"}'
```

## Common Fixes (Copy-Paste Ready)

### Fix 1: Missing billToLocation

```sql
UPDATE "StoreConfiguration"
SET "billToLocation" = 'Main Branch'
WHERE "billToLocation" IS NULL;
```

### Fix 2: Placeholder Business Unit

```sql
UPDATE "StoreConfiguration"
SET "oracleBusinessUnit" = 'AE_BU'  -- Replace with actual BU
WHERE "oracleBusinessUnit" LIKE '%placeholder%';
```

### Fix 3: Reset Failed Orders After Config Fix

```sql
UPDATE "OrderSyncQueue"
SET 
  status = 'PENDING',
  "syncAttempts" = 0,
  "lastErrorMessage" = NULL
WHERE "branchCode" = 'YOUR_BRANCH_CODE'
  AND status = 'FAILED';
```

## Check If It Worked

Run the analysis again:

```bash
npm run query:failed-orders
```

Look for:
- ✅ Decreased failure count
- ✅ Successful sync for the branch
- ✅ No new Status E errors

## Still Failing?

### Check Backend Logs

```bash
pm2 logs backend | grep -A 50 "Status E"
```

Look for the **full SOAP XML response** that shows Oracle's actual error message.

### Try Dry Run

Test without actually calling Oracle:

```bash
npm run debug:oracle -- --dryRun
```

This shows what would be sent to Oracle without making the call.

### Compare with Successful Orders

Find a working branch:

```sql
SELECT * FROM "StoreConfiguration"
WHERE "branchCode" IN (
  SELECT DISTINCT "branchCode" FROM "OrderSyncQueue"
  WHERE status = 'COMPLETED'
  LIMIT 1
);
```

Copy the working configuration values.

## Need More Help?

1. **Detailed README**: `src/scripts/ORACLE_DEBUG_README.md`
2. **SQL Queries**: `src/scripts/debug-queries.sql`
3. **Full Documentation**: `docs/ORACLE_SOAP_STATUS_E_FIX.md`

## Pro Tips

- 🎯 **Most Status E errors** are configuration issues, not code bugs
- 🔍 **Always check store configuration first** before diving into code
- 📊 **Compare with successful orders** to see what's different
- 🔄 **Retry is safe** - it won't create duplicates
- 📝 **Oracle error messages** are in the backend logs, not the database
