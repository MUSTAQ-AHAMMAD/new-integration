# Oracle SOAP Integration - Complete Implementation

This directory contains the complete Oracle Fusion Cloud SOAP integration for the VendHQ to Oracle sync pipeline.

## Overview

The integration consists of three main service layers:

1. **OracleSoapClient** - Low-level SOAP client that handles XML request/response for all Oracle Fusion services
2. **Oracle Service Wrappers** - Three high-level services that provide business logic and caching:
   - `OracleCustomerService` - Resolves customer IDs from account numbers
   - `OracleTaxService` - Fetches tax classification codes for products
   - `OracleUomService` - Fetches unit of measure codes for products

## Implementation Status

✅ **All services are fully implemented and production-ready**

### What's Implemented

#### 1. OracleSoapClient (`oracle-soap.client.ts`)
- ✅ `createSimpleInvoice()` - Create AR invoices in Oracle
- ✅ `createStandardReceipt()` - Create standard cash receipts
- ✅ `createApplyReceipt()` - Apply receipts to invoices
- ✅ `createMiscellaneousReceipt()` - Create miscellaneous receipts (bank charges, rounding)
- ✅ `importJournalEntry()` - Import GL journal entries
- ✅ `getCustomerProfile()` - Query customer profiles by account number
- ✅ `getItemMaster()` - Query item master data (UOM, tax codes)

#### 2. OracleCustomerService (`oracle-customer.service.ts`)
- ✅ `getCustomerId()` - Resolve customer ID from account number
- ✅ `getCustomerProfile()` - Get full customer profile including payment terms
- ✅ In-memory caching for performance
- ✅ Graceful error handling (returns null on failure)

#### 3. OracleTaxService (`oracle-tax.service.ts`)
- ✅ `getTaxClassificationCode()` - Fetch tax codes for products
- ✅ Database fallback (queries StoreConfiguration and FusionInvoiceLine)
- ✅ In-memory caching for performance
- ✅ Graceful error handling (returns null on failure)

#### 4. OracleUomService (`oracle-uom.service.ts`)
- ✅ `getUomCode()` - Fetch unit of measure codes for products
- ✅ Database fallback (queries FusionInvTxn)
- ✅ In-memory caching for performance
- ✅ Default fallback to "EA" (Each) on error
- ✅ Graceful error handling (never throws)

## Usage

### 1. Configure Oracle Credentials

Oracle credentials can be configured in two ways:

#### Option A: Environment Variables (Quick Setup)
```bash
ORACLE_SOAP_BASE_URL=https://your-oracle-instance.fa.us2.oraclecloud.com
ORACLE_REST_BASE_URL=https://your-oracle-instance.fa.us2.oraclecloud.com/fscmRestApi/resources/11.13.18.05
ORACLE_USERNAME=your_username
ORACLE_PASSWORD=your_password
```

#### Option B: Database (Production Recommended)
Store credentials in the `FusionCredential` table:
```sql
INSERT INTO "FusionCredential" (
  "hostName",
  "server",
  "username",
  "password",
  "active"
) VALUES (
  'your-oracle-instance.fa.us2.oraclecloud.com',
  'US2',
  'your_username',
  'your_password',
  true
);
```

### 2. Using the Services in Code

```typescript
import { OracleCustomerService } from './clients/oracle/oracle-customer.service';
import { OracleTaxService } from './clients/oracle/oracle-tax.service';
import { OracleUomService } from './clients/oracle/oracle-uom.service';

// Inject services via NestJS dependency injection
constructor(
  private readonly customerService: OracleCustomerService,
  private readonly taxService: OracleTaxService,
  private readonly uomService: OracleUomService,
) {}

// Resolve customer ID
const customerId = await this.customerService.getCustomerId('CUST-001', 'AE');
// Returns: 300000012345678 or null

// Get tax classification code
const taxCode = await this.taxService.getTaxClassificationCode('ITEM-001', 'AE');
// Returns: "VAT_STANDARD" or null

// Get UOM code
const uomCode = await this.uomService.getUomCode('ITEM-001', 'AE');
// Returns: "EA" (never null - defaults to "EA")
```

### 3. Caching Behavior

All three services implement multi-layer caching:

