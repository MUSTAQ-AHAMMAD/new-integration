# Integration Middleware

Enterprise-grade middleware replacing a Java-based system, connecting **Odoo ERP → Oracle Fusion**.

## Pain Points Solved

| # | Problem | Solution |
|---|---------|----------|
| 1 | Cannot selectively sync | `SyncJob` with `ScopeType` (SINGLE_ORDER, DATE_RANGE, BRANCH, FAILED_ONLY) |
| 2 | Timezone misalignment | `TimezoneService` normalises every order date to UTC; `originalTimezone` preserved |
| 3 | Draft orders syncing | Queue processor skips orders where `isPaid = false` |
| 4 | Duplicate transactions | SHA-256 `idempotencyKey` on every Oracle call via `IdempotencyService` |
| 5 | Unknown payment methods | `PaymentMappingService` raises alert + blocks only that order, not the whole batch |
| 6 | Refund handling broken | `isRefund` flag routes to credit-memo creation instead of AR invoice |
| 7 | Bad store config | `StoreConfigService.getValidatedConfig()` skips gracefully per store |
| 8 | No graceful failure | BullMQ per-job retry with exponential back-off; `FailedTransaction` dead-letter queue |
| 9 | Negative inventory blocks sync | Order syncs with `negativeInventoryFlag`; alert fires to inventory team |
| 10 | No real-time visibility | Next.js dashboard + WebSocket (`/events`) for live status updates |

---

## Architecture

```
packages/
├── backend/      NestJS · TypeScript strict · Prisma · BullMQ · REST + WebSocket
└── dashboard/    Next.js 15 App Router · shadcn/ui · TanStack Query · Recharts · Socket.IO
```

### Automatic Sync Pipeline

The system features an **automatic pipeline** that continuously syncs orders from Odoo to Oracle Fusion, similar to the Java reference implementation's Quartz scheduler:

```
Odoo API → OdooBackupService (15min cron) → BackupOdooOrder table
         → OrderSyncService.ingestOrder() → OrderSyncQueue (PENDING status)
         → PipelineSchedulerService (5min cron) → Creates SyncJob
         → BullMQ Queue → OrderSyncProcessor (10 workers)
         → Oracle SOAP/REST APIs → Invoice + Receipt creation
```

**Key Features:**
- 🔄 **Automatic processing**: Orders are synced every 5 minutes without manual intervention
- 🎯 **Quartz-like scheduler**: `PipelineSchedulerService` mimics Java's VendHQIntegrationScheduler
- 📊 **Real-time monitoring**: Dashboard shows pipeline status and queue statistics
- 🔁 **Auto-retry**: Failed orders are automatically retried with exponential backoff
- 🏥 **Health checks**: Pipeline monitors backlog and alerts on issues

See [docs/PIPELINE_ARCHITECTURE.md](docs/PIPELINE_ARCHITECTURE.md) for detailed pipeline documentation.

### Key Backend Modules

| Module | Responsibility |
|--------|---------------|
| `SyncModule` | Create / cancel / retry sync jobs; selective scope |
| `QueuesModule` | BullMQ queues: `order-sync`, `inventory-sync`, `retry`, `notifications` |
| `WebhookModule` | Receive Odoo events; idempotent ingest |
| `StoreConfigModule` | CRUD + validation; config errors are isolated per store |
| `PaymentMappingModule` | Resolve Odoo → Oracle method; unknown method raises alert |
| `AlertsModule` | Create / list / resolve alerts with severity |
| `HealthModule` | `@nestjs/terminus` endpoint + 5-min cron health checks |
| `GatewayModule` | Socket.IO WebSocket for dashboard real-time events |
| `DashboardModule` | Aggregate stats, charts data, failed tx, audit log |
| `ReconciliationModule` | Compare stored Odoo orders against the Oracle rows we pushed; find mismatches |
| `UsersModule` | Dashboard accounts, roles and per-area visibility |

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 22+
- pnpm 9+

### 1. Clone & configure

```bash
git clone https://github.com/MUSTAQ-AHAMMAD/new-integration
cd new-integration
cp .env.example .env
# Edit .env with your Odoo/Oracle credentials
```

### 2. Start infrastructure

```bash
docker compose up -d
```

> **Note**: By default, services connect directly to PostgreSQL (bypassing PgBouncer). This simplifies development and avoids connection pooling issues. PgBouncer is available as an optional service if needed. See [PGBOUNCER_SETUP.md](PGBOUNCER_SETUP.md) for details.

### 3. Install & migrate

```bash
pnpm install
pnpm db:migrate
pnpm db:generate
```

### 4. Start (development)

```bash
# Terminal 1
cd packages/backend && pnpm dev

# Terminal 2
cd packages/dashboard && pnpm dev
```

**Or with Docker:**

```bash
docker compose up -d
```

### Access control

Dashboard sign-in is backed by the `AppUser` table. On a fresh install nobody
exists yet, so the first sign-in uses the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
environment pair; that account is then written into `AppUser` and manageable
like any other from **Admin Panel → Access Control → User Management**.

| Role | Sees |
|------|------|
| `ADMIN` | Everything, including credentials and user management |
| `OPERATOR` | The integration itself — no credentials, settings or user management |
| `VIEWER` | Read-only: dashboards, reports, reconciliation, audit |

