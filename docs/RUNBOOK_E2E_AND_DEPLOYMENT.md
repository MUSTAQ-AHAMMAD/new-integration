# Runbook — Running the Integration Locally and Deploying It Elsewhere

This runbook documents an actual end-to-end run performed on 2026-07-20/21 against the
live Oracle Fusion test pod (`ehxk-test.fa.em2.oraclecloud.com`) and the live Oracle
application database (`193.122.68.27 / PDB1 / NEW_INTEGRATION`).

Everything below was executed, not theorised. Where a step failed, the failure and its
root cause are recorded rather than smoothed over.

---

## 1. What the system is

| Piece | Tech | Port | Notes |
|---|---|---|---|
| `packages/backend` | NestJS 11 | 3001 | REST (`/api/v1`), GraphQL, Swagger at `/docs`, WebSocket gateway |
| `packages/dashboard` | Next.js 15 | 3000 | React 19, TanStack Query, talks to the backend over `NEXT_PUBLIC_API_URL` |
| `packages/shared` | TS types | — | shared contracts |
| Application DB | **Oracle** via TypeORM | 1521 | schema `NEW_INTEGRATION` in `PDB1`. **Prisma/PostgreSQL are gone** — leftover `DATABASE_URL` entries in `.env` are dead |
| Queue | Redis + BullMQ | 6379 | order-sync, inventory-sync, retry, notifications |
| Source | Odoo POS REST | — | `GET {ODOO_BASE_URL}/api/pos/order`, `x-api-key` auth |
| Target | Oracle Fusion | 443 | SOAP for invoices/receipts/credit-memos/journals, REST for item lookups |
| ERP reference DB | Oracle | 1521 | `ODOO_INTEGRATION` schema — source of all config/reference data |

The backend process also runs the queue processors, so a separate worker
(`pnpm --filter backend start:worker`) is **optional** in development — starting both
would double-process every job.

---

## 2. Prerequisites

1. **Node.js ≥ 22** and **pnpm 9** (`npm install -g pnpm@9`; `corepack enable` fails on
   this machine with `EPERM` writing into `C:\Program Files\nodejs`).
2. **Oracle Instant Client** — required, not optional. Both Oracle connections run in
   thick mode (the app DB uses Native Network Encryption, and the ERP DB connects as
   `SYS AS SYSDBA`, which thin mode does not support). Installed here at
   `C:\oracle\instantclient_21_20`.
3. **Redis** — `docker run -d --name integration_redis -p 6379:6379 redis:7-alpine redis-server --requirepass redis_pass`
4. **Network reach** to `193.122.68.27:1521` (app DB), `193.122.71.188:1521` (ERP DB)
   and `ehxk-test.fa.em2.oraclecloud.com:443` (Fusion).

---

## 3. Configuration (`packages/backend/.env`)

Only `packages/backend/.env` is read by the backend — the repository-root `.env` is for
Docker Compose only and is **not** loaded by the Nest process. Four things had to be
corrected before the app would run:

| Key | Was | Now | Why |
|---|---|---|---|
| `ORACLE_REST_BASE_URL` | `https://oracle-instance/...` | `https://ehxk-test.fa.em2.oraclecloud.com/fscmRestApi/resources/11.13.18.05` | placeholder — every Fusion call would fail |
| `ORACLE_SOAP_BASE_URL` / `ORACLE_SOAP_WSDL_URL` | `https://oracle-instance` | `https://ehxk-test.fa.em2.oraclecloud.com` | same |
| `ORACLE_USERNAME` / `ORACLE_PASSWORD` | `oracle_user` / `oracle_password` | `OICINT` / *(real)* | same |
| `APP_DB_PASSWORD` | `NewIntegration#2026` | `"NewIntegration#2026"` | **dotenv truncates an unquoted value at `#`** — the app was sending `NewIntegration` and got `ORA-01017` |
| `APP_DB_INSTANT_CLIENT_DIR`, `ORACLE_DB_INSTANT_CLIENT_DIR` | `/opt/instantclient` | `C:\oracle\instantclient_21_20` | Linux path on a Windows host |
| `REDIS_PASSWORD` | *(empty)* | `redis_pass` | must match the Redis container |
| `WEBHOOK_SECRET` | *absent* | set | required by `POST /webhooks/odoo` |

> ⚠️ **Account lockout.** Ten failed logins with the truncated password locked
> `NEW_INTEGRATION` (`ORA-28000`). Unlock as SYS against **PDB1** (not the CDB root):
> `ALTER USER NEW_INTEGRATION ACCOUNT UNLOCK;`

There is **no env validation schema** — a missing or wrong variable surfaces as a
runtime failure deep in a request, never at boot. Treat the table above as the real
contract.

