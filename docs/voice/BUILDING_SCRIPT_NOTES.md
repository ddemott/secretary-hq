# Building the Call Script — Architecture, Bugs, and Gotchas

A running record of how the voice-agent call flow is built, why, and every bug we hit
getting it to work. Written so a second business — or a second developer — can rebuild
the same thing without re-paying for the lessons.

> ## ⚠️ HISTORICAL — this documents the RUNG (TaskGroup) era, not the live flow
>
> Everything below describes `agent/src/tasks/` (`CallRootAgent`, `makeRung`,
> `planCallTasks`), which ran in prod from 2026-07-18 and was **superseded on
> 2026-07-21 by the question-tree architecture**. It is reachable today only with
> `ENABLE_QUESTION_TREE=false` **and** `ENABLE_TASK_GROUP=true`.
>
> Live calls run `agent/src/checklist/` — see `docs/voice/QUESTION_TREE_ARCHITECTURE.md`
> and CLAUDE.md → `/agent`. **Read this file for the BUGS, not for the design.**
> The failure modes it catalogues (a model that says "booked" with an empty diary,
> a router that swaps its own tool mid-call, an action that fires before its inputs
> are collected) are all still real — the question-tree code guards against each of
> them, and this is where the evidence for those guards lives.
>
> The "VERIFIED SUCCESS POINT" below is a rung-era anchor. It is a valid rollback
> target for that architecture; it is not the current state of the product.

---

## ✅ VERIFIED SUCCESS POINT — 2026-07-15 (rollback anchor: COMMIT HASHES, no branch)

**The task-group call flow works end-to-end on a live voice call.** This is the point to
come back to. Everything below the line is why and how.

The `spike/task-group-ladder` branch was deliberately deleted (2026-07-16 branch cleanup —
hashes beat long-lived branches; everything below is merged into main so these commits are
permanent). To return to the verified point:

```
59651f3ec06695d483c436f2c15b5a4f9ef5a8e5   the spike tip — the exact tree re-verified live 2026-07-16
bce7ba269a7416ebe3b7382de30d20ecbea8e40b   "task-group call works cleanly on VOICE, start to finish"
5fb50d0bb4214183ff02a4e7ad5956c9d7ad190a   PR #264 merge commit into main

git checkout 59651f3                         # inspect (detached)
git branch spike/task-group-ladder 59651f3   # recreate the branch outright
```

Unmerged work preserved by hash in the same cleanup (recoverable, NOT in main):

```
7a61d2da164155ee9c9d6863f283cc6f6c256b66   fix/never-talk-over-the-caller tip (PR #263, closed) —
                                           parks save_customer_preference, talk-over fixes; needs a
                                           rebase over the #266 blocks.ts rewrite.
                                           Recover: git fetch origin pull/263/head
75553c253a95a34028ababd57ca1baf19ce2f6d8   chore/blueprints-plan-and-deno-cleanup tip (no PR) —
                                           Deno/Vapi toolchain removal + blueprints design spec.
                                           Lives only in local git objects until GC (~90 days).
```

What a real voice call did, confirmed in the database:

```
greeting → intent (begin_call) → TASK GROUP:
    identity → book_meeting → job_intake   (every rung completed)
    ✓ appointment: Programming Consultation, real time on the calendar
    ✓ job inquiry: name + phone + BOTH companies + rate + length + location, recorded
    ✓ clean goodbye by name, then hangup — NO re-collection
```

**What works (verified on the call, not just in tests):**

| Behaviour | Status |
|---|---|
| Runs the whole call as host-code rungs the model can't skip | ✅ works |
| Books the right service (semantic match) at a real time (not October) | ✅ works |
| Takes ALL job-intake details, both companies kept apart | ✅ works — the rung that used to get skipped |
| Identity flows to booking (no re-asking the phone) | ✅ works |
| Opens on what the caller already said (no "what would you like?") | ✅ works |
| No "how can I help?" re-ask after identity (positive framing) | ✅ works |
| Natural spoken summary, no markdown/run-on | ✅ works |
| Clean close by name, no end-of-call re-collection | ✅ works |

**What is NOT done yet (honest scope):**

- **6 rungs exist**: identity, book_meeting, meeting_context (rung 3 — TEMPLATE-dispatched:
  'job' is the old job_intake, now linking the inquiry to the meeting; 'default' is one
  wrap-up notes question onto the appointment — added 2026-07-16, Dale's design, see its
  section below), schedule_change (cancel / reschedule — added 2026-07-15 on the generic
  `makeRung` core, the first lookup-then-act rung), take_message (added 2026-07-16 — the
  universal catch-all, an ACTION rung wrapping the real `take_message`), and policy_qa
  (added 2026-07-16 — the caller's QUESTIONS, answered from the knowledge base via RAG;
  see its section below). Still not a rung: page-owner. Adding one is config on
  `makeRung`, not a new class.
- ~~The stack is snapshotted at group start~~ **RETIRED 2026-07-18** — the loop-back
  (roadmap step 3) is implemented: after the group completes, the root agent asks
  "Anything else I can help you with?", a NEW goal re-enters begin_call and runs a
  second group (identity carried over — planCallTasks skips the identity rung when
  the shared state already holds a confirmed name + number), and "no thanks" exits
  through a finish_call TOOL that owns the fixed goodbye. Rounds capped at 3.
- **Text E2E (`sim-taskgroup.ts`) does not exercise the runtime handoff** — only a live
  call does. Keep both.
- **Behind `ENABLE_TASK_GROUP` only.** The agent answering the real phone is the prompt
  ladder, untouched.

**How to grow from 3 rungs to a full receptionist (the roadmap):**

You do NOT code per-request. You code per goal TYPE (a rung), and `begin_call` routes to it.
1. Build a rung per goal the business actually gets — same 5-part pattern, reuse existing
   tools (`cancel_appointment`, `take_message`, `get_company_policy_answer` all exist).