A role is the ceiling. Per-user **area overrides** narrow it further (for
example an operator who should only see Reports and Audit). Areas are defined
once in `packages/backend/src/auth/areas.ts`, enforced on the API through
`@RequireArea()`, and mirrored in `packages/dashboard/src/lib/areas.ts` so the
sidebar hides what the account cannot open. Keep the two in step when adding a
screen.

> The `AppUser` table is created like every other entity — by TypeORM
> `synchronize` (`APP_DB_SYNCHRONIZE=true`) or `pnpm --filter backend
> db:bootstrap`. Until it exists the env admin still works and the backend logs
> a warning on each sign-in.

### Reconciliation

**Reconciliation** in the sidebar has two tabs:

- **Odoo ↔ Oracle** — every Odoo order in a date window placed next to the
  invoice, lines and receipts recorded when it was pushed, classified as
  matched, missing, amount/payment/line mismatch, Oracle error, or (worst)
  present in Oracle despite being cancelled or unpaid in Odoo. Orders are
  joined on the Odoo order reference, which is what
  `FusionInvoiceLine.salesOrder` and `OrderSyncQueue.odooOrderNumber` both
  carry. Exportable as CSV.

  It reads top-down. Three roll-ups sit over one order list:

  | View | One row per | Answers |
  |------|-------------|---------|
  | **By store** | outlet | which store is out of balance |
  | **By day** | trading day | which day went wrong |
  | **By store & day** | outlet × day | the level a Z-report reconciles at |
  | **Orders** | Odoo order reference | which sale caused it |

  Each roll-up carries order count, problems, match rate, Odoo total, Oracle
  total, variance, Odoo payments and linked Oracle receipts, plus a totals row.
  Clicking a row drills into the Odoo order references behind it; clicking an
  order opens the line-by-line and payment-by-receipt comparison. The drill-down
  narrows the order list only — the roll-ups keep covering the whole window, so
  the store totals never shift under you. Stores are keyed on branch code,
  falling back to branch name then POS config name, so an outlet is never split
  across two rows because one identifier is missing.

  Roll-up totals deliberately ignore the status filter: a store's variance has
  to cover every order it booked, or it stops reconciling against the POS.
- **Odoo source integrity** — did what Odoo's API returned land in our tables
  intact? A clean result here is the precondition for trusting the first tab.

Both are read-only; running them never sends anything to Odoo or Oracle.

### URLs

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| Backend API | http://localhost:3001/api/v1 |
| Swagger docs | http://localhost:3001/docs |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3003 (admin/admin) |

---

## API Overview

### Selective Sync
```http
POST /api/v1/sync/jobs
{
  "jobType": "ORDER_SYNC",
  "scopeType": "DATE_RANGE",
  "startDate": "2024-04-01",
  "endDate": "2024-04-01"
}
```

### Retry Failed Only
```http
POST /api/v1/sync/jobs
{ "jobType": "ORDER_SYNC", "scopeType": "FAILED_ONLY" }
```

### Webhook (Odoo)
```http
POST /api/v1/webhooks/odoo
{ "event_type": "order.paid", "order": { ... } }
```

---

## Database Schema (13 models)

`SyncJob` · `OrderSyncQueue` · `AuditLog` · `PaymentMethodMapping` · `RefundTracking` · `StoreConfiguration` · `FailedTransaction` · `InventorySyncTracker` · `IntegrationHealthCheck` · `NotificationRecipient` · `AlertLog` · `WebhookEvent`

---

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
1. Lint & type check
2. Test backend (real Postgres + Redis)
3. Build backend + Docker image
4. Build dashboard + Docker image
5. Deploy on `main` push

---

## Troubleshooting

### PARTIAL Sync Status

If you see **PARTIAL** status in sync jobs, this typically means some orders were **SKIPPED** (not failed). This is normal behavior - not all orders should sync to Oracle.

**Common reasons:**
- Orders not marked as "paid" (state must be in one of 22+ recognized paid states)
- Orders are cancelled
- Missing branch code
- **Missing store configuration** — use `POST /api/v1/store-config/populate/all-branches` to auto-create configs

**How to fix existing orders:**
1. **Auto-Fix (Recommended)**: `POST /api/v1/sync/auto-fix/skipped-orders`
2. **Retry Skipped**: `POST /api/v1/sync/orders/retry-skipped`
3. **Re-Ingest from Backup**: `POST /api/v1/odoo-backup/reingest-from-backup`

See [docs/EXISTING_ORDERS_FIX_GUIDE.md](docs/EXISTING_ORDERS_FIX_GUIDE.md) for comprehensive fix guide with all available endpoints.

See [docs/STORE_CONFIG_POPULATION.md](docs/STORE_CONFIG_POPULATION.md) for how to populate StoreConfiguration for all branches.

See [docs/ORACLE_INTEGRATION_TROUBLESHOOTING.md](docs/ORACLE_INTEGRATION_TROUBLESHOOTING.md) for complete troubleshooting guide.

---

## Monitoring

- **Prometheus** scrapes backend metrics every 10s
- **Grafana** connected to Prometheus
- **Pino** structured JSON logs (pretty in dev)
- **Health**: `GET /api/v1/health`