---

## 4. Starting everything

```bash
# 0. one-time
npm install -g pnpm@9
docker run -d --name integration_redis -p 6379:6379 redis:7-alpine redis-server --requirepass redis_pass

# 1. dependencies
cd C:/xampp/htdocs/new-integration
pnpm install

# 2. backend  (http://localhost:3001, Swagger at /docs)
pnpm --filter backend dev

# 3. dashboard (http://localhost:3000)
pnpm --filter dashboard dev

# 4. optional dedicated worker — ONLY if the API is run with queue processing disabled
# pnpm --filter backend start:worker:dev
```

Healthy boot looks like this:

```
[Bootstrap] Instant Client initialized from: C:\oracle\instantclient_21_20
[Bootstrap] Node-oracledb version: 7.0.0 — Thick Mode enabled
[Bootstrap] Oracle test connection successful
[NestApplication] Nest application successfully started
```

Verify:

```bash
curl http://localhost:3001/api/v1/health
# {"status":"ok","info":{"database":{"status":"up"}},...}

curl -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<ADMIN_PASSWORD>"}'
# {"accessToken":"eyJ..."}
```

Boot ordering matters: **the Oracle application DB is a hard dependency** — if it is
unreachable, TypeORM retries 10× and the process exits. Redis, Fusion REST and Fusion
SOAP are all soft — the app boots without them and fails later, per request.

Every route except `/health*`, `/metrics` and `POST /webhooks/odoo` requires
`Authorization: Bearer <token>`. Credentials are the plain `ADMIN_EMAIL` /
`ADMIN_PASSWORD` env vars; the dashboard stores the token in `localStorage`.

---

## 5. Loading reference data (mandatory before any sync)

The `NEW_INTEGRATION` schema starts empty — 61 tables, no configuration. All reference
data comes from the `ODOO_INTEGRATION` schema on the ERP database:

```bash
TOKEN=...   # from /auth/login

# core config — ~10 min
curl -X POST http://localhost:3001/api/v1/admin/oracle-import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tables":["OUTLETS_INTEGRATION_CONFIG","FUSION_BUSINESS_UNIT_ID_MAP","FUSION_RECEIPT_METHOD","FUSION_SALES_METADATA","SERVICE_PROVIDER_JOURNAL_META"]}'

# registers, items, outlets, tax — ~25 min
curl -X POST http://localhost:3001/api/v1/admin/oracle-import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tables":["VENDHQ_REGISTERS","VENDHQ_ITEM_META","VENDHQ_OUTLETS","VENDHQ_TAX_META"]}'

# customer account-number → cust_account_id
curl -X POST http://localhost:3001/api/v1/admin/oracle-import/customer-accounts \
  -H "Authorization: Bearer $TOKEN"
```

Observed result:

| Table | Rows |
|---|---|
| `OutletIntegrationConfig` | 462 |
| `FusionSalesMetadata` | 2 122 imported → 474 distinct |
| `FusionReceiptMethod` | 42 |
| `FusionBusinessUnitMap` | 6 |
| `ServiceProviderJournalMeta` | 44 |
| `VendHqRegister` | 462 |
| `VendHqItemMeta` | 4 720 |
| `VendHqOutlet` | 353 |
| `FusionCustomerAccount` | 458 |

`StoreConfiguration` is **not** imported — it is created per branch, either
automatically on first ingest or explicitly:

```bash
curl -X POST http://localhost:3001/api/v1/admin/store-configs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "branchCode":"164018","branchName":"RYDAVNUMAL","odooBranchId":164018,"region":"SN",
    "oracleOperatingUnitId":300000001421038,"oracleBusinessUnit":"AlQurashi-KSA",
    "billToSiteName":"164018","billToLocation":"164018",
    "bankAccountName":"AL Jazeerah Bank RYDAVNUMAL","cashAccountName":"Cash RYDAVNUMAL",
    "bankAccountId":300000215271032,"cashAccountId":300000215271038,
    "paymentTermsName":"IMMEDIATE","transactionSource":"Vend","transactionType":"Vend Invoice",
    "invoiceCurrencyCode":"SAR","isActive":1,"validationStatus":"VALID","version":1,
    "createdBy":"ops"}'
```

`branchName` must normalise-match a `FusionSalesMetadata.billToName` for the same region
(uppercased, non-alphanumerics stripped) or the transformer cannot resolve a bill-to.

> ⚠️ `PUT /store-config/:branchCode` takes a **full** body. Sending a partial body
> silently zeroes `odooBranchId` and `oracleOperatingUnitId`.

---

## 6. Running the end-to-end cycle

### 6.1 The source

