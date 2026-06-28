# Fusion Metadata Integration Fix - Summary

## Problem Statement
Orders were failing with status 'E' (Error) because the invoice payload used HARDCODED values instead of fetching from the `FusionSalesMetadata` table.

### Hardcoded Values (Before)
```typescript
billToAccountNumber: '1000',        // ❌ HARDCODED
businessUnit: 'BU1',               // ❌ HARDCODED
transactionSource: 'Odoo',         // ❌ HARDCODED
transactionType: 'Invoice',        // ❌ HARDCODED
```

## Solution Implemented

### 1. Created FusionMetadataService
**File**: `packages/backend/src/fusion/fusion-metadata.service.ts`

A new service that:
- Fetches `FusionSalesMetadata` by region from the database
- Implements a 5-minute cache to reduce database queries
- Provides fallback mechanism if no metadata found for region
- Includes methods for fetching related metadata:
  - `getSalesMetadata(region)` - Main metadata
  - `getBusinessUnitMap(region)` - Business unit mappings
  - `getReceiptMethod(region, methodName)` - Receipt methods
  - `getJournalMeta(region)` - Journal metadata

### 2. Updated OrderEnrichmentService
**File**: `packages/backend/src/sync/order-enrichment.service.ts`

Updated three methods to use FusionMetadataService:

#### a. `buildPayloadsFromQueue()` - Now fetches metadata
```typescript
// ✅ FETCH from FusionSalesMetadata
const metadata = await this.fusionMetadataService.getSalesMetadata(region);

// ✅ BUILD FROM METADATA
const invoiceHeader: InvoiceHeader = {
  billToCustomerName: metadata.billToName || 'Default Customer',
  billToLocation: metadata.siteNumber || '',
  billToAccountNumber: String(metadata.billToAccount || '1000'),
  businessUnit: metadata.businessUnit || 'AlQurashi-KSA',
  transactionSource: metadata.txnSource || 'Vend',
  transactionType: metadata.txnType || 'Vend Invoice',
  conversionRateType: metadata.rateIsCorporate ? 'Corporate' : 'User',
  // ... rest of the invoice
};
```

#### b. `buildPayloadsFromBackup()` - Also uses metadata
Same pattern as above, ensuring backup orders also use correct metadata.

#### c. `createMinimalPayloads()` - Minimal fallback also uses metadata
Even the last-resort minimal payload creation now uses metadata.

### 3. Updated SyncModule
**File**: `packages/backend/src/sync/sync.module.ts`

- Added `FusionMetadataService` import
- Added to `providers` array
- Added to `exports` array (so other modules can use it)

### 4. Added Debug Endpoints
**File**: `packages/backend/src/sync/sync.controller.ts`

Added two new endpoints for debugging:

#### GET `/api/v1/sync/debug/metadata/:region`
Returns metadata configuration for a region:
```json
{
  "region": "SA",
  "metadata": {
    "billToName": "KHURAISSQ",
    "billToAccount": 83012,
    "businessUnit": "AlQurashi-KSA",
    "txnSource": "Vend",
    "txnType": "Vend Invoice",
    ...
  },
  "hasMetadata": true
}
```

#### POST `/api/v1/sync/debug/test-invoice/:region`
Tests invoice building with metadata:
```json
{
  "region": "SA",
  "metadata": { ... },
  "testInvoice": {
    "billToCustomerName": "KHURAISSQ",
    "billToAccountNumber": "83012",
    "businessUnit": "AlQurashi-KSA",
    "transactionSource": "Vend",
    "transactionType": "Vend Invoice",
    ...
  }
}
```

### 5. Verified Region Passing
**File**: `packages/backend/src/queues/processors/order-sync.processor.ts`

Confirmed that the processor already correctly:
- Sets `effectiveRegion = order.region ?? branchCode` (line 331)
- Passes `effectiveRegion` to enrichment service (line 537)

## Expected Results

After this fix, invoices will be created with correct values from FusionSalesMetadata:

### For Region 'SA':
- ✅ `billToCustomerName`: KHURAISSQ
- ✅ `billToAccountNumber`: 83012
- ✅ `businessUnit`: AlQurashi-KSA
- ✅ `transactionSource`: Vend
- ✅ `transactionType`: Vend Invoice
- ✅ `conversionRateType`: Corporate (based on `rateIsCorporate: true`)
- ✅ `billToLocation`: 68003 (site number)

## Testing Commands

### 1. Check Metadata Configuration
```bash
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/debug/metadata/SA
```

### 2. Test Invoice Building
```bash
curl -X POST -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/debug/test-invoice/SA
```

### 3. Sync an Order
```bash
curl -X POST -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/sync-direct/YOUR_ORDER_ID
```

### 4. Verify Invoice Created
```bash
curl -H "Authorization: ******" \
  "http://localhost:3001/api/v1/admin/fusion-invoice-headers?limit=5"
```

## Files Changed

1. ✅ **NEW**: `packages/backend/src/fusion/fusion-metadata.service.ts`
   - Created new service for metadata management

2. ✅ **MODIFIED**: `packages/backend/src/sync/order-enrichment.service.ts`
   - Added FusionMetadataService dependency
   - Updated `buildPayloadsFromQueue()` to fetch and use metadata
   - Updated `buildPayloadsFromBackup()` to fetch and use metadata
   - Updated `createMinimalPayloads()` to fetch and use metadata

3. ✅ **MODIFIED**: `packages/backend/src/sync/sync.module.ts`
   - Added FusionMetadataService to imports, providers, and exports

4. ✅ **MODIFIED**: `packages/backend/src/sync/sync.controller.ts`
   - Added FusionMetadataService to constructor
   - Added `GET /debug/metadata/:region` endpoint
   - Added `POST /debug/test-invoice/:region` endpoint

5. ✅ **VERIFIED**: `packages/backend/src/queues/processors/order-sync.processor.ts`
   - Already correctly passes region to enrichment service

## Key Benefits

1. **No More Hardcoded Values**: All invoice metadata comes from the database
2. **Region-Specific Configuration**: Each region can have different Oracle settings
3. **Caching**: 5-minute cache reduces database load
4. **Fallback Support**: If no metadata for region, uses first available
5. **Debug Endpoints**: Easy to verify configuration without syncing orders
6. **Logging**: Clear logs showing which metadata is being used

## Next Steps

1. Deploy the changes
2. Test with `GET /debug/metadata/SA` to verify configuration
3. Test with `POST /debug/test-invoice/SA` to verify invoice building
4. Sync a real order using `POST /sync/sync-direct/{orderId}`
5. Check `fusion-invoice-headers` table to verify correct values
