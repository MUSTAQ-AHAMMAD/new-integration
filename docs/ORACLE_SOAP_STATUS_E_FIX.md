# Oracle SOAP Status E Error Message Extraction Fix

## Problem

Oracle Fusion SOAP API was returning `Status E` (error status) responses **without visible error messages** in the application logs. The previous implementation only checked 4 XML tags for error messages:
- `ErrorMessage` / `errorMessage`
- `Message` / `message`

This caused issues when Oracle returned errors in different XML tag formats, resulting in generic "Unknown error" messages that made debugging impossible.

## Root Cause

Oracle Fusion SOAP responses vary significantly based on:
- **API version** (older vs newer Oracle Cloud releases)
- **Service type** (Invoice, Receipt, Journal, Customer services)
- **Error severity** (validation errors, business logic errors, system errors)
- **Configuration** (tenant-specific Oracle setup)

Different error scenarios use different XML tag names to convey error information.

## Solution Implemented

### 1. Comprehensive Error Extraction Function

Created `extractErrorMessage()` function that checks **20+ XML tags** commonly used by Oracle:

```typescript
function extractErrorMessage(xml: string): string {
  const errorTags = [
    // Standard error message tags
    'ErrorMessage', 'errorMessage',
    'Message', 'message',
    // Detailed error tags
    'Detail', 'detail',
    'Text', 'text',
    'Reason', 'reason',
    // Oracle-specific error tags
    'ErrorDetail', 'errorDetail',
    'ErrorDescription', 'errorDescription',
    'FaultText', 'faultText',
    'Description', 'description',
    // Status-specific tags
    'StatusMessage', 'statusMessage',
    'StatusText', 'statusText',
    'ValidationError', 'validationError',
  ];
  
  // Try each tag...
}
```

### 2. Pattern-Based Fallback

If no specific error tag is found, the function uses regex patterns to extract text from common error wrappers:
- `<error>...</error>`
- `<fault>...</fault>`
- `<exception>...</exception>`

### 3. Enhanced Logging

When Status E is detected:
- **If error message found**: Logs error details + first 2000 chars of XML
- **If NO error message found**: Logs the **FULL XML response** for debugging

```typescript
if (!errorMessage || errorMessage === '') {
  this.logger.error(
    `⚠️  Status E detected but NO error message found in response!\n` +
    `  This may indicate an Oracle API issue or unexpected XML format.\n` +
    `  FULL Response XML (for debugging):\n${xml}`,
  );
}
```

### 4. Better Error Messages

Improved error messages thrown to the application:
- Clear indication of Status E
- Transaction number and Customer Trx ID included
- Specific guidance when no error details available

## Testing

Added comprehensive test cases in `oracle-soap.client.spec.ts`:

1. ✅ Status E with `ErrorMessage` tag
2. ✅ Status E with `Detail` tag  
3. ✅ Status E with `Text` tag
4. ✅ Status E with **no error message tags** (tests fallback behavior)

## Benefits

### For Developers
- **Full XML logged** when error message extraction fails
- Can identify which XML tags Oracle is using for errors
- Can extend error extraction easily

### For Operations
- **Clear error messages** in logs for troubleshooting
- **Transaction IDs** included for Oracle support tickets
- **Actionable information** instead of "Unknown error"

### For Users
- Better error reporting in the application
- Faster issue resolution
- More transparent failure reasons

## How to Debug Future Issues

If you encounter a Status E with no error message:

1. **Check backend logs** for the full XML response:
   ```bash
   pm2 logs backend | grep "Status E"
   ```

2. **Look for the warning**:
   ```
   ⚠️  Status E detected but NO error message found in response!
   ```

3. **Examine the FULL Response XML** logged below the warning

4. **Identify the error tag** Oracle is using (if any)

5. **Update `extractErrorMessage()`** to include the new tag:
   ```typescript
   const errorTags = [
     // ... existing tags ...
     'YourNewTag',
     'yourNewTag',
   ];
   ```

## Related Files

- **Implementation**: `packages/backend/src/clients/oracle/oracle-soap.client.ts`
- **Tests**: `packages/backend/src/clients/oracle/oracle-soap.client.spec.ts`
- **Documentation**: This file

## Oracle SOAP Response Examples

### Example 1: Standard Error Format
```xml
<soapenv:Envelope>
  <soapenv:Body>
    <ns:createSimpleInvoiceResponse>
      <ServiceStatus>E</ServiceStatus>
      <TransactionNumber>INV-12345</TransactionNumber>
      <ErrorMessage>Invalid customer account number</ErrorMessage>
    </ns:createSimpleInvoiceResponse>
  </soapenv:Body>
</soapenv:Envelope>
```

### Example 2: Detail Tag Format
```xml
<soapenv:Envelope>
  <soapenv:Body>
    <ns:createSimpleInvoiceResponse>
      <ServiceStatus>E</ServiceStatus>
      <TransactionNumber>INV-12345</TransactionNumber>
      <Detail>Payment terms IMMEDIATE not found for business unit US_BU</Detail>
    </ns:createSimpleInvoiceResponse>
  </soapenv:Body>
</soapenv:Envelope>
```

### Example 3: Text Tag Format (Validation Errors)
```xml
<soapenv:Envelope>
  <soapenv:Body>
    <ns:createSimpleInvoiceResponse>
      <ServiceStatus>E</ServiceStatus>
      <Text>Item number ITEM-001 not found in inventory</Text>
    </ns:createSimpleInvoiceResponse>
  </soapenv:Body>
</soapenv:Envelope>
```

## Version History

- **2026-06-29**: Initial implementation of comprehensive error extraction
  - Added 20+ error tag checks
  - Added pattern-based fallback
  - Enhanced logging for debugging
  - Added comprehensive test coverage
