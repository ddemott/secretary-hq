# Repository Directory Structure

Layout of the entire monorepo — written as a target layout, verified against the filesystem 2026-09-18. Items 1 (agentTools split), 2 (tests moved under `tests/`) and 7 (dashboard components into subdirs) have LANDED; the `○ future` groupings under `src/services/` have NOT. Every source directory contains **only production code**; tests live in parallel `tests/` trees (backend) or are co-located (agent, dashboard).

**Legend:**  `✓` done · `🔄` in progress · `○` todo (numbered = which improvement item)

---

## Root

```
secretary-hq/
├── CLAUDE.md                      ✓ project brief for AI assistants
├── README.md
├── package.json                   ✓ root workspace scripts (bootstrap, start, test, checks)
├── tsconfig.json                  ✓ backend + shared TypeScript config
├── vitest.config.mts               ✓ backend test runner config
├── docker-compose.yml             ✓ local Postgres (port 5433)
├── docs/                          ✓ all project documentation
├── scripts/                       ✓ CLI helpers (simulate.sh, migrate-tests.mjs, …)
├── shared/                        ✓ cross-runtime TypeScript (no Node/Next deps)
├── src/                           backend (Fastify)
├── tests/                         ✓ backend tests (item 2 done)
├── public/                        ✓ static assets the backend serves — caller-simulator.html
├── supabase/                      ✓ migrations/ + seed.sql + generated baseline.sql
├── portable-workflow-kit/         ✓ extractable copy of the dev workflow (npm run generate-kit)
├── agent/                         LiveKit voice worker
└── dashboard/                     Next.js 16 frontend
```

---

## `shared/` — cross-runtime utilities

```
shared/
├── phone.ts           ✓ normalizePhone, formatPhone, isValidPhone
├── name.ts            ✓ splitName, joinName, buildDisplayName, slugify
├── scheduling.ts      ✓ selectAssignments, shift/slot types
├── appointmentValidation.ts  ✓ 15-min increment + duration rules
├── questionBank.ts    ✓ POLICY_QUESTIONS, resolveQuestions
├── starterServices.ts ✓ per-vertical starter services (generated into a migration + seed)
├── getEmbedding.ts    ✓ OpenAI embedding wrapper
├── normalizeForEmbedding.ts  ✓
├── expandQueryForEmbedding.ts ✓ RAG query expansion
├── callContext.ts     ✓ call-context shape shared by agent + backend
├── markerQuestions.ts ✓
├── payRange.ts        ✓
├── hipaaVerticalDenylist.ts ✓ HIPAA verticals are permanently excluded
├── versionHistoryFields.ts ✓ field lists behind the version-history RPCs
├── checklistPresetDerivation.ts ✓ preset id + business_type → checklist runtime config
├── checklistOverrides.ts ✓ the SUBTRACT-only override validator (no ADD verb, by design)
├── checklistPreview.ts   ✓ Business Settings next-call dry-run (ASK / LISTEN / REQUIRED)
└── voiceCrm.ts        ✓
```

The three `checklist*` files are here for one reason: the dashboard's preview of the next call
and the agent's actual runtime must never disagree about what the call will ask.
One implementation, two consumers.

---

## `src/` — Fastify backend (production code only)

