# Oracle Invoice SOAP Payload Fix

## Problem Statement

The Oracle invoice SOAP payload structure needed to match the exact format that successfully creates invoices in Oracle Fusion. The working payload (Invoice #2678575) showed specific requirements that were not fully implemented in the codebase.

## Key Changes

### 1. Root Structure Change

**Before:**
```xml
<typ:createSimpleInvoice>
  <typ:invoice>
    <!-- fields here -->
  </typ:invoice>
</typ:createSimpleInvoice>
```

**After:**
```xml
<typ:createSimpleInvoice>
  <typ:invoiceHeaderInformation>
    <!-- fields here -->
  </typ:invoiceHeaderInformation>
</typ:createSimpleInvoice>
```

The wrapper element changed from `<typ:invoice>` to `<typ:invoiceHeaderInformation>` to match Oracle's expected structure.

### 2. Quantity Field with unitCode Attribute

**Before:**
```xml
<typ1:Quantity>2</typ1:Quantity>
<typ1:UOMCode>Ea</typ1:UOMCode>
```

**After:**
```xml
<typ1:Quantity unitCode="Ea">2</typ1:Quantity>
```

The unit of measure is now an attribute on the Quantity element instead of a separate tag. Defaults to "Ea" if not specified.

### 3. UnitSellingPrice with currencyCode Attribute

**Before:**
```xml
<typ1:UnitSellingPrice>50</typ1:UnitSellingPrice>
<typ1:CurrencyCode>AED</typ1:CurrencyCode>
```

**After:**
```xml
<typ1:UnitSellingPrice currencyCode="AED">50</typ1:UnitSellingPrice>
```

The currency code is now an attribute on the UnitSellingPrice element instead of a separate tag.

### 4. Field Ordering

Fields are now ordered to match the working payload:
1. BusinessUnit
2. TransactionSource
3. TransactionType
4. TrxDate
5. GlDate
6. BillToCustomerName
7. BillToAccountNumber
8. BillToLocation
9. PaymentTermsName
10. InvoiceCurrencyCode
11. ConversionRateType
12. ConversionRate (optional)
13. ConversionDate (optional)
14. Invoice Lines

### 5. Discount Item Handling

For discount items, `MemoLineName` is now prioritized over `ItemNumber`:

**Regular Item:**
```xml
<typ1:InvoiceLine>
  <typ1:LineNumber>1</typ1:LineNumber>
  <typ1:ItemNumber>6287020283765</typ1:ItemNumber>
  <typ1:Description>Product description</typ1:Description>
  ...
</typ1:InvoiceLine>
```

**Discount Item:**
```xml
<typ1:InvoiceLine>
  <typ1:LineNumber>2</typ1:LineNumber>
  <typ1:MemoLineName>Discount Item</typ1:MemoLineName>
  <typ1:Description>Discount description</typ1:Description>
  ...
</typ1:InvoiceLine>
```

## Complete Working Example

### Input Payload Object

```typescript
{
  businessUnit: "AlQurashi-KSA",
  transactionSource: "Vend",
  transactionType: "Vend Invoice",
  trxDate: new Date("2026-06-01"),
  saleDate: new Date("2026-06-01"),
  billToCustomerName: "Red Sea Mall",
  billToAccountNumber: "9",
  billToLocation: "9",
  paymentTermsName: "IMMEDIATE",
  invoiceCurrencyCode: "SAR",
  conversionRateType: "Corporate",
  conversionRate: 1,
  invoiceLines: [
    {
      lineNumber: 1,
      itemNumber: "6287020283765",
      description: "Product description",
      quantity: 1,
      uomCode: "Ea",
      unitSellingPrice: 300,
      currencyCode: "SAR",
      taxClassificationCode: "OUTPUT-GOODS-DOM-15%",
      salesOrder: "REDSEA/60822",
      salesOrderLine: "1"
    },
    {
      lineNumber: 2,
      memoLineName: "Discount Item",
      description: "Discount",
      quantity: 1,
      unitSellingPrice: -10,
      currencyCode: "SAR",
      taxClassificationCode: "OUTPUT-GOODS-DOM-15%",
      salesOrder: "REDSEA/60822",
      salesOrderLine: "2"
    }
  ]
}
```

### Generated XML Output

```xml
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:typ="http://xmlns.oracle.com/apps/financials/receivables/transactions/invoices/invoiceService/types/"
  xmlns:typ1="http://xmlns.oracle.com/apps/financials/receivables/transactions/invoices/invoiceService/">
  <soapenv:Header/>
  <soapenv:Body>
    <typ:createSimpleInvoice>
      <typ:invoiceHeaderInformation>
        <typ1:BusinessUnit>AlQurashi-KSA</typ1:BusinessUnit>
        <typ1:TransactionSource>Vend</typ1:TransactionSource>
        <typ1:TransactionType>Vend Invoice</typ1:TransactionType>
        <typ1:TrxDate>2026-06-01</typ1:TrxDate>
        <typ1:GlDate>2026-06-01</typ1:GlDate>
        <typ1:BillToCustomerName>Red Sea Mall</typ1:BillToCustomerName>
        <typ1:BillToAccountNumber>9</typ1:BillToAccountNumber>
        <typ1:BillToLocation>9</typ1:BillToLocation>
        <typ1:PaymentTermsName>IMMEDIATE</typ1:PaymentTermsName>
        <typ1:InvoiceCurrencyCode>SAR</typ1:InvoiceCurrencyCode>
        <typ1:ConversionRateType>Corporate</typ1:ConversionRateType>
        <typ1:ConversionRate>1</typ1:ConversionRate>
        
        <typ1:InvoiceLine>
          <typ1:LineNumber>1</typ1:LineNumber>
          <typ1:ItemNumber>6287020283765</typ1:ItemNumber>
          <typ1:Description>Product description</typ1:Description>
          <typ1:Quantity unitCode="Ea">1</typ1:Quantity>
          <typ1:UnitSellingPrice currencyCode="SAR">300</typ1:UnitSellingPrice>
          <typ1:TaxClassificationCode>OUTPUT-GOODS-DOM-15%</typ1:TaxClassificationCode>
          <typ1:SalesOrder>REDSEA/60822</typ1:SalesOrder>
          <typ1:SalesOrderLine>1</typ1:SalesOrderLine>
        </typ1:InvoiceLine>
        
        <typ1:InvoiceLine>
          <typ1:LineNumber>2</typ1:LineNumber>
          <typ1:MemoLineName>Discount Item</typ1:MemoLineName>
          <typ1:Description>Discount</typ1:Description>
          <typ1:Quantity unitCode="Ea">1</typ1:Quantity>
          <typ1:UnitSellingPrice currencyCode="SAR">-10</typ1:UnitSellingPrice>
          <typ1:TaxClassificationCode>OUTPUT-GOODS-DOM-15%</typ1:TaxClassificationCode>
          <typ1:SalesOrder>REDSEA/60822</typ1:SalesOrder>
          <typ1:SalesOrderLine>2</typ1:SalesOrderLine>
        </typ1:InvoiceLine>
        
      </typ:invoiceHeaderInformation>
    </typ:createSimpleInvoice>
  </soapenv:Body>
</soapenv:Envelope>
```

## Field Mapping Reference

| Your Field | XML Field | Notes |
|------------|-----------|-------|
| TransactionDate | TrxDate | Different name! |
| AccountingDate | GlDate | Different name! |
| BillToCustomerNumber | BillToAccountNumber | Different name! |
| BillToSite | BillToLocation | Different name! |
| PaymentTerms | PaymentTermsName | Different name! |
| receivablesInvoiceLines | InvoiceLine | Different name! |
| quantity | Quantity with unitCode attribute | Attribute added |
| unitSellingPrice | UnitSellingPrice with currencyCode attribute | Attribute added |
| MemoLine | MemoLineName | Use for discount items |

## Code Changes

### File: `packages/backend/src/clients/oracle/oracle-soap.client.ts`

1. Updated `buildInvoiceSoap()` function to generate correct XML structure
2. Changed wrapper from `<typ:invoice>` to `<typ:invoiceHeaderInformation>`
3. Added `unitCode` attribute to Quantity (defaults to "Ea")
4. Added `currencyCode` attribute to UnitSellingPrice
5. Removed separate `<typ1:UOMCode>` and `<typ1:CurrencyCode>` tags
6. Reordered fields to match working payload
7. Prioritize MemoLineName over ItemNumber for discount items

### File: `packages/backend/src/clients/oracle/oracle-soap.client.spec.ts`

Added comprehensive tests:
- Test invoiceHeaderInformation wrapper
- Test unitCode attribute in Quantity field
- Test currencyCode attribute in UnitSellingPrice field
- Test MemoLineName prioritization for discount items
- Test custom uomCode support
- Test ItemNumber usage when MemoLineName is absent

## Expected Impact

### Before Fix
- ❌ Payload structure didn't match Oracle's working format
- ❌ Separate UOMCode and CurrencyCode tags
- ❌ Used `<typ:invoice>` wrapper
- ⚠️ Potential compatibility issues with Oracle Fusion

### After Fix
- ✅ Payload structure exactly matches working format (Invoice #2678575)
- ✅ Attributes on Quantity and UnitSellingPrice
- ✅ Uses `<typ:invoiceHeaderInformation>` wrapper
- ✅ Proper handling of discount items with MemoLineName
- ✅ Field ordering matches successful payload

## Testing

### Manual Testing

```bash
# Run the Oracle SOAP client tests
cd packages/backend
npm test -- oracle-soap.client.spec.ts
```

### Integration Testing

1. Create a test invoice with both regular and discount items
2. Verify the generated XML matches the working payload structure
3. Submit to Oracle Fusion sandbox environment
4. Verify successful invoice creation
5. Check that transaction number is returned properly

## Rollback Plan

If issues occur after deployment:

```bash
# Revert the commits
git revert HEAD~2..HEAD
git push
```

## Related Files

- `packages/backend/src/clients/oracle/oracle-soap.client.ts` - Main SOAP client
- `packages/backend/src/clients/oracle/oracle-soap.client.spec.ts` - Tests
- `packages/backend/src/sync/odoo-transformation.service.ts` - Odoo transformation
- `packages/backend/src/sync/fusion-transformation.service.ts` - VendHQ transformation

## References

- Working Invoice: #2678575 (successful creation)
- Oracle Fusion Receivables Invoice Service WSDL
- Oracle Invoice API Documentation

## Notes

- No changes needed to transformation services (OdooTransformationService, FusionTransformationService) as they already populate the InvoiceHeader interface correctly
- The InvoiceHeader interface remains unchanged; only the XML generation logic was updated
- All existing functionality preserved, only XML structure improved
