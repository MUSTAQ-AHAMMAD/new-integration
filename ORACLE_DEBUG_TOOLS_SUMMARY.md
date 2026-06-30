# Oracle SOAP Debugging Tools - Complete Summary

## 🎉 What's Been Created

A comprehensive suite of debugging tools to diagnose and fix Oracle Status E errors:

### 1. **Debug Script** (`debug-oracle-invoice.ts`)
A powerful diagnostic tool that:
- ✅ Analyzes failed orders with complete context
- ✅ Validates all required Oracle fields
- ✅ Shows exact SOAP payload that would be sent
- ✅ Attempts invoice creation with detailed error reporting
- ✅ Provides actionable recommendations

**Usage:**
```bash
npm run debug:oracle                    # Debug most recent failure
npm run debug:oracle -- --orderId=12345 --branch=CCNTRBHR  # Specific order
npm run debug:oracle -- --dryRun        # Test without calling Oracle
npm run debug:oracle -- --showXml       # Show SOAP XML preview
```

### 2. **Analysis Script** (`query-failed-orders.ts`)
Database analysis tool that shows:
- ✅ Summary statistics (success/failure rates)
- ✅ Failed orders grouped by branch
- ✅ Common error message patterns
- ✅ Recent failures with full details
- ✅ Store configuration issues
- ✅ Invoice audit failures
- ✅ Success vs failure rate by branch

**Usage:**
```bash
npm run query:failed-orders
```

### 3. **SQL Query Collection** (`debug-queries.sql`)
15 ready-to-use SQL queries for:
- ✅ Finding failed orders
- ✅ Analyzing error patterns
- ✅ Checking store configuration
- ✅ Comparing successful vs failed orders
- ✅ Identifying retry candidates
- ✅ Plus helper queries for fixing issues

### 4. **Documentation**
- ✅ **QUICK_START.md** - 5-minute debugging guide
- ✅ **ORACLE_DEBUG_README.md** - Comprehensive usage guide
- ✅ Updated **package.json** with npm scripts

## 🚀 Quick Start (5 Minutes)

### Step 1: Find the Problem
```bash
cd packages/backend
npm run query:failed-orders
```

### Step 2: Debug It
```bash
npm run debug:oracle
```

### Step 3: Fix It
```sql
UPDATE "StoreConfiguration"
SET "billToLocation" = 'Main Branch',
    "oracleBusinessUnit" = 'AE_BU'
WHERE "branchCode" = 'PROBLEM_BRANCH';
```

### Step 4: Retry
```bash
curl -X POST http://localhost:3000/sync/orders/retry \
  -H "Content-Type: application/json" \
  -d '{"odooOrderId":"12345","branchCode":"PROBLEM_BRANCH"}'
```

## 📊 What the Tools Will Tell You

### Field Validation
```
❌ ERRORS (2):
   • billToLocation: Missing or empty
     → Set billToLocation in StoreConfiguration
   • businessUnit: Missing or empty
     → Set oracleBusinessUnit in StoreConfiguration
```

### Configuration Issues
```
⚠️  Business Unit appears to be a placeholder value
⚠️  Store configuration was auto-created and needs manual validation
⚠️  No successful syncs found for this branch
```

### Oracle Response
```
✅ SUCCESS! Invoice created successfully
   Transaction Number: 123456
   
OR

❌ FAILED! Oracle returned an error
   Error Message: Business Unit XYZ_BU not found
```

## 🔍 Common Issues and Fixes

### Issue 1: Missing billToLocation
**Symptom:** `billToLocation: Missing or empty`

**Fix:**
```sql
UPDATE "StoreConfiguration"
SET "billToLocation" = 'Main Branch'
WHERE "branchCode" = 'YOUR_BRANCH';
```

### Issue 2: Invalid Business Unit
**Symptom:** `Error: Business Unit XYZ_BU not found`

**Fix:**
1. Check Oracle for valid business units
2. Update configuration:
```sql
UPDATE "StoreConfiguration"
SET "oracleBusinessUnit" = 'VALID_BU_NAME'
WHERE "branchCode" = 'YOUR_BRANCH';
```

### Issue 3: Placeholder Values
**Symptom:** `Business Unit appears to be a placeholder value`

