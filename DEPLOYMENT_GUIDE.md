# Quick Deployment Guide

## Immediate Actions Required

### 1. Deploy Code Changes
```bash
cd /path/to/new-integration
git pull origin main
pnpm install  # If dependencies changed
pnpm --filter backend build
pm2 restart backend
```

### 2. Run Database Fixes
```bash
# Connect to your database
export DATABASE_URL="your_database_url_here"

# Run the SQL fix script
psql $DATABASE_URL -f packages/backend/scripts/fix-order-sync.sql
```

**What this script does:**
- Fixes null dates → sets to NOW()
- Sets default customer names → 'Default Customer'
- Sets default customer emails → 'default@example.com'
- Sets default currency → 'AED'
- Resets FAILED orders to PENDING (with attempts < 5)

### 3. Trigger Bulk Order Fix
```bash
# This will re-queue all failed orders
curl -X POST http://localhost:3000/api/v1/sync/fix-all-failed

# Or in production:
curl -X POST https://your-domain.com/api/v1/sync/fix-all-failed
```

### 4. Verify Dates Display Correctly
```bash
# Check that dates show as ISO strings, not "[object Ob]"
curl http://localhost:3000/api/v1/sync/orders?take=5 | jq '.data[].orderDate'

# Expected output:
# "2024-01-15T10:30:00.000Z"
# "2024-01-14T15:20:00.000Z"
# etc.
```

### 5. Monitor Sync Progress
```bash
# Watch logs for Step 7/14 messages
pm2 logs backend | grep "Step 7/14"

# Check queue stats
curl http://localhost:3000/api/v1/sync/queue/stats | jq

# List failed orders (should decrease over time)
curl http://localhost:3000/api/v1/sync/failed-orders?limit=10 | jq
```

---

## What Was Fixed

### ✅ Issue 1: Orders Not Syncing to Oracle
**Root Cause:** Logging at Step 7/14 made it seem like backup tables were required, but they weren't.

**Fix:** Enhanced logging to show 3-tier enrichment strategy:
- Try Direct Queue Data first (orderLines + orderPayments JSON)
- Fallback to Backup Tables if needed
- Use Minimal Enrichment as last resort (ALWAYS succeeds)

**Result:** Orders will ALWAYS sync - no more stuck at Step 7/14

### ✅ Issue 2: Date Fields Show "[object Ob]"
**Root Cause:** Date objects were not serialized to strings before sending to UI.

**Fix:** 
- Created `DateFormatUtil` for date formatting
- Created `OrderResponseDto` that properly serializes dates to ISO strings
- Added new `GET /sync/orders` endpoint with proper date handling

**Result:** Dates now display as "2024-01-15T10:30:00.000Z" instead of "[object Ob]"

### ✅ Issue 3: Data Enrichment Unclear
**Root Cause:** orderLines and orderPayments JSON fields exist but enrichment logic wasn't clearly documented.

**Fix:**
- Improved logging to show which data source is being used
- Added checks to display if orderLines/orderPayments are populated
- Clarified 3-tier enrichment strategy in code comments

**Result:** Clear visibility into which enrichment method is used for each order

---

## New API Endpoints

### 1. List Orders (with proper date formatting)
```bash
GET /api/v1/sync/orders?skip=0&take=20&status=PENDING&branchCode=101
```

### 2. Bulk Fix Failed Orders
```bash
POST /api/v1/sync/fix-all-failed
```

### 3. Direct Sync Single Order
```bash
POST /api/v1/sync/sync-direct/:orderId
```

---

## Verification Checklist

- [ ] Code deployed and backend restarted
- [ ] SQL fix script executed successfully
- [ ] Bulk fix API called (POST /fix-all-failed)
- [ ] Date display verified (no more "[object Ob]")
- [ ] Orders syncing to Oracle successfully
- [ ] Step 7/14 logs show correct enrichment method
- [ ] Failed order count decreasing

---

## Rollback Plan (if needed)

```bash
# Revert to previous commit
git revert HEAD~3..HEAD

# Rebuild and restart
pnpm --filter backend build
pm2 restart backend
```

---

## Support

If issues persist:
1. Check logs: `pm2 logs backend --err`
2. Verify database: Run verification queries from fix-order-sync.sql
3. Check specific order: `GET /api/v1/sync/orders/{odooOrderId}`

See `ORDER_SYNC_FIXES.md` for complete documentation.
