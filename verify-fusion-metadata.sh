#!/bin/bash
# Fusion Metadata Integration - Quick Test Script

set -e

echo "=========================================="
echo "Fusion Metadata Integration - Test Script"
echo "=========================================="
echo ""

# Check if TOKEN is set
if [ -z "$TOKEN" ]; then
  echo "❌ ERROR: TOKEN environment variable not set"
  echo "Usage: export TOKEN='your-bearer-token' && ./verify-fusion-metadata.sh"
  exit 1
fi

BASE_URL="${BASE_URL:-http://localhost:3001}"
API_BASE="${BASE_URL}/api/v1"

echo "Testing against: ${API_BASE}"
echo ""

# Test 1: Check metadata for SA region
echo "Test 1: Checking FusionSalesMetadata for region 'SA'..."
RESPONSE=$(curl -s -H "Authorization: ******" "${API_BASE}/sync/debug/metadata/SA")
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
echo ""

# Test 2: Test invoice building with SA metadata
echo "Test 2: Testing invoice building with SA metadata..."
RESPONSE=$(curl -s -X POST -H "Authorization: ******" "${API_BASE}/sync/debug/test-invoice/SA")
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
echo ""

# Test 3: Check recent fusion invoice headers
echo "Test 3: Checking recent fusion invoice headers..."
RESPONSE=$(curl -s -H "Authorization: ******" "${API_BASE}/admin/fusion-invoice-headers?limit=5")
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
echo ""

echo "=========================================="
echo "Tests complete!"
echo "=========================================="
echo ""
echo "To sync a specific order, run:"
echo "curl -X POST -H \"Authorization: ******" \\"
echo "  ${API_BASE}/sync/sync-direct/YOUR_ORDER_ID"
echo ""
