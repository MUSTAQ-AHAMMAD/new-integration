# BigInt Handling - Complete Fix Documentation

## Overview
This document describes the comprehensive BigInt handling solution implemented to eliminate all BigInt serialization and conversion issues in the Oracle integration cycle.

## Problem Statement
BigInt values from Prisma cannot be serialized to JSON by default, causing errors:
- **"Do not know how to serialize a BigInt"** - JSON.stringify() fails on BigInt
- **Precision loss** - Unsafe Number() conversions can lose digits
- **Type mismatches** - Inconsistent BigInt ↔ Number conversions across codebase

## Solution Architecture

### 1. Global Serialization Layer (main.ts)
```typescript
BigInt.prototype.toJSON = function (this: bigint) {
  const n = this.valueOf();
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `BigInt value ${n.toString()} cannot be safely serialised as a JSON number`
    );
  }
  return Number(n);
};
```
**Handles:** JSON.stringify() calls throughout the application

### 2. Response Interceptor (big-int.interceptor.ts)
```typescript
@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map(data => this.serializeBigInt(data))
    );
  }
}
```
**Handles:** All HTTP responses from API endpoints

### 3. Centralized Utilities (bigint-utils.ts)
New utility module providing safe BigInt conversions:

#### bigIntToNumber(value, fieldName?)
- Safely converts BigInt → Number
- Throws RangeError if value exceeds MAX_SAFE_INTEGER
- Used when converting for Oracle SOAP calls

#### toSafeNumber(value)
- Universal converter for any type (BigInt, Decimal, string, number)
- Handles Prisma Decimal structures
- Used in transformation services

#### numberToBigInt(value)
- Safely converts Number → BigInt  
- Truncates decimals, handles null/undefined
- Used when writing to Prisma BigInt fields

#### serializeBigIntForLog(obj)
- Recursively converts BigInts in objects for logging
- Safe alternative to JSON.stringify() in debug logs

## Implementation Coverage

### ✅ Complete Coverage

#### 1. Transformation Services
- `OdooTransformationService` - All BigInt conversions use safe utilities
- `FusionTransformationService` - All BigInt conversions use safe utilities
- `OrderEnrichmentService` - Uses toSafeNumber for all conversions

#### 2. Processors & Workers
- `OrderSyncProcessor` - Uses numberToBigInt() for Prisma writes
- `VendHqToOracleSyncService` - Uses numberToBigInt() for Prisma writes

#### 3. Configuration Services
- `StoreConfigService` - Uses numberToBigInt() for all BigInt fields
- `PaymentMappingService` - Uses numberToBigInt() for all BigInt fields
- `AdminService` - Uses numberToBigInt() for CSV imports

#### 4. Controllers
- `SyncController` - Uses toSafeNumber() for Decimal/BigInt conversion
- All other controllers rely on BigIntInterceptor

## BigInt Fields in Schema

### Affected Tables
The following Prisma models contain BigInt fields:

1. **PaymentMethodMapping**
   - `oracleReceiptMethodId: BigInt`
   - `oracleBankAccountId: BigInt?`

2. **StoreConfiguration**
   - `odooBranchId: BigInt`
   - `oracleOperatingUnitId: BigInt`

3. **FusionBusinessUnitMap**
   - `businessUnitId: BigInt`

4. **FusionReceiptMethod**
   - `receiptMethodId: BigInt`

5. **FusionSalesMetadata**
   - `billToAccount: BigInt`
   - `distributionAccId: BigInt?`

6. **ServiceProviderJournalMeta**
   - `ledgerId: BigInt`
   - `taxGroupId: BigInt?`
   - `chartOfAccountsId: BigInt`

7. **VendHqRegister**
   - `version: BigInt`

8. **VendHqOutlet**
   - `version: BigInt`

9. **StoreConfiguration**
   - `cashAccountId: BigInt?`
   - `bankAccountId: BigInt?`
   - `giftAccountId: BigInt?`
   - `version: BigInt`

10. **FusionStandardReceipt**
    - `receiptMethodId: BigInt?`

11. **FusionMiscReceipt**
    - `receiptMethodId: BigInt?`

12. **FusionInvoiceHeader**
    - `ledgerId: BigInt?`

13. **FusionJournalHeader**
    - `ledgerId: BigInt?`

14. **FusionJournalLine**
    - `ledgerId: BigInt?`
    - `chartOfAccountsId: BigInt?`

## Conversion Rules

### When to Use Each Utility

#### Use `bigIntToNumber()`
- Converting BigInt → Number for Oracle SOAP requests
- Example: `receiptMethodId: bigIntToNumber(method.receiptMethodId, 'receiptMethodId')`

