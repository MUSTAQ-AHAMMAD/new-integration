# StoreConfiguration Population Guide

## Overview

This guide explains **Option B: Populate StoreConfiguration for All Branches**, which automatically creates `StoreConfiguration` records for all unique branches found in your backup order tables.

## What It Does

The population script/endpoint:

1. **Scans all backup tables** for unique branches:
   - `BackupOdooOrder` (Odoo POS orders)
   - `BackupIbqOrder` (IBQ orders)

2. **Merges and deduplicates** branches across sources

3. **Maps to FusionSalesMetadata** to populate Oracle configuration fields:
   - Matches by region when available
   - Falls back to default region (AE) if no match
   - Uses the first available record as last resort

4. **Creates StoreConfiguration** records with:
   - `branchCode` = string representation of branch ID
   - `branchName` = from backup data or auto-generated
   - `odooBranchId` = numeric branch ID from Odoo/IBQ
   - Oracle fields from `FusionSalesMetadata`
   - `validationStatus: PENDING` (needs manual review)

## Prerequisites

Before running the population:

1. **FusionSalesMetadata must be populated**
   ```bash
   # Import FusionSalesMetadata from CSV
   cd packages/backend
   pnpm seed:csv data/fusion-sales-metadata.csv
   ```

2. **Backup tables must contain data**
   ```bash
   # Fetch Odoo orders to populate BackupOdooOrder
   POST /api/v1/sync/fetch-odoo
   {
     "credentialId": "your-odoo-credential-id",
     "startDate": "2026-01-01",
     "endDate": "2026-06-30"
   }

   # Fetch IBQ orders to populate BackupIbqOrder
   POST /api/v1/sync/fetch-ibq
   {
     "credentialId": "your-ibq-credential-id",
     "startDate": "2026-01-01",
     "endDate": "2026-06-30"
   }
   ```

## Method 1: Using the Script (Recommended for Initial Setup)

### Development Mode

```bash
cd packages/backend
pnpm populate:store-config:dev
```

### Production Mode

```bash
cd packages/backend
pnpm build
pnpm populate:store-config
```

### Docker

```bash
docker exec integration_backend sh -c \
  "node dist/scripts/populate-store-config.js"
```

## Method 2: Using the API Endpoint

```bash
POST /api/v1/store-config/populate/all-branches
```

**Response:**
```json
{
  "totalBranches": 25,
  "created": 20,
  "skipped": 5,
  "errors": [
    "No suitable FusionSalesMetadata found for branch 999"
  ]
}
```

## After Population

### 1. Review Created Configurations

Navigate to the admin UI or use the API:

```bash
GET /api/v1/store-config?activeOnly=false
```

### 2. Update Placeholder Values

The script creates configurations with placeholder values for some fields:

- `bankAccountName`: Set to `BANK_{region}` (e.g., `BANK_AE`)
- `cashAccountName`: Set to `CASH_{region}` (e.g., `CASH_AE`)

**Update these to actual Oracle account names:**

```bash
PUT /api/v1/store-config/{branchCode}
{
  "bankAccountName": "ACTUAL_BANK_ACCOUNT_NAME",
  "cashAccountName": "ACTUAL_CASH_ACCOUNT_NAME"
}
```

### 3. Validate Each Configuration

```bash
POST /api/v1/store-config/{branchCode}/validate
```

**Required fields for validation:**
- `billToSiteName`
- `bankAccountName`
- `cashAccountName`
- `paymentTermsName`
- `oracleBusinessUnit`

### 4. Activate Configurations

After validation passes, configurations are automatically marked as `VALIDATED`. The `isActive` flag is set to `true` by default, but you can update it if needed:

```bash
PUT /api/v1/store-config/{branchCode}
{
  "isActive": true
}
```

## Troubleshooting

### No FusionSalesMetadata Error

**Error:** `No FusionSalesMetadata records found`

**Solution:** Import FusionSalesMetadata first:
```bash
pnpm seed:csv data/fusion-sales-metadata.csv
```

### No Branches Found

**Error:** `Total unique branches: 0`

**Solution:** Fetch orders from Odoo/IBQ first:
```bash
POST /api/v1/sync/fetch-odoo
POST /api/v1/sync/fetch-ibq
```

### Branch Already Configured

This is normal — the script skips branches that already have configurations. If you want to update an existing configuration, use the update endpoint:

```bash
PUT /api/v1/store-config/{branchCode}
```

### Validation Errors

After population, configurations have `validationStatus: PENDING`. Common validation errors:

- Missing `bankAccountName` / `cashAccountName` — update with actual values
- Missing `billToSiteName` — should be populated from FusionSalesMetadata
- Missing `paymentTermsName` — defaults to "IMMEDIATE"

Fix validation errors and re-validate:
```bash
PUT /api/v1/store-config/{branchCode}
POST /api/v1/store-config/{branchCode}/validate
```

## SQL Queries

### Check Populated Configurations

```sql
SELECT 
  "branchCode",
  "branchName",
  region,
  "validationStatus",
  "isActive",
  "createdBy"
FROM "StoreConfiguration"
ORDER BY "branchCode";
```

### Check Branches Without Configuration

```sql
SELECT DISTINCT 
  "branchId",
  "branchName",
  region
FROM "BackupOdooOrder"
WHERE "branchId" IS NOT NULL
  AND "branchId"::text NOT IN (
    SELECT "branchCode" FROM "StoreConfiguration"
  )
ORDER BY "branchId";
```

### Validate All Configurations

```sql
SELECT 
  "branchCode",
  "validationStatus",
  "validationErrors"
FROM "StoreConfiguration"
WHERE "validationStatus" != 'VALIDATED'
ORDER BY "branchCode";
```

## Comparison: Option A vs Option B

| Aspect | Option A: Manual | Option B: Auto-Populate |
|--------|------------------|-------------------------|
| **Speed** | Slow (one-by-one) | Fast (batch creation) |
| **Accuracy** | High (manual entry) | Good (auto-mapped) |
| **Effort** | High | Low |
| **Best For** | Few branches, custom config | Many branches, standard config |
| **When to Use** | <5 branches | 5+ branches |

## See Also

- [Store Configuration Admin UI](/admin/store-configurations)
- [Oracle Sync Troubleshooting](./ORACLE_SYNC_TROUBLESHOOTING.md)
- [FusionSalesMetadata Admin UI](/admin/fusion-sales-metadata)
- [API Quick Reference](../API_QUICK_REFERENCE.md)
