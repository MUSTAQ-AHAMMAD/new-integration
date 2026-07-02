-- ================================================================
-- Oracle Status E Debugging - SQL Queries
-- ================================================================
-- Use these queries in pgAdmin, DBeaver, or psql to investigate
-- failed orders and Status E errors
-- ================================================================

-- 1. SUMMARY: Get overall sync status
-- ================================================================
SELECT 
  status,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM "OrderSyncQueue"
GROUP BY status
ORDER BY count DESC;

-- 2. STATUS E FAILURES: Find all orders with Status E errors
-- ================================================================
SELECT 
  "odooOrderId",
  "odooOrderNumber",
  "branchCode",
  "region",
  "totalAmount",
  "currency",
  "syncAttempts",
  SUBSTRING("lastErrorMessage", 1, 200) as error_preview,
  "updatedAt"
FROM "OrderSyncQueue"
WHERE status = 'FAILED'
  AND "lastErrorMessage" LIKE '%Status E%'
ORDER BY "updatedAt" DESC
LIMIT 20;

-- 3. FAILURES BY BRANCH: Identify problematic branches
-- ================================================================
SELECT 
  "branchCode",
  COUNT(*) as total_orders,
  SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
  SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
  ROUND(
    SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
    2
  ) as success_rate
FROM "OrderSyncQueue"
GROUP BY "branchCode"
HAVING COUNT(*) > 5  -- Only branches with more than 5 orders
ORDER BY success_rate ASC, failed DESC
LIMIT 20;

-- 4. STORE CONFIG ISSUES: Find configuration problems
-- ================================================================
SELECT 
  "branchCode",
  "billToSiteName",
  "billToLocation",
  "oracleOperatingUnitId",
  "oracleBusinessUnit",
  "transactionSource",
  "transactionType",
  "invoiceCurrencyCode",
  "isActive",
  "validationStatus",
  "validationErrors"
FROM "StoreConfiguration"
WHERE "isActive" = false
   OR "validationStatus" IN ('INVALID', 'PENDING', 'PARTIAL')
   OR "billToLocation" IS NULL
   OR "oracleBusinessUnit" IS NULL
   OR "transactionSource" IS NULL
ORDER BY "branchCode";

-- 5. RECENT FAILURES: Last 10 failed orders with full details
-- ================================================================
SELECT 
  o."odooOrderId",
  o."odooOrderNumber",
  o."branchCode",
  o."region",
  o."totalAmount",
  o."currency",
  o."orderDate",
  o."isPaid",
  o."isCancelled",
  o."syncAttempts",
  o."lastErrorMessage",
  o."lastErrorType",
  o."updatedAt",
  s."billToSiteName",
  s."oracleBusinessUnit",
  s."transactionSource",
  s."transactionType"
FROM "OrderSyncQueue" o
LEFT JOIN "StoreConfiguration" s ON o."branchCode" = s."branchCode"
WHERE o.status = 'FAILED'
  AND o."lastErrorMessage" LIKE '%Status E%'
ORDER BY o."updatedAt" DESC
LIMIT 10;

-- 6. INVOICE AUDIT: Failed invoice attempts in Oracle
-- ================================================================
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
  "currencyCode",
  "txnDate",
  "requestDate"
FROM "FusionInvoiceHeader"
WHERE status = 'E'
ORDER BY "requestDate" DESC
LIMIT 20;

-- 7. SUCCESSFUL VS FAILED: Compare successful orders to failed ones
-- ================================================================
-- Find successful orders from the same branch as failed ones
WITH failed_branches AS (
  SELECT DISTINCT "branchCode"
  FROM "OrderSyncQueue"
  WHERE status = 'FAILED'
    AND "lastErrorMessage" LIKE '%Status E%'
)
SELECT 
  o."branchCode",
  o."status",
  COUNT(*) as order_count,
  AVG(o."totalAmount") as avg_amount,
  s."oracleBusinessUnit",
  s."transactionSource",
  s."transactionType"
FROM "OrderSyncQueue" o
INNER JOIN failed_branches fb ON o."branchCode" = fb."branchCode"
LEFT JOIN "StoreConfiguration" s ON o."branchCode" = s."branchCode"
WHERE o.status IN ('COMPLETED', 'FAILED')
GROUP BY o."branchCode", o."status", s."oracleBusinessUnit", s."transactionSource", s."transactionType"
ORDER BY o."branchCode", o."status";

-- 8. BACKUP ORDER DETAILS: Get raw backup data for a failed order
-- ================================================================
-- Replace '12345' with actual odooOrderId
SELECT 
  bo.*,
  (SELECT json_agg(bol.*) FROM "BackupOdooOrderLine" bol WHERE bol."backupOdooOrderId" = bo.id) as lines,
  (SELECT json_agg(bop.*) FROM "BackupOdooOrderPayment" bop WHERE bop."backupOdooOrderId" = bo.id) as payments
FROM "BackupOdooOrder" bo
WHERE bo."orderId" = 12345;  -- Replace with actual order ID

-- 9. ERROR PATTERNS: Group errors by message patterns
-- ================================================================
SELECT 
  CASE 
    WHEN "lastErrorMessage" LIKE '%Business Unit%' THEN 'Business Unit Error'
    WHEN "lastErrorMessage" LIKE '%Transaction Source%' THEN 'Transaction Source Error'
    WHEN "lastErrorMessage" LIKE '%Transaction Type%' THEN 'Transaction Type Error'
    WHEN "lastErrorMessage" LIKE '%not found%' THEN 'Not Found Error'
    WHEN "lastErrorMessage" LIKE '%invalid%' THEN 'Invalid Data Error'
    WHEN "lastErrorMessage" LIKE '%timeout%' THEN 'Timeout Error'
    WHEN "lastErrorMessage" LIKE '%Status E%' THEN 'Status E (no details)'
    ELSE 'Other Error'
  END as error_type,
  COUNT(*) as occurrence_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM "OrderSyncQueue"
