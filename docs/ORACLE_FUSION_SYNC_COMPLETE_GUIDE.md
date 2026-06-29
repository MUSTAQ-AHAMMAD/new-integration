# Oracle Fusion Complete Sync Cycle Guide

## Overview

This document describes the complete Oracle Fusion integration sync cycle that processes orders from Odoo/IBQ/VendHQ systems into Oracle Fusion ERP.

## Complete Sync Flow (6 Operations)

When an order is synced to Oracle Fusion, the system performs the following operations in sequence:

```
Order → 1. Invoice → 2. Standard Receipts → 3. Misc Receipts → 4. Apply Receipts → 5. Journal Entries → (6. Inventory - separate cron)
```

### 1. Invoice Headers & Lines ✅

**Purpose:** Create a receivables invoice in Oracle Fusion AR

**SOAP Endpoint:** `/fscmService/RecInvoiceService`

**Operation:** `createSimpleInvoice`

**Key Fields:**
- `billToCustomerName` - Customer name
- `billToLocation` - Customer site/location
- `billToAccountNumber` - Customer account number
- `businessUnit` - Oracle Fusion business unit
- `transactionSource` - Transaction source (e.g., "Manual")
- `transactionType` - Transaction type (e.g., "PASA CONSULTING SALE")
- `invoiceCurrencyCode` - Currency (AED, USD, etc.)
- `conversionRateType` - "Corporate" or "User"
- `paymentTermsName` - Payment terms from CustomerProfileService
- `saleDate` - Invoice date and GL date
- `invoiceLines[]` - Array of line items

**Invoice Line Fields:**
- `lineNumber` - Sequential line number
- `itemNumber` - Fusion inventory item number
- `memoLineName` - Memo line (used for discounts)
- `description` - Line description
- `quantity` - Quantity sold
- `uomCode` - Unit of measure
- `unitSellingPrice` - Price per unit
- `currencyCode` - Line currency
- `salesOrder` - VendHQ/Odoo order number
- `salesOrderLine` - Line number
- `taxClassificationCode` - Tax classification

**Response:**
- `serviceStatus` - "SUCCESS" or "E" (error)
- `transactionNumber` - **CRITICAL** - Invoice number (used in all downstream operations)
- `customerTrxId` - Oracle transaction ID

**Error Handling:**
- ✅ **Status E Detection:** If `serviceStatus = "E"`, the sync cycle STOPS immediately
- ✅ **Null Transaction Number:** If `transactionNumber` is null/empty, throws error
- ✅ **Full Response Logging:** Logs first 2000 chars of XML on error
- ✅ **Error Extraction:** Attempts to extract error message from response

**Persisted To:** `FusionInvoiceHeader` and `FusionInvoiceLine` tables

---

### 2. Standard Receipts ✅

**Purpose:** Create customer payment receipts for the invoice

**SOAP Endpoint:** `/fscmService/StandardReceiptService`

**Operation:** `createStandardReceipt`

**Key Fields:**
- `currencyCode` - Payment currency
- `receiptDate` - Receipt date
- `receiptMethodId` - Receipt method ID from FusionReceiptMethod table
- `receiptNumber` - Format: `{PaymentType}-{TransactionNumber}` (e.g., "CASH-12345")
- `remittanceBankAccountId` - Bank account for deposit
- `customerAccountNumber` - Customer account number
- `businessUnitId` - Oracle business unit ID
- `payingCustomerPartyId` - Customer ID (optional)
- `amount` - Receipt amount

**Response:**
- `receiptNumber` - Receipt number
- `customerReceiptReference` - Customer receipt reference

**Error Handling:**
- ✅ **Empty Receipt Number:** Validates receipt number is returned
- ✅ **Full Response Logging:** Logs first 2000 chars on error

**Persisted To:** `FusionStandardReceipt` table

**Multiple Receipts:** One standard receipt per payment method (CASH, CARD, KNET, etc.)

---

### 3. Miscellaneous Receipts ✅

**Purpose:** Handle cash rounding adjustments and bank charges

**SOAP Endpoint:** `/fscmService/MiscellaneousReceiptService`

**Operation:** `createMiscellaneousReceipt`

**Key Fields:**
- `currencyCode` - Payment currency
- `receiptDate` - Receipt date
- `receiptMethodId` - Receipt method ID
- `receiptMethodName` - Payment method name
- `receiptNumber` - Format: `{PaymentType}-{TransactionNumber}-MISC`
- `bankAccountName` - Bank or cash account name
- `receivableActivityName` - Receivable activity (e.g., "Cash Rounding", "Bank Charges")
- `businessUnitId` - Oracle business unit ID
- `amount` - **NEGATIVE for adjustments** (e.g., -0.05 for cash rounding)

