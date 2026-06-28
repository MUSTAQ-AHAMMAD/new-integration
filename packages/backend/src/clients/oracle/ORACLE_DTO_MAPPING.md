# Oracle Fusion SOAP DTO Mapping Guide

This document maps Java classes from the `integration-Oracle` repository to TypeScript interfaces in the Node.js implementation.

## Source Reference
**Java Repository**: https://github.com/MUSTAQ-AHAMMAD/integration-Oracle

---

## 1. InvoiceLine (InvoiceLineModel.java)

### Java Source
`FusionSOAPClient/src/innovate/tamergroup/fusion/soap/model/InvoiceLineModel.java`

### TypeScript Interface
```typescript
export interface InvoiceLine {
  lineNumber: number;              // Line sequence number (1, 2, 3...)
  itemNumber?: string;             // Product ID from VendHQ
  memoLineName?: string;           // Set to "Discount Item" for discount lines
  description?: string;            // Product name
  quantity: number;                // Quantity (forced to 1 for discount items with total > 0)
  uomCode?: string;                // Unit of Measure code (e.g., "EA", "EACH") - fetched from Oracle UOM service
  unitSellingPrice: number;        // Unit price (calculated as totalPrice / quantity)
  currencyCode: string;            // Currency code (e.g., "AED", "USD")
  salesOrder: string;              // Invoice number from VendHQ (NOT saleNumber - use invoiceNumber field)
  salesOrderLine?: string;         // Line number as string
  taxClassificationCode?: string;  // Tax classification (fetched from Oracle based on product)
}
```

### Field Mapping from Java
```java
// InvoiceLineModel.java fields:
private Long lineNumber;              → lineNumber: number
private String itemNumber;            → itemNumber?: string
private String memoLineName;          → memoLineName?: string
private String description;           → description?: string
private BigDecimal quantity;          → quantity: number
private String uomCode;               → uomCode?: string
private BigDecimal unitSellingPrice;  → unitSellingPrice: number
private String currencyCode;          → currencyCode: string
private String salesOrder;            → salesOrder: string
private String salesOrderLine;        → salesOrderLine?: string
private String taxClassificationCode; → taxClassificationCode?: string
```

### Critical Implementation Notes

1. **memoLineName**: Set to `"Discount Item"` when product name is "Discount Item"
2. **quantity**: If discount item and totalPrice > 0, force quantity to 1
3. **uomCode**: Must be fetched from Oracle Fusion UOM service and cached
4. **taxClassificationCode**: Must be fetched from Oracle based on product configuration
5. **salesOrder**: ⚠️ **CRITICAL** - Use `sale.invoiceNumber` NOT `sale.saleNumber`

---

## 2. InvoiceHeader (InvoiceHeader.java)

### Java Source
`FusionSOAPClient/src/innovate/tamergroup/fusion/soap/model/InvoiceHeader.java`

### TypeScript Interface
```typescript
export interface InvoiceHeader {
  billToCustomerName: string;       // Customer name from FusionSalesMetadata
  billToLocation: string;           // Site number from FusionSalesMetadata
  billToAccountNumber: string;      // Account number from FusionSalesMetadata
  businessUnit: string;             // Business unit from FusionSalesMetadata
  outletName?: string;              // Outlet name from VendHQ
  saleDate: Date;                   // Sale date/time
  paymentTermsName?: string;        // Payment terms (optional)
  transactionSource: string;        // Transaction source from FusionSalesMetadata
  transactionType: string;          // Transaction type from FusionSalesMetadata
  invoiceCurrencyCode: string;      // Currency code
  conversionRateType: string;       // "Corporate" or "User" based on FusionSalesMetadata
  invoiceLines: InvoiceLine[];      // Array of invoice lines
}
```

---

## 3. StandardReceiptRequest (StandardReceiptRequest.java)

### Java Source
`FusionSOAPClient/src/innovate/tamergroup/fusion/soap/model/StandardReceiptRequest.java`

