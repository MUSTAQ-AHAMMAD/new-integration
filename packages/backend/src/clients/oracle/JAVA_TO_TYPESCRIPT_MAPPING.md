# Java to TypeScript Payload Mapping - Complete Implementation Guide

This document provides the complete TypeScript implementation that matches the working Java Oracle Fusion integration.

## Reference Java Repository
**Source**: https://github.com/MUSTAQ-AHAMMAD/integration-Oracle

## Key Findings from Java Analysis

### 1. INVOICE PAYLOAD

#### Java Model Files:
- `FusionSOAPClient/src/.../model/InvoiceHeader.java`
- `FusionSOAPClient/src/.../model/InvoiceLineModel.java`
- `IntegrationJobs/src/.../mapping/FusionInvoiceMapping.java`

#### Java InvoiceHeader Fields (Complete):
```java
private String billToCustomerName;      // Required
private String billToLocation;           // Required
private String billToAccountNumber;      // Required
private String businessUnit;             // Required
private String outletName;               // Optional
private Date saleDate;                   // Required
private String paymentTermsName;         // Optional (from CustomerProfileService)
private String transactionSource;        // Required
private String transactionType;          // Required
private String invoiceCurrencyCode;      // Required
private String conversionRateType;       // Required ("Corporate" or "User")
private List<InvoiceLineModel> invoiceLines; // Required
```

#### Java InvoiceLineModel Fields (Complete):
```java
private Integer lineNumber;              // Required, sequential from 1
private String itemNumber;               // Optional (product code)
private String memoLineName;             // Optional ("Discount Item" for discounts)
private String description;              // Required
private BigDecimal quantity;             // Required
private String uomCode;                  // Optional (from FusionUomService)
private BigDecimal unitSellingPrice;     // Required (absolute value)
private String currencyCode;             // Required (matches invoice currency)
private String salesOrder;               // Required (invoice/receipt number)
private String salesOrderLine;           // Optional (line number as string)
private String taxClassificationCode;    // Optional (from tax service)
```

#### TypeScript Implementation (CORRECT):
```typescript
export interface InvoiceHeader {
  billToCustomerName: string;
  billToLocation: string;
  billToAccountNumber: string;
  businessUnit: string;
  outletName?: string;
  saleDate: Date;
  paymentTermsName?: string;
  transactionSource: string;
  transactionType: string;
  invoiceCurrencyCode: string;
  conversionRateType: string;
  invoiceLines: InvoiceLine[];
}

export interface InvoiceLine {
  lineNumber: number;
  itemNumber?: string;
  memoLineName?: string;
  description?: string;
  quantity: number;
  uomCode?: string;
  unitSellingPrice: number;
  currencyCode: string;
  salesOrder: string;
  salesOrderLine?: string;
  taxClassificationCode?: string;
}
```

#### Java Mapping Logic (FusionInvoiceMapping.java):
```java
// Line 41-54
invoiceHeader.setBillToCustomerName(salesMetaData.getBillToName());
invoiceHeader.setBillToLocation(salesMetaData.getSiteNumber());
invoiceHeader.setBillToAccountNumber(String.valueOf(salesMetaData.getBillToAccount()));
invoiceHeader.setBusinessUnit(salesMetaData.getBusinessUnit());
invoiceHeader.setOutletName(outletDetail.getOutletName());
invoiceHeader.setSaleDate(MappingUtils.getTimeZoneOffsetDate(sale.getSaleDate(), hoursOffset, minutesOffset));
invoiceHeader.setTransactionSource(salesMetaData.getTxnSource());
invoiceHeader.setTransactionType(salesMetaData.getTxnType());
invoiceHeader.setInvoiceCurrencyCode(outletDetail.getCurrency());
invoiceHeader.setConversionRateType(salesMetaData.getRateIsCorporate().equals("1") ? "Corporate" : "User");

// Line 60-82 (Invoice Line)
invoiceLine.setLineNumber(invoiceHeader.getInvoiceLines().size()+1);
invoiceLine.setItemNumber(lineItem.getItemNumber());
if (lineItem.getItemName().equals("Discount Item"))
    invoiceLine.setMemoLineName("Discount Item");
invoiceLine.setQuantity(lineItem.getQuantity());
if (lineItem.getItemName().equals("Discount Item") && lineItem.getTotalPrice().intValue() > 0)
    invoiceLine.setQuantity(BigDecimal.valueOf(1));
invoiceLine.setDescription(itemMeta.getDescription());
invoiceLine.setUomCode(new FusionUomService(params, credential).getUomCode(itemMeta.getUomName()));
invoiceLine.setCurrencyCode(invoiceHeader.getInvoiceCurrencyCode());
BigDecimal sellingPrice = lineItem.getTotalPrice().divide(lineItem.getQuantity());
invoiceLine.setUnitSellingPrice(sellingPrice.abs());
invoiceLine.setSalesOrder(sale.getInvoiceNumber());
invoiceLine.setSalesOrderLine(String.valueOf(lineItem.getLineNumber()));
invoiceLine.setTaxClassificationCode(lineItem.getTaxName());
```