**Response:**
- `receivablesTransactionId` - Transaction ID
- `receiptNumber` - Receipt number

**Error Handling:**
- ✅ **Empty Receipt Number:** Validates receipt number is returned
- ✅ **Amount Logging:** Logs receipt amount for debugging
- ✅ **Full Response Logging:** Logs first 2000 chars on error

**Persisted To:** `FusionMiscReceipt` table

**Use Cases:**

1. **Cash Rounding** (Payment Method: "Cash Rounding")
   - `amount`: **Negative** (e.g., -0.05)
   - `receivableActivityName`: "Cash Rounding" (from FusionSalesMetadata.recActivityNameCash)
   - `bankAccountName`: Cash account name

2. **Bank Charges** (Non-cash payment methods like KNET, Debit Card)
   - `amount`: **Negative** calculated from `receiptBankCharge * (1 + receiptMethodTax)`
   - `receivableActivityName`: "Bank Charges" (from FusionSalesMetadata.recActivityNameBank)
   - `bankAccountName`: Bank account name
   - **Regional Cap:** Debit Card in OM region capped at 10

---

### 4. Apply Receipts ✅

**Purpose:** Apply standard receipts to the invoice

**SOAP Endpoint:** `/fscmService/StandardReceiptService`

**Operation:** `createApplyReceipt`

**Key Fields:**
- `receiptDate` - Application date
- `transactionNumber` - **CRITICAL** - Invoice transaction number from step 1
- `receiptNumber` - Receipt number from step 2
- `amountApplied` - Amount to apply
- `receiptCurrencyCode` - Currency
- `transactionSource` - Transaction source

**Response:**
- `customerTrxId` - Customer transaction ID
- `receiptNumber` - Receipt number

**Error Handling:**
- ✅ **Empty Receipt Number:** Validates receipt number is returned
- ✅ **Transaction/Amount Logging:** Logs transaction number and amount applied
- ✅ **Full Response Logging:** Logs first 2000 chars on error

**Persisted To:** `FusionApplyReceipt` table

**Note:** One apply receipt per standard receipt

---

### 5. Journal Entries ✅

**Purpose:** Create accounting entries for service provider customers (non-NORMAL)

**SOAP Endpoint:** `/fscmService/JournalImportService`

**Operation:** `importJournals`

**Key Fields (Header):**
- `batchName` - Format: `{PeriodName}: {CustomerType}` (e.g., "Jan-26: SERVICE_PROVIDER")
- `batchDescription` - Format: `Journal Import: {TransactionNumber}`
- `ledgerId` - Ledger ID
- `accountingPeriodName` - Period name (e.g., "Jan-26")
- `accountingDate` - Accounting date
- `userSourceName` - Journal source
- `userCategoryName` - Journal category
- `errorToSuspenseFlag` - false
- `summaryFlag` - false
- `journalLines[]` - Array of journal lines

**Key Fields (Lines):**
- `ledgerId` - Ledger ID
- `periodName` - Period name
- `accountingDate` - Accounting date
- `userJeSourceName` - Journal source
- `jeCategoryName` - Journal category
- `chartOfAccountsId` - Chart of accounts ID
- `segment1` - Company code
- `segment2` - Account code
- `segment3` - Department code
- `segment4` - Cost center code
- `segment5-10` - Additional segments (typically "00")
- `currencyCode` - Currency
- `enteredCrAmount` - Credit amount
- `accountedCr` - Accounted credit amount
- `currencyConversionRate` - Conversion rate (1 for same currency)
- `currencyConversionType` - "Corporate"
- `currencyConversionDate` - Conversion date
- `transactionDate` - Transaction date
- `taxCode` - "N" (no tax)

**Response:**
- `result` or `return` - Journal Entry Header ID

**Error Handling:**
- ✅ **Warning on Failure:** Logs warning if JE Header ID is null (non-blocking)
- ✅ **Full Response Logging:** Logs first 2000 chars on warning

**Persisted To:** `FusionJournalHeader` and `FusionJournalLine` tables

**Note:** Only created for **non-NORMAL** customers (SERVICE_PROVIDER, etc.)

---

### 6. Inventory Transactions (Separate Cron)

**Purpose:** Sync Oracle Fusion inventory quantities to VendHQ

**Architecture:** **Separate from order sync** - runs independently every 30 minutes

**REST Endpoint:** Oracle Fusion REST API for inventory queries

**Flow:**
1. Fetch on-hand quantities from Oracle Fusion
2. Resolve matching VendHQ product by SKU
3. Resolve matching VendHQ outlet by region
4. Update VendHQ inventory counts
5. Record transaction in `FusionInvTxn` table

