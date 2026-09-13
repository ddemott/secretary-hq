# SecretaryHQ — Production Incident & Telephony Runbook

Operator-facing playbook for diagnosing and recovering production incidents.
Pairs with `docs/operations/DEPLOYMENT.md` (how prod is wired) and `docs/operations/SECURITY.md`.

**First move for any incident:** check the health board — `./scripts/simulate.sh status --env prod [--deep]` (or `npm run status`). It reports backend / dashboard / agent liveness and build staleness in one shot.

---

## 0. Quick reference

| Thing         | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Backend       | `https://secretary-hq-production.up.railway.app/`                                                      |
| Liveness      | `GET /health` — process up only, no DB (`{status, started_at}`)                                        |
| Readiness     | `GET /ready` — pings DB + reports pool saturation; 503 when DB unreachable                             |
| Metrics       | `GET /metrics` — Prometheus text, Bearer `METRICS_TOKEN` (404 if token unset)                          |
| Phone (prod)  | `+1 630-822-9086` (Telnyx, tenant Thinking Hammer LLC; current)                                        |
| Inbound trunk | LiveKit trunk `ST_aUM3GuCuc9wL`                                                                        |
| Logs          | Railway live-tail (stdout) + Better Stack (if `BETTER_STACK_TOKEN` set)                                |
| Errors        | Sentry (if `SENTRY_DSN` set)                                                                           |
| Services      | Railway: `secretary-hq` (backend), `secretary-hq-agent` (worker), `dashboard` — all deploy from `main` |

**Key metric series** (`/metrics`): `errors_total{event}`, `http_requests_total{route,method,status}`, `http_request_duration_ms`, `booking_attempts_total{outcome,source}`, `tool_calls_total{tool,outcome}`, `sync_dispatches_total{provider,entity,action}`.

---

## 1. Triage signals

1. **Is the process up?** `curl https://secretary-hq-production.up.railway.app/health` → expect `200 {status:"ok",...}`. No response = backend down → §5.
2. **Is the DB reachable?** `curl .../ready` → `503` or `pool.waiting > 0` sustained = DB/pool problem → §6.
3. **Error rate?** `rate(errors_total[5m])` climbing, or Sentry alerting → find the `event` label, grep Better Stack for it.
4. **Build current?** `./scripts/simulate.sh ci` shows local build freshness + the 4 CI job conclusions. A backend running longer than the last `src/` change suggests a stale binary (see Build Principles in `CLAUDE.md`).

---

## 2. Incident: the voice agent is silent / not answering calls

Symptom: caller hears ringing then dead air, or the call connects but the AI never speaks; no new rows in `voice_sessions`.

Check in order:

1. **Agent worker alive?** `./scripts/simulate.sh status --env prod --deep` dispatch-tests the `secretary-hq-agent` worker. If the deep check fails, the worker is down → redeploy `secretary-hq-agent` on Railway, confirm it booted (Railway logs show the LiveKit worker registering).
2. **Agent → backend auth.** The worker calls `/agent-tools/*` with `x-agent-secret`. A mismatch returns 401 and the agent can't fetch tenant context. Symptom in logs: `Agent not authorized — check AGENT_SECRET config`. Fix: ensure `AGENT_SECRET` is identical on `secretary-hq` and `secretary-hq-agent`.
3. **Agent `BACKEND_URL`.** Must be `https://secretary-hq-production.up.railway.app` on `secretary-hq-agent` (the worker exits at boot if unset). A wrong URL = every tool call fails.
4. **TTS / LLM provider down.** Dead air after the greeting can be **Deepgram Aura** (TTS) or OpenAI (LLM) timing out. Check the dead-air guard logs (`agent/src/fallback.ts`) and the hold-line watchdog (`agent/src/session/holdLines.ts`). Check OpenAI quota (a 429 surfaces as a tool 500) AND the Deepgram key. **If the line is SILENT rather than slow, suspect the Aura WebSocket handshake** — a bad param (e.g. `speed`) makes Aura answer 400, the socket never opens, and there is no TTS at all: run `cd agent && npm run verify:tts`. **A silent line is not always a failed handshake (2026-08-14):** the WS `speak` path has been observed opening cleanly and then delivering **zero audio bytes**, while the HTTP `collect` path returned audio on the same key and voice. `verify:tts` demands real bytes, so it catches both shapes — but if it passes and callers still hear nothing, set `AURA_TTS_STREAMING=false` on the agent service to move replies onto the collect path, then reopen the investigation. Observed on one dev host, not on prod; treat it as a lead, not a diagnosis.
5. **Inbound never reached the agent at all** → this is a telephony-path problem, not an agent problem → §7.