The configured Odoo tenant (`ibrahimalquraishieu-26-2-26-29083802.dev.odoo.com`) is
**deprovisioned** — DNS resolves to `0.0.0.0`. No data can be pulled from it.

For this run the POS API was mocked locally (`scratchpad/mock-odoo.cjs`) speaking the
exact contract the client expects — `GET /api/pos/order`, `x-api-key` header,
`limit`/`offset` paging, `{ data: [...], count: N }` response — with
`ODOO_BASE_URL=http://127.0.0.1:8069`. Everything downstream of the HTTP boundary is
the real production code path against the real Oracle Fusion pod.

### 6.2 The steps

```bash
# 1. pull → backup → ingest
curl -X POST http://localhost:3001/api/v1/sync/fetch-odoo \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"startDate":"2026-07-01","endDate":"2026-07-31"}'
# {"ok":true,"fetched":2,"backedUp":2,"backupSkipped":0,"ingested":2,"skipped":0,"errors":[]}

# 2. the processor picks the order up automatically; to force one order:
curl -X POST http://localhost:3001/api/v1/sync/sync-direct/<orderSyncQueueId> \
  -H "Authorization: Bearer $TOKEN"

# 3. observe
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/sync/order-queue?limit=5
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/sync/diagnostics/summary
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/audit
```

### 6.3 What actually happened

Order `RYDAVNUMAL/E2E/0001` (branch 164018, region SN, 339.53 SAR, cash, SKU
`1010011120`) completed all 14 steps:

| Step | Result |
|---|---|
| 1 paid/cancelled | ✅ |
| 2 validation | ✅ store config VALID |
| 3 store config | ✅ region=SN |
| 5 payment mapping | ⚠️ no `DEFAULT` mapping → auto-created `PENDING_MAPPING` placeholder (non-blocking) |
| 6 idempotency | ✅ not a duplicate |
| 7 enrichment | ✅ from `BackupOdooOrder` |
| 7b item existence | ✅ `1010011120` found in Fusion |
| 8a invoice | ✅ **`txn=2958524`, status=S, customerTxnId=300000236391189** |
| 8b inventory txn | ✅ 1 created |
| 9 standard receipt | ✅ **`Cash-2958524`** |
| 10 misc receipt | 0 (cash payment — expected) |
| 11 apply receipt | ✅ **339.53 applied to invoice 2958524** |
| 12 GL journal | 0 (only built for non-`NORMAL` customer types — expected) |
| 13/14 | ✅ status `SYNCED` |

Re-running the same order returned `DUPLICATE` from the idempotency check without
re-posting to Oracle — idempotency verified.

**Refund path:** refund order `RYDAVNUMAL/E2E/R0002` was correctly excluded from
invoicing and tracked in `RefundTracking` with `creditMemoStatus=PENDING`. The credit
memo push **failed** — see §8.

---

## 6.5 Invoice granularity — daily aggregation

**One Oracle AR invoice per `(branch, business day, customer type, credit flag)`**,
not per order. This replaced the original one-invoice-per-order behaviour to match the
legacy Java integration (`VendHQSalesToFusionInvRecTransBackup#addInvoiceMapping`).

| Aspect | Behaviour |
|---|---|
| Grouping key | branch + store-local calendar day + customerType + credit flag |
| Business day | store-local, resolved by region (`SN`/`SA`→Asia/Riyadh, `AE`→Asia/Dubai, …) via IANA zones, so DST never shifts the boundary |
| Line grain | one Oracle line per **source order line** — no item-level summing — numbered continuously across the whole day |
| Traceability | every line carries `salesOrder` = Odoo order number and `salesOrderLine` = source line number |
| Idempotency | per line on `(salesOrder, salesOrderLine, region, status=SUCCESS)` in `FusionInvoiceLine` |
| Receipts | one per `(payment method, register)` per group, amounts summed |
| Journals | only for non-`NORMAL` customer types (service providers) |
| Credit sales | `Credit On Cust` payments split into their own invoice and get **no** receipt |
| Refunds | **not** aggregated — they stay on the credit-memo path |

### Running it

```bash
# Dry run — shows the groups that WOULD post, no Oracle calls
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/v1/sync/daily-invoice/preview/164018/2026-07-19

# Post one branch, one day
curl -X POST http://localhost:3001/api/v1/sync/daily-invoice \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"branchCode":"164018","startDate":"2026-07-19","days":1}'

# Post a whole region, catch-up range (capped at 7 days)
curl -X POST http://localhost:3001/api/v1/sync/daily-invoice \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"region":"SN","startDate":"2026-07-14","days":7}'
```

Always preview before posting a new branch — it shows the exact orders, line count,
totals and receipts without touching Oracle.

