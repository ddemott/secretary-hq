# DEVELOPMENT_WORKFLOW.md

## Local Development Setup

1. Start services: `npm run start` or `docker compose up -d db` for DB only.
   - **One compose file, one container, one port.** The canonical `db` service is
     `ankane/pgvector` as container `secretary-hq-db` on **5433**. Anything else
     bound to 5433 (another project's compose, a hand-run `docker run`) is a
     different database with a different volume, and a bootstrap run against it
     looks like it worked. Check with `docker ps` before migrating.
   - `npm run test-db:start` (`./scripts/start-test-db.sh`) does steps 1 and 2 together: brings the
     canonical service up, waits on its healthcheck rather than sleeping, proves
     `SELECT 1`, then runs the bootstrap below.
2. Bootstrap test database: `npx tsx scripts/setup-test-db.ts`
   - Creates `test_db` if missing.
   - Runs every migration in `supabase/migrations/`, lexically, **as superuser** (was pinned to a hardcoded cutoff migration until 2026-09-12 — the cutoff fell 4 migrations behind disk and `test_db` silently ran an outdated schema, failing 72 unrelated tests with stale function/behavior errors; see `docs/workflow/LESSONS_LEARNED.md`).
   - Creates `app_user` role with `NOBYPASSRLS`.
   - Applies grants and verifies posture.
   - Guards against prod DBs (refuses non-local hosts or prod-named DBs).
3. Run migrations/seed if needed: `npm run db:rebuild` (full reset) or `npm run db:migrate && npm run db:seed`.
4. Run tests: `npm test` (uses `tests/utils.ts` patterns; `REQUIRE_DB_TESTS=1` for CI enforcement).
   - `tests/regression/rlsIsolation.test.ts` now passes (no more "Cannot reach the database as app_user" error).
   - Other tests use `ROOT_DB_URL`, `skipIfDbDown()`, `setupBasicTenant()`, transaction savepoints.

## Local Voice Calls (talking to the agent on this machine)

Run the worker with `cd agent && npm run dev:local` — NOT `npm run dev`. The local script sets four things, each of which was a real defect on 2026-08-15:

- `AGENT_NAME=secretary-hq-agent-dev` — the default name is the SAME name the Railway worker registers under, and LiveKit load-balances a dispatch across every worker sharing it. Without this you are in a coin flip with production and cannot tell which binary answered.
- `NODE_EXTRA_CA_CERTS=../certs/localhost-cert.pem` — the backend serves HTTPS with a self-signed cert, so the agent's `fetch` to `BACKEND_URL` fails TLS. Symptom: `voice_session_start_failed: fetch failed` and a tenant config that silently degrades to the name "this business". Trust the cert; do not disable verification.
- `NUM_IDLE_PROCESSES=1` — the LiveKit SDK keeps `min(cpus,4)` idle job processes in production and **0** in dev mode, so locally the caller pays process spawn + VAD load + every cold connection. One idle process moves that off the call.
- `DNS_FORCE_IPV4=true` — see below.

Then dispatch a call: `./scripts/simulate.sh call --tenant <id>` (browser + mic), or `npx playwright test e2e/caller-pickup.spec.ts` from `dashboard/` for the automated "does the agent make noise" check. **`simulate.sh call` does not pass `AGENT_NAME`**, so prefix it — `AGENT_NAME=secretary-hq-agent-dev ./scripts/simulate.sh call …` — or the dispatch goes to the Railway worker.

**After any DB rebuild (every Playwright run does one), restore the two things a call needs:**

```bash
npm run local:business   # services + employee + shifts → the tenant is bookable
npm run trees:local      # seed templates + convert/refresh uncustomized local tenant copies
```

Without `local:business` the agent reaches the booking step, gets no service back from the resolver, and says "I'm not able to pull up our booking options right now" — a **success-shaped** dead end (HTTP 200, `success:true`) that nothing counts as an error, so the call slides into message-taking and looks like a model decision rather than missing data.

Check the pause the caller actually hears in the worker log: `greeting_spoken … ms_since_participant`. Under a second is healthy; seconds means something on the first-connection path is slow.

### The WSL DNS trap (why `DNS_FORCE_IPV4` exists)

On this host `dns.lookup('api.deepgram.com')` takes **11 seconds**: getaddrinfo waits for A _and_ AAAA, and the WSL resolver (`nameserver 10.255.255.254`, the Windows side) takes 11 s to answer AAAA. `dig AAAA … @1.1.1.1` answers the same query in 46 ms. Every first outbound connection in a job process paid it, so a fully cached greeting still reached the caller ~12 s after pickup.

`DNS_FORCE_IPV4=true` points the http/https global agents at an A-only lookup (default OFF; production resolves both families in milliseconds and must keep choosing for itself). **The real fix is the resolver**, and it needs root:

```bash
# /etc/wsl.conf
[network]
generateResolvConf = false
# then, as root, replace /etc/resolv.conf:
#   nameserver 1.1.1.1
#   nameserver 8.8.8.8
# and restart WSL from Windows: wsl --shutdown
```

## RLS / Role Testing

- Always run `setup-test-db.ts` before the RLS suite or full test run.
- The test uses `appUser` pool derived from `TEST_APP_USER_DATABASE_URL` (defaults via `ROOT_DB_URL` to `app_user` on `test_db`).
- `rlsTest()` wrapper throws with clear message if `available=false`.
- Verification in bootstrap matches the `DO $verify$` block in the role migration.

## DB Scripts Overview (match project style)

- `scripts/start-test-db.sh`: Brings the canonical compose `db` service up, waits on its healthcheck, proves a connection, then runs `setup-test-db.ts`. The one entry point — there is deliberately no second compose file or per-package copy.
- `scripts/setup-test-db.ts`: Targeted test bootstrap (this file; uses pg Client + schema_migrations tracking like `setup-db.sh`).
- `scripts/setup-db.sh`: General migration applicator.
- `scripts/rebuild-db.sh`: DROP + full rebuild + seed (re-applies role migration post-baseline).
- `tests/utils.ts`: Test helpers (`getRootClient()`, `clearDB()`, `skipIfDbDown()`, `setupBasicTenant()`, transaction isolation). Extended indirectly via consistent URL usage.

## Guarding Prod

All DB scripts check host (`localhost`, `127.0.0.1`, etc.) and DB name. `setup-test-db.ts` refuses prod-like URLs explicitly. Matches `rebuild-db.sh` safety pattern and `src/database/index.ts` local vs managed detection.

## CI / Pre-PR

`npm run pre-pr` includes tests. `test:ci` sets `DATABASE_URL` to test_db. Bootstrap ensures RLS tests run reliably.

Run `npx tsx scripts/setup-test-db.ts` after schema changes affecting RLS or roles.

**Verified:** Script completes without error. `npm run test -- tests/regression/rlsIsolation.test.ts` now succeeds (role posture assertions pass).

See `HANDOFF.md`, `CODING_STANDARDS.md`, `supabase/migrations/20260724000100_app_user_role.sql` for context.
