# VERTICAL-PRESET-BLOCK-ARCHITECTURE

> **Design/history doc, frozen at 2026-08-13 — NOT the live source of truth for
> current counts.** Numbers below (e.g. "the first three real preset bundles")
> describe the state as of that date. #388 (2026-08-31) added 28 more
> vertical-intake presets; the platform runs **33 presets** today. For the
> live, maintained catalog and counts, see `CLAUDE.md`'s `/agent/src/checklist/`
> bullet — where the code and this doc differ, the code wins.

**Status:** phases 1-4, presets, live `runtimeConfig`, setup UI, Step 9 overrides, and Step 10 CI journeys are implemented. **Date:** 2026-08-13. **Owner:** Dale.

**The ask:** turn the current one-off call flows into configurable, reusable building blocks that can be pre-packaged by business type. An auto shop should start with an auto-shop-ready set of blocks; a salon should start with salon-ready blocks; both should still be built from the same reusable primitives so the platform does not decay into twenty bespoke scripts.

---

## 1. Verdict in one paragraph

Build **vertical presets on top of reusable blocks**.

Not one giant "auto shop flow" and one giant "salon flow" hardcoded forever. Not arbitrary tenant-authored code. Not prompt soup. The right shape is:

- **reusable typed primitives** underneath
- **business-type preset bundles** in the middle
- **tenant overrides** on top

That gives fast onboarding, sane defaults, safe customization, and a product surface that can grow without turning every new industry into a fresh architecture project.

### Implemented checkpoint (2026-08-12)

The first real slice is now in the repo and verified:

- canonical block/preset/runtime vocabulary lives in `agent/src/checklist/blockTypes.ts`
- Zod validation for blocks, presets, runtime config, and intake envelopes lives in `agent/src/checklist/blockSchemas.ts`
- thin wrappers for the first live parity set live in `agent/src/checklist/blockLibrary.ts`
- `agent/src/checklist/blockCompiler.ts` compiles enabled conversation blocks into selectable live tree ids
- the checklist runtime now accepts `runtimeConfig` while preserving the full live tree library for tracker invariants
- `capture-job-inquiry` now writes a generic `intake_submissions` envelope before the existing `job_inquiries` projection
- `src/services/jobInquiryCapture.ts` now owns the generic capture + `job_inquiry` projection write while `src/routes/agentTools/messaging.ts` stays the route shell
- `src/services/meetingNotesCapture.ts` now proves a second reusable path by writing `submission_type='meeting_notes'` into `intake_submissions` before projecting to the appointment description
- `supabase/migrations/20260811160000_intake_submissions.sql` adds the generic table with FORCE RLS and repo-standard tenant/admin policies
- `agent/src/checklist/presets.ts` now defines the first three real preset bundles: `auto_shop_front_desk`, `salon_front_desk`, and `local_service_front_desk`
- `agent/src/checklist/blockLibrary.ts` now exposes the additional already-live conversation-block wrappers those presets compile through (`generic_subject`, `qa`, `buy_service`, `schedule_change`, `fix_computer`)
- `agent/src/checklist/presetCatalog.test.ts` proves preset validation, lookup, runtime materialization, and compile-to-live-tree behavior
- `agent/src/checklist/presetJourneys.test.ts` walks one host-tool journey per preset (auto-shop book, salon message, local-service buyer demo)
- each preset now declares `forbidden_trees` and required `defaults`

What is **not** done yet: unique salon-vs-auto-shop trees. Step 10 CI journeys live in `agent/src/checklist/step10Journeys.test.ts`. Live `ChecklistAgent` receives `runtimeConfig` from tenant-config. Owners pick the preset and toggle disable / booking / message / optional / required / wording, and see a next-call dry-run, under Business Settings → Call checklist.

---

## 2. What already exists in the repo

The current system already contains most of the pieces, just not yet in a first-class configurable form.

### Live question-tree runtime

- `agent/src/checklist/trees.ts`
  - current platform tree library
  - includes live `JOB_TREE`, `BOOKING_TREE`, `MESSAGE_TREE`, `BUY_SERVICE_TREE`, etc.
- `agent/src/checklist/types.ts`
  - node/type contracts for the tree system
- `agent/src/checklist/tracker.ts`
  - host-owned state and completion logic
- `agent/src/checklist/checklistTools.ts`
  - runtime tools like `set_purpose`, `record_answer`, `finish_call`

### Existing job-intake persistence path

- `src/routes/agentTools/schemas.ts`
  - `CaptureJobInquirySchema`