---

### 2. STANDARD RECEIPT PAYLOAD

#### Java Model File:
- `FusionSOAPClient/src/.../model/StandardReceiptRequest.java`
- `IntegrationJobs/src/.../mapping/FusionStdReceiptMapping.java`

#### Java StandardReceiptRequest Fields (Complete):
```java
private String currencyCode;             // Required
private Date saleDate;                   // Required
private Long receiptMethodId;            // Required (from FusionReceiptMethod)
private String receiptNumber;            // Required (format: "{PaymentType}-{TransactionNumber}")
private Long remittanceBankAccountId;    // Required (cash or bank account)
private String accountValue;             // Required (billToAccountNumber)
private String region;                   // Optional
private Long orgId;                      // Required (from FusionBusinessUnitMap)
private Long customerId;                 // Optional (from CustomerProfileService)
private BigDecimal receiptAmount;        // Required
```

#### TypeScript Implementation (CORRECT):
```typescript
export interface StandardReceiptRequest {
  currencyCode: string;
  saleDate: Date;
  receiptMethodId: number;
  receiptNumber: string;
  remittanceBankAccountId: number;
  accountValue: string;
  region?: string;
  orgId: number;
  customerId?: number;
  receiptAmount: number;
}
```

#### Java Mapping Logic (FusionStdReceiptMapping.java):
```java
// Line 28-38
standardReceipt.setCurrencyCode(invoice.getInvoiceCurrencyCode());
standardReceipt.setSaleDate(invoice.getSaleDate());
standardReceipt.setReceiptMethodId(receiptMethodMeta.getReceiptMethodId().longValue()); 
standardReceipt.setReceiptNumber(paymentType + "-" + transactionNumber);
standardReceipt.setRemittanceBankAccountId(receiptMethodMeta.getReceiptIsCash().equals("1") 
                                           ? registerDetails.getCashAccountId().longValue() 
                                           : registerDetails.getBankAccountId().longValue());
standardReceipt.setAccountValue(invoice.getBillToAccountNumber());
standardReceipt.setOrgId(session.getFusionBusinessUnitIdMapfindByRegion(outletDetail.getRegion()).getBusinessUnitId().longValue());
```

---

### 3. MISCELLANEOUS RECEIPT PAYLOAD

#### Java Model File:
- `FusionSOAPClient/src/.../model/MiscReceiptRequest.java`
- `IntegrationJobs/src/.../mapping/FusionMiscReceiptMapping.java`

#### Java MiscReceiptRequest Fields (Complete):
```java
private String currencyCode;             // Required
private Date saleDate;                   // Required
private Long receiptMethodId;            // Required
private String receiptMethodName;        // Required
private String receiptNumber;            // Required (format: "{PaymentType}-{TransactionNumber}-MISC")
private String bankAccountName;          // Required
private String receivableActivityName;   // Required
private Long orgId;                      // Required
private BigDecimal receiptAmount;        // Required (negative for adjustments)
```

#### TypeScript Implementation (CORRECT):
```typescript
export interface MiscReceiptRequest {
  currencyCode: string;
  saleDate: Date;
  receiptMethodId: number;
  receiptMethodName: string;
  receiptNumber: string;
  bankAccountName: string;
  receivableActivityName: string;
  orgId: number;
  receiptAmount: number;
}
```

