# Oracle Invoice Missing Fields Fix

## Problem Statement

The system was experiencing transaction number NULL issues when creating invoices in Oracle Fusion. Investigation revealed that the `createSimpleInvoice` SOAP payload was missing several fields required by Oracle's specification, most critically the **TrxDate** field.

## Root Cause

The original implementation was missing the following fields from the Oracle specification:

1. **TrxDate** (Critical) - Transaction/invoice date
2. ConversionRate (Optional) - Exchange rate value  
3. ConversionDate (Optional) - Exchange rate date
4. PurchaseOrder (Optional) - Purchase order reference
5. SoldToCustomerName (Optional) - Sold-to customer name
6. BillToContact (Optional) - Bill-to contact name

Without the **TrxDate** field, Oracle was either:
- Rejecting the invoice creation request
- Returning incomplete/invalid responses with empty transaction numbers
- Processing the invoice but failing to return the transaction number properly

## Solution

### 1. Updated InvoiceHeader Interface

**File:** `packages/backend/src/clients/oracle/oracle-soap.client.ts`

Added missing fields to the `InvoiceHeader` interface:

```typescript
export interface InvoiceHeader {
  billToCustomerName: string;
  billToLocation: string;
  billToAccountNumber: string;
  businessUnit: string;
  outletName?: string;
  saleDate: Date;
  trxDate?: Date; // ✅ NEW - Transaction date (invoice date) - critical field
  paymentTermsName?: string;
  transactionSource: string;
  transactionType: string;
  invoiceCurrencyCode: string;
  conversionRateType: string;
  conversionRate?: number; // ✅ NEW - Exchange rate value
  conversionDate?: Date; // ✅ NEW - Exchange rate date
  purchaseOrder?: string; // ✅ NEW - Purchase order reference
  soldToCustomerName?: string; // ✅ NEW - Sold-to customer name
  billToContact?: string; // ✅ NEW - Bill-to contact name
  invoiceLines: InvoiceLine[];
}
```

### 2. Updated SOAP XML Payload

**File:** `packages/backend/src/clients/oracle/oracle-soap.client.ts`

Updated the `buildInvoiceSoap()` function to include new fields in the XML:

```xml
<typ:invoice>
  <typ1:BillToCustomerName>...</typ1:BillToCustomerName>
  <typ1:BillToLocation>...</typ1:BillToLocation>
  <typ1:BillToAccountNumber>...</typ1:BillToAccountNumber>
  <typ1:BillToContact>...</typ1:BillToContact> <!-- NEW -->
  <typ1:SoldToCustomerName>...</typ1:SoldToCustomerName> <!-- NEW -->
  <typ1:BusinessUnit>...</typ1:BusinessUnit>
  <typ1:TransactionSource>...</typ1:TransactionSource>
  <typ1:TransactionType>...</typ1:TransactionType>
  <typ1:TrxDate>2024-01-15</typ1:TrxDate> <!-- NEW - CRITICAL -->
  <typ1:GlDate>2024-01-15</typ1:GlDate>
  <typ1:InvoiceCurrencyCode>AED</typ1:InvoiceCurrencyCode>
  <typ1:ConversionRateType>Corporate</typ1:ConversionRateType>
  <typ1:ConversionRate>1</typ1:ConversionRate> <!-- NEW -->
  <typ1:ConversionDate>2024-01-15</typ1:ConversionDate> <!-- NEW -->
  <typ1:PaymentTermsName>...</typ1:PaymentTermsName>
  <typ1:PurchaseOrder>...</typ1:PurchaseOrder> <!-- NEW -->
  ...
</typ:invoice>
```

### 3. Updated Odoo Transformation Service

**File:** `packages/backend/src/sync/odoo-transformation.service.ts`

Updated the invoice header creation to populate new fields:

```typescript
const invoiceHeader: InvoiceHeader = {
  // ... existing fields ...
  saleDate,
  trxDate: saleDate, // Transaction date same as sale date
  conversionRateType: 'Corporate',
  conversionRate: 1, // Default to 1 for Corporate rate type
  conversionDate: saleDate, // Conversion date same as transaction date
  purchaseOrder: undefined, // Could map from backup.clientOrderRef if needed
  soldToCustomerName: undefined, // Could map from backup.partnerName if needed
  billToContact: undefined, // Could map from contact data if available
  invoiceLines: [],
};
```

### 4. Updated Fusion Transformation Service

**File:** `packages/backend/src/sync/fusion-transformation.service.ts`

Updated the invoice header creation to populate new fields:

