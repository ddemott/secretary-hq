# Repository Directory Structure

Target layout for the entire monorepo. Every source directory contains **only production code**; tests live in parallel `tests/` trees.

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
├── tests/                         backend tests  ○(item 2)
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
├── getEmbedding.ts    ✓ OpenAI embedding wrapper
├── normalizeForEmbedding.ts  ✓
├── expandQueryForEmbedding.ts ✓ RAG query expansion
├── callContext.ts     ✓ call-context shape shared by agent + backend
├── dateTime.ts        ✓
├── markerQuestions.ts ✓
├── versionHistoryFields.ts ✓ field lists behind the version-history RPCs
├── checklistPresetDerivation.ts ✓ preset id + business_type → checklist runtime config
├── checklistOverrides.ts ✓ the SUBTRACT-only override validator (no ADD verb, by design)
├── checklistPreview.ts   ✓ Business Settings next-call dry-run (ASK / LISTEN / REQUIRED)
└── voiceCrm.ts        ✓
```

The last three are here for one reason: the dashboard's preview of the next call
and the agent's actual runtime must never disagree about what the call will ask.
One implementation, two consumers.

---

## `src/` — Fastify backend (production code only)

```
src/
├── index.ts                 ✓ entry point — registers all routes + workers
├── middleware.ts            ✓ withHandler, tenantMiddleware, JWT auth hook
├── constants.ts             ✓ app-wide constants
├── jsonContentTypeParser.ts ✓ Fastify plugin
├── readinessHandler.ts      ✓ /ready deep-health handler
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
│   ├── agentTools/          🔄 item 1 — splitting the 2,524-line file
│   │   ├── schemas.ts       ✓ all 26 Zod schemas + constants
│   │   ├── helpers.ts       ✓ ok/fail/toolRoute/pgErrorFields/interval math
│   │   ├── session.ts       ○ voice-session-start/end/transcript, tenant-config
│   │   ├── scheduling.ts    ○ check-availability, available-slots, book-*, cancel, reschedule
│   │   ├── identity.ts      ○ identify-caller, customer-context, find-by-name, history, preferences
│   │   ├── knowledge.ts     ○ policy-answer, service-catalog
│   │   ├── messaging.ts     ○ take-message, page-owner, capture-job-inquiry, verify-phone
│   │   ├── aiCost.ts        ○ record-ai-cost
│   │   ├── _testRoutes.ts   ○ /agent-tools/_test/sync-events (SYNC_TEST_RECORDER-gated)
│   │   └── index.ts         ○ registerAgentToolRoutes() + auth preHandler only
│   │
│   ├── agentTools.ts        🔄 replaced by agentTools/index.ts when item 1 complete
│   ├── analytics.ts         ✓ (logic extraction → item 4)
│   ├── appointments.ts      ✓
│   ├── auth.ts              ✓
│   ├── auditLog.ts          ✓
│   ├── billing.ts           ✓
│   ├── calendar.ts          ✓
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
├── services/
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
│   ├── reminders/           ✓ existing — well organized
│   │   ├── index.ts
│   │   ├── reminderProcessor.ts
│   │   ├── reminderRepository.ts
│   │   ├── reminderScheduler.ts
│   │   ├── retryPolicy.ts
│   │   ├── scheduleForAppointment.ts
│   │   └── types.ts
│   │
│   ├── tenants/             ✓ existing
│   │   ├── bootstrap.ts
│   │   └── index.ts
│   │
│   ├── knowledge/           ○ NEW grouping (items 3 + future)
│   │   ├── knowledgeIngestion.ts    currently: src/services/knowledgeIngestion.ts
│   │   ├── knowledgePipeline.ts     ○ TODO extract from routes/knowledge.ts
│   │   └── knowledgeSuggestions.ts  ○ TODO extract from routes/knowledge.ts
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
    ├── reminderScheduler.ts  ✓
    └── voiceSessionReaper.ts ✓