**Service:** `FusionInvToVendHqService`

**Cron Schedule:** `0 */30 * * * *` (every 30 minutes)

**Persisted To:** `FusionInvTxn` table

---

## Error Handling Strategy

### Critical Errors (STOP Sync)

These errors will **STOP** the sync cycle and mark the order as FAILED:

1. **Invoice Status E**
   - `serviceStatus = "E"`
   - Transaction number is null
   - Error logged with full XML response

2. **Empty Transaction Number**
   - Invoice created but no transaction number returned
   - Prevents all downstream operations (receipts, journals)

3. **Empty Receipt Numbers**
   - Standard receipt, misc receipt, or apply receipt returns empty receipt number

4. **Configuration Errors**
   - Missing FusionSalesMetadata
   - Missing bank/cash account configuration
   - Missing receipt method configuration

### Non-Critical Errors (WARN Only)

These errors are logged but do **NOT** stop the sync:

1. **Journal Import Failure**
   - Journal entry is optional for NORMAL customers
   - Logged as warning with full response

2. **Missing Payment Mapping**
   - Order continues without receipt method
   - Logged as warning

---

## Troubleshooting Common Errors

### 1. Invoice Status E with Null Transaction Number

**Symptoms:**
```
Invoice created: txn=N/A, status=E
Transaction Number: null
Customer Trx ID: N/A
Status: E
```

**Root Causes:**
- Invalid customer account number
- Missing or invalid business unit
- Invalid transaction source or type
- Missing payment terms
- Invalid invoice line data (item number, UOM, tax classification)
- Duplicate invoice (Oracle validation)
- Date/period closed in Oracle

**Resolution:**
1. Check the full error XML in logs (first 2000 chars logged)
2. Verify customer configuration in FusionSalesMetadata
3. Verify business unit in FusionBusinessUnitMap
4. Verify item master data in Oracle (item number, UOM, tax)
5. Check Oracle period status (open/closed)
6. Review Oracle AR logs for detailed error

**New Behavior (After Fix):**
- ✅ Sync cycle **STOPS** on Status E
- ✅ Error message extracted from XML
- ✅ Full context logged (transaction number, customer trx ID, error message)
- ✅ Order marked as FAILED

### 2. Missing Misc Receipts

**Symptoms:**
- Standard receipts created
- No misc receipts in FusionMiscReceipt table
- Cash rounding or bank charges not posted

**Root Causes:**
- Payment method not configured as "Cash Rounding"
- Bank charge not configured in FusionReceiptMethod
- Missing receivable activity configuration

**Resolution:**
1. Verify FusionReceiptMethod has correct receiptBankCharge
2. Verify FusionSalesMetadata has recActivityNameBank and recActivityNameCash
3. Check transformation service logs for "Receipt method not configured"

### 3. Apply Receipt Failures

**Symptoms:**
- Receipts created but not applied to invoice
- FusionApplyReceipt table empty

**Root Causes:**
- Invalid transaction number (from failed invoice)
- Invalid receipt number
- Amount mismatch

**Resolution:**
1. Verify invoice was created successfully with valid transaction number
2. Verify standard receipt was created with valid receipt number
3. Check transformation service applyReceipts mapping

### 4. Journal Entry Failures

**Symptoms:**
- Journal entry returns null JE Header ID
- Warning logged but sync continues

**Root Causes:**
- Invalid chart of accounts ID
- Invalid segment values
- Missing journal source/category in Oracle
- Period closed

**Resolution:**
1. Review ServiceProviderJournalMeta configuration
2. Verify journal source and category exist in Oracle
3. Check period status in Oracle GL
4. Review Oracle GL logs

**Note:** Journal failures are **non-blocking** for NORMAL customers

---

## Database Tables

### Input Tables
- `OrderSyncQueue` - Orders pending sync
- `BackupOdooOrder`, `BackupVendHqSale`, `BackupIbqOrder` - Backup order data

### Configuration Tables
- `FusionSalesMetadata` - Customer type metadata
- `FusionBusinessUnitMap` - Business unit mapping
- `FusionReceiptMethod` - Receipt method configuration
- `ServiceProviderJournalMeta` - Journal entry configuration
- `VendHqOutlet` - Outlet information
- `VendHqRegister` - Register/bank account information

### Output Tables (Oracle Audit)
- `FusionInvoiceHeader` - Invoice headers
- `FusionInvoiceLine` - Invoice lines
- `FusionStandardReceipt` - Standard receipts
- `FusionMiscReceipt` - Miscellaneous receipts
- `FusionApplyReceipt` - Applied receipts
- `FusionJournalHeader` - Journal headers
- `FusionJournalLine` - Journal lines
- `FusionInvTxn` - Inventory transactions (separate cron)

