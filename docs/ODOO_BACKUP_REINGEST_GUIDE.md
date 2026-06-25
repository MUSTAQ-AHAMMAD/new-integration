# Odoo Backup Re-ingestion Guide

## Overview

The Odoo backup re-ingestion feature allows you to process orders that are already stored in the backup tables (`BackupOdooOrder`, `BackupOdooOrderLine`, `BackupOdooOrderPayment`) without re-fetching them from the Odoo API.

## When to Use

This feature is useful in the following scenarios:

1. **Orders backed up but never ingested** - If the initial ingestion failed or was interrupted
2. **Branch mapping changes** - After fixing or updating branch codes in `StoreConfiguration`
3. **State mapping changes** - After expanding the list of valid order states (e.g., adding new state values to `PAID_ORDER_STATES`)
4. **Data recovery** - When the original orders are no longer available in Odoo but exist in backup tables
5. **Testing and validation** - Re-processing orders to test changes without hitting the Odoo API

## API Endpoint

**POST** `/odoo-backup/reingest-from-backup`

### Request Body

All parameters are optional. Without filters, the endpoint will re-ingest up to 1000 orders.

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "state": "paid",
  "region": "AE",
  "limit": 500
}
```

#### Parameters

- **startDate** (optional): ISO 8601 date string. Only orders on or after this date will be re-ingested.
- **endDate** (optional): ISO 8601 date string. Only orders on or before this date will be re-ingested.
- **state** (optional): Order state filter (e.g., "paid", "done", "posted", "invoiced"). Case-sensitive.
- **region** (optional): Region filter (e.g., "AE", "KW", "SA").
- **limit** (optional): Maximum number of orders to re-ingest. Must be a positive integer. Defaults to 1000.

### Response

```json
{
  "ok": true,
  "message": "Re-ingested 150 orders from backup tables",
  "ingested": 150,
  "skipped": 5,
  "total": 155
}
```

#### Response Fields

- **ingested**: Number of orders successfully ingested into `OrderSyncQueue`
- **skipped**: Number of orders that could not be ingested (e.g., missing branch code, validation errors)
- **total**: Total number of orders fetched from backup tables

## Examples

### 1. Re-ingest all recent orders

Re-ingest orders from the last 7 days:

```bash
curl -X POST http://localhost:3000/odoo-backup/reingest-from-backup \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-01-20"
  }'
```

### 2. Re-ingest orders for a specific region

Re-ingest only UAE orders:

```bash
curl -X POST http://localhost:3000/odoo-backup/reingest-from-backup \
  -H "Content-Type: application/json" \
  -d '{
    "region": "AE"
  }'
```

### 3. Re-ingest orders with a specific state

Re-ingest only "paid" orders:

```bash
curl -X POST http://localhost:3000/odoo-backup/reingest-from-backup \
  -H "Content-Type: application/json" \
  -d '{
    "state": "paid"
  }'
```

### 4. Re-ingest a specific date range with limit

Re-ingest orders from January 2024, maximum 100 orders:

```bash
curl -X POST http://localhost:3000/odoo-backup/reingest-from-backup \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-01-01",
    "endDate": "2024-01-31",
    "limit": 100
  }'
```

### 5. Re-ingest all orders (careful!)

Re-ingest up to 1000 orders with no filters:

```bash
curl -X POST http://localhost:3000/odoo-backup/reingest-from-backup \
  -H "Content-Type: application/json" \
  -d '{}'
```

## How It Works

1. **Query Backup Tables**: Fetches orders from `BackupOdooOrder` based on the provided filters
2. **Resolve Branch Codes**: Looks up canonical branch codes from `StoreConfiguration` using `odooBranchId`
3. **Normalize Data**: Uses `normalizeOrderForIngestion()` to transform backup data into the ingestion format
4. **Ingest Orders**: Calls `orderSyncService.ingestOrder()` to queue orders into `OrderSyncQueue`
5. **Return Stats**: Reports how many orders were successfully ingested vs. skipped

## Important Notes

- **Default Limit**: The endpoint defaults to 1000 orders to avoid memory issues. For large re-ingestion jobs, process in batches using date ranges.
- **Branch Code Required**: Orders without a valid branch code will be skipped.
- **Raw JSON Fallback**: The endpoint uses `rawJson` field if available, otherwise reconstructs the order from backup table fields.
- **Region Resolution**: The endpoint attempts to resolve the region from:
  1. The `region` field on the backup order
  2. The `StoreConfiguration` lookup by `odooBranchId`
  3. Falls back to no region if neither is available
- **Idempotency**: Re-ingesting the same order multiple times is safe. The `OrderSyncQueue` uses `@@unique([odooOrderId, branchCode])` constraint to prevent duplicates at the queue level.

## Monitoring

The service logs detailed information during re-ingestion:

- Start message with filter criteria
- Individual order skip warnings (missing branch code, ingestion errors)
- Final summary with ingested/skipped/total counts

Check the backend logs for detailed information:

```bash
docker logs -f backend-container-name | grep "Re-ingest"
```

## Related Endpoints

- **POST /odoo-backup/trigger** - Triggers a full backup job (fetches from Odoo API)
- **GET /odoo-backup/orders** - Lists recent backed-up orders
- **GET /odoo-backup/orders/:id** - Gets a specific backed-up order with lines and payments
- **POST /sync/orders/retry-skipped** - Retries orders that were skipped during sync (different from this endpoint)

## Workflow Comparison

### Normal Flow
1. Odoo API → `BackupOdooOrder` tables → `OrderSyncQueue` → BullMQ → Oracle

### Re-ingestion Flow
1. `BackupOdooOrder` tables → `OrderSyncQueue` → BullMQ → Oracle
   - Skips the Odoo API fetch step
   - Useful when data already exists in backup tables

## Troubleshooting

### "Skipping backup order: no valid branch code"

**Cause**: The backup order has no `branchId`, or the `branchId` cannot be resolved to a `branchCode` in `StoreConfiguration`.

**Solution**:
1. Check the `BackupOdooOrder` table for the order's `branchId`
2. Verify that a matching `odooBranchId` exists in `StoreConfiguration` with `isActive=true`
3. If the mapping is missing, add it to `StoreConfiguration` and retry

### "Failed to ingest backup order"

**Cause**: The order data doesn't meet validation requirements (e.g., missing required fields, invalid date format).

**Solution**:
1. Check the backend logs for the specific error message
2. Verify the `rawJson` field in `BackupOdooOrder` contains valid data
3. If the `rawJson` is corrupted or missing, the fallback construction may not have all required fields

### High skipped count

**Cause**: Many orders don't meet ingestion requirements.

**Solution**:
1. Review the logs to identify common skip reasons
2. Fix configuration issues (e.g., branch mappings)
3. Re-run the re-ingestion after fixes

## Best Practices

1. **Start Small**: Test with a small `limit` (e.g., 10-50 orders) before processing large batches
2. **Use Date Ranges**: For large re-ingestion jobs, break them into smaller date ranges
3. **Filter by Region**: When troubleshooting region-specific issues, filter by region to avoid processing unrelated data
4. **Monitor Logs**: Always monitor backend logs during re-ingestion to catch errors early
5. **Verify Success**: After re-ingestion, check the `OrderSyncQueue` table to verify orders were queued correctly
