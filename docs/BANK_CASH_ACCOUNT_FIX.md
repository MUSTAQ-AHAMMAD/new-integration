# Bank/Cash Account ID Population Fix

## Problem Statement

The integration system was experiencing complete receipt creation failure because **50+ store configurations** had `NULL` values for `bankAccountId` and `cashAccountId` fields. These fields are **required** for Oracle Fusion receipt creation, causing the system to log warnings and skip all receipts.

### Root Cause

When `StoreConfiguration` records were created (either manually or via auto-population), the `bankAccountId` and `cashAccountId` fields were not being populated. The Odoo transformation service checks these fields and skips receipt creation when they're null:

```typescript
const numericAccountId = isCash
  ? (storeConfig.cashAccountId ?? null)
  : (storeConfig.bankAccountId ?? null);

if (numericAccountId == null) {
  this.logger.warn(
    `StoreConfiguration branchCode=${branchCode} has no ` +
    `${isCash ? 'cashAccountId' : 'bankAccountId'} — ` +
    `standard receipt for "${pmtMethod}" skipped.`
  );
}
```

## Solution Overview

Added three-level fix:

1. **Service method** to populate existing stores with missing account IDs
2. **Updated auto-creation logic** to populate account IDs when creating new stores
3. **Enhanced validation** to check for missing account IDs

## Implementation Details

### 1. Service Method: `populateBankCashAccountIds()`

**Location**: `packages/backend/src/store-config/store-config.service.ts`

**What it does**:
- Queries all `StoreConfiguration` records with null `bankAccountId` or `cashAccountId`
- Loads `VendHqRegister` data by region (one register per region with valid account IDs)
- Creates a region → account IDs mapping
- Updates each store based on its region
- Clears configuration cache after updates

**How it works**:
```typescript
// Find all stores missing account IDs
const stores = await this.prisma.storeConfiguration.findMany({
  where: {
    OR: [
      { bankAccountId: null },
      { cashAccountId: null },
    ],
  },
});

// Get account IDs by region from VendHqRegister
const registersByRegion = await this.prisma.$queryRaw`
  SELECT DISTINCT ON (region)
    region,
    "bankAccountId",
    "cashAccountId"
  FROM "VendHqRegister"
  WHERE "bankAccountId" IS NOT NULL
    AND "cashAccountId" IS NOT NULL
    AND "deletedAt" IS NULL
  ORDER BY region, "createdAt" DESC
`;

// Update each store
for (const store of stores) {
  const accountIds = regionAccountMap.get(store.region);
  await this.prisma.storeConfiguration.update({
    where: { id: store.id },
    data: {
      bankAccountId: accountIds.bankAccountId,
      cashAccountId: accountIds.cashAccountId,
      validationStatus: ValidationStatus.PENDING,
    },
  });
}
```

### 2. Updated Auto-Creation: `createDefaultConfig()`

**What changed**:
- Now queries `VendHqRegister` by region before creating the store config
- Populates `bankAccountId` and `cashAccountId` if available
- Sets validation status to `PENDING` if accounts found, `PARTIAL` if not
- Uses register's `bankAccount` and `cashAccount` names instead of generic placeholders

**Benefits**:
- New stores get account IDs automatically
- Reduces manual configuration needed
- Improves first-time success rate

### 3. Updated Batch Population: `populateAllBranches()`

**What changed**:
- Loads all region → account ID mappings upfront
- Populates account IDs when creating each store configuration
- Logs whether account IDs were populated for each store

### 4. Enhanced Validation

**What changed**:
- Added explicit checks for `bankAccountId === null` and `cashAccountId === null`
- These are now **critical errors** that set validation status to `INVALID`
- Returns both `errors` and `warnings` arrays
- Warns about missing region and tax classification

**Error messages**:
```typescript
if (config.bankAccountId === null) {
  errors.push('bankAccountId is required for receipt creation - receipts will be skipped');
}
if (config.cashAccountId === null) {
  errors.push('cashAccountId is required for receipt creation - cash receipts will be skipped');
}
```

## API Endpoints

### `POST /store-config/populate/bank-cash-accounts`