- `src/routes/agentTools/messaging.ts`
  - `/agent-tools/capture-job-inquiry`
  - durable write path, duplicate-call idempotency, owner notification, appointment stamping

### Superseded but still informative script-era intake

- `src/services/scripts/blocks.ts`
  - older rung/prompt-ladder wording for booking, offering a meeting, and job intake
  - useful as evidence/history, but not the live runtime

So the problem is not "invent call architecture from nothing." The problem is that the logic is spread across multiple layers and still feels one-off when it should be productized.

Important constraint: this should compile into the **existing question-tree runtime**, not create a second call engine beside it. `agent/src/checklist/` stays the execution path; presets and blocks become a higher-level configuration source for that runtime.

---

## 3. Core design decision

> **Business type must select a preset composition. It must not own runtime behavior directly.**

That means:

- `autoshop` is not a giant special-case code path
- `salon` is not a giant special-case code path
- a vertical preset is a **bundle of reusable pieces**
- a tenant runtime config is the actual source of truth for what runs on calls

This is the expensive-to-reverse decision. Make it now.

Why:

- two businesses in the same vertical will still differ
- blocks can be reused across verticals
- new presets become composition work instead of custom engineering
- the setup wizard can offer a strong default without locking tenants into it

---

## 4. The four kinds of reusable blocks

Earlier thinking treated "blocks" a little too broadly. The cleaner model is four separate classes.

### 4.1 Conversation blocks

These collect or confirm information from the caller.

Examples:

- identity
- booking
- message
- service selection
- vehicle intake
- stylist preference
- job inquiry
- estimate request
- reminder consent

These are the closest descendants of the current question trees.

### 4.2 Policy blocks

These change behavior and constraints, not the questions themselves.

Examples:

- cancellation window
- no walk-ins
- drop-off only
- consent required before SMS
- offer transfer vs take message
- whether booking is offered, required, or never offered

These should not be buried as ad hoc prose in conversation blocks if they are really platform/business rules.

### 4.3 Knowledge blocks

These define categories of business facts the AI can answer.

Examples:

- hours
- services
- pricing guidance
- locations
- staff specialties
- policies

This is separate from intake. Otherwise the system ends up shoving facts, rules, and questions into one structure and the call flow gets brittle.

### 4.4 Outcome blocks

These define what gets saved, triggered, or sent once the interaction completes.

Examples:

- save message
- create booking
- create estimate request
- create job inquiry
- stamp appointment note
- send owner notification
- send follow-up email

This is where generic submissions can be projected into specialized records.

---

## 5. Product shape

### 5.1 Block library

A typed reusable library of primitives.

Each block definition should capture:

- `block_id`
- `kind` (`conversation`, `policy`, `knowledge`, `outcome`)
- purpose / description
- trigger hints / selection examples
- fields or options
- conditional branches
- wording guidance
- validation rules
- summary rendering hints
- compatibility rules (`pairs_with`, `requires`, `conflicts_with`)

### 5.2 Vertical presets

A vertical preset is an ordered, opinionated bundle of blocks plus defaults.

Examples:

#### Auto shop preset

- identity
- booking
- service selection
- vehicle intake
- drop-off / pickup policy
- estimate approval policy
- message
- FAQ / business info

#### Salon preset

- identity
- booking
- service selection
- stylist preference
- treatment notes
- cancellation / late policy
- message
- FAQ / business info

#### Generic local service / home services preset

- identity
- booking
- service selection
- site / address intake
- estimate request
- message
- FAQ / business info

### 5.3 Tenant runtime config

Each tenant should select a preset and then own a concrete runtime configuration derived from it.

Tenant-level config should be able to:

- enable/disable blocks from the preset
- add a small number of extra compatible blocks
- tweak wording safely
- choose which fields are required
- change the order of safe sections
- choose whether booking is offered / required / disabled
- choose owner notification behavior

The tenant runtime config is what the live call uses. The preset is only the starting template.

---

## 6. Why this is better than giant vertical scripts

A giant per-vertical script sounds simpler until the second real customer arrives.

Problems with giant scripts:

- every vertical becomes a custom engineering branch
- shared improvements do not propagate cleanly
- duplicated wording and logic drift apart
- testing explodes because each script is effectively its own product
- setup UX becomes all-or-nothing instead of composable

Benefits of reusable blocks + presets:

- one tested primitive can power multiple verticals
- one platform fix can improve many tenants at once
- setup becomes guided rather than blank-canvas
- new verticals are composed, not reinvented
- the dashboard can eventually expose safe customization without exposing code

---

## 7. Declarative, not executable