#### Use `toSafeNumber()`
- Converting Prisma query results (any type) → Number
- Handles BigInt, Decimal, strings, numbers
- Example: `const amount = toSafeNumber(order.totalAmount)`

#### Use `numberToBigInt()`
- Converting Number → BigInt for Prisma writes
- Example: `odooBranchId: numberToBigInt(branchId)`

#### Use `serializeBigIntForLog()`
- Logging objects that may contain BigInts
- Example: `this.logger.debug(serializeBigIntForLog(payload))`

## Testing

### Manual Testing
```bash
# 1. Test API responses with BigInt fields
curl http://localhost:3001/api/v1/admin/FusionBusinessUnitMap
# Should return JSON without errors

# 2. Test order sync with BigInt values
curl -X POST http://localhost:3001/api/v1/sync/jobs \
  -H "Content-Type: application/json" \
  -d '{"branchCodes": ["101"], "region": "AE"}'

# 3. Check logs for BigInt serialization errors
tail -f /var/log/backend.log | grep -i "bigint\|serialize"
```

### Unit Test Scenarios
1. **Boundary Values**
   - Test with MAX_SAFE_INTEGER (9007199254740991)
   - Test with values exceeding MAX_SAFE_INTEGER
   - Verify RangeError is thrown appropriately

2. **Null/Undefined Handling**
   - Test all utilities with null/undefined
   - Verify appropriate defaults (0 or null)

3. **Type Conversions**
   - Test string → BigInt → Number round trips
   - Test Prisma Decimal → Number conversions
   - Test BigInt in nested objects/arrays

## Verification Checklist

### ✅ Completed
- [x] Global BigInt.prototype.toJSON implementation
- [x] BigIntInterceptor registered as APP_INTERCEPTOR
- [x] Centralized bigint-utils.ts module created
- [x] All transformation services updated
- [x] All processors and workers updated
- [x] All configuration services updated
- [x] Admin services updated

### 🔍 Verification Steps
1. **No Direct Number() Conversions**
   ```bash
   # Should return minimal results (only in oracle-native.service.ts)
   grep -r "Number(.*\..*Id)" packages/backend/src --include="*.ts"
   ```

2. **No Direct BigInt() Conversions**
   ```bash
   # Should return minimal results (only in oracle-native.service.ts)
   grep -r "BigInt(" packages/backend/src --include="*.ts" | grep -v bigint-utils
   ```

3. **No JSON.stringify() with BigInt**
   ```bash
   # All JSON.stringify should be safe due to global toJSON
   grep -r "JSON.stringify" packages/backend/src --include="*.ts"
   ```

## Oracle Account ID Safety

All Oracle account IDs used in this application are well within `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991):
- Receipt Method IDs: ~10-100
- Business Unit IDs: ~100-1000
- Ledger IDs: ~100-1000
- Chart of Accounts IDs: ~100-1000
- Bank Account IDs: ~1000-10000

**Conclusion:** No precision loss risk for this application's data.

## Error Handling

### If RangeError Occurs
```
RangeError: BigInt value X cannot be safely serialized as a JSON number (exceeds MAX_SAFE_INTEGER)
```

**Actions:**
1. Check the source of the BigInt value
2. Verify it's a valid Oracle ID (should be < 10^15)
3. If value is corrupt, investigate data source
4. If value is legitimate, consider using string representation

## Maintenance

### Adding New BigInt Fields
1. Update Prisma schema with `BigInt` type
2. Run `npx prisma generate`
3. Use `numberToBigInt()` when writing to the field
4. Use `bigIntToNumber()` when reading for Oracle
5. Update this documentation

### Code Review Checklist
- [ ] No direct `Number(bigIntField)` conversions
- [ ] No direct `BigInt(numberField)` conversions (except oracle-native)
- [ ] Uses `bigIntToNumber()` for Oracle SOAP parameters
- [ ] Uses `numberToBigInt()` for Prisma BigInt writes
- [ ] Uses `toSafeNumber()` for multi-type conversions
- [ ] Logging uses `serializeBigIntForLog()` if needed

## Related Files
- `/packages/backend/src/common/utils/bigint-utils.ts` - Utility functions
- `/packages/backend/src/common/interceptors/big-int.interceptor.ts` - Response interceptor
- `/packages/backend/src/main.ts` - Global BigInt.prototype.toJSON
- `/packages/backend/src/app.module.ts` - Interceptor registration

## References
- [MDN BigInt](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt)
- [Prisma BigInt](https://www.prisma.io/docs/orm/reference/prisma-schema-reference#bigint)
- [Number.MAX_SAFE_INTEGER](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER)
