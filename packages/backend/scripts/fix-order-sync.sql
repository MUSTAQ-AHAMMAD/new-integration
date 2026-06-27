-- ========================================
-- DATABASE FIX SCRIPT FOR ORDER SYNC ISSUES
-- ========================================
-- This script fixes:
-- 1. Missing/null dates in orders
-- 2. Resets failed orders to allow retry
-- 3. Validates data integrity
-- ========================================

-- Fix 1: Update missing order dates
-- ========================================
UPDATE "OrderSyncQueue" 
SET "orderDate" = COALESCE("orderDate", "createdAt", NOW()),
    "orderDateUtc" = COALESCE("orderDateUtc", "orderDate", "createdAt", NOW())
WHERE "orderDate" IS NULL 
   OR "orderDateUtc" IS NULL;

-- Fix 2: Ensure customer names are populated
-- ========================================
UPDATE "OrderSyncQueue"
SET "customerName" = COALESCE("customerName", 'Default Customer')
WHERE "customerName" IS NULL OR "customerName" = '';

-- Fix 3: Ensure customer emails are populated
-- ========================================
UPDATE "OrderSyncQueue"
SET "customerEmail" = COALESCE("customerEmail", 'default@example.com')
WHERE "customerEmail" IS NULL OR "customerEmail" = '';

-- Fix 4: Ensure currency is set
-- ========================================
UPDATE "OrderSyncQueue"
SET "currency" = COALESCE("currency", 'AED')
WHERE "currency" IS NULL OR "currency" = '';

-- Fix 5: Reset failed orders to PENDING
-- ========================================
-- This allows them to be retried
UPDATE "OrderSyncQueue" 
SET "status" = 'PENDING',
    "syncAttempts" = 0,
    "validationErrors" = NULL,
    "lastSyncAt" = NULL
WHERE "status" = 'FAILED'
  AND "syncAttempts" < 5;

-- ========================================
-- VERIFICATION QUERIES
-- ========================================

-- Check order counts by status
SELECT 
  "status", 
  COUNT(*) as count,
  SUM("totalAmount") as total_amount
FROM "OrderSyncQueue"
GROUP BY "status"
ORDER BY count DESC;

-- Check for null dates (should be 0 after fix)
SELECT 
  COUNT(*) as total_orders,
  COUNT(CASE WHEN "orderDate" IS NULL THEN 1 END) as null_dates,
  COUNT(CASE WHEN "orderDateUtc" IS NULL THEN 1 END) as null_utc_dates,
  COUNT(CASE WHEN "customerName" IS NULL THEN 1 END) as null_customers,
  COUNT(CASE WHEN "status" = 'FAILED' THEN 1 END) as failed_orders,
  COUNT(CASE WHEN "status" = 'PENDING' THEN 1 END) as pending_orders,
  COUNT(CASE WHEN "status" = 'SYNCED' THEN 1 END) as synced_orders
FROM "OrderSyncQueue";

-- Check orders that were just reset
SELECT 
  "id",
  "odooOrderNumber",
  "branchCode",
  "status",
  "syncAttempts",
  "orderDate",
  "totalAmount",
  "currency"
FROM "OrderSyncQueue"
WHERE "status" = 'PENDING'
  AND "syncAttempts" = 0
ORDER BY "orderDate" DESC
LIMIT 10;

-- Check for any remaining data issues
SELECT 
  COUNT(*) as orders_with_issues,
  COUNT(CASE WHEN "orderDate" IS NULL THEN 1 END) as missing_dates,
  COUNT(CASE WHEN "totalAmount" = 0 THEN 1 END) as zero_amounts,
  COUNT(CASE WHEN "branchCode" IS NULL OR "branchCode" = '' THEN 1 END) as missing_branch
FROM "OrderSyncQueue";

-- ========================================
-- NOTES
-- ========================================
-- After running this script:
-- 1. Verify the counts look correct
-- 2. Call POST /api/v1/sync/fix-all-failed to queue orders
-- 3. Monitor GET /api/v1/sync/orders to see sync progress
-- 4. Check GET /api/v1/sync/queue/stats for queue status
-- ========================================
