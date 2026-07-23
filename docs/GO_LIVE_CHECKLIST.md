# Go-Live Checklist — Odoo → Oracle Fusion Daily Invoicing

The daily Odoo→Oracle cycle is **code-complete and verified** (see
`RUNBOOK_E2E_AND_DEPLOYMENT.md`). What remains before a region goes live is
**environment and configuration** work that code cannot do for you. Each item below
names its owner and how to confirm it.

Run the preflight at any time to see current status:

```
GET /api/v1/sync/daily-invoice/readiness/<REGION>     # → ready true/false + blockers
```

---

## 1. Reference data loaded  ·  Owner: Integration operator

For each region you are turning on, import the Oracle reference data:

```
POST /api/v1/admin/oracle-import                       # config tables
POST /api/v1/admin/oracle-import/customer-accounts     # account → cust_account_id
```

Confirm with readiness: Sales metadata / Receipt methods / BU map / Registers /
Customer accounts must all be **PASS**.

---

## 2. Store configurations  ·  Owner: Integration operator (+ review)

Seed the whole region, then review:

```
POST /api/v1/store-config/seed-region  {"region":"SN","dryRun":true}   # preview
POST /api/v1/store-config/seed-region  {"region":"SN"}                 # write
```

- Every `NEEDS_REVIEW` outlet needs a human check — especially the **branch code**.
  Outlets that have not yet sent an Odoo order get a *provisional* branch code from the
  site number; confirm it equals the outlet's real Odoo `branch_id` (the value incoming
  orders carry), or the orders won't match the config.
- `SKIPPED_NO_METADATA` outlets have no bill-to match in `FusionSalesMetadata` — add the
  metadata row or exclude the outlet.
- Readiness "Active stores" must show **0 INVALID**.

---

## 3. Outlet gating verified  ·  Owner: Integration operator

`OUTLETS_INTEGRATION_CONFIG.INTEG_MODE` decides what runs automatically:

- `NONE` → never integrated. Confirm every decommissioned/handled-elsewhere outlet is
  `NONE` (SN currently has 30).
- `MANUAL` → only via an operator trigger (`"trigger":"MANUAL"`).
- `AUTOMATIC` → only via the 03:00 scheduled run.

Readiness "Outlet gating" shows the counts.

---

## 4. Credit memos — RESOLVED IN CODE ✅  ·  Owner: Integration operator

Refunds now post as real Oracle credit memos, verified live (memo `1399172`, Complete).
The earlier `AR_INVAL_CUST_TRX_TYPE_ID` blocker is gone: the code no longer uses the SOAP
AutoInvoice service (which needs an imported Credit-Memo batch source your pod lacks) and
instead creates the memo through the **`receivablesCreditMemos` REST resource** with the
`Manual` source — the same channel the Fusion UI uses. The revenue account is derived from
a real invoice's distribution with the store's own cost centre substituted, so no
chart-of-accounts is hard-coded.

Operational notes:
- Refunds stay **separate** and are pushed **manually** from the credit-memo menu
  (`POST /api/v1/refunds/:id/push` or `/process-pending`) — the auto-push cron is off
  (`CREDIT_MEMO_AUTO_PUSH_ENABLED=false`) per the manual-only requirement.
- Each store must have at least one **successful sales invoice** first (that's where the
  revenue account template comes from) — true by the time any refund exists.
- `CreditReason` is intentionally not sent (Oracle rejects free text); the refund reason
  goes on the line description. If you want a coded reason, pass a value from Oracle's
  credit-memo reason lookup.

---

## 5. Oracle Inventory — interface processor  ·  Owner: **Oracle administrator**

Inventory issues are posted to `inventoryStagedTransactions` (the deprecated
`inventoryTransactions` the legacy Java used is 403 on this pod). They land with
`ProcessStatus = 1` and are relieved when Oracle's **transaction manager** interface job
runs.

Confirm with the Oracle admin:
1. The "Manage Inventory Transactions" / transaction-manager ESS job is scheduled.
2. The transaction type is correct for your setup — default is `Account Issue`; override
   with `ORACLE_INVENTORY_TXN_TYPE` if you use a specific one (e.g. `Vend Sales Issue`).
3. Spot-check that a posted `FusionInvTxn` (status SUCCESS) actually relieves on-hand
   quantity a few minutes later.

---

## 6. Live Odoo source  ·  Owner: Integration operator / Odoo admin

All testing used a local mock because the configured tenant's DNS resolves to `0.0.0.0`.
Before go-live:
1. Point `ODOO_BASE_URL` / `ODOO_API_KEY` (or a per-region `OdooCredential`) at the live
   tenant.
2. Pull a day: `POST /api/v1/sync/fetch-odoo {"startDate":"…","endDate":"…"}` and confirm
   real orders back up into `BackupOdooOrder`/`Line`/`Payment`.
3. Confirm the live order shape matches (branch_id, lines, statement_ids, customer_type).

---

## 7. Financial validation  ·  Owner: Finance + Integration operator

- **Cash rounding** is folded into the Cash standard receipt (Java parity) but was never
  exercised with real rounding data. Reconcile one real cash-rounding day before trusting
  it.
- **GL journals** (delivery-platform / non-`NORMAL` sales) now post the service-provider
  commission, not the gross. Validate the amounts on a real service-provider day.
- **Tax**: lines send no `TaxClassificationCode`; Oracle applies the customer/site default
  VAT. Confirm that default is correct for each bill-to, or supply a validated
  Odoo-tax → Oracle-code map.

---

## 8. Operational safety  ·  Owner: DevOps

- If you run more than one backend instance (or API + worker), the daily job is protected
  by a **DB-backed lock** — verified. No extra action needed, but do set a shared explicit
  `JWT_SECRET` (otherwise tokens minted by one instance are rejected by another).
- Set `SMTP_*` and configure daily-report recipients so the **run-summary email** is
  delivered rather than only logged.
- Instant Client path and thick mode must be correct on every host (see runbook §3).

---

## Pilot procedure (recommended)

1. Pick one region. Complete items 1–3, 6.
2. Readiness must be `ready: true`.
3. Run **manually** for one business day:
   `POST /api/v1/sync/daily-invoice {"region":"<R>","startDate":"<day>","days":1,"trigger":"MANUAL"}`
   (temporarily set the pilot outlets to `MANUAL`, or a single branch by `branchCode`).
4. Reconcile the created invoices/receipts/inventory in Oracle by hand.
5. Repeat for 3–5 days. When clean, set the outlets to `AUTOMATIC` and enable the
   `daily-invoice` cron.
6. Items 4, 5, 7 can proceed in parallel with the Oracle admin and Finance.