```
src/
├── index.ts                 ✓ entry point — registers all routes + workers
├── constants.ts             ✓ app-wide constants
├── jsonContentTypeParser.ts ✓ Fastify plugin
├── localHttpsCerts.ts       ✓ local-dev HTTPS certs
├── readinessHandler.ts      ✓ /ready deep-health handler
│
├── middleware/
│   └── fastify-middleware.ts ✓ withHandler, tenantMiddleware, JWT auth hook, AppError, requireSuperAdmin
│
├── database/
│   └── index.ts             ✓ pool singleton + createWithTenantClient
│
├── types/
│   ├── fastify.ts           ✓ AppFastifyInstance
│   ├── index.ts             ✓
│   ├── versionHistory.ts    ✓
│   └── voiceCrm.ts          ✓
│
├── templates/               ✓ industry YAML bundles (5 files)
│   └── *.yaml
│
├── routes/                  ✓ thin HTTP layer — validate → service → respond
│   │
│   ├── agentTools/          ✓ item 1 — DONE 2026-07-11 (was a single 2,5xx-line agentTools.ts)
│   │   ├── schemas.ts       ✓ Zod schemas + constants
│   │   ├── helpers.ts       ✓ ok/fail/toolRoute/pgErrorFields/interval math + AgentToolDeps
│   │   ├── session.ts       ✓ tenant-config + voice-session-start/end/transcript
│   │   ├── scheduling.ts    ✓ service-catalog, available-slots, book-*, cancel, reschedule
│   │   ├── identity.ts      ✓ identify/lookup/history, preferences, consent, OTP verification
│   │   ├── knowledge.ts     ✓ policy-answer (the only module touching embeddings)
│   │   ├── messaging.ts     ✓ take-message, page-owner, capture-job-inquiry, self-service link
│   │   ├── aiCost.ts        ✓ record-ai-cost
│   │   ├── _testRoutes.ts   ✓ /agent-tools/_test/sync-events (SYNC_TEST_RECORDER-gated)
│   │   └── index.ts         ✓ registration order + the shared x-agent-secret auth hook only
│   │
│   ├── analytics.ts         ✓ (logic extraction → item 4)
│   ├── appointments.ts      ✓
│   ├── auth.ts              ✓
│   ├── auditLog.ts          ✓
│   ├── billing.ts           ✓
│   ├── calendar.ts          ✓
│   ├── callerSimulator.ts   ✓ browser voice-call harness (serves public/caller-simulator.html)
│   ├── communications.ts    ✓
│   ├── crmRouteScaffold.ts  ✓
│   ├── customers.ts         ✓
│   ├── demo.ts              ✓
│   ├── employees.ts         ✓
│   ├── exportData.ts        ✓
│   ├── health.ts            ✓
│   ├── knowledge.ts         ✓ (logic extraction → item 3)
│   ├── mappings.ts          ✓
│   ├── provisioning.ts      ✓
│   ├── reminders.ts         ✓
│   ├── resources.ts         ✓
│   ├── routeHelpers.ts      ✓
│   ├── selfService.ts       ✓
│   ├── services.ts          ✓
│   ├── setup.ts             ✓
│   ├── shifts.ts            ✓
│   ├── skills.ts            ✓
│   ├── square.ts            ✓
│   ├── tenants.ts           ✓
│   ├── users.ts             ✓
│   ├── versionHistory.ts    ✓
│   ├── versionHistoryHelpers.ts ✓
│   ├── vocabulary.ts        ✓
│   └── voice.ts             ✓
│
├── services/                (flat files today — the groupings below marked ○ are NOT done)
│   │
│   ├── metrics.ts           ✓ Prometheus-style in-process registry
│   ├── logger.ts            ✓ Pino wrapper
│   ├── sentry.ts            ✓
│   ├── envWarnings.ts       ✓
│   ├── featureReadiness.ts  ✓
│   ├── setupGraph.ts        ✓
│   ├── demoSeed.ts          ✓
│   ├── aiCost.ts            ✓
│   │
│   ├── scheduling/          ○ NEW grouping (item — future)
│   │   ├── availabilitySearch.ts   currently: src/services/availabilitySearch.ts
│   │   ├── appointmentValidation.ts
│   │   ├── conflictLookup.ts
│   │   ├── expandWeeklyToSchedule.ts
│   │   ├── serviceResolver.ts
│   │   └── tenantBuffer.ts
│   │
│   ├── sync/                ○ NEW grouping (item — future)
│   │   ├── calendarSync.ts         currently: src/services/calendarSync.ts
│   │   ├── googleCalendar.ts
│   │   ├── outlookCalendar.ts
│   │   ├── syncOrchestrator.ts
│   │   ├── syncPaginate.ts
│   │   └── syncMapHelpers.ts
│   │
│   ├── crm/                 ✓ existing — absorb crmDisconnect + crmSyncStatus (future)
│   │   ├── squareClient.ts
│   │   ├── squareSync.ts
│   │   ├── crmDisconnect.ts  ○ move from services/
│   │   ├── crmSyncStatus.ts  ○ move from services/
│   │   └── types.ts
│   │
│   ├── communications/      ✓ existing — well organized
│   │   ├── appointmentService.ts
│   │   ├── communicationHistory.ts
│   │   ├── emailService.ts
│   │   ├── emailTemplates.ts
│   │   ├── emailLayout.ts / emailLogo.ts / formatLead.ts
│   │   ├── index.ts
│   │   ├── MockAdapter.ts
│   │   ├── ProviderRegistry.ts
│   │   ├── smsRateLimit.ts
│   │   ├── smsService.ts
│   │   ├── systemEmail.ts
│   │   ├── TelephonyProvider.interface.ts
│   │   ├── TelnyxSmsAdapter.ts
│   │   └── types.ts
│   │
│   ├── reminders/           ✓ existing — `index.ts` (ReminderService) is the whole live implementation;
│   │   ├── index.ts           the parallel reminderProcessor/Repository/Scheduler trio was deleted 2026-08-20
│   │   ├── retryPolicy.ts
│   │   ├── scheduleForAppointment.ts
│   │   └── types.ts
│   │
│   ├── tenants/             ✓ existing
│   │   ├── bootstrap.ts
│   │   └── index.ts
│   │
│   ├── knowledge/           ✓ existing (created for the routes/knowledge.ts extraction, item 3)
│   │   ├── answerExplainer.ts, importStaging.ts, ingestChunks.ts, retrievalParams.ts
│   │   ├── siteScrape.ts, suggestionReview.ts, tokenEstimate.ts, websiteImport.ts
│   │   (knowledgeIngestion.ts still sits flat at src/services/knowledgeIngestion.ts)
│   │
│   ├── scripts/             ✓ existing — blocks.ts is the prompt LADDER (fallback path only, see CLAUDE.md)
│   │
│   ├── telephony/           ○ NEW grouping (future)
│   │   ├── phoneUtils.ts    ○ re-export from shared/phone.ts (item 6)
│   │   ├── phoneLoopGuard.ts
│   │   ├── telnyxNumbers.ts
│   │   ├── telnyxNumbersStub.ts
│   │   ├── telnyxSms.ts
│   │   ├── scanRateLimit.ts
│   │   └── provisioningService.ts
│   │
│   ├── customers/           ○ NEW grouping (future)
│   │   ├── customerLookup.ts
│   │   ├── consentService.ts
│   │   └── csv.ts
│   │
│   ├── auth/                ○ NEW grouping (future)
│   │   ├── tokenManagement.ts
│   │   ├── selfServiceToken.ts
│   │   ├── oauthCallbackFactory.ts
│   │   └── oauthStateJwt.ts
│   │
│   └── utils/               ○ NEW grouping (future)
│       ├── timezoneUtils.ts
│       └── nameUtils.ts     ○ re-export from shared/name.ts (item 6)
│
└── workers/
    ├── reminderScheduler.ts       ✓ 60s tick
    ├── voiceSessionReaper.ts      ✓ 60s tick, force-finalizes stale voice_sessions
    ├── websiteRescanScheduler.ts  ✓ daily tick
    └── scheduleExtender.ts        ✓ extends employee_schedule forward
```