1. **In-Memory Cache** (fastest)
   - Key format: `${region}:${identifier}`
   - Persists for the lifetime of the service instance
   - Cleared on service restart

2. **Database Cache** (fallback)
   - Tax Service: Queries `StoreConfiguration` and `FusionInvoiceLine`
   - UOM Service: Queries `FusionInvTxn`
   - Customer Service: No DB cache (always queries Oracle)

3. **Oracle SOAP Call** (slowest)
   - Only called if cache misses
   - Results are cached after successful call

## Testing

### Run Integration Tests
```bash
pnpm --filter backend test oracle-services.integration.spec.ts
```

### Test Coverage
- ✅ Basic functionality for all three services
- ✅ Caching behavior verification
- ✅ Error handling and null returns
- ✅ Default value fallback (UOM service)

## Architecture

### SOAP Request Flow
```
Application Code
    ↓
OracleCustomerService / OracleTaxService / OracleUomService
    ↓
OracleSoapClient (builds SOAP XML)
    ↓
CircuitBreakerService (handles retries)
    ↓
Axios HTTP Client
    ↓
Oracle Fusion Cloud
```

### SOAP Response Flow
```
Oracle Fusion Cloud (returns SOAP XML)
    ↓
Axios HTTP Client
    ↓
CircuitBreakerService (handles faults)
    ↓
OracleSoapClient (parses XML, extracts data)
    ↓
OracleCustomerService / OracleTaxService / OracleUomService (caches result)
    ↓
Application Code
```

## Error Handling

All services implement graceful error handling:

### OracleCustomerService
- Returns `null` on SOAP fault or network error
- Logs error details for debugging
- Does not throw exceptions

### OracleTaxService
- Returns `null` on SOAP fault or network error
- Logs error details for debugging
- Does not throw exceptions

### OracleUomService
- Returns default `"EA"` on SOAP fault or network error
- Logs error details for debugging
- Does not throw exceptions
- **Never returns null** - always provides a fallback value

## Performance Considerations

1. **Cache Hit Rate**: First call to Oracle is cached, subsequent calls are instant
2. **Database Fallback**: Tax/UOM services check local DB before calling Oracle
3. **Circuit Breaker**: Automatic retry with exponential backoff (5s, 10s, 20s)
4. **Timeouts**: All SOAP calls timeout after 60 seconds
5. **Graceful Degradation**: Services return null/default instead of failing the entire sync

## Troubleshooting

### Issue: "Oracle SOAP connectivity check failed"
- **Cause**: Oracle credentials not configured or network issue
- **Fix**: Verify `ORACLE_SOAP_BASE_URL` and credentials in `.env` or `FusionCredential` table

### Issue: "SOAP fault: Invalid credentials"
- **Cause**: Incorrect Oracle username/password
- **Fix**: Update credentials in `.env` or `FusionCredential` table

### Issue: Tax/UOM codes always null
- **Cause**: Oracle Item Master Service not accessible or items don't exist
- **Fix**: 
  1. Verify items exist in Oracle Item Master
  2. Check SOAP endpoint is accessible
  3. Review Oracle logs for authorization issues

### Issue: Customer IDs always null
- **Cause**: Oracle Customer Profile Service not accessible or customers don't exist
- **Fix**:
  1. Verify customers exist in Oracle with matching account numbers
  2. Check SOAP endpoint is accessible
  3. Review Oracle logs for authorization issues

## Documentation

- `IMPLEMENTATION_SUMMARY.md` - Detailed implementation notes
- `ORACLE_DTO_MAPPING.md` - Complete mapping from Java to TypeScript
- `oracle-services.integration.spec.ts` - Integration test suite

## Java Reference

This implementation is based on the Java integration:
- **Repository**: https://github.com/MUSTAQ-AHAMMAD/integration-Oracle
- **Key Classes**:
  - `FusionCustomerProfileClient.java` → `OracleCustomerService`
  - `FusionInvoiceMapping.java` → `OracleTaxService` + `OracleUomService`
  - `FusionSOAPClient.java` → `OracleSoapClient`

## Support

For issues or questions:
1. Review the troubleshooting section above
2. Check Oracle Fusion Cloud logs for SOAP faults
3. Enable debug logging: `LOG_LEVEL=debug`
4. Contact the integration team with detailed error logs