### TypeScript Interface
```typescript
export interface StandardReceiptRequest {
  currencyCode: string;              // Currency code
  saleDate: Date;                    // Sale date/time
  receiptMethodId: number;           // Receipt method ID from FusionReceiptMethod
  receiptNumber: string;             // Format: "{paymentMethod}-{invoiceNumber}"
  remittanceBankAccountId: number;   // Bank/cash account ID from VendHqRegister
  accountValue: string;              // Customer account number
  region?: string;                   // Region code (e.g., "AE", "KW", "OM") - for duplicate checking
  orgId: number;                     // Organization/Business Unit ID
  customerId?: number;               // Customer ID (resolved from accountValue)
  receiptAmount: number;             // Payment amount
}
```

### Field Mapping from Java
```java
// StandardReceiptRequest.java fields:
private String currencyCode;           → currencyCode: string
private Date saleDate;                 → saleDate: Date
private Long receiptMethodId;          → receiptMethodId: number
private String receiptNumber;          → receiptNumber: string
private Long remittanceBankAccountId;  → remittanceBankAccountId: number
private String accountValue;           → accountValue: string
private String region;                 → region?: string
private Long orgId;                    → orgId: number
private Long customerId;               → customerId?: number
private BigDecimal receiptAmount;      → receiptAmount: number
```

### Critical Implementation Notes

1. **region**: Required for duplicate receipt checking in Oracle
2. **customerId**: Must be resolved by querying Oracle Customer Profile service using accountValue
3. **receiptNumber**: Format is `{paymentMethod}-{invoiceNumber}` (e.g., "Cash-INV-12345")
4. **remittanceBankAccountId**: Selected based on `receiptIsCash` flag from FusionReceiptMethod

---

## 4. ApplyReceiptRequest (ApplyReceiptRequest.java)

### Java Source
`FusionSOAPClient/src/innovate/tamergroup/fusion/soap/model/ApplyReceiptRequest.java`

### TypeScript Interface
```typescript
export interface ApplyReceiptRequest {
  transactionNumber: string;      // Invoice transaction number
  receiptNumber: string;          // Receipt number (matches StandardReceiptRequest)
  amountApplied: number;          // Amount to apply to invoice
  receiptCurrency: string;        // Currency code
  transactionSource: string;      // Transaction source
  accountingDate: Date;           // Accounting date (same as saleDate)
  applicationDate: Date;          // Application date (same as saleDate)
}
```

### Field Mapping from Java
```java
// ApplyReceiptRequest.java fields:
private String transactionNumber;  → transactionNumber: string
private String receiptNumber;      → receiptNumber: string
private BigDecimal amountApplied;  → amountApplied: number
private String receiptCurrency;    → receiptCurrency: string
private String transactionSource;  → transactionSource: string
private Date accountingDate;       → accountingDate: Date
private Date applicationDate;      → applicationDate: Date
```

### Critical Implementation Notes

1. **accountingDate & applicationDate**: Both should use the sale date (receiptDate)
2. Created one ApplyReceipt for each StandardReceipt
3. Links receipt to invoice for payment application

---

## 5. MiscReceiptRequest (MiscReceiptRequest.java)

### Java Source
`FusionSOAPClient/src/innovate/tamergroup/fusion/soap/model/MiscReceiptRequest.java`

### TypeScript Interface
```typescript
export interface MiscReceiptRequest {
  currencyCode: string;              // Currency code
  saleDate: Date;                    // Sale date/time
  receiptMethodId: number;           // Receipt method ID
  receiptMethodName: string;         // Payment method name
  receiptNumber: string;             // Format: "{paymentMethod}-{invoiceNumber}-MISC"
  bankAccountName: string;           // Bank/cash account name
  receivableActivityName: string;    // Activity name (e.g., "Bank Charges", "Cash Rounding")
  orgId: number;                     // Organization/Business Unit ID
  receiptAmount: number;             // Negative amount for charges/rounding
}
```

### Critical Implementation Notes