```typescript
const invoiceHeader: InvoiceHeader = {
  // ... existing fields ...
  saleDate,
  trxDate: saleDate, // Transaction date same as sale date
  conversionRateType: salesMeta.rateIsCorporate ? 'Corporate' : 'User',
  conversionRate: salesMeta.rateIsCorporate ? 1 : undefined,
  conversionDate: saleDate,
  purchaseOrder: undefined,
  soldToCustomerName: undefined,
  billToContact: undefined,
  invoiceLines: [],
};
```

### 5. Updated Tests

**File:** `packages/backend/src/clients/oracle/oracle-soap.client.spec.ts`

Updated the test helper function to include new required fields:

```typescript
function makeInvoiceHeader(overrides: Partial<InvoiceHeader> = {}): InvoiceHeader {
  return {
    // ... existing fields ...
    saleDate: new Date('2024-01-15T10:00:00Z'),
    trxDate: new Date('2024-01-15T10:00:00Z'),
    conversionRateType: 'Corporate',
    conversionRate: 1,
    conversionDate: new Date('2024-01-15T10:00:00Z'),
    // ... rest of fields ...
    ...overrides,
  };
}
```

## Field Mapping Details

### Critical Fields

| Field | Default Value | Source | Notes |
|-------|---------------|--------|-------|
| **trxDate** | `saleDate` | Same as GL date | **CRITICAL** - Required for Oracle to return transaction number |
| conversionRateType | 'Corporate' or 'User' | FusionSalesMetadata | Already existed |
| conversionRate | `1` for Corporate, `undefined` for User | Calculated | NEW - Defaults to 1 for Corporate rate |
| conversionDate | `saleDate` | Same as transaction date | NEW - Required when conversionRate is specified |

### Optional Fields (Future Enhancement)

| Field | Current Value | Future Mapping Options |
|-------|---------------|------------------------|
| purchaseOrder | `undefined` | Could map from `backup.clientOrderRef` or custom field |
| soldToCustomerName | `undefined` | Could map from `backup.partnerName` or customer data |
| billToContact | `undefined` | Could map from contact data if available |

## Expected Impact

### Before Fix
- ❌ Transaction number becoming NULL in database
- ❌ Oracle returning incomplete/invalid responses
- ❌ Invoice sync failures or incomplete data
- ❌ Missing critical field (TrxDate) in SOAP payload

### After Fix
- ✅ Transaction number properly returned from Oracle
- ✅ Complete SOAP payload matching Oracle specification
- ✅ Reliable invoice creation with all required fields
- ✅ Better alignment with Oracle Fusion API expectations

## Testing Recommendations

1. **Test Invoice Creation:**
   ```bash
   # Trigger a new invoice sync and verify transaction number is returned
   POST /sync/orders/process
   ```

2. **Verify SOAP Payload:**
   - Check logs for the complete SOAP XML payload
   - Ensure `<typ1:TrxDate>` is present in the XML
   - Verify other new fields are included when available

3. **Database Verification:**
   ```sql
   -- Check that txnNumber is no longer NULL
   SELECT id, txnNumber, customerTxnId, status, createdAt 
   FROM "FusionInvoiceHeader" 
   WHERE createdAt > NOW() - INTERVAL '1 hour'
   ORDER BY createdAt DESC;
   ```

4. **Oracle Response Validation:**
   - Monitor for Status E errors
   - Verify `TransactionNumber` is returned in successful responses
   - Check that transaction numbers are numeric and valid

## Rollback Plan

If issues occur after deployment:

1. Revert commits:
   ```bash
   git revert HEAD~2..HEAD
   ```

2. Monitor for:
   - Increased invoice creation failures
   - Different error patterns in Oracle responses
   - Any breaking changes in downstream processes

## Future Enhancements

1. **Populate Optional Fields:**
   - Map `purchaseOrder` from order reference fields
   - Map `soldToCustomerName` from customer data
   - Map `billToContact` from contact information

2. **Dynamic Conversion Rate:**
   - Fetch actual conversion rates for non-Corporate types
   - Cache conversion rates per date/currency pair
   - Handle multiple currencies properly

3. **Validation:**
   - Add pre-flight validation for all required fields
   - Implement field-level validation rules
   - Add warnings for missing optional fields

## References

- Oracle Fusion Receivables Invoice Service WSDL
- Oracle Invoice API Documentation
- Previous investigation: Transaction number NULL issue analysis

## Related Files

- `packages/backend/src/clients/oracle/oracle-soap.client.ts`
- `packages/backend/src/sync/odoo-transformation.service.ts`
- `packages/backend/src/sync/fusion-transformation.service.ts`
- `packages/backend/src/clients/oracle/oracle-soap.client.spec.ts`
