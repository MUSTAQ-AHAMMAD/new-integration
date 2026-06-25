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
docker compose up -d postgres redis
```

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
- Orders not marked as "paid" (state must be: paid, done, posted, invoiced, sale, invoice, confirmed, validated, or sent)
- Orders are cancelled
- Missing branch code
- Missing store configuration

**How to fix:**
1. Navigate to **Operations > Skipped Orders** to see WHY each order was skipped
2. Fix the underlying issue (update order states, add missing config, etc.)
3. Click **"Retry Skipped Orders"** button to re-process

See [docs/ORACLE_INTEGRATION_TROUBLESHOOTING.md](docs/ORACLE_INTEGRATION_TROUBLESHOOTING.md) for complete troubleshooting guide.

---

## Monitoring

- **Prometheus** scrapes backend metrics every 10s
- **Grafana** connected to Prometheus
- **Pino** structured JSON logs (pretty in dev)
- **Health**: `GET /api/v1/health`
