# FusionCredential Database Integration

## Overview

The item-sync service now uses Oracle Fusion credentials stored in the `FusionCredential` database table instead of relying solely on environment variables. This enables dynamic credential management through the admin UI without requiring application restarts.

## Architecture

### FusionCredential Table Schema

```prisma
model FusionCredential {
  id        String   @id @default(cuid())
  hostName  String   @unique    // e.g., "ehxk-test"
  server    String               // e.g., "em2"
  username  String               // e.g., "OICINT"
  password  String               // e.g., "159159159"
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([active])
}
```

### Resolution Flow

1. **Database First**: `FusionCredentialResolver` queries the `FusionCredential` table for the first active record
2. **URL Construction**: Uses `FusionAppParams` to build Oracle REST/SOAP URLs from `hostName` and `server`
3. **Environment Fallback**: If no active credential found, falls back to environment variables:
   - `ORACLE_REST_BASE_URL`
   - `ORACLE_SOAP_BASE_URL`
   - `ORACLE_USERNAME`
   - `ORACLE_PASSWORD`

### Module Configuration

The fix involved adding `PrismaModule` to `OracleModule`:

```typescript
@Module({
  imports: [ConfigModule, PrismaModule],  // ← PrismaModule added
  providers: [
    FusionCredentialResolver,  // Can now inject PrismaService
    OracleClient,
    OracleSoapClient,
    // ...
  ],
  exports: [/* ... */],
})
export class OracleModule {}
```

## How It Works

### For Item Sync (`POST /api/v1/item-sync/trigger/:region`)

1. **Application Startup**:
   - `OracleClient` is instantiated with default env-var credentials
   - `OracleClient.onModuleInit()` is called
   - Resolver checks database for active `FusionCredential` record
   - If found, HTTP client is re-initialized with database credentials

2. **Item Sync Request**:
   - `ItemSyncController` calls `ItemSyncService.syncItemsForRegion()`
   - Service uses `OracleClient.getInventoryItems()` to fetch from Oracle
   - OracleClient uses the credentials loaded during initialization

### URL Construction Example

Given database record:
```
hostName: "ehxk-test"
server: "em2"
username: "OICINT"
password: "159159159"
```

`FusionAppParams` constructs:
```
REST URL: https://ehxk-test.fa.em2.oraclecloud.com/fscmRestApi/resources/11.13.18.05
SOAP URL: https://ehxk-test.fa.em2.oraclecloud.com/fscmService/ServiceCatalogService
Auth: Basic T0lDSU5UOjE1OTE1OTE1OQ== (base64 of "OICINT:159159159")
```

## Admin UI

Credentials can be managed via the admin UI:
- **View**: `GET /admin/fusion-credentials`
- **Create**: `POST /admin/fusion-credentials`
- **Update**: `PUT /admin/fusion-credentials/:id`
- **Delete**: `DELETE /admin/fusion-credentials/:id`
- **Toggle Active**: `PATCH /admin/fusion-credentials/:id/active`

## Error Handling

If the database is unavailable during startup:
```
[OracleClient] WARN: onModuleInit: failed to load DB credentials for Oracle REST client — continuing with env-var credentials: <error>
```

If no credentials found (neither database nor environment):
```
[FusionCredentialResolver] WARN: No Oracle credentials found in database or environment variables
```

## Testing

The credential resolution can be verified via:

1. **Check Current Configuration**:
   ```bash
   curl http://localhost:3001/api/v1/health/oracle
   ```

2. **Test Item Sync**:
   ```bash
   curl -X POST http://localhost:3001/api/v1/item-sync/trigger/SA
   ```

3. **Monitor Logs**:
   ```
   [OracleClient] LOG: Oracle REST client re-initialised with database credentials (https://ehxk-test.fa.em2.oraclecloud.com/...)
   ```

## Migration Guide

### Before This Fix

Item-sync would fail with 404 errors if:
- `ORACLE_REST_BASE_URL` was incorrect
- Credentials stored in database couldn't be accessed
- No fallback to database credentials existed

### After This Fix

Item-sync now:
1. ✅ Automatically uses database credentials when available
2. ✅ Falls back to environment variables if database is unavailable
3. ✅ Logs which credential source is being used
4. ✅ Can be managed dynamically via admin UI

## Related Files

- `packages/backend/src/clients/oracle/oracle.module.ts` - Module configuration
- `packages/backend/src/clients/oracle/oracle.client.ts` - REST client with credential resolution
- `packages/backend/src/clients/oracle/oracle-soap.client.ts` - SOAP client with credential resolution
- `packages/backend/src/clients/oracle/fusion-credential.resolver.ts` - Credential resolution logic
- `packages/backend/src/utils/fusion-app-params.ts` - URL construction from hostname+server
- `packages/backend/prisma/schema.prisma` - FusionCredential model definition

## Troubleshooting

### Symptom: Item sync still returns 404

**Cause**: Database credentials are incorrect or inactive

**Solution**:
1. Verify database credential is active:
   ```sql
   SELECT * FROM "FusionCredential" WHERE active = true;
   ```
2. Test Oracle endpoint manually:
   ```bash
   curl -u "username:password" \
     "https://ehxk-test.fa.em2.oraclecloud.com/fscmRestApi/resources/11.13.17.11/items?limit=1"
   ```
3. Check application logs for credential source:
   ```
   grep "Oracle REST client" logs/app.log
   ```

### Symptom: Falls back to environment variables unexpectedly

**Cause**: Multiple possible issues
- No active credential in database
- Database connection failed during startup
- PrismaService injection failed

**Solution**:
1. Check database connection:
   ```bash
   curl http://localhost:3001/api/v1/health
   ```
2. Verify PrismaModule is imported in OracleModule
3. Check for database warnings in startup logs

## Future Enhancements

- [ ] Support multiple regional credentials (credential-per-region)
- [ ] Add credential rotation/expiry tracking
- [ ] Implement credential validation endpoint
- [ ] Add audit logging for credential usage