#### Java Mapping Logic (FusionMiscReceiptMapping.java):
```java
// Line 31-43
miscReceiptRequest.setCurrencyCode(invoice.getInvoiceCurrencyCode());
miscReceiptRequest.setSaleDate(invoice.getSaleDate());
miscReceiptRequest.setReceiptMethodId(receiptMethodMeta.getReceiptMethodId().longValue()); 
miscReceiptRequest.setReceiptMethodName(!payment.getPaymentType().contains("Cash") ? payment.getPaymentType() : "Cash");
miscReceiptRequest.setReceiptNumber(payment.getPaymentType() + "-" + transactionNumber + "-MISC");
miscReceiptRequest.setBankAccountName(payment.getPaymentType().toLowerCase().contains("rounding")
                                      ? registerDetails.getCashAccount() : registerDetails.getBankAccount());
miscReceiptRequest.setReceivableActivityName(payment.getPaymentType().toLowerCase().equals("cash rounding") 
                                            ? metaMappings[1] : metaMappings[2]);
miscReceiptRequest.setOrgId(session.getFusionBusinessUnitIdMapfindByRegion(outletDetail.getRegion()).getBusinessUnitId().longValue());
```

---

### 4. APPLY RECEIPT PAYLOAD

#### Java Model File:
- `FusionSOAPClient/src/.../model/ApplyReceiptRequest.java`
- `IntegrationJobs/src/.../mapping/FusionApplyReceiptMapping.java`

#### Java ApplyReceiptRequest Fields (Complete) - **CRITICAL FIX**:
```java
private Date receiptDate;                // Required
private String transactionNumber;        // Required (from invoice creation response)
private String receiptNumber;            // Required (from standard receipt)
private BigDecimal amountApplied;        // Required
private String receiptCurrency;          // Required
private String transactionSource;        // Required
```

#### TypeScript Implementation (NEEDS FIX):
**CURRENT (WRONG)**:
```typescript
export interface ApplyReceiptRequest {
  transactionNumber: string;
  receiptNumber: string;
  amountApplied: number;
  receiptCurrency: string;
  transactionSource: string;
  accountingDate: Date;      // NOT IN JAVA
  applicationDate: Date;     // NOT IN JAVA
}
```

**CORRECT (MATCHES JAVA)**:
```typescript
export interface ApplyReceiptRequest {
  receiptDate: Date;           // FIELD NAME FROM JAVA
  transactionNumber: string;
  receiptNumber: string;
  amountApplied: number;
  receiptCurrency: string;
  transactionSource: string;
}
```

#### Java Mapping Logic (FusionApplyReceiptMapping.java):
```java
// Line 22-29
applyReceiptRequest.setReceiptDate(standardReceiptRequest.getSaleDate());
applyReceiptRequest.setTransactionNumber(receiptInvoiceResultMapping.get(standardReceiptRequest));
applyReceiptRequest.setReceiptNumber(standardReceiptRequest.getReceiptNumber());
applyReceiptRequest.setAmountApplied(standardReceiptRequest.getReceiptAmount());
applyReceiptRequest.setReceiptCurrency(standardReceiptRequest.getCurrencyCode());
applyReceiptRequest.setTransactionSource(transactionSource);
```

---

### 5. JOURNAL ENTRY PAYLOAD

#### Java Model Files:
- `FusionSOAPClient/src/.../model/JournalHeader.java`
- `FusionSOAPClient/src/.../model/JournalLine.java`
- `IntegrationJobs/src/.../mapping/FusionJournalEntryMapping.java`

#### Java JournalHeader Fields (Complete):
```java
private Long jeHeaderId;                 // Optional (output from Oracle)
private String batchName;                // Required
private String batchDescription;         // Optional
private Long ledgerId;                   // Required
private String accountingPeriodName;     // Required (format: "MMM-yy")
private Date accountingDate;             // Required
private String userSourceName;           // Required
private String userCategoryName;         // Required
private Boolean errorToSuspenseFlag;     // Required (false)
private Boolean summaryFlag;             // Required (false)
private String importDescriptiveFlexField; // Optional
private Long txnNumber;                  // Optional
private String customerType;             // Optional
private String cashCredit;               // Optional
private List<JournalLine> journalLines;  // Required
```