2. Add one boolean to `begin_call` for each, so intent detects it.
3. ~~Add "loop back after the group" plumbing ONCE~~ **DONE 2026-07-18** (Dale: "it
   should have asked, is there anything else"): begin_call is round-capped instead of
   once-only; the group-complete tool result IS the phase change (ask anything-else →
   new goals re-enter begin_call / "no" exits via finish_call, which owns the fixed
   goodbye); identity persists across rounds so re-collection — gotcha H's original
   failure — is structurally off the table.

Each rung is small, safe, isolated (the loop keeps rungs from breaking each other), and has
its own tests. Adding a capability is bounded work, not a rewrite. That is the payoff.

---

## Hardening pass — a LIVE LLM caller, at volume (2026-07-15)

After the live-call success, the harness (`sim-taskgroup.ts`) was upgraded from a *scripted*
caller to a **live LLM caller**: a second model PLAYS the caller from a persona (the facts it
holds + a behavioural style — `plain`, `terse`, `chatty`, `frontloader`, `corrector`,
`rambler`) at temperature 0.9, so it words things differently every run. Same real
tasks/tools/backend/DB; every run verified against the **database**, not the transcript.
Dale's instinct — "real callers word things differently; make it bullet-proof" — was right:
the varied caller found bugs the scripted one never could, immediately.

Run at volume (30–48 runs/pass across the styles), it surfaced three more real faults. All
three fixed at the **shared instruction string**, so both flows benefit:

1. **Root cause 3, caught in the wild — and the fix is REORDERING, not prohibition.** ~1 run
   in 30, the agent gathered every job detail then *said* "I've noted that, I'll pass it
   along" **without ever calling `capture_job_inquiry`**. The instruction already *forbade*
   that exact phrase ("merely saying 'I've noted that' does nothing") — and the model said it
   anyway. **A prohibition cannot beat this; the model doesn't obey "don't."** What worked:
   reorder the action ahead of the speech — *"the instant you have the answers, your VERY
   NEXT action is to CALL the tool — before you say anything back."* Call, THEN confirm.
   Applied the same reorder preventively to the booking rung (say-you're-booked-without-
   booking is the identical failure). This is gotcha G (positive framing) applied to root
   cause 3: don't tell it what not to say, tell it what to do FIRST.

2. **A rung must survive a failed lookup it doesn't need.** `identify_caller` sits in the
   identity rung's toolset but is NOT required to finish it (`confirm_identity` is). When
   `identify_caller` returned an error, the model sometimes spiralled — "I'm having technical
   difficulties…", apology after apology, and it **never called `confirm_identity`**. The
   whole call lost at rung 1, over a tool that was never load-bearing. **Fix:** the rung's
   instructions now say a lookup hiccup never blocks completion — you already have the name
   and number, so call `confirm_identity` and move on. **Watch for:** any rung that exposes a
   tool it doesn't strictly need to complete. Either don't give it the tool (best), or tell
   it explicitly that the tool failing is survivable. A non-load-bearing tool that can derail
   the load-bearing path is a trap.

3. **The lookup error was a LOCAL DB GAP — and it teaches the debugging discipline.** The
   `identify_caller` 500 was `column "phone_verifications.call_id" does not exist`: three
   migrations were unapplied on the dev DB. The tell that cracked it: the 500 hit ONLY
   **returning** callers (the disclosure gate runs only when the customer already exists), so
   across repeated runs it looked *random* — pass, pass, pass, 500 — when it was in fact
   deterministic on "have we seen this phone before". **Get the real trace first:** a
   `SIM_TRACE=1` flag on the harness that logs every tool call + result turned "sometimes
   fails" into "`identify_caller -> {error: Backend returned 500}`", and the backend log gave
   the exact column + stack. One trace beat any amount of guessing. (Lesson mirrors
   `LESSONS_LEARNED.md` #1: measure/trace before fixing.)

**Result:** full suite **30/30 across all six styles**; in-house company-labeling **10/10**
in a focused stress run.

### Second hardening pass (2026-07-15, autonomous)

Fixed the two-companies `represents_company` wobble (a *placing-with-a-client* call
occasionally recorded as in-house) and closed three Copilot review nits. Two durable lessons:

- **DERIVE a fact from the data the model reports RELIABLY, not from a flag it flips.** The
  voice model reliably reports the two company NAMES it heard, but routinely flips the
  `represents_company` boolean. So `resolveJobCompanies` (messaging.ts) now DERIVES it: two
  different names → agency+client (false); same name → in-house (true). The trace showed the
  *residual* failures were a different bug — under the rambler style the model skipped asking
  "which company are YOU from?" and duplicated the client's name into `caller_company`, so
  even the derivation saw "same name → in-house". Fix was in the intake prompt: make
  capturing the caller's OWN company explicit and non-skippable, distinct from the client.
  Together: rambler job-only went from ~1-in-4 failing to **10/10**, full suite **19/19**.
- **The booking RPC wants a TARGETED window, not a wide one to scan.** `book_with_scheduling`
  with a wide multi-day window whose earliest slot is occupied COLLIDES ("already booked")
  rather than advancing — because the live agent always calls `get_available_slots` first and
  passes `window_from` = a known-open slot. The E2E seed learned this the hard way (a
  contended single-employee calendar): the seed now finds a real open slot via
  `available-slots`, then books that exact time. Also: a seed failure now skips that one run
  instead of throwing and crashing the whole suite.

### The take-message rung (2026-07-16, autonomous)

The 5th rung, and the clearest demonstration yet of WHY the task-group flow exists. It came
straight off a live prompt-ladder call that failed the way the ladder always fails.

**The failing call (prompt ladder).** A caller: "I'd like to leave a message for the owner…
tell him I have a job for him, and I'd like him to give me a callback." The agent collected
the name, the number, the message — then said *"I've passed that message along to the owner"*
and hung up. **`take_message` never fired. Nothing was saved.** The backend log confirmed it:
no `/agent-tools/take-message` call, no `customer_messages` row. Root cause 3 in its purest
form (a sentence is free, a tool call is work), and two rounds of prompt wording on the ladder
— including the exact instruction "saying it saves nothing, CALL the tool" — did not beat it.
The model narrated the save anyway. There was also an "out of order" tell: the ladder asked
for the message body before it had the caller's name, because the ladder sequences itself.

**The fix is structural, not more prompt.** `take_message` becomes an ACTION rung
(`takeMessageTask.ts`) wrapping the real tool; the rung completes only on a real `message_id`.
The TaskGroup loop cannot end until it does, so "I've passed that along" advances nothing —
the identical fix that stopped job-intake being skipped. Ordering fixes itself too: identity
is always rung 1 (`planCallTasks`), so the "asked for the message before the name" tell cannot
happen. `begin_call` gained a `wants_to_leave_message` boolean; the rung is placed after
book + intake, mirroring the composed-script ELSE order.

**One disambiguation the rung must carry.** A message that MENTIONS a job or a callback is
still a message — the caller ASKED to leave one. The intent step sets `wants_to_leave_message`
(not `has_job_inquiry`) for "leave a message… I have a job for him", and the rung's
instructions say a job/callback word inside a message does not send it back to booking or role
intake. Without this the widened job trigger swallows the message.

**Verified (sim, not yet a live mic call).** `sim-taskgroup.ts` gained two scenarios — a plain
message, and the job+callback message above — checked against a real `customer_messages` row
(not the transcript). **30/30 across plain/terse/chatty/frontloader**; the job+callback case
records a message and NO job inquiry every run. Unit: `takeMessageTask.test.ts` +
`callPlan.test.ts` (order + tool-narrowing). Gotcha #8 applied: the rung carries NO passthrough
tools — `take_message` is the completion and it needs nothing else, so there is nothing to
misfire. **Still unproven:** a live voice call (STT/TTS/turn-taking + the `voice_sessions`
row), exactly as with scheduling — the sim skips the runtime handoff.

---

### The policy-Q&A rung — RAG answers as a rung (2026-07-16, autonomous; Dale's ask)

Dale: "what if the user wants to ask questions about the company, pricing, hours of
operation… this has to do with the RAG." The retrieval layer already existed end-to-end
and measured 100% on the sim-rag eval (get_company_policy_answer →
/agent-tools/policy-answer → search_tenant_docs pgvector, honest out-of-scope fallback,
gap-logging for the owner). What was missing was FLOW: nothing guaranteed a
questions-call ends properly, and on the ladder, hours and prices are exactly the facts
a model invents most fluently.

**The design (policyQaTask.ts):** a COLLECT rung with an ACTION fallback — the
scheduling rung's multi-completion pattern.

- Tools: ONLY get_company_policy_answer (retrieval is the point of the rung; rule 8).
- Exit 1: `questions_answered` (synthetic — curiosity has no success id).
- Exit 2: the REAL take_message. The policy route's own fallback text offers "I can
  take a message so the owner gets back to you" — a rung that spoke that offer while
  holding no tool to perform it would promise a save it cannot make, which is the
  bug class this whole week was spent killing. The write is the transition.
- `begin_call` gains `has_questions`; the rung is planned after identity and BEFORE
  the booking on mixed calls — the book-first doctrine exists because callers hung up
  unbooked after answering nine of OUR questions, but Q&A is THEIR questions, and
  nobody picks a time before hearing the price. The loop still cannot end with a
  flagged meeting unbooked.

**THE ONE DOCTRINE CHANGE — identity is now conditional (flagged for Dale's review).**
A questions-ONLY call plans `[policy_qa]` with NO identity rung: a caller asking "when
are you open?" must not be interrogated for a name and number before getting an answer.
Identity remains the floor under every contact-needing goal (booking, message, role,
change); pure curiosity has none. If the caller's questions turn into "have the owner
get back to me", the rung gathers name+number itself and take_message's backend gate
enforces them. This is the first exception to "identity is always rung 1" in
planCallTasks, deliberately narrow, and trivially revertible (one `if`).

**E2E:** sim-taskgroup gained a `seedKnowledgeBase` helper (through the REAL
/knowledge/add ingestion — real embeddings — for the same reason seedAppointment books
through the real RPC) and two scenarios: QUESTIONS-ONLY (the $149 figure exists only in
the seeded KB, so if it reaches the transcript the answer came from retrieval; the
transcript must also NOT contain a number shakedown) and QUESTIONS-then-BOOKING (price
answered first, meeting still lands in the DB).

**What the live-LLM hardening pass found (same day), both caught by the new scenarios:**

1. **The island denied an ability the call had.** Mid-questions the caller said "can I
   go ahead and book?" and the rung — holding no booking tools — truthfully said "I
   don't have the ability to book sessions directly." The caller gave up; by the time
   the queued booking rung offered real times they had disengaged. 0/4 on the mixed
   scenario. Root cause 1 wearing a new coat: the rung didn't know what follows it.
   Fix: `bookingFollows` — when a booking rung is queued, "I want to book" IS the
   completion cue (call questions_answered; the booking step takes over in the same
   breath), and the rung may never claim it cannot book. Without a booking queued, the
   rung offers a REAL recorded message instead of a dead "I can't". 3/3 after.

2. **A hallucinated price with a fake citation.** One run in six, the model answered
   "$100 per hour" — a figure existing NOWHERE — prefixed "according to our pricing
   policy", having said "let me check… one moment" and emitted a literal "…" to
   role-play the lookup it never made (the exact behavior in toolPhases.ts's header,
   now inside a rung). Root cause 3: retrieval has no natural WRITE to weld the answer
   to, so the tool call cannot be made the rung's exit per-question. Mitigation is the
   ladder's proven wording (tools return IN AN INSTANT — never "one moment"; your first
   action on an already-asked question is the tool call; a price you did not just read
   out of a tool result is a price you are making up): 8/8 after. HONEST RESIDUAL: this
   is prompt discipline, not structure — the transcript-fact check in the sim (the $149
   only exists in the seeded KB) is the guardrail that keeps this class visible.

**Still unproven:** a live mic call (as ever), and the questions-then-BOOKING order on
voice. Known limit unchanged: a goal that only EMERGES mid-call (pure Q&A caller decides
to book after the plan snapshot) still needs the "re-run intent after the group"
loop-back from the roadmap.

### The MEETING-GOALS rung — rung 3 generalized into templates (2026-07-16, Dale's ask)

Dale's design: rung 3 is not "the job rung" — it is **what the meeting needs attached to
it**, and that varies by goal exactly the way the composed script blocks' INTAKE varies
by vertical. So `meeting_context` replaced `job_intake` in the plan, dispatched by
TEMPLATE (`meetingContextTask.ts`):

- **'job'** (selected by `has_job_inquiry`) — the existing job intake, unchanged, PLUS:
  the `job_inquiries` row now carries an `appointment_id` FK to the meeting it was
  booked around, and the capture route stamps a `Job details: …` summary into the
  appointment's description. The owner opens the calendar entry and sees what the
  meeting is ABOUT.
- **'default'** (every other booked meeting) — ONE light wrap-up question ("anything
  you'd like us to know ahead of the meeting?"). An answer is written by the new
  `attach_meeting_notes` tool (`Caller notes: …` onto the appointment); "no" exits via
  a synthetic `no_notes`; `take_message` rides along as the honest fallback. A future
  vertical (fixing a car) is a NEW TEMPLATE here, not a new rung.

**The plumbing rule that makes it safe: THE SYSTEM CARRIES THE MEETING ID, never the
model.** `CallOutcomeTracker` already records the booked `appointment_id`;
`capture_job_inquiry` and `attach_meeting_notes` read it from there inside their
`execute` (same trust model as `spokenPhone`). The model never sees a UUID, so it can
never attach to the wrong meeting. The backend still verifies the id belongs to the
tenant, and on a miss saves the inquiry UNLINKED — the row is the lead, the link is
context.

**Host-code skip:** the notes rung's factory runs AFTER booking and reads
`CallState.appointmentId` (what HAPPENED, not what was asked). Booking fell back to a
message → a `SkipRung` completes in `onEnter`, no LLM turn, no audio — the caller is
never asked about a meeting that does not exist. Same state also fixed the job opener:
"you're booked in" now only opens the intake when something actually was.

**What the live-LLM hardening pass found (same day):**

1. **The model invented a note.** ~1-in-3 chatty runs attached "Consulting work
   discussion." — a topic label the caller never spoke — without asking the question.
   Root cause 3 again (a sentence-shaped step with a write available). Mitigation:
   ASK-FIRST wording + "the MEETING TOPIC is NOT a note" + "never attach a note whose
   content the caller did not actually say". 8/8 after. HONEST RESIDUAL: prompt
   discipline; the sim's `descriptionMatch` check (the COBOL token can only reach the
   description through the tool) keeps this class visible.
2. **An evening run turned every booking into a message.** `get_available_slots` for
   TODAY is empty after close, and the booking fallback's trigger read "no open times →
   take a message" LITERALLY — the model messaged instead of offering tomorrow.
   Pre-existing wording bug in `BOOK_MEETING_INSTRUCTIONS`, exposed by running the sim
   in the evening. Fix: "no open times on ONE day does NOT mean the booking cannot
   happen — check the next day and offer those times." Full suite 30/30 after.

### The address curveball — the information is the note; the mention of it is not (2026-07-18)

Dale went off script on a live call: "he needs to know my address because he's
gonna be fixing my computer." The agent attached exactly that sentence as the
note — a POINTER to an address, containing no address — said "I've added that
to the meeting," and the owner would have opened the calendar with nowhere to
go. Everything else on the call was perfect (intent correctly classified as
NOT a job, the notes rung fired, the tool really ran); the note was just
useless.

Two instruction lessons, both proven by the sim's new two-stage persona (the
caller says only the pointer, and reveals "1060 West Addison" ONLY if asked):

1. **A conditional must live INSIDE the imperative bullet, ahead of the
   action.** The first fix added a beautiful "ask for the thing itself" rule
   as its own bullet BELOW "your VERY NEXT action is to CALL
   attach_meeting_notes" — and lost 2/2 sim runs: the model executed the
   imperative it read first. Restructured so the pointer-check is step 1 of
   the same bullet and the CALL is step 2 ("otherwise"), it passed. A rule
   that arrives after an imperative is a rule that never runs.
2. **The ask itself needs the same imperative armor as the action.** The
   remaining failures were the model attaching a topic label WITHOUT ever
   asking the wrap-up question. "ASK FIRST" (a description) became "your VERY
   NEXT action is to ASK" plus a hard gate — "attach_meeting_notes may only
   run AFTER the caller has ANSWERED" — and the full suite went 32/32,
   including the historical ~1-in-30 topic-label residual going quiet in the
   same run.

3. **When the judgment flaps, add the deterministic layer under it.** With both
   wording fixes in, the pointer-check still flapped (2/2, then 1/2 across sim
   runs — gpt-4o-mini judgment at instruction level). The FULFILLMENT GATE in
   attach_meeting_notes is the code layer: a note that NAMES an address/number/
   code and contains NO DIGIT is bounced with the action the model can take
   ("ask the caller for the thing itself, then attach what they say" — the
   satisfiable-error rule). The sim log shows the whole loop working: pointer
   attached → gate bounces → model ASKS → real address attached. Escalation
   order, generalized: instruction → instruction ordering → code gate.

**Status: sim-verified 32/32 with the gate (two-stage persona, both styles); the
live-call replay is the remaining gate.**

---

**Two flows exist in the codebase. Know which you are reading about:**

1. **The prompt ladder** (shipped, default). The whole call is one big system prompt with
   an `IF/THEN` "ladder". The model sequences the call itself. Lives in `agent/src/prompt.ts`
   + a per-tenant script composed from `src/services/scripts/blocks.ts`.
2. **The task-group flow** (spike, behind `ENABLE_TASK_GROUP`). The call is a LiveKit
   `TaskGroup` of host-code rungs the model *cannot* skip. Lives in `agent/src/tasks/`.

The task-group flow is the direction of travel — it fixes the class of bug the prompt
ladder keeps hitting (the model skipping a step). This doc covers both, but leads with the
task-group flow because that is what to duplicate.

---

## Why we moved from prompt → task-group

The prompt ladder failed the same way over and over, on real calls: **the model would
complete one of the caller's goals and hang up with the second undone.** "I'd like a
meeting to talk about a job" is two goals — book the meeting AND record the job details —
and the model booked, then said goodbye. We tried to fix it with prompt text ("the call is
not over until every goal is done") and the model ignored it. Twice.

We researched what others do (Pipecat Flows, Parlant, Rasa CALM, LiveKit). The finding:

> You built the right thing one layer too high — in **prompt-space, where the model can
> decline to cooperate** — when the framework you already run offers the same control in
> **host-code, where it can't.**

The proof it was architectural, not a prompt/model problem: we swapped `gpt-4o-mini` →
`gpt-4.1-mini` and the eval score did **not** move (63% both, failing set still rotating).
A better model does not fix "the model skipped a step." Taking the sequencing away from the
model does.

**LiveKit ships the fix in the version already in `node_modules` (`@livekit/agents` 1.4.5,
`beta/workflows`).** `TaskGroup.onEnter` is a `while (taskStack.length > 0)` loop in host
code, and `complete()` sits AFTER the loop. The model has no tool to exit early. It cannot
narrate its way past a rung and cannot hang up with a goal unmet.

---

## The task-group architecture (what to duplicate)

```
Incoming call
   │
   ▼
index.ts entry ── speaks the tenant's PRE-GENERATED greeting (zero TTS latency)
   │
   ▼
CallRootAgent  ── the INTENT step. One tool: begin_call(wants_meeting, has_job_inquiry, …).
   │              The model's ONLY job here is to classify the ask into booleans.
   │              (Classifying one sentence = the thing LLMs are reliably good at.
   │               Sequencing a 5-step call = the thing they are bad at.)
   ▼
begin_call.execute → planCallTasks(goals) → buildCallTaskGroup() → await group.run()
   │
   ▼
TaskGroup loop (HOST CODE — the model cannot break out):
   IdentityTask     → get name + phone, read back, confirm → complete({name, phone})
   BookMeetingTask  → offer real slots, book               → complete on appointment_id
   JobIntakeTask    → walk the intake questions, record    → complete on job_inquiry_id
   │
   ▼
group.run() resolves only when the stack is EMPTY → root agent says goodbye
```

### The pieces (`agent/src/tasks/`)

| File | Role |
|---|---|
| `rung.ts` | **The generic rung core.** `makeRung(cfg)` builds an `AgentTask` with onEnter + ttsNode + completion-in-a-tool baked in. Every rung is built from it. |
| `callRootAgent.ts` | Greets, classifies intent via `begin_call`, runs the group inside that tool. |
| `callPlan.ts` | `planCallTasks(goals, deps)` → ordered `TaskSpec[]`. **This is the checklist.** Pure. Also `runtimePreamble`, `knownCallerLine`, `pick`. |
| `identityTask.ts` | Rung 1 — a COLLECT rung. Name + phone via `confirm_identity`. |
| `bookMeetingTask.ts` | Rung 2 — an ACTION rung. Wraps the real `book_with_scheduling`; completes on `appointment_id`. |
| `meetingContextTask.ts` | Rung 3 — MEETING GOALS, dispatched by TEMPLATE. 'job' → the job intake; 'default' → one wrap-up notes question (ACTION `attach_meeting_notes` OR COLLECT `no_notes`, `take_message` fallback). Skips in host code (`SkipRung`, completes in onEnter) when no meeting actually landed. |
| `jobIntakeTask.ts` | The 'job' TEMPLATE — an ACTION rung. Wraps the real `capture_job_inquiry`; completes on `job_inquiry_id`. The runtime injects the booked `appointment_id` so the inquiry links to the meeting. |
| `takeMessageTask.ts` | Rung 4 — an ACTION rung, the universal catch-all. Wraps the real `take_message`; completes on `message_id`. Carries NO passthrough tools (take_message IS the completion). |
| `policyQaTask.ts` | The Q&A rung — COLLECT (`questions_answered`) with an ACTION fallback (the real `take_message`). Holds ONLY `get_company_policy_answer`; every factual answer comes from retrieval. Questions-only calls skip identity (the one doctrine exception). |
| `schedulingTask.ts` | Rung 5 — a LOOKUP-THEN-ACT rung. Reads `get_my_appointments`, then completes on `cancel_appointment` OR `reschedule_appointment` OR `no_appointment_change`. |
| `../scripts/sim-taskgroup.ts` | E2E harness — runs the real tasks/tools/backend/DB with a **live LLM caller** (a second model plays the caller across phrasing styles). `SIM_TRACE=1` logs every tool call + result. |

### The GENERIC rung — one shape, a few TYPES (`rung.ts`)

A rung is DATA now, not a bespoke class. `makeRung(cfg)` takes `{ instructions, tools, completion }`
and returns a real `voice.AgentTask` with every rung guarantee baked in by CONSTRUCTION —
onEnter speaks, ttsNode strips markdown, and completion lives inside a tool. The
business-specific part is only the config. This killed the copy-paste that let a fourth rung
drift (forget the onEnter → dead call). There are exactly **two completion modes**, and every
rung so far — and every one we foresee — is one of them:

| TYPE | Completion mode | "Done" is… | Rungs |
|---|---|---|---|
| **Collect** | a synthetic confirm tool | the model has gathered + confirmed the facts | identity |
| **Action** | wrap the real doing-tool | the backend write returned its success id | book, job-intake, scheduling |

A **lookup-then-act** rung (scheduling) is just Action with a read tool added to `tools` and
**more than one** completion — `makeRung` accepts an array, and the first to succeed wins.
Scheduling carries three: cancel, reschedule, and a narrow `no_appointment_change` escape so a
caller with nothing upcoming can't hang the loop. Adding a business's rung is now: pick the
TYPE, write the instructions, list the load-bearing tools, name the completion. Nothing else.

To add a rung generically: `makeRung({ instructions, tools: pick(deps.tools, [...]), completion })`
where `completion` is one `{kind:'collect', …}` or `{kind:'action', …}` (or an array for a
multi-ending rung). Then register it in `planCallTasks` behind its goal flag and add the flag to
`begin_call`. The `idExtractor(idField, build)` helper turns any tool's success-id JSON into a
typed result, so an Action completion is usually one line.

### The core idea, in one sentence

**A task is an Agent with its own instructions and its own tools, and it ends ONLY when
something calls `this.complete()` — and `complete()` is called from inside a TOOL.** So
the only way out of a rung is to do the work. "Let me check…" advances nothing. "Have a
great day" advances nothing. The transition IS the tool call. (Pipecat calls this "routing
lives on the function.")

### How to add a new rung (the recipe)

1. Extend `voice.AgentTask<ResultT>`.
2. In the constructor, take the **real** tool(s) from `buildTools()` — do not reinvent them.
3. **Wrap** the tool whose success means "rung done": call the real execute, inspect its
   returned JSON for the success id, and if present call `this.complete(result)`.
4. Add `override async onEnter() { this.session.generateReply(); }` — **required, see
   gotcha #4.**
5. Add the markdown `ttsNode` override (gotcha #5) or the rung will read markdown aloud.
6. Register it in `planCallTasks` behind its goal flag, in the right order.
7. Thread any state it needs from earlier rungs via `CallState` (gotcha #2).

**And the four rules the hardening pass proved you cannot skip (each cost a lost call):**

8. **Give the rung ONLY the tools it needs to complete.** A non-load-bearing tool (a lookup
   the rung doesn't need to finish) that can error will sometimes derail the load-bearing
   path — the model apologises about the failed tool and never calls the completion tool.
   If a rung must carry such a tool, its instructions MUST say the tool failing is survivable
   ("you already have what you need — call `<completion_tool>` and move on"). Best is not to
   give it the tool at all (root cause 2 / gotcha #3).
9. **ACTION-FIRST wording: "call the tool, THEN confirm" — never the reverse.** The model
   will substitute a confirmation *sentence* for the completion *tool call* if the wording
   lets it. Write: *"the instant you have what you need, your VERY NEXT action is to CALL
   `<tool>`, before you say anything back."* This is the reliable defence against root cause
   3 inside a rung (the task-group structure defends the *ordering* of rungs; this defends
   *within* a rung).
10. **Positive framing, always (gotcha G).** Tell the rung what its next action IS, not what
    not to say. Prohibitions (even naming the exact bad phrase) do not reliably stop the
    model — reordering the instruction to a positive "do X first" does. Reserve negations for
    hard prohibitions where the prohibition itself IS the instruction ("never offer a time
    not in the list").
11. **Every fact from an earlier rung goes in THIS rung's instructions, not just the chat
    context.** A task's system prompt is fresh; the chat history carries the conversation but
    the model acts on its *instructions*. Inject the caller's name/number/prior-answers
    explicitly so the rung doesn't re-ask (root cause 1 / gotcha #6).
12. **An ACTION rung's tool MUST be idempotent per call, and its reply must not carry
    side-effect latency.** (2026-07-17, the first live firing of the job-linked meeting
    rung.) The rung contract is "retry until you hold the success id" — which means a SLOW
    response is indistinguishable from a FAILED one: prod's SMTP was unreachable, the
    capture route AWAITED the owner email (60–120s to fail), every reply blew the agent's
    8s tool timeout, and the rung did exactly its job — retried — while the route did
    exactly its job — inserted. FOUR identical `job_inquiries` rows, four "Job details:"
    stamps on one appointment, and the caller heard "having issues writing to the system"
    about writes that had all succeeded. Two rules, a pair: (a) dedupe on `(tenant_id,
    call_id)` — a retry returns the EXISTING id and writes nothing, so retrying converges
    instead of multiplying; (b) best-effort side effects (owner email) are fire-and-forget
    with a metric + 5W log — "best-effort" awaited inline is not best-effort, it is a
    caller standing in dead air behind an SMTP handshake. Audit every ACTION-rung tool for
    both properties (take_message and page_owner_via_sms await `sendSms` inline — Telnyx is
    fast today, but the class is the same).

13. **An unskippable rung must carry an escape for the case where the RUNG was the
    mistake.** (2026-07-18, a live call.) Intent flapped "fix my computer at my house"
    into has_job_inquiry=true — deliberately, since the router over-counts on purpose —
    and the job rung's great virtue (the model cannot skip it) became a trap: the caller
    said "this is for fixing my computer" three times, asked to leave a message, was
    told "I can't take messages" (the rung holds no such tool — honest and terrible),
    and hung up. The cure is the scheduling rung's no_appointment_change pattern,
    generalized: every rung whose PLANNING can be wrong gets a narrow synthetic exit
    (not_a_job) whose instruction OUTRANKS the interview and sits FIRST (the ordering
    lesson: a rule below an imperative never runs). With the loop-back live the
    recovery is complete: escape → group finishes → "anything else?" → the caller's
    real need re-enters begin_call. Sim-pinned with a MISROUTE scenario that plans the
    job rung against a caller who denies having one: booking lands, no inquiry row is
    fabricated, the run completes. "Narrowing must never remove an exit" — and neither
    may certainty of purpose.

    **Corollary (same day): the escape covers "wrong rung"; a caller on the RIGHT rung
    can still refuse to walk it.** Dale's question — "in the middle of asking for a job
    can someone ask just to leave a message instead?" — and the answer was no: the job
    rung held no take_message, so a real recruiter in a hurry got the same refusal as
    the misrouted repair caller. take_message is now a third COMPLETION of the job rung
    (mirroring the booking and notes rungs' fallback — an offer to "pass it along" must
    always have a write behind it), with an instruction bullet: never refuse a message;
    calling take_message IS taking one. Rule 8 ("a rung sees only its load-bearing
    tools") is unviolated — a completion is load-bearing by definition. Sim-pinned with
    a MID-INTAKE BAIL scenario (real job caller who refuses the detail questions):
    customer_messages row lands, no job_inquiries row, rung completes.

    **Second corollary: the escape is the net, not the fix — teach the router the
    boundary.** A SECOND live call (2026-07-18, ~7 AM) flapped "can someone come to my
    house and fix my computer" into has_job_inquiry=true again; the escape fired
    (booking preserved, no fabricated row) but the caller still heard "which company
    are you calling from?" after booking a repair visit, and the escape turn deflected
    to "reach out to technical support" — at the business that IS the technical
    support. The flag's DEFINITION was the bug: "mentioned a job, role, contract,
    project, or hiring" matches a service request, where "the job" is the work, not a
    role. Redefined in both places the model sees it (instruction bullet + schema
    description) as a role brought TO the owner (recruiting/staffing/hiring) vs work
    requested FROM the business, with an explicit carve-out on the when-in-doubt rule.
    Pinned in sim-begincall (the eval that reads the REAL instructions off the
    instance): the repair opener failed 2/3 runs pre-fix, 30/30 post-fix, including a
    recruiter-pitch guard so the true direction cannot regress.

14. **Anything the caller says BEFORE a rung exists is invisible to that rung — thread
    volunteered facts through state, or they evaporate.** (2026-07-18 live call.) The
    caller opened with "I'm Dale. And I would like to have my computer fixed"; the very
    next agent line was "Can I get your name, please?" Each rung is a separate agent
    with its own prompt (that is the architecture's strength), so the identity rung
    never HEARD the opener — only the root agent did, and begin_call had no way to
    carry a name. The fix is the CallState pattern from the first E2E (a confirmed
    number was invisible to the booking rung) applied one layer earlier: begin_call
    gained optional caller_name/caller_phone ("ONLY if the caller stated it — never
    guess"), the root agent seeds state.volunteeredName/Phone (confirmed values always
    win), and the identity rung greets a volunteered name instead of asking, while a
    volunteered PHONE still gets the read-back confirm (spoken ≠ carrier-attested; the
    trust ladder is untouched). Caller-ID beats a volunteered number — two competing
    instructions about the same digits is how a model picks the wrong one. Pinned at
    every layer: unit (rung wording, schema optionality, state threading), eval
    (front-loaded opener must relay caller_name), and a live E2E scenario whose
    transcriptForbid catches the re-ask phrasings verbatim.

15. **A fallback whose trigger can't fire is no fallback — enumerate the triggers, then
    gate the one only code can see.** (2026-07-19, found by the failure-injection E2E
    Dale commissioned, not by a live call — the first bug this project caught BEFORE a
    caller did.) The booking rung's message fallback triggered on "several days with no
    open times" or caller preference. But when the booking WRITE is down and
    availability is healthy, neither fires: the sim showed the agent four days deep in
    fail → offer new times → caller accepts → fail again, forever. The model cannot
    count its own failures reliably — code can. The gate: the wrapped booking tool
    counts consecutive failures; at 2 the tool RESULT becomes "BOOKING SYSTEM DOWN —
    stop offering times, call take_message now" (the tool result is the phase change,
    the same mechanism as the loop-back). Counter resets on success so a flaky-but-
    recoverable path never forces a message. Harness note: sim-taskgroup scenarios can
    now inject failures via `wrapTools` (failTool) — the sad paths of the BACKEND are
    E2E-testable without breaking the backend.

### How to duplicate for a new vertical

The intake rung is the only vertical-specific piece. A real-estate line is the same
identity + book rungs with a different intake rung (buyer/seller/agent branches). Mirror
`jobIntakeTask.ts` → `realEstateIntakeTask.ts`, register it under a new goal flag. Same as
the prompt ladder's swappable `INTAKE_*` blocks in `src/services/scripts/blocks.ts`.

---

## THE GOTCHAS (the things that cost us real calls)

These are ordered by how much time they burned. Every one passed unit tests and only a
whole-call run exposed it — **which is the meta-lesson: test the assembled call, not the
pieces.**

### 1. Tasks are BLIND to runtime context (date, hours) — they book October

Each task has its OWN instructions, which **replace** the system prompt where `buildSystemPrompt`
injects the current date and business hours. So inside the booking rung the model didn't
know what "today" was and queried availability for **October**, hit the "nothing that day"
fallback (raw soonest-from-now times like *1:41 PM*, drifting minute to minute), and every
`book_with_scheduling` failed `EMPLOYEE_NOT_SCHEDULED`.
**Fix:** `runtimePreamble(rt)` — "Today is X, we are open Y" — prepended to every rung.
**Watch for:** any new rung that reasons about time needs the preamble.

### 2. State does NOT flow between rungs — booking re-asks for the phone

Identity captured and confirmed the phone; the booking rung then asked for it *again*,
because each task is a separate agent with a fresh context and `book_with_scheduling`
**requires** a phone parameter. The booking failed.
**Fix:** a shared mutable `CallState` object in `deps` — identity writes `{callerName,
callerPhone}`, later rungs read it (their factories run *after* identity completes, so the
value is there). Also: identity sets `ctx.spokenPhone` so backend tools can fall back to
it, and the booking wrapper **defaults** the known name/phone into the call so a model that
forgets to pass them still books.
**Watch for:** anything a later rung needs that an earlier rung learned MUST go through
`CallState`. The chat context carries the conversation, but a task's *system prompt* is
fresh, so put facts a rung must act on into its instructions explicitly.

### 3. Passing the WHOLE toolbox to a task defeats the whole point

`BookMeetingTask` was handed `deps.tools` (all 24 tools). The model reached past the clean
`get_available_slots` (15-minute grid) for `get_scheduling_options` (raw resource times)
and had the bug-#3 traps `book_appointment`/`check_availability` available too.
**Fix:** `pick(tools, [...])` — each rung gets ONLY its own tools. Booking gets exactly
`get_available_slots`, `get_service_catalog`, `book_with_scheduling`. Nothing else.
**Watch for:** the temptation to "just pass everything." A tool a rung does not have is a
tool the model cannot misfire. This is the narrow-toolset benefit TaskGroup gives you — but
only if you actually narrow.

### 4. A task with no `onEnter` takes over and sits SILENT — the call hangs

First live call: `begin_call` fired, the group started, `IdentityTask` became the active
agent — and said nothing while the caller repeated "hello? you there?". An `AgentTask` does
not speak on entry unless you tell it to.
**Fix:** `override async onEnter() { this.session.generateReply(); }` on every conversational
rung. (The shipped `WarmTransferTask` defines `onEnter` for the same reason.)
**Watch for:** every new rung needs this. It is the easiest thing to forget and it produces
a totally dead call with no error in the log.

**Meta-gotcha:** our text E2E harness (`sim-taskgroup.ts`) drives the tasks' tools directly
and does **not** exercise the real `TaskGroup.run()` agent-swap. So it validated task logic,
state flow, and DB writes — but could NOT catch the missing `onEnter`. Only a live voice
call did. The harness is necessary but not sufficient; a real call is still the final gate.

### 5. Markdown reaches TTS on the task path — the summary reads as a run-on

The main path strips markdown via `SpeakingAgent.ttsNode`. The task agents are plain
`voice.Agent`, so a model that answered with a **bulleted summary** ("- Caller Company: ABC
- Client Company: Northern Trust") had its dashes and newlines read straight to Deepgram,
which collapsed them into one flat run with no pauses. Reported as "it ran the lines
together."
**Fix (two parts):** (a) add the `ttsNode` sanitizer override to every task agent AND
`CallRootAgent`; (b) instruct the intake rung to confirm in ONE natural sentence, never a
bulleted/field-labelled list — a list has no sentence boundaries so TTS never pauses.
**Watch for:** any new agent on this path needs the `ttsNode` override, or markdown leaks
to voice.

### 7. The root agent's persona must NOT be the ladder — a 10k-token contradiction loses calls

index.ts passed the FULL prompt-ladder system prompt (buildSystemPrompt output, ~10.5k chars
incl. the tenant's composed RUNG script) as CallRootAgent's `persona`. So the intent agent's
prompt was 130 lines of "run the call yourself — ask their name, take the message, here is
RUNG 4" followed by 14 lines of "your ONE job is to call begin_call". Which text won was a
coin flip per call: on 2026-07-16 a booking call handed off fine, and a leave-a-message call
20 minutes later never called begin_call at all — the root agent ran the ladder's
take-a-message script conversationally, held NO take_message tool, and the caller's message
was heading for a narrated save with nothing behind it. Zero tool calls in the entire call.
**Fix:** the root agent gets an IDENTITY LINE ("You are <persona_name>, the AI receptionist
for <business>"), never a script; the rungs carry their own instructions.
**Watch for:** any agent whose prompt embeds instructions meant for a DIFFERENT layer. And a
sober eval note: a single-turn text replay (sim-begincall.ts) could NOT reproduce this even
with the identical prompt at temperature 0 — the failure only manifested on the live voice
path. Some of these only a real call catches (gotcha F applies to prompts too).

### 6. Asking for something the caller already said

After identity, the booking rung opened with "What would you like to book a meeting for?" —
but the caller had said "a meeting about a job" at the very start. The task *received*
`requestedService` but didn't use it in its instructions.
**Fix:** inject "the caller ALREADY told you: '<their words>' — do not ask, go straight to
`get_available_slots`" into the booking instructions when `requestedService` is set.
**Watch for:** any fact captured before a rung should be reflected in that rung's opening so
it doesn't re-ask. Re-asking a known thing is the single most common "it sounds robotic"
complaint.

---

## Cross-cutting gotchas (bite BOTH flows)

These are not task-group specific — they burned us on the prompt ladder too and will bite
any voice agent.

### A. `??` does NOT fall through on `""` — and LLMs emit `""` constantly

`args.callback_phone ?? ctx.callerPhone` keeps an empty string, because `""` is not nullish.
A model sending `callback_phone: ""` both sends the empty string AND blocks the fallback.
**Fix:** a `blank()`/`firstPhone()` helper that treats whitespace as absent. Same bug bit
the dashboard customer-update (a blank email `""` failed `.email()` and 400'd an unrelated
name change). **Normalize blanks at the boundary, for every optional string.**

### B. The transcript is a GUESS about the truth, not the truth

Background noise became the word "Now", the agent took it as a time choice, and booked a
slot the caller never picked. STT on a phone line is lossy.
**Fix:** never book/act on a value that isn't clearly an answer to what was asked. "Yeah"/
"okay" are agreement, not a choice of time. If unsure which option they meant, ASK AGAIN.
Also: raise VAD `activationThreshold` (0.5→0.6) and `minSpeechDuration` (50ms→200ms) so a
cough isn't heard as speech, and `minSilenceDuration`/endpointing so a pause mid-phone-
number doesn't end the turn.

### C. The model narrates instead of acting

"Let me check availability…" then it never calls the tool — because a *sentence* satisfies
the instruction and a *tool call* is work. The prompt ladder had a line telling it to say
"one moment" before a lookup; that line was the CAUSE — it let the model narrate. The
task-group flow kills this structurally (the transition IS the tool call). On the prompt
path: remove any instruction to "announce" a lookup; let the runtime watchdog speak, not
the model.

### D. The runtime watchdog must not talk OVER the caller, and must not lie

The dead-air watchdog watched the AGENT for silence and fired "one moment while I check"
even when (a) the caller was mid-sentence, and (b) no tool was running (it was just LLM
latency). Two fixes: only fire when a tool is genuinely in flight (`isToolRunning()`), and
if it must fire on pure think-time say a neutral "Just a moment" that claims nothing. **A
machine that fills the silence while waiting for a human to answer is talking over them.**

### E. Never hardcode a real person's name in shared code

"I'll have **Dale** get back to you" was hardcoded in a route every tenant shares — so a
salon's caller heard it. There's now a test (`tests/noHardcodedNames.test.ts`) that fails
if a real identifier appears in shipping code. Use tenant data or a neutral word.

### H. After the group ends, the ROOT AGENT re-collects — close the session

The task-group flow runs inside `begin_call.execute` on the root agent. When
`group.run()` returns, control falls back to that root agent — whose instructions are
the START-of-call intent step ("understand the ask, collect identity"). It has no
memory that the sub-agents already booked and recorded everything (they were separate
agents with their own contexts). So with nothing left to do, it reverts to its opening
job and **asks for the name and phone AGAIN**, after the entire call was done. Seen on a
real call: "...I've passed those along to Dale. Is there anything else? … Great! I'll
need your name and the best phone number to reach you at."
**Fix:** when the group completes, DON'T hand back to the free-running root agent. Speak
a fixed, definitive goodbye (no LLM generation, no "anything else?" that invites more)
using the name from `CallState`, then `session.close()`. The rungs already confirmed the
concrete outcomes as they happened, so there is nothing left to say.
**Watch for:** any point where a sub-flow returns control to an agent whose instructions
are for a DIFFERENT phase of the call. The returning agent doesn't know what the
sub-flow did — end the call, or update its instructions to match the phase.
**Evolution (2026-07-18):** the fixed-goodbye-immediately rule is superseded by the
loop-back — control DOES return to the root agent now, but through the narrow door
this gotcha demands: the begin_call tool RESULT is the phase change (the JS SDK has no
updateInstructions), the base instructions carry a "# After the work is done" section,
identity persists so a second round plans NO identity rung, and the goodbye lives in a
finish_call TOOL. The prescription generalizes: a phase change must arrive as a tool
result plus a pre-declared phase section — not as hope.

### G. Tell the model what TO DO, not what NOT to do

We fixed the "how can I help you?" re-ask (gotcha #6) with a negation — "do NOT ask
'how can I help'". Dale's insight: models act on positive instructions far more
reliably than negations, and naming the forbidden phrase can even prime it. The
reliable form tells the rung what its **last action IS**: "the moment you confirm
identity, your final words are a short 'Thanks, <name>' and the system takes over."
Nothing to decline — just a thing to do. **Prefer "do X" over "don't do Y" everywhere
in a script; reserve negations for hard prohibitions ("never book a time not in the
list"), where the prohibition IS the instruction.**

> Status: **VERIFIED on a live call 2026-07-15.** Positive framing ("your last words are a
> brief 'Thanks, <name>' and the system takes over") stopped the "how can I help?" re-ask
> cleanly — the agent went straight from confirming the number to offering booking times.
> Negation ("do NOT ask how can I help") had not been reliable; positive framing was.

### F. "It compiles and the tests are green" ≠ "it makes noise"

The whole reason this doc exists. A TTS engine swap passed typecheck + 567 unit tests and
took the phone line **completely silent** — not one test synthesizes a word. Every gotcha
above passed its unit tests. **The final gate is always a real call.** `cd agent && npm run
verify:tts` at least proves the voice makes sound; the browser sim (`simulate.sh call`)
proves the flow.

### I. A turn that hits `maxToolSteps` ends in SILENCE — and the watchdog salutes it

(2026-07-17, live browser call — "Ryan Seacrest". The caller said "Monday at 1:30",
heard nothing, said "Hello?" twice, and hung up.)

LiveKit caps how many tool calls one turn may chain (`maxToolSteps`, **default 3** — we
never overrode it). What the cap DOES is the gotcha: when a turn hits it, the framework
ends the turn **without generating any speech**. The log line is
`maximum number of function calls steps reached`; the state goes `thinking → listening`
with no audio in between; the caller hears nothing, forever. On the failing call the
model spent its 3 steps on intake lookups (catalog → history → context) without ever
reaching the `start_booking` router, so the booking never even began.

Three aggravators, each its own lesson:

1. **The hold-line watchdog treated `listening` as "turn fully resolved" and DISARMED.**
   The never-silent backstop stood down on exactly the transition that WAS the silence.
   Watch for: any "stand down" condition in a watchdog that a *failure mode* can
   satisfy. A watchdog must distinguish "the output happened" from "the turn is over."
2. **The capped turn strands its last tool call with no output in chat history** —
   every later turn logs `function call missing the corresponding function output,
   ignoring`. The corruption is permanent for the call.
3. **The failure is STABLE, not transient.** The caller's "Hello?" starts a new turn —
   which replays the same doomed tool loop from the same context and dies the same
   death. Waiting does not fix it; nothing the caller says fixes it.

**Fix (three layers):** `maxToolSteps: 5` (env-tunable `MAX_TOOL_STEPS`) so a legitimate
lookup-then-route chain fits; `attachSilentTurnRecovery` (watchdog.ts) — on a
`thinking → listening` transition with no audio, the RUNTIME forces a reply via
`generateReply({ toolChoice: 'none' })`, which cannot die the same death because with no
tools there is no cap to hit; if even that turn dies silent, ONE canned recovery line,
then stop (an unbounded nudge loop is its own bug). Honors gotcha D: never fires while
the caller is mid-utterance.

**Found while fixing it: prod runs `ENABLE_OUTPUT_WATCHDOG=false`** (Railway env,
2026-07-17) — the hold-line watchdog was not running AT ALL on the live line. The
silent-turn recovery is therefore attached UNCONDITIONALLY, not behind that flag: a
turn that ends in permanent silence is a dropped call, not a UX polish option.

> **Status: LIVE-VERIFIED 2026-07-17 16:02 UTC (first browser call after deploy).**
> A turn died silent again on that very call — and it was a DIFFERENT killer than
> the step cap: the phone-number read-back turn generated its text but produced **no
> audio at all** (the #3418-class TTS/interruption edge; the caller never heard the
> read-back). `silent_turn_recovered` fired and the call survived to a real booking
> — on-grid 1:00 PM, service recorded, `start_booking` reached. So the recovery is
> proven against a failure mode we did not even design it for, which is the point of
> watching the OUTPUT rather than the cause.
>
> **The same firing broke two things (v1 nudge wording — both fixed same day, see
> NUDGE_INSTRUCTIONS in watchdog.ts):** (1) told to "use what you already know," the
> model **answered its own pending question** — "Thank you! That's correct" with the
> caller never having confirmed the number. A pending question is not something the
> model knows; it is something it is owed. (2) It promised "I'll go ahead and book —
> one moment, please" from a turn that HOLDS NO TOOLS, then sat quiet ~20s until the
> caller's "Hello?" started a tool-bearing turn. The nudge must RE-ASK the pending
> question and END WITH A QUESTION: the caller's answer is what starts a turn that
> has tools again. The question is the recovery's exit.

### J. Unsatisfiable advice in a TOOL RESULT is a loop generator

Same call as gotcha I — this is what *made* the model burn its steps. Two tool results
handed it advice it could not act on:

- `get_detailed_customer_history` (no carrier caller-ID on a browser/forwarded line)
  returned *"identify the caller first (via identify_caller)"* — but `identify_caller`
  had **already succeeded**. The advice was already satisfied and therefore impossible
  to act on.
- `get_customer_context` returned *"Use send_verification_code, then
  verify_phone_code"* — tools that **were not in the session** (the `verification`
  capability is off while SMS is off). And `identify_caller`'s variant promised *"I'll
  text a 4-digit code"* — a text the platform cannot send.

The model does not shrug at advice it can't follow — **it retries the lookup**, turn
after turn, and with a step cap the retries eat the whole turn (see the toolPhases.ts
header for the 9-loops-of-history ancestor of this bug). The rules:

1. **Every error message must name a step the model can take on THIS call**, and be
   positively framed (gotcha G): "you already have their name and number — continue
   with their request, and do not call this tool again on this call."
2. **GH #113's rule — "removing a tool is not enough; NOTHING may still point at it" —
   applies to tool RESULTS, not just tool descriptions.** The backend cannot know a
   session's capabilities, so the agent-side wrapper is the layer that rewrites
   capability-dependent advice (`gateVerificationAdvice` in tools.ts).
3. **A message the model relays verbatim is a promise to the caller.** "I'll text a
   4-digit code" on a line that cannot text is the SMS-promising bug (configSchema.ts
   header) arriving through a tool result instead of the prompt.

Related reality check for the sim: a browser call has **no carrier caller-ID** — the
same branch as a forwarded line. That is a real production branch, not a sim artifact;
`simulate.sh call` exercising it is a feature. But know which branch you are testing:
history/context lookups succeed on a direct PSTN call and refuse on browser/forwarded
calls, so some loops only reproduce in the sim (and some only on PSTN).

**Addendum (2026-07-17, Dale: "But we aren't texting"): honesty has TWO layers, and a
capability gate is only a gate if every tool is filed under it.** The claim-vs-called
grader checks layer 1 (did the model lie about what it did). Layer 2 is whether the
TOOL told the truth about reality — and `send_self_service_link` didn't: it TEXTS the
caller, no text this product sends reaches a handset (10DLC), yet it was filed under
the `scheduling` capability and so ESCAPED the `ENABLE_SMS` gate. A live agent could
call it, get Telnyx's false "sent", and truthfully relay a text that would never
arrive. Fixed by refiling it under `sms` and gating every prompt pointer with it (the
tool doc line, the manage-door description, the proactive offer step, the honesty-line
parenthetical — GH #113: they move together). The toolselect eval now grades TWO
WORLDS: prod-parity (no `sms`) by default, with per-case `smsWorld: true` for flows
that only exist post-10DLC. **Known follow-ups surfaced by the prod-parity world:**
(a) `page_owner_via_sms` is the same class half-solved — it persists a durable
`customer_messages` row, but its urgency promise ("I've texted the owner") is false
until 10DLC; (b) the no-SMS prompt branch says "you have NO tool to text with" while
the toolset still holds page_owner_via_sms and take_message's "text them an alert" —
a contradiction the eval caught the model tripping over (it narrated a page instead
of calling it); (c) two eval cases FLAP at temperature 0 (OpenAI nondeterminism):
hours-are-not-availability and the urgent page — both sit within the 80% threshold
but rotate.

### K. A persona that only lives in the DEFAULT opener is a persona most tenants never speak

(2026-07-17 16:02 UTC live call — Thinking Hammer's assistant is named "Chris"
in the dashboard; the caller met "an AI assistant" with no name.)

The persona name was only ever spoken by the DEFAULT opener ("Hi, this is
Chris.") — and any tenant with a custom First Message never uses the default
opener, so configuring both a First Message and a persona silently discarded
the persona. Dale's rule: the greeting introduces the assistant's **name and
role for the company**. Fix (greeting.ts, 2026-07-17): the platform-default
DISCLOSURE is persona-aware — "I'm Chris, an AI assistant for Thinking
Hammer…" — which is the coexistence the legal wording rules explicitly
anticipate (the AI identity stays disclosed verbatim; a bare "Hi, this is
Chris" implying a human remains impossible). Both variants are authored
strings; a custom `callDisclosure` is still spoken verbatim; and the persona
is deduped exactly like the business name (opener already names them → the
disclosure carries only the role — no name twice in six seconds).
**Status: unit-tested (the live-call config is pinned as a test); not yet
heard on a live call.**

---

## A sample rung, annotated (copy this shape)

This is `IdentityTask` stripped to its skeleton. Every rung has the same five parts.
Copy this shape for a new rung and you inherit the guarantees for free.

```ts
export class IdentityTask extends voice.AgentTask<IdentityResult> {   // (1) typed RESULT
  constructor(opts: IdentityTaskOptions) {
    super({
      instructions: `${opts.runtimePreamble ?? ''}                     // (2) runtime facts FIRST
        Your ONE job is to get the caller's name and a confirmed phone number.
        Do not book. Do not take job details. Just identity.
        When you have both and they've confirmed the number, call confirm_identity.`,
      tools: {
        identify_caller: opts.identifyCaller,                          // (3) REUSE the real tool
        confirm_identity: llm.tool({                                   // (4) the COMPLETION tool
          parameters: { /* name, phone */ },
          execute: async ({ name, phone }) => {
            ctx.spokenPhone = phone;                                   //     write shared state
            await opts.onIdentified?.({ name, phone });
            this.complete({ name, phone });                            //     <-- THE ONLY EXIT
            return 'Got it.';
          },
        }),
      },
    });
  }
  override async onEnter() { this.session.generateReply(); }           // (5) SPEAK on entry
  override async ttsNode(text, ms) {                                   // (5) strip markdown
    return voice.Agent.default.ttsNode(this, sanitizeStream(text), ms);
  }
}
```

The five parts, and what breaks if you omit each:

| # | Part | Omit it and… |
|---|------|--------------|
| 1 | Typed `ResultT` | later rungs can't read what this one produced |
| 2 | `runtimePreamble` in instructions | the rung books October (gotcha #1) |
| 3 | reuse the real tool | you re-implement a week of bug fixes, badly |
| 4 | completion inside a tool | the model ends the rung by *talking* — the whole bug |
| 5 | `onEnter` + `ttsNode` | dead silence (#4) / markdown read aloud (#5) |

For a **booking-style** rung (BookMeeting, JobIntake) the completion tool isn't a separate
`confirm_*` — you WRAP the real doing-tool (`book_with_scheduling`, `capture_job_inquiry`)
and call `complete()` when its returned JSON has the success id. That's stronger: the
booking IS the completion, so there's no gap between "did the work" and "said it's done."

---

## WHY things break — the three root causes

Nearly every bug in this doc is one of three shapes. Learn the shapes and you predict the
bug before you write it.

### Root cause 1: A task is an ISLAND

Each task is a fresh agent — fresh system prompt, no memory of other rungs' prompts. So
**anything an earlier rung knew, a later rung does NOT know unless you carried it.** Date,
hours, the caller's name and number, what they already asked for — all invisible by
default. Gotchas #1, #2, #6 are all this one shape.

> **The tell:** if a rung needs a fact it didn't collect itself, and you didn't thread it
> in, it will ask for it again or guess it. Before writing a rung, list every fact it
> assumes — then check each one is either collected *in* the rung or threaded *into* it.

### Root cause 2: The model picks tools by DESCRIPTION SHAPE, not by intent

Tool selection is the model matching the caller's words against tool descriptions. Give it
two tools whose descriptions overlap ("remember a fact about the caller" vs "record a job
detail") and it flips a coin. Give it a messy tool alongside a clean one and it may grab the
messy one. Give it a tool with "use AFTER the questions" and it will *wait* when it should
act. Gotchas #3, and the `save_customer_preference`-stole-the-job-details bug, are this
shape.

> **The tell:** two tools that could plausibly answer the same caller sentence. Fix by (a)
> not giving a rung tools it doesn't need (`pick`), and (b) making descriptions name what
> they're FOR, not just what they do. "The ONE place job details go" beats "record a job
> inquiry."

### Root cause 3: A SENTENCE can satisfy an instruction that wanted an ACTION

"Confirm the booking" — the model says "you're all set!" without booking. "Take the job
details" — it says "I've noted that" and calls nothing. A sentence is free; a tool call is
work; offered both, the model takes the sentence. The prompt ladder is *made* of this bug.

> **The tell:** any instruction of the form "do X" where X is a tool call but the model
> could *say* it did X. The structural fix is the task-group flow itself — completion lives
> in a tool, so saying-it-did-it doesn't advance anything. On the prompt path, the only
> defence is verifying the tool actually ran (metrics + the eval's "claimed vs called"
> check).

---

## Spotting bugs from the SHAPE of the script (before they happen)

A checklist to run against a new rung or a new script, in order. Each maps to a root cause
above.

1. **List the rung's assumed facts.** For each: does it collect it, or is it threaded in via
   `CallState` / instructions? Any fact that is neither → it *will* re-ask or guess. (RC1)
2. **List the rung's tools.** Is any of them not strictly needed? Remove it. Do any two
   descriptions answer the same caller sentence? Disambiguate. (RC2)
3. **Find the completion.** Is it a tool call, and is it the REAL doing-tool (not a "say
   you're done" tool)? If the rung can end by the model talking, it will. (RC3) And is the
   wording **action-first** — "call `<tool>`, THEN confirm", never "confirm" before the call?
   (recipe rule 9)
3a. **Every tool the rung holds — is it load-bearing?** For each tool that is NOT the
   completion tool: if it errors, can the rung still finish? If the instructions don't say
   the failure is survivable, the model may spiral on it and never complete. Drop the tool or
   say "its failing is fine". (recipe rule 8)
4. **Check `onEnter` + `ttsNode` exist.** Missing `onEnter` = dead call. Missing `ttsNode` =
   markdown read aloud. (Gotchas #4, #5)
5. **Read the rung's opening line out loud.** Does it ask for something an earlier rung
   already has? (Gotcha #6) Does it produce a list/summary? Lists read as run-ons. (#5)
6. **Check the order.** Identity before anything that needs a name/number. The primary goal
   (the meeting) before the preparation for it (the details). Order is not a preference.
7. **Trace one full call on paper.** Greeting → intent → each rung → close. At the "close",
   ask: is every goal the caller stated *done*, with a tool result to prove it? If a goal
   can be reached without its tool firing, that's the skip bug.

If a script passes all seven and still misbehaves on a real call, it's almost certainly a
cross-cutting gotcha (A–F) — an empty-string, a mis-heard word, or the model narrating.

---

## E2E status — 2026-07-17 overnight sweep (all mic-free tiers, post silent-turn fixes)

Run after PRs #272/#273 deployed and with #274–#277 in flight. Every tier that can run
without a microphone, against a locally restored bookable Thinking Hammer (business shape
copied from prod — see the CLAUDE.md bare-bones-seed note for why that restore is needed):

| Tier | Result | Notes |
|---|---|---|
| `simulate.sh toolselect` (ladder) | **12/13 (92%)** | Was 10/13 (77%) — 2 of 3 fails were a GRADER false positive (fixed, PR #277). Remaining fail: take_message narrated, never called — the ladder disease the rung fixes; `ENABLE_TASK_GROUP` still off in prod. The 9×-history loop seen once did NOT recur (flaps). |
| `sim-taskgroup.ts` full suite (rung flow) | **29/30** | Sole failure: the KNOWN notes residual — chatty style, model attached the topic label ("Consulting work discussion.") without asking; the caller's real note (COBOL) never spoken. ~1-in-30 now vs 1-in-3 pre-ASK-FIRST. Documented residual, sim keeps it visible. |
| `simulate.sh tools` (agent-tools journey) | **16/16** | Zero gaps awaiting wiring. |
| `simulate.sh rag` | **9/9 (100%)** | Incl. 3 out-of-scope fallbacks. |

Still only provable on a live mic call: STT/TTS/turn-taking, `onEnter`, the greeting
audio (incl. the new persona-aware disclosure, PR #275), and the silent-turn recovery's
acoustics (its state machine is live-verified — gotcha I).

## Testing ladder (cheapest → most real)

1. **Unit tests** (`vitest`) — task logic, plan completeness, tool wiring. Fast, but blind
   to the assembled call (gotchas 1, 2, 4 all passed unit tests).
2. **`sim-taskgroup.ts`** — the whole call, real tasks/tools/backend/DB, **live LLM caller**
   across six phrasing styles (`plain`/`terse`/`chatty`/`frontloader`/`corrector`/`rambler`),
   verified against the DB. Catches state-flow, date-context, wrong-tool, DB-outcome, and
   **phrasing-induced** bugs a scripted caller misses. Run it at volume (`SIM_RUNS=N`) —
   several of the worst bugs showed up ~1 run in 30. `SIM_TRACE=1` logs every tool call +
   result (how the narrate-instead-of-act and the 500 were caught). **Does NOT** catch the
   runtime agent-swap / `onEnter` / TTS issues — only a live call does.
3. **`sim-toolselect.ts`** — the prompt-ladder eval; replays the real prompt + tools through
   the real model. Catches tool-selection and "narrates instead of acts". Costs OpenAI $.
4. **Browser voice call** (`simulate.sh call`, or a dispatched sim room) — the only thing
   that exercises STT/TTS/turn-taking/`onEnter`. The final gate. **Run against a dev worker
   under its own `AGENT_NAME`** so the job cannot land on the production worker.

**Gotcha for #4:** dispatched sim rooms are single-use — one greeting per dispatch. And the
local worker holds port 8081; a stale worker there silently blocks a restart (kill it by
PID, `lsof -ti :8081`).

---

## Running the task-group flow locally

```bash
# backend (has your tenant, migrated)
node dist/src/index.js &                       # https://localhost:4001

# worker on the task-group flow, its OWN name so it can't take prod's calls
cd agent
ENABLE_TASK_GROUP=true AGENT_NAME=secretary-hq-agent-dev \
  BACKEND_URL=https://localhost:4001 NODE_TLS_REJECT_UNAUTHORIZED=0 \
  node dist/index.js start

# dispatch a browser call to it
AGENT_NAME=secretary-hq-agent-dev SIM_TENANT=<tenant-uuid> node agent/scripts/sim-call.mjs

# or run the whole call end-to-end, no voice:
BACKEND_URL=https://localhost:4001 npx tsx agent/scripts/sim-taskgroup.ts
```

Flags that matter: `ENABLE_TASK_GROUP` (task flow vs prompt ladder), `ENABLE_SMS` (off until
10DLC), `ENABLE_PHONE_VERIFICATION` (off until SMS works — a code that can't be delivered
must not block a booking), `ENABLE_OUTPUT_WATCHDOG` (hold-line dead-air cover, on by default
in code — **but set `false` on prod Railway as of 2026-07-17**; the silent-turn recovery of
gotcha I is deliberately NOT behind it), `MAX_TOOL_STEPS` (per-turn tool-call cap, default 5
— see gotcha I for what hitting the cap does).
