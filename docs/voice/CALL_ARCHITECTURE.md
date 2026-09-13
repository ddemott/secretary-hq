# CALL ARCHITECTURE — the shape every call has

_Written 2026-08-16. Read against the code, not against other docs._

**What this doc is for.** Every call this product answers has the same eight-phase
skeleton, regardless of tenant or vertical. Three of those phases are platform
guarantees that must never vary per tenant. The rest is content, and content is what
onboarding swaps. This document draws that line, so that "pick your business from a
dropdown and get the right call" is a configuration question rather than an
engineering one.

**What this doc is NOT.** It does not re-explain how question trees work
(`docs/QUESTION_TREE_ARCHITECTURE.md`) or the LiveKit/Telnyx/Deepgram wiring
(`docs/ARCHITECTURE.md` §6). It covers the parts neither of those states: the phases
before pickup and after hangup, and the contract a section must satisfy to be
swappable by someone who cannot deploy code.

Sections are marked **BUILT** (running today) or **PROPOSED** (design, not code).
Where this doc and the code disagree, the code wins.

---

## 1. The eight phases — BUILT

```
   ┌────────────────────────── the phone is still ringing ───────────────────────┐
   │                                                                             │
 0 │ RING      prewarm: DNS warm, VAD load  ·  parse dispatch metadata           │
   │           ctx.connect()  ·  fetch tenant config  ·  warm greeting TTS       │
   │                                                                             │
   └───────────────────────────── waitForParticipant() ══ PICKUP ════════════════┘
                                          │
 1   GREET     say(greeting): disclosure → menu → closing question
               voice_sessions row written (fire-and-forget, never blocks audio)
                                          │
 2   IDENTIFY  caller-ID decision · maybeIdentify() · customer-context prefetch
               `identity` is force-added to any goal-bearing selection
                                          │
 3   PURPOSE   set_purpose picks trees off the PRESET's menu
               host code overrides when the model gets it wrong
                                          │
                                          ▼
 4   INTAKE    ┌──────────────────────────────────────────────┐
     (loop)    │ checklist rendered into context each turn:   │
               │   [ASK] [listen] [ACTION NOW] [✓]            │
               │ record_answer — any field, any order         │
               │ answer_question (RAG) — any moment           │
               │ toolset rebuilt from current selection       │
               └──────────────────────────────────────────────┘
                                          │
 5   WRITE     action node fires its real tool once `requires` is met
                                          │
 6   CLOSE     finish_call, gated by tracker.isResolved()
                                          │
 7   RECORD    end_voice_session · transcript · outcome · summary · AI cost
               reaper backstop at 15 min
```

### 0 — RING

Everything that can be done before the caller hears anything is done here, because
`waitForParticipant()` **is** pickup and every millisecond after it is dead air.
Tenant config fetch and greeting TTS warm both run in this phase.
`GREETING_POST_PICKUP_WAIT_MS = 0`: the cap was once raised to 12 s to let a slow
local warm finish, and the caller sat in silence after join and hung up. **Waiting
after pickup is itself the defect.**

Prewarm (idle process, before any call) resolves the call-path DNS names. One
unresolved name cost 11 s of silence on a WSL host with a cached, ready greeting
frame — see `docs/workflow/LESSONS_LEARNED.md`.

### 1 — GREET

`agent/src/index.ts` speaks the greeting via `session.say()` **before any agent logic
runs**, so greeting behaviour is identical on all three call architectures.

Composition (`agent/src/greeting.ts`): **disclosure → services menu → closing
question**. The disclosure is deliberately outside the opener fallback chain — a
tenant may reword it, but a blank one falls back to the platform default rather than
being absent. That clause is the platform's AI identification and is not a tenant's
to delete.

The `voice_sessions` row is created by a fire-and-forget call to
`/agent-tools/voice-session-start`. It must never delay the greeting, so a failure is
logged and swallowed; the reaper in phase 7 is the backstop.

### 2 — IDENTIFY

Host code, not the model. `identify_caller` is invoked directly by
`checklistTools.ts` and is never presented to the model. The `identity` tree is added
to any goal-bearing selection by the host (`CONTACTLESS_TREES`), because a message
asking for a callback was once taken with no phone number and the scenario passed its
grader.

### 3 — PURPOSE

`set_purpose` selects trees from the menu the tenant's preset allows. **A tree missing
from the preset is unreachable no matter what the model asks for** — overrides can
only subtract.

The host corrects the model's selection from the ANSWER, not from the prompt: role
words in a meeting topic select `job`; a knowledge-base miss selects `message` +
`identity`; a booking attempt records `meeting_offer`. The principle, learned twice:
**a prompt sentence is a request, host code is a guarantee.**