1. Used for bank charges and cash rounding adjustments
2. **receiptAmount**: Always negative (charges deducted)
3. Bank charge calculation: `amount * bankCharge * (1 + tax)`
4. Regional caps: Debit Card in OM region capped at 10

---

## 6. JournalHeader (JournalHeader.java)

### Java Source
`FusionSOAPClient/src/innovate/tamergroup/fusion/soap/model/JournalHeader.java`

### TypeScript Interface
```typescript
export interface JournalHeader {
  batchName: string;                  // Format: "{date}: {customerType}"
  batchDescription?: string;          // Description of batch
  ledgerId: number;                   // Ledger ID from ServiceProviderJournalMeta
  accountingPeriodName: string;       // Period name (e.g., "Jan-26", "Feb-26")
  accountingDate: Date;               // Accounting date (sale date)
  userSourceName: string;             // Journal source name (e.g., "Vend")
  userCategoryName: string;           // Journal category name (e.g., "Vend")
  errorToSuspenseFlag?: boolean;      // Whether to send errors to suspense account
  summaryFlag?: boolean;              // Whether to summarize lines
  journalLines: JournalLine[];        // Array of journal lines
  jeHeaderId?: number;                // Journal entry header ID (returned by Oracle)
}
```

### Field Mapping from Java
```java
// JournalHeader.java fields:
private String batchName;              → batchName: string
private String batchDescription;       → batchDescription?: string
private Long ledgerId;                 → ledgerId: number
private String accountingPeriodName;   → accountingPeriodName: string
private Date accountingDate;           → accountingDate: Date
private String userSourceName;         → userSourceName: string
private String userCategoryName;       → userCategoryName: string
private Boolean errorToSuspenseFlag;   → errorToSuspenseFlag?: boolean
private Boolean summaryFlag;           → summaryFlag?: boolean
private List<JournalLine> journalLines;→ journalLines: JournalLine[]
private Long jeHeaderId;               → jeHeaderId?: number
```

### Critical Implementation Notes

1. Only created for non-NORMAL customer types
2. **accountingPeriodName**: Calculated from date (e.g., "Jan-26" for January 2026)
3. **batchName**: Format is `{YYYY-MM-DD}: {customerType}`

---

## 7. JournalLine (JournalLine.java)

### Java Source
`FusionSOAPClient/src/innovate/tamergroup/fusion/soap/model/JournalLine.java`

### TypeScript Interface
```typescript
export interface JournalLine {
  ledgerId: number;                     // Ledger ID
  periodName?: string;                  // Period name (e.g., "Jan-26")
  accountingDate: Date;                 // Accounting date
  userJeSourceName: string;             // Journal source name
  jeCategoryName: string;               // Journal category name
  groupId?: number;                     // Group ID (optional)
  chartOfAccountsId?: number;           // Chart of accounts ID
  segment1?: string;                    // Company segment
  segment2?: string;                    // Account segment
  segment3?: string;                    // Department segment
  segment4?: string;                    // Cost center segment
  segment5?: string;                    // Product segment
  segment6?: string;                    // Future segment
  segment7?: string;                    // Future segment
  segment8?: string;                    // Intercompany segment
  segment9?: string;                    // Future segment
  segment10?: string;                   // Future segment
  currencyCode: string;                 // Currency code
  enteredDrAmount?: number;             // Debit amount (transaction currency)
  enteredCrAmount?: number;             // Credit amount (transaction currency)
  accountedDr?: number;                 // Debit amount (ledger currency)
  accountedCr?: number;                 // Credit amount (ledger currency)
  currencyConversionRate?: number;      // Conversion rate
  currencyConversionType?: string;      // Conversion type
  currencyConversionDate?: Date;        // Conversion date
  transactionDate?: Date;               // Transaction date
  status?: string;                      // Status code (e.g., "P" for Posted)
  taxCode?: string;                     // Tax code (e.g., "N" for None)
}
```

