#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-production-secrets.sh
#
# Validates that every secret required in production is present in the
# current environment.  Run this before triggering a production deploy to
# catch missing secrets before they can break live traffic.
#
# Exit codes:
#   0 — all required secrets are set
#   1 — one or more required secrets are missing (details printed to stderr)
# ---------------------------------------------------------------------------
set -euo pipefail

ERRORS=0

# Helper: require a secret by name, print a diagnostic if it is absent.
require_secret() {
  local name="$1"
  local hint="${2:-}"
  if [ -z "${!name:-}" ]; then
    echo "[MISSING] $name is not set. $hint" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "[OK]      $name"
  fi
}

# Helper: warn when an optional-but-recommended secret is absent.
recommend_secret() {
  local name="$1"
  local hint="${2:-}"
  if [ -z "${!name:-}" ]; then
    echo "[WARN]    $name is not set (optional). $hint" >&2
  else
    echo "[OK]      $name"
  fi
}

echo "=== Production secrets check ==="
echo ""

# ---- Core infrastructure --------------------------------------------------

require_secret DATABASE_URL \
  "All database queries will fail without a connection string."

require_secret SESSION_SECRET \
  "Session cookies cannot be signed; every authenticated request will fail."

# ---- Clerk authentication -------------------------------------------------

require_secret CLERK_SECRET_KEY \
  "Clerk server-side auth is completely broken without this key."

# ---- Stripe billing -------------------------------------------------------

# STRIPE_SECRET_KEY is optional in the Replit connector flow (the connector
# injects it), but STRIPE_WEBHOOK_SECRET must always be present when
# STRIPE_SECRET_KEY is set so that incoming webhook events are verified.
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  echo "[OK]      STRIPE_SECRET_KEY"
  require_secret STRIPE_WEBHOOK_SECRET \
    "Without this, all Stripe webhook events (purchases, renewals, cancellations) will be rejected."
else
  recommend_secret STRIPE_SECRET_KEY \
    "Stripe billing features are disabled without this."
fi

# ---- RevenueCat mobile billing --------------------------------------------

require_secret REVENUECAT_WEBHOOK_SECRET \
  "Without this, all RevenueCat webhook events (purchases, renewals, expirations) will be rejected, breaking all mobile entitlements."

# ---- Object storage -------------------------------------------------------

recommend_secret PRIVATE_OBJECT_DIR \
  "Private object storage paths will not resolve."

recommend_secret PUBLIC_OBJECT_SEARCH_PATHS \
  "Public object storage paths will not resolve."

# ---- Optional integrations ------------------------------------------------

recommend_secret METERED_API_KEY \
  "Live-stream TURN relay will be unavailable; streams may fail on restricted networks."

recommend_secret METERED_DOMAIN \
  "Live-stream TURN relay will be unavailable."

recommend_secret YOUTUBE_TOKEN_ENCRYPTION_KEY \
  "YouTube upload integration will not work."

echo ""

if [ "$ERRORS" -gt 0 ]; then
  echo "=== FAILED: $ERRORS required secret(s) are missing. Set them and re-run before deploying. ===" >&2
  exit 1
else
  echo "=== PASSED: all required secrets are present. ==="
fi
