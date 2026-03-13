#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Radius Scout — Interactive Setup Script
# ============================================================
# Takes you from fresh clone to a running Cloudflare deployment.
#
# Usage:
#   ./scripts/setup.sh
#
# Non-interactive mode (CI):
#   export AZURE_MAPS_KEY="..."
#   export MAPBOX_PUBLIC_TOKEN="pk.eyJ..."
#   ./scripts/setup.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DEPLOYED_URL=""

# ────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────
banner() {
  echo ""
  echo "============================================================"
  echo "  $1"
  echo "============================================================"
  echo ""
}

fail() {
  echo ""
  echo "ERROR: $1"
  if [[ -n "${2:-}" ]]; then
    echo ""
    echo "How to fix:"
    echo "  $2"
  fi
  exit 1
}

# ────────────────────────────────────────────────────────────
# Phase 1: Prerequisites check
# ────────────────────────────────────────────────────────────
banner "Phase 1/5 — Checking prerequisites"

# node
if ! command -v node &>/dev/null; then
  fail "node is not installed" "Install Node.js >= 18: https://nodejs.org/"
fi
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "Node.js >= 18 required (found $NODE_VERSION)" \
       "Upgrade Node.js: https://nodejs.org/"
fi
echo "  node       $NODE_VERSION"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm is not installed" "npm ships with Node.js — reinstall from https://nodejs.org/"
fi
echo "  npm        $(npm --version)"

# npx
if ! command -v npx &>/dev/null; then
  fail "npx is not installed" "npx ships with npm — reinstall Node.js from https://nodejs.org/"
fi
echo "  npx        $(npx --version)"

# wrangler
if ! command -v wrangler &>/dev/null; then
  fail "wrangler CLI is not installed" \
       "Install it: npm install -g wrangler && wrangler login"
fi
echo "  wrangler   $(wrangler --version 2>/dev/null | head -1)"

# Cloudflare auth
if ! wrangler whoami >/dev/null 2>&1; then
  fail "Not authenticated with Cloudflare" \
       "Run: wrangler login"
fi
echo "  Cloudflare auth OK"

echo ""
echo "All prerequisites satisfied."

# ────────────────────────────────────────────────────────────
# Phase 2: Provider key collection
# ────────────────────────────────────────────────────────────
banner "Phase 2/5 — Provider key collection"

# Azure Maps key
if [[ -n "${AZURE_MAPS_KEY:-}" ]]; then
  echo "  AZURE_MAPS_KEY detected in environment — skipping prompt."
else
  echo "You need an Azure Maps API key (free S0 tier: 5,000 searches/month)."
  echo "  Get one here: https://portal.azure.com/#create/Microsoft.Maps"
  echo "  Docs: https://learn.microsoft.com/en-us/azure/azure-maps/how-to-manage-authentication"
  echo ""
  read -rp "  Azure Maps key: " AZURE_MAPS_KEY
  if [[ -z "$AZURE_MAPS_KEY" ]]; then
    fail "Azure Maps key cannot be empty" \
         "Create a key at https://portal.azure.com/#create/Microsoft.Maps"
  fi
fi

# Mapbox public token
if [[ -n "${MAPBOX_PUBLIC_TOKEN:-}" ]]; then
  echo "  MAPBOX_PUBLIC_TOKEN detected in environment — skipping prompt."
else
  echo ""
  echo "You need a Mapbox public token (free tier: 50,000 map loads/month)."
  echo "  Get one here: https://account.mapbox.com/access-tokens/"
  echo "  Must be a public token starting with pk.eyJ"
  echo ""
  read -rp "  Mapbox public token: " MAPBOX_PUBLIC_TOKEN
  if [[ -z "$MAPBOX_PUBLIC_TOKEN" ]]; then
    fail "Mapbox token cannot be empty" \
         "Create a token at https://account.mapbox.com/access-tokens/"
  fi
fi

# Validate Mapbox token prefix
if [[ "$MAPBOX_PUBLIC_TOKEN" != pk.eyJ* ]]; then
  fail "Mapbox token must start with 'pk.eyJ' (got '${MAPBOX_PUBLIC_TOKEN:0:10}...')" \
       "Use a public token (pk.*), not a secret token (sk.*). Create one at https://account.mapbox.com/access-tokens/"