#### Java JournalLine Fields (Complete):
```java
private Long jeHeaderId;                 // Optional
private Integer jeLineNum;               // Required (sequential)
private Long ledgerId;                   // Required
private String periodName;               // Optional (format: "MMM-yy")
private Date accountingDate;             // Required
private String userJeSourceName;         // Required
private String userJeCategoryName;       // Required
private Long groupId;                    // Optional
private Long chartOfAccountsId;          // Optional
private String salesOrder;               // Optional
private String segment1;                 // Optional (Company)
private String segment2;                 // Optional (Account)
private String segment3;                 // Optional (Department)
private String segment4;                 // Optional (Cost Center)
private String segment5;                 // Optional
private String segment6;                 // Optional (Inter Company)
private String segment7;                 // Optional (Future Use)
private String segment8;                 // Optional
private String segment9;                 // Optional
private String segment10;                // Optional
private String currencyCode;             // Required
private BigDecimal enteredCrAmount;      // Optional (for credit lines)
private BigDecimal accountedCr;          // Optional (for credit lines)
private BigDecimal enteredDrAmount;      // Optional (for debit lines)
private BigDecimal accountedDr;          // Optional (for debit lines)
private String userCurrencyConversionType; // Optional
private Date currencyConversionDate;     // Optional
private BigDecimal currencyConversionRate; // Optional
private String currencyConversionType;   // Optional
private Boolean averageJournalFlag;      // Optional
private String jeCategoryName;           // Optional
private String jeSourceName;             // Optional
private String status;                   // Optional
private String taxCode;                  // Optional
private Date transactionDate;            // Optional
private String recordType;               // Optional
```

#### TypeScript Implementation (CORRECT):
```typescript
export interface JournalHeader {
  batchName: string;
  batchDescription?: string;
  ledgerId: number;
  accountingPeriodName: string;
  accountingDate: Date;
  userSourceName: string;
  userCategoryName: string;
  errorToSuspenseFlag?: boolean;
  summaryFlag?: boolean;
  journalLines: JournalLine[];
  jeHeaderId?: number;
}

export interface JournalLine {
  ledgerId: number;
  periodName?: string;
  accountingDate: Date;
  userJeSourceName: string;
  jeCategoryName: string;
  groupId?: number;
  chartOfAccountsId?: number;
  segment1?: string;
  segment2?: string;
  segment3?: string;
  segment4?: string;
  segment5?: string;
  segment6?: string;
  segment7?: string;
  segment8?: string;
  segment9?: string;
  segment10?: string;
  currencyCode: string;
  enteredDrAmount?: number;
  enteredCrAmount?: number;
  accountedDr?: number;
  accountedCr?: number;
  currencyConversionRate?: number;
  currencyConversionType?: string;
  currencyConversionDate?: Date;
  transactionDate?: Date;
  status?: string;
  taxCode?: string;
}
```