---

## 3. Incident: reminders not sending

Symptom: appointments booked but no confirmation/reminder SMS or email.

Check in order:

1. **Scheduler running?** `reminderScheduler` ticks every 60s, only in prod or when `ENABLE_REMINDER_SCHEDULER=true`. Confirm the backend booted in production mode. Logs show the scheduler batch tick.
2. **SMS silently in mock mode.** Without `TELNYX_PHONE_NUMBER`, the ProviderRegistry still defaults to Telnyx but a missing number means sends fail; without Telnyx creds it can fall to MockAdapter (a boot warning fires). Symptom: `reminder_schedules` rows flip to `sent` but no SMS arrives. Fix: confirm `TELNYX_PHONE_NUMBER=+16308229086` + `TELNYX_API_KEY` on Railway.
3. **Email silently in mock mode.** Without `EMAIL_USER`/`EMAIL_PASS`, a mock transporter returns a fake messageId and nothing sends (boot warning fires — `envWarnings.ts`). Fix: set the Gmail app-password env on Railway.
4. **Per-tenant SMS rate limit.** A tenant batching many sends can hit the token bucket (`smsRateLimit.ts`, 429 → retryable). Rate-limited reminders fall into the 5m/30m/2h retry queue — check `reminder_schedules` retry columns, not a true failure.
5. **Consent gate.** Comms are consent-gated. A customer with an `opt_out_records` row (or no consent) is skipped by design — check `consent_records` / `opt_out_records`.

---

## 4. Incident: Stripe webhook 400 / subscription won't activate

Symptom: customer pays but the tenant gate doesn't flip; Stripe dashboard shows webhook delivery failures (400).

Check in order:

