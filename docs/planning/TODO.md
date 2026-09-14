# TODO — SecretaryHQ (single backlog)

**This is the one and only backlog.** Consolidated 2026-07-05 from the former
`GAPS.md`, `IMPROVEMENT_IDEAS.md`, `IMPROVEMENTS_TODO.md`, and
`AIASSISTANT_GO_LIVE_TODO.md` (all deleted; their done items + analysis archived
verbatim in `docs/planning/RESOLVED.md` under the 2026-07-05 entry).

Items are ordered by what should be done first. Ownership tags:
`(Dale)` = user/ops action, no code · `(code)` = codeable now · `(blocked)` = waiting on an external gate ·
**untagged** = deferred code work (the P3 / UX / doc-hygiene sections — no per-item owner because nothing there is scheduled).

**Not backlogs (left as reusable procedure/reference, do not fold here):**
`docs/workflow/BRANCH_CHECKLIST.md`, `docs/workflow/CODING_STANDARDS.md`, `docs/operations/DEPLOYMENT.md`,
`docs/workflow/DEVELOPMENT_WORKFLOW.md`, `docs/operations/ALERTS.md`. Completed work + history: `docs/planning/RESOLVED.md`.
Voice/Telnyx go-live ops detail + incident recovery: `docs/operations/RUNBOOK.md` §7.

---

## Next items to fix (coverage/build/deploy review)

Cold completed items from this section (prod migrations-behind outage, night-shift
morning half, declined-meeting goodbye gate, urgent-message raise-only, wrong-node-id
re-ask, unlinked-service STRICT parity, flaky CI gates) archived in
`docs/planning/RESOLVED.md` (2026-09-14 doc-hygiene entry).

- **OPEN, needs Dale's ear, not mine:** flag is on. Remaining question is whether the filler _sounds_ like cover and not a stutter on a real call (2800ms deadline, `HOLD_LINE`). Place one real test call; keep or set `ENABLE_OUTPUT_WATCHDOG=false`. CI cannot grade this.
- Fill real TELNYX_PUBLIC_KEY in .env

---

## 📞 Live-call follow-ups still open

Shipped series detail: `docs/planning/CALL_FIX_PLAN.md` (2026-07-30 batches) and
`docs/planning/RESOLVED.md` (2026-08-13 job-tree / CALL1+CALL2, 2026-08-15 E2E
observation sweep — all defects closed, sim suites green).

- [ ] **(Dale)** Run `scripts/pin-owner-for-hire-preset.sql` against prod after deploy,
      then place a test call and confirm a `job_inquiries` row lands.
- [ ] **(Dale)** Read the first `greeting_spoken` `ms_since_participant` values off
      prod. Both CALL1/CALL2 showed the greeting at `[0:17]` on the transcript clock, which is
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

## 🔴 P0 — Launch blockers (clear before the first paying customer)

Ordered: the product must answer + transfer + book on a real call, then take money,
then be gated/insured. Most of this is your action, not code — the code is shipped.

### 1. Voice path — make a real call work end-to-end

_Post-live voice enhancements (recording disclaimer, etc.) live in **🎙️ Voice — Phase 2** at the bottom of this file._

