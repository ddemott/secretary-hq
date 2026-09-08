# TODO — SecretaryHQ (single backlog)

**This is the one and only backlog.** Consolidated 2026-07-05 from the former
`GAPS.md`, `IMPROVEMENT_IDEAS.md`, `IMPROVEMENTS_TODO.md`, and
`AIASSISTANT_GO_LIVE_TODO.md` (all deleted; their done items + analysis archived
verbatim in `docs/planning/RESOLVED.md` under the 2026-07-05 entry).

Items are ordered by what should be done first. Ownership tags:
`(Dale)` = user/ops action, no code · `(code)` = codeable now · `(blocked)` = waiting on an external gate ·
**untagged** = deferred code work (the P3 / UX / doc-hygiene sections — no per-item owner because nothing there is scheduled).

**Not backlogs (left as reusable procedure/reference, do not fold here):**
`docs/BRANCH_CHECKLIST.md`, `docs/CODING_STANDARDS.md`, `docs/DEPLOYMENT.md`,
`docs/DEVELOPMENT_WORKFLOW.md`, `docs/ALERTS.md`. Completed work + history: `docs/planning/RESOLVED.md`.
Voice/Telnyx go-live ops detail + incident recovery: `docs/RUNBOOK.md` §7.

---

## Next items to fix (coverage/build/deploy review)

