# Store Configuration: Bank/Cash Account ID Fix

## Summary

This fix resolves the critical issue where **50+ store configurations** had NULL `bankAccountId` and `cashAccountId` values, causing **100% receipt creation failure** and complete integration breakdown.

## The Solution

A comprehensive 3-part fix:

1. **Populate existing stores** - Service method + script to fix all existing NULL values
2. **Auto-populate new stores** - Updated logic to prevent future NULLs
3. **Validate & monitor** - Enhanced validation and health checks

## Quick Start

### Fix All Stores Now

```bash
# Via API (recommended in production)
curl -X POST http://localhost:3000/store-config/populate/bank-cash-accounts

# Via script (recommended in development)
cd packages/backend
pnpm populate:bank-cash-accounts:dev
```

### Verify Success

```bash
curl http://localhost:3000/store-config/health/check | jq '.summary.missingBothAccountIds'
```

Expected result: `0`

## What Was Changed

### Backend Service (`store-config.service.ts`)

- **New method**: `populateBankCashAccountIds()` - Populates all stores from VendHqRegister
- **Updated**: `createDefaultConfig()` - Auto-populates on store creation
- **Updated**: `populateAllBranches()` - Includes account IDs in batch creation
- **Enhanced**: `validateConfig()` - Checks for NULL account IDs

### API Endpoints (`store-config.controller.ts`)

- **New**: `POST /store-config/populate/bank-cash-accounts` - Fix all stores
- **Enhanced**: `GET /store-config/health/check` - Shows account ID status

### Scripts

- **New**: `packages/backend/src/scripts/populate-bank-cash-accounts.ts`
- **Added**: `pnpm populate:bank-cash-accounts:dev` command

### Documentation

- **Complete guide**: `docs/BANK_CASH_ACCOUNT_FIX.md` (12KB)
- **Quick reference**: `docs/BANK_CASH_ACCOUNT_FIX_QUICK.md` (3KB)
- **This readme**: `docs/BANK_CASH_ACCOUNT_FIX_README.md`

## How It Works

### Data Source: VendHqRegister

The fix uses `VendHqRegister` table as the source of truth:

```sql
SELECT DISTINCT ON (region)
  region,
  "bankAccountId",
  "cashAccountId"
FROM "VendHqRegister"
WHERE "bankAccountId" IS NOT NULL
  AND "cashAccountId" IS NOT NULL
  AND "deletedAt" IS NULL
ORDER BY region, "createdAt" DESC
```

This gets one register per region with valid account IDs.

### Population Logic

For each `StoreConfiguration` with NULL account IDs:
1. Look up the store's `region` field
2. Find matching account IDs from `VendHqRegister` for that region
3. Update `bankAccountId` and `cashAccountId`
4. Set `validationStatus` to `PENDING` for re-validation

## Testing

### 1. Check Current Status

```bash
curl http://localhost:3000/store-config/health/check
```

Look at:
- `missingBankAccountId` - Should be 0
- `missingCashAccountId` - Should be 0
- `configsInvalid` - Should be 0 or low

### 2. Test Population

```bash
# Run population
curl -X POST http://localhost:3000/store-config/populate/bank-cash-accounts

# Check results
{
  "totalStores": 52,
  "updated": 50,
  "skipped": 2,
  "errors": []
}
```

### 3. Validate Individual Store

```bash
curl -X POST http://localhost:3000/store-config/304/validate

# Expected
{
  "isValid": true,
  "errors": [],
  "warnings": []
}
```

### 4. Test Receipt Creation

Run a sync job and check logs:
- ✅ No "standard receipt skipped" warnings
- ✅ Receipts created successfully
- ✅ No NULL account ID errors

## Impact

### Before Fix
- ❌ 50+ stores with NULL account IDs
- ❌ 0% receipt creation success
- ❌ Integration non-functional
- ❌ Manual configuration required for every store

### After Fix
- ✅ All stores have account IDs (or clear error)
- ✅ 100% receipt creation attempt rate
- ✅ Integration fully functional
- ✅ Auto-population for new stores
- ✅ Clear validation and monitoring

## Maintenance

### For Operations

**Weekly check**:
```bash
curl http://localhost:3000/store-config/health/check
```

**If new stores created**:
- Check health endpoint
- Run population if needed
- Validate stores

### For Developers

**Creating new stores**:
- Use `POST /store-config/populate/all-branches`
- Account IDs populate automatically if VendHqRegister data exists

**Adding new regions**:
1. Add VendHqRegister records for the region first
2. Then create stores
3. Account IDs will populate automatically

## Troubleshooting

### Store Still Has NULL After Population

**Cause**: No VendHqRegister data for that region

**Fix**:
```bash
# Option 1: Add VendHqRegister data and re-run
# Option 2: Manually set IDs
curl -X PUT http://localhost:3000/store-config/304 \
  -H "Content-Type: application/json" \
  -d '{"bankAccountId": 123456, "cashAccountId": 789012}'
```

### Receipts Still Not Created

1. **Clear cache**:
   ```bash
   curl -X POST http://localhost:3000/store-config/clear-cache
   ```

2. **Check store is active**:
   ```bash
   curl http://localhost:3000/store-config/304
   # Verify: isActive: true
   ```

3. **Check validation**:
   ```bash
   curl -X POST http://localhost:3000/store-config/304/validate
   ```

4. **Check FusionReceiptMethod**:
   ```sql
   SELECT * FROM "FusionReceiptMethod" WHERE region = 'AE';
   ```

## Next Steps

1. **Deploy this fix to production**
2. **Run population script immediately**
3. **Monitor health check daily for first week**
4. **Update runbooks to include account ID checks**
5. **Train team on new validation errors**

## Related Documentation

- Full guide: `docs/BANK_CASH_ACCOUNT_FIX.md`
- Quick reference: `docs/BANK_CASH_ACCOUNT_FIX_QUICK.md`
- Store config population: `docs/STORE_CONFIG_POPULATION.md`
- Oracle integration: `docs/ORACLE_FUSION_SYNC_COMPLETE_GUIDE.md`

## Success Metrics

✅ **Zero** stores with NULL account IDs  
✅ **100%** receipt creation attempt rate  
✅ **Automated** population for new stores  
✅ **Clear** validation errors guide fixes  
✅ **Monitoring** via health check endpoint  
✅ **Documented** solution and troubleshooting  

---

**Questions?** See full documentation in `docs/BANK_CASH_ACCOUNT_FIX.md`