### Re-running a day is safe

Lines already posted are dropped from the new invoice; if every line of a day is
already posted the group is skipped entirely and nothing is sent. Verified live: a
second run of the same day returned `{"created":0,"failed":0,"results":[]}`.

### Verified results (2026-07-21, ehxk-test)

| Invoice | Source orders | Lines |
|---|---|---|
| `2958525` | E2E/0003, E2E/0004 | 2 |
| `2958526` | E2E/0005, E2E/0006 | 2 |
| `2958527` | E2E/0007, E2E/0008, E2E/0009 | 3 |

Each with a single aggregated `Cash-<txn>` receipt. `2958524` is the older per-order
invoice, left in place — note how its order was correctly excluded from the `2958525`
group rather than double-posted.

### Deliberate differences from the Java reference

1. **Refunds are not folded in.** The reference puts negative lines in the same daily
   invoice; here refunds stay on the credit-memo path (per requirement).
2. **Register is part of the receipt key.** The reference attributed every receipt to
   whichever register appeared on the first sale of the day, so a multi-till outlet
   remitted to the wrong bank account.
3. **The apply-receipt rounding delta is computed**, not discovered by retrying 50
   times subtracting 0.01. The comparison uses the **tax-inclusive** order total, since
   invoice lines are ex-tax and Oracle derives tax from each line's classification code.
4. **The outlet is stored on the invoice header** rather than being recoverable only
   through the bill-to customer name.

### Turning it off

`PER_ORDER_INVOICING_DISABLED` in
`packages/backend/src/queues/processors/order-sync.processor.ts`. Set it to `false` to
restore one-invoice-per-order; nothing else needs changing.

### Parity fixes applied after the Java gap-analysis (2026-07-22)

A side-by-side review against the Java reference surfaced several gaps; these were closed
and verified live:

- **Receipt/journal retry lockout (regression) — fixed.** When every line of a day was
  already posted, the group was skipped entirely, stranding any receipt/journal the
  previous run had not reached. Now each Oracle object is guarded independently: a
  fully-invoiced day still reuses the invoice and retries missing receipts/journals.
  Verified: a receipt forced to ERROR was re-posted on the next run without duplicating
  the invoice.
- **Item pre-check (regression) — fixed.** One unknown SKU used to fail a whole
  branch-day invoice. Now each distinct item is checked against Oracle and only the
  offending orders are held back (surfaced as `excludedOrders`); the rest of the day
  posts. Verified with SKU `9999999999`.
- **Outlet `INTEG_MODE` gating — added.** `OUTLETS_INTEGRATION_CONFIG` (31 `NONE`
  outlets in the live data) was ignored, so decommissioned/manual outlets were being
  integrated automatically. Now `NONE` is never posted, `MANUAL` only on operator
  triggers, `AUTOMATIC` only on the scheduled run. The manual endpoint takes
  `"trigger":"MANUAL"|"AUTOMATIC"`; the cron uses `AUTOMATIC`. Verified: a `NONE` outlet
  is refused even on an automatic run.
- **GL journal amount — fixed.** Posted the full invoice total; now posts the
  service-provider commission (`total × bankChargeRate`, or `fixedFreightCharge`).
  Affects non-`NORMAL` (delivery-platform) sales only.
- **Invoice-line UOM — fixed.** Lines now carry the valid short Oracle UOM code resolved
  from the item master (`VendHqItemMeta.uomCode`, e.g. `Ea`, `G`) instead of a hardcoded
  `Ea`. The naive first attempt (sending the Odoo display name `Gram`) was rejected by
  Oracle — `UomCode exceeds the maximum length allowed` — and reverted.
- **Line tax classification — deliberately NOT sent.** The Odoo tax name (`VAT 15%`) is
  not a valid Oracle `TaxClassificationCode` and made Oracle reject the whole invoice.
  Omitting it lets Oracle apply the customer/site default VAT, which is correct for these
  KSA customers. A per-line tax code would need a validated Odoo-tax → Oracle-code map.

### Inventory relief (added 2026-07-22)

Each contributing invoice line now posts an inventory **issue** to Oracle so stock is
relieved.

- **Resource:** `inventoryStagedTransactions` (REST). The Java used
  `inventoryTransactions`, which is **deprecated and returns 403** on this pod — the
  staged/interface resource is the working successor. Oracle's transaction manager
  processes the interface asynchronously (`ProcessStatus` 1 → processed), same async
  model the Java relied on.
- **Organisation** is resolved from the subinventory name via `activeSubinventories`
  (cached), e.g. `RYDAVNUMAL` → org `300000001419031`.