---

## `tests/` — backend tests (parallel to `src/`) ✓ item 2 — DONE

Backend tests live under `tests/`, not beside the source. Enumerating individual files here went
stale immediately; the shape is:

```
tests/
├── utils.ts, mock.ts      shared test helpers
├── routes/                unit tests for src/routes/* (agentTools*.test.ts included)
├── services/              unit tests for src/services/* (+ communications/, reminders/, tenants/)
├── workers/               reminderScheduler, voiceSessionReaper, …
├── database/              pool / deadlock-prevention
├── shared/                tests for shared/*
├── scripts/               tests for scripts/*
├── regression/            cross-cutting bug-fix + schema suites (incl. rlsIsolation.test.ts)
├── integration/           all *.realdb.test.ts — require live Postgres
└── *.test.ts              top-level suites (question-tree round trip, preset catalog constraint, …)
```

---

## `agent/` — LiveKit voice worker

```
agent/src/
├── index.ts              ✓ entry point — picks ONE of 3 call architectures at session start
├── config.ts, configSchema.ts ✓
├── prompt.ts             ✓ LADDER-path prompt (fallback only)
├── sessionContext.ts     ✓
├── tenantConfig.ts       ✓
├── toolsClient.ts        ✓
├── tools.ts              ✓ thin re-export; the real definitions are in tools/
├── toolPhases.ts         ✓ LADDER-path only
├── transferClient.ts, transferReport.ts ✓
├── transcript.ts         ✓
├── callOutcome.ts, callSummary.ts, callClassify.ts ✓
├── greeting.ts, greetingPickup.ts ✓
├── fallback.ts, logger.ts, sentry.ts, redactToolArgs.ts ✓
├── customerContext.ts, dispatchReport.ts, nameCleanup.ts, openaiChatCompletion.ts,
│   speechSanitizer.ts, toolCallLog.ts ✓
│
├── checklist/            ✓ existing — THE LIVE CALL ARCHITECTURE (question trees)
│   ├── types.ts          node shapes (text / choice / action) + the 10 NodeStatus values
│   ├── trees.ts          PLATFORM_TREE_LIBRARY — 10 hand-written trees + 30 from verticalIntakeTrees.ts
│   ├── verticalIntakeTrees.ts  30 per-vertical slot-filling intake trees + their presets (#388)
│   ├── tracker.ts        ChecklistTracker: all call state + isResolved() (the goodbye gate)
│   ├── checklistAgent.ts ONE agent for the whole call + buildChecklistPrompt()
│   ├── checklistTools.ts set_purpose / record_answer / finish_call / answer_question + wrapAction
│   ├── presets.ts        the 33 shipped presets (5 hand-written + 28 vertical) — WHICH TREES A TENANT CAN REACH
│   ├── runtimeConfig.ts  the per-tenant compiled config ChecklistAgent receives
│   ├── blockTypes.ts     conversation-block shapes
│   ├── blockSchemas.ts   Zod validation for blocks
│   ├── blockLibrary.ts   the platform block catalog
│   └── blockCompiler.ts  blocks → trees, the compile step presets go through
│
├── tasks/                ✓ existing — TaskGroup "rungs", FALLBACK only (ENABLE_TASK_GROUP)
│   ├── rung.ts           makeRung() generic core        superseded 2026-07-21
│   ├── callRootAgent.ts  intent hand-off via begin_call
│   ├── callPlan.ts       planCallTasks() + runtimePreamble() ← still shared with checklist/
│   └── *Task.ts          identity / bookMeeting / jobIntake / meetingContext / policyQa / takeMessage / scheduling
│
├── session/              ✓ existing — well organized
│   ├── fillerCache.ts
│   ├── thinkingSound.ts
│   ├── holdLines.ts      pre-synthesized dead-air lines, spoken from a TIMER
│   ├── toolActivity.ts   isToolRunning() — so a hold line never names a lookup that isn't happening
│   ├── turnDetector.ts, turnLatency.ts  checklist-aware end-of-turn + latency samples
│   ├── watchdog.ts, outageGuard.ts
│   ├── dnsWarm.ts, dnsIpv4.ts  resolve call-path hosts in prewarm; default-off A-only lookup shim
│   └── workerTuning.ts
│
└── tools/                ✓ item 5 — DONE, grouped by capability (re-exported by ../tools.ts)
    ├── buildTools.ts     buildTools() composition
    ├── types.ts          Capability type, CAPABILITY_OF
    ├── wrapTool.ts       never-freeze contract applied at the compose boundary
    ├── knowledge.ts, messaging.ts, identity.ts, scheduling.ts, verification.ts, sms.ts, transfer.ts
    ├── reachability.ts   DEFINED_UNREACHABLE_ON_QUESTION_TREE
    └── deps.ts, helpers.ts
```