### 4 — INTAKE

The only loop in the call. The tracker renders the live checklist into the model's
context every turn and owns all state; the model never tracks its own progress. Ten
node statuses, of which `open` means may-be-asked and `latent` means listen-only.
Callers answer in any order.

### 5 — WRITE

An action node completes **only** on a real tool's success id. `wrapAction` carries
the guarantees: a `done` action refuses to repeat, a `blocked` one names its unmet
nodes, omitted args are backfilled from recorded answers, and
`ACTION_FAILURE_LIMIT = 2` flips the tool's own result to "stop retrying, take a
message".

### 6 — CLOSE

`tracker.isResolved()` is the goodbye gate: `finish_call` refuses while any selected
node is unresolved. This gate is what replaced book-first sequencing — a stated goal
cannot be forgotten, because the call cannot END on it.

Three bounds keep the gate from livelocking a line that, unlike a test harness, has no
round cap: `BOOKING_GUARD_REFUSAL_LIMIT = 2`, `FINISH_REFUSAL_LIMIT = 5` (escalates at
2, releases at 5, logs `goodbye_gate_released` with the unmet nodes), and
`GOODBYE_STALL_LIMIT = 2` for the case where the model trades farewells instead of
calling `finish_call`.

### 7 — RECORD

Session `close` → `end_voice_session` (which re-runs the customer-context capture, so
the stored snapshot reflects what the call PRODUCED rather than what preceded it),
transcript persist, outcome tracker (booked / transferred + `appointment_id`), bounded
post-call summary, AI cost row. `voiceSessionReaper` force-finalizes anything still
`active` after 15 minutes.

---

## 2. Spine vs content — the line that makes swapping safe

| Phase | Classification | Why |
| --- | --- | --- |
| 0 RING | spine | latency is a platform property |
| 1 GREET | **content** (text) + spine (disclosure floor) | tenant voice; legal clause guaranteed |
| 2 IDENTIFY | spine | a lead with no contact is not a lead |
| 3 PURPOSE | **content** (the menu) | this is the preset |
| 4 INTAKE | **content** (the questions) | this is the vertical |
| 5 WRITE | spine (mechanism) + content (which action) | guarantees live here |
| 6 CLOSE | spine | a tenant who could disable it could ship calls that forget the goal |
| 7 RECORD | spine | the call record is the product's evidence |

**Rule: a tenant may change what is ASKED and what is OFFERED. A tenant may never
change what is GUARANTEED.**

---

## 3. The three sinks — the rule that prices a new section

A call can end in exactly three durable outcomes today:

| Sink | Table | Written by |
| --- | --- | --- |
| Booked time | `appointments` | `book_with_scheduling`, `cancel_appointment`, `reschedule_appointment` |
| Message | `customer_messages` | `take_message` |
| Structured capture | `intake_submissions` (+ optional projection, e.g. `job_inquiries`) | `capture_job_inquiry`, `capture_case_inquiry` |

**A section whose questions land in an existing sink is DATA — authoring, no deploy.
A section that needs a new sink is CODE — tool, Zod schema, route, write path, tests.**

That single sentence prices any onboarding request. It is also why the law-firm
sub-verticals are cheap: `capture_case_inquiry`'s payload already carries both the
insurance fields (`insurer_name`, `policy_type`, `claim_outcome`, `appeal_status`) and
the injury fields (`injuries_sustained`, `medical_treatment`, `at_fault_party`,
`police_report`, `gave_recorded_statement`). What differs between a personal-injury
firm and an insurance-defense firm is **which questions get asked**, not where the
answers go. `intake_submissions` was built payload-preserving for exactly this: a
specialized projection can be forked out of `payload_json` later without re-capturing
anything.

---

## 4. What a swappable section must declare

`agent/src/checklist/blockLibrary.ts` is already most of this contract.

All BUILT (`sink` and `conflicts_with` landed 2026-08-16):

- `block_id` — the handle a preset enables and an override disables.
- `description` — **prompt-visible**: this text is what the purpose selector reads, so
  it carries intent boundaries ("can someone fix my computer" is a service request,
  not a job inquiry). It is contract, not documentation.
- `tree_refs` — the questions.
- `requires` — hard dependency (`schedule_change` requires `identity`).
- `pairs_with` — soft affinity, and for a `composed` block it is load-bearing: it names
  who carries the answers.
- `sink` — which outcome this block terminates in: `appointment`, `message`,
  `intake_submission`, `composed` (no terminal action of its own; a partner writes), or
  `none` (spine only — `identity`, whose answers backfill into every other write).
