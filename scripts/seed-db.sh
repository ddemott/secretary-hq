#!/usr/bin/env bash
set -euo pipefail

# seed-db.sh: Insert demo/test data into a SecretaryHQ database.
# Usage: ./scripts/seed-db.sh [DATABASE_URL]
#
# Prerequisite: run setup-db.sh first to create tables.
# Safe to re-run — all inserts use ON CONFLICT DO NOTHING / DO UPDATE.

DB_URL="${1:-${DATABASE_URL:-postgres://postgres:postgres@localhost:5433/postgres}}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
SEED_FILE="$ROOT_DIR/supabase/seed.sql"

# Redact the userinfo (user:password) before logging — DB_URL may be a real
# credentialed URL passed as $1 or inherited from DATABASE_URL.
echo "[secretaryhq] Seeding database: $(printf '%s' "$DB_URL" | sed -E 's#(://)[^@/]*@#\1***:***@#')"

if ! command -v psql >/dev/null 2>&1; then
  echo "Error: psql is not installed."
  exit 1
fi

if ! psql "$DB_URL" -c "SELECT 1" >/dev/null 2>&1; then
  echo "Error: Cannot connect to database. Check your DATABASE_URL."
  exit 1
fi

if [ ! -f "$SEED_FILE" ]; then
  echo "Error: Seed file not found at $SEED_FILE"
  exit 1
fi

echo "  Applying supabase/seed.sql..."
# Capture psql output so a real failure (e.g. schema drift breaking the
# seed) surfaces with the actual error. Previously this redirected to
# /dev/null and treated every failure as "data already exists" — which
# silently hid the seed.sql being out-of-date relative to the schema
# from 2026-05-12 through 2026-05-13. ON_ERROR_STOP=1 + the captured
# output means a future regression is immediately visible in CI.
SEED_OUTPUT=$(psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$SEED_FILE" 2>&1) || {
  echo "[secretaryhq] ERROR: seed application failed:"
  echo "$SEED_OUTPUT" | sed 's/^/    /'
  exit 1
}
echo "[secretaryhq] Seed data applied successfully."

echo "[secretaryhq] Done. Platform admin + Thinking Hammer LLC + Bella's Hair Studio demo seeded."
echo "  Login: admin@secretaryhq.com / p@ssw0rd (platform super-admin)"
echo "  Login: daledemott@gmail.com  / p@ssw0rd (Thinking Hammer LLC — Dale's real business)"
echo "  Login: bella@bellashair.com  / p@ssw0rd (Bella's Hair Studio — salon demo tenant)"