### Field Mapping from Java (44 total fields)
```java
// JournalLine.java fields:
private Long ledgerId;                     → ledgerId: number
private String periodName;                 → periodName?: string
private Date accountingDate;               → accountingDate: Date
private String userJeSourceName;           → userJeSourceName: string
private String jeCategoryName;             → jeCategoryName: string
private Long groupId;                      → groupId?: number
private Long chartOfAccountsId;            → chartOfAccountsId?: number
private String segment1;                   → segment1?: string
private String segment2;                   → segment2?: string
private String segment3;                   → segment3?: string
private String segment4;                   → segment4?: string
private String segment5;                   → segment5?: string
private String segment6;                   → segment6?: string
private String segment7;                   → segment7?: string
private String segment8;                   → segment8?: string
private String segment9;                   → segment9?: string
private String segment10;                  → segment10?: string
private String currencyCode;               → currencyCode: string
private BigDecimal enteredDrAmount;        → enteredDrAmount?: number
private BigDecimal enteredCrAmount;        → enteredCrAmount?: number
private BigDecimal accountedDr;            → accountedDr?: number
private BigDecimal accountedCr;            → accountedCr?: number
private BigDecimal currencyConversionRate; → currencyConversionRate?: number
private String currencyConversionType;     → currencyConversionType?: string
private Date currencyConversionDate;       → currencyConversionDate?: Date
private Date transactionDate;              → transactionDate?: Date
private String status;                     → status?: string
private String taxCode;                    → taxCode?: string
```

### Critical Implementation Notes

1. Each invoice line creates a journal line with credit amount
2. Debit/Credit pairs must balance
3. **Segments**: 10 segments for flexible GL account structure
4. **Status**: "P" for Posted
5. **taxCode**: "N" for Non-taxable

---

## Database Field Mapping

### BackupVendHqSale → Oracle Invoice

⚠️ **CRITICAL FIELD NAME**:
- Java entity: `BackupVendhqSales.invoiceNumber` 
- Node.js Prisma: `BackupVendHqSale.invoiceNumber`
- Oracle field: `salesOrder`

```typescript
// CORRECT ✅
salesOrder: sale.invoiceNumber

// INCORRECT ❌ (what the current code uses)
salesOrder: sale.saleNumber
```

### Explanation
- `invoiceNumber`: The VendHQ invoice/receipt number (e.g., "INV-12345") - **THIS IS THE ORACLE REFERENCE**
- `saleNumber`: Internal sale ID/sequence number - **NOT USED IN ORACLE**

---

## Type Mapping Guide

| Java Type | TypeScript Type | Notes |
|-----------|----------------|-------|
| `String` | `string` | Direct mapping |
| `Long` | `number` | Use `number` for IDs, use `bigint` if > MAX_SAFE_INTEGER |
| `Integer` | `number` | Direct mapping |
| `BigDecimal` | `number` | Oracle amounts serialize to number via JSON |
| `Date` | `Date` | Serialize as ISO 8601 string for SOAP |
| `Boolean` | `boolean` | Direct mapping |
| `List<T>` | `T[]` | Array type |

---

## Oracle SOAP Endpoints

From Java `application.properties`:

```
# Invoice Service
https://{hostname}.fa.{region}.oraclecloud.com/fscmService/RecInvoiceService?WSDL

# Standard Receipt Service  
https://{hostname}.fa.{region}.oraclecloud.com/fscmService/StandardReceiptService?WSDL

# Miscellaneous Receipt Service
https://{hostname}.fa.{region}.oraclecloud.com/fscmService/MiscellaneousReceiptService?WSDL

# Journal Import Service
https://{hostname}.fa.{region}.oraclecloud.com/fscmService/JournalImportService?WSDL

# Customer Profile Service (for customer ID resolution)
https://{hostname}.fa.{region}.oraclecloud.com/fscmService/CustomerProfileService?WSDL
```

---

## Required Services (Not Yet Implemented)

### 1. UOM Code Lookup Service
**Purpose**: Fetch unit of measure codes from Oracle Fusion

**Java Reference**: `FusionInvoiceMapping.java` lines 57-84
```java
// Fetches UOM codes and caches in HashMap
String uomCode = uomCodeMap.get(itemNumber);
```