- `conflicts_with` — blocks that cannot be selected on the **same call**. Symmetric.

`sink` is checked against the action tools the block's trees actually contain, so a
declaration cannot drift from the tree it describes. `conflicts_with` drives the
host-side `set_purpose` bounce — previously the `job`/`buy_service` pair was named in
the gate itself; the gate now compiles the pair set from the library, so the next
confusable pair is one line in `blockLibrary.ts` and no code change.

**What `composed` does NOT yet prove.** It asserts a partner exists, not that the
partner's capture carries these fields. `captureCompleteness.test.ts` covers the `job`
tree only, so `buy_service`'s qualification answers (`current_cost`, `call_volume`,
`current_setup`, `wants_handled`) rely on the partner's `message_body` or a booked demo
to carry them, and nothing checks that. Extending capture-completeness to every block
with a declared sink is the obvious follow-on and is not done.

**Conflicts are about a CALL, never about a PRESET.** `owner_for_hire_front_desk`
enables `job` and `buy_service` together on purpose — different callers to one line
want different things. A test pins that intent so a future "presets may not contain
conflicting blocks" rule cannot quietly break that tenant's line.

---

## 5. Where each layer lives, and who can change it

| Layer | Storage | Changed by | Deploy needed? |
| --- | --- | --- | --- |
| Questions (per tenant) | `tenant_question_nodes` | SQL / scripts today | no |
| Questions (per vertical) | `question_tree_template_nodes` | seed script | no (script run) |
| Greeting text | `tenants.persona_name` / `greeting_menu` / `greeting_closer` / `call_disclosure` | dashboard | no |
| Which blocks are OFF | `tenants.checklist_overrides` | dashboard | no |
| Which blocks are ON | preset, in TS | **code** | **yes** |
| Preset catalog | `agent/src/checklist/presets.ts` + a DB CHECK enum | **code + migration** | **yes** |
| Action tools + write routes | `agent/src/tools.ts`, `src/routes/agentTools/` | **code** | **yes** |

The asymmetry in rows 4 and 5 is the whole problem: **removal is configuration,
insertion is a deploy.**

---

## 6. Known gaps — PROPOSED work, in order

1. **No ADD verb.** `ChecklistOverrides` has `disabled_conversation_blocks` and no
   enabled counterpart. This is not theoretical: `job` sat in `forbidden_trees` on all
   three original presets, so no tenant configuration could reach it, and two recruiter
   calls on 2026-08-13 wrote zero `job_inquiries` rows while the model correctly asked
   for the tree by name. The precondition for a safe ADD now exists — every block
   declares a `sink` (§4) — so an allowlist of "blocks that can hold what they collect"
   is a query rather than a judgement call.
2. **One vertical per business_type.** `verticalForBusinessType()` returns exactly one
   string, so every law firm gets identical `case_intake` questions. The schema does
   NOT have this limit — `question_tree_templates` is keyed `(vertical, tree_id)` with
   `vertical` as free text, and `copy_question_tree_templates_to_tenant()` already
   takes an ARRAY of verticals. The plumbing for sub-verticals is built; nothing has
   used it. Today all five verticals hold identical content, because the seed script
   writes the whole platform library under each one.
3. **Presets are TS + a DB CHECK enum.** That enum has already fallen a preset behind
   once. Moving the catalog to rows makes a new vertical an INSERT.
4. **No question editor.** Nothing in the product writes `tenant_question_nodes` — only
   scripts. Verified by grepping every consumer of that table.

---

## 7. The onboarding path this enables — PROPOSED

```
  signup form                    provisioning                     first call
  ───────────                    ────────────                     ──────────
  business category  ─┐
    "Law firm"        ├─→ vertical key ─→ copy_question_tree_      preset menu
  specialty          ─┘    'law_firm_       templates_to_tenant(     ↓
    "Personal injury"      personal_          tenant, ['platform',  trees the
                            injury'            '<vertical>'])       caller can
                                ↓                    ↓              reach
                          preset row          tenant's OWN rows
```

Two dropdowns, one transaction, no deploy. The copy is idempotent at TREE granularity
on purpose, so a later re-run can never restore a question the client deleted.

The guard this needs before it ships: a test asserting every question in every
sub-vertical maps to a capture param or a declared control node — the same shape as
`agent/src/checklist/captureCompleteness.test.ts`. Without it, sub-vertical authoring
is a way to add questions whose answers are dropped, which is the failure this codebase
has already paid for twice (`role_description`, `location_type`).

---

## 8. Standards — the rules for building any of this

### 8.1 Where standards already live