WHERE status = 'FAILED'
  AND "lastErrorMessage" IS NOT NULL
GROUP BY error_type
ORDER BY occurrence_count DESC;

-- 10. ORDERS STUCK IN PROCESSING: Find orphaned processing orders
-- ================================================================
SELECT 
  "odooOrderId",
  "odooOrderNumber",
  "branchCode",
  "status",
  "syncAttempts",
  "updatedAt",
  EXTRACT(EPOCH FROM (NOW() - "updatedAt")) / 3600 as hours_stuck
FROM "OrderSyncQueue"
WHERE status = 'PROCESSING'
  AND "updatedAt" < NOW() - INTERVAL '1 hour'
ORDER BY "updatedAt" ASC;

-- 11. BRANCH CONFIGURATION: Get all config for a specific branch
-- ================================================================
-- Replace 'CCNTRBHR' with your branch code
SELECT 
  sc.*,
  (
    SELECT COUNT(*) 
    FROM "OrderSyncQueue" osq 
    WHERE osq."branchCode" = sc."branchCode" 
      AND osq.status = 'FAILED'
  ) as failed_order_count,
  (
    SELECT COUNT(*) 
    FROM "OrderSyncQueue" osq 
    WHERE osq."branchCode" = sc."branchCode" 
      AND osq.status = 'COMPLETED'
  ) as completed_order_count
FROM "StoreConfiguration" sc
WHERE sc."branchCode" = 'CCNTRBHR';  -- Replace with actual branch code

-- 12. TIMELINE: Orders by hour to identify patterns
-- ================================================================
SELECT 
  DATE_TRUNC('hour', "createdAt") as hour,
  status,
  COUNT(*) as order_count
FROM "OrderSyncQueue"
WHERE "createdAt" > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', "createdAt"), status
ORDER BY hour DESC, status;

-- 13. RETRY CANDIDATES: Orders that should be retried
-- ================================================================
SELECT 
  "odooOrderId",
  "odooOrderNumber",
  "branchCode",
  "region",
  "syncAttempts",
  "lastErrorMessage",
  "updatedAt"
FROM "OrderSyncQueue"
WHERE status = 'FAILED'
  AND "syncAttempts" < 3  -- Not exhausted retries yet
  AND "isPaid" = true
  AND "isCancelled" = false
  AND "updatedAt" > NOW() - INTERVAL '7 days'  -- Recent failures
ORDER BY "updatedAt" DESC
LIMIT 50;

-- 14. INVOICE LINE AUDIT: Check for missing line data
-- ================================================================
SELECT 
  ih."id",
  ih."txnNumber",
  ih."status",
  ih."businessUnit",
  COUNT(il."id") as line_count,
  SUM(il."quantity") as total_quantity
FROM "FusionInvoiceHeader" ih
LEFT JOIN "FusionInvoiceLine" il ON ih."id" = il."invoiceNumber"
WHERE ih.status = 'E'
GROUP BY ih."id", ih."txnNumber", ih."status", ih."businessUnit"
HAVING COUNT(il."id") = 0  -- Invoices with no lines
ORDER BY ih."requestDate" DESC
LIMIT 20;

-- 15. DUPLICATE CHECK: Find potentially duplicate orders
-- ================================================================
SELECT 
  "odooOrderId",
  "branchCode",
  COUNT(*) as duplicate_count,
  array_agg(status) as statuses,
  array_agg("updatedAt") as update_times
FROM "OrderSyncQueue"
GROUP BY "odooOrderId", "branchCode"
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC
LIMIT 20;

-- ================================================================
-- HELPER QUERIES FOR FIXING ISSUES
-- ================================================================

-- FIX 1: Update store configuration with correct values
-- ================================================================
/*
UPDATE "StoreConfiguration"
SET 
  "billToLocation" = 'Main Branch',
  "oracleBusinessUnit" = 'US_BU',
  "transactionSource" = 'MANUAL',
  "transactionType" = 'Invoice',
  "validationStatus" = 'VALID'
WHERE "branchCode" = 'CCNTRBHR';
*/

-- FIX 2: Reset failed orders for retry
-- ================================================================
/*
UPDATE "OrderSyncQueue"
SET 
  status = 'PENDING',
  "syncAttempts" = 0,
  "lastErrorMessage" = NULL,
  "lastErrorType" = NULL
WHERE "branchCode" = 'CCNTRBHR'
  AND status = 'FAILED'
  AND "lastErrorMessage" LIKE '%Status E%';
*/

-- FIX 3: Delete duplicate orders (keep most recent)
-- ================================================================
/*
DELETE FROM "OrderSyncQueue"
WHERE id IN (
  SELECT id FROM (
    SELECT 
      id,
      ROW_NUMBER() OVER (
        PARTITION BY "odooOrderId", "branchCode" 
        ORDER BY "updatedAt" DESC
      ) as rn
    FROM "OrderSyncQueue"
  ) t
  WHERE rn > 1
);
*/

-- ================================================================
-- NOTES:
-- - Always test UPDATE/DELETE queries on a backup first
-- - Replace placeholder values with actual data
-- - Uncomment (remove /* */) queries before executing fixes
-- ================================================================