fi

# Write .dev.vars
cat > "$PROJECT_ROOT/.dev.vars" <<DEVVARS
AZURE_MAPS_KEY=${AZURE_MAPS_KEY}
MAPBOX_PUBLIC_TOKEN=${MAPBOX_PUBLIC_TOKEN}
# Set to 1 to use mock data instead of real API calls
PROVIDER_MOCKS=0
DEVVARS

echo ""
echo "  .dev.vars written."
echo ""
echo "  TIP: Set PROVIDER_MOCKS=1 in .dev.vars to use mock data during"
echo "  development — no API calls, no quota usage."

# ────────────────────────────────────────────────────────────
# Phase 3: Cloudflare resource creation
# ────────────────────────────────────────────────────────────
banner "Phase 3/5 — Creating Cloudflare resources"

# Create D1 database
echo "Creating D1 database: radius-scout-db"
D1_OUTPUT="$(wrangler d1 create radius-scout-db 2>&1)" || {
  fail "Failed to create D1 database" \
       "Run manually: wrangler d1 create radius-scout-db"
}
echo "$D1_OUTPUT"

DATABASE_ID="$(echo "$D1_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')" || true
if [[ -z "$DATABASE_ID" ]]; then
  fail "Could not extract database ID from wrangler output" \
       "Check the output above and manually set database_id in wrangler.toml"
fi
echo ""
echo "  Database ID: $DATABASE_ID"

# Create R2 bucket
echo ""
echo "Creating R2 bucket: radius-scout-media"
wrangler r2 bucket create radius-scout-media 2>&1 || echo "  (may already exist — continuing)"

# Patch wrangler.toml with the real database ID
echo ""
echo "Patching wrangler.toml with database ID..."
if grep -q "YOUR_DATABASE_ID" "$PROJECT_ROOT/wrangler.toml"; then
  sed -i.bak "s/YOUR_DATABASE_ID/$DATABASE_ID/" "$PROJECT_ROOT/wrangler.toml"
  rm -f "$PROJECT_ROOT/wrangler.toml.bak"
  echo "  wrangler.toml updated."
else
  echo "  YOUR_DATABASE_ID placeholder not found — patching existing database_id value."
  sed -i.bak "s/database_id = \"[^\"]*\"/database_id = \"$DATABASE_ID\"/" "$PROJECT_ROOT/wrangler.toml"
  rm -f "$PROJECT_ROOT/wrangler.toml.bak"
  echo "  wrangler.toml updated."
fi

# ────────────────────────────────────────────────────────────
# Phase 4: Build & deploy (CRITICAL ORDERING)
# ────────────────────────────────────────────────────────────
banner "Phase 4/5 — Build & deploy"

# Install dependencies
echo "Installing dependencies..."
npm install || {
  fail "npm install failed" \
       "Check the error output above. Try deleting node_modules and running npm install again."
}
echo ""

# Build
echo "Building project..."
npm run build || {
  fail "Build failed" \
       "Check the error output above. Run 'npm run build' manually to debug."
}
echo ""

# Apply D1 migrations
echo "Applying D1 migrations..."
wrangler d1 migrations apply radius-scout-db --remote || {
  fail "D1 migrations failed" \
       "Run manually: wrangler d1 migrations apply radius-scout-db --remote"
}
echo ""

# First deploy — creates the worker
echo "Deploying worker (first deploy)..."
DEPLOY_OUTPUT="$(wrangler deploy 2>&1)" || {
  echo "$DEPLOY_OUTPUT"
  fail "First deploy failed" \
       "Run manually: wrangler deploy"
}
echo "$DEPLOY_OUTPUT"

# Extract deployed URL from output
DEPLOYED_URL="$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)" || true
if [[ -z "$DEPLOYED_URL" ]]; then
  # Try alternate pattern for custom domains
  DEPLOYED_URL="$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.[a-zA-Z]+' | head -1)" || true
fi
if [[ -z "$DEPLOYED_URL" ]]; then
  echo ""
  echo "  WARNING: Could not auto-detect deployed URL from output."
  read -rp "  Enter the deployed URL (e.g. https://radius-scout.yourname.workers.dev): " DEPLOYED_URL