- [ ] **(Dale, use wife's phone)** **Live validation call** — do these steps together in one sitting:
  1. Set the **forward number** on the dashboard AI Persona → "Forward Calls to a Person" (`+1 608 217 5303`) before calling.
  2. Have wife call `+1 630-822-9086` (must use her phone — can't call from your cell and forward to it).
  3. Validate booking: appointment lands in `appointments` for tenant `d5e3c6a1` inside a real shift window.
  4. Validate transfer: say "talk to a person" → your cell rings + Calls tab shows the transcript.
     Code wiring shipped 2026-09-14 (`transfer_call` always-on checklist passthrough when forward number configured). This step is now the live proof, not a known fail.
  5. Validate dialog: agent asks preferred time, widens when none fit, never imposes a slot, recalls preferences across calls.
  6. Validate the booked time is what was said, not an earlier slot. `docs/planning/RESOLVED.md` (2026-07-04) logged a `[~]` **partial**: `book_with_scheduling_atomic` books the EARLIEST open slot ≥ `window_from`, so a caller-named "4:30" could book 4:00 — code mitigation shipped (tool description + prompt sharpened to set `window_from` to exactly the picked time), but it was never live-proved and no later TODO item picked it up. Confirm the agent both books AND confirms back the actual `booked_start`, not the caller's stated time restated blindly.
     (PSTN inbound itself already confirmed 2026-06-30; this closes the booking + transfer + preference legs.)
- [x] **(code)** **Wire `transfer_call` into the question-tree toolset** — 2026-09-14, PR #462. Always-on passthrough via `ALWAYS_ON_PASSTHROUGH_TOOLS` + `offerTransfer` (same forward-number gate as `CLOSER_WITH_TRANSFER`). Not a per-tree action node — every preset gets it when a forward number is configured; omitted entirely when absent.
- [ ] **(Dale)** **Delete or merge the duplicate active `Dale DeMott` employee row in prod.** `docs/planning/RESOLVED.md` (2026-07-03) logged this `[~]` **partial**: the app-level guard that stops a NEW duplicate (409 on a normalized-name collision with an existing non-deleted employee) shipped, but the pre-existing duplicate row in prod — one soft-deleted, one active — was left for a manual cleanup that needed prod DB access no session has. Never resurfaced as its own TODO item since.
- [x] **(code)** **Confirm whether the Aura TTS zero-bytes bug reaches prod.** ~~CLAUDE.md's TTS section documents an unresolved 2026-08-14 finding…~~ **CLOSED 2026-09-14 (PR #467) — dev-host-only artifact, not prod risk.** Ran `cd agent && npm run verify:tts` against the monorepo `.env` Deepgram key after confirming it **fingerprints identical** to Railway `DEEPGRAM_API_KEY` (same sha256_12 / len / prefix+suffix). Result: **10/10 SPEAKS** (6 Aura voices + greeting/hold/recovery/tool-fallback), each path returning ~100k–290k audio bytes over the **WebSocket** speak path. Prod `AURA_TTS_STREAMING` is **UNSET** (streaming default stays on). Keep `greetingPickup.ts` + `AURA_TTS_STREAMING=false` escape hatch + `verify:tts` gate; do not flip the prod default. Evidence: `docs/planning/RESOLVED.md` (2026-09-14 Aura zero-bytes).

### 2. Billing — be able to take money

- [ ] **(Dale)** **Decide final tier pricing** before creating Stripe products — current placeholders ($129/$279) have not been validated. Research findings + cost model (2026-07-07):
  - **Variable cost per call (5-min avg):** Telnyx ~$0.03 + LiveKit ~$0.02–0.05 + Deepgram STT $0.02 + OpenAI LLM ~$0.001 + TTS ~$0.02–0.09 = **~$0.09–0.17/call**
    - ⚠️ **Stale input (flagged 2026-07-28):** the TTS figure is OpenAI's, and TTS moved to **Deepgram Aura** on 2026-07-14. The LLM also moved 4o-mini → **4.1-mini**. Both legs need re-pricing from current provider rates before this model is used to set a price — deliberately NOT guessed here.
  - **Loss point:** an uncapped Solo tier at 1,000 calls costs $90–170 in variable cost alone — near-zero or negative margin at $129/mo
  - **Recommended Solo cap: ~300–400 calls/month** → variable cost ~$27–51, gross margin ~$78–102 on $129/mo
  - **Competitor benchmarks (verified July 2026):** Rosie AI $49/$149/$299 (250/1,000/2,000 min); Goodcall $79/$129/$249/agent (100/250/500 unique customers/mo); Signpost $199/$399/$749 (AI-only → hybrid human+AI)
  - **Key differentiator to keep:** include booking + call transfer at ALL tiers — competitors (Rosie, Goodcall) gate these to mid-tier. Lead with "full receptionist from day one."
  - **Suggested tier shape:** Solo ~$99–129/mo (1 location, ~300 calls/mo cap, full booking+transfer) · Growth ~$199–249/mo (multi-location or higher volume, Square CRM sync, analytics) · Pro ~$349+/mo (unlimited volume, priority support)
  - **Volume metering is built** — answered-call counter + soft-cap enforcement live under `src/services/billingUsage.ts` / voice-session-start; Dale still owns final Stripe price IDs and may retune `PLAN_CAP_*` env after real usage data.
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

### 4. Security housekeeping

- [ ] **(Dale)** **Rotate the Railway team token** created 2026-06-12 — it was pasted into a Claude session. Burn + reissue.
- [ ] **(Dale)** **Rotate the Supabase DB password** — exposed in a session transcript 2026-07-11.

### 5. Legal / business (long lead time — start early)

- [ ] **(Dale)** Open an **LLC bank account** for Thinking Hammer LLC (required before Stripe payouts).
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

- [ ] **(Dale)** Verify **reminder delivery stats** in prod. **Unblocked 2026-07-09** — Telnyx creds confirmed, and `TELNYX_PHONE_NUMBER` corrected from the dead `+163****1960` (see P0 §1). Note the stats before that fix were measuring a broken `from` address: fallback-tenant sends were rejected by Telnyx and logged as `status='failed'` in `communications_history`. Expect `sent` now. Check the Failed-only drill-down (`GET /communications/history?status=failed`) and confirm no new failures post-`23:49:38Z`.
- [ ] **(Dale/code)** **Pricing tiers (Pro/Enterprise)** positioning.

### Optional integrations — turn on per business need (code complete, need creds + a live round-trip)

- [ ] **(Dale)** **Google Calendar** — `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL` + GCP OAuth app; prove a real round-trip via `calendarSync.ts` + `SYNC_TEST_RECORDER`.
- [ ] **(Dale)** **Outlook Calendar** — `OUTLOOK_CLIENT_ID/SECRET/CALLBACK_URL` + Azure app.
- [ ] **(Dale)** **Square CRM** — `SQUARE_CLIENT_ID/SECRET/CALLBACK_URL` + `SQUARE_WEBHOOK_SIGNATURE_KEY` + provider OAuth app (code no-ops safely until set).

---

## 🟢 P2 — Quality, scale & ops visibility

- [x] **(code)** **Volume metering + tier cap enforcement** — monthly answered-call counter from `voice_sessions`; configurable caps via `PLAN_CAP_SOLO` / `PLAN_CAP_GROWTH` / `PLAN_CAP_PROFESSIONAL` / `PLAN_CAP_FREE` (defaults Solo 350, Growth 1000, Pro unlimited, free-tier 50 for null/unknown plan under soft-cap); meter counts soft-deleted billable + active in-flight (no owner-delete wipe, no completed-only TOCTOU); `GET /billing/usage` meter + 80% warn / 100% blocked banners; soft-cap refuse on `/agent-tools/voice-session-start` **and** `/voice/session/start` (`error_code=usage_limit_exceeded`, metric `call_rejected_usage_limit_exceeded`); agent speaks capacity line and ends the call. Toggle off with `USAGE_SOFT_CAP_ENFORCE=false` (pack overage messaging remains). Page `usage_cap_check_failed` / `voice_session_start_failed` rates (fail-open / fail-soft).
- [x] ~~**(Dale/code)** _(Optional)_ Repoint Railway `healthcheckPath` → `/ready`~~ — **DECLINED 2026-09-14 (PR #468).** Keep `railway.json` `healthcheckPath: /health`. `/ready` stays monitoring-only. Rationale + failure modes: `docs/planning/RESOLVED.md` (2026-09-14 Railway healthcheck decision).
- [x] **(code)** **Website-scan re-scan scheduler** — **DONE 2026-09-14 (PR #482).** Migration `20260914000000_tenant_website_scan_tracking` adds `tenants.website_scan_url` + `website_last_scanned_at` + `website_scan_fail_count` + `website_scan_last_attempt_at` (NULL URL = never scanned / opt-out). Shared `importWebsiteKnowledge` supersedes prior open suggestions, stages + stamps in one tenant transaction, resets fail_count on success. Worker `websiteRescanScheduler` (prod ON unless `ENABLE_WEBSITE_RESCAN_SCHEDULER=false`) daily-ticks oldest-stale non-demo tenants, default **30d** stale / **5** per tick / **5** maxFails (env-clamped). Dead-URL exponential backoff + quarantine. Multi-instance advisory lock. Still stages suggestions only — never auto-publishes. No boot stampede. Skip whole tick if no `OPENAI_API_KEY`. Roady HIGH follow-up t_462175ab.

### Structural refactors

- [ ] **(code)** **Migration chain squash** — **203** files in `supabase/migrations/` (2026-09-14). Do when convenient; `baseline.sql` already carries the collapsed schema. **PLAN ONLY 2026-09-14 (PR #459) — unsafe to execute without Dale prod gate** (prod `schema_migrations` head, data-migration/seed parity, role-grant restore, no checked-in chain-delete runbook). Full procedure + entry criteria: [`docs/planning/MIGRATION_CHAIN_SQUASH_PLAN.md`](./MIGRATION_CHAIN_SQUASH_PLAN.md). Do **not** delete migration files until that plan’s §3 criteria are green.

Dashboard component subdirectory migration finished 2026-09-12 (zero loose `.tsx`/`.ts`
at `dashboard/components/`). Backend suite warning cleanup (incl. pg@9 single-client
`Promise.all` break) shipped 2026-09-08. Detail: `docs/planning/RESOLVED.md`.

---

## 🔵 P3 — Moat & expansion (deferred until a customer asks — build principle: no integrations on spec)

- [ ] **Square CRM deeper reads** — pull open jobs into voice context; real external OAuth + Stripe + live CRM round-trips in CI (recorder-only today).
- [ ] **Extended self-service** — public portal/login (manage all appointments); waitlist / callback-queue tool; no-show auto-marking + auto-rebook.
- [ ] **Voice enhancements** — post-call "how did we do?" SMS/NPS link; multi-language; real-time owner listen-in / barge.
- [ ] **Product expansion** — booking widget/embed; granular RBAC beyond owner/front_desk; white-label / reseller theming; public API; PDF + analytics export (CSV export shipped #189); SSO/SAML; international numbers (US-centric today); multi-DID per tenant.
- [ ] **Schedule sub-view consolidation (C1+C2)** — merge the 4 scheduler sub-views (calendar/staff/resources/list) → 2 (calendar Day/Month + Team/Resources) with one unified header. `dashboard/components/SchedulerView.tsx`. (large/UX; from the former IMPROVEMENT_IDEAS.) **Open — needs a UX design pass with Dale before build** (it changes the scheduler layout; brainstorm the target shape first).
- [ ] **Threaded demo mode (E1)** — replace the static `/demo` page with a session flag (`isDemoMode`) injecting read-only sample data into the live dashboard shell (stays in sync with real UI automatically). (large.)
- [ ] **Future CRM/platform candidates** (build-deferred per the `docs/product/STRATEGY.md` vendor heuristic — "how does this vendor make money?") — QuickBooks/Xero, Toast, Apple Calendar (safe infra/transaction partners); Microsoft Teams (notify-only); Vagaro/Mindbody, Acuity/Calendly (competitor-ish → shallow read or import-only).

---

## 🎨 UX backlog (separate workstream — `/ux-expert` audits)

- [x] **(Dale — BLOCKER)** Review live scheduling **coloring/grading** — **ACCEPTED 2026-09-14 (Dale verbal).** Keep current colors/grades. De-grade slices stay reverted; do not strip coloring unprompted. Revisit only if Dale flags a specific surface later.
- [x] **Cluster A — neutral-language / no-grading** — **DEFERRED 2026-09-14 with Dale's color accept.** Same 8 surfaces (`StepReview`, `SkillRelationshipMap`/`SkillMapNode`, `ResourceColumnsView`, `AppointmentListView`, `EmployeeDayFocusPanel`, `AnalyticsView`, `AppointmentDetailPanel`) may still use traffic-light / % / coverage-badge patterns; that is now intentional product choice, not an open de-grade ticket. Re-open only on Dale request.
- [ ] **Wizard Phase B follow-ups, remaining** (explicitly deferred in the design doc, not bugs):
      auto forwarding-verification heuristic (SIP caller-ID match instead of asking the owner) —
      named, not built; real Telnyx porting API integration — deferred until a real port customer
      per YAGNI. (Wizard Phase B + abandoned-test-number reaper shipped — see RESOLVED.md.)
- [ ] **Dense-view decomposition** — remaining over-300 coordination surfaces: `NewSchedulerView` (1582 — do with C1+C2 scheduler consolidation); other over-300 files are unavoidable coordination code (wizard state machines, layout shell, GoLivePanel). Five decomposition slices already shipped 2026-07-05…07 (PRs #201, #211, #212, #217, #218) + coverage batch #219 — detail in RESOLVED.md.
- [ ] Un-audited surfaces — **[REVIEW]** before beta (owner-judgment layout/flow; copy/a11y partials already landed). Most already had a copy/a11y **partial fix** 2026-07-03 plus correctness/a11y defect batch 2026-07-05 (PR #200). What remains is the owner-judgment call:
  - `AIConfigView`, `AnalyticsView`, `VoiceCallsView`, `AppointmentView` + `AppointmentDetailPanel` + `AppointmentListSidebar`, `CRMView` + `CustomerDetailPanel`, `ProfileView`, `BusinessSettingsView`, `SettingsView`, `EmployeeManagementView`, `ShiftManagementView`, `ResourceManagerView`, `ServiceAssignmentView`, `SkillMatrixView` + `SkillAssignmentsView` + `SkillRelationshipMap`, `DeletedRecordsPanel` + `RecordHistoryModal`, `/register`, `LoginView` + `/forgot-password` + `/reset-password`, `SuperAdminDashboard` + tenant cards/forms, `FirstRunTour`.

---

## 🧹 Doc hygiene (mechanical, ongoing — low priority)

- [ ] Continue count-drift passes (route modules / migrations / test numbers) after any new route or migration; keep secondary docs synced. `verify-claude-md.ts` guards Key Directories route/migration counts; the Project Status paragraph is excluded via `stripHistoricalSections()`, so test-count prose there drifts silently unless someone re-runs this pass by hand after a PR adds tests.
      **2026-09-14 pass (PR #470):** routes **29** (verify-claude-md definition: top-level `.ts` under `src/routes/` excluding `*Helpers.ts` / `*Scaffold.ts` / tests — prior hygiene notes saying **32** counted helpers/scaffold too); `supabase/migrations/` **202**; e2e specs **40**; loose `dashboard/components/` top-level **0**; tools defined **27** (`agent/src/tools/*.ts`). Live suite totals refreshed: backend **3,147** (263 files), dashboard **1,126** (104 files), agent **1,048** (61 files). Secondary drift fixed: ARCHITECTURE tree still said **92** dashboard Vitest files (→104), ALERTS sizing note still said **~32** route modules (→~29), README Tests row still at 3,144. `npm run verify:claude-md` clean. Checkbox stays open — pass is ongoing after each route/migration PR.
- [x] ~~Trim remaining historical narrative from active docs into `planning/RESOLVED.md` when it goes cold.~~ — **DONE 2026-09-14 (PR #460).** Cold `[x]` postmortems + finished series moved to RESOLVED; open items + unique procedures kept.
