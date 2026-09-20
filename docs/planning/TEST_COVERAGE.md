# Test Coverage

**Latest verification rerun (suite totals):** 2026-09-20 (recorded in `CLAUDE.md` Project Status). `npm test` at repo root finished **3,365 passing (281 files)**; `cd dashboard && npm test` finished **1,242 passing (113 files)**; `cd agent && npm test` finished **1,085 passing (63 files)**; `tsc --noEmit` clean in all three packages. Measured on the PR #540 branch (= `main` through #539 + #540), so the dashboard figure assumes #540 merges. Playwright e2e was NOT re-run locally (it wipes and rebuilds the local database); CI runs it green on every PR.

**Prior verification rerun (suite totals):** 2026-09-16. Root **3,205 passing (268 files)**; dashboard **1,173 passing (107 files)**; agent **1,061 passing (61 files)**.

**Prior verification rerun:** 2026-08-19. `npm test` at repo root finished 2,750 passing (226 files); dashboard 1,044 passing (97 files); agent 943 passing (56 files); `cd agent && npm run build` exited **0**. Production freshness also moved the same day: `GET https://secretary-hq-production.up.railway.app/health` returned `{"status":"ok","started_at":"2026-08-19T08:22:19.112Z"}` and `POST /demo/start` returned `{"success":true,...}`.

**Latest V8 coverage rerun:** 2026-08-19 (percentages below have NOT been re-measured since; suite totals above have). Root `npx vitest run --coverage` finished **2,805 passing (233 files)** with coverage **74.17% statements / 66.35% branches / 72.64% functions / 76.08% lines**. Dashboard `cd dashboard && npx vitest run --coverage` finished **1,044 passing (97 files)** with coverage **61.99% statements / 58.17% branches / 57.60% functions / 63.97% lines**.

**Warnings seen during the 2026-08-19 reruns, but both commands exited 0:**
- Dashboard test/coverage emits `ReferenceError: closeMobileMenu is not defined` from a jsdom inline click handler.
- Root coverage emitted `Failed to parse file:///home/dale/projects/secretary-hq/src/templates/auto_bays_v1.yaml. Excluding it from coverage.`

**Prior fully green headline snapshot kept for history:** 2026-08-14 — **2,706 backend + 1,044 dashboard + 1,629 agent = 5,379 passing**.

**Prior reconcile:** 2026-08-11 — **2,675 backend + 1,031 dashboard + 1,498 agent = 5,204 passing**, tied to the vertical-preset/block + intake-submission checkpoint.

**Prior refresh:** 2026-05-22 — Walk-in customer create modal work. Replaced the single "Full name" field in CustomerCombobox with a proper `CustomerCreateModal` (split name, phone, email, address, timezone, internal notes). `name` is now derived from first+last on submit. Dashboard test count: 705 → 716.

**Previous major refresh (2026-05-13):** PK-rename pilot 28 closed the real-DB coverage gap. See `planning/RESOLVED.md` for the full 28-pilot summary (including the 121 follow-up renames, 5 latent bugs surfaced, and the UUID type fixes). Detailed migration and test counts are in RESOLVED.md.

Older refresh history (May 9–12 PK-rename sprint, reminder wiring, security pass 2, etc.) has been consolidated in `planning/RESOLVED.md`.


