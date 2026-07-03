# Bank/Cash Account ID Fix - Quick Reference

## TL;DR - Fix It Now

```bash
# Option 1: Via API
curl -X POST http://localhost:3000/store-config/populate/bank-cash-accounts

# Option 2: Via Script
cd packages/backend
pnpm populate:bank-cash-accounts:dev

# Verify
curl http://localhost:3000/store-config/health/check | jq '.summary.missingBothAccountIds'
# Should return: 0
```

## What Was The Problem?

50+ stores had **NULL** `bankAccountId` and `cashAccountId` → Receipts were skipped → Integration failed

## What's Fixed?

1. ✅ New API endpoint to populate account IDs from VendHqRegister
2. ✅ Script to run the population
3. ✅ Auto-creation now populates IDs automatically
4. ✅ Validation checks for missing IDs
5. ✅ Health check shows account status

## Quick Commands

### Check Status
```bash
curl http://localhost:3000/store-config/health/check | jq '.summary'
```

### Fix All Stores
```bash
curl -X POST http://localhost:3000/store-config/populate/bank-cash-accounts
```

### Fix Single Store
```bash
curl -X PUT http://localhost:3000/store-config/304 \
  -H "Content-Type: application/json" \
  -d '{"bankAccountId": 123456, "cashAccountId": 789012}'
```

### Validate Store
```bash
curl -X POST http://localhost:3000/store-config/304/validate
```

### Clear Cache
```bash
curl -X POST http://localhost:3000/store-config/clear-cache
```

## Expected Results

### Before
```json
{
  "summary": {
    "missingBankAccountId": 50,
    "missingCashAccountId": 50,
    "missingBothAccountIds": 50
  }
}
```

### After
```json
{
  "summary": {
    "missingBankAccountId": 0,
    "missingCashAccountId": 0,
    "missingBothAccountIds": 0
  }
}
```

## Troubleshooting

### Still NULL After Population?

**Check VendHqRegister has data for that region:**
```sql
SELECT region, "bankAccountId", "cashAccountId" 
FROM "VendHqRegister" 
WHERE region = 'AE' 
  AND "bankAccountId" IS NOT NULL 
LIMIT 1;
```

**No data?** Manually set IDs or add VendHqRegister records.

### Receipts Still Not Created?

1. Clear cache: `POST /store-config/clear-cache`
2. Check store is active: `isActive: true`
3. Validate: `POST /store-config/304/validate`
4. Check logs for other errors

## Files Changed

- `packages/backend/src/store-config/store-config.service.ts`
- `packages/backend/src/store-config/store-config.controller.ts`
- `packages/backend/src/scripts/populate-bank-cash-accounts.ts`
- `packages/backend/package.json`
- `docs/BANK_CASH_ACCOUNT_FIX.md` (full docs)

## Next Steps

1. Run population script
2. Check health endpoint
3. Test receipt creation
4. Monitor for new stores

---

**Full documentation**: `docs/BANK_CASH_ACCOUNT_FIX.md`
