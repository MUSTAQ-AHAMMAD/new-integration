-- =====================================================================
-- Store Configuration Population Script
-- =====================================================================
-- This script creates default StoreConfiguration records for all
-- branches found in BackupOdooOrder and BackupIbqOrder tables.
-- 
-- Run this to pre-populate configs for all branches to avoid
-- auto-creation during order sync.
-- =====================================================================

-- Get all unique branches from Odoo and IBQ backup tables
WITH all_branches AS (
  -- Odoo branches
  SELECT DISTINCT
    "branchId",
    MAX("branchName") as "branchName",
    MAX(region) as region
  FROM "BackupOdooOrder"
  WHERE "branchId" IS NOT NULL
  GROUP BY "branchId"
  
  UNION
  
  -- IBQ branches
  SELECT DISTINCT
    "branchId",
    MAX("branchName") as "branchName",
    MAX(region) as region
  FROM "BackupIbqOrder"
  WHERE "branchId" IS NOT NULL
  GROUP BY "branchId"
),

-- Get the first FusionSalesMetadata per region (for Oracle config)
region_metadata AS (
  SELECT DISTINCT ON (region)
    region,
    "billToAccount",
    "businessUnit",
    "billToName",
    "siteNumber",
    "txnSource",
    "txnType"
  FROM "FusionSalesMetadata"
  ORDER BY region, "billToName"
),

-- Combine branch info with metadata
branches_with_metadata AS (
  SELECT
    b."branchId",
    b."branchName",
    COALESCE(b.region, 'AE') as region,
    COALESCE(m."billToAccount", 0) as "billToAccount",
    COALESCE(m."businessUnit", 'DEFAULT_BU') as "businessUnit",
    COALESCE(m."billToName", 'BILL_TO_' || COALESCE(b.region, 'AE')) as "billToName",
    m."siteNumber",
    COALESCE(m."txnSource", 'Manual') as "txnSource",
    COALESCE(m."txnType", 'PASA CONSULTING SALE') as "txnType"
  FROM all_branches b
  LEFT JOIN region_metadata m ON b.region = m.region OR (b.region IS NULL AND m.region = 'AE')
)

-- Insert store configurations (skip if already exists)
INSERT INTO "StoreConfiguration" (
  id,
  "branchCode",
  "branchName",
  "odooBranchId",
  "oracleOperatingUnitId",
  "oracleBusinessUnit",
  "billToSiteName",
  "billToLocation",
  "bankAccountName",
  "cashAccountName",
  "paymentTermsName",
  "transactionSource",
  "transactionType",
  "invoiceCurrencyCode",
  region,
  "isActive",
  "validationStatus",
  "validationErrors",
  "createdBy",
  "createdAt",
  "updatedAt",
  version
)
SELECT
  gen_random_uuid()::text,
  "branchId"::text,
  COALESCE("branchName", 'Branch-' || "branchId"),
  "branchId",
  "billToAccount",
  "businessUnit",
  "billToName",
  "siteNumber",
  'BANK_' || region,
  'CASH_' || region,
  'IMMEDIATE',
  "txnSource",
  "txnType",
  'AED',
  region,
  true,
  'PARTIAL',
  '["Auto-created via SQL script - requires manual validation"]'::jsonb,
  'SQL_BATCH_POPULATE',
  NOW(),
  NOW(),
  1
FROM branches_with_metadata
WHERE NOT EXISTS (
  SELECT 1 FROM "StoreConfiguration"
  WHERE "branchCode" = "branchId"::text
)
ORDER BY "branchId";

-- Display summary
DO $$
DECLARE
  total_branches INT;
  configs_before INT;
  configs_after INT;
  created INT;
BEGIN
  -- Count total unique branches
  SELECT COUNT(DISTINCT "branchId")
  INTO total_branches
  FROM (
    SELECT "branchId" FROM "BackupOdooOrder" WHERE "branchId" IS NOT NULL
    UNION
    SELECT "branchId" FROM "BackupIbqOrder" WHERE "branchId" IS NOT NULL
  ) AS all_branches;
  
  -- Count configs before
  SELECT COUNT(*)
  INTO configs_before
  FROM "StoreConfiguration";
  
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'Store Configuration Population Complete';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'Total unique branches found: %', total_branches;
  RAISE NOTICE 'Store configurations now: %', configs_before;
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '1. Review created configs at /store-config endpoint';
  RAISE NOTICE '2. Update bank/cash account names for each region';
  RAISE NOTICE '3. Validate configs using POST /store-config/{branchCode}/validate';
  RAISE NOTICE '4. Run health check: GET /store-config/health/check';
  RAISE NOTICE '';
END $$;

-- Show created configurations by region
SELECT
  region,
  COUNT(*) as count,
  array_agg(DISTINCT "branchCode" ORDER BY "branchCode") as branch_codes
FROM "StoreConfiguration"
WHERE "createdBy" = 'SQL_BATCH_POPULATE'
GROUP BY region
ORDER BY region;
