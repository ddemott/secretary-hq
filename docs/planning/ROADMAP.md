# ROADMAP

**Status:** active execution. Steps 1–10 closed in CI (host-tool journeys). **Date:** 2026-08-13. **Owner:** Dale.

This roadmap turns the vertical-preset/block architecture into an execution sequence. It is intentionally ordered by risk: prove the architecture against the current live runtime before widening scope.

Related doc:

- `docs/product/VERTICAL-PRESET-BLOCK-ARCHITECTURE.md`

---

## 1. Objective

Build configurable, reusable receptionist behavior for different business types without creating a second call engine.

Target shape:

- reusable typed block library
- vertical preset compositions
- tenant runtime config generated from presets
- generic intake submission layer
- specialized projectors where needed

Hard rule:

- this must compile into the existing `agent/src/checklist/` runtime
- do **not** build a parallel call-flow engine

## Checkpoint completed on 2026-08-12

The roadmap is no longer hypothetical from step zero.

Implemented and verified in this checkpoint:

- Step 1 vocabulary freeze: `ConversationBlockDef`, `PolicyBlockDef`, `KnowledgeBlockDef`, `OutcomeBlockDef`, `VerticalPresetDef`, `TenantRuntimeConfig`, and `IntakeSubmission` now exist in `agent/src/checklist/blockTypes.ts`
- Step 2 canonical schemas: Zod schemas now exist in `agent/src/checklist/blockSchemas.ts`, with tests covering acceptance/rejection cases
- Step 3 definition/compiler layer: `agent/src/checklist/blockLibrary.ts`, `agent/src/checklist/blockCompiler.ts`, and the checklist runtime `runtimeConfig` path now compile the first parity-set block ids into live selectable tree ids while keeping the full tree library for tracker invariants
- Step 4 generic intake envelope: `supabase/migrations/20260811160000_intake_submissions.sql` created `intake_submissions`, and `capture-job-inquiry` now writes that envelope before the specialized `job_inquiries` row
- Step 5 first projector split: `src/services/jobInquiryCapture.ts` now owns generic capture + `job_inquiry` projection persistence while `src/routes/agentTools/messaging.ts` keeps validation / spoken reply / email side effects; route, route-unit, and real-DB tests pass against the split path
- Step 6 second reusable path proof: `src/services/meetingNotesCapture.ts` now lands `attach-meeting-notes` into the same generic `intake_submissions` envelope with `submission_type='meeting_notes'` before projecting to appointment description, and route + service tests pass against that split path
- Step 7 first three presets + journeys: `auto_shop_front_desk`, `salon_front_desk`, and `local_service_front_desk` validate, materialize a runtime config, declare `forbidden_trees` + required defaults, and each has a host-tool journey (`presetJourneys.test.ts`). Auto shop and salon share the same front-desk trees on purpose — unique per-vertical trees are not invented until a real tenant needs them.

