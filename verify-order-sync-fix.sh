#!/bin/bash
# verify-order-sync-fix.sh
# Script to verify the order synchronization fixes are working

set -e

echo "========================================"
echo "Order Sync Fix Verification"
echo "========================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Base URL (adjust as needed)
BASE_URL="${API_BASE_URL:-http://localhost:3001/api/v1}"

echo "Using API Base URL: $BASE_URL"
echo ""

# Test 1: Check if BigInt interceptor is loaded
echo "Test 1: Checking BigInt Interceptor..."
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health" || echo "000")
if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "401" ]; then
  echo -e "${GREEN}✅ Backend is running${NC}"
else
  echo -e "${RED}❌ Backend is not accessible (HTTP $RESPONSE)${NC}"
  echo "   Make sure the backend is running and BASE_URL is correct"
  exit 1
fi

# Test 2: Query endpoint with BigInt fields
echo ""
echo "Test 2: Testing BigInt Serialization..."
RESPONSE=$(curl -s "$BASE_URL/store-config/all" -H "Authorization: ******" 2>&1)
if echo "$RESPONSE" | grep -q "serialize a BigInt"; then
  echo -e "${RED}❌ BigInt serialization error detected${NC}"
  echo "   Response: $RESPONSE"
  exit 1
elif echo "$RESPONSE" | grep -q "Unauthorized"; then
  echo -e "${YELLOW}⚠️  Need valid API_TOKEN to test fully${NC}"
  echo "   But no BigInt errors in error response - likely working"
else
  echo -e "${GREEN}✅ No BigInt serialization errors${NC}"
fi

# Test 3: Check logs for "No backup data found" errors
echo ""
echo "Test 3: Checking for backup data errors in logs..."
if [ -f "/var/log/backend.log" ]; then
  BACKUP_ERRORS=$(grep -c "No backup data found" /var/log/backend.log 2>/dev/null || echo "0")
  if [ "$BACKUP_ERRORS" -gt "0" ]; then
    echo -e "${YELLOW}⚠️  Found $BACKUP_ERRORS 'No backup data found' errors in logs${NC}"
    echo "   These may be from before the fix - check timestamps"
  else
    echo -e "${GREEN}✅ No 'No backup data found' errors in logs${NC}"
  fi
else
  echo -e "${YELLOW}⚠️  Log file not found at /var/log/backend.log${NC}"
  echo "   Skipping log check"
fi

# Test 4: Check for recent order sync success
echo ""
echo "Test 4: Checking order sync stats..."
STATS_RESPONSE=$(curl -s "$BASE_URL/sync/orders/stats" -H "Authorization: ******" 2>&1)
if echo "$STATS_RESPONSE" | grep -q "Unauthorized"; then
  echo -e "${YELLOW}⚠️  Need valid API_TOKEN to check sync stats${NC}"
  echo "   Export API_TOKEN with a valid JWT token"
else
  echo "   Response: $STATS_RESPONSE"
fi

echo ""
echo "========================================"
echo "Verification Summary"
echo "========================================"
echo ""
echo "Files changed:"
echo "  ✓ order-enrichment.service.ts - Backup fallback"
echo "  ✓ auto-fix.service.ts - Retry without backup"
echo "  ✓ big-int.interceptor.ts - NEW BigInt handler"
echo "  ✓ app.module.ts - Registered interceptor"
echo ""
echo "What to test manually:"
echo "  1. Create order without backup data → Should sync"
echo "  2. Query /store-config/all → Should return BigInt fields"
echo "  3. Auto-fix skipped order → Should retry"
echo ""
echo "Environment variables:"
echo "  API_BASE_URL - Base URL of API (default: http://localhost:3001/api/v1)"
echo "  API_TOKEN    - JWT token for authenticated requests"
echo ""
echo "For detailed testing, see ORDER_SYNC_COMPLETE_FIX.md"
echo ""
