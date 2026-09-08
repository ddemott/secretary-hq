# Secretary HQ

**AI receptionist for service businesses.** Answers calls 24/7, books appointments, answers policy questions, takes messages for escalation when needed, and logs every interaction — call summaries, transcripts, and analytics — to the owner's dashboard. No missed calls, no hold music, no voicemail.

Built for tire shops, salons, auto repair, fitness studios, trades, and food & beverage businesses.

Below is a full list of its features:

**Voice & Calls**

- Answers inbound calls 24/7 with a low-latency, human-like voice (Deepgram Aura TTS, streaming)
- Identifies callers on arrival and matches them to existing customer records
- Greets callers by name when recognized, captures new callers into the address book automatically
- Takes messages for escalation today; SIP REFER handoff plumbing exists in code, but the live question-tree path does not yet expose human transfer
- Records full call transcripts and generates AI post-call summaries
- Handles rejections, off-topic questions, and policy queries naturally

**Appointment Booking**

- Books appointments atomically — shift coverage, staff skills, resource availability, and timeslot occupancy checked in a single DB transaction
- Race-safe under concurrent calls via GiST exclusion constraints (no double-bookings)
- DST-safe scheduling across timezones
- Customer-led: asks the caller's preferred time first, widens only if no slots fit
- Specific error codes (`TIMESLOT_OCCUPIED`, `NO_SKILLED_EMPLOYEE`, `EMPLOYEE_NOT_SCHEDULED`) drive spoken responses
- Supports service-to-employee and service-to-resource skill mapping

**Knowledge Base**

- Two-layer knowledge: live DB tool calls for facts (pricing, hours, availability) + RAG over uploaded documents for policies
- Document upload: PDF, TXT, DOC, DOCX, MD — chunked, embedded, and retrieved via pgvector cosine similarity
- 40-pair policy Q&A seeded per business; owners extend via the dashboard

**Dashboard**

- Staff swimlane scheduler: 24-hour view, zoom, employee day focus with utilization stats
- Resource columns alongside staff lanes
- Appointment list view and calendar sub-view
- Quick-book panel for walk-ins
- Coverage gap indicators across scheduler, services list, skill map, and setup wizard
- 8 UI themes: light, dark, midnight, nord, sunset, forest, high-contrast, solarized
- Per-business vocabulary: "Bays / Technicians" for tire shops, "Chairs / Stylists" for salons, and so on across 29 business types

**CRM & Customer Records**

- Full customer profiles with appointment history, call summaries, transcripts, and internal notes
- Searchable customer list
- Square CRM bidirectional sync
- Google Calendar and Outlook Calendar OAuth integration — appointments auto-sync on create, update, delete, and cancel

**Analytics**

- Call analytics dashboard: busiest hours, return rate, no-show patterns
- Per-call outcome tracking (booked, transferred, no action) with appointment linkage

**Business Setup**

- 7-step onboarding wizard: repeatable, re-enterable, with live coverage feedback and phone activation
- Service, employee, resource, and skill management
- Weekly schedule grid that fans out to a 4-week `employee_schedule` (copy-week button for forward extension)
- Per-tenant AI persona: voice, greeting, and style controlled from the Phone Assistant page (`tts_speed` is currently inert under Aura)
- Website scan during onboarding to seed initial knowledge base

**Automated Reminders**

- Appointment reminder scheduling via SMS and email
- Consent-gated — only contacts who have opted in receive messages
- 60-second polling scheduler, batches up to 100 due reminders per tick

**Billing**

- Stripe Checkout + subscription-gate wiring are built, but launch pricing is not finalized
- Subscription gate middleware — unsubscribed tenants are blocked from paid features once billing is wired
- Billing webhook route exists at `/billing/webhook`, but no Stripe endpoint is registered yet

**Security & Multi-Tenancy**

- Row Level Security on all tables (`FORCE ROW LEVEL SECURITY`)
- JWT auth (8-hour expiry), bcrypt password hashing, auto-logout on 401
- Helmet headers, rate limiting (100 req/min, 5/5 min on login), CORS restriction
- Anonymous and cross-tenant access rejected before any data touches the query layer

---

## Status