> **Maintenance rule:** Refresh this file whenever a commit measurably moves
> test counts or coverage percentages (added a test suite, deleted a stale
> test, raised coverage by ≥1pp on a hotspot, etc.). Re-run the commands in
> [Regenerating](#regenerating) and update the tables. The numbers go stale
> within a session — a stale table here is worse than no table.

## Headline counts

| Suite | Tests | Status | Runtime |
|---|---|---|---|
| Root/backend (`npm test`) | 3,365 passing (281 files) | ✅ | 2026-09-20 rerun |
| Dashboard (`cd dashboard && npm test`) | 1,242 passing (113 files) | ✅ | 2026-09-20 rerun (with #540) |
| Agent (`cd agent && npm test`) | 1,085 passing (63 files) | ✅ | 2026-09-20 rerun |
| Playwright e2e (`cd dashboard && npx playwright test`) | 162 passed, 15 skipped | ✅ last verified, not re-run in this sweep | 2026-08-18 full verification |

Current verified total from the three suites re-run on 2026-09-20: **5,692 passing** (3,365 + 1,242 + 1,085). Last verified Playwright snapshot still stands at **162 passed, 15 skipped** from 2026-08-18.

> **On skipped e2e tests**: `calendar-sync.spec.ts` tests skip without `SYNC_TEST_RECORDER=1` (set it + restart the backend to run them). One test in `full-functional-audit.spec.ts` (Voice Calls) is deferred until Telnyx PSTN clears. Re-run the suite to refresh pass/skip counts.

## Unit test coverage (V8)

| Project | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| Root Vitest (`npx vitest run --coverage`) | **74.17%** (7,051/9,506) | 66.35% (4,503/6,786) | 72.64% (1,062/1,462) | 76.08% (6,620/8,701) |
| Dashboard (`components/`, `lib/`) | **61.99%** (5,027/8,109) | 58.17% (3,891/6,689) | 57.60% (1,322/2,295) | 63.97% (4,682/7,319) |

HTML reports: `coverage_data/index.html` (root), `dashboard/coverage/index.html` (dashboard).

## E2E coverage — workflow-based, not percentage-based

E2E tests drive a black-box browser against the running stack; there's no
source instrumentation, so V8/Istanbul percentages don't apply without a
purpose-built coverage build. Track e2e by **workflows covered** instead.

### Hard-asserted workflows (fail loud on regression)

| File | Workflow | Surface exercised |
|---|---|---|
| `workflows.spec.ts` | smoke | Login → tab nav → Schedule → seeded appts |
| `workflows.spec.ts` | quick book | UI form → POST `/appointments` → GiST exclusion check → DB row |
| `workflows.spec.ts` | edit appointment | UI list visibility + PUT `/appointments/:id/update` (happy + sad) |
| `workflows.spec.ts` | create customer | POST `/customers/create` → list refresh → DB row |
| `workflows.spec.ts` | front-desk role gating | Login as `front_desk` → Advanced tabs hidden |
| `workflows.spec.ts` | invite teammate | Owner-only POST `/users/invite` → user + password_resets row |
| `quick-book-shift-overrides.spec.ts` | book against `employee_schedule` | shift override, no weekly pattern |
| `quick-book-shift-overrides.spec.ts` | validator: end ≤ start | rejected |
| `quick-book-shift-overrides.spec.ts` | validator: 23-hour appointment | rejected |
| `quick-book-shift-overrides.spec.ts` | resources/chairs view | renders rows |
| `calendar-sync.spec.ts` | appointment lifecycle dispatch | create/update/delete each fire calendar + Square via `SYNC_TEST_RECORDER` recorder |
| `calendar-sync.spec.ts` | customer lifecycle dispatch | create/update/delete each fire Square (no calendar — by contract) |
| `calendar-sync.spec.ts` | fire-and-forget contract | HTTP returns in <3s even with sync promises in flight |
| `setup-wizard-to-booking.spec.ts` | wizard finalize → first booking | `/register` → seed services/resource/employee → `/shifts/expand-weekly` → `/appointments/create` succeeds |
| `setup-wizard-to-booking.spec.ts` | skip-fan-out sad path | same flow minus expand-weekly → booking returns `EMPLOYEE_NOT_SCHEDULED` |
| `setup-wizard-to-booking.spec.ts` | range coverage | default `weeks_ahead=4` → 28 employee_schedule rows reaching ~27 days out |
| `workflows.spec.ts` | quick book real-time | submit Quick Book → capture `appointment_id` from POST response → assert `[data-testid="appointment-block-${id}"]` visible in grid without page reload |
| `appointment-cancel-restore.spec.ts` | reactivate happy round-trip | seed appt → `/cancel` → DB status='canceled' → `/reactivate` → DB status='scheduled' |
| `appointment-cancel-restore.spec.ts` | slot-rebooked race | cancel A → seed B in A's slot → reactivate A → 409 + TIMESLOT_OCCUPIED + conflict block; A stays canceled, B stays scheduled |
| `appointment-cancel-restore.spec.ts` | not-canceled guard | reactivate on status='scheduled' → 400 + NOT_CANCELED, no UPDATE issued |
| `mobile-responsive.spec.ts` | mobile schedule (iPhone 14) | 390×844 viewport → mobile nav renders → Schedule tab → scheduler-view + date display visible, no horizontal overflow |
| `mobile-responsive.spec.ts` | mobile quick book (iPhone 14) | Resources sub-view → Quick Book panel + customer/resource/confirm inputs visible, no overflow |
| `mobile-responsive.spec.ts` | mobile customer lookup (iPhone 14) | Customers tab → seeded customer name visible in list, no overflow |
| `mobile-responsive.spec.ts` | Android smoke (Pixel 7) | 412×915 viewport → mobile nav → Schedule reachable, no overflow (catches breakpoint-specific regressions iPhone width misses) |
| `tenant-delete-cascade.spec.ts` | full cascade | super-admin DELETE /tenants/:id → every dependent row count drops to 0 across 11 tenant-scoped tables (users / services / resources / employees / customers / employee_schedule / appointments / mappings / audit_log / record_versions) |
| `tenant-delete-cascade.spec.ts` | cross-tenant isolation | deleting tenant A leaves tenant B's row counts unchanged — cascade is scoped to the deleted tenant_id, not a schema-wide DELETE |
| `tenant-delete-cascade.spec.ts` | authz | tenant owner token cannot delete its own tenant → 403, tenant row + dependents untouched (gate fires before any SQL) |
| `version-history-restore.spec.ts` | soft-delete → restore round-trip | create customer → `/soft-delete` → filtered from `/customers` + appears in `/records/customers/deleted` → `/restore` → back in active list + gone from deleted list |
| `version-history-restore.spec.ts` | restore non-deleted | `/restore` on a record that was never deleted → 404 + `RECORD_NOT_DELETED`; record state unchanged |
| `version-history-restore.spec.ts` | invalid table whitelist | `/restore` against `foobar` or `tenants` → 400 + `INVALID_TABLE`; pins the SQL-injection-defense boundary on the route's inlined table name |

### Soft-checked workflows (`if (visible)` guards or `logIssue()`)

`critical-ux-fixes.spec.ts` — toast dismissal, shift validation toast, Quick
Book disabled-state, wizard step-guard, scheduler crash-on-empty, scheduler
stale-empty-state, unsaved-changes Save/Discard banner.

`full-functional-audit.spec.ts` — walks Home, Scheduler, CRM, Calls, Services
& Resources, My Team, Phone Assistant, theme switcher, URL-tab
restoration. Uses `logIssue()` not `expect()` — sections can be broken and
the test still passes.

### Not covered by any e2e

- Voice/AI loop (Telnyx → LiveKit → tools → booking) — covered by `./scripts/simulate.sh tools` (on-demand system harness), not Playwright
- ~~Calendar sync (Google + Outlook OAuth)~~ — orchestration layer covered by `calendar-sync.spec.ts` (2026-05-08); actual outbound HTTP shape still only at unit level
- ~~CRM sync (Square, bidirectional)~~ — dispatch (us → Square) covered by `calendar-sync.spec.ts`; bidirectional read path (Square → us) still uncovered. (The Jobber / HubSpot / ServiceTitan integrations were removed 2026-06-12.)
- ~~Setup wizard end-to-end (8 steps from business-type pick to first booking)~~ — finalize → first-booking path now covered by `setup-wizard-to-booking.spec.ts` (2026-05-08); 8-step UI walkthrough still uncovered, deferred (driving the modal's nested step state through Playwright is heavy for what unit-tests of `useWizardCrud` already cover)
- Stripe billing flow / checkout / webhook
- SMS OTP verification before booking
- Knowledge base upload → chunking → RAG query
- Multi-tenant admin (super-admin tenant switching, "Activate Phone")
- ~~Mobile responsive~~ — automated audit added 2026-05-11 (`mobile-responsive.spec.ts`, iPhone 14 + Pixel 7 viewports via `page.setViewportSize`). Real-device verification on iOS Safari + Android Chrome still recommended pre-beta for touch + virtual-keyboard behaviors Playwright Chromium can't fully emulate.

## Low-coverage hotspots worth attention

_Hotspot percentages are from the 2026-08-19 coverage run. Rows for `src/services/reminders/reminderRepository.ts` / `reminderScheduler.ts` (deleted 2026-08-20 as a dead parallel implementation), `dashboard/components/shifts/ShiftScheduleView.tsx` and `dashboard/lib/callerActions.ts` (no longer exist) were removed 2026-09-18; the remaining rows have not been re-measured._

### Root / backend
| File | Statements | Notes |
|---|---|---|
| `src/index.ts` | 0% | app bootstrap still uncovered by direct tests |
| `src/routes/vocabulary.ts` | 0% | route file still unexercised |
| `src/routes/calendar.ts` | 0.99% | calendar route remains mostly uncovered |
| `src/workers/scheduleExtender.ts` | 0% | worker path still uncovered |

### Dashboard
| File | Statements | Notes |
|---|---|---|
| `components/shifts/ShiftEditorModal.tsx` | 0% | whole shift editor path still dark |
| `components/shifts/ShiftTimeline.tsx` | 0% | whole shift timeline path still dark |
| `components/scheduler/SchedulerToolbar.tsx` | 0% | toolbar path still unexercised |
| `components/knowledge/KnowledgeDocumentsTab.tsx` | 11.76% | document-tab path still thin |
| `lib/api.ts` | 33.42% | many API helpers still unexercised |

## Regenerating

```bash
# Backend coverage (~90s, requires Postgres + test_db migrated)
npx vitest run --coverage

# Dashboard coverage (~30s)
cd dashboard && npx vitest run --coverage

# Playwright e2e count (requires servers running on :4000 + :4001 + Postgres)
cd dashboard && npx playwright test
```

**Running the suites from a git worktree:** a worktree has no `dashboard/node_modules` or `agent/node_modules`. Link them from the main checkout (`ln -s <main>/dashboard/node_modules dashboard/node_modules`, same for `agent/`) or the dashboard suite cannot start and `tests/tenantLiveCallJourneys.test.ts` fails to load (`Cannot find package '@livekit/agents'`) — an environment artifact, not a regression (measured 2026-09-20: 3,359 passing + that one file failing without the link; 3,365 passing, all 281 files, with it). `git status` shows the `agent/` symlink as untracked, so delete it before `git add -A`. Do not run two suites at once: they share the one local `test_db`.

After running, paste the new totals into the tables above and bump the
"Last refreshed" date. Per-file breakdowns are in the HTML reports — only
copy a file into the hotspots table if it materially moved.