```

---

## `tests/` — backend tests (parallel to `src/`) ○ item 2

```
tests/
├── utils.ts               ○ was: src/test-utils.ts
├── mock.ts                ○ was: src/test-utils-mock.ts
│
├── routes/                ○ unit tests for src/routes/*
│   ├── agentTools/        ○ all agentTools*.test.ts files
│   │   ├── agentTools.test.ts
│   │   ├── agentToolsAiCost.test.ts
│   │   ├── agentToolsBookingIntegration.test.ts
│   │   ├── agentToolsCancel.test.ts
│   │   ├── agentToolsCustomerHistory.test.ts
│   │   ├── agentToolsMessages.test.ts
│   │   ├── agentToolsPageOwner.test.ts
│   │   ├── agentToolsPreferences.test.ts
│   │   ├── agentToolsSelfServiceLink.test.ts
│   │   ├── agentToolsTakeMessage.test.ts
│   │   └── tools.test.ts
│   ├── analytics.test.ts
│   ├── appointment-date-filter.test.ts
│   ├── appointment-mutations.test.ts
│   ├── appointments.test.ts
│   ├── auth.test.ts
│   ├── available-slots-consolidated.test.ts
│   ├── available-slots.test.ts
│   ├── billing-routes.test.ts
│   ├── billing.test.ts
│   ├── billing.route.test.ts    ← was: src/routes/billing.test.ts
│   ├── book-appointment-mapping.test.ts
│   ├── booking-buffer.test.ts
│   ├── booking-concurrency.test.ts
│   ├── booking-soft-delete.test.ts
│   ├── calendar-sync.test.ts
│   ├── communications.test.ts
│   ├── coverage-gaps.test.ts
│   ├── coverage-ui-consistency.test.ts
│   ├── coverage.test.ts
│   ├── crm-appointments.test.ts
│   ├── crud-routes.test.ts
│   ├── customer.test.ts
│   ├── customers.import.test.ts
│   ├── demo-route.test.ts
│   ├── exportData.test.ts
│   ├── jwt-logging.test.ts
│   ├── knowledge-import-document.test.ts
│   ├── knowledge-policy-answer.test.ts
│   ├── knowledge.explain.test.ts
│   ├── knowledge.importWebsite.test.ts
│   ├── knowledge.suggestions.test.ts
│   ├── mappings.test.ts
│   ├── provisioning.test.ts
│   ├── provisioning.route.test.ts ← was: src/routes/provisioning.test.ts
│   ├── reminders.deliveryStats.test.ts
│   ├── routeHelpers.test.ts
│   ├── selfService.test.ts
│   ├── service-catalog.test.ts
│   ├── service-enhancements.test.ts
│   ├── shift-overrides-edge.test.ts
│   ├── shift-overrides-routes.test.ts
│   ├── shifts-routes.test.ts
│   ├── skills.test.ts
│   ├── solo-wizard.test.ts
│   ├── square-routes.test.ts
│   ├── tenant-reorder.test.ts
│   ├── tenant-routes.test.ts
│   ├── tenants-notification-prefs.test.ts
│   ├── tenants-postgres-config.test.ts
│   ├── tenants-update-config-loop.test.ts
│   ├── token-refresh.test.ts
│   ├── unanswered-questions.test.ts
│   ├── auditLog.test.ts
│   ├── users-routes.test.ts
│   ├── versionHistory.test.ts
│   ├── vocabulary-wiring.test.ts
│   ├── vocabulary.test.ts
│   ├── voice.test.ts
│   └── webhook-signatures.test.ts
│
├── services/              ○ unit tests for src/services/*
│   ├── appointmentValidation.test.ts
│   ├── availability-search.test.ts
│   ├── calendar-sync.test.ts
│   ├── conflictLookup.test.ts
│   ├── consentService.test.ts
│   ├── crmDisconnect.test.ts
│   ├── crmSyncStatus.test.ts
│   ├── csv.test.ts
│   ├── customerLookup.test.ts
│   ├── deadlock-prevention.test.ts
│   ├── demo-seed.test.ts
│   ├── envWarnings.test.ts
│   ├── expand-weekly-integration.test.ts
│   ├── expandWeeklyToSchedule.test.ts
│   ├── featureReadiness.test.ts
│   ├── google-calendar.test.ts
│   ├── knowledge-normalization.test.ts
│   ├── knowledgeIngestion.test.ts
│   ├── logger.test.ts
│   ├── metrics.test.ts
│   ├── nameUtils.test.ts
│   ├── night-shift-availability.test.ts
│   ├── normalizer.test.ts
│   ├── oauthCallbackFactory.test.ts
│   ├── oauthStateJwt.test.ts
│   ├── outlook-calendar.test.ts
│   ├── phoneLoopGuard.test.ts
│   ├── phoneUtils.test.ts
│   ├── poolExhaustion.test.ts
│   ├── provisioningService.test.ts
│   ├── queryExpander.test.ts
│   ├── rag-normalization.test.ts
│   ├── reminder-retry-worker.test.ts
│   ├── scanRateLimit.test.ts
│   ├── scheduling-atomic.test.ts
│   ├── scheduling-overrides.test.ts
│   ├── scheduling-timezone-bug.test.ts
│   ├── scheduling.test.ts
│   ├── selfServiceToken.test.ts
│   ├── sentry.test.ts
│   ├── serviceResolver.test.ts
│   ├── skill-resource-matching-sweep.test.ts
│   ├── square-client.test.ts
│   ├── square-sync.test.ts
│   ├── sync-orchestrator.test.ts
│   ├── syncOrchestrator.test.ts
│   ├── syncPaginate.test.ts
│   ├── telnyxSms.test.ts
│   ├── timezoneUtils.test.ts
│   ├── tokenManagement.test.ts
│   ├── communications/
│   │   ├── TelnyxSmsAdapter.test.ts
│   │   ├── communicationHistory.test.ts
│   │   ├── communications.test.ts
│   │   ├── emailService.test.ts
│   │   ├── smsRateLimit.test.ts
│   │   └── smsServiceMetrics.test.ts
│   ├── reminders/
│   │   ├── reminderProcessor-metrics.test.ts
│   │   ├── reminders.test.ts
│   │   ├── retryPolicy.test.ts
│   │   └── scheduleForAppointment.test.ts
│   └── tenants/
│       └── bootstrap.test.ts
│
├── workers/               ○ unit tests for src/workers/*
│   ├── reminderScheduler.test.ts
│   └── voiceSessionReaper.test.ts
│
├── database/              ○
│   └── database.test.ts
│
├── regression/            ○ cross-cutting bug-fix + schema suites
│   ├── architecture-review-fixes.test.ts
│   ├── bugfix-comprehensive.test.ts
│   ├── critical-bugs.test.ts
│   ├── high-bugs.test.ts
│   ├── low-bugs.test.ts
│   ├── medium-bugs.test.ts
│   ├── multi-tenant-isolation.test.ts
│   ├── pk-extension-tables.test.ts
│   ├── pk-rename-coverage.test.ts
│   ├── tenant-fk-cascade.test.ts
│   ├── type-safety.test.ts
│   └── voice-ai-fixes.test.ts
│
└── integration/           ○ all *.realdb.test.ts — require live Postgres
    ├── agentToolsAiCost.realdb.test.ts
    ├── agentToolsCancelReschedule.realdb.test.ts
    ├── agentToolsCustomerSearch.realdb.test.ts
    ├── agentToolsMessages.realdb.test.ts
    ├── agentToolsRecordConsent.realdb.test.ts
    ├── analytics.firstTimeFix.realdb.test.ts
    ├── analytics.realdb.test.ts
    ├── analyticsUtilization.realdb.test.ts
    ├── auditLog.realdb.test.ts
    ├── communications.realdb.test.ts
    ├── coverageDryRun.realdb.test.ts
    ├── crmSync.realdb.test.ts
    ├── customerDelete.realdb.test.ts
    ├── customers.import.realdb.test.ts
    ├── employees.realdb.test.ts
    ├── exportData.realdb.test.ts
    ├── multiEmployeeScheduling.realdb.test.ts
    ├── reminders.deliveryStats.realdb.test.ts
    ├── rls.test.ts
    ├── schema.test.ts
    ├── scheduleForAppointment.realdb.test.ts
    ├── selfService.realdb.test.ts
    ├── serviceResolver.realdb.test.ts
    ├── setupCommit.realdb.test.ts
    ├── skills.realdb.test.ts
    ├── tenants.realdb.test.ts
    ├── users.realdb.test.ts
    ├── users.revokeSessions.realdb.test.ts
    ├── versionHistory.realdb.test.ts
    ├── voice.realdb.test.ts
    └── voiceSessionReaper.realdb.test.ts
```

---

## `agent/` — LiveKit voice worker

```
agent/src/
├── index.ts              ✓ entry point
├── config.ts             ✓
├── prompt.ts             ✓
├── sessionContext.ts     ✓
├── tenantConfig.ts       ✓
├── toolsClient.ts        ✓
├── transferClient.ts     ✓
├── transcript.ts         ✓
├── callOutcome.ts        ✓
├── callSummary.ts        ✓
├── callClassify.ts       ✓
├── greeting.ts           ✓
├── fallback.ts           ✓
├── logger.ts             ✓
├── sentry.ts             ✓
├── redactToolArgs.ts     ✓
│
├── checklist/            ✓ existing — THE LIVE CALL ARCHITECTURE (question trees)
│   ├── types.ts          node shapes (text / choice / action) + the 10 NodeStatus values
│   ├── trees.ts          PLATFORM_TREE_LIBRARY — the 9 trees a purpose can select
│   ├── tracker.ts        ChecklistTracker: all call state + isResolved() (the goodbye gate)
│   ├── checklistAgent.ts ONE agent for the whole call + buildChecklistPrompt()
│   ├── checklistTools.ts set_purpose / record_answer / finish_call / answer_question + wrapAction
│   ├── presets.ts        the 4 shipped presets — WHICH TREES A TENANT CAN REACH
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
│   └── *Task.ts          identity / bookMeeting / meetingContext / takeMessage / scheduling
│
├── session/              ✓ existing — well organized
│   ├── fillerCache.ts
│   ├── thinkingSound.ts
│   ├── holdLines.ts      pre-synthesized dead-air lines, spoken from a TIMER
│   ├── toolActivity.ts   isToolRunning() — so a hold line never names a lookup that isn't happening
│   ├── turnDetector.ts   checklist-aware end-of-turn (reads the pending [ASK] node)
│   └── watchdog.ts
│
├── tools/                🔄 item 5 — group by capability
│   ├── wrapTool.ts       ✓ existing
│   ├── knowledge.ts      ○ get_company_policy_answer, get_service_catalog
│   ├── messaging.ts      ○ take_message, capture_job_inquiry, page_owner_via_sms, verify-phone
│   ├── identity.ts       ○ get_customer_context, find_caller_by_name, identify_caller, preferences
│   ├── scheduling.ts     ○ get_available_slots, book_appointment, book_with_scheduling, cancel, reschedule
│   ├── transfer.ts       ○ transfer_call
│   └── index.ts          ○ buildTools(), CAPABILITY_OF, Capability type
│
└── tests/                ○ item 2 (agent) — agent tests separate from source
    ├── callClassify.test.ts
    ├── callOutcome.test.ts
    ├── callSummary.test.ts
    ├── fallback.test.ts
    ├── greeting.test.ts
    ├── logger.test.ts
    ├── prompt.test.ts
    ├── redactToolArgs.test.ts
    ├── sentry.test.ts
    ├── sessionContext.test.ts
    ├── tenantConfig.test.ts
    ├── tools.test.ts
    ├── toolsClient.test.ts
    ├── transcript.test.ts
    ├── transferClient.test.ts
    ├── session/
    │   ├── fillerCache.test.ts
    │   ├── thinkingSound.test.ts
    │   └── watchdog.test.ts
    └── tools/
        └── wrapTool.test.ts
```

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
└── components/
    ├── ui/               ✓ primitives (Button, Card, Modal, Toast, …)
    ├── legal/            ✓ LegalDocLayout — shared chrome + the single source of
    │                       the legal constants (effective date, entity, contacts)
    ├── SetupWizard/      ✓ existing — well organized
    ├── admin/            ✓ existing
    │
    ├── layout/           ○ item 7 — AppShell, OutlookLayout, DashboardHome,
    │                               ErrorBoundary, DemoBanner, FirstRunTour,
    │                               SetupProgressPill, VersionBadge, LoginView,
    │                               ProfileView, SettingsView, SetupView
    │
    ├── appointments/     ○ item 7 — AppointmentView, AppointmentDetailPanel,
    │                               AppointmentListSidebar
    ├── employees/        ○ item 7 — EmployeeManagementView, EmployeeServiceAssignmentView
    ├── skills/           ○ item 7 — SkillManagementView, SkillAssignmentsView, SkillMatrixView,
    │                               ServiceAssignmentView
    ├── resources/        ○ item 7 — ResourceManagerView
    ├── voice/            ○ item 7 — VoiceCallsView
    ├── knowledge/        ○ item 7 — KnowledgeBaseView, KnowledgeSuggestions, ExplainAnswerView
    ├── analytics/        ○ item 7 — AnalyticsView, UtilizationHeatmap, AIInsightsView
    ├── crm/              ○ item 7 — CRMView, CRMIntegrationCard
    ├── billing/          ○ item 7 — BillingView
    ├── customers/        ○ item 7 — CustomerDetailPanel, DeletedRecordsPanel
    ├── team/             ○ item 7 — TeamAccessView, TenantAdminForms, TenantCard,
    │                               TenantCreateForm, TenantEditPanel, SuperAdminDashboard
    ├── records/          ○ item 7 — RecordHistoryModal, AuditLogView
    ├── scheduler/        ○ item 7 — SchedulerView, ShiftManagementView
    ├── communications/   ○ item 7 — CommsSentView, ReminderDeliveryStats
    └── phone/            ○ item 7 — AIConfigView, BusinessSettingsView (phone assistant config)
```

---

## Key constraints

- **`shared/`** has no Node.js or framework deps — importable from backend, agent, and dashboard.
- **`tests/integration/`** requires a live local Postgres (`docker compose up -d db`). CI sets `REQUIRE_DB_TESTS=1`.
- **Dashboard tests** stay co-located in `dashboard/` (React convention; jsdom config is separate).
- **Agent tests** move to `agent/src/tests/` to match the backend pattern without affecting the agent's own vitest config.
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

Existing structured subdirs unchanged: `legaldocs/`, `superpowers/{specs,plans}/`, `mockups/`.

All cross-references and index tables in README.md updated. No stragglers (verified via repo search).