- **Quantity** is negated (issue); **UOM** is the resolved item-master code;
  **subinventory** comes from `FusionSalesMetadata.subinventory`.
- **Transaction type** is `ORACLE_INVENTORY_TXN_TYPE` (default `Account Issue` — the
  legacy `Vend Sales Issue` may not exist on every pod).
- Recorded in `FusionInvTxn` (`SUCCESS`/`ERROR`), guarded so a re-run never
  double-issues. Only lines with a real item + resolvable UOM produce an issue;
  description-only and discount lines do not.
- Verified live: invoice `2958531` + one inventory issue (`txnQty=-1`, org resolved);
  re-run left exactly one `SUCCESS` row.

### Operational features added 2026-07-22

- **Bulk store-config seeder** — `POST /store-config/seed-region` `{region?, dryRun?}`.
  Provisions/updates a `StoreConfiguration` for every eligible outlet in a region from
  the reference data (outlet config + sales metadata + registers + BU), skipping `NONE`
  outlets and any with no bill-to metadata, and flagging anything unresolved
  `NEEDS_REVIEW` with specific reasons. This is how you go from one configured store to a
  whole region. Always `dryRun:true` first — it returns the full worklist without
  writing. Verified: SN dry-run provisions 140 stores, skips 30 NONE + 45 no-metadata, in
  ~3 s. Outlets with no Odoo orders yet get a provisional branch code from the site
  number, flagged for review — confirm it matches the outlet's real Odoo `branch_id`
  before going live.
- **DB-backed run mutex** — the daily scheduler now takes a cross-process lock in
  `SyncControl` (compare-and-set with a 30-min lease that auto-expires on crash), so the
  API and worker (or two instances) can't run the same job at once. Verified: two
  concurrent `run-now` calls → one ran, one logged "already running elsewhere".
- **Run-summary notification** — after each scheduled run, a summary (invoices created,
  failures, held-back orders) is sent to the daily-report recipients, or logged when SMTP
  is off. Matches the legacy run-summary email.
- **Cash-rounding parity** — a `cash rounding` payment is now folded into the Cash
  standard receipt (they share one Oracle receipt-method id) as well as emitting the
  negative misc adjustment, matching the Java. ⚠️ No cash-rounding data existed in the
  test set, so this is code-parity with the Java, not financially reconciled live —
  validate against a real cash-rounding day before relying on it.

### Refunds / credit memos — separate, manual, menu-driven (config-blocked at Oracle)

Per the agreed design, refunds are **never** folded into invoices. They are tracked in
`RefundTracking` and surface on the Refunds/Cancellations menu for **manual** push as the
final step of the cycle. Verified: refund `R0002` is in `RefundTracking` and appears in
**zero** invoice lines.

The manual push itself is **blocked on Oracle AR configuration**, not code. Credit memos
go through AutoInvoice (`createSimpleInvoice`), which needs a **Credit-Memo-class
transaction type attached to an imported batch source** — the only combination present in
the pod is `(Manual, Credit Memo)`, and `Manual` is not an import source. Every import
attempt (`Vend`/`Manual` × `Credit Memo`/`Vend Credit Memo`) returns
`AR_INVAL_CUST_TRX_TYPE_ID`. **Action for the Oracle admin:** create (or associate) a
Credit-Memo transaction type on the `Vend` (imported) batch source, then set each store's
`creditMemoTransactionType` to it. Until then, refund pushes will fail with a clear error
and stay visible in the menu for retry.

### Readiness + operability (added 2026-07-22)

- **Preflight go/no-go:** `GET /sync/daily-invoice/readiness/:region` — checks reference
  data, store configs, Oracle SOAP+REST reachability and outlet gating, returning
  `ready` + specific blockers/warnings. Run it before turning a region live. Verified: SN
  → `ready:true`.
- **`nextRunAt`** is now on every `GET /admin/sync-control` row and the single-service GET,
  so operators can see when each cron fires next.
- **Health-check flapping fixed:** the DB ping timeout was 1 s, which returned 503 whenever
  a heavy cron held pool connections. Raised to 8 s to reflect the remote Oracle's latency.