Still open after this checkpoint (closed 2026-08-13 by #338 / #339 — see below):

- ~~onboarding wiring for preset selection~~ Business Settings → Call checklist + setup picker
- ~~tenant-safe override UI and activation controls~~ disable / policy / optional / required shipped; wording + dry-run remain

## Checkpoint completed on 2026-08-13

Shipped on `main` and live in prod (`4610d10`, `/health` `started_at` 2026-08-13T14:00:35Z):

- Step 8: `tenants.checklist_preset_id`, `deriveChecklistRuntimeConfig`, live `ChecklistAgent({ runtimeConfig })`, Business Settings preset picker (#338)
- Step 9 slices 1–3: `tenants.checklist_overrides` — disable blocks (not identity), `booking_mode` / `message_mode`, `optional_node_ids` (listen-only), `required_node_ids` (decline does not resolve) (#338 + #339)
- write-time 400 on invalid overrides; bad stored row ignored on tenant-config read

Still open:

- unique salon-vs-auto-shop trees only when a real tenant needs a block the shared front-desk set lacks
- live PSTN / Playwright voice replay of the same five paths (optional; host-tool journeys are the CI bar)

---

## 2. Big steps

### Step 1 — Freeze vocabulary and boundaries

Goal:

- stop "block" from meaning six different things

Define and use exact internal nouns:

- `ConversationBlockDef`
- `PolicyBlockDef`
- `KnowledgeBlockDef`
- `OutcomeBlockDef`
- `VerticalPresetDef`
- `TenantRuntimeConfig`
- `IntakeSubmission`
- `Projector`

Exit criteria:

- names documented in code-facing spec
- implementation notes use exact terms consistently
- no ambiguous umbrella language left in the active design docs

Why first:

- if naming is mush, implementation gets mushy fast

---

### Step 2 — Define canonical schemas

Goal:

- turn architecture into typed contracts before touching runtime behavior

Build:

- TypeScript interfaces and/or Zod schemas for:
  - block definitions
  - preset definitions
  - tenant runtime config
  - generic intake submission envelope
  - projector result contracts

Likely files:

- adjacent to `agent/src/checklist/types.ts` or in new shared schema files

Exit criteria:

- schemas compile
- invalid shapes are rejected in tests
- at least one example preset validates cleanly

---

### Step 3 — Extract current trees into a definition layer

Goal:

- prove this is a compiler layer over the current runtime, not a second runtime

Start with:

- `identity`
- `booking`
- `message`
- `job`

Build:

- internal definition source for these live pieces
- compiler: preset/config → existing question-tree structures

Exit criteria:

- compiled output is behavior-equivalent to current tree path
- no runtime behavior change
- targeted tests prove parity

This is first real knife cut.

---

### Step 4 — Introduce generic intake submission envelope

Goal:

- stop persistence from being only domain-specific one-offs

Build:

- generic `intake_submissions` table or equivalent
- generic submission write before any specialized projection
- preserve current `job_inquiries` write path as projection behavior

Exit criteria:

- one completed job inquiry creates:
  - generic intake submission
  - projected `job_inquiries` row
- duplicate-call retry is still idempotent
- appointment stamping still happens exactly once

Why now:

- without the generic envelope, every new preset drags bespoke storage behind it

---

### Step 5 — Refactor current job inquiry route into projector pattern

Goal:

- separate durable generic capture from domain-specific side effects

Refactor current `capture_job_inquiry` flow into parts:

- validation / normalization
- generic submission write
- `job_inquiry` projector
- notification/stamping hooks

Current source of truth:

- orchestration / spoken contract: `src/routes/agentTools/messaging.ts`
- generic capture + projection persistence: `src/services/jobInquiryCapture.ts`

Exit criteria:

- existing route still works end to end
- internal architecture is split cleanly
- regression tests still pass

---

### Step 6 — Prove a second reusable path

Status:

- implemented and verified on 2026-08-12 via the `attach-meeting-notes` / `buy_service` meeting-context path

Goal:

- catch architecture lies before rollout

Chosen path:

- `attach-meeting-notes` as the second reusable capture/projection path
- rationale: it is already a live path tied to `buy_service` demo booking flow and proves the same generic envelope can feed a non-`job_inquiry` projection without inventing a second runtime or a fake domain table

What shipped:

- `src/services/meetingNotesCapture.ts` owns generic submission capture plus appointment-description projection
- `src/routes/agentTools/scheduling.ts` now keeps spoken contract / route shell while delegating persistence to that service
- generic envelope rows land in `intake_submissions` with `submission_type='meeting_notes'`
- existing appointment description stamp remains the projection output (`Caller notes: …`)

Exit criteria:

- second path uses same config/compiler/projector model
- no bespoke runtime is introduced
- no new special-case persistence mess appears

Verification:

- `npx vitest run tests/services/meetingNotesCapture.test.ts tests/routes/agentTools/agentTools.test.ts --run`
- `npx tsc --noEmit`
- `npm run build`
- `npm run test`

Result:

- passed

---

### Step 7 — Define first three vertical presets

Status:

- closed 2026-08-13

Goal:

- turn primitives into product-ready starting points

Start with:

- auto shop
- salon
- generic local service / home services

For each preset, define:

- included conversation blocks
- policy blocks
- knowledge categories
- outcomes
- required overrides
- forbidden combinations

Exit criteria:

- each preset validates
- each preset has one example tenant runtime config
- each preset has at least one call-path test

What shipped:

- `agent/src/checklist/presets.ts` defines:
  - `auto_shop_front_desk`
  - `salon_front_desk`
  - `local_service_front_desk`
- each preset lists `forbidden_trees` (all three forbid `job`; auto shop + salon also forbid `buy_service`) and required `defaults` (`booking_mode`, `primary_intake`)
- policy / knowledge / outcome arrays stay empty — those block kinds exist as types, not live runtime yet
- `agent/src/checklist/blockLibrary.ts` wraps the live trees those presets compile through
- `presetCatalog.test.ts` + `checklistRuntimeConfig.test.ts` + `#336` tool-exposure tests + `presetJourneys.test.ts` (book / message / buyer-demo)

Explicitly not in this step:

- unique salon-vs-auto-shop trees. They share the front-desk set until a real tenant needs a block the other should not have. Inventing them now would be a second script, not a preset.

---

### Step 8 — Wire preset selection into setup/onboarding

Status:

- closed 2026-08-13 except policy-block preview (those blocks are not live yet)

Already shipped:

- `tenants.checklist_preset_id` + `deriveChecklistRuntimeConfig(business_type, preset_id)`
- `/agent-tools/tenant-config` and tenant GET return `checklist_runtime_config`
- fallback `local_service_front_desk`; explicit preset wins over business_type
- live `ChecklistAgent` receives `runtimeConfig` when the wire body validates (`fetchTenantConfig`)
- Business Settings → Call checklist: derived vs explicit override + preview of enabled conversation blocks
- Setup business-type picker names the derived checklist for the current type

Still open (Step 9 remainder):

- approved wording tweaks (deferred)
- preview/dry-run beyond the live chips + policy selectors

Goal:

- make this a real product surface, not an internal toy

Add:

- business-type / preset choice during setup
- generated tenant runtime config from the selected preset
- preview of active blocks and policies

Exit criteria:

- new tenant can choose preset during setup
- runtime config is generated deterministically
- safe fallback/default exists

---

### Step 9 — Add safe tenant overrides

Status:

- first slice: disable conversation blocks
- second slice: booking/message policy modes + optional-field allowlist
- third slice: required-field enforcement (decline does not resolve)
- fourth slice: approved wording + next-call dry-run (closes the step)

Already shipped:

- `tenants.checklist_overrides` jsonb + write-time validation
- cannot disable `identity`, cannot disable a block the preset does not have
- invalid overrides 400 on write; ignored on read so a bad row cannot take tenant-config down
- Business Settings chips toggle optional blocks; identity is locked
- `booking_mode` (`offer_once` / `prefer` / `never`) and `message_mode` (`always` / `fallback_only`) persist and land in the live prompt
- `never` also drops the booking block from the compiled set
- `optional_node_ids` from a fixed allowlist flip those text nodes to listen-only (goodbye gate cannot stick on them)
- `required_node_ids` from a fixed allowlist: `record_answer` refuses `declined:true`, node stays open, `finish_call` stays shut
- a field cannot be both required and optional (listen-only + must-answer is a deadlock)
- Business Settings chips for required fields; picking required clears optional and vice versa
- `wording` map on approved product questions only (`WORDING_NODE_ALLOWLIST` = optional-field list). Identity `ask` text stays platform-owned (caller_phone format-lecture lesson)
- next-call dry-run on the Call checklist card: enabled/disabled blocks, booking/message policy, each previewable field as ASK / LISTEN / REQUIRED plus the ask the model will see
- empty wording reverts to the default ask; unknown wording keys 400

Still open:

- none. Step 9 exit criteria are met.

Goal:

- allow customization without letting tenants create chaos

Allow:

- enable/disable supported blocks
- tweak approved wording
- mark fields required/optional where supported
- choose booking/message policy modes

Do not allow yet:

- arbitrary custom logic
- custom code hooks
- unrestricted branching authoring

Exit criteria:

- override validation exists
- invalid configs are blocked before activation
- preview/dry-run exists

All three met.

---

### Step 10 — Build coverage before expansion

Status:

- closed 2026-08-13 in CI via `agent/src/checklist/step10Journeys.test.ts`
- five required paths + policy / unavailable / no-reask / no-double-write
- recruiter uses the full platform library (job is forbidden on the three front-desk presets)
- not a Playwright mic call — same host-tool layer a live call actually runs

Goal:

- keep the architecture honest before adding more presets and flows

Must-have tests:

- schema validation failures
- compile-to-tree parity
- already-answered values are not re-asked
- duplicate retries do not duplicate rows
- booking/message policy interactions
- service unavailable → available alternatives offered
- auto-shop and salon happy + edge flows

Required E2E before claiming done:

- one recruiter path
- one auto-shop path
- one salon path
- one details-only path
- one missing-phone recovery path

The bar is behavior, not percentages.

What shipped:

- recruiter + book, recruiter details-only, auto-shop alignment, salon stylist/color, missing-phone recovery
- already-answered fields leave `[ASK]`, duplicate `take_message` is `ALREADY DONE`, `NO_AVAILABILITY` keeps book `ready` and names `next_available`, `booking_mode=never` drops the booking tree

---

## 3. Execution phases

### Phase A — Contract freeze

Includes:

- step 1
- step 2

Deliverables:

- exact internal names
- typed schemas
- validation tests

Why this phase exists:

- implementation without contract discipline will rot immediately

---

### Phase B — Runtime parity

Includes:

- step 3

Deliverables:

- current `JOB_TREE` path compiled from definitions
- no behavior change
- parity tests

Why this phase exists:

- if this fails, the whole architecture is lying

---

### Phase C — Generic capture + projector split

Includes:

- step 4
- step 5

Deliverables:

- generic intake envelope
- `job_inquiries` projector
- preserved idempotency + appointment stamping

Why this phase exists:

- future presets need common persistence bones

---

### Phase D — Reuse proof + preset definitions

Includes:

- step 6
- step 7

Deliverables:

- second reusable flow
- first three presets
- preset validation, tool-exposure, and host-tool journey coverage

Why this phase exists:

- one flow proves little; two proves architecture has a pulse

---

### Phase E — Product surface

Includes:

- step 8
- step 9
- step 10

Deliverables:

- setup integration — shipped #338
- tenant-safe overrides — shipped #338–#339 plus wording + dry-run
- minimum E2E confidence for rollout — Step 10 host-tool journeys shipped

Why this phase exists:

- internal elegance means nothing if onboarding and safety are missing

---

## 4. Recommended immediate order

Remaining immediate order from the current checkpoint:

1. widen block depth only when a real tenant needs a tree the shared front-desk set does not have
2. optional: PSTN / Playwright replay of the five Step 10 paths on a live tenant

---

## 5. What must not happen

Do not:

- build a second runtime beside `agent/src/checklist/`
- jump straight to vertical presets without parity proof
- let tenant-authored executable code into the runtime
- create giant per-vertical scripts
- skip regression coverage because the config "looks right"

That is how you get a prettier way to ship regressions.

---

## 6. Success definition

This roadmap succeeds when:

- new business types are composed from reusable primitives instead of custom call engines
- the current live job path still works after extraction
- one generic capture layer supports multiple flows
- preset setup is fast and safe
- tenant overrides are constrained and validated
- tests prove behavior across unit, regression, and E2E layers

In one sentence:

**Turn one-off live call flows into a typed, testable preset system without breaking the existing question-tree runtime.**
