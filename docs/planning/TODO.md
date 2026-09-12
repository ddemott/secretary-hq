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

- [x] ~~**PROD WAS SIX MIGRATIONS BEHIND, AND ONE DEPLOYED CODE PATH WAS ALREADY BROKEN BY IT.**~~ — **FOUND AND FIXED 2026-09-09.**
      `schema_migrations` on prod ended at `20260820000000` while `main` carried seven more. The
      gap was not inert: `availabilitySearch.ts` has joined `blackout_dates` since `d8f4e72`
      (#395, 2026-09-04), that commit is an ancestor of what prod was running, and **the table did
      not exist there.** So `findNextAvailableSlots` — the "when is your next opening?" path —
      returned `{"success":false,"error":"Failed to compute available slots"}` on production for
      five days. Probed directly: the same route WITH a `date` worked (different query), which is
      exactly why nobody noticed; the failure lived behind a generic error string on the one path
      that has no date to hand.
      Applied in order: `20260821000000` (drop n8n webhook), `20260821010000` (drop inert
      columns), `20260821020000` (narrow dead CRM provider CHECKs), `20260901000000` (vertical
      intake preset ids), `20260901100000` (starter services, `text[]`→`jsonb`), `20260903000000`
      (blackout_dates + `BUSINESS_CLOSED`), `20260909120000` (shift boundary slack). Preconditions
      for the three destructive ones were re-verified against prod first and still held: 0 tenants
      with an `n8n_webhook_url`, `pg_net` not installed, `tenant_integration_settings` and
      `entity_sync_map` both empty. Verified after: `blackout_dates` present,
      `shift_covers_booking` present and called 3× by the booking RPC, `n8n_webhook_url` gone,
      `example_services` now `jsonb`, and the next-available path answering
      _"The soonest I can get you in is tomorrow at 1:30 PM…"_.
      **The lesson worth keeping: "deploy verified" was checked against `/health` and a booking,
      and both were green while a third path was dead.** A merge that ships code and a migration
      together can half-land — the code always deploys, the migration only if someone runs it —
      and nothing in CI or the health board notices the half. Before calling a deploy done, compare
      `max(schema_migrations.version)` on prod against the newest file in `supabase/migrations/`.
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
- [x] ~~**The morning half of a night shift can never be booked.**~~ — **FIXED 2026-09-11**,
      migration `20260911010000_night_shift_morning_half.sql`. Coverage was matched on the SLOT's
      own local date, so a night shift's row (dated the evening it started) was never consulted
      for anything after midnight — 22:00→06:00 booked fine at 23:00 but refused a 02:00 slot the
      next morning with `EMPLOYEE_NOT_SCHEDULED`. New `shift_row_covers_booking()` wraps
      `shift_covers_booking()` and adds the missing case: a row dated YESTERDAY covers TODAY's
      slot only when it is itself a wrapping night shift (end < start) reaching that far, and
      today's slot doesn't itself wrap into a third day. Six call sites in
      `book_with_scheduling_atomic` widened from `es.shift_date = v_shift_date` to
      `es.shift_date IN (v_shift_date, v_shift_date - 1)` + the new function, plus
      `availabilitySearch.ts`'s suggest-side JOIN in the same commit (suggest and enforce must
      read the calendar the same way — the 2026-07-17 midnight-wrap lesson). `book_appointment_atomic`
      (dashboard path) is untouched — it validates one chosen resource/employee against one day's
      row by design and has never modeled night shifts; that gap is pre-existing and separate.
      **Residual, deliberately out of scope:** the `get_available_slots` DATE path
      (`src/routes/agentTools/scheduling.ts` `effective_shifts` CTE) has the identical
      same-date-only join and was not touched — it renders a single day's shifts/appointments in
      JS and was not part of this bug's repro. No live tenant runs night shifts, so this is not an
      active gap; fix it in the same pass as the day it matters. New tests:
      `tests/services/night-shift-availability.test.ts` (HAPPY: 02:00 books against a 22:00→06:00
      row; SAD: a day shift never gains cross-day coverage) and
      `tests/services/availability-search.test.ts` (suggest-side parity, post-midnight-only search
      window).
