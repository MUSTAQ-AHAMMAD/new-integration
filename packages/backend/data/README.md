# CSV Seed Data

Drop CSV files here and run:

```bash
# ── Local development (no Docker) ──────────────────────────────────────────
# Build the backend first (compiles seed-csv.ts → dist/scripts/seed-csv.js)
cd packages/backend
pnpm build

# Import all CSVs in data/
pnpm seed:csv

# Import a specific file
pnpm seed:csv data/VENDHQ_REGISTERS_202606241630.csv

# Import a file whose name doesn't match any table slug
pnpm seed:csv data/my-file.csv --table vendhq-registers

# ── Docker ─────────────────────────────────────────────────────────────────
# Drop CSVs into packages/backend/data/ on your host machine, then:

# One-shot seeder (no server restart needed)
docker compose run --rm seeder

# Or exec directly inside the running backend container
docker exec integration_backend sh -c "node dist/scripts/seed-csv.js"

# Import a specific file mounted from the host
docker exec integration_backend sh -c \
  "node dist/scripts/seed-csv.js /app/packages/backend/data/vendhq-registers.csv"
```

## How it works

1. Drop CSV files in this `data/` folder on the **host**.
2. The folder is mounted read-only into the container at `/app/packages/backend/data`.
3. Run the seeder — it auto-detects the target table from each filename.

## File naming convention

Name your CSV files to match the admin table slug, optionally with a date or
version suffix:

| File name                          | Target table        |
|------------------------------------|---------------------|
| `vendhq-registers.csv`             | `vendhq-registers`  |
| `VENDHQ_REGISTERS_202606241630.csv`| `vendhq-registers`  |
| `vendhq-outlets_SA.csv`            | `vendhq-outlets`    |
| `fusion-sales-metadata.csv`        | `fusion-sales-metadata` |

## Column mapping

Column headers are mapped automatically:

- **UPPER_SNAKE_CASE** headers (e.g. `REGISTER_ID`) → camelCase Prisma fields (`registerId`)
- **camelCase** headers (re-exported CSVs) → passed through as-is

Duplicate rows (same unique key) are silently skipped.

## Available table slugs

| Slug | Prisma model |
|------|-------------|
| fusion-credentials | FusionCredential |
| vendhq-credentials | VendHqCredential |
| odoo-credentials | OdooCredential |
| outlet-config | OutletIntegrationConfig |
| fusion-bu-map | FusionBusinessUnitMap |
| fusion-receipt-methods | FusionReceiptMethod |
| fusion-sales-metadata | FusionSalesMetadata |
| service-provider-journal-meta | ServiceProviderJournalMeta |
| sales-integration-status | SalesIntegrationStatus |
| vendhq-discount-items | VendHqDiscountItem |
| vendhq-tax-meta | VendHqTaxMeta |
| vendhq-outlets | VendHqOutlet |
| vendhq-registers | VendHqRegister |
| vendhq-service-providers | VendHqServiceProvider |
| vendhq-item-meta | VendHqItemMeta |
| ibq-credentials | IbqCredential |
| api-endpoint-configs | ApiEndpointConfig |