#### Java Mapping Logic (FusionJournalEntryMapping.java):
```java
// Line 150-165 (Journal Header)
journalHeader.setCustomerType(journalMapping.getServiceProvider());
journalHeader.setCashCredit(fixedCharge ? "CASH" : "CREDIT");
journalHeader.setBatchName(getPeriodName(invoice.getSaleDate()) + ": " + journalMapping.getServiceProvider());
journalHeader.setBatchDescription("Journal Import: " + transactionNumber);
journalHeader.setAccountingPeriodName(getPeriodName(invoice.getSaleDate()));
journalHeader.setAccountingDate(invoice.getSaleDate());
journalHeader.setLedgerId(journalMapping.getLedgerId().longValue());
journalHeader.setUserSourceName(journalMapping.getJeSource());
journalHeader.setUserCategoryName(journalMapping.getJeCategory());
journalHeader.setTxnNumber(Long.valueOf(transactionNumber));
journalHeader.setErrorToSuspenseFlag(false);
journalHeader.setSummaryFlag(false);

// Line 82-125 (Journal Line)
journalLine.setJeLineNum(journalHeader.getJournalLines().size()+1);
journalLine.setPeriodName(getPeriodName(invoice.getSaleDate())); // Format: "MMM-yy"
journalLine.setAccountingDate(invoice.getSaleDate());
journalLine.setCurrencyCode(invoice.getInvoiceCurrencyCode());
journalLine.setGroupId(journalHeader.getTxnNumber());
journalLine.setSalesOrder(invoiceLine.getSalesOrder());
journalLine.setLedgerId(journalMapping.getLedgerId().longValue());
journalLine.setChartOfAccountsId(journalMapping.getChartOfAccountsId().longValue());
journalLine.setJeSourceName(journalMapping.getJeSource());
journalLine.setJeCategoryName(journalMapping.getJeCategory());
journalLine.setUserJeSourceName(journalMapping.getJeSource());
journalLine.setUserJeCategoryName(journalMapping.getJeCategory());
journalLine.setSegment1(journalMapping.getCompany());
journalLine.setSegment2(journalMapping.getAccount());
journalLine.setSegment3(journalMapping.getDepartment());
journalLine.setSegment4(costCenterCode);
journalLine.setSegment5("00");
journalLine.setSegment6(journalMapping.getInterCompany());
journalLine.setSegment7(journalMapping.getFutUsed());
journalLine.setSegment8("00");
journalLine.setSegment9("00");
journalLine.setSegment10("00");
journalLine.setTransactionDate(invoice.getSaleDate());
if (!creditDebit.equals("CREDIT")) {
    journalLine.setEnteredCrAmount(charge);
    journalLine.setAccountedCr(charge);
} else {
    journalLine.setEnteredDrAmount(charge);
    journalLine.setAccountedDr(charge);
}
journalLine.setUserCurrencyConversionType("User");
journalLine.setCurrencyConversionType("Corporate");
journalLine.setCurrencyConversionRate(BigDecimal.valueOf(1L));
journalLine.setCurrencyConversionDate(invoice.getSaleDate());
journalLine.setTaxCode("N");
journalLine.setAverageJournalFlag(false);

// Line 168-170 (Period Name Format)
private String getPeriodName(Date saleDate) {
    DateFormat dateFormat = new SimpleDateFormat("MMM-yy");
    return dateFormat.format(saleDate);
}
```

---

## CRITICAL FIXES NEEDED

### 1. ApplyReceiptRequest Interface
**Problem**: TypeScript interface has wrong field names
**Solution**: Change `accountingDate` and `applicationDate` to `receiptDate`

### 2. Apply Receipt Mapping in fusion-transformation.service.ts
**Current (Line 280-288)**:
```typescript
const applyReceipts: ApplyReceiptRequest[] = standardReceipts.map((sr) => ({
  transactionNumber: txnNumber,
  receiptNumber: sr.receiptNumber,
  amountApplied: sr.receiptAmount,
  receiptCurrency: sr.currencyCode,
  transactionSource: invoiceHeader.transactionSource,
  accountingDate: saleDate,     // WRONG FIELD
  applicationDate: saleDate,    // WRONG FIELD
}));
```

**Fixed**:
```typescript
const applyReceipts: ApplyReceiptRequest[] = standardReceipts.map((sr) => ({
  receiptDate: saleDate,        // CORRECT FIELD NAME FROM JAVA
  transactionNumber: txnNumber,
  receiptNumber: sr.receiptNumber,
  amountApplied: sr.receiptAmount,
  receiptCurrency: sr.currencyCode,
  transactionSource: invoiceHeader.transactionSource,
}));
```

### 3. SOAP XML Builder (oracle-soap.client.ts)
**Problem**: XML builder must use correct field name
**Current**:
```typescript
${opt('AccountingDate', xmlDate(req.accountingDate))}
${opt('ApplicationDate', xmlDate(req.applicationDate))}
```

**Fixed**:
```typescript
${opt('ReceiptDate', xmlDate(req.receiptDate))}
```

---

## DATA SOURCE MAPPING

### From FusionSalesMetadata (region-based)
- billToCustomerName → `billToName`
- billToLocation → `siteNumber`
- billToAccountNumber → `billToAccount`
- businessUnit → `businessUnit`
- transactionSource → `txnSource`
- transactionType → `txnType`
- conversionRateType → `rateIsCorporate ? "Corporate" : "User"`
- receivableActivityName (cash) → `recActivityNameCash`
- receivableActivityName (bank) → `recActivityNameBank`