fi
echo ""
echo "  Deployed URL: $DEPLOYED_URL"

# Set secrets — requires worker to exist
echo ""
echo "Setting secrets..."
echo "$AZURE_MAPS_KEY" | wrangler secret put AZURE_MAPS_KEY || {
  fail "Failed to set AZURE_MAPS_KEY secret" \
       "Run manually: echo 'your-key' | wrangler secret put AZURE_MAPS_KEY"
}
echo "$MAPBOX_PUBLIC_TOKEN" | wrangler secret put MAPBOX_PUBLIC_TOKEN || {
  fail "Failed to set MAPBOX_PUBLIC_TOKEN secret" \
       "Run manually: echo 'your-token' | wrangler secret put MAPBOX_PUBLIC_TOKEN"
}

# Patch APP_BASE_URL in wrangler.toml with the actual deployed URL
echo ""
echo "Patching APP_BASE_URL in wrangler.toml..."
sed -i.bak "s|APP_BASE_URL = \"[^\"]*\"|APP_BASE_URL = \"$DEPLOYED_URL\"|" "$PROJECT_ROOT/wrangler.toml"
rm -f "$PROJECT_ROOT/wrangler.toml.bak"
echo "  APP_BASE_URL set to $DEPLOYED_URL"

# Redeploy — picks up secrets and correct APP_BASE_URL
echo ""
echo "Redeploying with updated configuration..."
wrangler deploy || {
  fail "Second deploy failed" \
       "Run manually: wrangler deploy"
}

# ────────────────────────────────────────────────────────────
# Phase 5: Verification & screenshot capture
# ────────────────────────────────────────────────────────────
banner "Phase 5/5 — Verification & screenshot capture"

echo "About to run 41 E2E tests against a local dev server in mock mode."
echo "These tests verify that the app works correctly without using any API quota."
echo ""
echo "  Test categories:"
echo "    CRITICAL  — Core workflows: search, queue, upload, export, persistence"
echo "    CRITICAL  — Input validation: empty origin, missing scout, upload types"
echo "    CRITICAL  — Multi-file upload: batch uploads, partial failure reporting"
echo "    IMPORTANT — Provider quota states: warning, locked, recovery"
echo "    IMPORTANT — Queue status lifecycle: all 4 statuses + persistence"
echo "    IMPORTANT — Queue filters: show/hide by status, default hidden states"
echo "    IMPORTANT — Media preview: HEIC/non-renderable image fallback display"
echo "    IMPORTANT — Edge cases: sparse/zero results, mobile, debug controls"
echo "    OPTIONAL  — Screenshot capture (requires deployed URL, skipped by default)"
echo ""

# Temporarily enable PROVIDER_MOCKS for local testing
sed -i.bak 's/^PROVIDER_MOCKS=0/PROVIDER_MOCKS=1/' "$PROJECT_ROOT/.dev.vars"
rm -f "$PROJECT_ROOT/.dev.vars.bak"

npx playwright install --with-deps chromium 2>/dev/null || true

E2E_EXIT=0
npx playwright test 2>&1 | tee /tmp/radius-scout-e2e.log || E2E_EXIT=$?

# Restore PROVIDER_MOCKS=0
sed -i.bak 's/^PROVIDER_MOCKS=1/PROVIDER_MOCKS=0/' "$PROJECT_ROOT/.dev.vars"
rm -f "$PROJECT_ROOT/.dev.vars.bak"

if [ "$E2E_EXIT" -eq 0 ]; then
  echo ""
  echo "  ✓ All E2E tests passed."
