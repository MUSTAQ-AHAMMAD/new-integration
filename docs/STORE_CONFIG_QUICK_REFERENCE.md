# Store Configuration Auto-Creation - Quick Reference

## Problem Fixed
✅ All orders failing at Step 2/14 with "No store configuration found for branch: [branchId]"

## Solution
Auto-creation system that creates configs on-demand with caching and fallback.

---

## Quick Start

### Option 1: Pre-populate All Configs (Recommended)

**Via API:**
```bash
curl -X POST http://localhost:3000/store-config/populate/all-branches
```

**Via SQL:**
```bash
psql -U postgres -d your_database -f packages/backend/src/scripts/populate-store-configs.sql
```

### Option 2: Let Auto-Creation Handle It

Just deploy the code - configs will be created automatically as orders are processed.

---

## Testing

### Run Test Script
```bash
cd packages/backend
npx ts-node src/scripts/test-store-config.ts
```

### Health Check
```bash
# Get overall health
curl http://localhost:3000/store-config/health/check

# Check specific branch
curl http://localhost:3000/store-config/304
```

---

## API Endpoints

### Health Check
```bash
GET /store-config/health/check
```
Returns summary of all branches and their config status.

### Get Store Config
```bash
GET /store-config/304
```
Returns raw config for branch 304.

### Clear Cache
```bash
# Clear specific branch
POST /store-config/clear-cache?branchCode=304

# Clear all branches
POST /store-config/clear-cache
```

### Populate All Branches
```bash
POST /store-config/populate/all-branches
```
Creates configs for ALL branches found in backup tables.

### Validate Config
```bash
POST /store-config/304/validate
```
Validates and updates validation status.

---

## Key Features

### 1. Auto-Creation
- Missing configs are created automatically
- Uses branch data from BackupOdooOrder/BackupIbqOrder
- Maps to FusionSalesMetadata by region
- Fires alert for manual review

### 2. Caching
- 5-minute in-memory cache
- Reduces database load
- Can be cleared manually

### 3. Fallback
- If DB creation fails, uses in-memory fallback
- Logs warning for investigation
- Allows sync to continue

### 4. Validation Levels
- **VALIDATED**: Fully configured, ready for production
- **PARTIAL**: Auto-created, requires review (⚠️ WARNING, allows sync)
- **PENDING**: Awaiting validation (⚠️ WARNING, allows sync)
- **INVALID**: Critical errors (❌ ERROR, blocks sync)

---

## Common Scenarios

### New Branch Appears in Orders
1. Order arrives for branch 999
2. ValidationService calls `getOrCreateStoreConfig(999)`
3. Config not found → auto-creates with PARTIAL status
4. Alert fired for review
5. **Sync continues** with warning
6. Admin reviews and validates later

### Existing Branch Missing Config
1. Old branch 304 has no config
2. First order triggers auto-creation
3. Config created with defaults from backup tables
4. **Sync continues** immediately
5. Admin validates when convenient

### Database Temporarily Down
1. Cannot query database
2. Fallback config used (in-memory)
3. Marked as INVALID
4. **Sync may continue** (depending on other validation)
5. Normal config used when DB returns

---

## Manual Review Process

After auto-creation, review and update:

1. **Check health:**
   ```bash
   GET /store-config/health/check
   ```

2. **Review PARTIAL configs:**
   Look for `configStatus: "PARTIAL"` in results

3. **Update bank/cash accounts:**
   ```bash
   PUT /store-config/304
   {
     "bankAccountName": "ACTUAL_BANK_ACCOUNT",
     "cashAccountName": "ACTUAL_CASH_ACCOUNT"
   }
   ```

4. **Validate:**
   ```bash
   POST /store-config/304/validate
   ```

5. **Verify:**
   Status should change from PARTIAL → VALIDATED

---

## Monitoring

### Key Metrics
- Total branches vs configs (should be equal)
- Configs with PARTIAL status (need review)
- Configs with INVALID status (blocks sync)
- Cache hit rate (check logs)

### Alerts to Watch
- Type: `STORE_CONFIG_INVALID`
- Severity: `WARNING`
- Fired when config auto-created

---

## Troubleshooting

### Problem: Config still not found
**Solution:**
1. Check FusionSalesMetadata has records
2. Verify backup tables have branch data
3. Check logs for auto-creation errors
4. Try manual creation via API

### Problem: Sync still failing
**Solution:**
1. Check if config is INVALID (blocks sync)
2. Check if branch is inactive
3. Review validation errors in config
4. Check logs for specific error

### Problem: Cache not working
**Solution:**
1. Verify TTL hasn't expired (5 min)
2. Check if cache was cleared
3. Look for cache hit/miss logs
4. Try clearing and testing again

---

## Default Config Values

When auto-created:
```json
{
  "branchCode": "304",
  "branchName": "Branch-304",
  "region": "AE",
  "bankAccountName": "BANK_AE",    ← Update manually
  "cashAccountName": "CASH_AE",    ← Update manually
  "paymentTermsName": "IMMEDIATE",
  "invoiceCurrencyCode": "AED",
  "transactionSource": "Manual",
  "transactionType": "PASA CONSULTING SALE",
  "validationStatus": "PARTIAL"
}
```

---

## Performance

- **Cache hit**: ~1-5ms ⚡
- **Cache miss**: ~10-50ms
- **Auto-creation**: ~100-500ms (one-time)
- **Fallback**: ~1ms (in-memory)

---

## Files Changed

1. `packages/backend/src/store-config/store-config.service.ts`
   - Added caching layer
   - Added getOrCreateStoreConfig
   - Added createDefaultConfig
   - Added getFallbackConfig

2. `packages/backend/src/sync/validation.service.ts`
   - Updated to use auto-creation
   - Changed errors to warnings for missing configs

3. `packages/backend/src/store-config/store-config.controller.ts`
   - Added health check endpoint
   - Added cache clearing endpoint

4. `packages/backend/src/scripts/test-store-config.ts`
   - New test script

5. `packages/backend/src/scripts/populate-store-configs.sql`
   - New SQL batch population script

6. `docs/STORE_CONFIG_AUTO_CREATION.md`
   - Complete documentation

---

## Support

For issues or questions:
1. Check logs for detailed error messages
2. Review documentation: `docs/STORE_CONFIG_AUTO_CREATION.md`
3. Run health check: `GET /store-config/health/check`
4. Run test script: `npx ts-node src/scripts/test-store-config.ts`