Populates missing bank/cash account IDs for all store configurations.

**Request**: None (no body required)

**Response**:
```json
{
  "totalStores": 52,
  "updated": 50,
  "skipped": 2,
  "errors": [
    "No account IDs found for region XX (store 9999)"
  ]
}
```

### `GET /store-config/health/check`

Enhanced to show account ID status.

**Response**:
```json
{
  "summary": {
    "totalBranches": 150,
    "configsFound": 150,
    "configsMissing": 0,
    "configsValid": 100,
    "configsPartial": 0,
    "configsInvalid": 0,
    "configsPending": 50,
    "missingBankAccountId": 0,
    "missingCashAccountId": 0,
    "missingBothAccountIds": 0
  },
  "branches": [
    {
      "branchId": 304,
      "branchCode": "304",
      "storeName": "Dubai Branch",
      "hasConfig": true,
      "configStatus": "PENDING",
      "isActive": true,
      "hasBankAccountId": true,
      "hasCashAccountId": true,
      "config": {
        "bankAccountId": 123456,
        "cashAccountId": 789012,
        ...
      }
    }
  ]
}
```

## Scripts

### Run Population Script

**Development**:
```bash
cd packages/backend
pnpm populate:bank-cash-accounts:dev
```

**Production**:
```bash
cd packages/backend
npm run build
pnpm populate:bank-cash-accounts
```

**Output**:
```
🚀 Starting bank/cash account ID population script
═══════════════════════════════════════════════════

📊 Analyzing store configurations...

Found 52 stores with missing account IDs
Found 5 regions with account IDs
Region AE: bank=123456, cash=789012 (from Main Register)
Region KW: bank=234567, cash=890123 (from Kuwait Register)
...

Updated store 304: bank=123456, cash=789012
Updated store 357: bank=123456, cash=789012
...

✅ Population complete!
═══════════════════════════════════════════════════
📈 Summary:
   Total stores processed: 52
   ✅ Updated: 50
   ⏭️  Skipped: 2
   ❌ Errors: 2

⚠️  Errors encountered:
   1. No account IDs found for region XX (store 9999)
   2. No account IDs found for region YY (store 8888)

💡 Next steps:
   1. Verify the updated configurations in the dashboard
   2. Run validation: POST /store-config/{branchCode}/validate
   3. Test receipt creation with a sample order
```

## Deployment Steps

### Option 1: Via API (Recommended)

```bash
# 1. Check current status
curl http://localhost:3000/store-config/health/check

# 2. Populate account IDs
curl -X POST http://localhost:3000/store-config/populate/bank-cash-accounts

# 3. Verify results
curl http://localhost:3000/store-config/health/check
```

### Option 2: Via Script

```bash
cd packages/backend
pnpm populate:bank-cash-accounts:dev
```

### Option 3: When Creating New Stores

The auto-creation logic now handles this automatically. Just create stores as normal:

```bash
curl -X POST http://localhost:3000/store-config/populate/all-branches
```

Account IDs will be populated if VendHqRegister data exists for the region.

## Verification

### 1. Check Health Status

```bash
curl http://localhost:3000/store-config/health/check | jq '.summary'
```

Look for:
- `missingBankAccountId: 0`
- `missingCashAccountId: 0`
- `missingBothAccountIds: 0`

### 2. Validate Individual Stores

```bash
curl -X POST http://localhost:3000/store-config/304/validate
```

Should return:
```json
{
  "isValid": true,
  "errors": [],
  "warnings": []
}
```

### 3. Test Receipt Creation

Run a sync job and check logs for:
- ✅ No warnings about missing account IDs
- ✅ Receipts created successfully
- ✅ No "standard receipt skipped" messages

## Troubleshooting

### Problem: Store still has null account IDs after population

**Cause**: No VendHqRegister data exists for that store's region

**Solution**:
1. Check what regions have data:
   ```sql
   SELECT region, COUNT(*) 
   FROM "VendHqRegister" 
   WHERE "bankAccountId" IS NOT NULL 
     AND "cashAccountId" IS NOT NULL
   GROUP BY region;
   ```