- [x] ~~**A caller who declines the meeting can leave the call unable to END.**~~ — **FIXED
      2026-09-11.** Found in `sim-questiontree` JOB-DIRECT (never graded — rate limits — so no
      grader saw it), on `main`. The opener "talk to someone about a job opportunity for Dale"
      selected `identity + job + booking`; the caller then answered the meeting offer "just
      pass the details along" (`details_only`). Booking stayed selected with nothing left to do,
      so the goodbye gate refused `finish_call` ("Not yet — the checklist is not complete"),
      while the agent itself told the caller "there's no appointment to book". One run ended in
      a goodbye loop ("You're welcome! … Take care!" / "Thanks, Mike. If you need anything
      else…") with no `finish_call` at all. `checklistTools.ts` turned `wants_meeting` into
      `select(['booking'])`; nothing did the inverse. Added the missing `details_only` handler:
      deselects `booking` (the caller's own "no meeting" is the clearest signal there is),
      guarded on the booking action not already being `done` — a meeting booked earlier in the
      call by whatever route is real progress and is never un-booked by a later, unrelated
      answer. Same structural-guarantee shape as the `meeting_offer → booking` escalation, in
      reverse. New tests in `checklistTools.test.ts`: the goodbye loop reproduced then fixed end
      to end (select booking directly, decline the offer, finish the intake, `finish_call`
      actually closes), plus a guard test pinning that an already-booked meeting survives a
      later `details_only`.
- [x] ~~**An urgent message can be saved as ordinary while the caller is told "urgent".**~~ —
      **FIXED 2026-09-11.** Found in `sim-questiontree` URGENT CALLER (graded FAIL, correctly),
      on `main`: the caller said "urgently" in her opener and "It's really urgent" again; the
      model tried `record_answer("is_urgent")`, was refused (not a checklist node), then called
      `take_message` WITHOUT `is_urgent: true` — and told her "I've saved your urgent message for
      Dale". The question-tree path had NO urgency handling at all: no node in any tree, no
      `ACTION_ARG_BACKFILL` entry, no host detection. Migration 20260801020000 says the flag "is
      set from the caller's own words", but only the model was ever asked to do it — a prompt
      request, not a guarantee. New `messageSoundsUrgent()` matches "urgent(ly)", "emergency",
      "as soon as possible"/"ASAP", "right away" against the FINAL message text (post-backfill,
      so it catches `message_body` even when the model never retyped it) — checked per
      OCCURRENCE with a negation guard, so "not urgent" / "isn't an emergency" never false-positive
      (Copilot review) — and `buildActionArgs` applies it to every `take_message` call.
      RAISE-ONLY means MONOTONIC, not "never touches the model's value": when the caller's own
      words say urgent, `is_urgent` is forced to `true` even over an explicit `false` from the
      model (the caller's words outrank the model's guess); when nothing in the message says
      urgent, whatever the model passed is left untouched — the flag can only ever move toward
      `true`, never away from it, matching the DB column's own raise-only contract. New tests in
      `checklistTools.test.ts`: the matcher itself (incl. negation), the raise when the message
      text says urgent (including over an explicit `is_urgent: false`), and the no-op when
      nothing in the message says urgent.
- [x] ~~**A wrong node id makes the agent RE-ASK the caller instead of retrying.**~~ — **FIXED
      2026-09-11.** Found reading `sim-questiontree` transcripts, on `main`. ONE-BREATH
      ("everything volunteered in the opener, nothing re-asked") was graded PASS while the
      transcript showed the opposite: the caller gave company, full-time, senior QA, $120–140k,
      hybrid and the address in her first sentence; the model recorded them under invented ids
      (`role_type`, `role_title`, `role_salary_range`, `role_location`), `tracker.ts`'s `record()`
      refused each with `"<id>" is not on this call's checklist. Record only the ids the checklist
      shows.` — which named no valid id — and the model then asked her for all of it again ("Like
      I said…", twice). Same class as the 2026-08-19 `hiring_for_own_company` prefix fix: the
      refusal must hand the model the ids it CAN record, so a wrong id costs a silent retry, not
      the caller's patience. Fix: the `UnknownNodeError` now appends `Open ids you may record
      now: <the frontier's current open ASK node ids>` — the same "list what's actually valid"
      shape as `UnknownTreeError` on `set_purpose`. Also fixed the grader: it only checked one
      hard-coded re-ask phrasing (the caller's name), which is exactly why this scenario passed
      despite the transcript showing a real re-ask. Added a generic tripwire instead — the
      persona's own behaviour instruction ("repeat it with mild impatience — 'like I said, …'")
      fires ONLY when the agent actually re-asks something already said, so `sim-questiontree.ts`
      now fails ONE-BREATH if the caller ever says "like I said" for ANY reason, not just the name.
      New unit test in `tracker.test.ts` pins the error message; the grader fix has no separate
      unit test (it's the harness itself).
- [x] ~~**The dashboard booking form and the phone disagree on an UNLINKED service.**~~ — **FIXED
      2026-09-11**, migration `20260911000000_book_appointment_atomic_strict_links.sql`.
      `book_appointment_atomic` (dashboard path) now applies the identical STRICT rule
      `book_with_scheduling_atomic` got in `20260909210000`: when `p_service_id` is passed, only
      ACTIVE `service_employee` / `service_resource` links decide who and where —
      `required_skills` / `required_resources` tag arrays are never read — and a service with no
      active linked resource (or, when an employee is being assigned, no active linked employee)
      is refused before any other check, same wording the phone path already speaks ("No room or
      line is set up for this kind of appointment" / "No one is assigned to take this kind of
      appointment"). Retired the fall-open "configure-as-you-go" contract the mapping model
      shipped with. Test coverage rewritten: `tests/routes/book-appointment-mapping.test.ts`
      (UNLINKED-SERVICE + LEGACY-TAGS-IGNORED cases replacing the old OPEN-SERVICE/LEGACY-FALLBACK
      pair), `tests/regression/high-bugs.test.ts` BUG-009 (both directions — reject-on-unlinked,
      allow-on-linked-regardless-of-tags), `tests/regression/low-bugs.test.ts` BUG-040 (link the
      fixture resource so the auto-calculate-end-time cases don't trip the new gate), and
      `dashboard/e2e/wizard-solo-path.spec.ts` (rewritten to the STRICT refusal message). Baseline
      regenerated (`npm run db:baseline`). Tag columns (`employees.skills`,
      `services.required_skills`) NOT dropped — `book_with_scheduling_atomic` still reads them for
      callers that omit `p_service_id`; retiring them is still open, not part of this fix.

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

- [ ] **(Dale)** Verify **reminder delivery stats** in prod. **Unblocked 2026-07-09** — Telnyx creds confirmed, and `TELNYX_PHONE_NUMBER` corrected from the dead `+16308661960` (see P0 §1). Note the stats before that fix were measuring a broken `from` address: fallback-tenant sends were rejected by Telnyx and logged as `status='failed'` in `communications_history`. Expect `sent` now. Check the Failed-only drill-down (`GET /communications/history?status=failed`) and confirm no new failures post-`23:49:38Z`.
- [ ] **(Dale/code)** **Pricing tiers (Pro/Enterprise)** positioning.

### Optional integrations — turn on per business need (code complete, need creds + a live round-trip)

- [ ] **(Dale)** **Google Calendar** — `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL` + GCP OAuth app; prove a real round-trip via `calendarSync.ts` + `SYNC_TEST_RECORDER`.
- [ ] **(Dale)** **Outlook Calendar** — `OUTLOOK_CLIENT_ID/SECRET/CALLBACK_URL` + Azure app.
- [ ] **(Dale)** **Square CRM** — `SQUARE_CLIENT_ID/SECRET/CALLBACK_URL` + `SQUARE_WEBHOOK_SIGNATURE_KEY` + provider OAuth app (code no-ops safely until set).

---

## 🟢 P2 — Quality, scale & ops visibility

- [ ] **(code)** **Volume metering + tier cap enforcement** — do after first customer, once real usage data sets the bands. Data already exists (`voice_sessions` per tenant per month). Build: (1) monthly call counter endpoint; (2) per-plan limit config (Solo ~300–400 calls, Growth ~1,000, Pro unlimited); (3) dashboard usage meter + 80% warning banner; (4) soft cap enforcement. No Stripe Metered Billing needed — flat bands with a DB query. See pricing notes in §2 Billing above.
- [x] ~~**(code)** **Three warnings the backend suite printed on every green run**~~ — **ALL THREE FIXED 2026-09-08.** Verified by removing the suppression and reading a full run: `configLoader` 0, `DeprecationWarning` 0, `dynamic-import-vars` 0, suite `3029 passed (254 files)`. (`ai_cost_model_unpriced` x4 stays — that is the SAD path doing its job on fixture models with no price entry.)
  1. **Vite `configLoader: 'native'`** — `vitest.config.ts` → **`vitest.config.mts`**, which is what the warning asked for. `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` is gone from `npm test`; it was hiding the warning, not fixing it, and native config loading is scheduled to become Vite's default. The rename broke `tests/services/deadlock-prevention.test.ts`, which read the config off disk by name — the same off-disk coupling CLAUDE.md flags for `available-slots.test.ts`. It now DISCOVERS the config file, because the assertion is about `fileParallelism: false` and not about an extension; an absent config still fails loudly.
  2. **`vite:dynamic-import-vars`** — `tests/regression/type-safety.test.ts` now imports `` `../../src/routes/${mod}.ts` ``. The plugin needs a static extension in the pattern.
  3. **`pg` overlapping-query deprecation — this one was PRODUCTION code, not test helpers, and it is a real pg@9 break.** Three sites ran `await Promise.all([client.query(…), client.query(…)])` against ONE pooled client: `/analytics/stats`, `/analytics/calls`, and `getCohortAnalytics`. node-postgres serialises on a single client regardless, so `Promise.all` bought **no concurrency at all** — it only started each query before the previous finished, which is exactly what pg@9 removes. `cohorts.ts`'s own header claimed the six queries ran "concurrently… running them in sequence would multiply one round trip by six"; that was never true and is corrected in place. All three now use `queryInSeries(...)` (`src/database/index.ts`), which takes THUNKS so nothing starts out of turn, and uses rest parameters so TypeScript still infers a tuple and each destructured result keeps its own row type. Guarded by `tests/regression/singleClientQueryOverlap.test.ts` — a source scan (comments stripped, thunks exempt) plus an ordering assertion on the helper. Red-green proven: a probe file with the old pattern fails it by name, removing the probe passes.
- [ ] **(Dale/code)** _(Optional)_ Repoint Railway `healthcheckPath` → `/ready` to gate deploy **promotion** on DB reachability (behavior change — could block promotion during a DB blip; your call).
- [ ] **(code)** **Website-scan re-scan scheduler** — periodic re-scan of stale KB. Deferred: needs a `last_scanned` column/migration + is a cost/product call.

### Structural refactors (folded in from root `07_11_2026_IMPROVEMENTS.md`, 2026-07-28 — that file is deleted; it duplicated this backlog and sat in the root, which by CLAUDE.md holds only CLAUDE.md / README.md / workflow.config.json / DEMO_SECTION.md)

Each status re-verified against the code on 2026-07-28, not carried over on trust. Item 1 of the original nine (**split `agentTools.ts` into a domain module**) is **DONE** — `src/routes/agentTools/` is a directory of 8 modules.

- [x] ~~**(code)** **Finish the dashboard component subdirectory migration**~~ — **DONE 2026-09-12.**
      Zero loose `.tsx`/`.ts` files remain at `dashboard/components/` (was 35, 2026-09-05 count).
      Moved: `AIConfigView`→`aiconfig/`, `BusinessSettingsView`/`BusinessTypeSection`/`SetupView`→`business/`,
      `CustomerDetailPanel`→`crm/`, `DashboardHome`→`home/`, `DeletedRecordsPanel`→`records/`,
      `EmployeeManagementView`→`employees/`, `ResourceManagerView`→`resources/`, `SchedulerView`→`scheduler/`,
      `ServiceAssignmentView`→`services/`, `SettingsView`→`settings/`, `ShiftManagementView`→`shifts/`,
      `SkillAssignmentsView`→`skill-map/` (consolidates with `SkillRelationshipMap`),
      `SkillManagementView`/`SkillMatrixView`→`skills/` (joins `SkillMatrix`), `TeamAccessView`→`team/`,
      `VoiceCallsView`→`voice/`; cross-cutting tests `critical-fixes.test.tsx` + `vocabulary-guard.test.ts`→`ui/`
      per this entry's own note. `SetupWizard.tsx` (a one-line re-export shim for `SetupWizard/index.tsx`)
      deleted outright — importers of `'./SetupWizard'` now resolve straight to the directory, unchanged
      behavior. The orphaned `EmployeeServiceAssignmentView.test.tsx` (misnamed — it actually tested
      `EmployeeManagementView`) renamed to `EmployeeManagementView.smoke.test.tsx` alongside its real subject.
      Every relative import updated (including several PRE-EXISTING "subdirectory pin" guard tests in
      unmoved sibling files — `CRMView.test.tsx`, `AuditLogView.test.tsx`, `BillingView.test.tsx`,
      `AIInsightsView.test.tsx` — that hardcoded the old top-level paths and had to move with it).
      Verified: `tsc --noEmit` clean, dashboard `next build` succeeds, full dashboard suite green
      (1070 tests, 99 files).
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

- [ ] **(Dale — BLOCKER)** Review live scheduling **coloring/grading** so Cluster A neutral-language work can proceed (de-grade slices were reverted 2026-05-20; do not re-apply unprompted).
- [ ] **Cluster A — neutral-language / no-grading** (8 surfaces, blocked on the Dale review): `StepReview`, `SkillRelationshipMap`/`SkillMapNode`, `ResourceColumnsView`, `AppointmentListView`, `EmployeeDayFocusPanel`, `AnalyticsView`, `AppointmentDetailPanel`. (Violates the "no percentage/letter grading" product rule.)
- [x] ~~**Wizard Phase B**~~ — reversed from "held" and **shipped 2026-07-05/06** (PRs #204–#208): draft-commit `SetupWizard` + `GoLivePanel` + E2E coverage, merged to main, no prod migration needed. Full writeup + lessons in `docs/planning/RESOLVED.md`.
- [x] ~~**Wizard Phase B follow-up: abandoned-test-number reaper**~~ — **DONE 2026-09-12** (query
      only, as scoped — "queryable, not built"). `scripts/find-abandoned-test-numbers.ts`: a
      `phone_status='active'` DID with no `forwarded_from_phone` and no `voice_sessions` in the
      last N days (default 14, `--older-than`) is billing Telnyx every month with no live purpose.
      Report-only by design — it never releases a number or touches Telnyx; deciding "abandoned
      enough to release" stays a human call, mirroring `purge-soft-deleted.ts`'s dry-run-first
      philosophy (except here there is no `--execute` at all, since deprovisioning is a
      platform-owner ops action, not something to automate blind). The query is exported
      (`findAbandonedTestNumbers`) and shared verbatim with its real-DB test
      (`tests/regression/abandonedTestNumbers.realdb.test.ts`, 6 cases: flags the genuinely
      abandoned tenant; never flags one with `forwarded_from_phone` set, one called inside the
      window, one soft-deleted, or one never phone-activated; re-opens as abandoned once a past
      call ages out of the window) plus a CLI-guard test
      (`scripts/find-abandoned-test-numbers.test.ts`, same `--older-than` misparse class
      `purge-soft-deleted.ts` was fixed for on PR #351 — a dropped guard here costs a misleading
      report, not a destructive purge, but a misleading report about which real phone numbers to
      release is still the wrong answer). Full backend suite green (3099 tests).
- [ ] **Wizard Phase B follow-ups, remaining** (explicitly deferred in the design doc, not bugs):
      auto forwarding-verification heuristic (SIP caller-ID match instead of asking the owner) —
      named, not built; real Telnyx porting API integration — deferred until a real port customer
      per YAGNI.
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

- [ ] Continue count-drift passes (route modules / migrations / test numbers) after any new route or migration; keep secondary docs synced. **2026-09-12 pass:** routes **32** (CLAUDE.md's own architecture-section prose still said 29 in two places — `verify-claude-md.ts` checks route-module count against `Key Directories`, not every prose mention, so this drift was NOT auto-caught; fixed both); `supabase/migrations/` **196**; dashboard loose `.tsx`/`.ts` at `components/` is **0** (the subdirectory migration TODO item above is now fully closed — was 35 on 2026-09-05); test counts refreshed in CLAUDE.md's Project Status line: backend **3,100** (260 files), dashboard **1,070** (99 files), agent **1,040** (60 files). **Lesson for the next pass:** `verify-claude-md.ts` and `npm test` totals both stay accurate only if someone re-runs them — neither is wired to fail CI on ITS OWN staleness the way the migration/route counts are; a prose count with no automated guard is exactly the kind of drift this line exists to catch.
- [ ] Trim remaining historical narrative from active docs into `planning/RESOLVED.md` when it goes cold.
