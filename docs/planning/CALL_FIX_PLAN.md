# CALL_FIX_PLAN — the PR series behind CALL_IMPROVEMENTS.md

> **Status 2026-09-18:** all seven batches (G #307, H #308, A #309, B #310, C #311, D #312, E #313, F #314) are merged to `main` (verified via `git log`). The root `CALL_IMPROVEMENTS.md` this plan cites was deleted in #401 once its fix batches closed — references to it below are historical.

Plan drawn up 2026-07-30 from the 12-call analysis in `CALL_IMPROVEMENTS.md` (root)
plus the same-day deep dive into call #1 (SCL_nRKo3KEVw8Yh), which surfaced defects
the original analysis missed. Each batch below is one PR. Mark batches with their PR
number as they ship; when a batch ships, also mark the CALL_IMPROVEMENTS entries it
resolves.

All fixes target the LIVE call path (question trees, `agent/src/checklist/*`) unless
stated. Nothing here touches the ladder — the ladder is the rollback path only.

**Shipping order: G → H → A+B → C → D → E → F.** Data loss first, then
observability (makes every later live-call verification cheap), then the trust
failures behind the 07-27 Jaya cascade, then the rest.

---

## G — job-call capture completeness (calls #1) — **PR #307**

1. `job_inquiries.role_description` column + Zod field + tool param + tree mapping +
   `baseline.sql` regen. The job tree COLLECTS the role description (node exists, the
   agent asks, the caller dictates) and the write layer silently drops it — verified
   2026-07-30 against prod: no tool param, no Zod field, no column. The role title is
   the single most useful field for deciding whether to return the call, and it is the
   one field the pipeline loses.
2. Outcome `job_inquiry` in CallOutcomeTracker (was `message` — so the session row,
   the post-call summary, and the dashboard all repeated the agent's false "left a
   message" claim; the summarizer faithfully summarizes the transcript's lie).
3. Job-tree wording rule: never say "message"/"voicemail" on a job call — "I'll
   record the position details for [owner]". Never promise an artifact that won't
   exist (same class as the SMS gate).
4. `finish_call` once-guard — call #1 ended with two consecutive goodbyes; nothing
   prevents a second `finish_call` from speaking a second farewell.
5. Stall detector — N consecutive caller turns with no new checklist answer → the
   state block directs: summarize what you have, offer to wrap up. Call #1 spent 5
   minutes extracting what an AI recruiter bot said in its first sentence.
6. Offer-meeting in the JOB TREE (live-path port of the merged-but-inert ladder
   OFFER_MEETING block, PR #306): offer time with the owner once — both doors
   (meeting or message), offer exactly once, nothing "booked" until
   `book_with_scheduling` returns success.
7. Guards: node→param completeness unit test (every text tree node maps to a tool
   param or is explicitly transcript-only — turns silent capture loss into CI
   failure); sim-questiontree Sage bot-mirror replay; offer-behavior sequence eval
   (the 2026-07-27 offered-took-a-time-said-booked-never-called-the-tool failure gets
   its regression guard here, on the path real callers hit).

Deliberately cut: caller-email ask at job wrap-up (owner declined — every added
question lengthens calls; callback phone already on every lead).

## H — call observability (unblocks every later postmortem) — **PR #308**

1. Per-call tool-call log — tool name, args digest, outcome, timestamp — persisted
   (e.g. `voice_sessions.metadata`, currently an empty `{}` on every row). Railway
   log rotation made call #8's three candidate causes undecidable; a tool trace makes
   that one query.
2. Watchdog/hold-line utterances into TranscriptRecorder (keep `addToChatCtx: false`
   — transcript ≠ chat context). Today the transcript under-reports what the agent
   spoke, which is why the silent calls (#5/#6) are undiagnosable.
3. Per-turn timestamps in transcript entries — pause/latency forensics.

## A — caller context reaches the model (calls #7, #8) — **PR #309**

> Bonus find during the build (2026-07-30): the context prefetch had been
> SILENTLY DEAD since the disclosure gate shipped 2026-07-13 — it never sent
> `phone_source`, the schema defaults to 'spoken', and the gate blocked every
> known-caller lookup. Even the LADDER's known-customer section stopped
> rendering that day, and nothing noticed. Fixed by declaring the attested
> source; the ladder path gets its context back as a side effect.

1. Extend `fetchCustomerContext` payload with upcoming appointments; PASS
   `knownCustomer` into ChecklistAgent (today it goes only into the ladder prompt —
   the live path never sees the CRM snapshot, verified 2026-07-30 at
   `agent/src/index.ts:1295-1307`).
2. Render upcoming appointments in the checklist prompt header — no tool call for the
   model to skip.
3. `get_my_appointments` into the base passthrough toolset (today: only when
   `schedule_change` is selected).
4. Prompt rule: never assert presence/absence of a booking without fresh tool result
   or header data.
5. toolselect eval: caller claims an existing booking → must not deny without
   checking.

## B — booking mechanics + timezone + duplicates (calls #9, #10 — root of the cascade) — **PR #310**

> Found while building: a refusal needs its own EXIT. The first sim run of the
> duplicate guard behaved perfectly — relayed the existing 1:00 PM, refused to
> double-book — and then the call could not END: the booking node stayed
> unresolved and the goodbye gate held it open while both sides looped "anything
> else?". Every refusal a checklist action can receive must tell the model how to
> resolve the node (here: record it declined when the caller keeps what they have).

1. Booking confirmation states call mechanics — per-tenant/per-service copy, default
   "[owner] will call you at this number at [time]". Call #9's "call Dale directly at
   two thirty on the same number" (the AI's own line) produced four follow-up failed
   calls.
2. `caller_timezone` listen node + prompt rule: caller utters a timezone → confirm the
   converted time ("2:30 Eastern is 1:30 our time — book 1:30?").
3. Cross-call duplicate guard in the booking route: same-day same-service non-cancelled
   appointment for this customer on a different call → `EXISTING_SAME_DAY` + details;
   model asks keep/move/both. (`wrapAction`'s guard is per-call in-memory only.)
4. Roster reconciliation: employee names in the checklist prompt; a caller-named
   person with no roster match gets a clarify ("You mean Dale?"), never repeated back
   as fact ("Jane").
5. Provenance rule + sim case: hedged company mentions ("companies like X") get a
   confirm question, never direct capture.

## C — availability says WHY (calls #7, #8) — **PR #311**

1. `available-slots` accepts optional `requested_time`; when that time is missing from
   results the response carries the reason: `occupied_by_caller` / `occupied` /
   `outside_shift` (reuse `conflictLookup.findOverlappingAppointment`, compare the
   blocking appointment's customer to the caller).
2. Route `spoken`/`note` includes the reason so the model relays truth ("You already
   have 2:30 booked") instead of inventing one ("we can only book on the quarter
   hour" — call #8's hallucinated explanation for a slot list it didn't understand).

## D — corrections propagate (call #2) — **PR #312**

1. Partial UNIQUE on `customer_messages (tenant_id, call_id) WHERE call_id IS NOT
NULL`; route becomes `ON CONFLICT DO UPDATE` — retry-safe AND correction-capable
   (same pattern as `job_inquiries_one_per_call`).
2. `record_answer` on a node consumed by a `done` action → re-fire that action's
   write with current values (macrotask; never `updateTools()` inside execute).
3. Un-latch `maybeIdentify` (today `identifySent` fires once per call — a corrected
   name never re-syncs); `identify_caller` gains `is_correction` to overwrite a
   non-placeholder name — SCOPED to names written by THIS call. Cross-call renames
   stay a dashboard act (a shared-line caller must not rename an established
   customer; same claim-based-trust class the OTP call-binding closed).
4. Normalize spelled corrections ("C-A-M-I-L-L-E" → "Camille") before save; prompt:
   name node gets the name ONLY, "from <company>" goes to the company node.

## E — junk rows + urgency (calls #3, #7) — **PR #313**

> COURSE CORRECTION during the build: the plan said "stop creating customer rows
> at voice-session-start". That would have REVERTED a deliberate 2026-07-27 fix
> — prod had 10 calls, 10 with caller ID, and ZERO linked customers; the owner's
> phonebook contained nobody who had actually phoned him, and the comment there
> explicitly accepts junk rows as the cost. So: keep creating, PRUNE AT HANG-UP
> instead, when the call has told us which kind it was. Deciding at the start
> whose call is worth recording is the mistake that caused the original gap.

1. Stop customer creation at voice-session-start (`session.ts` creates a customer
   named literally "Caller" on EVERY caller-ID call before a word is spoken —
   `customerLookup.ts:152`); create lazily on first real write. Check
   `voice_sessions.customer_id` consumers first.
2. One-off cleanup script for existing "Caller" rows with zero artifacts (dry-run
   default, prints blast radius).
3. Urgency: "urgent" → offer "I'll get a message to [owner] right away";
   priority flag on the message row + dashboard badge. A real `transfer_call`
   passthrough (gated on tenant forward-phone) is a separate later PR needing
   live-call verification.

## F — call hygiene (calls #1, #4, #5, #6, #11, #12) — **PR #314**

1. Caller-silence timer: >10s post-greeting → one "Are you still there? I can take a
   message or book a time." → graceful close, `outcome='silent_hangup'`. (No
   caller-silence handling exists — the watchdog arms on the AGENT's thinking state
   and stands down exactly when the caller goes quiet.)
2. Stall detector tuning from G's data.
3. `greeting_only_hangup` metric (transcript length == greeting length); measure
   before shortening the greeting. 4 greeting-only calls in one afternoon.
4. Off-hours greeting variant from `employee_schedule` ("[owner]'s hours are 1–5 PM
   Central — I can book you a time or take a message").
5. Job inquiries surfaced in/next to the dashboard Messages inbox — the call #1 lead
   is invisible where the owner actually looks.

---

## Deliberately NOT planned

- Robocall-phrase fast-hangup heuristic (#3, #12) — stall detector catches the worst
  cost; a phrase heuristic risks false positives on real callers. Revisit if the
  pattern repeats.
- Proactive spelling-confirmation on every name capture — adds friction to every
  call; measure after D ships.
- Per-tenant tree enablement — the config surface exists in principle (the tree
  library is platform-global; `fix_computer` is effectively one tenant's), but no
  second tenant is asking. Build principles: wait for the customer who does.
- Model upgrade — the 12 calls show starved-model failures, not dumb-model failures.
  Feed it better (A, C), catch it better (guards); re-evaluate only if toolselect
  still fails after those ship.

## The four failure classes (worth checking every future feature against)

1. **Promise-without-artifact** — "message" that isn't (#1), SMS "sent" that dies at
   the carrier, "let me check" with no tool. Never speak a capability the system
   won't produce.
2. **State theater** — checklist ✓ but the write dropped it (role_description;
   `location_type` before it). Host-owned state that the write ignores.
3. **Starved model confabulates** — "no booked time on file", "quarter hour", "Jane".
   An LLM fills information vacuums with fluent guesses; inject ground truth and
   return reasons instead of leaving gaps.
4. **Claim-based trust** — accepting a spoken fact as ownership (the pre-fix OTP
   window; unscoped name correction). Proof binds to the moment and the call.
