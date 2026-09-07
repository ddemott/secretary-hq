# SecretaryHQ SaaS — Architecture

**Last verified:** 2026-09-05 for filesystem/package facts (32 top-level route modules, 192 migrations, 26 defined agent tools in `tools.ts`, 40 committed Playwright spec files, dashboard on Next.js 16 / React 19, backend on Fastify 5). Test-pass counts below remain the 2026-08-14 full-suite snapshot until re-run.

> **External CRM sync reduced to Square only (2026-06-12).** The Jobber, HubSpot, ServiceTitan, and GoHighLevel integrations (route files, sync services, OAuth, webhooks) were deleted from the codebase. **Square remains the one surviving, live external CRM sync provider** — bidirectional push/pull via `src/routes/square.ts` + `src/services/crm/squareClient.ts` + `squareSync.ts`, dispatched from `src/services/syncOrchestrator.ts`. Calendar sync (Google + Outlook, push-only) is unchanged.

> **Migration shipped:** The voice-AI stack moved from Vapi + Supabase Edge Functions to LiveKit Agents + Fastify in commit `661d21d` (2026-04-27). Vapi account deleted; only Telnyx + LiveKit remain. TTS provider history: OpenAI → xAI Grok (2026-05) → OpenAI (2026-06-25) → **Deepgram Aura (2026-07-14, current)**; see §6.2 and `docs/FRAMEWORK_MIGRATIONS.md`.
>
> **Call flow:** production runs the **question-tree** architecture (`agent/src/checklist/`, `ENABLE_QUESTION_TREE`, on by default). The prompt ladder (`tenants.system_prompt`) and the TaskGroup rungs are flag-gated fallbacks and are NOT what a live call executes — see §6.3.

## Contents