**Implementation Required**:
```typescript
class OracleUomService {
  async getUomCode(itemNumber: string, region: string): Promise<string | null> {
    // Call Oracle UOM service
    // Cache results in memory or database
    // Return UOM code (e.g., "EA", "EACH")
  }
}
```

### 2. Customer ID Resolution Service
**Purpose**: Resolve customer ID from account number

**Java Reference**: `FusionStdReceiptMapping.java`
```java
// Queries Oracle Customer Profile service
Long customerId = customerProfileClient.getCustomerId(accountValue);
```

**Implementation Required**:
```typescript
class OracleCustomerService {
  async getCustomerId(accountValue: string, region: string): Promise<number | null> {
    // Call Oracle Customer Profile service
    // Return customer ID
  }
}
```

### 3. Tax Classification Service
**Purpose**: Fetch tax classification codes for products

**Java Reference**: `FusionInvoiceMapping.java`
```java
// Fetches tax codes based on product configuration
String taxCode = getTaxClassificationCode(itemNumber);
```

**Implementation Required**:
```typescript
class OracleTaxService {
  async getTaxClassificationCode(itemNumber: string, region: string): Promise<string | null> {
    // Call Oracle Tax service
    // Return tax classification code
  }
}
```

---

## Transformation Logic Summary

### From Java FusionInvoiceMapping.java
1. For each line item:
   - If product name is "Discount Item":
     - Set `memoLineName = "Discount Item"`
     - If `totalPrice > 0`, force `quantity = 1`
   - Fetch `uomCode` from Oracle UOM service
   - Fetch `taxClassificationCode` from Oracle Tax service
   - Use `invoiceNumber` for `salesOrder` field

### From Java FusionStdReceiptMapping.java
1. For each payment:
   - Skip "Credit on Cust" payment methods
   - Determine bank account based on `receiptIsCash` flag
   - Fetch `customerId` from Oracle Customer Profile service
   - Set `region` field for duplicate checking
   - Format receipt number as `{paymentMethod}-{invoiceNumber}`

### From Java FusionMiscReceiptMapping.java
1. For non-cash payments:
   - Calculate bank charges: `amount * bankCharge * (1 + tax)`
   - Apply regional caps (e.g., Debit Card in OM capped at 10)
   - Use negative amounts for charges

2. For cash rounding:
   - Use cash account instead of bank account
   - Use negative amount

### From Java FusionJournalEntryMapping.java
1. Only for non-NORMAL customer types
2. Create journal lines for each invoice line with credit amounts
3. Calculate period name from date (e.g., "Jan-26")
4. Set segments from ServiceProviderJournalMeta configuration

---

## Testing Checklist

- [ ] Verify `invoiceNumber` is used (not `saleNumber`) for `salesOrder`
- [ ] Verify `uomCode` is populated for all invoice lines
- [ ] Verify `taxClassificationCode` is populated for all invoice lines
- [ ] Verify `region` is populated for all standard receipts
- [ ] Verify `customerId` is populated for all standard receipts
- [ ] Verify `memoLineName` is set for discount items
- [ ] Verify discount item quantity is forced to 1 when total > 0
- [ ] Verify journal entries are created for non-NORMAL customers
- [ ] Verify period names are calculated correctly (e.g., "Jan-26")
- [ ] Verify bank charge calculations match Java logic
- [ ] Verify regional caps are applied correctly

---

## References

- **Java Repository**: https://github.com/MUSTAQ-AHAMMAD/integration-Oracle
- **Java Models**: `FusionSOAPClient/src/.../model/`
- **Java Mappings**: `IntegrationJobs/src/.../mapping/`
- **Java SOAP Clients**: `FusionSOAPClient/src/.../services/`
- **TypeScript Implementation**: `packages/backend/src/clients/oracle/oracle-soap.client.ts`
- **Transformation Service**: `packages/backend/src/sync/fusion-transformation.service.ts`