> **Do not make tenant-authored or preset-authored scripts executable code.**

Use typed declarative config.

That means:

- JSON/TS/DB-backed schemas
- validated fields and branches
- known block kinds
- known actions/outcomes
- no arbitrary code hooks
- no freeform logic runtime that needs a sandbox

Why:

- validation
- versioning
- safe editing in UI later
- testability
- migration safety
- lower support burden

If "script" really means executable behavior, the platform inherits a debugger, a sandbox problem, runtime trust issues, and a permanent category of broken tenant flows. That is not a feature. That is an unpaid second product.

---

## 8. Recommended data model

The exact table names can move, but the shape should be roughly this.

### 8.1 Reusable definitions

- `block_definitions`
  - reusable block specs
  - typed and versioned

- `vertical_presets`
  - preset id
  - business type
  - ordered block list
  - default wording and policies

### 8.2 Tenant runtime config

- `tenant_block_configs`
  - tenant id
  - active preset
  - enabled blocks
  - tenant overrides
  - version / rollout metadata

### 8.3 Generic capture layer

- `intake_submissions`
  - tenant id
  - call id
  - preset id
  - selected block ids
  - caller identity summary
  - structured payload JSON
  - linked appointment id
  - rendered owner summary
  - status / timestamps

### 8.4 Optional specialized projections

- `job_inquiries`
- `estimate_requests` _(example future table / projection)_
- `vehicle_visits` _(example future table / projection)_
- `lead_requests` _(example future table / projection)_

Pattern:

- write one generic envelope first
- project to specialized rows second when needed

That preserves analytics and future flexibility while avoiding a new bespoke table for every experiment.

---

## 9. How current code maps to this model

### Current live reusable primitives already hiding in trees

From `agent/src/checklist/trees.ts`:

- `identity`
- `booking`
- `message`
- `generic_subject`
- `buy_service`
- `qa`
- `job`
- `schedule_change`
- `fix_computer`

That exact list matters. The point is not that the repo has a vague idea of blocks; it already has a small typed library of reusable call-purpose units. The architecture here is a way to formalize and package them.

### Current job inquiry is the best first extraction target

Why `JOB_TREE` should go first:

- real production path
- has branching
- has wording already paid for by live-call failures
- has a persistence route already implemented
- has optional meeting offer behavior
- has a downstream specialized record (`job_inquiries`)

### Existing persistence logic worth preserving

From `src/routes/agentTools/messaging.ts`:

- name/phone enforcement
- duplicate-call idempotency
- owner notification
- appointment note stamping
- durable DB write path

That route should become an outcome/projector layer, not remain a one-off domain island.

---

## 10. Example preset compositions

### 10.1 Auto shop

Goal: answer common service questions, book visits, capture vehicle/service details, and support estimate-oriented calls.

Preset composition:

- conversation: identity, service selection, booking, vehicle intake, estimate request, message
- policy: drop-off only, late arrival rule, cancellation window, reminder consent
- knowledge: hours, services offered, pricing guidance, warranty/policy notes, location
- outcomes: create booking, save estimate request, send owner notification, save message

Likely service-specific fields:

- make / model / year
- issue summary
- drivable or not
- preferred drop-off timing
- prior diagnosis / estimate

### 10.2 Salon

Goal: answer service questions, book appointments, capture preference notes, and support stylist-aware scheduling.

Preset composition:

- conversation: identity, service selection, booking, stylist preference, treatment notes, message
- policy: cancellation window, no-show / late policy, reminder consent
- knowledge: hours, services, pricing guidance, staff specialties, location
- outcomes: create booking, save note, send owner notification, save message

Likely service-specific fields:

- requested stylist
- color / cut / treatment notes
- new vs returning client
- special prep requests

### 10.3 Generic local service / home services

Goal: quickly sort requests, book visits or estimates, and capture site details.

Preset composition:

- conversation: identity, service selection, booking, address intake, estimate request, message
- policy: service area restriction, emergency escalation, cancellation window, reminder consent
- knowledge: service list, hours, service area, pricing guidance, emergency limitations
- outcomes: create booking, create estimate request, send owner notification, save message

Likely service-specific fields:

- service address
- issue description
- urgency
- property access notes

---

## 10b. Relation to business blueprints

This document is adjacent to, but not the same as, `docs/superpowers/specs/2026-07-12-business-blueprints-design.md`.

- **Business blueprints** = clone/setup acceleration for tenant configuration and operational graph shape
- **Vertical preset block architecture** = reusable call-behavior composition for the AI receptionist

They should fit together.

Recommended relationship:

