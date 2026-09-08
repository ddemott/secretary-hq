#!/usr/bin/env bash
set -euo pipefail

# Bring up the canonical local Postgres and bootstrap `test_db` on it.
#
# One compose file, one container, one port: the `db` service in the repo-root
# docker-compose.yml (ankane/pgvector) as container `secretary-hq-db` on 5433.
# A second compose file publishing 5433 is a second database with a second
# volume, and a bootstrap run against the wrong one looks like it worked.
#
# WHY THE HOST CHECK EXISTS, and why an in-container check is not enough
# (measured 2026-09-08): `secretary-hq-db` sat "Up (healthy)" with
# NetworkSettings.Ports EMPTY — a container left in that state by having been
# started while another container held 5433. `docker compose up -d db` STARTS
# such a container rather than recreating it, so it inherits the broken state.
# `pg_isready` run through `docker compose exec` passed the whole time, because
# the server really was up — inside the container. Nothing on the host could
# reach it. The tests run on the host, so the host is where readiness has to be
# proven, and an unpublished port is a specific enough failure to recover from
# rather than just report.

PORT=5433
HOST_URL="postgres://postgres:postgres@localhost:${PORT}/postgres"

host_can_connect() {
  PGPASSWORD=postgres psql -h localhost -p "$PORT" -U postgres -d postgres \
    -tAq -c 'SELECT 1' > /dev/null 2>&1
}

wait_for_host() {
  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if host_can_connect; then return 0; fi
    sleep 1
  done
  return 1
}

echo "Starting the canonical db service (ankane/pgvector, container secretary-hq-db, port ${PORT})..."
docker compose up -d db

if ! wait_for_host; then
  # Distinguish "still booting" from "not published". Compose reports the
  # port mapping only when the running container actually has one.
  published="$(docker port secretary-hq-db "5432/tcp" 2>/dev/null || true)"
  if [[ -z "$published" ]]; then
    echo "Container is running but ${PORT} is not published — recreating it."
    echo "(Usually means it was last started while something else held ${PORT}.)"
    docker compose up -d --force-recreate db
    if ! wait_for_host; then
      echo "Still cannot reach Postgres on localhost:${PORT} after recreating." >&2
      echo "Check for another process on the port:  ss -ltnp | grep ${PORT}" >&2
      echo "Check the container:                    docker compose logs db" >&2
      exit 1
    fi
  else
    echo "Postgres is published on ${published} but did not answer within 60s." >&2
    echo "Check the container: docker compose logs db" >&2
    exit 1
  fi
fi

echo "Reached Postgres on localhost:${PORT} from the host."

echo "Running the test DB bootstrap (test_db + migrations + app_user role)..."
DATABASE_URL="$HOST_URL" npx tsx scripts/setup-test-db.ts

echo
echo "test_db is ready."
echo "  Use:            DATABASE_URL=postgres://postgres:postgres@localhost:${PORT}/test_db"
echo "  Enforce in CI:  REQUIRE_DB_TESTS=1 npm test"
echo "  Stop:           docker compose stop db"
echo "  Reset volume:   docker compose down -v   (destroys the data)"
