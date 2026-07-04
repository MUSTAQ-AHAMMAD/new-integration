# Timeout Protection for onModuleInit() Methods

## Overview
This document describes the implementation of timeout protection for all `onModuleInit()` lifecycle methods in the backend application to prevent startup hangs.

## Problem Statement
NestJS applications can hang indefinitely during startup if `onModuleInit()` lifecycle hooks never complete. This can happen when:
- Database connections time out
- External service credential resolution fails
- Network issues prevent initialization
- External APIs are unresponsive

## Solution
A `withTimeout()` utility function was created to wrap all async operations in `onModuleInit()` methods with a 30-second timeout.

## Implementation Details

### Timeout Utility
**Location:** `packages/backend/src/common/utils/timeout.ts`

```typescript
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName = 'Operation',
): Promise<T>
```

**Features:**
- Wraps any promise with a configurable timeout
- Provides descriptive error messages including operation name
- Properly cleans up timeout handles
- Default timeout: 30 seconds (`MODULE_INIT_TIMEOUT_MS`)

### Protected Services

#### 1. PrismaService
**File:** `packages/backend/src/prisma/prisma.service.ts`
- **Protected Operation:** Database connection (`this.$connect()`)
- **Fallback:** Application fails to start (expected behavior)

#### 2. OracleClient
**File:** `packages/backend/src/clients/oracle/oracle.client.ts`
- **Protected Operation:** Credential resolution from database
- **Fallback:** Uses environment variable credentials

#### 3. OracleSoapClient
**File:** `packages/backend/src/clients/oracle/oracle-soap.client.ts`
- **Protected Operation:** Credential resolution from database
- **Fallback:** Uses environment variable credentials

#### 4. SyncControlService
**File:** `packages/backend/src/sync/sync-control.service.ts`
- **Protected Operation:** Sync control records initialization
- **Fallback:** Service starts with existing records

#### 5. NotificationsService
**File:** `packages/backend/src/notifications/notifications.service.ts`
- **Protected Operation:** SMTP transporter initialization
- **Fallback:** Notifications are logged instead of sent

#### 6. MetricsService
**File:** `packages/backend/src/metrics/metrics.service.ts`
- **Protected Operation:** Metrics initialization (currently no-op)
- **Fallback:** N/A (no async work)

## Usage Pattern

### Basic Usage
```typescript
import { withTimeout, MODULE_INIT_TIMEOUT_MS } from '../common/utils/timeout';

async onModuleInit() {
  await withTimeout(
    this.asyncInitialization(),
    MODULE_INIT_TIMEOUT_MS,
    'ServiceName.onModuleInit',
  );
}
```

### With Error Handling
```typescript
async onModuleInit() {
  try {
    const result = await withTimeout(
      this.fetchCredentials(),
      MODULE_INIT_TIMEOUT_MS,
      'ServiceName.onModuleInit',
    );
    // Use result
  } catch (err) {
    this.logger.warn(`Initialization failed: ${err.message}`);
    // Fallback behavior
  }
}
```

## Testing
Unit tests are provided in `packages/backend/src/common/utils/timeout.spec.ts`:
- Promise resolution before timeout
- Timeout rejection with proper error message
- Error propagation from original promise
- Proper cleanup of timeout handles
- Concurrent timeout operations

## Benefits
1. **Prevents Infinite Hangs:** Application startup will fail fast instead of hanging
2. **Clear Error Messages:** Timeout errors include operation context
3. **Graceful Degradation:** Services fall back to environment variables when DB is unavailable
4. **Consistent Pattern:** All lifecycle hooks use the same timeout mechanism
5. **Configurable:** Timeout duration can be adjusted per service if needed

## Future Considerations
1. When adding new services with `onModuleInit()`, apply the same timeout pattern
2. Consider making timeout configurable via environment variables
3. Monitor timeout occurrences in production logs
4. Consider adding health checks that report initialization status

## Validation Results
- ✅ Code Review: Passed with minor feedback addressed
- ✅ CodeQL Security Scan: No security issues found
- ✅ Secret Scanning: No secrets detected
- ✅ Unit Tests: Comprehensive test coverage added

## Related Files
- `packages/backend/src/common/utils/timeout.ts` - Utility implementation
- `packages/backend/src/common/utils/timeout.spec.ts` - Unit tests
- All service files listed above - Implementation usage