| Doc | Covers | Currency |
| --- | --- | --- |
| `docs/VOICE_AGENT_PLAYBOOK.md` | the voice PIPELINE: latency, turn-taking, dead air, TTS, model ids | current for the pipeline; **its §11 "Recipe" is LADDER-ERA** — persona + `buildTools(capabilities)` describes a path prod does not run |
| `docs/VERTICAL-PRESET-BLOCK-ARCHITECTURE.md` | the block/preset model | design doc |
| `docs/workflow/CODING_STANDARDS.md` | general TS/SQL/test conventions | current |
| `docs/workflow/LESSONS_LEARNED.md`, `docs/BUILDING_SCRIPT_NOTES.md` | dated incidents, append-only | current |
| **this section** | building a call SECTION under question trees | current |

### 8.2 The fourteen rules, each paid for once

These are not style preferences. Every one has an incident behind it.

1. **A prompt sentence is a request; host code is a guarantee.** If a behaviour must
   happen, put it in the host. The `meeting_topic` node ASKED the model to re-declare
   purpose when the topic named a role; it did not, and a recruiter call wrote zero
   rows.
2. **A rule in the prompt cannot outrank an example in a tool result.** The prompt said
   never speak internal tokens; the tracker's own rejection message listed them as bare
   words, and the model said "answering_service" aloud on the next turn. Error text is
   few-shot training whether you meant it or not.
3. **Never promise what you have no means to do.** SMS is off, so the agent has no SMS
   tools and is told plainly it cannot text. The alternative is a caller waiting for a
   confirmation that will never arrive.
4. **Success-shaped failure is the worst outcome.** `{"success":true,"result":"I'm not
   able to pull up our booking options right now…"}` is counted by nothing and read as
   working. A refusal must FAIL and must name what to collect next.
5. **Every field collected must have somewhere to land.** `role_description` was asked
   on every job call and dropped end-to-end — no tool param, no Zod field, no column.
   Enforced now by `captureCompleteness.test.ts`.
6. **The model never holds a UUID.** If an id is needed, the host fills it — and only
   when the lookup is unambiguous. Two candidate appointments stays the model's choice;
   guessing which booking to cancel is worse than asking.
7. **Never call `updateTools()` inside a tool's own `execute()`.** It swaps out the tool
   LiveKit is waiting on, the model retries forever, and the caller hangs up. Defer to a
   macrotask.
8. **Every gate needs a bound.** A test harness has a round cap; a phone line does not.
   Four separate livelocks shipped because four gates could refuse forever.
9. **Host-owned state the write ignores is state theater.** If the tracker shows a field
   ✓, the write must carry it. Hence arg backfill.
10. **Measure before fixing.** One direct timing test beat hours of guessing twice — the
    "TTS freeze" was OpenAI TTS, and the "TTS pause" after that was DNS.
11. **Green tests are not audio.** A TTS swap passed typecheck and 567 unit tests and
    took the line completely silent. `npm run verify:tts` opens the real socket and
    demands real bytes.
12. **One row per call.** An action tool is retried until it returns a success id, so
    concurrent retries must converge. Partial UNIQUE on `(tenant_id, call_id)` +
    `INSERT … ON CONFLICT DO NOTHING` + winner lookup.
13. **Reachability is not optional.** A tree no preset offers is dead code that reads
    like a feature. `presetCatalog.test.ts` fails CI on orphans; the allowlist has one
    entry and adding to it is the thing to argue about.
14. **Don't invent a new top-level table.** `intake_submissions` is the type-tagged,
    payload-preserving envelope. Fork a projection out of `payload_json` later if a
    query needs it.

### 8.3 Per-phase DO / DON'T

**0 RING**
- DO move every avoidable millisecond before `waitForParticipant()`.
- DO resolve external hostnames in prewarm.
- DON'T add any wait AFTER pickup. Dead air on an answered line is indistinguishable
  from a dead line.

**1 GREET**
- DO let the tenant reword the greeting, the menu, and the closer.
- DON'T let a tenant produce an EMPTY disclosure — blank falls back to the platform
  default. The AI-identification clause is not theirs to delete.
- DON'T block the greeting on any network write; `voice-session-start` is
  fire-and-forget with a reaper backstop for a reason.

**2 IDENTIFY**
- DO keep `identify_caller` host-only.
- DO force `identity` into any goal-bearing selection.
- DON'T accept an undialable number as answered — refuse, name what was heard, leave
  the node open.
- DON'T accept a placeholder name ("caller", "customer"). It passes graders and ruins
  the record.

**3 PURPOSE**
- DO write the block `description` FOR the purpose selector, with the intent boundary
  spelled out ("can someone fix my computer" is a service request, not a job inquiry).
