# Quick Fix for Order 160909

## TL;DR - Fix in 3 Steps

### 1. Auto-Fix (Recommended)
```bash
curl -X POST "http://localhost:3001/api/v1/sync/auto-fix/skipped-orders?odooOrderId=160909"
```

### 2. If Auto-Fix Doesn't Work - Diagnose
```bash
curl http://localhost:3001/api/v1/sync/orders/160909/diagnose
```

### 3. Manual Retry
```bash
# If order is marked as paid but still skipped
curl -X POST http://localhost:3001/api/v1/sync/orders/retry-skipped
```

## Docker Quick Commands

```bash
# Run diagnostic script
docker exec -it integration_backend npx ts-node -r tsconfig-paths/register /app/packages/backend/src/scripts/diagnose-order-160909.ts

# Enable debug logging (add to .env)
ODOO_UTILS_DEBUG=true

# Restart backend
docker compose restart backend

# Watch logs
docker compose logs -f backend --tail=50 | grep "160909"
```

## What the Auto-Fix Does

1. Finds order 160909 in OrderSyncQueue
2. Checks why it was skipped
3. If order state is valid but isPaid=false:
   - Updates isPaid=true
   - Changes status to PENDING
   - Re-queues for sync
4. Returns result with action taken

## Response Interpretation

```json
{
  "totalProcessed": 1,
  "fixed": 1,
  "couldNotFix": 0,
  "results": [{
    "orderSyncQueueId": "xyz",
    "odooOrderId": "160909",
    "branchCode": "3",
    "issue": "not_marked_as_paid",
    "action": "reingest",
    "success": true,
    "message": "Order state \"invoiced\" indicates payment, but isPaid=false. Re-ingesting from backup. Order updated and re-queued for sync."
  }]
}
```

### Success Scenarios
- `"success": true` - Order was fixed
- `"action": "reingest"` - Order state valid, marked as paid, re-queued
- `"action": "retry"` - Order already paid, just needed re-queueing

### Cannot Fix Scenarios
- `"issue": "cancelled"` - Order is cancelled (intentional skip)
- `"action": "none"` + unknown state - State not in PAID_ORDER_STATES, needs manual review
- Missing backup data - Cannot determine if should be paid

## Common State Issues

| Order State | Should be Paid? | In PAID_ORDER_STATES? | Action |
|-------------|----------------|----------------------|---------|
| draft | ❌ No | No (in UNPAID_ORDER_STATES) | Skip |
| quotation | ❌ No | No (in UNPAID_ORDER_STATES) | Skip |
| cancelled | ❌ No | No (explicit check) | Skip |
| paid | ✅ Yes | Yes | Sync |
| done | ✅ Yes | Yes | Sync |
| posted | ✅ Yes | Yes | Sync |
| invoiced | ✅ Yes | Yes | Sync |
| sale | ✅ Yes | Yes | Sync |
| confirmed | ✅ Yes | Yes | Sync |
| *unknown* | ❓ Maybe | No | Check payment data |

## When to Add a New State

If auto-fix suggests a state appears frequently:

```bash
curl http://localhost:3001/api/v1/sync/auto-fix/suggest-states
```

Example output:
```json
{
  "suggestions": [
    {
      "state": "pending",
      "count": 45,
      "sample": {
        "orderId": 160909,
        "orderName": "Order/0001",
        "amountTotal": 500.00,
        "hasStatementIds": true,
        "hasPaymentIds": true
      }
    }
  ]
}
```

**Interpretation:**
- `count > 10` and `hasPaymentIds: true` → Likely should be a paid state
- Add to PAID_ORDER_STATES in `packages/backend/src/common/odoo-utils.ts`

## Full Documentation

See [ORDER_SYNC_ISSUE_FIX.md](./ORDER_SYNC_ISSUE_FIX.md) for complete guide.
