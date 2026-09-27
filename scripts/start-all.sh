#!/usr/bin/env bash
set -euo pipefail

# Kill any process using port 4001 (backend)
PORT=4001
PID=$(lsof -ti :$PORT || true)
if [ ! -z "$PID" ]; then
  echo "Killing process on port $PORT (PID: $PID)"
  kill -9 $PID
else
  echo "No process found on port $PORT"
fi

# Kill any process using port 4400 (dashboard)
PORT_DASH=4400
PID_DASH=$(lsof -ti :$PORT_DASH || true)
if [ ! -z "$PID_DASH" ]; then
  echo "Killing process on port $PORT_DASH (PID: $PID_DASH)"
  kill -9 $PID_DASH
else
  echo "No process found on port $PORT_DASH"
fi

# Delete lock files (ignore errors if not present)
rm -f .next/dev/lock dashboard/.next/dev/lock || true

# Start script for the complete SecretaryHQ SaaS stack
# Usage: ./scripts/start-all.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$ROOT_DIR"

echo "[secretaryhq] 🚀 Starting full stack..."

# 1. Ensure Docker DB is running
if command -v docker-compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1; then
  echo "[secretaryhq] 🐘 Ensuring Local Postgres is running..."
  docker compose up -d

  # Find the actual container name for Postgres
  POSTGRES_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep secretary-hq-db | head -n 1)
  if [ -z "$POSTGRES_CONTAINER" ]; then
    echo "[secretaryhq] ❌ Could not find Postgres container."
    exit 1
  fi

  echo "[secretaryhq] ⏳ Waiting for Postgres to be healthy..."
  until [ "$(docker inspect -f '{{.State.Health.Status}}' $POSTGRES_CONTAINER)" == "healthy" ]; do
    sleep 1
  done
  echo "[secretaryhq] ✅ Postgres is ready."
else
  echo "[secretaryhq] ⚠️ Warning: Docker Compose not found. Assuming DB is running elsewhere."
fi

# 2. Build the backend so `node dist/src/index.js` runs current source.
# Without this step, `dist/` may be stale relative to `src/` (the build
# script is invoked separately, not as part of `npm start`), and the
# running backend silently serves code that's out of sync with the
# branch the developer is editing. Surfaced 2026-05-12 when /register
# returned 500 with "column id does not exist" — dist/ had pre-PK-rename
# code while src/ was post-rename. Tracked under docs/TODO.md follow-ups.
echo "[secretaryhq] 🔨 Building backend (npm run build)..."
if ! npm run build; then
  echo "[secretaryhq] ❌ Backend build failed — aborting start. Fix the TS errors above before running npm start." >&2
  exit 1
fi

# Same staleness problem applies to the dashboard. The dashboard server
# runs from `dashboard/.next/standalone`, which is produced by
# `cd dashboard && npm run build`. Without rebuilding, the bundled JS
# can be out of sync with `dashboard/components/` — exact same shape as
# the backend dist/ regression. Surfaced 2026-05-13 when TenantCard.tsx
# crashed with "Cannot read properties of undefined (reading 'slice')"
# because the May 8 build had `tenant.id` baked in while the May 12
# rename had switched the source to `tenant.tenant_id`.
echo "[secretaryhq] 🔨 Building dashboard (cd dashboard && npm run build)..."
if ! (cd dashboard && npm run build); then
  echo "[secretaryhq] ❌ Dashboard build failed — aborting start. Fix the TS/build errors above before running npm start." >&2
  exit 1
fi

# 3. Start services concurrently
setsid node dist/src/index.js > backend.log 2>&1 &
echo "Backend server started on port 4001 (dist/src/index.js)"
(cd dashboard && NODE_ENV=production setsid node server.js > ../dashboard.log 2>&1 &)
echo "Dashboard server started on port 4400 (production mode)"

# Show status
sleep 5
echo "--- Server Status ---"
lsof -i :4001
lsof -i :4400