- **Admin routing fixed:** `GET /admin/sync-control` and `/admin/sync-control/:service`
  were being shadowed by the generic `admin/:table` catch-all ("Unknown table:
  sync-control"). The specific controllers are now registered first.

See `GO_LIVE_CHECKLIST.md` for the owner-assigned steps that remain (Oracle AR credit-memo
setup, inventory interface processor, live Odoo credentials, store-config review, pilot).

**Still open (lower priority, none block the daily cycle):** the Fusion→VendHQ item *push*
(needs live VendHQ, which is legacy/disabled) and three imported-but-unread VendHQ
reference tables (VendHQ ingest enrichment — not used by the live Odoo path).

---

## 7. What is stored from the Oracle APIs

This is the part that most often gets assumed rather than checked. Verified by querying
the schema directly after the run:

**Stored (structured outcomes):**

| Table | Holds |
|---|---|
| `FusionInvoiceHeader` | `txnNumber`, `customerTxnId`, `status` (`SUCCESS`/`ERROR`), `message` (full Oracle error text), region, requestId |
| `FusionInvoiceLine` | `invoiceNumber`, `salesOrder`, status |
| `FusionStandardReceipt` / `FusionMiscReceipt` / `FusionApplyReceipt` | receipt number, status, message |
| `FusionJournalHeader` / `FusionJournalLine` | `jeHeaderId` returned by Oracle |
| `FusionInvTxn` | inventory transactions |
| `FailedTransaction` | error type + full message per failed attempt |
| `OrderSyncQueue` | `oracleInvoiceNumber`, `oracleCreditMemoNumber`, attempts, status |

**NOT stored — raw request/response payloads:**

- `AuditLog.requestPayload` contains the internal `OrderSyncQueue` row, **not** the SOAP
  request sent to Oracle. `AuditLog.responsePayload` and `oracleResponseId` were `NULL`
  after a successful invoice creation.
- `FusionInvoiceAudit`, `FusionReceiptAudit`, `FusionJournalAudit`,
  `FusionInventoryAudit` all define `requestPayload`/`responsePayload` CLOBs and are
  **never written by any code path** — 0 rows, no non-definition references in the
  source.
- The only place the raw SOAP envelope and the raw Oracle fault body appear is the
  **application log**.

So: outcomes and error messages are persisted and queryable; full Oracle API
request/response bodies are not. If payload-level auditing is a requirement, the four
audit tables already exist and need wiring into `OracleSoapClient`.

---

## 8. Defects found and fixed during this run

All were pre-existing; four were blocking.

| # | Defect | Status |
|---|---|---|
| 1 | **`repo.upsert()` never fires the `@BeforeInsert` hook** that assigns the client-generated string PK → every reference-data row failed `ORA-01400: cannot insert NULL into (..."id")`. All imports returned 0 rows. | **Fixed** — `ensurePrimaryKey()` in `admin/oracle-native.service.ts`, reusing the existing row's id on conflict so re-imports never re-key a row. Applied at both upsert sites. |
| 2 | **TypeORM aliases an upsert's MERGE target as `"<schema>.<Table>"`** — a single quoted identifier of 35+ chars against this DB's 30-byte limit → `ORA-00972: identifier is too long` on every upsert. | **Fixed** — `database/data-source.ts` omits `schema` when it equals the connecting user; unqualified names resolve to the owner's schema anyway. |
| 3 | **`mgr.insert()` bulk inserts bypass `@BeforeInsert` too** → `BackupOdooOrderLine` / `BackupOdooOrderPayment` never saved, so the transformer fell back to a synthetic line with no item number, and Oracle rejected the invoice with `AR_INVALID_GL_ACCOUNT` (AR-855039). **This broke the core production data path, not just admin imports.** | **Fixed** — explicit `id: generateId()` in `odoo-backup.service.ts`. |
| 4 | **Dashboard crashed on load** — `branch-orders-chart.tsx` and `sync-trend-chart.tsx` still read Prisma's `_count.id`, but the TypeORM endpoints now return `count`. `TypeError: Cannot read properties of undefined`. | **Fixed** — both components and the `BranchOrderStats` / `SyncTrendItem` types. |
| 5 | **Credit memos are posted to the invoice SOAP service.** `createCreditMemo` targets `/fscmService/RecInvoiceService` with the `createSimpleInvoice` action while sending a Credit-Memo-class transaction type → `AR_INVAL_CUST_TRX_TYPE_ID` (AR-856386) every time. Verified with both `Vend` and `Manual` transaction sources, and confirmed `Credit Memo` *is* a valid type in the pod. Also, `buildCreditMemoPayload` has an override for the memo *type* but not the memo *source*. | **Open** — needs the correct Fusion credit-memo service. |
| 6 | `mgr.insert()` in `vendhq-backup.service.ts` has the same PK bug as #3 (legacy path, unverified). | **Open** |
| 7 | `seed-csv` script does not load `.env` — connects to `localhost:1521`. Run as `npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/seed-csv.ts`. Two of the four bundled CSVs also fail to resolve a table slug and the rest violate NOT NULL constraints; the Oracle import in §5 is the working path. | **Open** |
| 8 | `PUT /store-config/:branchCode` zeroes omitted numeric fields (§5). | **Open** |
| 9 | `str()` in the Oracle importer maps a NULL source column to `''`, which Oracle stores as NULL → `ORA-01400` on NOT NULL columns (~5 200 `VENDHQ_ITEM_META` rows skipped). | **Open** |

Stale-but-harmless: `DATABASE_URL` / `DIRECT_DATABASE_URL` in `.env`, the root
`db:generate` / `db:migrate` / `db:studio` scripts, `scripts/init.sql`, and
`packages/backend/scripts/verify-oracle-sync-fix.ts` (imports `@prisma/client`, which is
no longer a dependency) all pre-date the Oracle migration.

---

## 9. Deploying to another server

### 9.1 Docker Compose (recommended)

`docker-compose.yml` + `docker-compose.backend.yml` still describe the **pre-migration**
topology (PostgreSQL, PgBouncer, Redis Sentinel). PostgreSQL and PgBouncer are no longer
used by the application and can be dropped; Redis is still required.

```bash
git clone <repo> && cd new-integration
cp .env.example .env          # repo root — used by compose
# fill in: REDIS_PASSWORD, JWT_SECRET, WEBHOOK_SECRET, ADMIN_*,
#          ORACLE_* (Fusion), ORACLE_DB_* (ERP), APP_DB_* (application DB)
docker compose up -d redis-master backend dashboard
docker compose logs -f backend
```

The backend image must contain the Oracle Instant Client at the path given by
`APP_DB_INSTANT_CLIENT_DIR` / `ORACLE_DB_INSTANT_CLIENT_DIR` (the compose files assume
`/opt/instantclient`). Verify with `docker compose exec backend ls /opt/instantclient`
before debugging connection errors.

### 9.2 Bare metal / VM (Linux)

```bash
# 1. runtime
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm install -g pnpm@9

# 2. Oracle Instant Client (Basic, 21.x) — thick mode is mandatory
sudo apt install -y libaio1 unzip
sudo mkdir -p /opt/instantclient && cd /opt/instantclient
sudo unzip ~/instantclient-basic-linux.x64-21.20.0.0.0dbru.zip --strip-components=1
echo /opt/instantclient | sudo tee /etc/ld.so.conf.d/oracle.conf && sudo ldconfig

# 3. redis
sudo apt install -y redis-server
sudo sed -i 's/^# *requirepass .*/requirepass <REDIS_PASSWORD>/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server

# 4. app
git clone <repo> /opt/new-integration && cd /opt/new-integration
pnpm install --frozen-lockfile
cp packages/backend/.env.example packages/backend/.env   # then fill in per §3
pnpm --filter backend build
pnpm --filter dashboard build

# 5. run under a supervisor
sudo npm install -g pm2
pm2 start "node dist/main" --name integration-api --cwd /opt/new-integration/packages/backend
pm2 start "pnpm start" --name integration-dashboard --cwd /opt/new-integration/packages/dashboard
pm2 save && pm2 startup
```

Then load reference data (§5) and configure stores before enabling the crons.

### 9.3 Environment matrix for a new server

Required, no usable default:

```
APP_DB_HOST APP_DB_PORT APP_DB_SERVICE APP_DB_USERNAME APP_DB_PASSWORD
APP_DB_SCHEMA APP_DB_THICK_MODE APP_DB_INSTANT_CLIENT_DIR
ORACLE_DB_HOST ORACLE_DB_PORT ORACLE_DB_SERVICE ORACLE_DB_USERNAME
ORACLE_DB_PASSWORD ORACLE_DB_ROLE ORACLE_DB_THICK_MODE ORACLE_DB_INSTANT_CLIENT_DIR
ORACLE_REST_BASE_URL ORACLE_SOAP_BASE_URL ORACLE_SOAP_WSDL_URL
ORACLE_USERNAME ORACLE_PASSWORD
ODOO_BASE_URL ODOO_API_KEY
JWT_SECRET ADMIN_EMAIL ADMIN_PASSWORD WEBHOOK_SECRET
REDIS_HOST REDIS_PORT REDIS_PASSWORD
```

Quote any value containing `#`. `JWT_SECRET` is only enforced when
`NODE_ENV=production` — otherwise it silently defaults to `changeme`.

Dashboard build-time vars: `NEXT_PUBLIC_API_URL` (default
`http://localhost:3001/api/v1`) and `NEXT_PUBLIC_WS_URL` (default
`http://localhost:3001`). Four pages hardcode the localhost URL as a fallback, so set
these explicitly for any non-local deployment. Set `CORS_ORIGIN` on the backend to the
dashboard's public origin.

### 9.4 Post-deploy checklist

1. `curl /api/v1/health` → `database: up`
2. `POST /api/v1/auth/login` returns a token
3. `GET /api/v1/sync/admin/circuit-breakers` → all closed
4. Reference import (§5) completes with non-zero row counts
5. One order end-to-end; confirm a `txnNumber` in `FusionInvoiceHeader`
6. `GET /api/v1/admin/sync-control` — crons: odoo-backup (15 min), pipeline (5 min),
   credit-memo (5 min), item-sync (hourly), inventory (30 min)

---

## 9.5 Troubleshooting login

Login is the first thing that breaks on a new server, and the symptom looks the same
for several unrelated causes. Work through them in this order.

**Step 1 — is it the backend or the browser?** Call the API directly:

```bash
curl -X POST http://<backend-host>:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<ADMIN_PASSWORD>"}'
```

- **200 + token** → the backend is fine; the problem is in the dashboard (step 4).
- **401** → credentials or configuration (steps 2–3).
- **connection refused / timeout** → the backend is not running or not reachable.

**Step 2 — read the backend log.** Failed logins now say which half failed:

```
WARN [AuthService] Failed login for "admin@example.com": email matched, password did not
WARN [AuthService] Failed login for "x@y.com": email does not match ADMIN_EMAIL
ERROR [AuthService] Login rejected: ADMIN_EMAIL / ADMIN_PASSWORD (missing) not configured.
```

**Step 3 — check the credential env vars.** There is no user table; the only account is
`ADMIN_EMAIL` / `ADMIN_PASSWORD` from the backend environment. If either is unset every
login returns 401 (with the ERROR line above). Remember that **dotenv truncates an
unquoted value at `#`** — quote any password containing one.

⚠️ **The bundled defaults disagree, so the password depends on how you deployed:**

| Source | Default `ADMIN_PASSWORD` |
|---|---|
| `packages/backend/.env` (dev server via `pnpm dev`) | `123456789` |
| `packages/backend/.env.example` | `123456789` |
| `docker-compose.yml` / `docker-compose.backend.yml` | `admin123` |
| root `.env.example` (used by compose) | `admin123` |

A Compose deployment with no `ADMIN_PASSWORD` in the root `.env` therefore expects
`admin123`, while the local dev server expects `123456789` — the same password fails in
exactly one of the two. **Set `ADMIN_PASSWORD` explicitly in every environment** rather
than relying on any of these defaults, and never ship the defaults to anything
internet-facing.

Email is now compared case- and whitespace-insensitively, so `Admin@Example.com` and a
copy-pasted `" admin@example.com "` both work. The password is still matched exactly,
including whitespace.

**Step 4 — `NEXT_PUBLIC_API_URL` (the usual new-server cause).** These variables are
inlined into the browser bundle at **build** time. If the dashboard was built without
them, the bundle contains `http://localhost:3001/api/v1`, so each visitor's browser
tries to reach *its own machine* — login fails with a network error while `curl` on the
server works perfectly. Setting the variable at runtime does not help; you must rebuild:

```bash
cd packages/dashboard
cp .env.example .env.local     # set NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL
pnpm build && pnpm start
```

Confirm what was actually baked in: open DevTools → Network on the login page and check
the host the `auth/login` request goes to.

**Step 5 — CORS.** If the browser reports a CORS failure, set `CORS_ORIGIN` on the
backend to the dashboard's exact public origin (scheme + host + port) and restart. It
defaults to `http://localhost:3000` in development only.

**Step 6 — rate limiting.** `/auth/login` is throttled to 10 requests/minute. Repeated
testing returns 429; wait a minute.

**Step 7 — bounced straight back to the login page after a successful sign-in.** The
token was accepted but a later request returned 401, so the client cleared it. The token
lasts `JWT_EXPIRES_IN` (default 8h). Note that `JWT_SECRET` is only enforced when
`NODE_ENV=production`; otherwise it silently defaults to `changeme`, so tokens minted by
one instance are rejected by another with a different secret — set an explicit shared
`JWT_SECRET` whenever more than one backend instance is running.

---

## 10. Scheduled jobs

| Job | Schedule | Notes |
|---|---|---|
| `OdooBackupService.runBackupJob` | every 15 min | watermark in `OdooBackupState` |
| `OdooBackupService.runCredentialBackupJob` | every 15 min, +7 min offset | per-region credentials |
| `PipelineSchedulerService` | every 5 min | drives the sync pipeline; fail-fast circuit breaker |
| `CreditMemoService` | every 5 min | currently always fails — defect #5 |
| `ItemSyncService` | hourly | delegates to the direct-DB Oracle import (the REST items resource is search-only) |
| `FusionInvToVendHq` | every 30 min | inventory |

All are individually toggleable via `GET/POST /api/v1/admin/sync-control`.