- [1. Overview](#1-overview)
- [2. Directory Structure](#2-directory-structure)
- [3. Deployment Topology](#3-deployment-topology)
- [4. Data Model](#4-data-model)
- [5. Multi-Tenancy & Row-Level Security](#5-multi-tenancy-row-level-security)
- [6. Voice Loop](#6-voice-loop)
- [7. Voice AI Tools Catalog](#7-voice-ai-tools-catalog)
- [8. Phone Provisioning](#8-phone-provisioning)
- [9. Backend API (Fastify)](#9-backend-api-fastify)
- [10. Authentication & Authorization](#10-authentication-authorization)
- [11. Scheduling Engine](#11-scheduling-engine)
- [12. Knowledge Base (RAG)](#12-knowledge-base-rag)
- [13. Calendar Sync (Push-only)](#13-calendar-sync-push-only)
- [14. CRM Sync (Square only)](#14-crm-sync-square-only)
- [15. Billing (Stripe Lite)](#15-billing-stripe-lite)
- [16. Dashboard Architecture](#16-dashboard-architecture)
- [17. Async Work (no n8n)](#17-async-work-no-n8n)
- [18. Testing Strategy](#18-testing-strategy)
- [19. Observability](#19-observability)
- [20. Error Handling & Retry](#20-error-handling-retry)
- [21. Security Summary](#21-security-summary)
- [22. Known Gaps / Future Work](#22-known-gaps-future-work)

---

## 1. Overview

Multi-tenant AI receptionist SaaS for service businesses (tire shops, salons, auto shops, trades, fitness, food & beverage). HIPAA verticals are permanently excluded.

**Core loop:** Caller dials a tenant's Telnyx number → voice AI answers, identifies intent, checks the database (availability, customer history, skills, shifts, services, policies), books an appointment atomically, and syncs the result to the owner's dashboard + connected calendars + Square CRM.

**Layering:**

- **Edge**: Telnyx (PSTN + SIP) → LiveKit Cloud (orchestrator) → LiveKit agent worker on Railway (`secretary-hq-agent`: Deepgram Nova-3 STT, OpenAI GPT-4.1-mini LLM, **Deepgram Aura TTS**; no XAI key). Call sequencing = question trees (§6.3).
- **Tools**: 26 voice tools defined in `agent/src/tools.ts` against the tenant's Postgres — Fastify (Node) at `/agent-tools/*`. The live question-tree path offers a subset of them (12 base tools, plus 3 identity tools on goal-bearing calls) — see §7.
- **API**: Fastify (32 top-level route modules + `agentTools/` module dir) on Railway — serves the dashboard, handles webhooks, runs async work inline
- **DB**: Postgres + pgvector on Supabase, 192 migrations, RLS on every tenant-scoped table. Every single-column PK follows the `<table_singular>_id` convention (see `CODING_STANDARDS.md`)
- **UI**: Next.js 16 (App Router) + React 19 + Tailwind — deployed on Railway (production dashboard service)

---

## 2. Directory Structure

```
/
├── src/                          Fastify backend (Node)
│   ├── index.ts                  Entry — registers 32 top-level route modules + `agentTools/` dir (~420 lines)
│   ├── middleware.ts             withHandler, tenantMiddleware, registerJwtAuthHook, generateToken, AppError, logEvent
│   ├── routes/                   32 route modules + routeHelpers.ts
│   ├── services/                 flat files (calendar sync, OAuth, name/token/SMS utilities) + communications/ (Telnyx-only SMS + delivery webhooks), reminders/, tenants/, usage/ subdirs
│   └── database/                 getPool() singleton + createWithTenantClient(pool) factory + DatabaseService adapter
├── dashboard/                    Next.js 16 App Router
│   ├── app/                      page.tsx (landing), dashboard/page.tsx (app shell), layout.tsx, globals.css
│   ├── components/               ~80 feature components + ui/ primitives
│   │   └── ui/                   Badge, Button, Card, ConfirmModal, FolderTabs, Input, Modal, Select, Toast, TimeInput, PhoneInput, CoverageBar
│   ├── lib/                      api.ts, SessionContext, ThemeContext, VocabularyContext, hooks, types
│   ├── e2e/                      40 Playwright spec files
│   ├── server.js                 Custom HTTPS server (dev) + Railway deploy entry (prod)
│   └── 92 Vitest test files      React Testing Library + utility tests
├── supabase/
│   ├── migrations/               184 SQL migrations
│   └── seed.sql                  Platform admin + Bella's Hair Studio demo tenant
├── agent/                        LiveKit agent worker (Node) — deployed as Railway service `secretary-hq-agent`
│   └── src/                      index.ts (entry), prompt.ts, toolsClient.ts, sessionContext.ts, tools.ts
├── shared/                       Cross-runtime code
│   ├── getEmbedding.ts           OpenAI text-embedding-3-small wrapper
│   ├── normalizeForEmbedding.ts  gpt-4o-mini normalization before pgvector storage
│   └── scheduling.ts             Core scheduling algorithm (shared between booking RPC caller and UI)
├── scripts/                      bootstrap, setup-db, seed-db, simulate.sh (status/tools/rag/call harness)
├── docs/                         Architecture, deployment, UI/UX, TODO, migrations, bugs, plans
├── certs/                        Self-signed HTTPS certs for local dev
├── railway.json + nixpacks.toml  Backend deploy config
├── CLAUDE.md + README.md         Project overview + developer docs
└── .env.* + package.json         Config + deps
```

**Shipped in LiveKit migration (commit `661d21d`):**

- `agent/` — separate Node.js package for the LiveKit agent worker (deployed as Railway service `secretary-hq-agent`)
- `src/routes/agentTools/` — voice-AI tools (originals + OTP helpers); replaced the deleted `supabase/functions/vapi-tools/`

---

## 3. Deployment Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Caller (phone)                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ PSTN / SIP
                               ▼
                       ┌──────────────────┐
                       │  Telnyx (SIP)    │  +1 (630) 822-9086 (live)
                       └────────┬─────────┘
                                │ SIP trunk
                                ▼
                       ┌──────────────────┐
                       │  LiveKit Cloud   │
                       │ (SIP bridge +    │
                       │  orchestrator)   │
                       └────────┬─────────┘
                                │ WebSocket (room dispatch)
                                ▼
                      ┌────────────────────┐
                      │  Agent Worker      │  Railway: secretary-hq-agent
                      │  (Node, LiveKit    │  worker AW_vPmGExrgTeGn
                      │   Agents SDK)      │
                      └─────────┬──────────┘
                                │ HTTP + x-agent-secret
                                ▼
                    ┌─────────────────────┐
                    │  Fastify Backend    │  secretary-hq-production.up.railway.app
                    │  32 route modules   │  Railway (Nixpacks, Node 22)
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼─────────────────────┐
          ▼                    ▼                     ▼
    ┌──────────┐        ┌────────────┐        ┌──────────────┐
    │ Postgres │        │  OpenAI /  │        │ Integrations │
    │ Supabase │        │  Deepgram  │        │ Google /     │
    │ + vector │        │  (TTS too) │        │ Outlook /    │
    └──────────┘        └────────────┘        │ Stripe       │
                                              └──────────────┘
          ▲
          │
    ┌─────┴────────┐
    │  Dashboard   │  Railway (current production)
    │  Next.js 16  │
    └──────────────┘
```

| Service            | Platform                               | Region / URL                                                                                                     | Deploy mechanism                                                                                                       |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Backend (Fastify)  | Railway                                | `secretary-hq-production.up.railway.app`                                                                               | Nixpacks auto-deploy from `main`                                                                                       |
| Agent worker       | Railway (service `secretary-hq-agent`)       | WebSocket long-runner, worker ID `AW_vPmGExrgTeGn`, registers with LiveKit under agent name `secretary-hq-agent` | Node.js package under `agent/`                                                                                         |
| Database           | Supabase (managed Postgres + pgvector) | `sgibijfchvfuizudrmir` (us-west-2)                                                                               | Migrations applied via `npm run db:migrate`                                                                            |
| Dashboard          | Railway                                | `dashboard-production-cee3.up.railway.app`                                                                       | Next.js build via `dashboard/server.js`                                                                                |
| Telephony          | Telnyx                                 | `+1 (630) 822-9086` (live; `937-9478` + `866-1960` decommissioned)                                               | SIP Connection `livekit-outbound` (ID `2945038451784812111`); provisioned per tenant via `POST /provisioning/activate` |
| Voice orchestrator | LiveKit Cloud                          | `ai-secretary-nmlkkmgf.sip.livekit.cloud:5060` (SIP); WebSocket for agent                                        | Dispatch rule `SDR_WEL49AwBB4NW` routes to agent name `secretary-hq-agent`                                             |
| Stripe             | Hosted                                 | Route exists at `/billing/webhook` on Railway                                                                    | Stripe endpoint registration and final price IDs are still pending                                                      |

**Graceful shutdown:** Backend handles `SIGTERM`/`SIGINT` (Railway sends these during deploys) — closes Fastify and drains the DB pool.

**Single DB pool:** Backend uses one pool via `DATABASE_URL`. No separate `api_user` pool — `FORCE ROW LEVEL SECURITY` on all 20 RLS-enabled tables enforces tenant isolation even as the `postgres` superuser (required for Supabase-managed Postgres).

---

## 4. Data Model

### 4.1 Core entities

```
┌─────────────┐     ┌──────────────┐    ┌──────────────┐
│  tenants    │◄────│    users     │    │  customers   │
│             │     │ (email, pw)  │    │ (per-tenant) │
└──────┬──────┘     └──────────────┘    └──────┬───────┘
       │                                        │
       │         ┌───────────────┐              │
       ├────────►│   employees   │              │
       │         └──────┬────────┘              │
       │                │                       │
       │         ┌──────▼──────────┐            │
       │         │employee_schedule│            │
       │         │ (date-based)    │            │
       │         └─────────────────┘            │
       │                                        │
       │         ┌───────────────┐              │
       ├────────►│   resources   │              │
       │         └──────┬────────┘              │
       │                │                       │
       │                ▼                       ▼
       │         ┌──────────────────────────────────┐
       │         │          appointments             │
       │         │ (start_time, end_time,           │
       │         │  resource_id, employee_id,       │
       │         │  customer_id, service_id,        │
       │         │  status, call_id)                │
       │         └──────────────────────────────────┘
       │
       │         ┌──────────────┐       ┌─────────────────┐
       ├────────►│   services   │───────│ service_employee│
       │         │ (duration,   │       │ (skill req)     │
       │         │  price)      │       └─────────────────┘
       │         └──────┬───────┘       ┌─────────────────┐
       │                │───────────────│ service_resource│
       │                                │ (capability)    │
       │         ┌───────────────┐      └─────────────────┘
       ├────────►│ tenant_skills │
       │         └───────────────┘
       │
       │         ┌─────────────────┐
       ├────────►│   tenant_docs   │  (pgvector knowledge base)
       │         │ (embedding,     │
       │         │  normalized)    │
       │         └─────────────────┘
       │
       │         ┌──────────────────┐   ┌──────────────────┐
       ├────────►│call_transcripts  │   │  call_summaries  │
       │         └──────────────────┘   └──────────────────┘
       │
       │         ┌──────────────────────────┐
       ├────────►│tenant_integration_settings│ (Square OAuth tokens; Jobber/HubSpot/ServiceTitan removed 2026-06-12)
       │         └──────────────────────────┘
       │         ┌────────────────────┐
       ├────────►│  entity_sync_map   │ (Square local↔external ID mapping; other CRMs removed 2026-06-12)
       │         └────────────────────┘
       │
       │         ┌─────────────────────┐  ┌──────────────────┐
       └────────►│tenant_calendar_sett.│  │appointment_sync_m│
                 └─────────────────────┘  └──────────────────┘
```

### 4.2 Tables (20 RLS-enabled + 6 global)

**Tenant-scoped (RLS + FORCE RLS):**
`tenants`, `users`, `customers`, `employees`, `resources`, `services`, `appointments`, `service_employee`, `service_resource`, `tenant_skills`, `tenant_docs`, `employee_schedule`, `call_transcripts`, `call_summaries`, `tenant_integration_settings`, `entity_sync_map`, `tenant_calendar_settings`, `appointment_sync_map`, `reminder_schedules`, `unanswered_questions`.

**Global / platform:**
`business_templates` (vocabulary per business type), `audit_log`, `record_versions` (version history), `voice_sessions`, `consent_records`, `opt_out_records`.

**Dropped 2026-04-30:**
`employee_shifts` (weekly patterns) was retired entirely (NEEDS-REFACTORING #4 Phase 2). Setup wizard now collects weekly availability in form state and posts the pattern to `POST /shifts/expand-weekly`, which fans it into `employee_schedule` for 4 weeks at finalize. The `/shifts` legacy CRUD routes, `/coverage/staffing` analytics, and `Api.shifts.list/create/update/delete` are all gone.

### 4.3 Key columns

- All entity IDs are **UUID** (services + employees migrated from `SERIAL` in Phase 9).
- Every tenant-scoped row has `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
- Soft-deletable tables carry `is_deleted BOOLEAN DEFAULT false` + `deleted_at TIMESTAMPTZ` with partial indexes (e.g., `WHERE is_deleted = false`).
- `customers.phone` is stored in E.164 format (`+1...`). `normalizePhone()` rejects anything with < 10 digits.
- `appointments` has CHECK constraint `start_time < end_time`, indexes on `(tenant_id, start_time)` + `(resource_id, start_time)` for availability checks, and partial index on `call_id WHERE call_id IS NOT NULL` for back-reference to the originating call (LiveKit room ID; was Vapi call ID pre-`661d21d`).

### 4.4 Stored procedures (key RPCs)

| RPC                                                | Purpose                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `book_appointment_atomic(...)`                     | Legacy atomic booking — 7-layer constraint check + past-time rejection, business hours validation, fuzzy service matching. Used by dashboard QuickBook.                                                                                                                |
| `book_with_scheduling_atomic(...)`                 | Production voice-AI booking path — uses `employee_schedule` for shift validation (date-based), night-shift support (cross-midnight), specific error codes (`TIMESLOT_OCCUPIED`, `NO_SKILLED_EMPLOYEE`, `EMPLOYEE_NOT_SCHEDULED`, `NO_AVAILABILITY`, `INVALID_PARAMS`). |
| `check_availability_with_tz(...)`                  | Timezone-aware availability check — queries `employee_schedule` for active employees + scans `appointments` for conflicts.                                                                                                                                             |
| `get_effective_shifts(tenant_id, date)`            | Returns entries from `employee_schedule` (date-based only).                                                                                                                                                                                                            |
| `get_effective_shifts_bulk(tenant_id, start, end)` | Bulk variant — returns all employees' shifts in a date range. Used by scheduler for efficient loading.                                                                                                                                                                 |
| `search_tenant_docs(tenant_id, query_embedding)`   | Cosine similarity over `tenant_docs.embedding` (pgvector `<=>` operator).                                                                                                                                                                                              |
| `check_coverage_gaps(tenant_id)`                   | Returns list of services with missing coverage (no qualified employee or resource).                                                                                                                                                                                    |
| `link_orphaned_transcripts()`                      | Post-call cleanup — joins transcripts to summaries where `call_id` matches. Called from `dispatcher.handleCallEnded()`.                                                                                                                                                |
| `set_tenant_context(uuid)`                         | Sets `app.current_tenant_id` session variable for RLS policy evaluation. Called by `withTenantClient()`.                                                                                                                                                               |
| `fn_audit_trigger()`                               | `SECURITY DEFINER` trigger — writes before/after snapshots to `audit_log` on INSERT/UPDATE/DELETE of appointments, customers, resources.                                                                                                                               |

---

## 5. Multi-Tenancy & Row-Level Security

### 5.1 The context variable

Every tenant-scoped table has RLS policies using `current_setting('app.current_tenant_id', true)::uuid`. Before any query that touches tenant data, the backend sets this session variable:

```ts
// src/database/index.ts — createWithTenantClient(pool) factory
await client.query(`SELECT set_tenant_context($1)`, [tenantId]);
// query runs here, RLS auto-filters
await client.query(`SELECT set_config('app.current_tenant_id', '', false)`);
client.release();
```

### 5.2 FORCE ROW LEVEL SECURITY

Supabase's managed Postgres doesn't let us create a separate `api_user` role. Without FORCE, the `postgres` superuser role bypasses RLS entirely. Migration `20260323000000_force_rls_single_pool.sql` applies `FORCE ROW LEVEL SECURITY` to all 20 RLS-enabled tables, which makes RLS apply even to superusers.

### 5.3 Admin bypass

Super-admin operations (cross-tenant queries, tenant listing, user registration) need to bypass RLS. Three tables (`tenants`, `users`, `business_templates`) carry an additional policy: **if `app.current_tenant_id` is unset, allow all rows**. Admin routes acquire a connection without calling `set_tenant_context()` — effectively running in admin mode.

### 5.4 Audit trigger

`fn_audit_trigger` is marked `SECURITY DEFINER` so it can insert into `audit_log` regardless of the caller's RLS context. This keeps the audit trail complete even during admin operations.

---

## 6. Voice Loop

### 6.1 Current flow (LiveKit Agents, shipped in `661d21d`)

1. **Inbound call** — Telnyx SIP trunk → LiveKit Cloud SIP inbound trunk.
2. **Room creation** — LiveKit dispatch rule `SDR_WEL49AwBB4NW` creates a room with metadata `{ tenant_id }` (agent name `secretary-hq-agent`).
3. **Agent worker** — Node.js worker (Railway service `secretary-hq-agent`) joins the room. `agent/src/index.ts` speaks the tenant's pre-generated greeting (`buildGreeting()`, via `session.say()`) and then constructs ONE of three call architectures — see §6.3.
4. **Conversation** — Deepgram Nova-3 (STT) → **OpenAI GPT-4.1-mini** (voice LLM since 2026-07-20; 4o-mini still runs summaries/classify/fallback) → **Deepgram Aura TTS** (`aura-asteria-en`; per-tenant `tenants.tts_voice`). **`tenants.tts_speed` is INERT under Aura** — the plugin appends `?speed=` to the WS upgrade URL, Aura answers 400, the socket never opens and the line goes completely silent. That outage (2026-07-14) is why `cd agent && npm run verify:tts` exists and is mandatory before any TTS change ships.
5. **Tool execution** — LLM issues tool calls → HTTP POST to `https://secretary-hq-production.up.railway.app/agent-tools/*` with `x-agent-secret` header.
6. **Business logic** — Fastify route → `withTenantClient()` → Postgres RPCs and pgvector queries.
7. **Response** — JSON `{ success: true, result: ... }` or `{ success: false, error: ... }` with HTTP 200 — the LLM relays both shapes naturally.
8. **Call end** — LiveKit room close event → `src/routes/voice.ts` handles summary generation + embedding + `link_orphaned_transcripts()`.
9. **Post-call async** — Appointment mutations trigger fire-and-forget sync (via `syncOrchestrator.ts`) to Google/Outlook calendars **and** Square from route handlers.

### 6.2 TTS history — OpenAI → xAI Grok (2026-05) → OpenAI (2026-06-25) → **Deepgram Aura (2026-07-14, current)**

**Current: Deepgram Aura.** Native WebSocket streaming — audio is emitted as the words are produced. Configured per tenant via `tenants.tts_voice`; `tts_speed` is not passed (see §6.1).

**Why the switch off OpenAI TTS (2026-07-14):** the OpenAI LiveKit plugin is **non-streaming** — it buffers the entire reply before emitting any audio, so every turn was silence-then-a-burst. Chopping the input into sentences with `StreamAdapter` only traded one gap for a gap between every sentence. **You cannot make a non-streaming engine stream by chopping its input finer.**

**Historical (no longer in the codebase):** the Grok/xAI phase (`agent/src/grokTTS.ts`, `XAI_TTS_VOICE`) was removed entirely on 2026-06-25 — no `XAI_API_KEY` is referenced anywhere. The OpenAI-TTS phase that followed it is likewise gone. Full index in `docs/FRAMEWORK_MIGRATIONS.md`.

### 6.3 Call flow — THE QUESTION-TREE ARCHITECTURE (what production runs)

`agent/src/index.ts` selects one of three, in this precedence order:

| Flow | Flag | Status |
|---|---|---|
| **`ChecklistAgent`** — question trees (`agent/src/checklist/`) | `ENABLE_QUESTION_TREE`, `(v) => v !== 'false'` — **ON unless disabled** | **LIVE. This is production.** |
| `CallRootAgent` — TaskGroup "rungs" (`agent/src/tasks/`) | `ENABLE_TASK_GROUP=true` AND question-tree off | Fallback. Superseded 2026-07-21. |
| `SpeakingAgent` — the prompt ladder (`prompt.ts` + `tenants.system_prompt`) | both flags off | Fallback. The original design. |

**How question trees work.** The model is NOT given a script to follow. Instead:

- **Trees are data** (`checklist/trees.ts`). 10 in `PLATFORM_TREE_LIBRARY`: `identity`, `booking`, `message`, `generic_subject`, `qa`, `job`, `buy_service`, `schedule_change`, `fix_computer`, `case_intake`. Nodes are `text`, `choice` (if-branch: answering one option activates its children and marks siblings `not_applicable`), or `action` (completed ONLY by a real tool's success id).
- **Host code owns all state** (`checklist/tracker.ts`). 10 node statuses; it renders the live checklist into the model's context each turn (`[ASK]` / `[listen]` / `[ACTION NOW]` / `[✓]`), discards answers stranded on a branch the caller abandoned, and exposes `isResolved()`.
- **`isResolved()` is the goodbye gate.** `finish_call` refuses to close the call while any selected node is unresolved. **This gate replaced book-first sequencing**: a stated goal cannot be forgotten because the call cannot END on it. Callers may answer out of order, in any order.
- **The model has three jobs:** `set_purpose` (choose trees off a menu), `record_answer` (fill anything it hears), and call the action tool when the checklist says `[ACTION NOW]`. Plus `answer_question` (RAG) at any moment.

**Presets decide what a call CAN do (added 2026-08-12/13, ROADMAP Steps 7–9).** `tenants.checklist_preset_id` + `tenants.checklist_overrides` → `deriveChecklistRuntimeConfig` → `/agent-tools/tenant-config` (`checklist_runtime_config`) → `ChecklistAgent({ runtimeConfig })`. Five presets: `auto_shop_front_desk`, `salon_front_desk`, `local_service_front_desk` (shared front-desk tree set), `owner_for_hire_front_desk`, which adds `job` for solo professionals whose line takes work offers, and `law_firm_front_desk` (2026-08-14), which adds `case_intake` — the only tree whose intake ends in a human take-or-decline decision rather than a booking. **`ChecklistOverrides` can only SUBTRACT** (`disabled_conversation_blocks`, `booking_mode`, `message_mode`, `optional_node_ids`, `required_node_ids`) — there is no ADD verb, so **a tree missing from the preset is unreachable by that tenant no matter what the model asks for.** That is not theoretical: `job` sat in `forbidden_trees` on all three original presets, and two recruiter calls on 2026-08-13 to a line advertising the owner for hire wrote zero `job_inquiries` rows (`CALL1.md` / `CALL2.md`). `presetCatalog.test.ts` now fails CI on any orphaned platform tree; `fix_computer` is the single declared exception.

**Consequence for anyone changing call behaviour:** a tenant's `system_prompt` is **never passed to the model** on a live call — `ChecklistAgent` receives a one-line persona. Editing `src/services/scripts/blocks.ts` or reinstalling a tenant script changes nothing. Behaviour changes go in `agent/src/checklist/trees.ts`, and whether a tenant can reach them goes in the preset. Full design: `docs/QUESTION_TREE_ARCHITECTURE.md`.

---

## 7. Voice AI Tools Catalog

`agent/src/tools.ts` defines **26** real tools, implemented as POST routes under `src/routes/agentTools/` (a DIRECTORY since 2026-07-11 — split from a single 2,517-line file).

**But defining a tool does not put it in front of the model.** Under question trees, `selectedTools()` (`agent/src/checklist/checklistTools.ts`) rebuilds the toolset from the currently selected trees, and presents **12 base tools**, plus **3 identity tools whenever the `identity` tree is selected** (which is true on goal-bearing calls, so most real calls see 15):

| Group | Tools |
|---|---|
| Base (always) | `set_purpose`, `record_answer`, `finish_call`, `answer_question` (wraps `get_company_policy_answer` — RAG under another name) |
| Action nodes (per selected tree) | `book_with_scheduling`, `take_message`, `capture_job_inquiry`, `cancel_appointment`, `reschedule_appointment` |
| Passthrough (per selected tree) | `get_available_slots`, `get_service_catalog`, `get_my_appointments` |
| Identity add-ons (when `identity` is selected) | `get_customer_context`, `send_verification_code`, `verify_phone_code` |

The other 11 are **never offered on a live call.** Some are dead by design: `start_booking` / `manage_appointment` were ladder-era ROUTERS, `book_appointment` / `check_availability` / `get_scheduling_options` are superseded, and `record_sms_consent` / `send_self_service_link` are gated off with SMS anyway. **The rest are capability the product still does not expose on the live question-tree path**: `transfer_call` — *so there is still no live human handoff on a production call* — plus `page_owner_via_sms`, `attach_meeting_notes`, `save_customer_preference`, `identify_caller`, `get_detailed_customer_history`, and `find_caller_by_name`.

To make a tool reachable it must be an `action` node in a tree, a `TREE_PASSTHROUGH_TOOLS` entry, or a base tool.

**Action tools are WRAPPED, not passed raw** (`wrapAction`): a completed action refuses to run twice (anti-double-book), a blocked one names its unmet prerequisites, omitted arguments are backfilled from the tracker's recorded answers, completion requires a real success id in the response, and two consecutive failures rewrite the tool's own result to "stop retrying, take a message."

### 7.1 Auth contract

- **Header:** `x-agent-secret: <AGENT_SECRET>` (must match the backend's env var, ≥32 chars). The shared `preHandler` in `src/routes/agentTools/index.ts` rejects anything else with `401` for any URL starting with `/agent-tools/`.
- **Tenant scoping:** every body carries `tenant_id` (UUID). These routes are exempt from `tenantMiddleware` because the agent worker isn't logged in as a tenant user; tenant enforcement is at the SQL/RPC layer via `withTenantClient(tenant_id)`.
- **Validation:** every body parsed with Zod (Zod schemas in `src/routes/agentTools/schemas.ts`). Failures return `success: false` with the field paths.

### 7.2 Response envelope

Every route returns HTTP 200 with one of:

```json
{ "success": true, "result": <tool-specific> }
{ "success": false, "error": "<human-readable message>" }
```

200-on-failure is deliberate — the LLM paraphrases the `error` string conversationally for the caller, instead of the HTTP client throwing.

### 7.3 Core agent-tools routes (booking/knowledge subset)

> The table below is the original 10 Fastify `/agent-tools/*` routes. The agent defines **26 real tools** today in `agent/src/tools.ts`; this table documents the original booking/knowledge subset, not the full live catalog. For the current reachability split, see §7 above and `docs/VOICE_AGENT_PLAYBOOK.md`.

| Route                                      | Input (Zod)                                                                                                                  | Return shape                                                                                                                                                                | Backing logic                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /agent-tools/service-catalog`        | `{ tenant_id }`                                                                                                              | `{ services: [{ id, name, duration_minutes, price, description }] }`                                                                                                        | `SELECT * FROM services WHERE is_deleted = false`                                                                          |
| `POST /agent-tools/customer-context`       | `{ tenant_id, phone }`                                                                                                       | `{ customer, last_appointment, recent_calls }` (or `{ customer: null }` for new caller)                                                                                     | Caller phone lookup; routing to existing customer record + history                                                         |
| `POST /agent-tools/check-availability`     | `{ tenant_id, resource_id, start_time, end_time }`                                                                           | `{ available: boolean, conflicts?: [...] }`                                                                                                                                 | `check_availability_with_tz()` RPC (timezone-aware)                                                                        |
| `POST /agent-tools/policy-answer`          | `{ tenant_id, question }`                                                                                                    | `{ answer: string \| null, source_doc_ids: string[] }`                                                                                                                      | `search_tenant_docs()` RPC over pgvector + OpenAI embedding of the question                                                |
| `POST /agent-tools/book-appointment`       | `{ tenant_id, resource_id, start_time, end_time, phone, name?, description?, employee_id?, location?, call_id? }`            | `{ appointment_id, status }` or `{ ask_for_phone: true, message }`                                                                                                          | Legacy atomic booking — `book_appointment_atomic()` RPC. Gates on `isValidPhone(phone)` before the RPC.                    |
| `POST /agent-tools/scheduling-options`     | `{ tenant_id, requirements: { serviceType, requiredResourceCapabilities?, requiredEmployeeSkills? }, window: { from, to } }` | `{ options: [{ start_time, end_time, resource_id, employee_id }, ...] }`                                                                                                    | Pure algorithm in `shared/scheduling.ts:selectAssignments()` — no DB write                                                 |
| `POST /agent-tools/book-with-scheduling`   | `{ tenant_id, requirements, window, phone, name?, description?, location?, call_id? }`                                       | `{ appointment_id, status }` or `{ ask_for_phone: true, message }` or specific error code (TIMESLOT_OCCUPIED, NO_SKILLED_EMPLOYEE, EMPLOYEE_NOT_SCHEDULED, NO_AVAILABILITY) | **Production booking path** — `book_with_scheduling_atomic()` RPC with 7-layer validation. Gates on `isValidPhone(phone)`. |
| `POST /agent-tools/available-slots`        | `{ tenant_id, service_type, date }` (date `YYYY-MM-DD`)                                                                      | `{ slots: [{ start_time, end_time }, ...] }`                                                                                                                                | Consolidated slot aggregator, single query — replaces multi-round-trip discovery                                           |
| `POST /agent-tools/send-verification-code` | `{ tenant_id, phone }`                                                                                                       | `{ message: "I just sent a verification code to <phone>..." }`                                                                                                              | OTP send via `telnyxSms.sendSms`. 6-digit code, 10-min TTL, bcrypt-hashed. Rate-limited 3/phone/hour, 100/tenant/day.      |
| `POST /agent-tools/verify-phone-code`      | `{ tenant_id, phone, code }` (code numeric)                                                                                  | `{ verified: boolean, message }`                                                                                                                                            | Verifies hashed code from `phone_verifications` table. 5 attempts max per code.                                            |

### 7.4 OTP flow integration

`book-appointment` and `book-with-scheduling` reject invalid/missing phones with `{ ask_for_phone: true, message: "..." }`. The agent prompt instructs the LLM:

1. Read the message to the caller (asks for a callback number).
2. On the spoken phone number, call `send-verification-code(phone)` and read its `message` to the caller.
3. On the spoken 6-digit code, call `verify-phone-code(phone, code)`.
4. On `verified: true`, retry the original booking tool with the verified phone.

Caller-ID phones that pass `isValidPhone()` skip the OTP loop entirely.

---

## 8. Phone Provisioning

### 8.1 Activation flow (`POST /provisioning/activate`)

1. Owner clicks "Activate Phone" in the setup wizard with an area code.
2. Backend calls **Telnyx Numbers API** to search inventory + purchase a number (`src/services/telnyxNumbers.ts`).
3. Backend assigns the number to SIP Connection `livekit-outbound` (ID `2945038451784812111`) so Telnyx routes inbound calls to LiveKit Cloud's SIP ingress.
4. LiveKit dispatch rule `SDR_WEL49AwBB4NW` (already configured at the project level, not per-tenant) routes inbound calls to a room with metadata `{ tenant_id }`. The agent worker `secretary-hq-agent` picks up rooms with agent name `secretary-hq-agent`.
5. Tenant row updated: `inbound_phone`, `telnyx_phone_number_id`, `phone_status = 'active'`.

Rollback on failure — if step 3 fails, step 2's number is released. (No Vapi assistant creation step — that was retired with the LiveKit migration in `661d21d`.)

### 8.2 Deactivation flow (`POST /provisioning/deactivate`)

Releases the Telnyx number via the API and clears `telnyx_phone_number_id`, `inbound_phone`, `phone_status = 'deprovisioned'`. DB deactivation always succeeds even when the Telnyx release call fails (warning surfaced in the response).

---

## 9. Backend API (Fastify)

### 9.1 Route modules (32 + `agentTools/` dir)

32 top-level route modules live directly under `src/routes/`: health, callerSimulator, auth, tenants, appointments, customers, employees, users, shifts, resources, services, mappings, skills, calendar, knowledge, analytics, setup, vocabulary, billing, provisioning, square (sole surviving external CRM after competitor removals 2026-06-12), voice, versionHistory, communications, reminders, demo, selfService, exportData (tenant data portability), and auditLog (owner change history). `src/index.ts` also wires the `agentTools/` module dir, which owns the `/agent-tools/*` surface behind a shared `index.ts`. Recent additions include callerSimulator, data export, and audit surfaces. `src/index.ts` is slim — imports each `register*Routes(...)` and wires them. The `withTenantClient` it passes is built from `createWithTenantClient(pool)` (see `src/database/index.ts`); the pool itself comes from `getPool()` so the reminder scheduler and communications service share the same singleton.

### 9.2 Middleware layer (`src/middleware.ts`)

- **`withHandler(fn)`** — Decorator wrapping every route handler. Catches thrown `AppError`, converts to consistent `{ success: false, error, details? }` response. Logs request + response with structured fields.
- **`registerJwtAuthHook(app, pool)`** — onRequest hook that decodes Bearer tokens, rejects expired/forged ones with 401, and rejects tokens issued before the user's `password_changed_at` (so a password rotation invalidates outstanding sessions). Public routes bypass.
- **`tenantMiddleware`** — Reads `tenant_id` from query/body/JWT, attaches it to `request.tenantId`, and enriches the request logger with `{ tenantId, userId }` so every downstream log line carries tenant context. The tenant existence check happens inside `withTenantClient` when the route runs (returns `TENANT_NOT_FOUND` → 404).
- **`generateToken({ tenant_id, user_id, email })`** — Signs an 8h JWT. Used by the auth route on login/register.
- **`AppError`** — Typed error class with HTTP status + error code. Preferred over `throw new Error()`.
- **`requireAuth`** / **`requireTenantId`** — Per-route guards.
- **`logEvent(req, name, fields)`** / **`logWarning` / `logError`** — Structured JSON logging via Pino.

### 9.3 Request lifecycle

```
Request
  → CORS + helmet + rate-limit (all routes)
  → JWT verification (protected routes) → extract tenant_id
  → tenantMiddleware (tenant-scoped routes) → verify tenant exists
  → withHandler(handler)
    → handler body
      → withTenantClient(pool, tenantId, async (client) => {
          set_tenant_context(tenantId)
          await handler logic (SELECT/INSERT/UPDATE via client)
          set_tenant_context(NULL)
        })
      → Zod validation at boundaries
      → assertRowAffected() on UPDATE/DELETE
    → catches AppError / Error, formats response
  → Response
```

### 9.4 Validation & response conventions

- Every mutation validated by a Zod schema at the API boundary.
- Every response uses `{ success: boolean, ...payload | error }` envelope.
- Every UPDATE/DELETE uses `assertRowAffected()` — zero-row operations return 404, never silent success.
- All entity IDs validated by `requireValidUUID()`.
- Pagination via `parsePagination(req.query)` (default limit 50, max 200).

### 9.5 Shared route helpers (`src/routes/routeHelpers.ts`)

`sendValidationError`, `sendNotFound`, `sendSuccess`, `sendConflict`, `assertRowAffected`, `requireValidUUID`, `parseDateRange`, `parsePagination`.

### 9.6 Security stack

- `@fastify/helmet` — standard security headers.
- `@fastify/rate-limit` — 100 req/min globally, 5 req / 5 min on `/auth/login` + `/register`.
- CORS via `CORS_ORIGIN` env var (restrict to dashboard origin in production).
- HTTPS in dev via self-signed certs in `certs/`; platform TLS termination in production.
- Fail-fast env validation — server refuses to start if `DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, or `STRIPE_SECRET_KEY` are missing.

---

## 10. Authentication & Authorization

### 10.1 User auth flow

```
POST /register    { email, password, company_name, business_type }
                  → bcrypt hash → INSERT users + INSERT tenants
                  → returns { token, tenant_id, user_id }

POST /login       { email, password }  [rate-limited: 5/5min]
                  → SELECT user by email → bcrypt.compare
                  → jwt.sign({ tenant_id, user_id, email }, JWT_SECRET, expiresIn: 8h)
                  → returns { token }

POST /auth/refresh { token }  (token may be expiring)
                  → verifies signature (ignores expiry)
                  → re-signs with fresh 8h expiry
                  → returns { token }
```

Client keeps the token in `localStorage` and sends `Authorization: Bearer <jwt>` on every API call. On `401 TOKEN_EXPIRED`, client auto-calls `/auth/refresh`. On `401 TENANT_NOT_FOUND`, client force-logs-out (tenant was deleted).

Dashboard `SessionContext` watches token TTL and pre-emptively refreshes 10 minutes before expiry.

### 10.2 Tenant uniqueness

`users.email` is scoped per-tenant, not globally unique. The same email can register a second tenant without collision (BUG-002 fix, March 2026 review).

### 10.3 OAuth flows (integrations)

Both calendar integrations (Google Calendar, Outlook) use the same OAuth 2.0 pattern via `src/services/oauthCallbackFactory.ts`:

```
GET /{provider}/auth/start
  → Generate signed state JWT (contains tenant_id, csrf_nonce)
  → Redirect to provider authorize URL with state + PKCE

GET /{provider}/auth/callback?code=...&state=...
  → Verify state JWT signature (CSRF protection)
  → Exchange code for access + refresh token
  → Store tokens in tenant_integration_settings (RLS-scoped)
  → Redirect to dashboard
```

Token refresh is centralized in `src/services/tokenManagement.ts`:

```ts
async function getValidToken(tenantId, provider) {
  const settings = SELECT * FROM tenant_integration_settings WHERE ...
  if (expires_at - now < 5 min) {
    const fresh = await provider.refreshAccessToken(refresh_token)
    UPDATE tenant_integration_settings SET access_token = $1, expires_at = $2 ...
    return fresh.access_token
  }
  return settings.access_token
}
```

On persistent refresh failure (invalidated refresh token), the integration is marked `is_active = false` and surfaced in the dashboard as "Reconnect required."

### 10.4 Agent tool auth (post-migration)

`/agent-tools/*` routes bypass tenant middleware entirely. Auth via `x-agent-secret` header in a `preHandler` hook. The tenant_id comes from the request body (the agent gets it from LiveKit room metadata).

---

## 11. Scheduling Engine

### 11.1 Data model

`employee_schedule` is the single source of truth for staff availability:

```sql
CREATE TABLE employee_schedule (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  employee_id UUID NOT NULL,
  schedule_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,  -- may be < start_time (cross-midnight / night shift)
  ...
);
```

Date-based only — no weekly patterns, no overrides. The `employee_shifts` weekly-pattern table that previously coexisted was dropped 2026-04-30 (NEEDS-REFACTORING #4 Phase 2). The setup wizard collects a weekly grid in form state and posts it to `POST /shifts/expand-weekly`, which fans the pattern into `employee_schedule` for 4 weeks at finalize. Owners then extend coverage forward via the Schedule tab's copy-week button.

### 11.2 Effective shifts

`get_effective_shifts(tenant_id, date)` and `get_effective_shifts_bulk(tenant_id, start, end)` return rows from `employee_schedule` verbatim. Both the Working Days editor (under My Team) and the Schedule tab read from these RPCs.

### 11.3 Booking (7-layer check)

`book_with_scheduling_atomic()` runs all seven checks in a single transaction:

1. **Past-time rejection** — `start_time > now() AT TIME ZONE tenant.timezone` (BUG-059 fix).
2. **Business hours** — (soft rule, not enforced at DB level) — checked before RPC call.
3. **Resource availability** — no overlapping appointment on the same resource.
4. **Staff on shift** — `start_time` and `end_time` fall inside an `employee_schedule` window (date-based, DST-safe via `AT TIME ZONE`, night-shift aware).
5. **Staff expertise** — employee is in `service_employee` for the requested service (by skill_id).
6. **Resource capability** — resource is in `service_resource` for the requested service.
7. **Customer upsert** — if `customer_id IS NULL` and phone is provided, find-or-create.
8. **Auto end-time** — if `end_time IS NULL`, compute from `service.duration_minutes`.

Specific error codes: `TIMESLOT_OCCUPIED`, `NO_SKILLED_EMPLOYEE`, `EMPLOYEE_NOT_SCHEDULED`, `NO_AVAILABILITY`, `INVALID_PARAMS` (BUG-064).

### 11.4 Night shifts

`end_time < start_time` indicates cross-midnight. The shift is treated as two logical windows for overlap math — e.g. 22:00-06:00 against an appointment at 23:30 evaluates against window `[22:00, 24:00]`, and an appointment at 04:00 evaluates against `[00:00, 06:00]` on the following calendar day.

### 11.5 Scheduling algorithm (`shared/scheduling.ts`)

Shared between the Fastify backend (`../shared/...`) and the dashboard (`../../shared/...`) — see `/shared`. Takes the tenant, the service, and a date range → returns a list of viable (resource, employee, start, end) tuples. Uses `get_effective_shifts_bulk()` + single query for existing appointments → returns diagnostics object (`"no skilled employee on 4/23"`, `"all 3 bays busy 9-noon"`) so the LLM can explain **why** no slots exist.

---

## 12. Knowledge Base (RAG)

### 12.1 Storage

```sql
CREATE TABLE tenant_docs (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  source_file TEXT,
  text TEXT,              -- raw chunk
  normalized_text TEXT,   -- post gpt-4o-mini normalization (§12.3)
  embedding vector(1536),
  ...
);
```

### 12.2 Ingestion

1. Dashboard uploads PDF/DOCX/DOC/TXT/MD.
2. Server parses + chunks (paragraph-aware with overlap).
3. For each chunk: `text` → `normalizeForEmbedding()` → `normalized_text` → `text-embedding-3-small` → `embedding`.
4. INSERT into `tenant_docs`. Duplicate detection: delete existing chunks from the same `source_file` before re-ingesting.

### 12.3 Query normalization

Both ingestion and query paths pass text through `shared/normalizeForEmbedding.ts` (OpenAI GPT-4o-mini, temp 0.1, 15s abort). Normalization collapses synonyms, expands abbreviations, and strips presentation noise — dramatically improves cosine similarity hit rate.

### 12.4 Retrieval

The `get_company_policy_answer` tool:

1. Normalizes the caller's question.
2. Embeds the normalized query.
3. `search_tenant_docs(tenant_id, query_embedding)` returns top-k by cosine distance (`<=>` operator).
4. Top chunks are returned to the LLM as factual context.

Unanswered questions (no chunk above similarity threshold) are logged to `unanswered_questions` table → surfaced in the owner's dashboard as a badge + SMS notification.

### 12.5 Knowledge base questionnaire

`dashboard/lib/policyQuestions.ts` defines 40 policy Q&A pairs across 9 categories (cancellation, payment, service area, hours, warranty, etc.). Owners fill these in during onboarding; answers are stored as `tenant_docs` rows with `source_file = 'questionnaire'`.

---

## 13. Calendar Sync (Push-only)

Two providers, same orchestration layer.

| Provider | Service                           | Route                    | API                             |
| -------- | --------------------------------- | ------------------------ | ------------------------------- |
| Google   | `src/services/googleCalendar.ts`  | `src/routes/calendar.ts` | `googleapis` SDK                |
| Outlook  | `src/services/outlookCalendar.ts` | `src/routes/calendar.ts` | Microsoft Graph API (raw fetch) |

### 13.1 OAuth + token management

Via `oauthCallbackFactory.ts` + `tokenManagement.ts` (§10.3). State param is a signed JWT (CSRF protection). Tokens never exposed to the frontend. Best-effort token revocation on disconnect.

### 13.2 Sync orchestrator

`src/services/calendarSync.ts` is provider-agnostic:

```ts
async function syncAppointment(tenantId, appointment, op: 'create'|'update'|'delete'|'cancel') {
  const providers = SELECT * FROM tenant_calendar_settings WHERE tenant_id = $1 AND is_active
  for (const p of providers) {
    try {
      const token = await getValidToken(tenantId, p.provider)
      await callProviderAPI(p.provider, token, appointment, op)
      UPDATE appointment_sync_map SET external_id = ..., last_synced_at = now()
    } catch (err) {
      logError(...); // fire-and-forget continues with other providers
    }
  }
}
```

Fires from the 4 appointment mutation points (create, update, delete, cancel). Calendar is **display-only** — no pull back. Calendar events don't become SecretaryHQ appointments.

---

## 14. CRM Sync (Square only)

> **External CRM sync reduced to Square only (2026-06-12).** The bidirectional Jobber, HubSpot, ServiceTitan, and GoHighLevel integrations were deleted from the codebase — their route files, sync services, OAuth, and webhooks. **Square is the one surviving external CRM sync provider** and is fully live.

| Provider | Route                  | Service                                              | Auth                                                                                                                           | Direction                                                                   |
| -------- | ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Square   | `src/routes/square.ts` | `src/services/crm/squareClient.ts` + `squareSync.ts` | OAuth (`SQUARE_CLIENT_ID`/`SQUARE_CLIENT_SECRET`/`SQUARE_CALLBACK_URL`) + webhook HMAC-SHA256 (`SQUARE_WEBHOOK_SIGNATURE_KEY`) | Bidirectional (push appointments/customers out; pull via `/square/webhook`) |

`src/services/syncOrchestrator.ts` fans appointment mutations out to the connected calendars **and** Square (`{ name: 'square', fn: syncAppointmentToSquare }`); customer mutations fan out to Square (`syncCustomerToSquare`). Each provider fails independently (best-effort, fire-and-forget). Square's OAuth tokens live in `tenant_integration_settings`; its local↔external ID mappings live in `entity_sync_map` — both tables are actively written today. The in-app operational customer record (Customers view) and Google/Outlook calendar sync (§13) are independent of Square.

---

## 15. Billing (Stripe Lite)

### 15.1 Plans

| Plan label in code | Current state | Notes |
| ------------------ | ------------- | ----- |
| Solo               | Checkout path exists | Price not finalized; old dollar figures were placeholders |
| Growth             | Checkout path exists | Price not finalized; old dollar figures were placeholders |
| Professional       | Backlog / partial wiring | Not yet a launched plan |
| Enterprise         | Not implemented | Placeholder only |

### 15.2 Checkout flow

```
POST /billing/checkout { tenant_id, plan }
  → stripe.checkout.sessions.create({
      customer (or customer_email),
      line_items: [{ price: STRIPE_{PLAN}_PRICE_ID }],
      mode: 'subscription',
      success_url + cancel_url (uses DASHBOARD_URL)
    })
  → returns { checkout_url }

Client → redirects to checkout_url
```

### 15.3 Webhook (`POST /billing/webhook`)

The route exists and verifies Stripe signatures via `STRIPE_WEBHOOK_SECRET`, but **no Stripe webhook endpoint is registered yet**, so production has not received these events. When wired, it handles three events:

| Event                           | Action                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`    | `UPDATE tenants SET stripe_subscription_id, subscription_status = 'active', subscription_plan = $plan`         |
| `invoice.payment_failed`        | `UPDATE tenants SET subscription_status = 'past_due'`                                                          |
| `customer.subscription.deleted` | `UPDATE tenants SET subscription_status = 'canceled', stripe_subscription_id = NULL, subscription_plan = NULL` |

### 15.4 Subscription gate middleware

Tenant-scoped routes behind `subscriptionGateMiddleware` check `tenants.subscription_status`. If not in `('active', 'trialing')`, return **402 Payment Required** with upgrade URL. Exemptions: `/billing/*`, `/auth/*`, `/health`.

### 15.5 Status endpoint

`GET /billing/status` → `{ subscription_status, subscription_plan }` for the dashboard to decide what to gate.

---

## 16. Dashboard Architecture

### 16.1 Routing

Next.js 16 App Router:

- `/app/page.tsx` — Marketing landing page.
- `/app/dashboard/page.tsx` — App shell (single route, view-switching internally via tab state + URL query params).
- `/app/layout.tsx` — Wraps `SessionProvider`, `ThemeProvider`, `VocabularyProvider`, `ToastContainer`, `ErrorBoundary`.

### 16.2 Navigation — Primary + Advanced

```
Primary (always visible)           Advanced (owners + admins only)
├─ Home                            ├─ My Business
├─ Schedule                        ├─ My Team
├─ Customers                       └─ Phone Assistant
└─ Calls
```

Single top-level tab bar. Front-desk-only users (`role === 'front_desk' && !isAdmin`) see the Primary group only — a useEffect in `OutlookLayout` snaps them back to Home if they land on a restricted tab via a stale `?tab=` URL or back-button. Owners and super-admins see Primary + Advanced. Account-level destinations (My Profile, Business Settings, All Businesses for admins) live in the profile dropdown, not the tab bar. Tab state synced to URL query params (`?tab=schedule`) — shareable links, browser back/forward works.

### 16.3 State management

Four React contexts in `dashboard/lib/`:

| Context                    | Purpose                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SessionContext`           | JWT, current user, active tenant (via `useActiveTenantId()`), tenant list, `tenantsVersion` counter for cross-component sync        |
| `ThemeContext`             | 8 themes (light, dark, midnight, nord, sunset, forest, high-contrast, solarized) — swaps CSS custom properties in `app/globals.css` |
| `VocabularyContext`        | 3-tier label fallback (`COALESCE(tenant_override, template_default, hardcoded)`) per business type. 29 types across 6 categories    |
| `AppointmentDetailContext` | Holds selected appointment for cross-view access (list → detail panel)                                                              |

### 16.4 Component hierarchy

- `components/ui/` — 16 primitives (Button, Card, Input, Select, Modal, ConfirmModal, Toast, Badge, TimeInput, PhoneInput, FolderTabs, CoverageBar, CoverageStatusBadge, FeedbackButton)
- `components/scheduler/` — `NewSchedulerView`, `StaffRow`, `ResourceColumns`, `QuickBookPanel`, `EmployeeDayFocusPanel`, `StaffProfileCard`
- `components/SetupWizard/` — 7-step wizard + `WizardModeChooser` (solo vs team branching)
- `components/CRM/`, `components/employees/`, `components/services/`, etc. — List+Detail pane pattern (sidebar + detail right)

### 16.5 API client (`dashboard/lib/api.ts`)

Centralized namespace: `Api.appointments.create(...)`, `Api.customers.list(...)`, `Api.services.update(...)`, etc. Every call fully typed (no `Record<string, unknown>` return types). Shared `forceLogout()` + `checkAuthFailure()` handle 401.

### 16.6 Theming

Every component consumes CSS custom properties (`--bg`, `--fg`, `--accent`, `--border`, `--font-display`, `--font-body`) — never hardcoded colors. All 8 themes are dark variants (locked from March 24 2026 design session). Fonts: Bebas Neue (display) + DM Sans (body).

### 16.7 Test harness

Vitest + React Testing Library (jsdom). Latest local audit rerun: **1,046 passing tests** (2026-08-18). Contexts are provided by a shared `renderWithProviders()` helper. Happy + sad paths with 5W diagnostic comments (Who / What / When / Where / Why) — failure messages are self-debugging.

### 16.8 Dev server

`dashboard/server.js` — custom HTTPS server for local dev (self-signed certs from `certs/`), doubles as the Railway production entry when `NODE_ENV=production`.

---

## 17. Async Work (no n8n)

`n8n/` was removed. All async work runs inline in Fastify route handlers as fire-and-forget calls.

| Concern                     | Trigger point                                        | Runs in                                                                      |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Post-call summary           | LiveKit room close event → `POST /voice/session/end` | `src/routes/voice.ts`                                                        |
| Call summary embedding      | After summary insert                                 | `src/routes/voice.ts` (OpenAI embedding call)                                |
| Calendar + Square CRM sync  | Appointment / customer mutation routes               | `src/services/syncOrchestrator.ts` → `calendarSync.ts` + `crm/squareSync.ts` |
| SMS / reminders             | Planned cron-based                                   | `src/routes/reminders.ts` (stub; scheduler not yet wired)                    |
| Orphaned transcript linking | After call end                                       | `link_orphaned_transcripts()` RPC from dispatcher                            |

All async work is **best-effort**. If a sync fails, the user-facing operation still succeeds. Failures are logged + surfaced in the dashboard (e.g., "Reconnect required").

---

## 18. Testing Strategy

### 18.1 Test pyramid

```
                  ╱╲
                 ╱E2E╲        Playwright e2e (40 committed full-stack browser specs)
                ╱────╲
               ╱ sim  ╲       `simulate.sh tools` (on-demand agent-tools journey — real `/agent-tools/*` routes)
              ╱────────╲
             ╱ vitest  ╲      Vitest unit + integration (real DB, real RLS)
            ╱────────────╲
```

### 18.2 Backend (`npm test`)

Vitest with `--fileParallelism=false` (tests share `test_db` on port 5433). Covers routes (happy + sad), services, scheduling, RLS enforcement, calendar sync, OAuth flows, voice-AI fixes, schema constraints, migration regressions, billing webhook handling, provisioning flows. Every test has 5W diagnostic comments (`// WHO: Bella's Hair Studio caller | WHAT: ... | WHEN: ... | WHERE: ... | WHY: ...`). **Latest local audit rerun (2026-08-18): not green in this workspace — 1,761 passing, 985 skipped, 9 failed. The loudest blocker was `tests/regression/rlsIsolation.test.ts`, which could not connect as `app_user` and instructed applying `supabase/migrations/20260724000100_app_user_role.sql` to `test_db` first.**

### 18.3 Dashboard (`cd dashboard && npm test` — 1,046 passing on 2026-08-18)

Vitest + React Testing Library (jsdom). Renders components with all 4 providers (Session, Theme, Vocabulary, AppointmentDetail). Tests interactions (click, keyboard, form submission), accessibility (role/tabIndex/aria attributes), and error states.

### 18.4 Agent (`cd agent && npm test` — 943 passing on 2026-08-18)

Vitest. Covers the LiveKit Agents worker: prompt assembly, the 26 defined tool schemas, `toolsClient`, transcript recording, call-outcome tracking, the bounded post-call summary, and the TTS dead-air fallback.

_(The former Supabase edge-function suite — `deno task test --no-check` — was removed with `supabase/functions/` itself when the backend moved to Fastify. See `docs/FRAMEWORK_MIGRATIONS.md`.)_

### 18.5 Playwright e2e (`cd dashboard && npx playwright test` — 40 committed spec files)

Full-stack browser coverage: regression gates (toast, validation, unsaved-changes warning, NaN guards), functional audit journeys (login → home → scheduler → CRM → calls → services → staff → AI → theme → URL nav), auth/role gating, calendar sync, knowledge-base import, wizard flows, and self-service. Runs as a required CI job on every PR.

### 18.6 Live QA (`./scripts/simulate.sh tools`)

Provisions an ephemeral demo tenant and runs the full agent-tools journey (catalog → availability → booking → preference recall → policy RAG). Verifies DB side effects directly. On-demand pre-deploy integration check; not a CI gate (real OpenAI embeddings, costs tokens per run).

### 18.7 Typecheck

`npx tsc --noEmit --noUnusedLocals --noUnusedParameters` — must be clean. Currently passes with 0 errors.

---

## 19. Observability

### 19.1 Structured logging

Pino under Fastify. Every request + response logs a structured JSON line. Domain events logged via `logEvent(req, name, fields)`:

```ts
logEvent(req, 'appointment_booked', {
  tenantId,
  customerId,
  appointmentId,
  serviceId,
  employeeId,
  startTime,
  source: 'voice',
});
```

Railway captures stdout/stderr. No aggregation pipeline yet (Datadog/Logtail/etc.) — planned but not started.

### 19.2 Audit log

`audit_log` table records before/after snapshots for every INSERT/UPDATE/DELETE on appointments, customers, and resources. Trigger `fn_audit_trigger` runs as `SECURITY DEFINER` to bypass RLS. Written atomically with the mutation — if the write fails, the log entry isn't created.

Surfaces in dashboard via `GET /versionHistory/:entity/:id`.

### 19.3 Record versions

`record_versions` table — parallel history system specific to entities that need UI diff/restore (services, employees, resources). Triggered from `src/routes/versionHistory.ts`.

### 19.4 Health endpoint

`GET /health` → `{ status: 'ok' }`. Railway uses this as the healthcheck.

### 19.5 Gaps

- No error rate dashboard.
- No latency percentile tracking.
- No alerting on Stripe webhook failure, OAuth token invalidation, or sync error spikes.

Planned once there's real call volume.

---

## 20. Error Handling & Retry

### 20.1 Error taxonomy

| Source        | Type                    | Response                                                          |
| ------------- | ----------------------- | ----------------------------------------------------------------- |
| User input    | Zod validation failure  | 400 `{ error, details: [...zod issues] }`                         |
| Auth          | Invalid / expired JWT   | 401 `{ error: 'TOKEN_EXPIRED' }` → client refresh                 |
| Auth          | Tenant deleted          | 401 `{ error: 'TENANT_NOT_FOUND' }` → client force-logout         |
| Billing       | No active subscription  | 402 `{ error: 'SUBSCRIPTION_REQUIRED', upgrade_url }`             |
| Authorization | Wrong tenant            | 403 `{ error: 'FORBIDDEN' }`                                      |
| Not found     | Zero-row UPDATE/DELETE  | 404 `{ error: 'NOT_FOUND' }` (via `assertRowAffected()`)          |
| Conflict      | Booking clash           | 409 `{ error: 'TIMESLOT_OCCUPIED' }` (RPC-specific codes)         |
| Upstream      | OpenAI/Deepgram timeout | 502 `{ error: 'UPSTREAM_TIMEOUT' }`                               |
| Server        | Uncaught                | 500 `{ error: 'INTERNAL_SERVER_ERROR' }` (details hidden in prod) |

### 20.2 Retry strategy

- **Token refresh**: automatic, 5-min buffer. On failure → mark integration inactive, no automatic retry.
- **Calendar sync**: fire-and-forget, no retry. Failures logged + visible in dashboard.
- **Stripe webhook**: idempotent by design (Stripe retries on non-2xx).
- **Voice AI tool calls**: the LLM retries naturally (if the tool returns an error string, the LLM paraphrases and tries alternative tool or asks the caller).
- **OpenAI/Deepgram API calls**: AbortController timeouts (10s embeddings, 15s normalization) — no retry, surface as upstream error.

### 20.3 Destructive action safeguards

- Type-to-confirm modal for tenant deletion.
- `ConfirmModal` + `useConfirm()` hook for all destructive actions on the dashboard.
- `beforeunload` warning on dirty state in reorder + form edit flows.

---

## 21. Security Summary

- **Row Level Security** — enforced on 20 tenant-scoped tables with `FORCE ROW LEVEL SECURITY`. Context via `app.current_tenant_id`.
- **JWT Authentication** — 8h expiry, auto-refresh, auto-logout on tenant deletion. bcrypt password hashing.
- **Rate limiting** — 100 req/min global, 5 req / 5 min on auth endpoints.
- **Security headers** — `@fastify/helmet` (HSTS, CSP, X-Frame-Options, etc.).
- **CORS** — restricted to `CORS_ORIGIN` in production.
- **Input validation** — Zod at every API boundary. CHECK constraints on JSONB columns.
- **OAuth state** — signed JWT state param (CSRF protection) on every integration.
- **Secrets** — env vars only; never committed. Production validation fail-fast on missing required secrets.
- **Audit log** — immutable via `SECURITY DEFINER` trigger, cascaded delete from `tenants`.
- **Soft deletes** — `is_deleted` flag + partial indexes on appointments, customers, resources, employees.
- **HIPAA exclusion** — medical verticals permanently removed. No BAA, no ePHI handling, no compliance program.

---

## 22. Known Gaps / Future Work

- **Dashboard deployment** — Railway (production for all 3 services: backend, agent, dashboard); self-host / other platforms possible for the Next.js part.
- **LiveKit migration** — Phase 2+ pending LiveKit API Secret + WSS URL (`.claude/plans/federated-snacking-puffin.md`).
- **Communications/reminders** — routes + schemas exist, Telnyx SMS + nodemailer wiring pending.
- **Observability pipeline** — aggregation + alerting not started.
- **Soft-delete SELECT filters** — only 2 of 20 routes currently filter `is_deleted = false` on SELECTs.
- **Full billing system** — trial management, plan switching, call limits, Stripe portal. Post-launch.
- **Business intelligence / ROI analytics** — requires real booking volume. Post-launch.