### From VendHqOutlet (outlet-based)
- invoiceCurrencyCode → `currency`
- outletName → `outletName`

### From FusionBusinessUnitMap (region-based)
- orgId → `businessUnitId`

### From VendHqRegister (outlet + register-based)
- remittanceBankAccountId (cash) → `cashAccountId`
- remittanceBankAccountId (bank) → `bankAccountId`
- bankAccountName (cash) → `cashAccount`
- bankAccountName (bank) → `bankAccount`

### From FusionReceiptMethod (payment method + region-based)
- receiptMethodId → `receiptMethodId`
- receiptMethodName → payment method name
- isCash → `receiptIsCash`

### From ServiceProviderJournalMeta (region-based)
- ledgerId → `ledgerId`
- userSourceName → `jeSource`
- userCategoryName → `jeCategory`
- chartOfAccountsId → `chartOfAccountsId`
- segment1 → `company`
- segment2 → `account`
- segment3 → `department`
- segment6 → `interCompany`
- segment7 → `futUsed`

### From CustomerProfileService (REST API call)
- paymentTermsName → fetched by account number
- customerId → fetched by account number

### From OracleUomService (REST API call)
- uomCode → fetched by product/item

### From OracleTaxService (lookup)
- taxClassificationCode → fetched by product/region

---

## VALIDATION CHECKLIST

Before syncing each order, validate:

1. **Invoice**:
   - [ ] billToCustomerName not empty
   - [ ] billToLocation not empty
   - [ ] billToAccountNumber not empty
   - [ ] businessUnit not empty
   - [ ] transactionSource not empty
   - [ ] transactionType not empty
   - [ ] invoiceCurrencyCode not empty
   - [ ] conversionRateType is "Corporate" or "User"
   - [ ] At least one invoice line
   - [ ] Each line has: lineNumber, quantity > 0, unitSellingPrice, currencyCode, salesOrder

2. **Standard Receipt**:
   - [ ] currencyCode not empty
   - [ ] receiptMethodId > 0
   - [ ] receiptNumber not empty
   - [ ] remittanceBankAccountId > 0
   - [ ] accountValue not empty
   - [ ] orgId > 0
   - [ ] receiptAmount > 0

3. **Misc Receipt**:
   - [ ] currencyCode not empty
   - [ ] receiptMethodId > 0
   - [ ] receiptMethodName not empty
   - [ ] receiptNumber not empty
   - [ ] bankAccountName not empty
   - [ ] receivableActivityName not empty
   - [ ] orgId > 0

4. **Apply Receipt**:
   - [ ] receiptDate is valid Date
   - [ ] transactionNumber not empty (from invoice response)
   - [ ] receiptNumber not empty
   - [ ] amountApplied > 0
   - [ ] receiptCurrency not empty
   - [ ] transactionSource not empty

5. **Journal Entry**:
   - [ ] batchName not empty
   - [ ] ledgerId > 0
   - [ ] accountingPeriodName not empty (format: "MMM-yy")
   - [ ] userSourceName not empty
   - [ ] userCategoryName not empty
   - [ ] At least one journal line
   - [ ] Each line has: ledgerId, accountingDate, userJeSourceName, jeCategoryName, currencyCode
   - [ ] Each line has either enteredCrAmount or enteredDrAmount (not both)

---

## SUMMARY OF CHANGES REQUIRED

1. **Fix ApplyReceiptRequest interface** in `oracle-soap.client.ts`:
   - Remove `accountingDate` and `applicationDate`
   - Add `receiptDate: Date`

2. **Update apply receipt SOAP builder** in `oracle-soap.client.ts`:
   - Change XML tags from `AccountingDate`/`ApplicationDate` to `ReceiptDate`

3. **Fix apply receipt mapping** in `fusion-transformation.service.ts`:
   - Use `receiptDate` instead of `accountingDate`/`applicationDate`

4. **Add paymentTermsName** to invoice header mapping:
   - Call CustomerProfileService to fetch payment terms
   - Set on InvoiceHeader before sending

5. **Enhance validation**:
   - Add validation functions for all payload types
   - Log validation errors clearly
   - Prevent syncing incomplete payloads

This completes the comprehensive mapping between Java and TypeScript implementations.