1. **`STRIPE_WEBHOOK_SECRET` set + correct?** An empty/mismatched secret makes the handler reject every event 400 (signature verify fails — boot warning fires when `STRIPE_SECRET_KEY` is set but the webhook secret isn't). Fix: copy the signing secret from the Stripe webhook endpoint into Railway.
2. **Webhook registered at the right URL?** `https://secretary-hq-production.up.railway.app/billing/webhook`, subscribed to the 3 events (`checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted`).
3. **Price IDs.** A missing `STRIPE_SOLO/GROWTH/PRO_PRICE_ID` makes that plan's checkout 503 before any webhook.
4. **Verify the round-trip locally** with `stripe listen` + `./scripts/simulate.sh stripe` before blaming prod.

---

## 5. Incident: backend down / 5xx spike

1. `curl .../health` — no response → process crashed or Railway is redeploying. Check Railway deploy status + logs for the crash stack (also in Sentry).
2. **Boot refusal.** In production the backend exits if `DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, or `STRIPE_SECRET_KEY` is missing. A crash-loop right after a deploy with no stack usually means a dropped required env var.
3. **5xx without a crash** → look at `errors_total{event}` + Sentry for the dominant event. Pool-checkout timeouts (§6) surface here as `errors_total` increments.
4. **Recovery:** redeploy the last green `main` commit. All 3 services deploy from `main` — a `git push` to a branch deploys nothing; a revert must land on `main` via merge.

---

## 6. Incident: DB pool saturation / slow everything

Symptom: `/ready` shows `pool.waiting > 0` sustained, requests timing out at ~5s.

Background: the pool (`src/database/index.ts`) is capped `max=10` with `connectionTimeoutMillis=5000` (checkout fails fast → error → `errors_total` rather than hanging) and server-side `statement_timeout=30000` / `lock_timeout=10000` / `idle_in_transaction_session_timeout=60000`.

Check:

1. **A slow query holding connections** — look for `statement_timeout` cancellations in logs; find the offending route via `http_request_duration_ms` p95 by route.
2. **A lock fight** — `lock_timeout` errors point at contended rows (e.g. booking under load; the GiST exclusion constraints are race-safe but a pathological pattern can still queue).
3. **Connection leak** — `pool.total` pinned at 10 with low throughput. Restart the backend to drain; then hunt the un-released client.
4. `/ready` is a signal, not a traffic gate, unless Railway's healthcheck path was repointed to it.

### 6b. "No one is scheduled that day" for hours the owner does work

Symptom: a caller asks for a normal weekday inside the owner's normal hours and
is told nobody is scheduled. `employee_schedule` simply has no row for that date.

Background: `employee_schedule` stores one dated row per shift and **no rule**.
The rolling extender (`src/services/extendSchedules.ts`, worker
`src/workers/scheduleExtender.ts`) keeps the bookable window from shrinking a day
per day. It projects from ONE of two sources, and which one it used decides what
you do next:

1. **The DECLARED rule** — `employee_schedule_pattern (tenant_id, employee_id, day_of_week)`,
   written by `expandWeeklyToSchedule` from the same weekly grid the wizard and
   `POST /shifts/expand-weekly` already collect. When a rule exists for an
   employee, it wins outright and the derivation is skipped for them.
2. **A DERIVED fallback** — the employee's tail week, **clamped to
   `CURRENT_DATE + 14`**. The clamp is load-bearing: without it, a single
   one-off shift far in the future (an "annual inventory Saturday" 300 days out)
   becomes the whole tail week, Mon–Fri silently stop being extended, and the
   business goes unbookable in about six months.

**ADOPTION IS ON THE OWNER'S NEXT SAVE, AND ONLY ON THEIR NEXT SAVE.** Migration
`20260820000000` added the table and **deliberately backfilled nothing** —
inventing a rule out of historical rows is the row archaeology the table exists
to end, and every archaeological rule is wrong in its own way (a recent-window
rule resurrects a weekday the owner dropped; a "densest week" rule over-schedules
the light leg of a rotation, which puts a real customer in front of a locked
door; a "3+ weekdays" rule never qualifies for the Saturday-only owner and leaves
them unbookable). So every tenant provisioned before that migration runs on the
clamped fallback until somebody saves hours for them.

Check:

```sql
-- Which source is this employee on?
SELECT day_of_week, start_time, end_time
  FROM employee_schedule_pattern
 WHERE tenant_id = $1 AND employee_id = $2
 ORDER BY day_of_week;          -- rows → declared rule; empty → derived fallback

-- How far the bookable window actually reaches:
SELECT MAX(shift_date) FROM employee_schedule
 WHERE tenant_id = $1 AND employee_id = $2 AND is_off IS NOT TRUE;
```

Fix: **have the owner re-save their weekly hours** (Schedule tab → weekly hours,
or the setup wizard's hours step). That one save writes the rule and the next
extender tick projects it. Do NOT write a backfill script — the rule is a
statement of intent and only the owner has it.

Two behaviours worth knowing before you touch anything:

- The rule is **replaced, not merged**. A weekday absent from the saved grid
  means the owner dropped it; merging would resurrect it forever.
- An **empty** pattern does not wipe an existing rule. "This employee has no
  hours" and "the caller sent nothing" arrive identically, and wiping on the
  ambiguous reading is how a bookable business goes dark. The callers that mean
  "no hours" delete the rule explicitly, beside the delete of the future rows.

Covered by `tests/services/schedulePatternAdoption.realdb.test.ts`, which
exercises both the adoption path and the clamp regression, and by
`tests/services/extendSchedules.realdb.test.ts`.

---

## 7. Telephony troubleshooting (Telnyx → LiveKit → agent)

The inbound path: **PSTN caller → Telnyx DID → Telnyx SIP Connection → LiveKit Cloud SIP trunk → LiveKit dispatch rule → `secretary-hq-agent` worker (tenant via SIP metadata).**

### 7a. Call doesn't connect at all (busy / fast-busy / no ring)

1. Confirm you dialed the **live** DID `+1 630-822-9086`. Previous `+1 630-866-1960` (Telnyx id `2973794140900296302`) dead. Test verification number `+1 630-822-9086`; `+1 630-937-9478` long dead (orders deleted).
2. Telnyx portal → the number is assigned to SIP Connection `livekit-outbound` (`2945038451784812111`) and the connection is **active**.
3. Telnyx creds present in prod: `TELNYX_API_KEY` + `TELNYX_SIP_CONNECTION_ID` (else provisioning/OTP 503, though inbound routing is portal-side).

### 7b. Call rings but agent never picks up / no audio

1. **Watch LiveKit** `listRooms()` while a test call comes in — a room should appear. No room = the call never crossed Telnyx → LiveKit (SIP trunk misconfig or LiveKit creds rotated). Note: local `.env` LiveKit API key has been rotated at Railway before — a dead local key won't affect prod, but a dead **prod** key breaks dispatch.
2. Room appears but no agent joins = worker down or not registered → §2 step 1.
3. Agent joins but silent = TTS/LLM → §2 step 4.

### 7c. Live transfer ("talk to a person") fails

**Check this first, before touching Telnyx config: under the LIVE architecture (question trees, `ENABLE_QUESTION_TREE` on by default), `transfer_call` is not in the model's toolset at all** — `selectedTools()` in `agent/src/checklist/checklistTools.ts` never includes it, on any tree, on any preset. This means a caller who says "representative" (the exact word the greeting's `CLOSER_WITH_TRANSFER` offers when a forward number is configured, `agent/src/greeting.ts`) cannot actually be transferred — there is no tool the model can call to execute it, independent of Telnyx/SIP config. See CLAUDE.md's `/agent` bullet ("Still capability the product believes it has and currently does not... `transfer_call`") — this is a known, currently-open product gap, not a misconfiguration. `docs/planning/TODO.md`'s open "Live validation call" item (§1) is the test that would confirm this on a real call; it has not been run as of this writing.

If/when `transfer_call` is wired into a tree and this becomes a real config question:

1. REFER is enabled by DEFAULT on Telnyx FQDN connections as of 2026-07-07 — there is no toggle to check in the Telnyx UI. If a transfer attempt still fails at the SIP layer, that would be a Telnyx-side issue to escalate, not a setting to flip here.
2. **Forward number set?** Dashboard → AI Persona → "Forward Calls to a Person". No number = the greeting doesn't offer the "representative" opt-out at all (`forwardPhone` gates it) — nothing to transfer to either way.

### 7d. Blocked-caller-ID booking can't verify

`send_verification_code` needs `TELNYX_API_KEY` + `TELNYX_SIP_CONNECTION_ID` in prod; missing → OTP send fails.

> Only real PSTN inbound can't be simulated end-to-end from CI. Everything up to the LiveKit dispatch is checkable with `./scripts/simulate.sh status --deep` and `call`.

---

## 8. Escalation / after-action

- Capture the dominant `errors_total{event}` label + a Better Stack log window + the Sentry issue link.
- If a deploy caused it: revert on `main` (merge), confirm CI green (`npm run ci:status`), let Railway redeploy.
- Apply prod DB migrations BEFORE merging code that depends on them (`./scripts/setup-db.sh "<prod-url>"`).
- Record the incident + fix in `planning/RESOLVED.md` once closed.
