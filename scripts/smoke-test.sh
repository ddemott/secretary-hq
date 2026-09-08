#!/usr/bin/env bash
set -euo pipefail

# smoke-test.sh: Runs basic smoke tests against a deployed SecretaryHQ backend.
# Usage: ./scripts/smoke-test.sh <backend-url> [admin-email] [admin-password]
#
# Examples:
#   ./scripts/smoke-test.sh https://your-backend.railway.app
#   ./scripts/smoke-test.sh https://localhost:4001 admin@secretaryhq.com p@ssw0rd
#
# Uses env vars ADMIN_EMAIL and ADMIN_PASSWORD as fallbacks.

BACKEND_URL="${1:-}"
ADMIN_EMAIL="${2:-${ADMIN_EMAIL:-admin@secretaryhq.com}}"
ADMIN_PASSWORD="${3:-${ADMIN_PASSWORD:-p@ssw0rd}}"

if [ -z "$BACKEND_URL" ]; then
  echo "Usage: ./scripts/smoke-test.sh <backend-url> [admin-email] [admin-password]"
  echo "Example: ./scripts/smoke-test.sh https://your-backend.railway.app"
  exit 1
fi

# Strip trailing slash
BACKEND_URL="${BACKEND_URL%/}"

log() { echo "[secretaryhq] $1"; }

PASS=0
FAIL=0
TOTAL=0

# Allow self-signed certs for local testing
CURL_OPTS="-s --max-time 10"
if [[ "$BACKEND_URL" == *"localhost"* ]] || [[ "$BACKEND_URL" == *"127.0.0.1"* ]]; then
  CURL_OPTS="$CURL_OPTS -k"
fi

run_test() {
  local name="$1"
  local pass="$2"
  TOTAL=$((TOTAL + 1))
  if [ "$pass" = "true" ]; then
    PASS=$((PASS + 1))
    echo "  [PASS] $name"
  else
    FAIL=$((FAIL + 1))
    echo "  [FAIL] $name"
  fi
}

echo "============================================"
echo " SecretaryHQ - Smoke Tests"
echo " Target: $BACKEND_URL"
echo "============================================"
echo ""

# ---------------------------------------------------------------------------
# Test 1: Health check
# ---------------------------------------------------------------------------
echo "1. Health check..."
HEALTH_RESPONSE=$(curl $CURL_OPTS "$BACKEND_URL/health" 2>/dev/null || echo "")
HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | grep -oP '"status"\s*:\s*"ok"' || echo "")

if [ -n "$HEALTH_STATUS" ]; then
  run_test "GET /health returns {\"status\":\"ok\"}" "true"
else
  run_test "GET /health returns {\"status\":\"ok\"} (got: $HEALTH_RESPONSE)" "false"
fi

# ---------------------------------------------------------------------------
# Test 2: Login
# ---------------------------------------------------------------------------
echo ""
echo "2. Authentication..."
LOGIN_RESPONSE=$(curl $CURL_OPTS -X POST "$BACKEND_URL/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null || echo "")

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -oP '"token"\s*:\s*"[^"]*"' | grep -oP '"[^"]*"$' | tr -d '"' || echo "")

if [ -n "$TOKEN" ]; then
  run_test "POST /login returns a token" "true"
else
  run_test "POST /login returns a token (got: $LOGIN_RESPONSE)" "false"
  log "WARNING: Cannot run authenticated tests without a valid token."
  log "Remaining tests will likely fail."
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

# ---------------------------------------------------------------------------
# Test 3: Tenants
# ---------------------------------------------------------------------------
echo ""
echo "3. Tenants endpoint..."
TENANTS_RESPONSE=$(curl $CURL_OPTS "$BACKEND_URL/tenants" \
  -H "$AUTH_HEADER" 2>/dev/null || echo "")

if echo "$TENANTS_RESPONSE" | grep -qP '^\['; then
  TENANT_COUNT=$(echo "$TENANTS_RESPONSE" | grep -oP '"id"' | wc -l)
  run_test "GET /tenants returns array ($TENANT_COUNT tenants)" "true"
else
  run_test "GET /tenants returns array (got: ${TENANTS_RESPONSE:0:100})" "false"
fi

# ---------------------------------------------------------------------------
# Test 4: Templates
# ---------------------------------------------------------------------------
echo ""
echo "4. Templates endpoint..."
TEMPLATES_RESPONSE=$(curl $CURL_OPTS "$BACKEND_URL/templates" \
  -H "$AUTH_HEADER" 2>/dev/null || echo "")

if echo "$TEMPLATES_RESPONSE" | grep -qP '^\['; then
  TEMPLATE_COUNT=$(echo "$TEMPLATES_RESPONSE" | grep -oP '"id"' | wc -l)
  if [ "$TEMPLATE_COUNT" -ge 29 ]; then
    run_test "GET /templates returns 29+ templates ($TEMPLATE_COUNT found)" "true"
  else
    run_test "GET /templates returns 29+ templates (only $TEMPLATE_COUNT found)" "false"
  fi
else
  run_test "GET /templates returns array (got: ${TEMPLATES_RESPONSE:0:100})" "false"
fi

# ---------------------------------------------------------------------------
# Test 5: Vocabulary
# ---------------------------------------------------------------------------
echo ""
echo "5. Vocabulary endpoint..."

# Use the Bella's Hair Studio demo tenant ID (DynaTire PoC removed 2026-06-03)
POC_TENANT="b3e1aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

VOCAB_RESPONSE=$(curl $CURL_OPTS "$BACKEND_URL/vocabulary?tenant_id=$POC_TENANT" \
  -H "$AUTH_HEADER" 2>/dev/null || echo "")

VOCAB_HTTP=$(curl $CURL_OPTS -o /dev/null -w "%{http_code}" "$BACKEND_URL/vocabulary?tenant_id=$POC_TENANT" \
  -H "$AUTH_HEADER" 2>/dev/null || echo "000")

if [ "$VOCAB_HTTP" = "200" ]; then
  run_test "GET /vocabulary returns 200" "true"
else
  run_test "GET /vocabulary returns 200 (got HTTP $VOCAB_HTTP)" "false"
fi

# ---------------------------------------------------------------------------
# Test 6: Customers
# ---------------------------------------------------------------------------
echo ""
echo "6. Customers endpoint..."

CUSTOMERS_HTTP=$(curl $CURL_OPTS -o /dev/null -w "%{http_code}" "$BACKEND_URL/customers?tenant_id=$POC_TENANT" \
  -H "$AUTH_HEADER" 2>/dev/null || echo "000")

if [ "$CUSTOMERS_HTTP" = "200" ]; then
  run_test "GET /customers returns 200" "true"
else
  run_test "GET /customers returns 200 (got HTTP $CUSTOMERS_HTTP)" "false"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo " Results: $PASS/$TOTAL passed, $FAIL failed"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  log "Some tests failed. Check the output above for details."
  exit 1
else
  echo ""
  log "All smoke tests passed!"
  exit 0
fi