Agent tests are CO-LOCATED (`agent/src/**/*.test.ts` next to the module), not under a separate
`agent/src/tests/` tree. `agent/scripts/` holds the `sim-*` simulation helpers and `verify-tts.mjs`.

---

## `dashboard/` — Next.js 16 frontend

```
dashboard/
├── app/                  ✓ Next.js App Router pages
│   ├── page.tsx          ✓ public landing (footer links the legal pages)
│   ├── register/         ✓ signup — REQUIRED legal-consent checkbox
│   ├── privacy/          ✓ public Privacy Policy
│   ├── terms/            ✓ public Terms (Bonterms Cloud Terms v1.0 by reference)
│   └── dpa/              ✓ public DPA (Bonterms DPA v2.0 cover + subprocessors)
├── lib/                  ✓ API client, types, hooks, utilities
├── types/                ✓
├── e2e/                  ✓ 40 committed Playwright spec files
│
└── components/           ✓ item 7 — DONE 2026-09-12: no loose .tsx at this level; every view is in a subdir
    ├── ui/               ✓ shared primitives (Button, Card, Modal, Toast, …)
    ├── legal/            ✓ LegalDocLayout — shared chrome + the single source of
    │                       the legal constants (effective date, entity, contacts)
    ├── SetupWizard/      ✓ setup wizard steps + WizardModeChooser + Solo wizard
    ├── admin/            ✓ super-admin surfaces
    ├── layout/           ✓ AppShell, OutlookLayout, MobileTabBar, profile/tenant/theme dropdowns
    ├── auth/             ✓ LoginView, ProfileView, FirstRunTour
    ├── home/             ✓ DashboardHome + Home* cards
    ├── business/         ✓ BusinessSettingsView, SetupView, BusinessTypeSection
    ├── settings/         ✓ SettingsView + account cards
    ├── aiconfig/         ✓ AIConfigView + persona / disclosure / forwarding sections (Phone Assistant tab)
    ├── phone/            ✓ GoLivePanel
    ├── appointments/, employees/, services/, resources/
    ├── skills/, skill-map/, shifts/, scheduler/
    ├── voice/            ✓ calls views
    ├── knowledge/, analytics/, crm/, billing/, communications/, records/, team/
    (list `ls dashboard/components` for the authoritative set)

---

## Key constraints

- **`shared/`** has no Node.js or framework deps — importable from backend, agent, and dashboard.
- **`tests/integration/`** requires a live local Postgres (`docker compose up -d db`). CI sets `REQUIRE_DB_TESTS=1`.
- **Dashboard tests** stay co-located in `dashboard/` (React convention; jsdom config is separate).
- **Agent tests** are co-located with the source (`agent/src/**/*.test.ts`) under the agent's own vitest config.
- **Migrations** (`supabase/migrations/`) are never reorganized — the numbered chain is the source of truth.

## `docs/` organization (updated 2026-09-04)

Flat *.md files reorganized into topic dirs to eliminate root clutter:

- `architecture/` — ARCHITECTURE.md, DIRECTORY_STRUCTURE.md, core tech maps
- `planning/` — TODO.md (single backlog), RESOLVED.md, ROADMAP.md, TEST_*.md, item lifecycle
- `voice/` — VOICE_AGENT_PLAYBOOK.md, QUESTION_TREE_ARCHITECTURE.md, CALL_*.md, migrations, superseded call designs, knowledge base
- `product/` — MISSION, STRATEGY, FEATURES, COMPETITOR_*, VERTICAL-*
- `design/` — DESIGN_HANDOFF.md, UI_UX_DESIGN.md, DIAGRAMS.md
- `workflow/` — DEVELOPMENT_WORKFLOW.*, CODING_STANDARDS.md, BRANCH_CHECKLIST.md, AGENTS.md, LESSONS_LEARNED.md
- `operations/` — DEPLOYMENT.*, RUNBOOK.md, SECURITY.md, onboarding, TICKET_SUPPORT.md

Existing structured subdirs unchanged: `legaldocs/`, `superpowers/{specs,plans}/`, `mockups/`, plus `calls/` (prod call archive) and `diagrams/` (`.mmd` sources).

All cross-references and index tables in README.md updated. No stragglers (verified via repo search).