[![CI](https://github.com/ddemott/secretary-hq/actions/workflows/ci.yml/badge.svg)](https://github.com/ddemott/secretary-hq/actions/workflows/ci.yml)

|               |                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase**     | 13 — Production Readiness                                                                                                                                                                                                                                                                                                                                             |
| **Backend**   | Live on Railway (`secretary-hq-production.up.railway.app`)                                                                                                                                                                                                                                                                                                            |
| **Dashboard** | Live at `https://www.secretaryhq.com` (Railway origin `dashboard-production-cee3.up.railway.app`); set `DASHBOARD_URL` on backend Railway service for Stripe/OAuth redirects                                                                                                                                                                                          |
| **Voice AI**  | Live — Telnyx → LiveKit Cloud → Deepgram Nova-3 (STT) + OpenAI GPT-4.1-mini (LLM) + Deepgram Aura (TTS). Call flow = question trees (`agent/src/checklist/`). PSTN inbound reaches the agent (confirmed 2026-06-30); the booking + transfer legs still need a live different-carrier call — see `docs/planning/TODO.md` (P0 Voice) + `docs/operations/RUNBOOK.md` §7. |
| **Phone**     | `+1 630-822-9086` (current). Previous `+1 630-866-1960` (purchased 2026-06-02) dead. Test verification number `+1 630-822-9086`. Old `+1-630-937-9478` dead.                                                                                                                                                                                                          |
| **Tests**     | Root `npm test` green: 3029 passing. Dashboard + agent suites green. See `docs/planning/TEST_COVERAGE.md` for exact output.                                                                                                                                                                                                                                           |
| **E2E**       | 40 committed Playwright spec files                                                                                                                                                                                                                                                                                                                                    |

**Quick status commands** (see `scripts/simulate.sh`):

- `npm run status` — runtime health board (backend /health + /ready pool, dashboard, deep agent worker)
- `npm run ci:status` — CI runs (GitHub Actions job stages + conclusions) + local src vs built artifacts staleness
- `npm run ci:watch` — live tail the latest CI run
- `./scripts/simulate.sh ci --watch` (same)

**CI gate**: GitHub branch protection on `main` (applied 2026-06-15) requires the 4 CI jobs to be green before merges (and thus Railway deploys from `main`) are allowed. Always run `npm run ci:status` before merging. (See `.github/BRANCH_PROTECTION.md` + `docs/planning/TODO.md`.)

See `docs/planning/TODO.md` for remaining work and `docs/planning/RESOLVED.md` for completed phases + historical session notes.

---

## What It Does

- **Voice AI Reception** — Answers inbound calls with a low-latency, human-like voice. Greets callers, identifies intent, books appointments, answers policy questions, and handles rejections naturally.
- **Atomic Booking** — Checks staff shifts, expertise, resource capabilities, and timeslot availability in a single database transaction. DST-safe; concurrent-call-safe via GiST exclusion constraints on `(resource_id, time-range)` and `(employee_id, time-range)` so the find-then-insert race surfaces as `TIMESLOT_OCCUPIED` rather than a double-booking. Specific error codes (TIMESLOT_OCCUPIED, NO_SKILLED_EMPLOYEE, EMPLOYEE_NOT_SCHEDULED) drive the agent's spoken response.
- **Two-Layer Knowledge** — Database tool calls for facts (pricing, availability) with zero hallucination. RAG over uploaded documents (PDF/TXT/DOC/DOCX/MD) for policies (cancellation, service area, payment terms).
- **Multi-Tenant Dashboard** — Owners manage staff, resources, services, shifts, AI persona, and knowledge base. Vocabulary adapts per business type (Bays/Technicians for tire shops, Chairs/Stylists for salons).
- **Scheduler** — Staff swimlane view (24hr, zoom), resource columns, appointment list, calendar sub-view. Quick book panel for walk-ins. Employee day focus with utilisation stats.
- **CRM** — Searchable customer profiles with appointment history, call summaries, transcripts, and internal notes.
- **Calendar Sync** — Google Calendar and Outlook Calendar OAuth integration. Appointments auto-sync on create, update, delete, and cancel.
- **Coverage Visibility** — Gaps shown across scheduler, services list, skill map, and setup wizard.
- **Analytics** — Busiest hours, return rate, and no-show patterns from booking data.
- **Billing** — Stripe Checkout route + subscription gate exist in code; launch pricing is still provisional and the webhook endpoint is not yet registered.

---

## Architecture

```
Inbound Call
    |
Telnyx (carrier + SIP trunk) --> LiveKit Cloud (SIP ingress)
                                          |
                                LiveKit Agent worker (Node)
                                — Deepgram Nova-3 (STT)
                                — OpenAI GPT-4.1-mini (LLM)
                                — Deepgram Aura (TTS, streaming)
                                          |
                                Fastify backend (32 route modules + agentTools dir; agent calls /agent-tools/*)
                                          |
                                PostgreSQL + pgvector (RLS multi-tenancy)
                                          |
                                Next.js 16 Dashboard
```

| Layer             | Tech                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Voice**         | Telnyx (carrier + SIP trunk), LiveKit Cloud (orchestrator), Deepgram Nova-3 (STT), OpenAI GPT-4.1-mini (voice LLM; 4o-mini for summaries/classify), Deepgram Aura (TTS, streaming, per-tenant voice via dashboard AI Persona page; `tts_speed` is inert under Aura)                                      |
| **Backend**       | Fastify 5.x, 32 top-level route modules plus the `agentTools/` module dir, JWT auth via `registerJwtAuthHook` in `src/middleware.ts`, Zod validation, RLS via `withTenantClient()` (factory in `src/database/index.ts`)                                                                                  |
| **Frontend**      | Next.js 16 (App Router), React 19, Tailwind CSS 3.4, TypeScript, Lucide icons                                                                                                                                                                                                                            |
| **Database**      | PostgreSQL + pgvector, 192 migrations, Row Level Security, atomic booking RPCs with GiST exclusion constraints to close the find-then-insert race. Every single-column PK follows the `<table_singular>_id` convention (see `CODING_STANDARDS.md`)                                                       |
| **Agent runtime** | LiveKit Agents (Node) on Railway as `secretary-hq-agent`. Call flow = **question trees** (`agent/src/checklist/`): host-owned checklist, purpose-selected trees, goodbye gate. 26 tools are defined in `agent/src/tools.ts`; the live question-tree path offers a subset — see `docs/ARCHITECTURE.md` §7 |
| **Async**         | Inline in Fastify routes (post-call summaries, calendar sync, SMS)                                                                                                                                                                                                                                       |
| **Billing**       | Stripe Checkout route + subscription gate exist in code; pricing is provisional and the webhook endpoint is not yet registered                                                                                                                                                                           |
| **Security**      | @fastify/helmet, @fastify/rate-limit, CORS restriction, bcrypt, FORCE RLS                                                                                                                                                                                                                                |

See `docs/ARCHITECTURE.md` for the full technical deep-dive.

---

## Quick Start

### Prerequisites

- Node.js 22+
- Docker (for local PostgreSQL)
- npm

### 1. Bootstrap (full local setup)

```bash
npm run bootstrap
```

Installs dependencies, starts Docker DB, applies all migrations, seeds demo data, and runs tests.

### 2. Database Only (migrations + seed separately)

```bash
# Apply schema migrations (works with any Postgres — local, Supabase, Railway)
npm run db:migrate                              # uses DATABASE_URL from .env
npm run db:migrate -- "postgres://user:pass@host:5432/db"  # explicit URL

# Seed demo data (platform admin + Bella's Hair Studio demo tenant)
npm run db:seed                                 # uses DATABASE_URL from .env
npm run db:seed -- "postgres://user:pass@host:5432/db"     # explicit URL
```

### 3. Trust the Backend Certificate

The backend uses HTTPS with self-signed certificates:

- Visit [https://localhost:4001/health](https://localhost:4001/health)
- Click **Advanced** > **Proceed to localhost**
- You should see `{"status":"ok"}`

### 4. Start

```bash
npm start
```

| Service     | URL                    |
| ----------- | ---------------------- |
| Dashboard   | https://localhost:4000 |
| Backend API | https://localhost:4001 |

### 5. Sign In

Default credentials are created by the seed script. See `supabase/seed.sql` for details.

---

## Project Structure

```
/
├── src/                    Fastify backend
│   ├── index.ts            Entry point (32 top-level route registrations + agentTools dir)
│   ├── middleware.ts        withHandler, tenant middleware, structured logging
│   ├── routes/             32 route modules + shared helpers (routeHelpers.ts, versionHistoryHelpers.ts, crmRouteScaffold.ts)
│   ├── services/           Square CRM sync, calendar sync, communications (Telnyx-only for SMS + delivery receipts), reminders, token management, telnyxNumbers + telnyxSms (Telnyx is now the sole provider)
│   └── database/           DatabaseService interface + Postgres implementation
├── agent/                  LiveKit Agents worker (Node) — Deepgram STT + OpenAI LLM + Deepgram Aura TTS; call flow in agent/src/checklist/
│   └── src/                Worker entry, session context, prompt, tool client
├── dashboard/              Next.js 16 frontend
│   ├── components/         60+ components (scheduler, CRM, settings, wizard)
│   ├── lib/                API client, hooks, types, SessionContext
│   └── e2e/                Playwright tests
├── supabase/
│   ├── migrations/         192 SQL migrations
│   └── seed.sql            Platform admin + Bella's Hair Studio demo tenant
├── shared/                 Cross-runtime code (embeddings, scheduling, voice CRM types + prompt formatter)
├── scripts/                Automation (bootstrap, setup-db, seed-db, deploy, QA)
└── docs/                   Architecture, plans, deployment, design, TODO
```

---

## Testing

```bash
npm test                              # Backend/root Vitest suite (see docs/TEST_COVERAGE.md for latest status)
cd dashboard && npx vitest run        # Dashboard Vitest suite
cd agent && npm test                  # Agent Vitest suite
cd dashboard && npx playwright test   # E2E (40 committed spec files)
```

### Coverage

| Area                              | Tests |
| --------------------------------- | ----- |
| Backend routes (32 modules)       | ~700  |
| Backend services                  | ~570  |
| Middleware, scheduling, constants | ~500  |
| Dashboard components + views      | ~747  |
| Playwright e2e (40 spec files)    | —     |

### Test Philosophy

Every test covers both happy and sad paths. Sad paths include **5W diagnostic context** (Who, What, When, Where, Why) so failures are immediately debuggable:

```typescript
it('should reject country-code-only "+1" (BUG-060 root cause)', () => {
  // WHO: inbound caller | WHAT: carrier sent only "+1" as phone
  // WHEN: April 1 2026 test call | WHERE: shared/phone.ts normalizePhone
  // WHY: some carriers send partial caller ID before the full number resolves
  expect(normalizePhone('+1')).toBeNull();
});
```

---

## Infrastructure

| Concern                 | Implementation                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| **Multi-tenancy**       | Row Level Security on all tables, `FORCE ROW LEVEL SECURITY` enforced                       |
| **Auth**                | JWT (8h expiry), bcrypt, auto-logout on 401, token refresh endpoint                         |
| **Security**            | Helmet headers, rate limiting (100 req/min, 5/5min on login), CORS                          |
| **Validation**          | Zod schemas at API boundaries, CHECK constraints on JSONB                                   |
| **Deadlock prevention** | Pool timeouts (statement 30s, lock 10s, idle-txn 60s), sequential test execution            |
| **Mutation safety**     | `assertRowAffected()` guard on all UPDATE/DELETE — zero-row ops return 404                  |
| **CRM sync**            | Shared `syncMapHelpers.ts`, timestamp-based merge, `withSyncContext()` for version tracking |

---

## Deployment

All three Railway services (`secretary-hq` backend, `secretary-hq-agent`, `dashboard`) deploy
from `main`. **Shipping means merging to `main` via PR** — a push to a feature
branch deploys nothing. Branch protection gates the merge behind green CI.

```bash
npm run ci:status   # wait for all 4 CI jobs green
gh pr merge --squash
```

Apply production DB migrations **before** the merge. Environment variables are set
on the Railway services themselves; `.env.production.example` lists what each one
needs.

See `docs/DEPLOYMENT.md` for the step-by-step guide.

---

## Key Features

| Feature                | Details                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| 29 business types      | 6 categories with per-type vocabulary                                                 |
| Scheduler              | Staff swimlanes, resource columns, list view, calendar, quick book                    |
| Skill relationship map | Interactive 3-column employee > service > resource view                               |
| 7-step setup wizard    | Repeatable, re-enterable, live coverage feedback, phone activation                    |
| 8 themes               | Light, dark, midnight, nord, sunset, forest, high-contrast, solarized                 |
| Stripe billing         | Checkout + subscription gate in code; pricing provisional; webhook not yet registered |
| Calendar sync          | Google + Outlook, OAuth, auto-sync on all mutations                                   |
| Square CRM sync        | Bidirectional customer + appointment sync                                             |
| Knowledge base         | 40 policy Q&A pairs, document upload, RAG via pgvector                                |
| Contextual feedback    | In-app feedback button on every page                                                  |
| Playwright e2e         | 40 spec files                                                                         |

---

## Documentation

`docs/README.md` is the in-folder index. Full inventory below (verified 2026-07-04).

**Root**

| Doc               | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `README.md`       | This file — project overview, quick start, status                       |
| `CLAUDE.md`       | Developer conventions, code patterns, project context (agents + humans) |
| `DEMO_SECTION.md` | Public voice-demo plan (BLOCKED / not started; kept at root on purpose) |

**Core reference**

| Doc                                 | Purpose                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `docs/README.md`                    | Documentation index + docs-hygiene principles                   |
| `docs/architecture/ARCHITECTURE.md` | Full technical architecture deep-dive                           |
| `docs/design/DIAGRAMS.md`           | Mermaid diagrams (deployment, voice flow, booking, OAuth, etc.) |
| `docs/operations/DEPLOYMENT.md`     | Step-by-step deployment guide (Railway env, deploy commands)    |
| `docs/operations/SECURITY.md`       | Security model — RLS, auth, hardening, posture                  |
| `docs/operations/RUNBOOK.md`        | Production incident + telephony recovery playbook               |
| `docs/operations/ALERTS.md`         | Alerting rules (optional; paid observability decided against)   |

**Planning, tasks & status**

| Doc                              | Purpose                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `docs/planning/TODO.md`          | The one backlog — all open work, prioritized (GAPS + IMPROVEMENT_IDEAS + go-live folded in 2026-07-05) |
| `docs/planning/RESOLVED.md`      | Completed phases + historical bug tracker + session-notes archive (incl. the folded-doc snapshots)     |
| `docs/planning/TEST_COVERAGE.md` | Test coverage status and gaps                                                                          |
| `docs/TEST_DB_AUDIT.md`          | Mocked-DB vs real-SQL coverage map                                                                     |

**Voice AI**

| Doc                                  | Purpose                                                             |
| ------------------------------------ | ------------------------------------------------------------------- |
| `docs/VOICE_AGENT_PLAYBOOK.md`       | Authoritative rulebook for building customer voice scripts          |
| `docs/VOICE_DEADAIR_RESEARCH.md`     | Dead-air / latency research findings (mostly shipped)               |
| `docs/AIASSISTANT_PERSONA_DRAFT.md`  | Thinking Hammer persona + call-flow draft                           |
| `docs/aiassistant-knowledge-base.md` | Source content for the Thinking Hammer AI assistant's KB            |
| `docs/FRAMEWORK_MIGRATIONS.md`       | Voice-stack migration history (Vapi→LiveKit, Grok→OpenAI TTS, etc.) |

**Onboarding & operations**

| Doc                       | Purpose                                               |
| ------------------------- | ----------------------------------------------------- |
| `docs/BETA_ONBOARDING.md` | First-day / first-week guide for new beta customers   |
| `docs/OWNER_GUIDE.md`     | Plain-language guide to each dashboard tab for owners |
| `docs/TICKET_SUPPORT.md`  | Telnyx support ticket status + escalation             |

**Product & strategy**

| Doc                             | Purpose                                         |
| ------------------------------- | ----------------------------------------------- |
| `docs/MISSION_STATEMENT.md`     | Product mission and goals                       |
| `docs/STRATEGY.md`              | Product + competitive strategy (positioning)    |
| `docs/COMPETITOR_WEAKPOINTS.md` | Competitor attack map                           |
| `docs/SECRETARYHQ_FEATURES.md`  | Organized capability outline with status legend |

**Design**

| Doc                      | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `docs/DESIGN_HANDOFF.md` | Visual brand system + design decisions (frozen)   |
| `docs/UI_UX_DESIGN.md`   | Living design brief — interaction + UX principles |

**Workflow & standards**

| Doc                                     | Purpose                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `docs/DEVELOPMENT_WORKFLOW.md`          | Repeatable dev process for this project                |
| `docs/PORTABLE_DEVELOPMENT_WORKFLOW.md` | Project-agnostic version of the workflow (copyable)    |
| `docs/ADOPTING_THE_WORKFLOW.md`         | How another project points at + adopts the workflow    |
| `docs/CODING_STANDARDS.md`              | Naming conventions + code-style rules                  |
| `docs/BRANCH_CHECKLIST.md`              | Checklist for starting + finishing feature-branch work |
| `docs/LESSONS_LEARNED.md`               | Running log of hard-won debugging lessons              |
| `docs/AGENTS.md`                        | Agent-oriented codebase brief                          |

**Subfolders**

| Path                              | Contents                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| `docs/legaldocs/`                 | Consent/privacy language + Thinking Hammer LLC setup summary   |
| `docs/superpowers/`               | Feature specs + implementation plans (per-feature design docs) |
| `docs/diagrams/`, `docs/mockups/` | Visual diagram assets + UI mockups                             |

---

## License

Proprietary. All rights reserved.

**Docs hygiene note (2026-07-05):** TODO consolidation — `GAPS.md`, `IMPROVEMENT_IDEAS.md`, `IMPROVEMENTS_TODO.md`, and `AIASSISTANT_GO_LIVE_TODO.md` were folded into `docs/planning/TODO.md` (now the one backlog, deduped + prioritized) and deleted; their done items + verbatim snapshots were appended to `docs/planning/RESOLVED.md`; navigational refs across CLAUDE/README/docs updated. Prior pass 2026-07-04 rebuilt this Documentation table from the actual `docs/` tree. See docs/README.md + RESOLVED.md.