- DO correct selection in host code from the ANSWER when the model gets it wrong.
- DON'T rely on a node's prompt text to trigger a re-selection; by the time the answer
  arrives, purpose has usually locked.

**4 INTAKE**
- DO make questions data, in a tree.
- DO use `choice` for branches so dead branches are never asked, and let the tracker
  discard answers stranded on an abandoned branch.
- DON'T add a field to `types.ts` and use it only in an unreachable tree — the round-trip
  test won't see it. (`questionTreeFieldCoverage.test.ts` now catches this.)
- DON'T let the model re-ask something already recorded. That is what the rendered
  checklist is for.

**5 WRITE**
- DO name the sink BEFORE writing any questions (§3).
- DO backfill every omitted arg from the tracker.
- DO make the route refuse loudly and say what to collect next.
- DON'T let an action complete on anything but a real success id.
- DON'T retry forever — two failures flip to take-a-message.

**6 CLOSE**
- DO put anything that must not be forgotten in a selected node; the gate is the
  enforcement.
- DON'T add a gate without a release bound and a log line naming what it held for.

**7 RECORD**
- DO instrument every sad path with a metric plus a 5W log; metrics survive log
  truncation.
- DON'T assume the outcome — `end_voice_session` re-captures context at call END so the
  record reflects what the call produced.

### 8.4 The build order for a new section

Follow it in this order; each step exists because skipping it shipped a defect.

1. **Name the sink.** Existing sink → authoring. New sink → this is a code project, say
   so before estimating.
2. **Write the tree as data**, with a purpose-selector-grade `description`.
3. **Add the action node** with `requires` (soft ordering) and `await_tree` if the intake
   must finish before the write.
4. **Wire the field end to end**: tool param → Zod schema → column or payload key.
5. **Add the backfill entry** so the write carries what the checklist shows.
6. **Write the route**: one row per call, placeholder refusals, honest failure text that
   names the next action.
7. **Enable it in a preset** — otherwise it is unreachable no matter what the model asks.
8. **Seed the template + convert tenants** (`npm run trees:local`, prod rollout on
   deploy), or provisioned tenants keep the old questions.
9. **Let the guards run** (§8.5). Fix rather than waive; both new guards in the last
   sweep failed on their first run, which was the point.
10. **Add a `sim-questiontree` scenario and READ the transcript.** The tally is not the
    result. In the 2026-08-15/16 sweep, 20 defects were visible in output the graders
    passed or misattributed.
11. **Document the break and the fix**, with verification status and date.

### 8.5 What is actually enforced (as opposed to remembered)

CI fails on all of these. They are the standards with teeth.

| Guard | Refuses |
| --- | --- |
| `agent/src/checklist/captureCompleteness.test.ts` | a collected node with nowhere to land |
| `agent/src/checklist/actionArgCoverage.test.ts` | a required tool param that is not backfilled, host-supplied, or declared model-only WITH a reason |
| `agent/src/checklist/presetCatalog.test.ts` | a tree no preset offers (one-entry allowlist) |
| `agent/src/checklist/blockCompiler.test.ts` | block → runtime compilation drift |
| `agent/src/checklist/blockContract.test.ts` | a block whose declared `sink` disagrees with the action tools its trees fire; a `composed` block naming no partner; a one-sided `conflicts_with`; a conflict gate that stopped reading the library |
| `tests/presetCatalogConstraint.test.ts` | the preset list and the DB CHECK constraint disagreeing |
| `tests/questionTreeRoundTrip.test.ts` | the DB copy of a tree differing from the TS library |
| `tests/questionTreeFieldCoverage.test.ts` | a node field the DB and assembler do not carry — including in unreachable trees |
| `tests/noHardcodedNames.test.ts` | one tenant's owner name compiled into every tenant's logic |
| `tests/routes/agentTools/policyFallbackContract.test.ts` | the RAG no-answer sentence drifting across a package boundary with no shared import |
| `npm run verify:schema` | a migration-created table/column missing from `supabase/baseline.sql` |
| `npm run verify:claude-md` | doc counts drifting from the filesystem |

Everything else in this document is convention, which means it holds exactly as long as
someone remembers it. **When a convention here gets violated twice, promote it to a
guard** — that is how this table was built.

---

## 9. Related

- `docs/QUESTION_TREE_ARCHITECTURE.md` — how trees, the tracker, and the goodbye gate work
- `docs/ARCHITECTURE.md` §6 — the voice stack and the three call architectures
- `docs/workflow/LESSONS_LEARNED.md` — the DNS lesson, the TTS outage, the measure-first rule
- `CLAUDE.md` — the live catalog of trees, presets, tools, and their counts
