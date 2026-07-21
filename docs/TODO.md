# TODO — SecretaryHQ (single backlog)

**This is the one and only backlog.** Consolidated 2026-07-05 from the former
`GAPS.md`, `IMPROVEMENT_IDEAS.md`, `IMPROVEMENTS_TODO.md`, and
`AIASSISTANT_GO_LIVE_TODO.md` (all deleted; their done items + analysis archived
verbatim in `docs/RESOLVED.md` under the 2026-07-05 entry).

Items are ordered by what should be done first. Ownership tags:
`(Dale)` = user/ops action, no code · `(code)` = codeable now · `(blocked)` = waiting on an external gate ·
**untagged** = deferred code work (the P3 / UX / doc-hygiene sections — no per-item owner because nothing there is scheduled).

**Not backlogs (left as reusable procedure/reference, do not fold here):**
`docs/BRANCH_CHECKLIST.md`, `docs/CODING_STANDARDS.md`, `docs/DEPLOYMENT.md`,
`docs/DEVELOPMENT_WORKFLOW.md`, `docs/ALERTS.md`. Completed work + history: `docs/RESOLVED.md`.
Voice/Telnyx go-live ops detail + incident recovery: `docs/RUNBOOK.md` §7.

---

## 🔴 P0 — Launch blockers (clear before the first paying customer)

Ordered: the product must answer + transfer + book on a real call, then take money,
then be gated/insured. Most of this is your action, not code — the code is shipped.

### 1. Voice path — make a real call work end-to-end

_Post-live voice enhancements (recording disclaimer, etc.) live in **🎙️ Voice — Phase 2** at the bottom of this file._

- [x] **(Dale)** Enable **call transfer / REFER** on the Telnyx SIP Connection (`livekit-outbound`). ~~Until then `transfer_call` fails at runtime and the agent silently degrades to taking a message.~~ **RESOLVED 2026-07-07**: No toggle exists in Telnyx UI — FQDN connections support SIP REFER by default. Nothing to configure.
- [x] ~~**(Dale)** Confirm `TELNYX_API_KEY` + `TELNYX_SIP_CONNECTION_ID` are set on Railway~~ — **DONE 2026-07-09.** All three present. **`TELNYX_PHONE_NUMBER` held the DEAD `+16308661960`** (order deleted); corrected to `+16308229086` and the backend redeployed (`started_at` `23:49:38Z`).
  - **What it was breaking:** the var is the outbound-SMS `from` fallback (`tenantConfig.inboundPhone || process.env.TELNYX_PHONE_NUMBER`, `smsService.ts:66,147` + `appointments.ts:710`). Any tenant without its own `inbound_phone` was sending confirmations/reminders from a number Telnyx no longer owns → provider rejects → silent `status='failed'` rows in `communications_history`. **Inbound voice was unaffected** (routing is Telnyx number → SIP Connection, not this var), which is why the 2026-06-30 live-call test passed while SMS was broken.
  - **Why nothing caught it:** `featureReadiness.ts:68,81` checks only that the var is _set_, never that Telnyx still owns the number. A set-but-dead credential reads as healthy.
  - Only the backend reads this var — `agent/` and `dashboard/` never do (agent takes the transfer target from tenant config, not env). Single fix sufficed.
