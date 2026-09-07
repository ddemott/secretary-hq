# SecretaryHQ SaaS - Production Deployment Guide

This guide walks through migrating from the local Docker development environment to a production Supabase project with live telephony.

---

## Prerequisites

- **Supabase Account**: [supabase.com](https://supabase.com) (free tier works for initial testing)
- **Telnyx Account**: [telnyx.com](https://telnyx.com) — carrier, SIP trunk, SMS OTP
- **LiveKit Cloud Account**: [livekit.io](https://livekit.io) — voice agent orchestrator + SIP ingress
- **Deepgram Account**: [deepgram.com](https://deepgram.com) — STT (Nova-3) used by the LiveKit agent
- **OpenAI API Key**: LLM (GPT-4.1-mini voice; 4o-mini summaries/classify), RAG embeddings, post-call summaries. **TTS is Deepgram, not OpenAI** — see `DEEPGRAM_API_KEY`
- **Railway Account**: For hosting the full stack (backend + secretary-hq-agent worker + this Next.js dashboard) in production. Self-hosting or other platforms (e.g. Vercel for dashboard only) remain options for the Next.js part.
- **Supabase CLI**: already in devDependencies — invoke via `npx supabase` (no global install needed). Migrations are applied via `npm run db:migrate` / `scripts/setup-db.sh`, not a direct CLI link.

---

## Phase 1: Supabase Project Setup

### 1.1 Create the Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and click **New Project**.
2. Choose a name (e.g., `secretary-hq-prod`), set a strong database password, and select a region close to your users.
3. Wait for the project to provision (~2 minutes).

### 1.2 Note Your Credentials

From **Project Settings** > **API**, save these values:

- **Project URL**: `https://<PROJECT_ID>.supabase.co`
- **Project ID**: The `<PROJECT_ID>` portion
- **anon key**: Public API key (not needed for this app, but good to have)
- **service_role key**: Server-side key with full access

From **Project Settings** > **Database**:

- **Connection string**: `postgres://postgres:[YOUR-PASSWORD]@db.<PROJECT_ID>.supabase.co:5432/postgres`
- **Connection pooler string** (Transaction mode): For high-concurrency use

### 1.3 Enable Required Extensions

In the Supabase SQL Editor, run:

```sql
CREATE EXTENSION IF NOT EXISTS pgvector;
```

- `pgvector`: Required for RAG knowledge base embeddings

(`pg_net` is no longer required — the old `notify_n8n_on_appointment` trigger is dead code. All async work runs inline in Fastify route handlers.)

---

## Phase 2: Database Migration

### 2.1 Run Pre-flight Check

Before applying migrations, validate that your cloud database meets all prerequisites:

```bash
./scripts/preflight-cloud.sh "postgres://postgres:[YOUR-PASSWORD]@db.<PROJECT_ID>.supabase.co:5432/postgres"
```

This checks: connectivity, extensions (pgvector, pg_net), role creation, database state, PostgreSQL version, and migration file count. Fix any FAIL items before proceeding.

### 2.2 Apply Migrations

Use the existing `setup-db.sh` script, passing the production connection string:

```bash
./scripts/setup-db.sh "postgres://postgres:[YOUR-PASSWORD]@db.<PROJECT_ID>.supabase.co:5432/postgres"
```

This applies all 192 migrations in order and seeds the database with the Bella's Hair Studio demo tenant.

### 2.3 RLS Enforcement

**Updated 2026-08-14 — the previous text here was wrong in a way worth naming.** It said the backend connects as `postgres` and that `FORCE ROW LEVEL SECURITY` "enforces tenant isolation even under superuser." It does not: FORCE RLS makes the policies apply to the table **owner**, but a superuser or any `BYPASSRLS` role still walks straight past them. Under that setup, isolation rested entirely on `tenantMiddleware`, and the RLS layer was decoration.

Since 2026-07-27 production connects as **`app_user`** (`rolsuper=f`, `rolbypassrls=f`, created by `20260724000100_app_user_role.sql`), so the 38 RLS-enabled tables are a genuine second layer. `withTenantClient()` sets `app.current_tenant_id` per request; policies read it through `tenant_ctx()` / `tenant_ctx_uuid()` (`20260724000000_rls_null_safe_context.sql`) rather than casting the raw GUC, because a cold pool connection has it NULL and `clearTenantContext()` sets it to the empty string — the two shapes that previously produced silent empty results and per-request 500s.

Verify from the running process, not from assumption: `GET /ready` reports `rls_enforced` + `db_role`. Do **not** "verify" by `SET ROLE app_user` from a `postgres` session — that is refused, the probe silently keeps executing as `postgres`, and its cross-tenant rows prove nothing. `tests/regression/rlsIsolation.test.ts` is the real probe and runs in CI. Reverting is one env var: keep the old superuser `DATABASE_URL` to hand.

Migration bookkeeping caveat: `schema_migrations` is deliberately RLS-exempt (`20260802000000_schema_migrations_no_rls.sql`). It has no tenant dimension, and with RLS on it an `app_user` migration run reads an **empty** table and tries to re-apply every migration.

### 2.4 Verify the Schema

Spot-check that critical objects exist:

```sql
-- Tables
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

-- Key functions
SELECT proname FROM pg_proc WHERE proname IN (
  'book_appointment_atomic', 'book_with_scheduling_atomic',
  'check_availability_with_tz', 'get_effective_shifts',
  'get_effective_shifts_bulk', 'link_orphaned_transcripts',
  'set_tenant_context'
);

-- RLS is enabled
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = true;
```

---

## Phase 3: Deploy the Backend API

The Fastify backend serves the dashboard and management API. Deploy options:

### Option A: Railway (Current Setup)

Railway is configured via `railway.json` + `nixpacks.toml` in the repo root.

1. **Build**: Nixpacks is pinned to Node.js 22 (`nixpacks.toml`), runs `npm install --include=dev && npm run build`
2. **Start**: `node dist/src/index.js`
3. **Health check**: `/health` endpoint
4. **Restart policy**: `ON_FAILURE` with max 10 retries

**Database compatibility**: The backend uses a single DB pool via `DATABASE_URL`. All 38 RLS-enabled tables have `FORCE ROW LEVEL SECURITY`. Since 2026-07-27 production connects as `app_user` (`rolbypassrls=f`), so the policies are a real second layer rather than decoration — `GET /ready` reports `rls_enforced` + `db_role` from the running process's own connection. Apply all 192 migrations (including `20260323000000_force_rls_single_pool.sql`, `20260427000000_telnyx_provisioning.sql`, `20260430000002_drop_employee_shifts.sql`, the 2026-05-01 atomic-booking exclusion-constraint pair `20260501000000` + `20260501000001`, the 2026-05-05 user-role column `20260505000000_user_roles.sql`, the 2026-08-11 generic intake envelope migration `20260811160000_intake_submissions.sql`, and the 2026-08-14 tenant-question-tree pair `20260814120000_checklist_preset_id_catalog_sync.sql` + `20260814130000_question_trees_per_tenant.sql`) to Supabase before deploying. The two atomic-booking migrations require a pre-flight scan for any existing overlapping `appointments` rows on the same `(resource_id, time-range)` or `(employee_id, time-range)` — the `ALTER TABLE ... ADD CONSTRAINT EXCLUDE` will fail if any are present. The user-role migration is harmless additive (DEFAULT `'owner'`, no NULL backfill).

**Graceful shutdown**: The backend handles `SIGTERM`/`SIGINT` (Railway sends these during deploys) — closes Fastify and drains the DB pool.

### Option B: Render / Fly.io

These platforms also support Node.js apps with similar config. Use the same env vars and start command.

### Option C: Run on a VPS

```bash
npm install
npm run build
NODE_ENV=production DATABASE_URL=... JWT_SECRET=... node dist/src/index.js
```

**Important**: In production (`NODE_ENV=production`), the backend skips HTTPS/TLS (the platform handles TLS termination). The `x-forwarded-proto` hook redirects HTTP to HTTPS when behind a proxy.

### Environment Variables — Canonical Reference

This is the single source of truth for environment variables across all three deployable services. Verified against code 2026-05-05 — env-var contract unchanged since 2026-04-30 audit (no new services or required vars added in the 2026-05-04 / 2026-05-05 cleanup sessions).

#### Backend (Fastify) — required at boot

The backend exits on startup if any of these are missing in production (see `src/services/envWarnings.ts`).

| Variable            | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`      | Supabase Postgres connection string (use session-mode pooler)     |
| `JWT_SECRET`        | Secret for signing JWT tokens (change from default!)              |
| `OPENAI_API_KEY`    | LLM (post-call summaries, normalization) + RAG embeddings         |
| `STRIPE_SECRET_KEY` | Stripe API key (test or live)                                     |
| `NODE_ENV`          | Set to `production` (skips local TLS, trusts `x-forwarded-proto`) |

#### Backend — required for full functionality

The backend boots without these but specific features fail or warn loudly.

| Variable                   | Required for                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_SECRET`             | Voice AI tools                    | Shared secret the LiveKit agent presents on every `/agent-tools/*` call. Must match the agent's `AGENT_SECRET`. Min 32 chars.                                                                                                                                                                                                                                                                                                                                                                                              |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Browser call-simulator (`POST /call-simulator/start`) | Same three values as the agent service (see below) — the BACKEND also needs its own copy, because `src/services/browserCallerSession.ts` runs `agent/scripts/sim-call.mjs` as a child process **of the backend**, not the agent worker. Missing on the backend service until 2026-08-19: `/call-simulator/start` returned a generic 500 with no LiveKit vars to work with, and nothing had ever verified the endpoint against a real deployed backend (the unit test injects a fake runner; the Playwright e2e spec runs against a locally-spawned backend that already has them via the repo `.env`). |
| `TELNYX_API_KEY`           | Phone provisioning + SMS OTP      | Carrier API key. Boot warns if missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TELNYX_SIP_CONNECTION_ID` | Phone provisioning                | SIP Connection ID purchased numbers are routed to (e.g. `2945038451784812111`).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TELNYX_PUBLIC_KEY`        | Inbound SMS (STOP/START) webhook  | Telnyx's **Ed25519 public key** — see "Retrieving `TELNYX_PUBLIC_KEY`" below (the portal no longer shows it; fetch it from the API). NOT a secret we generate; there is nothing to create. `POST /communications/telnyx/inbound` **fails closed with 503 until this is set** (it mutates consent state, so it never runs unverified); `/communications/telnyx/status` accepts unverified receipts without it and logs. Replaced `TELNYX_WEBHOOK_SECRET` on 2026-07-12 — that variable is dead and setting it does nothing. |
| `STRIPE_WEBHOOK_SECRET`    | Stripe webhook                    | Signing secret for `POST /billing/webhook` once the Stripe dashboard endpoint is actually registered. The route exists; the endpoint is still unregistered today.                                                                                                                                                                                                                                                                                                                                                           |
| `STRIPE_SOLO_PRICE_ID`     | Billing checkout                  | Stripe price ID for the current Solo label in code. **Do not treat old $129/mo docs as final pricing** — pricing is still being decided.                                                                                                                                                                                                                                                                                                                                                                                   |
| `STRIPE_GROWTH_PRICE_ID`   | Billing checkout                  | Stripe price ID for the current Growth label in code. **Do not treat old $279/mo docs as final pricing** — pricing is still being decided.                                                                                                                                                                                                                                                                                                                                                                                 |
| `STRIPE_PRO_PRICE_ID`      | Billing checkout                  | Stripe price ID for the Professional / backlog tier label in code. Not a launched public price.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DASHBOARD_URL`            | Stripe checkout + OAuth redirects | Public URL of the dashboard. Default `https://localhost:4000`. **Phase 13 blocker if not set in prod.**                                                                                                                                                                                                                                                                                                                                                                                                                    |

#### Retrieving `TELNYX_PUBLIC_KEY`

**Don't hunt for this in the portal.** Telnyx's docs say it lives under Mission Control →
Keys & Credentials → Public Key, but the redesigned portal (as of 2026-07-12) does not
surface that page anywhere — there is no such tab, and Search doesn't find it. Fetch it
from the API instead, using the `TELNYX_API_KEY` you already have:

```bash
curl -s -H "Authorization: Bearer $TELNYX_API_KEY" https://api.telnyx.com/v2/public_key
# → {"data":{"public":"9xjFf…arp8=","record_type":"public_key","organization_id":"…"}}
```

The `data.public` value IS `TELNYX_PUBLIC_KEY`. Paste it verbatim into the **`secretary-hq`**
(backend) service's Railway variables. Bare base64, ~44 chars ending in `=` — that's
32 raw Ed25519 key bytes; the loader also accepts a PEM-armored form.

**Nothing is generated, uploaded, or rotated by us.** Telnyx generated the keypair, keeps
the private half forever, and signs every webhook with it. The public half only _verifies_
those signatures — it cannot produce one, so it is not a secret. Publishing it is harmless.
This is the whole reason the variable is not called a "secret", and the reason a
symmetric-secret mental model (Stripe's) sends you looking for a "create key" button that
does not and should not exist.

Three Telnyx credentials, easily confused — they are not interchangeable:

| Variable                   | Kind                         | Direction       |
| -------------------------- | ---------------------------- | --------------- |
| `TELNYX_API_KEY`           | **secret** (`KEY0…`)         | we call Telnyx  |
| `TELNYX_PUBLIC_KEY`        | **public** key, not a secret | Telnyx calls us |
| `TELNYX_SIP_CONNECTION_ID` | identifier, not a credential | voice routing   |

Setting the key is only half of enabling inbound SMS: the Telnyx number's messaging
profile must also point its **inbound webhook URL** at
`https://secretary-hq-production.up.railway.app/communications/telnyx/inbound`, or Telnyx never
sends us anything to verify.

Verify it took, once Railway has redeployed:

```bash
curl -i -X POST https://secretary-hq-production.up.railway.app/communications/telnyx/inbound \
  -H 'content-type: application/json' -d '{}'
```

- **503 `Webhook not configured`** → the key is not set (or the deploy hasn't finished).
- **403 `Invalid Telnyx signature`** → **correct.** The key is loaded and verifying; an
  unsigned request is supposed to be rejected.

Then the real end-to-end check, which no test in the repo can cover (our tests sign with a
keypair we generate, not Telnyx's): text **STOP** to the live number and confirm a row
lands in `opt_out_records`.

#### Backend — optional / tuning

| Variable                                                          | Default                       | Description                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_EXPIRY`                                                      | `8h`                          | Token expiry duration                                                                                                                                                                                                                                                                                                                                 |
| `PORT`                                                            | `4001`                        | Server port                                                                                                                                                                                                                                                                                                                                           |
| `CORS_ORIGIN`                                                     | (none)                        | Permitted CORS origin for cross-domain dashboard requests                                                                                                                                                                                                                                                                                             |
| `STRIPE_ENTERPRISE_PRICE_ID`                                      | (none)                        | Stripe price ID for Enterprise plan (not yet shipped)                                                                                                                                                                                                                                                                                                 |
| `ENABLE_REMINDER_SCHEDULER`                                       | `false` outside prod          | Forces the appointment-reminder background worker on in dev                                                                                                                                                                                                                                                                                           |
| `TELEPHONY_PROVIDER`                                              | `telnyx`                      | (Optional) Override default SMS provider (Telnyx is the only supported provider; legacy support removed)                                                                                                                                                                                                                                              |
| `TELEPHONY_SIMULATION_MODE`                                       | `false`                       | If `true`, voice/SMS providers no-op (test/dev)                                                                                                                                                                                                                                                                                                       |
| `SMS_SIMULATION_MODE`                                             | `false`                       | If `true`, SMS service no-ops (test/dev)                                                                                                                                                                                                                                                                                                              |
| `EMAIL_USER`, `EMAIL_PASS`                                        | (none)                        | nodemailer SMTP creds for transactional email. **In production, missing creds now make every send FAIL LOUDLY** (throw → caller's catch → `errors_total`); off-production they fall back to a resolving stub so dev/CI need no mail account. Before 2026-07-27 the stub also applied in prod, i.e. every send reported success while no mail existed. |
| `SMTP_HOST`, `SMTP_PORT`                                          | `smtp.gmail.com` / `465`      | Transport target. Replaces the old `service: 'gmail'` shorthand so a provider swap needs no code change. Sends prefer IPv4 (`family: 4`) — Railway→Gmail over IPv6 died with `ENETUNREACH` after 60–120s (2026-07-17).                                                                                                                                |
| `EMAIL_SEND_DEADLINE_MS`                                          | `20000`                       | Hard ceiling on any single system-email send. A send that outlives it REJECTS, so a hung SMTP socket becomes a catchable, metered failure instead of an unbounded await. Origin: `/forgot-password` hung in prod 2026-07-27 (HTTP 000 at 30s, nothing logged — a hang is not an error).                                                               |
| `PLATFORM_ADMIN_EMAIL`                                            | falls back to `EMAIL_USER`    | Recipient for platform-internal notifications with no per-tenant owner (currently: `POST /provisioning/port-inquiry`'s "owner wants to port their number" email). Not tenant-facing.                                                                                                                                                                  |
| `TELNYX_*` (API_KEY, SIP_CONNECTION_ID, PHONE_NUMBER, PUBLIC_KEY) | (required for prod)           | Telnyx for numbers, SIP, SMS, OTP. `PUBLIC_KEY` gates the inbound-SMS webhook — see the table above. (`TELNYX_WEBHOOK_SECRET` is dead as of 2026-07-12; nothing reads it.)                                                                                                                                                                            |
| `BETTER_STACK_TOKEN`                                              | (none)                        | Source token for Better Stack (Logtail) log aggregation. When set, backend + agent forward Pino logs in addition to writing to stdout. Unset = stdout only (local dev / no aggregation). See "Observability" below.                                                                                                                                   |
| `LOG_LEVEL`                                                       | `info` (prod) / `debug` (dev) | Pino log level (`trace` `debug` `info` `warn` `error` `fatal`). Env knob for dialing back verbosity if free-tier ingest is approached without redeploy.                                                                                                                                                                                               |
| `SENTRY_DSN`                                                      | (none)                        | DSN for Sentry error monitoring. When set, backend + agent send unhandled exceptions and `logError` calls to Sentry for grouping + alert-on-spike. Unset = no Sentry calls (local dev / tests). See "Observability" below.                                                                                                                            |
| `SENTRY_ENVIRONMENT`                                              | `$NODE_ENV`                   | Override the Sentry environment tag (`production` / `staging` / `development`). Defaults to `NODE_ENV` when unset.                                                                                                                                                                                                                                    |
| `SENTRY_RELEASE`                                                  | (none)                        | Optional release tag (e.g. git SHA) so Sentry can group events by build. Set to `$RAILWAY_GIT_COMMIT_SHA` on Railway.                                                                                                                                                                                                                                 |

#### Backend — Calendar OAuth (set per integration you use)

Each integration is independent — set the trio for the ones you wire up. All optional at boot. (The competitor-CRM integrations — Jobber, HubSpot, ServiceTitan, GoHighLevel — were removed from the codebase 2026-06-12; their env vars are no longer used. **Square sync remains live** — see its row below.)

| Provider          | Variables                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Calendar   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` (e.g. `https://your-backend/calendar/auth/google/callback`)                                                                                                                                                                                        |
| Outlook Calendar  | `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_CALLBACK_URL`                                                                                                                                                                                                                                                 |
| Square (CRM sync) | `SQUARE_CLIENT_ID`, `SQUARE_CLIENT_SECRET`, `SQUARE_CALLBACK_URL` (OAuth) + `SQUARE_WEBHOOK_SIGNATURE_KEY` (HMAC-SHA256 verification for the `/square/webhook` receiver). Square is the one surviving external CRM sync provider — bidirectional push/pull via `src/services/crm/squareClient.ts` + `squareSync.ts`. |

#### Agent worker (`agent/`) — validated by Zod at startup

The agent boots with `dotenv` loading the repo-root `.env` and `agent/.env` in that order. Missing/invalid → process exits with the failed Zod issue. See `agent/src/config.ts` for the schema.

| Variable             | Required | Description                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LIVEKIT_URL`        | Yes      | LiveKit Cloud WSS URL (must start with `wss://`)                                                                                                                                                                                                                                                             |
| `LIVEKIT_API_KEY`    | Yes      | LiveKit Cloud API key                                                                                                                                                                                                                                                                                        |
| `LIVEKIT_API_SECRET` | Yes      | LiveKit Cloud API secret                                                                                                                                                                                                                                                                                     |
| `AGENT_SECRET`       | Yes      | Min 32 chars. Must match backend's `AGENT_SECRET`.                                                                                                                                                                                                                                                           |
| `OPENAI_API_KEY`     | Yes      | LLM (GPT-4.1-mini voice, 4o-mini auxiliary) + embeddings + summaries. NOT TTS since 2026-07-14                                                                                                                                                                                                                                    |
| `DEEPGRAM_API_KEY`   | Yes      | STT (Nova-3) **and TTS (Aura, `aura-asteria-en`)** — a bad key or param takes the line SILENT; run `cd agent && npm run verify:tts`                                                                                                                                                                                                                                                                                                 |
| `BACKEND_URL`        | No       | Where the agent posts `/agent-tools/*` calls. Default `http://localhost:4001`.                                                                                                                                                                                                                               |
| `BETTER_STACK_TOKEN` | No       | Same value as the backend's `BETTER_STACK_TOKEN`. When set, agent forwards Pino logs to Better Stack alongside stdout; unset = stdout only. Per-call child logger adds `tenant_id` + `call_id` to every line so support can pull a specific call's full timeline with one filter. See "Observability" below. |
| `LOG_LEVEL`          | No       | `trace` \| `debug` \| `info` (default) \| `warn` \| `error`                                                                                                                                                                                                                                                  |
| `SENTRY_DSN`         | No       | Same DSN as the backend (one Sentry project hosts both services; the `service` tag separates them). When set, agent forwards unhandled exceptions + fallback-triggered events to Sentry. Unset = no Sentry calls. See "Observability" below.                                                                 |

#### Dashboard (Next.js)

| Variable                   | Required | Description                                                   |
| -------------------------- | -------- | ------------------------------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | Yes      | Backend public URL. Compiled into the bundle at build time.   |
| `NODE_ENV`                 | (auto)   | Next.js sets this; check for production-only code paths only. |

---

## Phase 4: Deploy the Dashboard

The dashboard is a Next.js app in the `dashboard/` directory. In production the full stack (including dashboard) is hosted on Railway (see Phase 3 for backend/agent and `railway.json` + `nixpacks.toml` at root; the dashboard service is `dashboard-production-cee3`).

### Option A: Railway (Current Production Path)

The dashboard is built and deployed as part of the Railway monorepo services alongside the backend and agent worker. Environment variables (e.g. `NEXT_PUBLIC_API_BASE_URL`) are configured in the Railway dashboard for the dashboard service. No separate Vercel project needed.

### Option B: Self-hosted / Alternative Platforms

```bash
cd dashboard
npm install
npm run build
npm start
```

Set `NEXT_PUBLIC_API_BASE_URL` to point to your deployed backend.

(Vercel remains a viable alternative for the Next.js dashboard portion only if you prefer it; update `NEXT_PUBLIC_API_BASE_URL` accordingly. Older "Recommended" guidance has been updated to reflect Railway as the integrated production deployment.)

---

## Phase 5: Telephony Setup (Telnyx + LiveKit Cloud)

The voice stack runs as: **Telnyx** (carrier + SIP trunk) → **LiveKit Cloud** (SIP ingress) → **LiveKit Agent worker** (Node, deployed on Railway as `secretary-hq-agent`). One LiveKit dispatch rule routes every tenant's number to the same agent worker; tenant identity flows in via SIP dispatch metadata. There are no per-tenant orchestrator entities — buying a Telnyx number and pointing it at the SIP Connection is the entire per-tenant config.

### 5.1 LiveKit Cloud: Project + dispatch rule (one-time)

1. Sign in to [cloud.livekit.io](https://cloud.livekit.io) and create a project (e.g., `AI-Secretary`).
2. From **Settings → Keys**, copy the WSS URL, API Key, and API Secret. Set them in Railway as `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
3. Create a SIP inbound trunk and a dispatch rule that routes inbound SIP traffic to agent name `secretary-hq-agent`. The agent worker self-registers with this name when it boots.
4. Note the SIP FQDN LiveKit gives you (looks like `<project-slug>.sip.livekit.cloud:5060`). You'll point Telnyx at it.

### 5.2 Telnyx: SIP Connection pointing at LiveKit (one-time)

1. Sign in to [portal.telnyx.com](https://portal.telnyx.com).
2. **Voice → SIP Connections → Create FQDN Connection** named `livekit-outbound`.
3. **Inbound** tab → set **Default Primary FQDN** to the LiveKit SIP FQDN from 5.1, port 5060, DNS A record. Sequential routing. Codecs G722/G711U/G711A. DTMF: RFC 2833.
4. **Outbound** tab → use credential authentication. Set a strong username/password (`openssl rand -base64 32`). Store in your secret manager.
5. **Inbound subdomain receive setting**: tighten to `Only my connections` (default `From Anyone` is a toll-fraud target).
6. Copy the numeric Connection ID. Set it in Railway as `TELNYX_SIP_CONNECTION_ID`.
7. Set Telnyx API key in Railway as `TELNYX_API_KEY` (same key handles SMS OTP).

### 5.3 Buying a number (per-tenant, automated)

Buying happens through the backend's `/provisioning/activate` endpoint, not the portal. The flow:

1. SuperAdmin clicks **Activate Phone** on a tenant in the dashboard (or `POST /provisioning/activate` directly).
2. Backend calls `Telnyx /v2/available_phone_numbers` to find a number (optionally filtered by area code).
3. Backend orders the number via `Telnyx /v2/number_orders`.
4. Backend `PATCH /v2/phone_numbers/{id}` to assign it to the SIP Connection from 5.2.
5. Backend writes `telnyx_phone_number_id`, `inbound_phone`, and `phone_status='active'` on the tenant.

After step 4, calls to the new number flow Telnyx → LiveKit → agent. No Telnyx-portal clicks per tenant.

### 5.4 Deploy the LiveKit agent worker

The agent worker lives in `agent/` and runs as a separate Railway service (`secretary-hq-agent`). It registers with LiveKit Cloud on boot using the `LIVEKIT_*` env vars and stays connected. Required env vars on the agent service:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — from 5.1
- `OPENAI_API_KEY` — LLM used by the agent (plus backend summaries/classify); TTS is Deepgram, not OpenAI
- `DEEPGRAM_API_KEY` — STT (Nova-3) + TTS (Aura)
- `BACKEND_URL` — base URL for the Fastify backend (e.g., `https://secretary-hq-production.up.railway.app`)
- `AGENT_SECRET` — shared secret the agent presents on every `/agent-tools/*` call (must match the same env var on the backend service)

---

## Phase 6: Async Work (No n8n Required)

**n8n has been removed from this project.** All async work runs inline in Fastify route handlers:

- **Post-call summarization** — `src/routes/voice.ts` handles the LiveKit agent's `call-ended` event, calls OpenAI for summary + sentiment, stores in `call_summaries`.
- **Calendar + CRM sync** — `src/services/syncOrchestrator.ts` fans appointment mutations out to the connected Google/Outlook calendars **and** to Square (the surviving external CRM sync). Each provider fails independently.
- **SMS / reminders** — `src/routes/communications.ts` + `src/routes/reminders.ts` (routes and Zod schemas exist; provider integration stubbed).

(The competitor-CRM integrations — Jobber/HubSpot/ServiceTitan/GoHighLevel — were removed from the codebase 2026-06-12. **Square sync remains live.**)

Google/Outlook OAuth creds and the Square webhook signature key are set in Railway. Stripe route code exists too, but the Stripe webhook endpoint is still unregistered and final billing price IDs are still pending per `docs/planning/TODO.md`. No separate workflow engine to deploy.

---

## Phase 7: Post-Deployment Verification

### 7.1 Dashboard Smoke Test

1. Open the dashboard URL
2. Log in with the seeded credentials (`admin@secretaryhq.com` / `password`)
3. Verify you can see appointments, customers, and resources
4. Try creating a test appointment through the UI

### 7.2 Agent-tools Smoke Test

Test a tool route directly against the deployed backend (the same path the LiveKit agent uses):

```bash
# Get customer context — same payload shape the agent's tool client uses
curl -X POST https://secretary-hq-production.up.railway.app/agent-tools/customer-context \
  -H "Content-Type: application/json" \
  -H "x-agent-secret: $AGENT_SECRET" \
  -d '{
    "tenant_id": "<TENANT_ID>",
    "caller_phone": "+15555550100"
  }'
```

A 200 with a JSON body confirms the route is up and the agent secret is correctly configured. A 401 means `AGENT_SECRET` doesn't match between agent and backend.

### 7.3 Live Call Test

1. Call the Telnyx phone number
2. The AI should greet you with the tenant's first message
3. Test the full flow: identify as customer, ask about availability, book an appointment
4. Verify the appointment appears in the dashboard

### 7.4 Knowledge Base Test

1. Upload a policy PDF via the dashboard's Knowledge Base tab
2. Call in and ask a policy question (e.g., "What's your cancellation policy?")
3. Verify the AI answers using the uploaded document content

---

> **Decision 2026-07-02:** the paid vendors below (Better Stack, Sentry) were **decided against** — NOT set on Railway, not a go-live step. Free prod observability stands: `GET /metrics` (Prometheus, `METRICS_TOKEN`-gated), Pino JSON logs on Railway live-tail, `GET /ready`. The setup steps below are retained as **optional/future** reference (the code integrations no-op until env vars are set); revisit only via a free path (e.g. Grafana Cloud over `/metrics`).

## Observability — Better Stack log aggregation

Backend and agent both ship Pino JSON logs to stdout (Railway captures them) and, when `BETTER_STACK_TOKEN` is set, also forward to Better Stack (Logtail's successor). Both services use the same source token; a `service` filter splits them in the UI.

### One-time setup (one source for both services)

1. Sign up at [betterstack.com/logs](https://betterstack.com/logs). Free tier is 1 GB / 3 days retention — sufficient for current secretary-hq scale.
2. Create a new source: type **JavaScript / Pino**.
3. Copy the source token.
4. Set `BETTER_STACK_TOKEN=<token>` on the backend Railway service (`secretary-hq-production`) AND on the agent Railway service (`secretary-hq-agent`). Same value on both.
5. Restart both services. New log lines start flowing within ~5 seconds.

If the token is unset, both services keep running with stdout-only logging — there's no fail-open / fail-closed surprise.

### Filterable fields baked into every line

| Field          | Source                                                                                                         | Use                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `service`      | `secretary-hq-backend` or `secretary-hq-agent`                                                                             | Split the two services in one source                                                                             |
| `env`          | `production` / `development` / `test`                                                                          | Drop dev noise from prod incident filters                                                                        |
| `tenant_id`    | Backend: `tenantMiddleware` enriches request logger. Agent: per-call child logger after `sessionCtx` resolves. | Pull all logs for one tenant                                                                                     |
| `call_id`      | Agent: from SIP participant attributes (`sip.callID`).                                                         | Pull one specific call's full timeline                                                                           |
| `caller_phone` | Agent: from SIP participant attributes. Null for anonymous callers.                                            | Cross-reference a customer's reported call without knowing the call_id                                           |
| `event`        | Both: explicit event name in `log.info({ event: '...' }, msg)` calls.                                          | Filter by lifecycle stage (`call_start`, `session_started`, `tenant_config_fetched`, `fallback_triggered`, etc.) |

### Common support queries

- "The call dropped at 2:14pm" → filter `service: secretary-hq-agent AND tenant_id: <id>`, find the call_id at the right timestamp, then re-filter `call_id: <id>` to see the full timeline (call_start → session_context_resolved → tenant_config_fetched → session_started → any tool calls → fallback_triggered if applicable).
- "Why did the AI not book this customer?" → filter `service: secretary-hq-backend AND tenant_id: <id> AND event: booking_*` for the relevant minute. The booking RPC error code (`TIMESLOT_OCCUPIED` / `NO_SKILLED_EMPLOYEE` / `EMPLOYEE_NOT_SCHEDULED` / `NO_AVAILABILITY` / `INVALID_PARAMS`) is logged at the route handler.
- "Did fallback trigger today?" → filter `service: secretary-hq-agent AND event: fallback_triggered`. Returns the dispatch-metadata-invalid and session-context-lost cases (other fallback paths inside `runFallback` itself are not yet logged — separate follow-up).

### Cost knobs

- `LOG_LEVEL=warn` on both services drops info-level lifecycle noise; pair with a Better Stack alert on `level: error OR level: warn` to keep paging signal intact.
- The transport is a Pino worker thread — when Better Stack is unreachable or the token is invalid, log lines silently drop rather than blocking the main thread. The backend / agent never crash because of a logging issue.

### What's NOT yet wired

This is the first observability slice; metrics, error monitoring, and expanded live QA are tracked separately in `docs/planning/TODO.md`. Specifically out of scope for this slice:

- Dashboard logs (Next.js). Backend + agent are the priority because they handle the call path; dashboard logs are nice-to-have for support.
- Metrics (call success rate, booking success rate, tool-call latency). Daily-summary cron is a planned follow-up.
- Logging inside `runFallback()` itself. The callsites in `agent/src/index.ts` log when fallback is triggered; the dead-air-guard internals don't yet. Adding it would touch the 13 fallback unit tests; deferred.

---

## Observability — Sentry error monitoring

Sentry sits on top of Better Stack to provide error grouping, stack-trace deduplication, and alert-on-spike — things log aggregation alone can't do well. Both services use the same DSN; the `service` tag (`secretary-hq-backend` vs `secretary-hq-agent`) separates them in the Sentry UI.

### One-time setup

1. Sign up at [sentry.io](https://sentry.io). Free tier is 5k events / month — enough for pre-beta and the first few weeks of customer traffic.
2. Create a Node.js project. Copy the DSN.
3. Set `SENTRY_DSN=<dsn>` on the backend Railway service (`secretary-hq-production`) AND the agent Railway service (`secretary-hq-agent`). Same value on both.
4. Optional but recommended: set `SENTRY_RELEASE=$RAILWAY_GIT_COMMIT_SHA` on both services so Sentry can group events by build (helps spot "regressions started in commit X").
5. Restart both services. New errors start appearing in the Sentry UI within seconds.

If `SENTRY_DSN` is unset, both services keep running with logging-only error observability — the SDK is a no-op so local dev / tests don't make network calls.

### What gets captured

- **Backend.** Everything routed through `logError()` in `src/middleware.ts` (route handler errors via `withHandler`, post-call summary failures, booking RPC errors, calendar sync errors) plus Fastify's `setErrorHandler` for unhandled throws inside plugins. Auto-tagged with `tenant_id` + `route` + `event`.
- **Agent.** Fallback-triggered events (`dispatch_metadata_invalid`, `session_context_lost`) plus Sentry's default Node integrations (uncaughtException, unhandledRejection). Auto-tagged with `tenant_id` + `call_id`.

### Performance + cost knobs

- `tracesSampleRate: 0` and `profilesSampleRate: 0` — errors only, no performance/profiling overhead. The `src/services/metrics.ts` Prometheus endpoint already covers latency/throughput.
- The SDK uses a background queue, so a Sentry-side outage never blocks the main thread.

### Dashboard wiring

Same opt-in pattern via `@sentry/nextjs`. Three files own it:

- `dashboard/instrumentation.ts` — server-side init (Node + Edge runtimes). Next.js calls `register()` once at process start. Also exports `onRequestError = Sentry.captureRequestError` so server-render errors surface in Sentry instead of being silently absorbed by Next's error boundary. Tagged `service: secretary-hq-dashboard`.
- `dashboard/sentry.client.config.ts` — browser-side init. Reads `NEXT_PUBLIC_SENTRY_DSN` because client-side env vars need the `NEXT_PUBLIC_` prefix. Same `service: secretary-hq-dashboard` tag, with `runtime: browser` so the UI can split client vs server events.
- `dashboard/next.config.mjs` — wrapped with `withSentryConfig`. Source-map upload is gated on `SENTRY_AUTH_TOKEN` so CI/CD uploads symbol maps while local builds stay silent. `tunnelRoute: '/monitoring'` proxies Sentry events through the dashboard origin so ad blockers don't drop them.

Env vars on the dashboard Railway service (`dashboard-production-cee3`):

| Var                             | Purpose                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                    | Same DSN as backend + agent. Server-side init reads this.                                                                                 |
| `NEXT_PUBLIC_SENTRY_DSN`        | Same value — exposed to the browser bundle for client-side init.                                                                          |
| `SENTRY_AUTH_TOKEN`             | (CI/CD only) source-map upload token. Get from Sentry → Settings → Auth Tokens. Unset = no symbol-map upload, stack traces stay minified. |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Required when `SENTRY_AUTH_TOKEN` is set.                                                                                                 |

If `NEXT_PUBLIC_SENTRY_DSN` is unset, client-side init no-ops; `instrumentation.ts` checks `SENTRY_DSN` for the same opt-in on the server side. Same as the other two services: local dev / tests make zero Sentry calls.

---

## Security Checklist

Before going live, verify:

- [ ] **JWT_SECRET** is a strong random string (not the default `dev-jwt-secret-change-in-production`)
- [ ] **AGENT_SECRET** is a strong random string and matches between the backend and agent services on Railway
- [ ] **Telnyx outbound SIP credential** is high-entropy (toll-fraud target). `openssl rand -base64 32`. Stored in 1Password / AWS Secrets Manager, never committed.
- [ ] **Telnyx SIP subdomain** (`<your-subdomain>.sip.telnyx.com`) is set to **Only my connections**, not From Anyone
- [ ] **Database password** is strong and not committed to source control
- [ ] **OPENAI_API_KEY** is not exposed in client-side code
- [ ] **Login credentials** have been changed from the seeded defaults
- [ ] **CORS origin** is restricted to your dashboard domain (currently set to `origin: true` which allows all)
- [ ] **Supabase RLS** is verified as enabled on all tenant-scoped tables

---

## Troubleshooting

| Problem                                          | Solution                                                                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/agent-tools/*` returns 401                     | `AGENT_SECRET` mismatch — must be identical on the backend and agent Railway services                                                                                                         |
| `/provisioning/activate` returns 503             | `TELNYX_API_KEY` or `TELNYX_SIP_CONNECTION_ID` missing on backend service                                                                                                                     |
| LiveKit agent worker disconnects on boot         | Check `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` on the agent service; the worker logs the rejection reason                                                                     |
| Calls to a Telnyx number return "not in service" | Carrier-side LERG propagation. Verify the number is `active` and bound to the right SIP Connection via Telnyx API; if so, open a Telnyx support ticket — see `TICKET_SUPPORT.md` for template |
| Database connection refused                      | Verify connection string and that Supabase allows your IP                                                                                                                                     |
| Migrations fail on Supabase                      | `pgvector` extension must be enabled first                                                                                                                                                    |
| CORS errors on dashboard                         | Update CORS origin in `src/index.ts` to your dashboard domain                                                                                                                                 |
| JWT errors after deploy                          | Ensure `JWT_SECRET` is the same across backend restarts                                                                                                                                       |
| Knowledge base search returns nothing            | Verify `pgvector` extension is enabled and documents have embeddings                                                                                                                          |