- a business blueprint can choose a default vertical preset
- the vertical preset seeds the tenant runtime call config
- the setup graph / services / staff / resources remain a separate concern

In other words: blueprints help a tenant start with the right business configuration; vertical presets help the receptionist start with the right conversational behavior. Related, but not the same layer.

---

## 11. What not to build yet

Do not start with:

- a full visual flow builder
- arbitrary loops and mini-programming language features
- tenant-authored code hooks
- unrestricted custom tool execution from config
- deeply nested conditional logic beyond what real presets need
- a dozen verticals at once

Build the smallest real system that proves the model.

---

## 12. Recommended rollout

### Phase 1 — extract current job flow into block architecture without changing behavior

**Checkpoint status:** completed in the 2026-08-11 implementation slice.

Verified exit criteria:

- current `JOB_TREE` parity path reproduced through the new internal block-definition/compiler layer
- current wording and skip behavior preserved by compiling selectable tree ids back into the live checklist runtime
- no regression in duplicate protection or persistence path behavior

### Phase 2 — add generic intake envelope

**Checkpoint status:** completed in the 2026-08-11 implementation slice.

Verified exit criteria:

- completed job intake writes a generic `intake_submissions` row
- existing `job_inquiries` projection still works
- appointment stamping and owner notification still work

### Phase 3 — prove reuse with a second block/preset

Exit criteria:

- one more preset-backed path uses the same architecture cleanly
- recommended candidate: `buy_service` or an estimate/service-intake flow
- no new bespoke persistence architecture required

### Phase 4 — introduce business-type presets

Exit criteria:

- tenants can choose a preset during setup
- each preset maps to reusable blocks + policies + outcomes
- generated tenant runtime config is inspectable and versioned

### Phase 5 — safe tenant overrides

Exit criteria:

- owners/admins can safely enable/disable supported blocks and tweak allowed settings
- invalid configurations are rejected before activation
- preview / dry-run exists before a live rollout

---

## 13. Coverage requirements

This architecture will lie convincingly if only happy paths are tested. Coverage has to be specific.

### Unit coverage

- malformed block definitions rejected
- invalid preset compositions rejected
- branch resolution works
- already-answered fields do not get re-asked
- required-field enforcement works
- policy blocks influence runtime behavior correctly
- summary rendering works
- projector mappings work
- retry/idempotency behavior holds

### Regression coverage

- recruiter asks availability question → job path selected
- caller says "just pass it along" → meeting is not re-offered
- remote role asks plain wording: "What time zone is the job in?"
- booked meeting gets stamped exactly once
- duplicate tool retry does not duplicate inquiry rows
- caller-provided info already in state is not re-asked

### E2E coverage

- recruiter flow with booking
- recruiter flow details-only
- missing callback number forces recovery before completion
- auto-shop intake with vehicle details
- salon booking with stylist preference
- service unavailable path offers available alternatives rather than dead-ending

The bar is behavior, not percentages.

---

## 14. Initial preset recommendation

Start with three presets only:

- auto shop
- salon
- generic local service / home services

Why these three:

- they match the current product shape better than abstract professional-services flows
- they pressure-test booking, service selection, and structured intake in different ways
- they are varied enough to reveal whether the primitive set is actually reusable

If these three cannot share primitives cleanly, the architecture is wrong and needs fixing before expansion.

---

## 15. Naming recommendations

### This document

Recommended filename:

- `VERTICAL-PRESET-BLOCK-ARCHITECTURE.md`

Why this name:

- `VERTICAL` = business-type presets are central to the idea
- `PRESET` = they are templates/compositions, not hardcoded monoliths
- `BLOCK` = reusable primitives underneath
- `ARCHITECTURE` = this is system shape, not just UX copy or a feature stub

### Runtime concepts

Recommended terms:

- `block definitions` = reusable primitives
- `vertical presets` = predefined business-type bundles
- `tenant runtime config` = actual active per-tenant configuration
- `intake submissions` = generic captured payloads
- `projectors` = specialized persistence/output adapters

These names are plain and stable. That matters.

---

## 16. Final recommendation

Build this as:

- reusable typed block library
- four block classes: conversation, policy, knowledge, outcome
- vertical presets composed from those blocks
- tenant-level overrides constrained by validation
- generic intake submission layer with optional specialized projection

Do not build it as:

- giant per-vertical scripts
- tenant-authored executable code
- a visual builder first
- a blank-canvas setup system

In one sentence:

**Preconfigured business-type presets on top, reusable typed blocks underneath, tenant-safe overrides last.**

That is the product shape that scales.