- [x] ~~Commit E2E sweep fixes (20 defects, 4 livelocks)~~ — **DONE 2026-08-19**: Merged in PR #344 (`41c4d53`).
- [x] ~~Deploy recent changes to prod (Railway lags)~~ — **DONE 2026-08-19**: Deployed to Railway (`started_at` `2026-08-19T08:22:19Z`). Verified `GET /health` (200) and `POST /demo/start` (200).
- [x] ~~Create PR for main (protected branch)~~ — **DONE 2026-08-19**: PR #344 merged to `main`.
- [x] ~~Clean working tree~~ — **DONE 2026-08-19**: `main` clean.
- [x] ~~Refresh V8 coverage (stale since 05-22, run with DB)~~ — **DONE 2026-08-19**: reran root and dashboard coverage; `docs/TEST_COVERAGE.md` refreshed with exact totals.
- [x] ~~Setup test DB (fix 9 RLS failures)~~ — **DONE 2026-08-19**: `npm test` now passes at repo root (`2750 passed (2750)`), so the prior `app_user` / test_db RLS blocker is gone.
- [x] ~~Sync docs (TEST_COVERAGE, DEPLOYMENT, HANDOFF with current code)~~ — **DONE 2026-08-19**: refreshed counts/coverage/handoff and corrected deployment env wording.
- [x] ~~Test voice naturalness on simulator (inflections, pauses)~~ — **PARTIAL 2026-08-19**: a live browser-simulator call against prod surfaced two real defects. (1) Fixed: `agent/src/checklist/checklistTools.ts` — `job`/`fix_computer` co-selected with `generic_subject` left `generic_subject`'s own "what does this concern?" node open even after the topic was already known, so the caller got asked a second time; now backfilled from `TREE_TOPIC` same as `meeting_topic`. (2) Instrumented, not fixed: no engine-level inflection/pacing control exists (Aura's WS path rejects `?speed=`) and nobody had turn-latency numbers to diagnose "long pauses" from — `agent/src/session/watchdog.ts` now logs `turn_latency_ms` (INFO, WARN at ≥2500ms) on every turn, both the plain-transition and reply-queued-behind-filler paths. Next: pull `turn_latency_ms` from a real prod call (Better Stack) to find where the time actually goes before attempting a fix.
- [x] ~~Pull turn_latency_ms from a real prod call~~ — **DONE 2026-08-19, and it found the instrument was BROKEN.** Pulled `voice_sessions.transcript` + Railway logs for a real post-deploy call (`sim-call-1787158785189`, John Jones / job inquiry, 207s). Two real defects, both fixed on `fix/hiring-for-prefix-and-live-turn-latency`: **(1)** the transcript showed a clean re-ask the caller had to repeat — "Are you hiring for your own company... or placing with a client?" → caller answers plainly → agent asks AGAIN "just to be clear" 8s later. Logs showed why: the model recorded `hiring_for` as `"hiring_for_own_company"` (fused the node_id onto the valid option `own_company`), `tracker.record()` rejected it as an unknown option and the model, instead of silently retrying with the corrected key its own rejection message handed it, re-asked the caller. Fixed in `tracker.ts`'s choice-value check: strip a `${nodeId}_` prefix before rejecting, so this ONE mistake shape is accepted rather than round-tripped through the caller. **(2)** `turn_latency_ms` (shipped a few hours earlier, same day) **never once appeared in the log for this call** — zero occurrences, despite two turns that took 17s and 20s of real dead air per the transcript timestamps. Root cause: it was added inside `attachOutputWatchdog`, which is gated behind `ENABLE_OUTPUT_WATCHDOG`, and **prod runs that flag OFF** (`agent/src/index.ts` line ~1770 says so explicitly — the fact was already documented, just not connected to the new instrumentation before shipping it). Moved the same logging into `attachSilentTurnRecovery`, which is unconditional and the only thing that actually runs on every prod call. Both fixes have unit test coverage (`tracker.test.ts`, `watchdog.test.ts`).
- [x] ~~Set `ENABLE_OUTPUT_WATCHDOG=true` on `secretary-hq-agent`~~ — **DONE 2026-08-28**: Dale confirmed Railway Variables on `secretary-hq-agent` already has `ENABLE_OUTPUT_WATCHDOG=true`. Agent env schema default is also ON (`undefined` → true; only the literal string `false` disables it). The 2026-07-17 / 2026-08-19 "prod runs that flag OFF" finding is historical, not current.
- **OPEN, needs Dale's ear, not mine:** flag is on. Remaining question is whether the filler _sounds_ like cover and not a stutter on a real call (2800ms deadline, `HOLD_LINE`). Place one real test call; keep or set `ENABLE_OUTPUT_WATCHDOG=false`. CI cannot grade this.
- [x] ~~Reminder pipeline totally dead since 2026-08-06~~ — **FOUND AND FIXED 2026-08-19** on `fix/reminder-claim-status-constraint`. The atomic claim from #322 wrote a `status` the CHECK constraint rejected, so every tick threw and **zero reminders or confirmations were sent for 13 days** while the worker reported itself healthy. Migration `20260819000000` + `processReminder` accepting `'sending'` + `releaseStaleClaims()`, guarded by a real-DB regression suite. Full write-up in P0 §4b below and `docs/LESSONS_LEARNED.md`.
- **(Dale) DEPLOY ORDER FOR `20260819000000` — CODE FIRST, THEN THE MIGRATION. This is the REVERSE of the house rule, and the reversal is deliberate.** The standing rule ("prod DB migrations go in ahead of the merge") is right for an ADDITIVE migration that new code will start using. This one is different: prod is ALREADY running code that writes the value the constraint rejects, so widening the constraint changes prod behaviour on its own, with the old code still live.
  - **What applying the migration alone would do:** `origin/main` today writes `status='sending'` in the claim (#322), gates `processReminder` on `!== 'scheduled'`, and has **no** `releaseStaleClaims`. Widen the constraint and the claim starts SUCCEEDING — rows flip to `'sending'`, `processReminder` reads one, sees `'sending'`, returns, and the row is stranded permanently because the claim query only ever selects `'scheduled'` and nothing in prod recovers it. The worker counts each one as processed. That turns today's loud, harmless, total outage (nothing is written at all) into a **silent leak that damages rows** — strictly worse.
  - **Correct sequence:** (1) merge PR #350; (2) confirm the `secretary-hq` backend deploy actually landed (`/health` `started_at` moves — Railway can silently skip, see the SKIPPED-is-terminal note in `CLAUDE.md`); (3) THEN `npm run db:migrate -- "<prod DATABASE_URL>"`. Between (1) and (3) prod behaves exactly as it does today: still broken, still harmless.
  - **Confirm recovery** after step 3: no new `errors_total{event="reminder_batch_failed"}`, `reminder_schedules` rows moving past `'scheduled'`, and nothing accumulating in `'sending'`.
  - **The general lesson:** "migrations before merge" assumes the migration is inert until new code uses it. When the RUNNING code already emits the value a constraint blocks, the constraint is a live behavioural gate and relaxing it deploys a change by itself. Ask which side is already emitting the value before choosing the order.
- Fill real TELNYX_PUBLIC_KEY in .env

## 🔴 Flaky gates that block PROD DEPLOYS (2026-08-20)

A red `main` CI run makes Railway mark that commit's deployments **SKIPPED, and
SKIPPED is terminal** — turning CI green afterwards does not retry. So a flaky
test is not a nuisance here, it is a mechanism that silently stops merged code
from reaching production while every service reports healthy. Both of these
turned `main` red on `2aa61d4`.

> **THE PATTERN MATTERS MORE THAN ANY ONE OF THESE.** Three _different_ tests
> turned CI red on 2026-08-20 — `purge-soft-deleted` (timeout mismatch),
> `customer-preferences-config` (E2E, cause unproven), and
> `SetupWizard > shows success state with phone number after activation`
> (dashboard, passes locally, 1,115 ms under CI load). Only the first had a
> diagnosed cause. In a repo where a red `main` makes Railway skip the deploy
> **terminally**, CI flakiness is not a test-hygiene issue — it is an
> availability issue for shipping. If a fourth appears, stop adding features and
> treat runner contention as the bug: the common factor in all three is a
> wall-clock expectation meeting a loaded runner.

- [x] **`scripts/purge-soft-deleted.test.ts` — two timeouts that disagreed.** The
      harness gives its subprocess a 60s budget (`spawnSync timeout: 60_000`)
      while vitest's default test timeout is 5s, and the shorter one was arrived
      at by accident. Every case spawns `npx tsx`, paying npx resolution plus a
      TypeScript compile before the script runs — seconds, not milliseconds. On a
      loaded runner the happy-path case took **5,862 ms** and vitest killed it at
      5,000. All five cases now carry an explicit `SUBPROCESS_TEST_TIMEOUT_MS`
      matched to the subprocess budget, so a genuine hang is reported by
      `spawnSync` with its exit status and output rather than by vitest with a
      bare "timed out". Same class as the `PERF_ASSERT` fix: **the test was
      asserting the machine's speed, not the code's behaviour.**
- [x] **THE FOURTH ONE ARRIVED (2026-09-03), and it is the same shape.**
      `tests/services/deadlock-prevention.test.ts > clearDB truncates all tables
    in a single statement` timed out on PR #394's Backend job at **5,004 ms
      against vitest's default 5,000 ms budget** — a four-millisecond miss on a
      test that does a real `TRUNCATE ... CASCADE` over every seeded table. It
      passes locally in ~3 s and had never failed before. The prediction in the
      box above was correct: the common factor is a wall-clock expectation
      meeting a loaded runner, and nothing about the code changed.
      Fixed the way the other two were — an explicit
      `TRUNCATE_TEST_TIMEOUT_MS = 30_000` matched to the DATABASE work, with the
      assertions untouched (one statement, no deadlock, table empty). A genuine
      deadlock still hangs and still fails; the timeout now means "the DB never
      answered" rather than "the runner was busy".
      **Standing verdict, now with four data points: any test that asserts real
      I/O under vitest's 5 s default is a deploy outage waiting for a busy
      runner.** The next one gets a budget at the time it is written, not after
      it reddens `main`.
- [x] ~~**Dashboard flake, not yet diagnosed** — `SetupWizard.test.tsx > shows success state with phone number after activation`~~ — **FIXED 2026-09-03, PR #391 (`2ab4363`, T-007). This entry had gone stale — it sat unmarked for two weeks after its own fix shipped.** Root cause: Testing Library's `waitFor` defaults to a 1000ms ceiling; CI run `33249344101` (2026-08-29) failed at 1110ms because the runner was slow, not because the component was wrong. Fixed once, centrally, with `configure({ asyncUtilTimeout })` in `dashboard/vitest.setup.ts` (a ceiling that threatened every async dashboard test, not just this one). Acceptance was 20/20 local runs. **Re-verified here 2026-09-08**: `npx vitest run components/SetupWizard.test.tsx -t "shows success state with phone number after activation"` → 1 passed.
- [x] ~~**`customer-preferences-config.spec.ts` — root cause NOT yet proven.**~~ — **FIXED 2026-09-03, same PR #391 (`2ab4363`, T-007) as the item above. Also stale.** Root cause was NOT timing: a wrong-tenant-row bug. `useActiveTenantId()` falls back to `useSuperAdminTenants`'s auto-selected `tenantsArray[0]` when a super-admin session has no `managedTenantId` yet, and the spec's save landed on tenant `d5e3c6a1…` (Thinking Hammer) while its reset/assert targeted `00000000…` (platform) — which was still NULL, read as "textarea comes back empty." The unqualified `UPDATE tenants SET … ` (no WHERE clause) in `afterAll` masked this by also clearing the real row. Fixed with a shared `dashboard/e2e/helpers/aiPersona.ts`: pins the managed tenant via `addInitScript` before navigation, asserts the config GET was for the pinned tenant, waits on the `update-config` POST response instead of the "Saved!" label, and scopes both specs' resets to `WHERE tenant_id = $1`. Acceptance was 201/201 Playwright runs at `--repeat-each 20`. **Re-verified here 2026-09-08**: `npx playwright test e2e/customer-preferences-config.spec.ts` → 2 passed.

---

## 📞 Live-call fix series (2026-07-30) — see `docs/CALL_FIX_PLAN.md`

The 12 real calls from 2026-07-26/27 (`CALL_IMPROVEMENTS.md`, root) produced an
8-batch PR plan: **G** (job-call capture completeness — role_description dropped
end-to-end, outcome mislabel, false "message" promise, stall detector, offer-meeting
on the live path) → **H** (per-call tool-call log + transcript fidelity) → **A**
(caller context/appointments reach the model) + **B** (booking mechanics, timezone,
cross-call duplicates, roster) → **C** (availability reason codes) → **D**
(corrections propagate) → **E** (junk "Caller" rows, urgency) → **F** (silence
handling, greeting metric, inbox unification). Full detail, cut lines, and the four
recurring failure classes: `docs/CALL_FIX_PLAN.md`.

---

## 📞 Live-call fix series (2026-08-13) — see `CALL1.md` / `CALL2.md`

Two real calls from the same caller (`+1 262-497-9039`, Camille), three minutes apart,
on tenant Thinking Hammer: `SCL_3a8SkDKzxN4B` (19:46 CT, message) and
`SCL_KLvqZ2JkaQFU` (19:49 CT, booked). Both were recruiting calls. Both wrote **zero**
`job_inquiries` rows. Full transcripts, persisted tool traces, and per-finding evidence
in `CALL1.md` / `CALL2.md` at repo root.

**Root cause, one line:** `job` sat in `forbidden_trees` on all three presets while
`ChecklistOverrides` could only SUBTRACT blocks — so **no configuration of any tenant
could select the job tree.** On CALL1 the model read the caller correctly, declared
`work_direction: caller_offers_owner_work`, and re-issued `set_purpose` to add `job`
16 ms later; the host answered `No tree called "job"`. `capture_job_inquiry` never
entered the toolset, the goodbye gate never saw the tree, and the call closed clean.

**Shipped on `fix/job-tree-unreachable` and related (all green). See RESOLVED.md for full details, transcripts, root causes (forbidden_trees, unreachable job tree, phantom bookings, stall detectors).**

**Still open from these calls:**

- [ ] **(Dale)** Run `scripts/pin-owner-for-hire-preset.sql` against prod after deploy,
      then place a test call and confirm a `job_inquiries` row lands.
- [ ] **(Dale)** Read the first `greeting_spoken` `ms_since_participant` values off
      prod. Both calls showed the greeting at `[0:17]` on the transcript clock, which is
      NOT the caller's clock — nothing is worth optimizing until the real number is in.
      **MEASURE before fixing.**
- [ ] **Re-price the tiers** once the cost ledger has a few honest calls in it. P0 §2
      below is being decided against numbers that were ~35× too low. CALL2 really cost
      about **$0.068** for 96 seconds, dominated by **137,971 input tokens** —
      ~17k/turn, the checklist state block plus tool schemas resent every turn. That
      per-turn context is the product's whole cost curve and is now visible for the
      first time.
- [ ] **Do NOT "fix" the service semantic match by prefixing the query.** Measured and
      rejected 2026-08-13 (`scripts/probe-service-match.mjs`): `"a meeting about …"`
      lifts every score by roughly a constant, so `"four-wheel alignment"` (0.1739 →
      0.3571) clears the 0.35 threshold onto Programming Consultation. It defeats the
      threshold instead of improving discrimination — a confident wrong booking in place
      of a safe fallback. Recorded here because it looks like an obvious win.

---

## 🔬 E2E observation sweep (2026-08-15) — all 20 defects + 4 livelocks fixed. Sim suites 100%. See RESOLVED.md for detailed postmortems and the fixes (booking guard, refusal diagnosis, phantom bookings, stall detectors, backfill, placeholder names, filler repetition, etc.). All [x] shipped, sim-questiontree 22/22, agent suite green.

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
  - **Variable cost per call (5-min avg):** Telnyx ~$0.03 + LiveKit ~$0.02–0.05 + Deepgram STT $0.02 + OpenAI LLM ~$0.001 + TTS ~$0.02–0.09 = **~$0.09–0.17/call**
    - ⚠️ **Stale input (flagged 2026-07-28):** the TTS figure is OpenAI's, and TTS moved to **Deepgram Aura** on 2026-07-14. The LLM also moved 4o-mini → **4.1-mini**. Both legs need re-pricing from current provider rates before this model is used to set a price — deliberately NOT guessed here.
  - **Loss point:** an uncapped Solo tier at 1,000 calls costs $90–170 in variable cost alone — near-zero or negative margin at $129/mo
  - **Recommended Solo cap: ~300–400 calls/month** → variable cost ~$27–51, gross margin ~$78–102 on $129/mo
  - **Competitor benchmarks (verified July 2026):** Rosie AI $49/$149/$299 (250/1,000/2,000 min); Goodcall $79/$129/$249/agent (100/250/500 unique customers/mo); Signpost $199/$399/$749 (AI-only → hybrid human+AI)
  - **Key differentiator to keep:** include booking + call transfer at ALL tiers — competitors (Rosie, Goodcall) gate these to mid-tier. Lead with "full receptionist from day one."
  - **Suggested tier shape:** Solo ~$99–129/mo (1 location, ~300 calls/mo cap, full booking+transfer) · Growth ~$199–249/mo (multi-location or higher volume, Square CRM sync, analytics) · Pro ~$349+/mo (unlimited volume, priority support)
  - **Volume metering is NOT built yet** — tiers are flat subscriptions today; cap enforcement + usage meter is a P1 build item (see P2 section below). Go flat-rate for first customer, retrofit volume once real usage data exists.
- [ ] **(Dale)** **Stripe setup — part A: test-mode wiring. NO BANK ACCOUNT NEEDED.** A bank account gates **payouts**, not API configuration; every step below works today on the `sk_test` key prod already carries. Test mode has its own separate keys and webhook endpoints, so none of this touches live money. Only the pricing decision above is a real prerequisite (price IDs get baked into env vars).
  1. **Create products + prices** in Stripe **test mode** — Solo, Growth, Pro. Note the 3 price IDs.
  2. **Register the webhook endpoint** in the Stripe dashboard **while it is in TEST MODE** (the toggle top-left — test and live endpoints are separate objects with separate signing secrets): `https://secretary-hq-production.up.railway.app/billing/webhook`, 3 events: `checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted`. Copy the endpoint's signing secret (`whsec_…`) shown after creation.
     - **Status 2026-08-04: NOT registered.** Probed the live account directly — `webhook_endpoints` returns **zero** endpoints, and prod's `STRIPE_SECRET_KEY` is an `sk_test` key. CLAUDE.md's Production section states this URL as if it were wired; it is not. Nothing has ever delivered to it.
  3. **Set 5 env vars on Railway**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (**the `whsec_` from step 2**), `STRIPE_SOLO_PRICE_ID`, `STRIPE_GROWTH_PRICE_ID`, `STRIPE_PRO_PRICE_ID`.
  4. **Test-mode round-trip** (no real money): trigger a test checkout and verify each event activates/revokes the tenant gate. Events arrive at prod from the endpoint registered in step 2 — nothing else to run. (`./scripts/simulate.sh stripe` path-checks the wiring first.)
     - **`STRIPE_WEBHOOK_SECRET` must match whichever path actually delivers, and there is exactly one signing secret in play at a time.** A registered dashboard endpoint signs with ITS `whsec_`; `stripe listen` signs with a DIFFERENT `whsec_` that the CLI mints per session and prints on startup. Point both at prod with one secret configured and every event down the other path fails signature verification with a 400 — which reads like broken webhook code and is not.
     - **`stripe listen` is an OPTIONAL, LOCAL-ONLY alternative** — use it to exercise the handler against a backend on your own machine, never alongside the registered prod endpoint: `stripe listen --forward-to http://localhost:4001/billing/webhook`, then set `STRIPE_WEBHOOK_SECRET` **locally** to the `whsec_` the CLI prints. Do not forward the CLI at the production URL; prod would receive each event twice, and the copy signed with the CLI's secret would 400.
- [ ] **(Dale)** **Stripe setup — part B: live mode. THIS is what needs the bank account.** Do only after part A's round-trip passes.
  1. **Open an LLC bank account** for Thinking Hammer LLC — required before Stripe can pay out. (Also listed under Legal §5 below.)
  2. **Connect bank account to Stripe** — Stripe dashboard → Settings → Bank accounts & scheduling.
  3. **Re-create products + prices in LIVE mode** — test-mode objects do not carry over. New price IDs.
  4. **Register the webhook again in LIVE mode**, same URL and same 3 events, and copy the new `whsec_`. Live-mode endpoints are separate objects from test-mode ones and sign with their own secret — this must come BEFORE the env swap, because the secret does not exist until the endpoint does.
  5. **Swap the 5 Railway env vars to live values** — live secret key, live price IDs, and the **new** `STRIPE_WEBHOOK_SECRET` from step 4. The moment this lands, the test-mode endpoint's events start failing signature verification; that is expected, and it is why part A must be finished first.
- [ ] **(Dale)** **Stripe Tax** (after round-trip verified): enable Stripe Tax in Stripe dashboard → Tax → Settings; register nexus for IL + customer states; set `STRIPE_AUTO_TAX=true` on Railway. (Code done — `automatic_tax` gated behind the flag.)

### 3. Deploy gate — protect main

- [x] ~~**(Dale)** Enable the **"Wait for CI"** toggle on the 3 Railway services~~ — **DONE 2026-07-09.** Enabled on all 3 (`secretary-hq`, `secretary-hq-agent`, `dashboard`) at Railway → Service → Settings → Source → "Wait for CI" ("Trigger deployments after all GitHub actions have completed successfully"). Railway stages settings edits — they only take effect after clicking **Deploy** on the "Apply N changes" banner. The Railway GitHub App already held `checks` + `commit statuses` read/write on all repos, so no permission grant was needed.
  - **Caveat:** this is **unversioned dashboard state** — `railway.json` has no field for it. If a service is ever recreated the toggle silently reverts, and nothing in the repo will tell you. Re-check after any service recreation.
  - **Caveat:** the setting waits on _all_ GitHub Actions on the commit, not on the branch-protection required-checks list. Any future workflow that runs on `main` and can fail will also block deploys.
- [x] ~~**(Dale, code)** **Prove the gate** end-to-end~~ — **PROVEN 2026-07-09 (PR #227).** A deliberately-failing test made `Backend` red → `mergeStateStatus: BLOCKED` → `gh pr merge` **refused** with `the base branch policy prohibits the merge`. Deleting the test flipped all 4 checks green → `CLEAN` → merge allowed. Branch protection holds.
  - **Not tested, deliberately:** `gh pr merge --admin`. If `enforce_admins` didn't hold, that would merge a failing test to `main` and deploy broken code to Railway. The API reports `enforce_admins: true` — verified-by-config, not by experiment.
  - **This proves the MERGE gate only.** The **deploy** gate is still open: after #226 merged, Railway brought up the new backend at `19:27:03Z` while CI didn't go green until `19:31:27Z` — prod deployed ~4 min _ahead_ of its checks. That is exactly what the "Wait for CI" toggle above closes. Branch protection stops a red PR from merging; nothing yet stops a merged commit from deploying before CI confirms it.

### 4. Security housekeeping

- [ ] **(Dale)** **Rotate the Railway team token** created 2026-06-12 — it was pasted into a Claude session. Burn + reissue.
- [ ] **(Dale)** **Rotate the Supabase DB password** — exposed in a session transcript 2026-07-11.

### 4b. Code review 2026-07-13 — four-reviewer sweep (backend, security, reliability, dead code)

**All items resolved — moved to `docs/planning/RESOLVED.md` 2026-09-08 (doc-hygiene
trim; content dated 2026-07-13, re-verified 2026-08-21) — every entry was `[x]`,
nothing left open.** Covered: self-service SMS
token type confusion, OTP gate coverage gaps, `find-customer-by-name` enumeration,
reminder retry/metrics/SIGTERM-drain, schedule-extender far-future-shift poisoning,
alternatives-search duration mismatch, `'Caller'` placeholder, `purge-soft-deleted`
`--older-than` NaN, `/metrics` timing-safe compare, `GET /templates/full` column
leak, `isTenantExempt` (no-op rewrite), and the dead-code sweep (orphaned reminder
implementation, n8n webhook trigger, `shared/dateTime.ts`, `TelephonyProvider`
Twilio residue, self-managed migration transactions, inert columns).

### 5. Legal / business (long lead time — start early)

- [ ] **(Dale)** Open an **LLC bank account** for Thinking Hammer LLC (required before Stripe payouts).
- [x] ~~**(Dale)** Publish + link **legal docs**~~ — **SHIPPED 2026-08-14.** Public `/privacy`, `/terms`, `/dpa`. Terms = Bonterms Standard Online Cloud Terms v1.0 by reference + Provider-Specific Terms. DPA = Bonterms DPA v2.0 cover + subprocessors. Privacy = ICO-style notice + product call-handling language. Footer + register checkbox link all three. Not a lawyer review.
- [ ] **(Dale)** Add **TCPA-compliant SMS opt-in** consent language at booking time — required before any confirmation texts.
- [ ] **(Dale)** **E&O insurance** before the first paying customer (~$800–1,200/yr; Next/Hiscox).
- [ ] **(Dale)** **Cyber Liability insurance** before the first paying customer (often bundled with E&O).

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

- [ ] **(code)** **Volume metering + tier cap enforcement** — do after first customer, once real usage data sets the bands. Data already exists (`voice_sessions` per tenant per month). Build: (1) monthly call counter endpoint; (2) per-plan limit config (Solo ~300–400 calls, Growth ~1,000, Pro unlimited); (3) dashboard usage meter + 80% warning banner; (4) soft cap enforcement. No Stripe Metered Billing needed — flat bands with a DB query. See pricing notes in §2 Billing above.
- [ ] **(Dale/code)** _(Optional)_ Repoint Railway `healthcheckPath` → `/ready` to gate deploy **promotion** on DB reachability (behavior change — could block promotion during a DB blip; your call).
- [x] ~~**(Dale)** **Alert rules** — stand up a hosted monitoring destination~~ — **DROPPED 2026-07-09. No vendor meets the "really free forever" bar.** Researched rather than assumed:
  - **UptimeRobot free is not usable here at all** — since 2024-12-01 its ToS restricts the free plan to _personal, non-commercial_ use, explicitly prohibiting revenue-generating applications. SecretaryHQ is a paid SaaS.
  - **Grafana Cloud free** doesn't expire but is capped: 10K active series, 14-day retention, 3 users; $6.50/1K series beyond. Our worst case is 10 metrics × the 1000-series `MAX_LABEL_CARDINALITY` cap = exactly 10K, and `http_request_duration_ms` (~32 route modules × 3 status families × 12 series) realistically lands ~2–3K. It would fit — but "free within limits that the vendor can move" is not free forever.
  - **Healthchecks.io free** is heartbeat/cron monitoring (20 jobs), not metric thresholds.
  - Every "free forever" tier is free-_within-limits_. Paid vendors (Sentry, Better Stack) were already **declined** 2026-07-02; the code keeps its no-op hooks either way.
  - **`docs/ALERTS.md` stays** as a reusable PromQL reference — the rules are collector-agnostic and cost nothing to keep. If a destination is ever chosen, it's paste-and-go.
  - **The one signal actually worth having** — "SMS failure ratio crossed 20%", which would have caught the dead `TELNYX_PHONE_NUMBER` on day one — needs no vendor. See the zero-vendor option below.
- [x] ~~**(code)** _(Optional, unscheduled)_ **Zero-vendor alert**~~ — **DONE 2026-08-28.**
      `.github/workflows/zero-vendor-alerts.yml` every 30m curls prod `/metrics` with
      `METRICS_TOKEN`, `scripts/zeroVendorAlerts.ts` evaluates ALERTS.md §3.9 on the
      boot-lifetime counters (`rate()` needs two scrapes; a dead from-number pins
      the ratio at 1.0). Opens or comments one `[zero-vendor]` issue. Unset token
      is SKIP, not a page. Pin: `tests/scripts/zeroVendorAlerts.test.ts` (5).
- [ ] **(code)** **Website-scan re-scan scheduler** — periodic re-scan of stale KB. Deferred: needs a `last_scanned` column/migration + is a cost/product call.

### Structural refactors (folded in from root `07_11_2026_IMPROVEMENTS.md`, 2026-07-28 — that file is deleted; it duplicated this backlog and sat in the root, which by CLAUDE.md holds only CLAUDE.md / README.md / workflow.config.json / DEMO_SECTION.md)

Each status re-verified against the code on 2026-07-28, not carried over on trust. Item 1 of the original nine (**split `agentTools.ts` into a domain module**) is **DONE** — `src/routes/agentTools/` is a directory of 8 modules.

- [x] ~~**(code)** **Move test files out of `src/` into a parallel `tests/` tree**~~ — **DONE 2026-08-21.** The entry said "still mixed"; the actual remainder was **exactly one file**, `src/services/phoneLoopGuard.test.ts`. It is now `tests/shared/transferLoopGuard.test.ts`, renamed for what it covers — it exercises `isTransferLoop`/`canTransfer` in `shared/phone` directly, not the backend alias. `find src -name '*.test.ts'` returns **0**. Worth knowing it is NOT a duplicate of `tests/services/phoneLoopGuard.test.ts`: that sibling pins the alias `phonesWouldLoop`, so it is the one that would catch the re-export being broken or dropped. Two entry points, one implementation.
- [x] ~~**(code)** **Extract `src/routes/knowledge.ts` into services**~~ — **DONE 2026-08-21** (PR #367). **1,092 → 649 lines**, six modules under `src/services/knowledge/`: `siteScrape` (fetch + prose extraction + LLM Q&A), `ingestChunks` (normalize → embed → cost → insert), `suggestionReview` (transactional approve / reject), `answerExplainer` (the RAG debugger), `importStaging` (what the website scan and document upload were doing in two copies), `retrievalParams` + `tokenEstimate` (shared constants). Largest remaining handler is 120 lines. **Tests came first, as their own commit:** coverage **74.77% → 83.18% lines**, adding the untested CRUD surface — two of those are SECURITY assertions (a list that lost its tenant filter shows one business another's policies; a `DELETE` keyed on id alone lets any owner destroy another tenant's entries by guessing a UUID) — plus the **AI-cost path**, which had no coverage at all because every existing case runs with `KNOWLEDGE_IMPORT_E2E_STUB=1`. Shape quirks pinned not harmonized: `GET /knowledge` returns a bare array, `GET /knowledge/unanswered` a `{success, questions}` envelope. **The extraction found three defects that were invisible while the code was duplicated, each fixed in its own commit after the pure move:** (1) `/knowledge/explain` scored at threshold **0.5 while production answers at 0.30**, and embedded the NORMALIZED question while production embeds the EXPANDED one — so the debugger reported `would_answer: false` across the entire 0.30–0.5 band the lowering existed to capture, and an owner's rational response to "your KB can't answer this" is to write content that already worked. `expandQueryForEmbedding` was never even passed to `registerKnowledgeRoutes`. (2) `/knowledge/add` and `PUT /knowledge/:id` filed embedding spend under **`source: 'policy-questionnaire'`** — a `tenant_docs` PROVENANCE value written into a spend-CATEGORY column, in no reader's vocabulary (`aiCost.ts`, `agentTools/schemas.ts`'s `z.enum`, the migration comment), splitting one activity across two rows of the owner's breakdown. Not backfilled. (3) The embedding price was stated in **three** modules under "Mirrors aiCost PRICING" — the same comment-as-sync-mechanism that produced (1) — when `recordAiCostEvent` already prices from the authoritative table. `services/knowledge` now holds no price at all. **The file-level `eslint-disable` on line 1 is deleted**: all six `any` uses lived in the extracted handlers, and the four warnings that surfaced were typed rather than re-suppressed.
- [x] ~~**(code)** **`estimateCost` silently bills $0 for any model missing from `PRICING`**~~ — **DONE 2026-08-21** on `fix/aicost-unpriced-model`. `estimateCost` still returns 0 (fire-and-forget ingest must not throw) but now bumps `errors_total{event="ai_cost_model_unpriced"}` and logs the model when the name is not in `PRICING`, is not nova/aura audio, and usage > 0. Event name matches the existing voice-route warn (`ai_cost_model_unpriced`), not the `ai_cost_unpriced_model` spelling this item first used — one string, one alert. Priced model + zero tokens stays quiet. Red-green: the new assertion failed `expected +0 to be 1` before the impl. `npx vitest run tests/services/aiCost.test.ts tests/routes/agentTools/agentToolsAiCost.test.ts --run` → `26 passed (26)`.
- [x] ~~**(code)** **Website scan fetches owner-supplied URLs with no scheme/host guard**~~ — **DONE 2026-08-28.** `assertSafeSiteFetchUrl` in `siteScrape.ts` allowlists http/https, refuses loopback/private/link-local literals (incl. `169.254.169.254` and Node-canonicalized `http://2130706433`), and refuses hostnames whose DNS lookup returns a blocked address. Crawl uses `redirect: 'manual'` and re-gates `Location` so a public 302 cannot hop onto metadata. Red-green: `fetchAndExtractSiteText('http://169.254.169.254/latest/meta-data/')` called `fetch` once before the guard, zero times after. `npx vitest run tests/services/knowledge/siteScrapeUrlGuard.test.ts tests/routes/knowledge.importWebsite.test.ts --run` → `15 passed (15)`.
- [x] ~~**(code)** **Extract `src/routes/analytics.ts` into services**~~ — **DONE 2026-08-21.** **880 → 430 lines**, five modules under `src/services/analytics/`: `dateBounds` (shared date validation + coverage schema/row type), `aiCost`, `coveragePreview`, `cohorts`, `utilization`. Routes now resolve the tenant, validate, call, and send. **The coverage work is what made it safe, and it came first:** the existing suite covered 2 of 9 route paths, so characterization tests were written against the CURRENT code — **78.86% → 100% lines** — and the same 43 tests stayed green after every extraction step, which is the whole proof that behaviour did not change. `POST /coverage/dry-run` was wholly uncovered and is the only analytics route that WRITES (insert draft graph → measure → roll back); two tests now pin ROLLBACK on the happy path AND on a throw, because the rollback lives in a `finally` and without it a failed preview would leak services and staff into the tenant's real data. Behaviour quirks were **pinned, not fixed** — `/call-summaries` and `/coverage` return bare arrays while `/analytics/utilization` returns `{ cells }` — since changing behaviour under cover of a refactor is how a refactor becomes an outage. Final: 100% lines / 100% functions across route + all five services; backend 2840 green.
- [x] ~~**(code)** **Group agent tool definitions by capability**~~ — **DONE 2026-08-28** with the reachability audit. `agent/src/tools.ts` is a 12-line barrel. Definitions live under `agent/src/tools/` by capability (`knowledge` / `messaging` / `identity` / `scheduling` / `verification` / `transfer` / `sms`) plus `helpers.ts`, `types.ts` (`CAPABILITY_OF`), `buildTools.ts`. Public `buildTools` API unchanged. Agent `968 passed (968)`.
- [x] ~~**(code)** **Reconcile `tools.ts` against what the model can actually reach**~~ — **DONE 2026-08-28.** Nothing deleted. `DEFINED_UNREACHABLE_ON_QUESTION_TREE` parks the ladder routers, superseded scheduling tools, SMS-gated tools, host-only `identify_caller`, `get_company_policy_answer` (model sees `answer_question`), and the four previously-undecided tools as KEEP-UNWIRED (`transfer_call`, `page_owner_via_sms`, `save_customer_preference`, `get_detailed_customer_history`, plus `find_caller_by_name` still excluded for enumeration). Guard: `agent/src/tools/reachability.test.ts` — every `buildTools` name is either a tree action/passthrough or explicitly parked. `npx vitest run src/tools/reachability.test.ts src/tools.test.ts src/tools/wrapTool.test.ts --run` → `103 passed (103)`.
- [x] ~~**(code)** **Dedupe `src/services/phoneUtils.ts` / `nameUtils.ts` against `shared/`**~~ — **ALREADY DONE; entry was misleading (verified 2026-08-21).** Both files exist, but neither contains an implementation — each is a one-line re-export (`export { normalizePhone, isValidPhone, formatPhone } from '../../shared/phone'`, and the same shape for `shared/name`). Same for `phoneLoopGuard.ts`. So there is exactly ONE implementation of each helper and nothing to dedupe; the entry's "both still exist" was true and its implication was not. Collapsing the ~9 importers onto the `shared/` path and deleting the shims is optional cosmetics, not deduplication — the shims' own comments say they are kept as the name the backend already imports.
- [ ] **(code)** **Finish the dashboard component subdirectory migration** — **35** loose `.tsx` files at `dashboard/components/` (count 2026-09-05; subdirs: appointments, knowledge, analytics, scheduler, voice, shifts, aiconfig, admin, billing, business, communications, crm, employees, home, layout, legal, phone, records, resources, services, settings, skill-map, skills, team, ui, auth, vocabulary-guard.test.ts, SetupWizard). Remaining: move test files to parallel test structure or keep in ui/ if shared primitives.
- [x] ~~**(code)** **Dead CRM schema cleanup**~~ — **DONE 2026-08-21**, migration `20260821020000_drop_dead_crm_providers`. The remainder was smaller and sharper than the entry implied: **two CHECK constraints**, `entity_sync_map_provider_check` and `tenant_integration_settings_provider_check`, both still enumerating `jobber`/`hubspot`/`servicetitan` alongside `square`. Every TypeScript hit for those names is a comment or a test documenting the 2026-06-12 removal. **Checked against prod first: both tables hold ZERO rows**, so narrowing cannot reject existing data. A constraint is a statement about what the system supports — leaving three dead providers in it says the product can sync Jobber, and nothing in the schema tells the reader that is false. `grep -icE 'jobber|hubspot|servicetitan|gohighlevel' supabase/baseline.sql` is now **0**.
- [ ] **(code)** **Migration chain squash** — **192** files in `supabase/migrations/`. Do when convenient; `baseline.sql` already carries the collapsed schema.

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
- [x] ~~**Wizard Phase B**~~ — reversed from "held" and **shipped 2026-07-05/06** (PRs #204–#208): draft-commit `SetupWizard` + `GoLivePanel` + E2E coverage, merged to main, no prod migration needed. Full writeup + lessons in `docs/planning/RESOLVED.md`.
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

- [ ] Continue count-drift passes (route modules / migrations / test numbers) after any new route or migration; keep secondary docs synced. **2026-09-08 pass:** routes **32**; `supabase/migrations/` **192**; dashboard loose `.tsx` at `components/` is **38** (drifted back up from the **35** counted 2026-09-05 — new components landed since; open PR #402 `fix/test-db-bootstrap` already does a further round of the subdirectory migration, unmerged as of this pass).
- [ ] Trim remaining historical narrative from active docs into `planning/RESOLVED.md` when it goes cold.

---

## 🎙️ Voice — Phase 2 (after live, needs agent code + redeploy)

### Question-tree call review — 2026-07-21 07:34 call (branch `feat/question-tree-architecture`, room sim-call-1784637271290)

The call succeeded end-to-end (booked 4:30 PM ✓ linked job_inquiries.appointment_id ✓ semantic service match ✓ E.164 phone ✓ "Dale" not "Dale DeMott" ✓ no snake_case spoken ✓) — these are the conversation-layer snags it still had:

- [x] ~~**(code) Double read-back of the dictated number.**~~ — **ALREADY DONE; entry was stale (verified 2026-08-21).** The directive is conditional and the ordering was inverted so it cannot fire twice: `trees.ts` now tells the model to `record_answer` the number IMMEDIATELY and NOT read it back first, because _"the recording result hands you the exact read-back to speak (one read-back, one yes)"_; `checklistAgent.ts` states the invariant — _"read back exactly once — never skipped … and never twice"_. **The sim grader this entry asked for exists too**: `sim-questiontree.ts` counts agent read-back lines and requires exactly 1, with a comment naming _"the double read-back the unconditional host directive caused (call 7)"_.
- [x] ~~**(code) Redundant "What is the meeting about?" — third strike.**~~ — **ALREADY DONE; entry was stale (verified 2026-08-21).** Promoted to host exactly as prescribed: `checklistTools.ts` backfills `meeting_topic` from `TREE_TOPIC` (`job` → "a job opportunity", `fix_computer` → "a computer repair") whenever `booking` is selected alongside a subject tree, with the same treatment for `subject_details` when `generic_subject` rides along. Comment cites _"the third re-ask on a live call"_ and _"the promotion ladder"_. Covered by three tests in `checklistTools.test.ts`, **and the grader this entry asked for exists** — `sim-questiontree.ts` fails a run that _"asked for the topic the opener already gave"_.
- [x] ~~**(code) Silent-turn recovery fires during close.**~~ — **ALREADY FIXED; entry was stale (verified 2026-08-21).** `watchdog.ts` guards the nudge on `session.closing` before attempting `generateReply`, with a comment citing this exact 2026-07-21 hang-up, and `watchdog.test.ts` sets `closing = true` and asserts the nudge stands down. Re-checked because the new outage-voice path adds a SECOND way for the session to be closing mid-turn, and it lands on the same guard.
- [x] ~~**(code, polish) `set_purpose` passed `caller_name: ""`.**~~ — **ALREADY DONE; entry was stale (verified 2026-08-21).** `checklistTools.test.ts` carries exactly the pin this asked for — _"PIN: an empty volunteered caller_name never records (set_purpose passed "" live)"_ — passing `caller_name: ''` and asserting the node stays `open` so the real name is still asked.
- [x] ~~**(polish) Salary stored verbatim as words**~~ — **DONE 2026-08-28.** Capture stays verbatim. Inbox Rate row and job-inquiry email bits use `formatPayRangeDisplay` (`shared/payRange.ts`): "one forty to one hundred and sixty thousand" → `$140–160k (…words…)`. Unparseable copy (`competitive`) is unchanged.
- [x] ~~**(polish) Wrap-up turn is 12s long**~~ — **DONE 2026-08-28.** Ending block in `checklistAgent.ts` now forbids stacking passed-along + email + "anything else" in one turn. Email stays its own node. COMPLETE wrap-up is only "Anything else I can help you with?" then `finish_call`. Pinned in `checklistAgent.test.ts`.

- [x] ~~**(code) OUTAGE VOICE — a caller must never get silence when the LLM is down.**~~ — **DONE 2026-08-21.** New `agent/src/session/outageGuard.ts` + `OUTAGE_LINE` in `holdLines.ts`. On the **2nd consecutive** `AgentSession` error with no successful speech in between, the agent plays a **pre-synthesized, cache-only** line — "I'm having some technical trouble on my end. Please try calling back in a few minutes" — and closes the call. **The line deliberately routes around the model**, which is the whole lesson of the 2026-07-21 08:56 call: every other recovery path here IS a `generateReply` or a live TTS round trip, so when the LLM is the thing that is down they all die of the same cause and the caller gets seven consecutive errors' worth of silence. Design notes: 2 not 1 (a single transient error is survivable and tripping at one would end salvageable calls); the count is CONSECUTIVE, reset by the `speaking` state transition, so a long healthy call with one blip in minute two and another in minute nine is not treated as an outage; and it fires exactly ONCE per call, because a second trip would talk over the goodbye. The line promises nothing it cannot do — no callback (the agent cannot dial out) and no message (that needs a tool round trip through the failing stack). 6 unit tests; agent suite 963 green. **The watchdog half of this item was already fixed on 2026-08-15 and the entry was stale:** the `reply_already_queued` branch no longer stands down — it arms the escalation timer, so a queued reply that produces no audio gets a spoken line at deadline2 instead of silence until the framework's 10s `ttsReadIdleTimeout`. Teaching the probe to recognise an _errored_ generation specifically would only save the wait to deadline2 — noted but not attempted (the core outage guard is already built and live).

### Phase 2 backlog

- [x] ~~Recording disclaimer → deterministic verbatim greeting (Illinois 2-party consent).~~ — **ALREADY DONE; entry was stale (verified 2026-08-28).** The prescribed `tenants.greeting` column that `index.ts` would speak verbatim is the design `greeting.ts` exists to reject: a tenant-controlled whole greeting silently deleted the disclosure. What shipped instead: composed opener + **unconditional** disclosure + closer. Default: _"this call is transcribed for quality and service"_ (never "recorded", never "training"). Custom wording is `tenants.call_disclosure` with attestation (`20260711000000`), not a `greeting` column. Pin: `agent/src/greeting.test.ts` (`discloses AI + transcription` ×5 configs; `never "recorded", never "training"`). `npx vitest run src/greeting.test.ts --run` → `40 passed (40)`.
- [x] ~~`get_my_appointments` transfer-fallback string~~ — DONE 2026-07-05 (PR #198): the no-caller-ID fallbacks in `get_my_appointments`/cancel/reschedule now capability-gate the transfer offer (offer a message only when transfer is unwired).