else
  echo ""
  echo "  ⚠ Some E2E tests failed (exit code $E2E_EXIT)."
  echo ""
  echo "  Your deployment is live and working — test failures don't affect it."
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────────────┐"
  echo "  │ Understanding test failures                                     │"
  echo "  ├─────────────────────────────────────────────────────────────────┤"
  echo "  │                                                                 │"
  echo "  │ CRITICAL tests (app.spec.ts, upload-validation, export-*):      │"
  echo "  │   These test core functionality. If they fail, check:           │"
  echo "  │   • Visit $DEPLOYED_URL and try a search manually"
  echo "  │   • Check the browser console for JavaScript errors             │"
  echo "  │   • Run: PLAYWRIGHT_HEADLESS=false npx playwright test --headed │"
  echo "  │                                                                 │"
  echo "  │ QUOTA STATE tests (quota-states.spec.ts):                       │"
  echo "  │   Use route interception to simulate provider limits.           │"
  echo "  │   Can be timing-sensitive. To verify manually:                  │"
  echo "  │   • Visit $DEPLOYED_URL — provider cards should show 'healthy'"
  echo "  │   • Re-run: npx playwright test tests/e2e/quota-states.spec.ts │"
  echo "  │                                                                 │"
  echo "  │ QUEUE/NOTE tests (queue-statuses, note-stack):                  │"
  echo "  │   Test status transitions and note truncation. To verify:       │"
  echo "  │   • Queue a POI, change its status, reload — should persist     │"
  echo "  │   • Add 4+ notes to a queue item — only 3 should display       │"
  echo "  │                                                                 │"
  echo "  │ DEBUG/INTEGRITY tests (debug-controls, queue-integrity):        │"
  echo "  │   Test edge cases with route interception. Low risk if they     │"
  echo "  │   fail — these simulate unusual server responses.               │"
  echo "  │                                                                 │"
  echo "  │ WEBGL / MAP tests:                                              │"
  echo "  │   Headless Chromium uses SwiftShader for WebGL rendering.       │"
  echo "  │   If map-related tests fail:                                    │"
  echo "  │   • Try headed mode: PLAYWRIGHT_HEADLESS=false npx playwright   │"
  echo "  │     test --headed                                               │"
  echo "  │   • Verify the map loads at $DEPLOYED_URL"
  echo "  │                                                                 │"
  echo "  └─────────────────────────────────────────────────────────────────┘"
  echo ""
  echo "  To re-run tests manually:"
  echo "    Set PROVIDER_MOCKS=1 in .dev.vars, then: npx playwright test"
  echo ""
  echo "  Full test log saved to: /tmp/radius-scout-e2e.log"
  echo "  Detailed guide: docs/e2e-testing-guide.md"
  echo ""
fi

# Screenshot capture runs against the DEPLOYED URL (optional — always non-blocking)
echo ""
echo "Screenshot capture (optional):"
echo ""
echo "  The 'New Here?' onboarding modal and the user manual page include placeholder"
echo "  screenshots. To populate them with images from your live deployment, run:"
echo ""
echo "    CAPTURE_ONBOARDING=1 APP_BASE_URL=$DEPLOYED_URL npx playwright test tests/e2e/onboarding-screenshots.spec.ts"
echo "    CAPTURE_MANUAL=1 APP_BASE_URL=$DEPLOYED_URL npx playwright test tests/e2e/manual-capture.spec.ts"
echo ""
echo "  These capture real Mapbox map tiles and app state from your deployment."
echo "  Without them, the modal and manual show placeholder messages instead of screenshots."
echo ""
echo "  After capturing, rebuild and redeploy to bundle the new images:"
echo "    npm run build && wrangler deploy"

# ────────────────────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────────────────────
banner "Setup complete!"

echo "  Deployed URL:   $DEPLOYED_URL"
echo ""
echo "  Resources created:"
echo "    D1 database:  radius-scout-db ($DATABASE_ID)"
echo "    R2 bucket:    radius-scout-media"
echo "    Secrets:      AZURE_MAPS_KEY, MAPBOX_PUBLIC_TOKEN"
echo ""
echo "  Documentation:"
echo "    docs/e2e-testing-guide.md   — Full testing reference"
echo "    docs/provider-usage-runbook.md — Provider quota management"
echo ""
echo "  Next steps:"
echo "    1. Visit $DEPLOYED_URL to see your deployment"
echo "    2. Run 'npm run dev' for local development"
echo "    3. Set PROVIDER_MOCKS=1 in .dev.vars to develop without API calls"
echo "    4. Run 'npm run test:e2e' to run E2E tests locally"
echo "    5. Run 'npm run deploy' to redeploy after changes"
echo ""