---

## API Endpoints

### Debug Invoice Creation
```bash
curl -X POST \
  -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/debug/invoice/SA
```

### Sync Single Order
```bash
curl -X POST \
  -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/sync-direct/YOUR_ORDER_ID
```

### Check Sync Tables
```bash
# Invoice Headers
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/fusion-invoice-headers?limit=5

# Invoice Lines
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/fusion-invoice-lines?limit=5

# Standard Receipts
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/fusion-standard-receipts?limit=5

# Misc Receipts
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/fusion-misc-receipts?limit=5

# Apply Receipts
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/fusion-apply-receipts?limit=5

# Journal Headers
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/fusion-journal-headers?limit=5

# Inventory Transactions
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/admin/fusion-inv-txns?limit=5
```

---

## Architecture Notes

### TypeScript Implementation

The TypeScript implementation is a faithful port of the Java reference implementation:

**Java Reference:** `https://github.com/MUSTAQ-AHAMMAD/integration-Oracle`

**Key Mappings:**

| Java Class | TypeScript File |
|-----------|----------------|
| `FusionInvoiceClient.java` | `oracle-soap.client.ts` → `createSimpleInvoice()` |
| `FusionReceiptClient.java` | `oracle-soap.client.ts` → `createStandardReceipt()`, `createMiscellaneousReceipt()`, `createApplyReceipt()` |
| `FusionJournalClient.java` | `oracle-soap.client.ts` → `importJournalEntry()` |
| `VendHQSalesToFusionInvRecTransBackup.java` | `fusion-transformation.service.ts` → `buildSalePayloads()` |
| `FusionInvoiceMapping.java` | `fusion-transformation.service.ts` (invoice mapping) |
| `FusionStdReceiptMapping.java` | `fusion-transformation.service.ts` (standard receipt mapping) |
| `FusionMiscReceiptMapping.java` | `fusion-transformation.service.ts` (misc receipt mapping) |
| `FusionApplyReceiptMapping.java` | `fusion-transformation.service.ts` (apply receipt mapping) |
| `FusionJournalEntryMapping.java` | `fusion-transformation.service.ts` (journal mapping) |
| `VendHQSalesToFusionInvRecIntParallel.java` | `order-sync.processor.ts` → `handleOrderSync()` |

### Retry Strategy

All SOAP operations use exponential backoff retry:
- **Attempts:** 3
- **Delays:** 5s, 10s, 20s
- **Circuit Breaker:** Enabled for all operations

### Idempotency

Duplicate orders are detected via:
- **Idempotency Key:** `{odooOrderId}:{operation}:{branchCode}`
- **Audit Table:** `AuditLog`
- **Status:** Orders marked as DUPLICATE if already synced

---

## Success Criteria

After a successful sync cycle, you should see:

✅ `OrderSyncQueue.status = SYNCED`  
✅ `FusionInvoiceHeader` created with valid `txnNumber`  
✅ `FusionInvoiceLine` records created  
✅ `FusionStandardReceipt` records created (one per payment)  
✅ `FusionMiscReceipt` records created (for cash rounding, bank charges)  
✅ `FusionApplyReceipt` records created (one per standard receipt)  
✅ `FusionJournalHeader` created (if non-NORMAL customer)  
✅ `FusionJournalLine` records created (if journal created)  
✅ `AuditLog` entry created with status SUCCESS  

---

## Change Log

### 2026-06-28 - Critical Fixes

**1. Invoice Status E Detection ✅**
- Added explicit check for `serviceStatus = "E"`
- Extract and log error message from response
- Throw error to stop sync cycle
- Log first 2000 chars of XML response

**2. Transaction Number Validation ✅**
- Validate transaction number is not null/empty
- Throw error if missing (prevents downstream failures)

**3. Receipt Number Validation ✅**
- Validate all receipt operations return valid receipt numbers
- Throw error on empty receipt number
- Enhanced logging with context (amount, transaction number)

**4. Journal Entry Error Handling ✅**
- Convert journal errors to warnings (non-blocking)
- Log full response on failure

**5. Improved Logging ✅**
- All operations log success with ✅ prefix
- All errors log with ❌ prefix
- All warnings log with ⚠️ prefix
- Include full context in error messages

---

## Related Documentation

- [API Quick Reference](../API_QUICK_REFERENCE.md)
- [Oracle Sync Quick Start](../ORACLE_SYNC_QUICK_START.md)
- [Store Config Population](./STORE_CONFIG_POPULATION.md)
- [Oracle Sync Payment Fix](./ORACLE_SYNC_PAYMENT_FIX.md)
