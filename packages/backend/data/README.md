# CSV Seed Data

Drop CSV files here and run:

```bash
# From packages/backend — import all CSVs in this folder
pnpm seed:csv

# Import a specific file
pnpm seed:csv data/VENDHQ_REGISTERS_202606241630.csv

# Import a file whose name doesn't match any table slug
pnpm seed:csv data/my-file.csv --table vendhq-registers
```

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
