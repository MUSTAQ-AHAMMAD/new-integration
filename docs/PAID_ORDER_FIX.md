# Paid Order Detection Fix

## Problem

The system was marking 200+ orders as "Not Paid" and skipping them, even though these orders were already paid in Odoo.

## Root Cause

The system was checking the order's `state` field against a hardcoded list of "paid states" (`paid`, `done`, `posted`, `invoiced`, `sale`, `invoice`, `confirmed`, `validated`, `sent`). Any order with a different state was marked as `isPaid = false` and skipped.

**However**, the Odoo/IBQ API calls **already filter** and return **ONLY paid orders**. The state-checking logic was redundant and causing false negatives.

## Solution

### 1. Updated Order Normalization Logic

Modified `packages/backend/src/common/odoo-utils.ts`:

```typescript
// BEFORE: Check state against hardcoded list
const isPaid = PAID_ORDER_STATES.includes(normalizedState as any);

// AFTER: Trust the API source - all fetched orders are paid
const isCancelled = normalizedState === 'cancel' || normalizedState === 'cancelled';
const isPaid = !isCancelled;  // Mark as paid unless explicitly cancelled
```

**Rationale**: Since the Odoo/IBQ API already filters for paid orders at the source, any order in the backup/sync queue should be considered paid by default (unless explicitly cancelled).

### 2. Fix Script for Existing Orders

Created `packages/backend/scripts/fix-skipped-orders.ts` to update all existing skipped orders in the database.

## How to Apply the Fix

### Step 1: Update Existing Skipped Orders

Run the fix script to update the 200 skipped orders:

```bash
cd packages/backend
npx ts-node scripts/fix-skipped-orders.ts
```

This will:
- Find all orders with `status = SKIPPED` and `isPaid = false`
- Update them to `isPaid = true` and `status = PENDING`
- Clear validation errors and reset sync attempts
- Orders will be picked up by the automatic sync pipeline within 5 minutes

### Step 2: Monitor Progress

1. **Dashboard**: Visit http://localhost:3000/orders to see orders being processed
2. **Skipped Orders Page**: Check http://localhost:3000/skipped-orders - it should drop to 0
3. **Logs**: Watch backend logs for sync progress

## Future Behavior

Going forward:
- **All orders fetched from Odoo/IBQ will be marked as paid by default**
- Only explicitly cancelled orders will be marked as `isPaid = false`
- No more false negatives due to unexpected state values

## API Endpoints

If you need to manually retry orders:

```bash
# Retry all skipped orders
POST /api/v1/sync/orders/retry-skipped

# Retry specific order
POST /api/v1/sync/order-queue/:id/retry
```

## Verification

After running the fix script, verify:

```bash
# Check skipped order count (should be 0 or near 0)
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/order-queue?status=SKIPPED

# Check pending orders (should show the 200 orders)
curl -H "Authorization: ******" \
  http://localhost:3001/api/v1/sync/order-queue?status=PENDING
```

## Notes

- The `PAID_ORDER_STATES` constant is kept for reference but no longer used for filtering
- This aligns with the Java integration behavior: process ALL orders from backup table
- The fix is safe: cancelled orders are still properly excluded