**Fix:**
```sql
UPDATE "StoreConfiguration"
SET 
  "oracleBusinessUnit" = 'AE_BU',
  "transactionSource" = 'MANUAL',
  "transactionType" = 'Invoice',
  "validationStatus" = 'VALID'
WHERE "oracleBusinessUnit" LIKE '%placeholder%';
```

## 📁 Files Created

```
packages/backend/src/scripts/
├── debug-oracle-invoice.ts      # Main diagnostic script (580 lines)
├── query-failed-orders.ts       # Database analysis tool (280 lines)
├── debug-queries.sql            # SQL query collection (15 queries)
├── ORACLE_DEBUG_README.md       # Comprehensive guide
└── QUICK_START.md               # 5-minute guide

packages/backend/package.json    # Updated with npm scripts
```

## 🎯 Next Steps

### For Immediate Debugging:

1. **Run the query script** to see what's failing:
   ```bash
   npm run query:failed-orders
   ```

2. **Run the debug script** on a specific failed order:
   ```bash
   npm run debug:oracle -- --orderId=12345 --branch=CCNTRBHR
   ```

3. **Check backend logs** for full SOAP XML:
   ```bash
   pm2 logs backend | grep -A 50 "Status E"
   ```

4. **Fix the configuration** based on the validation errors

5. **Retry the order**:
   ```bash
   curl -X POST http://localhost:3000/sync/orders/retry \
     -H "Content-Type: application/json" \
     -d '{"odooOrderId":"12345","branchCode":"CCNTRBHR"}'
   ```

### For Investigation:

1. Open `debug-queries.sql` in your SQL client
2. Run queries 1-5 to understand the problem scope
3. Run queries 6-10 to investigate specific orders
4. Use queries 11-15 for deeper analysis

### For Documentation:

- **Quick help**: Read `QUICK_START.md`
- **Detailed guide**: Read `ORACLE_DEBUG_README.md`
- **SQL reference**: Open `debug-queries.sql`

## 💡 Key Insights

Based on the existing code and memories:

1. **Comprehensive Status E handling already exists** - The codebase has 20+ XML tag checks for error extraction

2. **Most Status E errors are configuration issues** - Missing or invalid values in `StoreConfiguration`

3. **Three main culprits**:
   - Missing `billToLocation`
   - Invalid `oracleBusinessUnit` (not in Oracle EBS)
   - Invalid `transactionSource` or `transactionType` (not in Oracle AR setup)

4. **Validation is already in place** - The `ValidationService` checks fields, but auto-created configs may have placeholder values

5. **Full XML logging is enabled** - When Status E occurs with no error message, the full SOAP XML is logged

## 🔧 How to Use in Production

### Monitor Failures
```bash
# Set up a cron job to check failures daily
0 9 * * * cd /path/to/backend && npm run query:failed-orders > /tmp/oracle-failures-$(date +\%Y\%m\%d).txt
```

### Alert on High Failure Rates
```sql
-- Query to check if failure rate exceeds 10%
SELECT 
  COUNT(CASE WHEN status = 'FAILED' THEN 1 END) * 100.0 / COUNT(*) as failure_rate
FROM "OrderSyncQueue"
WHERE "updatedAt" > NOW() - INTERVAL '1 hour';
```

### Automated Diagnostics
```bash
# Add to your monitoring system
if [[ $(npm run query:failed-orders | grep "Status E" | wc -l) -gt 10 ]]; then
  npm run debug:oracle
  # Send alert
fi
```

## 📚 Related Documentation

- **Original Status E Fix**: `docs/ORACLE_SOAP_STATUS_E_FIX.md`
- **Invoice Fields Guide**: `docs/ORACLE_INVOICE_MISSING_FIELDS_FIX.md`
- **Store Config Guide**: `docs/STORE_CONFIG_POPULATION.md`

## 🙏 Support

If the debugging tools don't resolve your issue:

1. ✅ Run both scripts and save output
2. ✅ Collect backend logs with full SOAP XML
3. ✅ Document the specific Oracle error message
4. ✅ Share the output for further investigation

The tools provide all the diagnostic information needed to identify and fix Oracle Status E errors quickly and effectively.

---

**Created**: 2026-06-30  
**Version**: 1.0  
**Status**: Production Ready ✅