- [ ] **(Dale, use wife's phone)** **Live validation call** — do these steps together in one sitting:
  1. Set the **forward number** on the dashboard AI Persona → "Forward Calls to a Person" (`+1 608 217 5303`) before calling.
  2. Have wife call `+1 630-822-9086` (must use her phone — can't call from your cell and forward to it).
  3. Validate booking: appointment lands in `appointments` for tenant `d5e3c6a1` inside a real shift window.
  4. Validate transfer: say "talk to a person" → your cell rings + Calls tab shows the transcript.
  5. Validate dialog: agent asks preferred time, widens when none fit, never imposes a slot, recalls preferences across calls.
     (PSTN inbound itself already confirmed 2026-06-30; this closes the booking + transfer + preference legs.)

### 2. Billing — be able to take money

- [ ] **(Dale)** **Decide final tier pricing** before creating Stripe products — current placeholders ($129/$279) have not been validated. Research findings + cost model (2026-07-07):
  - **Variable cost per call (5-min avg):** Telnyx ~$0.03 + LiveKit ~$0.02–0.05 + Deepgram $0.02 + OpenAI LLM ~$0.001 + OpenAI TTS ~$0.02–0.09 = **~$0.09–0.17/call**
  - **Loss point:** an uncapped Solo tier at 1,000 calls costs $90–170 in variable cost alone — near-zero or negative margin at $129/mo
  - **Recommended Solo cap: ~300–400 calls/month** → variable cost ~$27–51, gross margin ~$78–102 on $129/mo
  - **Competitor benchmarks (verified July 2026):** Rosie AI $49/$149/$299 (250/1,000/2,000 min); Goodcall $79/$129/$249/agent (100/250/500 unique customers/mo); Signpost $199/$399/$749 (AI-only → hybrid human+AI)
  - **Key differentiator to keep:** include booking + call transfer at ALL tiers — competitors (Rosie, Goodcall) gate these to mid-tier. Lead with "full receptionist from day one."
  - **Suggested tier shape:** Solo ~$99–129/mo (1 location, ~300 calls/mo cap, full booking+transfer) · Growth ~$199–249/mo (multi-location or higher volume, Square CRM sync, analytics) · Pro ~$349+/mo (unlimited volume, priority support)
  - **Volume metering is NOT built yet** — tiers are flat subscriptions today; the overage build is a P2 item (see P2 section below). Go flat-rate for first customer, retrofit volume once real usage data exists.
  - **DECIDED 2026-07-20 (Dale) — the overage model.** Dollar amounts per tier still open above, but the mechanics are settled:
    - **Billing unit: the ANSWERED call** — caller spoke at least once AND duration ≥ ~15s. Silent rooms, instant hang-ups, spam, and robocalls are FREE (both honest and a sales line — the definition is a query over `voice_sessions`, which already records duration + transcript).
    - **Flat tiers + auto-applied call PACKS, never a running meter** (the surviving telecom model: postpaid auto-blocks, not per-MB bill-shock). Quota exhausted → a fixed-price pack (e.g. **+$25 / 30 calls**, ~$0.83/call internal) auto-applies and calls KEEP ANSWERING. Owner is alerted at 80%, 100%, and on each pack purchase.
    - **NEVER cut service on quota** — "that's like a punch in the gut": a capped line punishes the tenant's CUSTOMERS for the tenant's success, and voicemail is the product breaking its one promise. Overage bills; the following month the owner adjusts the plan (repeat pack-buyers get the "Growth would have saved you $X" nudge on the Billing page).
    - **Quota exhaustion ≠ non-payment.** Only ordinary SaaS dunning (card declines → retries → grace → suspension) ever stops the line — never usage.
    - Overage price floor sanity (measured 2026-07-20, Jack Jung call, 163s): ~5–7¢ all-in per call (LLM 4.1-mini ~1.7¢ + Aura TTS ~1.8¢ + STT 0.2¢ + PSTN ~1¢) → pack pricing carries 80–90% margin.
- [ ] **(Dale)** **Stripe setup** — do these in order:
  1. **Open an LLC bank account** for Thinking Hammer LLC — required before Stripe can pay out. (Also listed under Legal §5 below.)
  2. **Connect bank account to Stripe** — add it in Stripe dashboard → Settings → Bank accounts & scheduling.
  3. **Create products + prices** in Stripe dashboard — Solo, Growth, Pro plans. Note the 3 price IDs.
  4. **Set 5 env vars on Railway**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SOLO_PRICE_ID`, `STRIPE_GROWTH_PRICE_ID`, `STRIPE_PRO_PRICE_ID`.
  5. **Register the webhook** in Stripe dashboard → `https://ai-sec-production.up.railway.app/billing/webhook` for 3 events: `checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted`.
  6. **Test-mode round-trip** (no real money): run `stripe listen --forward-to https://ai-sec-production.up.railway.app/billing/webhook`, trigger a test checkout, verify each event activates/revokes the tenant gate. (`./scripts/simulate.sh stripe` path-checks the wiring first.)
- [ ] **(Dale)** **Stripe Tax** (after round-trip verified): enable Stripe Tax in Stripe dashboard → Tax → Settings; register nexus for IL + customer states; set `STRIPE_AUTO_TAX=true` on Railway. (Code done — `automatic_tax` gated behind the flag.)

### 3. Deploy gate — protect main

- [x] ~~**(Dale)** Enable the **"Wait for CI"** toggle on the 3 Railway services~~ — **DONE 2026-07-09.** Enabled on all 3 (`ai-sec`, `ai-sec-agent`, `dashboard`) at Railway → Service → Settings → Source → "Wait for CI" ("Trigger deployments after all GitHub actions have completed successfully"). Railway stages settings edits — they only take effect after clicking **Deploy** on the "Apply N changes" banner. The Railway GitHub App already held `checks` + `commit statuses` read/write on all repos, so no permission grant was needed.
  - **Caveat:** this is **unversioned dashboard state** — `railway.json` has no field for it. If a service is ever recreated the toggle silently reverts, and nothing in the repo will tell you. Re-check after any service recreation.
  - **Caveat:** the setting waits on _all_ GitHub Actions on the commit, not on the branch-protection required-checks list. Any future workflow that runs on `main` and can fail will also block deploys.
- [x] ~~**(Dale, code)** **Prove the gate** end-to-end~~ — **PROVEN 2026-07-09 (PR #227).** A deliberately-failing test made `Backend` red → `mergeStateStatus: BLOCKED` → `gh pr merge` **refused** with `the base branch policy prohibits the merge`. Deleting the test flipped all 4 checks green → `CLEAN` → merge allowed. Branch protection holds.
  - **Not tested, deliberately:** `gh pr merge --admin`. If `enforce_admins` didn't hold, that would merge a failing test to `main` and deploy broken code to Railway. The API reports `enforce_admins: true` — verified-by-config, not by experiment.
  - **This proves the MERGE gate only.** The **deploy** gate is still open: after #226 merged, Railway brought up the new backend at `19:27:03Z` while CI didn't go green until `19:31:27Z` — prod deployed ~4 min _ahead_ of its checks. That is exactly what the "Wait for CI" toggle above closes. Branch protection stops a red PR from merging; nothing yet stops a merged commit from deploying before CI confirms it.

### 4. Security housekeeping

- [ ] **(Dale)** **Rotate the Railway team token** created 2026-06-12 — it was pasted into a Claude session. Burn + reissue.
- [ ] **(Dale)** **Rotate the Supabase DB password** — exposed in a session transcript 2026-07-11.

### 4a. 🔴 RLS IS NOT ENFORCED IN PRODUCTION — the single biggest thing on this list

**Found 2026-07-13 by an adversarial review of the remediation plan itself.** Verified against prod, not inferred:

```
current_user = postgres   rolsuper = f   rolbypassrls = t
set_config('app.current_tenant_id','00000000-0000-0000-0000-0000000000ff')   -- owns nothing
select count(*) from customers;  -> 1
select count(*) from tenants;    -> 3      -- ALL of them
```

The app connects as a role with **`BYPASSRLS`**. Every RLS policy and every `FORCE ROW LEVEL SECURITY` is **decorative** — FORCE only removes the table-_owner_ exemption, it does not override BYPASSRLS. Local + CI connect as a **superuser**, which also bypasses. **No test in this repo could ever have caught it, and none did**: the 39 isolation probes exercise the _middleware_, and their RLS assertions check _configuration metadata_ (policies exist) rather than that policies _apply to the connecting role_.

**`tenantMiddleware` is not defense-in-depth. It is the entire defense.** That is why the 2026-05-21 anonymous-`?tenant_id=` bug was a full read/write/delete and not a near-miss.

- [x] ~~**Make it visible**~~ — **DONE 2026-07-13 (#245).** `GET /ready` reports `rls_enforced` + `db_role`; boot logs `rls_not_enforced` + `errors_total{event="rls_not_enforced"}`; CLAUDE.md + `docs/SECURITY.md` corrected (both asserted RLS was enforced — that false claim is what let this hide).
- [ ] **(code)** **Migrate to a non-BYPASSRLS `app_user` role.** Its own staged project, **not a patch**. ⚠️ **LANDMINE — read before starting:** the `admin_bypass` policies test `current_setting('app.current_tenant_id', true) = ''`, but on a **cold pool connection** that GUC is **NULL**, and `NULL = ''` is NULL — _not_ true. Flipping the role without fixing this first makes `getDueReminders()` (raw cross-tenant sweep) return **zero rows on a cold connection** → **every reminder silently stops**. Required order: (1) rewrite every admin_bypass policy as `coalesce(current_setting(...), '') = ''`; (2) create the non-superuser, non-BYPASSRLS role; (3) migrate `DATABASE_URL`; (4) **prove isolation with a test that connects AS THAT ROLE** — the only kind of test that can prove it; (5) then rewrite the docs.
- [ ] **(code)** **Prod has drifted from `baseline.sql` on RLS flags and the schema guard can't see it.** In prod `message_delivery_status` has RLS **enabled with zero policies** (deny-all for any non-bypassing role); `baseline.sql` declares no RLS for it. The schema-alignment guard compares tables + columns, **not RLS flags**. Extend it.

### 4b. Code review 2026-07-13 — four-reviewer sweep (backend, security, reliability, dead code)

> **Adversarially re-reviewed 2026-07-13 (Opus).** Two of my findings were **REFUTED and dropped**:
> **CORS is NOT open in prod** (`curl -H "Origin: https://evil.example.com"` → `access-control-allow-origin: https://www.secretaryhq.com`; Railway sets `CORS_ORIGIN`, only the code _default_ is bad), and my **`message_delivery_status` RLS finding was measured against the LOCAL database and reported as production** — where it is in fact RLS-enabled-with-zero-policies (see 4a). The proposed "fix" would have changed nothing under BYPASSRLS and then been written into `SECURITY.md` as "RLS enforced" — worse than leaving it.
>
> **Severity corrections:** `find-customer-by-name` (name/phone enumeration) is **the worst security bug left** — the only one exploitable by a person with a telephone and no credential. `isTenantExempt`'s blanket `/tenants/*` exemption is **not latent** now that middleware is the sole boundary. The schedule-extender poison is **over-rated** (it is a _future_ regression needing an owner to add a far-future one-off shift — it is NOT the bug that killed the 2026-07-12 call, which was simply "the schedule ran out"). `ENABLE_VOICE_SESSION_REAPER`/`ENABLE_SCHEDULE_EXTENDER`: **my proposed "fix" was a regression** — those vars _do_ work outside production (that is how the realdb tests drive the workers); the real defect is the inverse (no way to turn a worker **off** in prod).

Every item below was **verified by reading the code**, not inferred. Ranked by what bites first.
The two CRITICALs are **fixed on branch `fix/jwt-type-confusion-and-context-gate`** (not yet merged).

**A grounding fact that reframes the rest:** production has **never booked an appointment** — 5 voice
calls, **0 appointments, 0 reminder_schedules, 0 communications_history**, all time. So no reminder
has ever been seeded, no SMS ever sent, and no self-service token ever minted. Several findings below
are unexploited _only because the feature has never once run_. The first real call is the moment they
all go live at the same time.

**CRITICAL — fixed on branch, awaiting merge**

- [x] ~~**Self-service SMS link authenticated as tenant OWNER.**~~ Cancel/reschedule tokens are signed with the same `JWT_SECRET` as sessions; `verifyToken` couldn't tell them apart and the hook did `role: decoded.role ?? 'owner'`. Anyone holding an appointment-confirmation text could replay it as a Bearer token and dump the tenant's customers/appointments/transcripts via `GET /export/tenant-data` for 24h, no password. Never exploited — no SMS has ever been sent. **Fix: every token declares a `typ`; each verifier accepts only its own kind; no owner default.**
- [x] ~~**The OTP gate guarded 1 of 3 doors.**~~ `identify-caller` was gated 2026-07-13; `customer-context` and `customer-history` returned the same name/preferences/history with **no check**, and the LLM picks the phone number it passes. Found independently by two reviewers. **Fix: one shared `callerMayHearCustomerData()` in front of all three; `phone_source` defaults to the cautious `'spoken'`.**

**HIGH — the OTP gate is still weaker than it looks**

- [ ] **(code)** **OTP verification is phone-global for 24h, not call-bound.** The gate accepts _any_ `phone_verifications` row for `(tenant, phone)` verified in the last 24h — nothing ties it to the current call. After Camille legitimately verifies once, **any caller who speaks her number for the next 24h passes with no code at all.** The gate degrades to "was this number ever verified recently", which is the claim-based trust it was built to kill. Fix: store `call_id` on `phone_verifications` and require it to match the live call (or a minutes-long window + consume the row on first use).
- [ ] **(code)** **A 4-digit code is brute-forceable because the attempt cap resets per code.** `MAX_VERIFY_ATTEMPTS=3` is enforced **per row**, and a new `send_verification_code` inserts a fresh row with `attempt_count = 0`. With the 3/hour send limit that's **9 guesses/hour against a 10,000 space, indefinitely, with no lockout and no metric** — ~2%/day of a targeted account, each attempt also SMS-bombing the victim. Old codes are never invalidated on resend, so several are live at once. Fix: count attempts per `(tenant, phone)` over a window; expire prior pending rows on resend; emit `errors_total{event="otp_failed_attempt"}`.
- [ ] **(code)** **A verified caller still can't cancel, reschedule, or hear their appointments.** `ctx.callerPhone` is set once and never reassigned; a forwarded-line call nulls it. But `get_my_appointments`, `send_self_service_link`, and the cancel/reschedule tools all hard-bail on `if (!ctx.callerPhone)`. So on Thinking Hammer's forwarded line, a customer proves her number by SMS code and _still_ gets "I can't do that without caller-ID" — **forever**. The OTP flow proves the number and then throws the proof away. Fix: on `verify_phone_code` success, set `ctx.callerPhone` to the proven number.
- [ ] **(code)** **`find-customer-by-name` reads out real customers' names + full phone numbers** to an unverified caller, on an unanchored `ILIKE '%…%'`. "My name is Smith" (or one common letter) returns up to 5 real `{name, phone}` pairs. Address-book enumeration where the caller supplies the only credential. Fix: mask the phone (`•••-••-1234`) for the "is this still your number?" confirmation and require a near-exact match.

**HIGH — SMS/reminders: the feature is about to run for the first time, and it is blind**

- [ ] **(code)** **The retry policy is unreachable dead code.** `ReminderService.processReminder` catches everything and marks the row `'failed'` itself — it never rethrows. The worker's `catch` (which owns `decideRetry`, `retry_count`, the 5m/30m/2h backoff) therefore **cannot execute**. One transient Telnyx 5xx permanently kills a reminder. `retryPolicy.ts` + migration `20260514000000` are decoration. Prod confirms: `max(retry_count)` is NULL. Fix: rethrow transient errors; let the worker own the terminal-status call.
- [ ] **(code)** **A reminder cancelled for "no consent" is silent** — no log, no metric (`reminders/index.ts:233`). If the LLM ever forgets to ask permission, every confirmation is dropped with **zero trace**. Highest-value single line in the whole sweep: `remindersSkippedTotal.inc({reason:'no_consent'})` + a 5W warn.
- [ ] **(code)** **`sms_sends_total` misses half the sends, and `reminders_sent_total` is never incremented at all.** The counters live only in `ReminderProcessor` — a class **instantiated nowhere** (see dead code below). The raw `sendSms()` path (OTP, page-owner, take-message, self-service link) increments nothing and writes no `communications_history` row. So the `ALERTS.md` SMS-failure-ratio alert evaluates 0/0 forever, and "SMS is silently broken" is exactly the state we could not detect. Fix: increment inside `sendSms()` itself (the chokepoint — one edit covers six call sites) and move the reminder counters into the live `ReminderService`.
- [ ] **(code)** **Unbounded `fetch()` to Telnyx can wedge the reminder worker permanently.** No AbortController in either SMS path. The worker is guarded by an `isRunning` flag, so one hung TCP connection pins it `true` **forever** — all reminders and the demo-tenant cleanup stop, silently, until redeploy. `/health` stays green. Fix: `AbortSignal.timeout(10_000)` in both fetches + a stuck-tick watchdog.
- [ ] **(code)** **`POST /appointments/:id` texts a CUSTOMER through the ungated raw path** (`appointments.ts:726`) — a cancel/reschedule link whose body ends "Reply STOP to opt out", sent with **no consent check**. The identical feature in `agentTools/messaging.ts` checks consent first. Same message, implemented twice, once compliant and once not. **Compliance gap, not just duplication.**
- [ ] **(code)** **SIGTERM doesn't drain in-flight worker ticks** — Railway sends one on every deploy, the reminder tick runs every 60s, and the pool closes underneath a mid-flight batch. A deploy can abort a batch _after_ the SMS left Telnyx but _before_ the row flipped to `'sent'` → the customer is texted **twice** on next boot.

**MEDIUM — correctness in the code shipped 2026-07-12/13**

- [ ] **(code)** **One far-future shift row poisons the schedule extender forever.** `tail` is `MAX(shift_date)` over _all time_ and the pattern is the 7 days ending there. Add a single one-off shift 300 days out ("annual inventory Saturday") and the pattern becomes **Saturday-only**; Mon–Fri quietly stop being extended and the business is unbookable again in ~180 days — by the very worker written to prevent that.
  - **⚠️ All three fixes I first proposed are WRONG** (Opus review, 2026-07-13). _"Last week at or before `LEAST(last_date, CURRENT_DATE+horizon)`"_ is **self-referential** — after the extender's first run `last_date` **is** ~`CURRENT_DATE+180`, so it selects the extender's own output. _"Densest recent week"_ picks the busy leg of a 2-week rotation and **over-schedules the light leg** — and over-scheduling is _worse_ than under-scheduling (under-scheduling loses a booking; over-scheduling puts a real customer in front of a locked door). _"Last week with ≥3 distinct weekdays"_ **breaks the Saturday-only owner** — no week ever qualifies, the extender never runs for them, they go unbookable. That is the bug, re-created.
  - **The real fix: STORE THE RULE.** `extendSchedules.ts` says it outright — _"`employee_schedule` does not store a rule"_ — and the Setup wizard **has** the weekly pattern and throws it away (`expandWeeklyToSchedule.ts`). Add `employee_schedule_pattern (tenant_id, employee_id, dow, start_time, end_time)`, write it from the wizard, project from the **declared rule**. One migration, ~30 lines, and this entire bug class evaporates. Everything else is archaeology on rows to reconstruct an intent we deleted on purpose.
  - Interim heuristic if the rule table is deferred: derive per-`(employee, dow)` from the most recent row in `[CURRENT_DATE - 28, CURRENT_DATE + 14]` (immune to a far-future one-off AND to the extender's own output); never project a `dow` with **zero** worked instances in that window; use a 14-day `(shift_date - anchor) % 14` key when the four weeks aren't identical.
- [ ] **(code)** **`SIGTERM drain` + `atomic claim` are ONE bug, and it fires on EVERY DEPLOY.** The reminder worker has no atomic claim (no `FOR UPDATE SKIP LOCKED`, no flip to `'sending'`) **and** SIGTERM doesn't drain in-flight ticks. Railway SIGTERMs on **every deploy**; the tick runs every 60s. A deploy landing mid-`processBatch` — _after_ Telnyx accepted the SMS, _before_ the row flipped to `'sent'` — **double-texts the customer on next boot.** This is not a hypothetical second replica; it is a routine deploy. **One fix closes both:** claim rows with `UPDATE reminder_schedules SET status='sending' ... FOR UPDATE SKIP LOCKED RETURNING *`.
- [ ] **(code)** **The alternatives search offers slots the booking then refuses.** It hardcodes `durationMinutes: 30` and drops the resolved service's real duration + required skills. A 90-minute service gets offered a 30-minute gap with an unskilled employee → the caller says yes → `NO_SKILLED_EMPLOYEE`. The 2026-07-12 dead-end becomes a rejection loop.
- [ ] **(code)** **`'Caller'` is still an unfixable placeholder on the OTHER write path.** `customerLookup.ts` learned the shared `PLACEHOLDER_NAMES` list; `identity.ts`'s `ON CONFLICT DO UPDATE` still only overwrites `NULL/''/'Valued Customer'`, while `scheduling.ts` writes `'Caller'` on every nameless booking. Book-then-give-name → stuck as "Caller" permanently, greeted that way on every future call. **This is the exact 2026-07-12 bug, still live.**
- [ ] **(code)** **`message_delivery_status` has NO RLS** — verified against the DB: `relrowsecurity = f`, zero policies, the **only** such table in `public`. It has a `tenant_id`, is written by the public Telnyx webhook, and is exported per-tenant. Protected today only by an explicit `WHERE tenant_id = $1`. `docs/SECURITY.md` claims "all tenant-scoped tables have ENABLE + FORCE" — **that claim is false.**
- [ ] **(code)** **`purge-soft-deleted.ts` `--older-than` typo → `NaN` → cutoff silently dropped**, and `--execute --yes` then hard-deletes **every** soft-deleted tenant, including one deleted a minute ago. Reject `NaN` explicitly.
- [ ] **(code)** `/metrics` compares its bearer token with `!==` — use the `timingSafeEqual` helper the agent secret already uses. `GET /templates/full` is reachable **anonymously** and returns every system prompt + first message (platform prompt IP; no PII). `isTenantExempt` exempts _all_ of `/tenants/*` regardless of the list (`path.startsWith('/tenants/')` ignores the loop var) — not exploitable today since every route self-checks, but a new `/tenants/*` route inherits **no** middleware protection.
- [ ] **(code)** **CORS is open in production.** `origin: process.env.CORS_ORIGIN || true`, and `CORS_ORIGIN` is set nowhere — so prod reflects **any** origin. `ARCHITECTURE.md` states as fact that it's restricted. It isn't.

**Dead code / simplification** (see also 🧹 Doc hygiene)

- [ ] **(code)** **Delete the orphaned parallel reminder implementation — 391 lines, zero prod callers.** `services/reminders/reminderProcessor.ts` + `services/reminders/reminderScheduler.ts` are a second, unused implementation whose only caller is a discarded `_`-prefixed dynamic import and a test. The **name collision with the live `workers/reminderScheduler.ts` is what hid it** — and it holds the metrics that were supposed to be watching prod. Its `reminderProcessor-metrics.test.ts` gives the dead class a green-CI halo. Textbook "test it or delete it".
- [ ] **(code)** **Live `n8n` trigger fires on every appointment INSERT** for an integration with **zero application surface** (`n8n_webhook_url` has no readers/writers anywhere). It's `SECURITY DEFINER` and, if `pg_net` were ever installed, would POST **synchronously inside the booking transaction**. Drop the trigger, the function, and the column.
- [ ] **(code)** **`shared/dateTime.ts` — 85 lines, 8 exports, zero importers.** The only fully-orphaned file in the monorepo. Delete.
- [ ] **(code)** **`TelephonyProvider`: 4 of 5 methods are dead Twilio residue** — both adapters `throw` on them, and `MockAdapter` still emits **TwiML XML** for a stack that dropped Twilio months ago. Collapse to `{ getName, sendSMS }` (~120 lines); the registry's one real job (the no-creds Mock switch) is a one-liner.
- [ ] **(code)** **42 of 158 migrations self-manage a transaction the runner already owns.** Their inner `COMMIT;` ends the runner's `--single-transaction` early, so the `schema_migrations` INSERT lands separately — **the all-or-nothing guarantee in `setup-db.sh`'s own comment does not hold**, and a failed rebuild can leave DDL applied with no tracking row. Inert against prod (already applied); fixes `db:rebuild` + fresh environments.
- [ ] **(code)** Inert columns to drop: `business_templates.voice_provider`/`voice_name` (backfilled `'cartesia'`/`'elevenlabs'` — providers that don't exist here, and `SELECT *` ships them to the dashboard), `tenant_integration_settings.webhook_secret` (Jobber-era). `ENABLE_VOICE_SESSION_REAPER`/`ENABLE_SCHEDULE_EXTENDER` are documented as if they work but the `isProduction ||` short-circuit means they **cannot** change behavior. `ProviderRegistry`'s `JEST_WORKER_ID` branch is dead (repo is Vitest-only). `STRIPE_AUTO_TAX` is set nowhere, so `automatic_tax` has **never** been sent to Stripe despite RESOLVED.md listing it as shipped.
- [x] ~~**CLAUDE.md called `tts_soft`/`tts_cheerful` "inert"** — false, and dangerous next to "delete on sight."~~ **Fixed 2026-07-13.** They are live LLM prompt-style flags with dashboard toggles; deleting them would have removed two working features. HIPAA-residue sweep came back **clean**.

### 5. Legal / business (long lead time — start early)

- [ ] **(Dale)** Open an **LLC bank account** for Thinking Hammer LLC (required before Stripe payouts).
- [ ] **(Dale)** Publish + link **legal docs** — Bonterms SaaS ToS + Privacy Policy + DPA (free, lawyer-drafted).
- [ ] **(Dale)** Add **TCPA-compliant SMS opt-in** consent language at booking time — required before any confirmation texts.
- [ ] **(Dale)** **E&O insurance** before the first paying customer (~$800–1,200/yr; Next/Hiscox).
- [ ] **(Dale)** **Cyber Liability insurance** before the first paying customer (often bundled with E&O).

---

## 🔎 Call-review defects — 2026-07-21 live test calls (Camille, 3 calls from +1 262-497-9039)

Transcripts + DB verified. Context: these calls ran on the 6-rung ladder + gpt-4.1-mini
(deployed 2026-07-20) but PRE-date the staged prompt fixes on `feat/usage-billing-statement`
(never-recite caller-ID, digit-by-digit 3-3-4 numbers, "Is this Camille?" recognition) —
items marked **[staged]** are already fixed in that branch and just need the deploy.
What worked: call 2's message flow was clean end-to-end; call 3 booked correctly, captured
the role with graceful handling of three declined questions (rate, length, address), and
linked inquiry→appointment.

- [x] **(code) P0 — RUNG-2 RE-ENTRY: double-booked and then DENIED the first booking (call 1).**
      **FIXED (staged) 2026-07-21:** `formatBookingResponse` now pins a `standing_fact` in every
      successful booking result — "THIS CALL NOW HAS A BOOKED APPOINTMENT: {time} (id …); never
      re-offer, never re-book, never say nothing is booked" — the tool result being the one
      context line the model re-reads all call. Unit-tested (both payload branches) + a full
      replay eval case ("the booking survives a long intake", maxToolCalls + forbiddenSpeech
      graders added) — 15/15 incl. the new case. Ships with the pending branch.
      The hard evidence: appointment created 00:35:56 (Jul 21 3:00 PM), then after intake the
      model re-entered the booking rung, told the caller **"I haven't booked any meeting for you
      yet"** — false — re-offered slots (3:00 now missing from availability _because she held
      it_), and created a SECOND appointment 00:37:46 (3:30 PM). Both sit 'scheduled' in prod.
      The caller even protested ("I thought we already booked one for 3PM") and was overruled.
      Root cause: nothing re-anchors the model on its own completed booking — the confirmation
      is N turns back in context and the runtime keeps the appointment_id (outcomeTracker) but
      never re-injects it. Fix direction (the "runtime, not the model" pattern): after
      book_with_scheduling succeeds, the runtime should pin a standing context line — "ALREADY
      BOOKED THIS CALL: Tue Jul 21 3:00 PM (id …). Do not offer or book another unless the
      caller asks for an ADDITIONAL appointment." Also add an eval case: book → long intake →
      ambiguous 'six months' answer → model must NOT re-open booking.
      _(Ops cleanup: cancel one of the two Jul-21 appointments — 3:00 or 3:30 — before Dale's
      calendar shows a phantom double.)_
- [x] **(code) P0 — intake captured NOTHING on call 1: capture_job_inquiry never ran.**
      **FIXED (staged) 2026-07-21** with the re-entry fix above — same disease, one anchor. The
      replay eval case REQUIRES capture_job_inquiry after the booking and passes.
      Company ("Thinking Pat"), client ("Cayenne"), contract, six months — all collected, none
      saved: no job_inquiries row exists for call 1. A fragment leaked out as a take_message
      note ("prefers to discuss rate in person") — wrong tool mid-intake. After the second
      booking it restarted intake FROM SCRATCH ("which company are you calling from?" — already
      answered) and the call ended with everything lost. Likely the same state-loss as the
      re-entry bug; fix together, and eval-pin: intake answers must end in capture_job_inquiry
      even when interrupted by rung re-entry.
- [x] **(code) P1 — "Anything else I can help you with?" fired while its own question was
      still pending (call 1: asked "What length of contract?" then immediately "Anything else?"
      — the caller's "Six months" landed after; reads as cutting her off). Also appears
      mid-call on every call despite the wrap-up-only rule — recurring drift, now 5/5 live
      calls. Needs a stronger mechanism than the current rung text (candidate: fold the
      anything-else into the RUNG 6 wrap-up line itself and forbid it elsewhere by name).
      **FIXED (staged) 2026-07-21:\*\* the sentence is now legal exactly once, as RUNG 6's opener,
      and banned by name everywhere else (ladder header + CLOSE block); ladder rebuilt.
- [x] **(code) P1 — incoherent caller-ID dispute recovery (calls 1 & 3).** Caller says the
      number is wrong → call 1: "I have the digits 262-497-9039, can you provide the rest to
      complete it?" (it's already complete — nonsense); call 3: she dictated the full number
      digit-by-digit and the model re-confirmed it AGAIN, with "+1". Add to the identity rung:
      a disputed caller-ID switches cleanly to verbal collection — collect once, read back once
      (3-3-4 digits), done.
      **FIXED (staged) 2026-07-21:** identity rung rewritten — one read-back, one yes, never
      twice; disputed caller-ID drops the old number and collects fresh; 3-3-4 digit format in
      the rung itself; never ask to "complete" a complete number.
- [ ] **[staged] Caller-ID recited aloud with "+1" / raw E164 on all 3 calls** ("I have your
      phone number as +12624979039") — fixed in branch: never recite; if callback matters ask
      "is the number you're calling from a good one to reach you?"; any spoken number is
      digit-by-digit in 3-3-4 with no +1.
- [ ] **[staged] No returning-caller recognition (calls 2 & 3).** Camille was identified on
      call 1; calls 2 and 3 asked her name cold. Fixed in branch: known number → "Is this
      Camille?"; message attribution → "Shall I say it's from Camille?". Verify on the first
      post-deploy call.
- [ ] **(code) P2 — company names accepted unverified, again.** "Thinking Pat", "Cayenne",
      "Peachesandcream.com" — one call earlier today turned "Apex" into "Attack". Pattern is
      now recurring (2+ real occurrences): revisit the declined-for-now company-name read-back
      line in the intake rung ("Cayenne — did I get that right?").
- [ ] **(code) P2 — robotic phrasing + a "Just a moment" before a tool (call 3):** "not
      among the officially available bookable times I have listed" is not how a receptionist
      talks, and "Just a moment." violates the tools-are-instant rule. Prompt-style polish;
      batch with the next prompt revision.
- [ ] **(code) P2 — requested time not addressed head-on (call 3):** caller asked for Jul 27
      3 PM; the reply listed 1:00/1:30/2:00 without saying "3 isn't open that day." The 4 PM
      follow-up WAS addressed properly. RUNG 2's named-time branch (staged) should cover the
      named-time path; verify post-deploy and extend to "name the miss" if not.

---

## 🟠 Legal-hold — built, DO NOT merge/enable without sign-off

Both erase PII irreversibly (kill-switched off / inert until enabled). Branches deleted in the 2026-06-23 cleanup; restorable from the PR pages.

- [ ] **(blocked — legal)** **PR #68** — `POST /customers/:id/purge` owner-gated single-customer GDPR/CCPA erasure (typed phone confirmation, atomic anonymize-in-place + audit_log PII redact, kill-switch `ENABLE_CUSTOMER_PURGE`; 8 tests).
- [ ] **(blocked — legal)** **PR #69** — disabled-by-default automated retention/purge worker (`ENABLE_RETENTION_WORKER` + explicit `RETENTION_DAYS`, no default window, per-tenant-failure-isolated; 9 tests). Broader-PII scope (`voice_sessions`/transcripts/appointment descriptions) is a deliberate follow-up.

---

## 🟡 P1 — Customer success & trust (non-blocking, do after P0)

- [x] ~~**`/demo/start` per-IP limiter is a global bucket**~~ — **investigated 2026-07-08, NOT a bug.** A controlled 16-min quiet-window test returned 200, so the window resets normally; the persistent 429s were self-inflicted test traffic. A spoofed `X-Forwarded-For` has no effect because Railway overwrites it with the true client IP (correct, non-spoofable). No action.
- [x] ~~**(code)** **Telnyx webhook verifies a re-stringified body.**~~ **FIXED 2026-07-09.** `/communications/telnyx/status` now HMACs `req.rawBody` (the exact received bytes), like `billing.ts`/`square.ts`. Signature verification was also moved **before** payload parsing — previously an unsigned caller reached the parse path and the route's safety rested on the id/status guard firing first (the parser synthesizes `{}` for an empty body). Compare is now `timingSafeEqual`. The old happy-path test hardcoded `JSON.stringify(payload)` as the signed bytes, so it could never see the bug; replaced with a regression test that signs raw bytes whose key order + whitespace `JSON.stringify` would not reproduce (asserted non-equal, so the test has teeth — verified failing against the old code).
- [x] ~~**(code)** **`npm run prepare-commit` reports a false failure.**~~ **FIXED 2026-07-09.** Two independent causes, both of which kept the gate red on a pristine `main`:
  1. `run_or_skip` eval'd each configured command in the parent shell, so the `cd dashboard` chained into `checks`/`unitTests` leaked out and stranded every later step in the wrong directory (`Missing script: "verify:claude-md"`). Each command now runs in a subshell — `if (eval "$cmd")`.
  2. Step 4's `focusedTestScan` regex was `(\.only\(|\.skip\()`, which flagged every **conditional** skip (`test.skip(process.env.FOO !== '1', …)`, `ctx.skip()`) as if it were a focused test — 12 legitimate guards, so the step could never pass. Extracted to `scripts/focused-test-scan.sh`, which flags only `.only(` and skips/todos whose first argument is a **string literal** (i.e. a test disabled by name = dead code). Verified: silent on the clean tree, and still catches an injected `describe.only(...)` / `it.skip('name', …)`.
- [x] ~~**(code)** **Dashboard vitest exits nonzero with 0 failing tests.**~~ **FIXED 2026-07-09.** Surfaced by the now-working `prepare-commit` gate: `Tests 1012 passed` + `Errors 2 errors`. `useEntityList` / `useServiceMappings` in `dashboard/lib/hooks.ts` fetched from an effect with no cancellation, so an unmount mid-flight ran `setLoading(false)` after vitest tore down jsdom → React read a dead `window` → unhandled rejection. Only reproduced under full-suite load. Fixed with a `useIsMounted()` guard on every post-`await` setter; 5 regression tests in `dashboard/lib/hooks.test.tsx` that simulate teardown by deleting `globalThis.window` (verified failing without the guard). Lesson recorded in `docs/LESSONS_LEARNED.md`.
- [ ] **(Dale)** Verify **reminder delivery stats** in prod. **Unblocked 2026-07-09** — Telnyx creds confirmed, and `TELNYX_PHONE_NUMBER` corrected from the dead `+16308661960` (see P0 §1). Note the stats before that fix were measuring a broken `from` address: fallback-tenant sends were rejected by Telnyx and logged as `status='failed'` in `communications_history`. Expect `sent` now. Check the Failed-only drill-down (`GET /communications/history?status=failed`) and confirm no new failures post-`23:49:38Z`.
- [ ] **(Dale/code)** **Pricing tiers (Pro/Enterprise)** positioning.

### Optional integrations — turn on per business need (code complete, need creds + a live round-trip)

- [ ] **(Dale)** **Google Calendar** — `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL` + GCP OAuth app; prove a real round-trip via `calendarSync.ts` + `SYNC_TEST_RECORDER`.
- [ ] **(Dale)** **Outlook Calendar** — `OUTLOOK_CLIENT_ID/SECRET/CALLBACK_URL` + Azure app.
- [ ] **(Dale)** **Square CRM** — `SQUARE_CLIENT_ID/SECRET/CALLBACK_URL` + `SQUARE_WEBHOOK_SIGNATURE_KEY` + provider OAuth app (code no-ops safely until set).

---

## 🟢 P2 — Quality, scale & ops visibility

- [ ] **(code)** **Volume metering + overage packs** — do after first customer, once real usage data sets the bands. Model DECIDED 2026-07-20 (see §2 Billing): billable = ANSWERED calls only (spoke + ≥15s; spam free), flat tiers + auto-applied fixed-price packs, **NO cap enforcement ever** — calls always answer; only dunning stops service. Build: (1) monthly answered-call counter (query over `voice_sessions`); (2) per-plan quota + pack config; (3) dashboard usage meter + 80%/100%/pack-applied alerts + "bigger plan would have saved you $X" nudge; (4) pack billing via Stripe invoice items on the existing subscription (webhook already wired). ~~soft cap enforcement~~ — explicitly rejected: a capped line is the product breaking its promise.
- [ ] **(code)** **`ai_cost_events` rate map is stale — every call under-reports ~3.5¢** (found 2026-07-20 on a real call): the estimator has no rates for `gpt-4.1-mini` (the voice LLM since 2026-07-20, recorded $0.00 on 39k tokens) or Deepgram Aura TTS (recorded $0.00 on 1,229 chars since the 2026-07-14 TTS switch). Add both rates so the Analytics AI-cost card and any future margin math tell the truth. Quick fix; matters before pricing decisions lean on the dashboard number.
- [ ] **(Dale/code)** _(Optional)_ Repoint Railway `healthcheckPath` → `/ready` to gate deploy **promotion** on DB reachability (behavior change — could block promotion during a DB blip; your call).
- [x] ~~**(Dale)** **Alert rules** — stand up a hosted monitoring destination~~ — **DROPPED 2026-07-09. No vendor meets the "really free forever" bar.** Researched rather than assumed:
  - **UptimeRobot free is not usable here at all** — since 2024-12-01 its ToS restricts the free plan to _personal, non-commercial_ use, explicitly prohibiting revenue-generating applications. SecretaryHQ is a paid SaaS.
  - **Grafana Cloud free** doesn't expire but is capped: 10K active series, 14-day retention, 3 users; $6.50/1K series beyond. Our worst case is 10 metrics × the 1000-series `MAX_LABEL_CARDINALITY` cap = exactly 10K, and `http_request_duration_ms` (~32 route modules × 3 status families × 12 series) realistically lands ~2–3K. It would fit — but "free within limits that the vendor can move" is not free forever.
  - **Healthchecks.io free** is heartbeat/cron monitoring (20 jobs), not metric thresholds.
  - Every "free forever" tier is free-_within-limits_. Paid vendors (Sentry, Better Stack) were already **declined** 2026-07-02; the code keeps its no-op hooks either way.
  - **`docs/ALERTS.md` stays** as a reusable PromQL reference — the rules are collector-agnostic and cost nothing to keep. If a destination is ever chosen, it's paste-and-go.
  - **The one signal actually worth having** — "SMS failure ratio crossed 20%", which would have caught the dead `TELNYX_PHONE_NUMBER` on day one — needs no vendor. See the zero-vendor option below.
- [ ] **(code)** _(Optional, unscheduled)_ **Zero-vendor alert** — a scheduled GitHub Actions workflow that curls `/metrics` with `METRICS_TOKEN`, evaluates the two `sms_sends_total` / `errors_total` thresholds from `ALERTS.md` §3.9, and opens an issue on breach. No account, no series cap, no ToS that bans commercial use. Costs Actions minutes (~720/mo at a 30-min cadence, against 2,000 free on a private repo). Gives alerts, not dashboards — which is the actual need until real call volume exists.
- [ ] **(code)** **Website-scan re-scan scheduler** — periodic re-scan of stale KB. Deferred: needs a `last_scanned` column/migration + is a cost/product call.

---

## 🔵 P3 — Moat & expansion (deferred until a customer asks — build principle: no integrations on spec)

- [ ] **Square CRM deeper reads** — pull open jobs into voice context; real external OAuth + Stripe + live CRM round-trips in CI (recorder-only today).
- [ ] **Extended self-service** — public portal/login (manage all appointments); waitlist / callback-queue tool; no-show auto-marking + auto-rebook.
- [ ] **Voice enhancements** — post-call "how did we do?" SMS/NPS link; multi-language; real-time owner listen-in / barge.
- [ ] **Product expansion** — booking widget/embed; granular RBAC beyond owner/front_desk; white-label / reseller theming; public API; PDF + analytics export (CSV export shipped #189); SSO/SAML; international numbers (US-centric today); multi-DID per tenant.
- [ ] **Schedule sub-view consolidation (C1+C2)** — merge the 4 scheduler sub-views (calendar/staff/resources/list) → 2 (calendar Day/Month + Team/Resources) with one unified header. `dashboard/components/SchedulerView.tsx`. (large/UX; from the former IMPROVEMENT_IDEAS.) **Open — needs a UX design pass with Dale before build** (it changes the scheduler layout; brainstorm the target shape first).
- [ ] **Threaded demo mode (E1)** — replace the static `/demo` page with a session flag (`isDemoMode`) injecting read-only sample data into the live dashboard shell (stays in sync with real UI automatically). (large.)
- [ ] **Future CRM/platform candidates** (build-deferred per the `docs/STRATEGY.md` vendor heuristic — "how does this vendor make money?") — QuickBooks/Xero, Toast, Apple Calendar (safe infra/transaction partners); Microsoft Teams (notify-only); Vagaro/Mindbody, Acuity/Calendly (competitor-ish → shallow read or import-only).

---

## 🎨 UX backlog (separate workstream — `/ux-expert` audits)

- [x] ~~**BUG — Setup tabs don't scroll**~~ (reported by Dale 2026-07-11) — **FIXED 2026-07-11.** `SetupView`'s sub-tab panel was a plain block `<div>` with `overflow-hidden`. Two failures at once: the leaf views written as `flex-1 … overflow-y-auto` (Services, Resources, Employees, Business Settings) only get a bounded height as flex _children_, so under a block parent `flex-1` was inert — they sized to content, their own scrolling never engaged, and the parent clipped the overspill; and the plain-`<div>` views (Billing, Audit Log, Answer Debugger) have no scroll container at all. So no Setup tab scrolled. Fix: `flex-1 flex flex-col min-h-0 overflow-y-auto` (`min-h-0` is load-bearing — without it the default `min-height:auto` re-inflates the box and the clipping returns). Regression test: `dashboard/e2e/setup-tabs-scroll.spec.ts`, verified to fail against the pre-fix build.
- [ ] **(Dale — BLOCKER)** Review live scheduling **coloring/grading** so Cluster A neutral-language work can proceed (de-grade slices were reverted 2026-05-20; do not re-apply unprompted).
- [ ] **Cluster A — neutral-language / no-grading** (8 surfaces, blocked on the Dale review): `StepReview`, `SkillRelationshipMap`/`SkillMapNode`, `ResourceColumnsView`, `AppointmentListView`, `EmployeeDayFocusPanel`, `AnalyticsView`, `AppointmentDetailPanel`. (Violates the "no percentage/letter grading" product rule.)
- [x] ~~**Wizard Phase B**~~ — reversed from "held" and **shipped 2026-07-05/06** (PRs #204–#208): draft-commit `SetupWizard` + `GoLivePanel` + E2E coverage, merged to main, no prod migration needed. Full writeup + lessons in `docs/RESOLVED.md`.
- [ ] **Wizard Phase B follow-ups** (explicitly deferred in the design doc, not bugs): abandoned-test-number reaper (a `phone_status='active'` DID with no `forwarded_from_phone` and no recent `voice_sessions`) — queryable, not built; auto forwarding-verification heuristic (SIP caller-ID match instead of asking the owner) — named, not built; real Telnyx porting API integration — deferred until a real port customer per YAGNI.
- [ ] **Dense-view decomposition** — track, don't piecemeal: `SettingsView`, `TenantEditPanel`, `CRMView`, `AppointmentView`, `DashboardHome`, `CustomerDetailPanel`, scheduler orchestration, `ShiftManagementView`, `ServiceAssignmentView`/`SkillAssignmentsView`/`SkillMatrixView`. Split each overloaded view into focused sub-components (no file over ~300 lines); sequence with C1+C2 to avoid duplicated churn.
  - _First slice DONE 2026-07-05 (PR #201):_ `VoiceCallsView` 1185→711, extracted `components/voice/` (`callFormatters`, `outcome`, `CallRows`, `MessagesInbox` — each <300 lines; also closed a swallowed-failure defect in the inbox).
  - _Second slice DONE 2026-07-06 (PR #211):_ `KnowledgeBaseView` 1143→408 (`components/knowledge/`), `AnalyticsView` 970→265 (`components/analytics/`), `ShiftManagementView` 960→402 (`components/shifts/`), `DashboardHome` 838→318 (`components/home/`), `ServiceAssignmentView` 816→395 (`components/services/`). 874 dashboard tests green.
  - _Third slice DONE 2026-07-06 (PR #212):_ `AppointmentDetailPanel` 605→248 + `CustomerDetailPanel` 606→124 + `CRMView` 719→288 + `useCustomerForm` hook; `AIConfigView` 673→240 + 5 aiconfig sub-components; `BusinessSettingsView` 612→195 + 4 settings sub-components; `TenantEditPanel` 531→255 + 2 admin sub-components; `AppointmentView` 768→300 + `AppointmentCalendar` + `useAppointmentCRUD`; `VoiceCallsView` 711→243 + `CallListPanel` + `CallDetailPanel`; `SchedulerView` 532→253 + `SchedulerToolbar` + `useSchedulerActions`. 874 dashboard tests green. (`CRMView` landed at 288 lines post-decompose — at the limit, no further split needed.)
  - _Fourth slice DONE 2026-07-07 (PR #217):_ `AnalyticsMetricsGrid` 575→69 (+ `CorePerformanceMetrics` / `EngagementRetentionMetrics` / `ServiceCohortMetrics`); `RecordHistoryModal` 636→282 (+ `VersionTimeline` + `FieldRestorePanel` + `recordHistoryHelpers`); `DeletedRecordsPanel` 455→227 (+ `DeletedRecordRow` + `CopyFieldsModal`); `EmployeeManagementView` (+ `EmployeeCard` + `EmployeeEditModal`); `ResourceManagerView` (+ `ResourceCard` + `ResourceEditModal`); `TeamAccessView` 346→232 (+ `InviteTeamMemberModal`); `BusinessTypeSection` 371→269 (+ `TemplatePreviewModal`); `OutlookLayout` 692→465 (+ `layout/TenantSwitcherDropdown` + `ProfileMenuDropdown` + `ThemeSelectorDropdown` + `MobileTabBar`); `CustomerSidebar` 335→301 (+ `crm/CustomerListItem`); `api.ts` namespaced → `Api.{resource}.{action}()`; `ToggleSwitch` shared primitive. 874/874 dashboard + 2324/2324 backend tests green.
  - _Fifth slice DONE 2026-07-07 (PR #218):_ `SkillMatrixView` 334→212 (+ `skills/SkillMatrix`). Also: 55 new dashboard tests for coverage hotspots (ThemeContext, VocabularyContext, TimeInput, logger, Toast, FeedbackButton) — 874→929 dashboard tests.
  - _Coverage batch 2 DONE 2026-07-07 (PR #219):_ 81 new dashboard tests targeting 0%-coverage views — `coverage.ts`, `VersionBadge`, `SkillManagementView`, `BillingView`, `KnowledgeSuggestions`, `MessagesInbox`, `CRMIntegrationCard` — 929→1010 dashboard tests. **Remaining:** `NewSchedulerView` (1582 — do with C1+C2 scheduler consolidation); other over-300 files are unavoidable coordination code (wizard state machines, layout shell, GoLivePanel).

### Un-audited surfaces — `[REVIEW]` before beta

Each screen below has had NO dedicated UX review (owner-judgment items). Most already had a copy/a11y **partial fix** landed 2026-07-03, plus a **correctness/a11y defect batch 2026-07-05 (PR #200)** — swallowed server-failures (Shift/Resource/Employee/SuperAdmin/BusinessSettings handlers), a cross-tenant config-leak in AIConfigView, and dead controls (details in git / RESOLVED). What remains on each is the **owner-judgment layout/flow call**.

- [ ] **[REVIEW]** `AIConfigView` — "Voice Settings"; raw system-prompt ("the Brain") exposed to non-technical owners; dirty-save `warning` variant.
- [ ] **[REVIEW]** `AnalyticsView` — full layout, empty states, date-range controls, metric usefulness; no-show/"abandoned" semantics.
- [ ] **[REVIEW]** `VoiceCallsView` — list layout, transcript/summary rendering (badges/filters/vocab already aligned + a11y done).
- [ ] **[REVIEW]** `AppointmentView` + `AppointmentDetailPanel` + `AppointmentListSidebar` — 3-panel/high-density flow, mobile, status-change communication.
- [ ] **[REVIEW]** `CRMView` + `CustomerDetailPanel` — search UX, how AI call summaries surface.
- [ ] **[REVIEW]** `ProfileView` — password-change discoverability, "My Profile" vs "Business Settings" boundary.
- [ ] **[REVIEW]** `BusinessSettingsView` — what belongs here vs Setup / AI Persona.
- [ ] **[REVIEW]** `SettingsView` — owner vs super-admin split, overlap with BusinessSettingsView.
- [ ] **[REVIEW]** `EmployeeManagementView` — per-card skill-assignment model, deactivated-staff surfacing.
- [ ] **[REVIEW]** `ShiftManagementView` — team-size-conditional paths, copy-week discoverability.
- [ ] **[REVIEW]** `ResourceManagerView` — zero-resource empty state, mapping-checkbox model, "capabilities" meaning.
- [ ] **[REVIEW]** `ServiceAssignmentView` — is the 3-step wizard right, no-assignment case, cancel/exit flow.
- [ ] **[REVIEW]** `SkillMatrixView` + `SkillAssignmentsView` + `SkillRelationshipMap` — grid legibility at scale, does the map earn its keep, both-views-necessary.
- [ ] **[REVIEW]** `DeletedRecordsPanel` + `RecordHistoryModal` — discoverability, restore/copy-fields flow, version-history comprehensibility (copy-target is customers-only today).
- [ ] **[REVIEW]** `/register` — field order, post-signup first-run experience.
- [ ] **[REVIEW]** `LoginView` + `/forgot-password` + `/reset-password` — forgot→email→reset live proof, error-copy quality, mobile.
- [ ] **[REVIEW]** `SuperAdminDashboard` + `TenantCard`/`TenantCreateForm`/`TenantEditPanel` — admin-interface usability / onboarding friction (Dale-facing).
- [ ] **[REVIEW]** `FirstRunTour` — post-wizard overlay tour content/flow/copy (behavior already correct).

---

## 🧹 Doc hygiene (mechanical, ongoing — low priority)

- [ ] Continue count-drift passes (route modules / migrations / test numbers) after any new route or migration; keep secondary docs synced.
- [ ] Trim remaining historical narrative from active docs into `RESOLVED.md` when it goes cold.

---

## 🎙️ Voice — Phase 2 (after live, needs agent code + redeploy)

- [ ] Recording disclaimer → deterministic verbatim greeting (Illinois 2-party consent). Needs a `tenants.greeting` column + tenant-config route + `agent/src/index.ts` greeting line (currently hardcoded).
- [x] ~~`get_my_appointments` transfer-fallback string~~ — DONE 2026-07-05 (PR #198): the no-caller-ID fallbacks in `get_my_appointments`/cancel/reschedule now capability-gate the transfer offer (offer a message only when transfer is unwired).
