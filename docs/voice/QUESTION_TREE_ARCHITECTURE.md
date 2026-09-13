# QUESTION TREE ARCHITECTURE

> ## ✅ BUILT AND LIVE — this is the production call architecture
>
> Not a plan any more. `ENABLE_QUESTION_TREE` is `(v) => v !== 'false'` in
> `agent/src/configSchema.ts` — **ON unless explicitly disabled** — so
> `agent/src/index.ts` builds a `ChecklistAgent` for every call. The code is in
> `agent/src/checklist/`: `types.ts` (node shapes), `trees.ts` (the platform
> library — 10 hand-written trees plus 30 more from `verticalIntakeTrees.ts`,
> #388 2026-08-31; this banner said "10-tree" for two weeks after that shipped),
> `tracker.ts` (state + the goodbye gate), `checklistAgent.ts` (the prompt
> and the one agent), `checklistTools.ts` (`set_purpose` / `record_answer` /
> `finish_call` / `answer_question` + the action wrappers).
>
> **Since this design was written, a per-tenant configuration layer was added on top
> (2026-08-12/13, ROADMAP Steps 7–9) and it changes what "the model picks a tree"
> means.** `tenants.checklist_preset_id` + `tenants.checklist_overrides` compile
> through `shared/checklistPresetDerivation.ts` into the `checklist_runtime_config`
> the agent receives, and the **preset decides which trees are selectable at all**.
> Overrides can only SUBTRACT — there is no ADD verb — so **a tree missing from the
> tenant's preset is unreachable no matter what the model asks for.** There are
> **33 presets as of #388 (2026-08-31)**: the original five —
> `auto_shop_front_desk`, `salon_front_desk`, `local_service_front_desk`,
> `owner_for_hire_front_desk`, and `law_firm_front_desk` — plus 28 more
> vertical-intake presets (`VERTICAL_INTAKE_PRESETS`), one per additional
> business vertical, each pairing with its own slot-filling intake tree. See
> `CLAUDE.md`'s `/agent/src/checklist/` bullet for the live, maintained count —
> this banner should not be treated as the authoritative source for it. This is
> not a hypothetical
> failure mode: `job` was
> in `forbidden_trees` on all three original presets, so no tenant could reach it,
> and two recruiter calls on 2026-08-13 produced zero `job_inquiries` rows while the
> model correctly asked for the tree by name (`CALL1.md` / `CALL2.md`).
>
> Both older flows survive as fallbacks behind flags and are NOT what a live call
> runs: the rung/TaskGroup flow (`agent/src/tasks/`, `ENABLE_TASK_GROUP`) and the
> prompt ladder (`src/services/scripts/blocks.ts` → `tenants.system_prompt`, both
> flags off). Under question trees the composed `system_prompt` is never passed to
> the model at all.
>
> Sections below are the ORIGINAL design as agreed; where the built code and this
> document differ, **the code in `agent/src/checklist/` wins**.

_Design agreed with Dale 2026-07-21; built and shipped the same week. Replaces BOTH
earlier call-flow systems._

_Rollback anchor: branch `rung-architecture` = main @ `909c8f2` (the last rung-era
main). Dale deletes it himself once this architecture is proven on live calls._

---

## 1. The idea in one paragraph

One continuous conversation, no rungs, no phases. When the caller's purpose becomes
known, the system hands the AI a **checklist of questions** — a merged set of small
**question trees** selected by that purpose. Trees carry **if-branches**: answering a
choice question ("remote, hybrid, or onsite?") activates ONE branch's follow-ups and
marks the other branches ✗ not-applicable, so they are never asked. The caller answers
in any order, conversationally; the AI listens and fills in whatever it hears rather
than re-asking. The call segment is over when every live node is resolved — ✓ answered,
✗ not-applicable, or "asked, declined". Host code owns all of this state; the model
never tracks its own progress.

```
work_mode: "Is this remote, hybrid, or onsite?"        [choice]
├─ remote  → timezone
├─ hybrid  → client_address, timezone
└─ onsite  → client_address

Caller: "Well it's a job downtown but we have all our people work remote."
→ record_answer(work_mode, remote)  → work_mode ✓, timezone OPEN, client_address ✗
→ "downtown" recorded NOWHERE (color, not an answer — no inference-stretching)
→ AI's next question: the only thing still open. "What timezone is the team in?"
```

## 2. What survives from the rung era, and why

The rung system exists because the one-big-prompt ladder let the model skip steps and
narrate work it never did. This design keeps that lesson while dropping the
sequencing:

| Lesson (paid for on live calls)                     | Where it lives now                              |
| --------------------------------------------------- | ----------------------------------------------- |
| Host code owns progress, not the model               | `ChecklistTracker` — all node state host-side   |
| A sentence must never complete work                  | ACTION nodes ✓ only on the real tool's success id (`idExtractor` reuse) |
| A tool the model doesn't hold can't misfire          | dead-branch questions LEAVE the prompt; action tools appear only when their node goes live |
| The model forgets its own completed work (2026-07-21 double-booking) | checklist state travels in TOOL RESULTS (`standing_fact` pattern) — the one context the model re-reads |
| Caller-derived text is interpolated into prompts     | `sanitizeVolunteered` at the `record_answer` choke point |
| One goodbye, host-owned                              | `finish_call` keeps its fixed goodbye + `session.close()`, now HOST-GATED on tree resolution |
| Markdown must never reach TTS                        | `sanitizeStream` ttsNode, unchanged             |
| Never `updateTools()` inside a tool's own `execute()`| macrotask deferral, unchanged (toolPhases gotcha) |
| Runtime facts (date/hours/tz) must be injected       | `runtimePreamble` carries over verbatim         |
| Silent-turn death recovery                           | `attachSilentTurnRecovery`, unconditional, unchanged |

Also unchanged: ALL of `agent/src/tools.ts` (the 23 real tools + `standing_fact`),
the `/agent-tools/*` backend, transcript/callOutcome/callSummary, hold lines,
greeting, `sim-*` harness bones.

**What dies once proven live:** `agent/src/tasks/` (the TaskGroup rungs),
`agent/src/toolPhases.ts` (phases replaced by node-driven tool availability), the
ladder composition path of `blocks.ts` (its hard-won WORDING ports into tree
definitions — the four-bad-calls rules are content now, not structure).

## 3. The pieces

### 3.1 Question trees (declarative data)

A tenant has a **library of small trees**, each with a `tree_id`, a `description`
written for the purpose selector (including the intent-boundary examples ported from
`begin_call` — "fix my computer" is a service request, NOT a job), and nodes:

```jsonc
{
  "tree_id": "job",
  "description": "Caller is bringing a job/role/contract TO the owner (recruiter, staffing, pitching work). NOT a caller asking us to do work for them — that is a service request.",
  "nodes": [
    { "node_id": "callers_company", "type": "text",
      "ask": "the company the CALLER is with (the agency that rang)" },
    { "node_id": "job_type", "type": "choice",
      "ask": "contract, full-time, or contract-to-hire",
      "options": {
        "contract": [
          { "node_id": "client_company", "type": "text",
            "ask": "the CLIENT company where the work actually is" },
          { "node_id": "work_mode", "type": "choice",
            "options": {
              "remote": [{ "node_id": "timezone", "type": "text" }],
              "hybrid": [{ "node_id": "client_address" }, { "node_id": "timezone" }],
              "onsite": [{ "node_id": "client_address", "type": "text" }]
            } }
        ],
        "fulltime": [ /* … */ ],
        "contract_to_hire": [ /* … */ ]
      } },
    { "node_id": "capture", "type": "action", "tool": "capture_job_inquiry",
      "requires": ["callers_company", "job_type"] }
  ]
}
```

- **Node kinds:** `text`/`choice` (ASK — filled from the caller's words) and
  `action` (✓ = the named real tool returned its success id; `requires` lists node
  ids that must be resolved before the tool goes live).
- **Node states:** `open` (live, unanswered) · `answered ✓` · `not_applicable ✗`
  (sibling branch taken) · `declined` (asked; caller doesn't know / won't say — the
  call CAN complete; the owner sees the difference between skipped and declined) ·
  `pending` (volunteered before its branch activated — held; promoted to ✓ if the
  branch goes live, discarded with the branch if not).
- **Shared node ids dedupe on merge**: `caller_name` / `caller_phone` appear in
  every tree and exist once in the merged checklist. Schema rule: cross-tree shared
  nodes MUST use the canonical ids.
- **Platform trees** (every tenant): `identity`, `booking`, `message`,
  `generic_subject`, `qa`. **Vertical trees** per tenant: `job`, `fix_computer`, …
  The identity tree's ask-hints carry the blocks.ts wording verbatim (one read-back
  one yes, 3-3-4 digits, disputed caller-ID dropped fresh).
- **Storage (decided in phase 2, 2026-07-21):** the platform library lives in the
  agent as typed TS (`agent/src/checklist/trees.ts`) — the compiler validates every
  node against the schema and `trees.test.ts` constructs the real tracker from the
  real library in CI, so a malformed tree is a red build, never a mid-call surprise.
  Per-tenant tree delivery (via `/agent-tools/tenant-config`) and owner-editable
  trees are BOTH deferred until a real tenant needs a tree the platform doesn't
  have (build-for-real-customers rule).

### 3.2 ChecklistTracker (host code, pure, the heart)

`agent/src/checklist/tracker.ts` — no LiveKit imports, fully unit-testable:

- `select(treeIds)` — merge trees into the live checklist (accumulator: callable
  mid-call to ADD trees; dedupes nodes already present, keeps their state).
- `record(nodeId, value | {declined})` — validate (node exists; choice value is a
  legal option), set state, **recompute**: activate the chosen branch, mark sibling
  branches ✗ recursively, promote matching `pending` answers.
- **Mind-change:** re-recording a choice node reopens it — the old branch's answers
  are discarded (not kept as ghosts), the new branch activates. The MIND-CHANGE e2e
  scenario becomes a tracker unit test.
- `frontier()` — live, open ASK nodes (what may be asked) + action nodes whose
  `requires` are met (what may be done).
- `renderState()` — the compact ✓/✗/open tree the model sees. Dead branches are
  OMITTED, not shown crossed out — a question not in the prompt cannot be asked.
- `isResolved()` — no live node open. Gates `finish_call`.

### 3.3 The conversation agent (one agent, whole call)

Single `voice.Agent` for the entire call — no per-rung agent swaps, no phase
machine. Its tools:

- **`set_purpose(trees: string[])`** — evolved `begin_call`. The prompt lists the
  tenant's tree library (id + description); the model picks on the opener AND any
  time a new goal surfaces ("oh, and can I also book…"). Nothing matches →
  `generic_subject`. Volunteered name/phone ride along exactly as `begin_call`'s
  `caller_name`/`caller_phone` do today (sanitized at the choke point). Round-capped
  like `#MAX_ROUNDS`.
- **`record_answer(node_id, value?, declined?)`** — the ONLY way a node changes
  state. Multiple calls per turn when the caller volunteers several things in one
  breath ("Hi, this is Mike from Apex, we've got a remote contract role" → four
  records). Its **tool result is `renderState()`** — the updated checklist rides in
  the context the model actually re-reads, all call long (the `standing_fact`
  trick, generalized).
- **Real ACTION tools** (`book_with_scheduling`, `take_message`,
  `capture_job_inquiry`, cancel/reschedule…) — present only while their node is
  live and `requires`-satisfied (swap via macrotask-deferred `updateTools`). Their
  success id resolves the node host-side; consecutive-failure gates (the HARD-DOWN
  rule 15 shape: `{error, error_code}`, no `success` field) redirect to the
  `message` tree.
- **`answer_question(question)`** — RAG, **always in the toolset, every turn**.
  Questions arrive anywhere; the loop is retrieve → answer in a spoken sentence or
  two → return to the frontier (the tracker hasn't moved, so the AI still knows
  what's open). A QA-purpose call is a one-node tree ("caller's questions
  answered", resolved when they say they're done) so even open-ended browsing hits
  the same goodbye gate. **Retrieval miss = pivot**: "that's a good one for Dale
  directly — want me to take a message, or set up a time?" → yes attaches the
  `message`/`booking` tree mid-call.
- **`finish_call()`** — HOST-GATED: if `isResolved()` is false it does NOT close;
  its result lists what's still open ("still needed: timezone — ask it"). Resolved →
  the fixed goodbye + `session.close()`, unchanged.

Prompt shape per turn: persona + `runtimePreamble` + conversation rules (the ported
style rules: numbers digit-by-digit 3-3-4, never recite caller-ID, "anything else"
only when the tracker says all-done) + `renderState()` + the standing listening
rule: **"fill anything you hear, ask only what's open, record only what was actually
said — never stretch an inference into a field."**

### 3.4 Purpose → trees (examples)

| Caller opener | Trees selected |
| --- | --- |
| "I'd like Dale to fix my computer" | `identity` + `fix_computer` (+ its booking action node) |
| "Message for Dale about a job" | `identity` + `message` + `job` |
| "Message about a wedding" | `identity` + `message` + `generic_subject` (the ELSE — every topic matches something) |
| "When are you open?" | `qa` only — questions-only callers are still never interrogated for a name first (identity attaches only if a message/booking emerges) |
| …mid-call: "actually can I also book time?" | `booking` joins the live checklist, already partly satisfied (name ✓ phone ✓) |

Ordering doctrine, revised: **book-first survives as a soft priority** (the frontier
renders the booking action prominently; the prompt keeps "the meeting is what they
rang for") — but a caller who leads with job details gets them recorded, not
stonewalled. The completion gate guarantees what book-first actually existed to
guarantee: the booking cannot be *forgotten*.

## 4. Build plan

Each phase = its own PR into `feat/question-tree-architecture`'s PR chain (or
stacked commits on it), CI-green, sim-verified before the next. Prod stays on the
rung flow (`ENABLE_TASK_GROUP=true`) throughout; the new path runs behind
**`ENABLE_QUESTION_TREE`** (which, when true, supersedes the other flags on that
worker).

1. **Tracker core** — `agent/src/checklist/` types + `ChecklistTracker`, pure.
   Unit tests are the conversation's whole case list: out-of-order volunteering,
   pre-branch `pending` promotion AND discard, sibling-✗ recursion, mind-change
   reopen + ghost-answer discard, declined vs ✗, merge dedupe preserving state,
   accumulator selection, `requires` gating, resolution.
2. **Tree definitions** — ✅ DONE 2026-07-21: `agent/src/checklist/trees.ts` (typed
   TS, see Storage above — the JSON-loader plan was dropped for compiler + real-
   tracker validation). Ported: identity (blocks.ts RUNG 1 + the 2026-07-21
   one-read-back rules), job (two-companies, employment fork incl. Dale's
   contract_to_hire, work-mode fork), message, generic_subject, booking, qa,
   schedule_change, fix_computer (DRAFT — service-area/duration details still open
   with Dale). Boundary examples ported from `begin_call` into descriptions.
   Tracker gained `deselect()` — the not_a_job wrong-door escape at tree level.
3. **Conversation agent** — ✅ DONE 2026-07-21: `agent/src/checklist/checklistTools.ts`
   (the injectable toolset: set_purpose with wrong_trees + rounds cap, record_answer
   with corrective-error results, host-gated finish_call, wrapped actions with the
   anti-double-book refusal + two-failures message advice, always-on answer_question,
   host-code identify_caller, caller-ID phone seeding) + `checklistAgent.ts` (one
   voice.Agent, whole call; prompt = persona + runtime + tree menu + ported style
   rules; toolset swaps only on selection change, macrotask-deferred). Wired into
   `index.ts` behind `ENABLE_QUESTION_TREE` (precedence over ENABLE_TASK_GROUP),
   reusing greeting/transcript/summary/silent-turn plumbing untouched. 24 toolset
   unit tests drive the executes directly.
4. **Eval battery** — ⏳ STEP 1 DONE 2026-07-21: `agent/scripts/sim-questiontree.ts` —
   a live caller-LLM improvises against the REAL prompt + toolset + tracker (backend
   tools faked; grading on the tracker's final SNAPSHOT, not transcript matching).
   First battery: JOB-DIRECT, ONE-BREATH, WEDDING MESSAGE, MIND-CHANGE, QA-ONLY,
   CALLER-ID BOOKING — **12/12 across two randomized runs** (gpt-4.1-mini agent).
   The first-ever mock call caught a real bug: capture fired with half the intake
   uncollected → `await_tree` gate added to action nodes ("finish the intake, then
   write"); a later run caught the selector skipping booking on a service request →
   selection-rule fix in the prompt. STILL TO DO: port the remaining rung-battery
   scenarios (STUBBORN, CLOSED-DAY, RACE, HARD-DOWN failure injection, multi-goal
   mid-call addition, RAG-miss→message pivot) and a real-backend/DB-verified tier
   (the sim-taskgroup pattern). Parity with the 43-scenario rung battery before any
   live call.
5. **Live verification** — browser call (`simulate.sh call`), then real PSTN calls
   (timestamped, per standing rule), on a worker with the flag on. Same bar the
   rung system had to clear: booking + intake + message + Q&A legs on voice, rows
   verified in DB.
6. **Cutover + demolition** — Dale flips prod; soak; then delete
   `agent/src/tasks/`, `toolPhases.ts`, the ladder path, the flags — and Dale
   removes the `rung-architecture` anchor branch. CLAUDE.md + docs updated;
   `verify-claude-md` kept honest.

## 5. Risks, named

- **Extraction quality is now load-bearing.** The model must map free speech onto
  node ids without over-inferring ("downtown" ≠ address). Mitigations: record-only-
  what-was-said rule, choice-value validation host-side, eval cases graded on WRONG
  records, and the declined state so the model never fabricates to close a node.
- **One agent, growing context.** No per-rung prompt resets means long calls carry
  everything. Mitigation: `renderState()` in tool results is compact; tree libraries
  are small; the 25-tool ceiling lesson is respected by node-driven tool presence.
- **`updateTools` churn** as action nodes go live/dead — same macrotask gotcha as
  the routers; centralized in one place in the agent.
- **Ambiguous choice answers** ("kind of both?") — the model asks a clarifying
  question rather than recording; choice validation refuses non-options, and the
  refusal text (tool result) tells it to clarify.