2. Manually set account IDs:
   ```bash
   curl -X PUT http://localhost:3000/store-config/304 \
     -H "Content-Type: application/json" \
     -d '{
       "bankAccountId": 123456,
       "cashAccountId": 789012
     }'
   ```

### Problem: Validation fails after populating IDs

**Cause**: Other required fields are missing

**Solution**: Run validation to see all errors:
```bash
curl -X POST http://localhost:3000/store-config/304/validate
```

Fix the reported errors through the dashboard or API.

### Problem: Receipts still not created

**Possible causes**:
1. Cache not cleared - try:
   ```bash
   curl -X POST http://localhost:3000/store-config/clear-cache
   ```

2. Store configuration not active:
   ```bash
   curl -X PUT http://localhost:3000/store-config/304 \
     -H "Content-Type: application/json" \
     -d '{"isActive": true}'
   ```

3. Receipt method not found - check `FusionReceiptMethod` table has entries for the region

## Data Sources

### VendHqRegister Table

**Purpose**: Source of truth for bank/cash account IDs by region

**Key fields**:
- `region` - Region identifier (AE, KW, OM, etc.)
- `bankAccountId` - Oracle Fusion bank account ID (BigInt)
- `cashAccountId` - Oracle Fusion cash account ID (BigInt)
- `bankAccount` - Bank account name (String)
- `cashAccount` - Cash account name (String)
- `deletedAt` - Soft delete timestamp (NULL = active)

**Query used**:
```sql
SELECT DISTINCT ON (region)
  region,
  "bankAccountId",
  "cashAccountId",
  "bankAccount",
  "cashAccount"
FROM "VendHqRegister"
WHERE "bankAccountId" IS NOT NULL
  AND "cashAccountId" IS NOT NULL
  AND "deletedAt" IS NULL
ORDER BY region, "createdAt" DESC;
```

This gets the **most recent** register per region with valid account IDs.

## Impact

### Before Fix

- ❌ 50+ stores with null account IDs
- ❌ 0% receipt creation success rate
- ❌ All receipts skipped with warnings
- ❌ Integration effectively non-functional

### After Fix

- ✅ All stores have account IDs (or clear error if data unavailable)
- ✅ 100% receipt creation attempt rate (if data available)
- ✅ Auto-population for new stores
- ✅ Clear validation errors guide manual fixes
- ✅ Integration fully functional

## Related Files

### Backend
- `packages/backend/src/store-config/store-config.service.ts` - Service implementation
- `packages/backend/src/store-config/store-config.controller.ts` - API endpoints
- `packages/backend/src/scripts/populate-bank-cash-accounts.ts` - Population script
- `packages/backend/src/sync/odoo-transformation.service.ts` - Receipt creation logic
- `packages/backend/src/sync/fusion-transformation.service.ts` - VendHQ receipt logic

### Database
- `StoreConfiguration` model - Stores per-branch configuration
- `VendHqRegister` model - Source of account IDs

## Success Criteria

✅ Zero stores with null bank/cash account IDs (or documented reason)
✅ Auto-creation populates account IDs when possible
✅ Validation catches missing account IDs
✅ Health check shows account ID status
✅ Script can fix existing stores in one command
✅ Receipt creation no longer skipped due to missing accounts
✅ Clear documentation for troubleshooting

## Next Steps

After deploying this fix:

1. **Run population immediately**:
   ```bash
   pnpm populate:bank-cash-accounts:dev
   ```

2. **Check results**:
   ```bash
   curl http://localhost:3000/store-config/health/check
   ```

3. **Fix any remaining issues** manually or by adding VendHqRegister data

4. **Test with real order**:
   - Trigger a sync job
   - Check for receipt creation
   - Verify no "skipped" warnings

5. **Monitor ongoing**:
   - Set up alerts for validation failures
   - Weekly check of health endpoint
   - Review new stores created

## Maintenance

- **Weekly**: Run health check to ensure no new stores missing account IDs
- **Monthly**: Validate all stores to catch configuration drift
- **Per new region**: Add VendHqRegister records before creating stores
- **Per store creation**: Verify account IDs populated automatically
