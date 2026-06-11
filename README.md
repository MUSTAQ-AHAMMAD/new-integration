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
- Docker & Docker Compose (v2)
- Node.js 22+ and pnpm 9+ (local development only)

### 1. Clone & configure

```bash
git clone https://github.com/MUSTAQ-AHAMMAD/new-integration
cd new-integration
cp .env.example .env
# Edit .env with your Odoo/Oracle/VendHQ credentials
```

### 2. Start with Docker (recommended)

```bash
# Build and start all services
docker compose up -d

# Run database migrations (required on first run)
docker compose exec backend pnpm exec prisma migrate deploy

# Tail logs
docker compose logs -f backend dashboard
```

### 3. Local development (alternative)

```bash
# Start only the infrastructure
docker compose up -d postgres redis-master

# Install dependencies
pnpm install

# Run migrations and generate Prisma client
pnpm db:migrate
pnpm db:generate

# Start both packages with hot-reload
pnpm dev
```

### URLs

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| Backend API | http://localhost:3001/api/v1 |
| Swagger docs | http://localhost:3001/docs |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3003 (admin/admin) |

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

## Monitoring

- **Prometheus** scrapes backend metrics every 10s
- **Grafana** connected to Prometheus
- **Pino** structured JSON logs (pretty in dev)
- **Health**: `GET /api/v1/health`
