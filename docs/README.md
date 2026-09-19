# Documentation Index

This folder contains the project's technical and operational documentation.

## Documentation Principles (How We Stay Sane)

- **One backlog**: ALL open work — active tasks, gaps, ideas, go-live blockers — lives in `docs/planning/TODO.md`. The former `GAPS.md`, `IMPROVEMENT_IDEAS.md`, `IMPROVEMENTS_TODO.md`, and `AIASSISTANT_GO_LIVE_TODO.md` were folded in and deleted 2026-07-05 (done items + analysis archived verbatim in `planning/RESOLVED.md`). Go-live / Telnyx ops detail → `RUNBOOK.md` §7.
  - Historical UX audit findings were also consolidated into `docs/planning/TODO.md` (the raw `ux-review-notes.md` + dated `scripts/ux-audit/reports/*/TODO-*.md` snapshots were removed 2026-06-30 once their actionable items had been absorbed).

  (The mechanical/type/convention refactor backlog `REFACTORING_TODO.md` was completed and removed 2026-06-19; its history lives in `planning/RESOLVED.md`.)

- **Historical vs living**: Big completed work and session journals go to `planning/RESOLVED.md`. `CLAUDE.md` is deliberately kept lean and points at the docs/ folder for details.
- **Succinctness over completeness**: When in doubt, link instead of duplicate. Long idea entries are acceptable only while they are active proposals.

## Core Documentation

| File                                                           | Purpose                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)                                      | Main project overview (start here)                                                                                   |
| [CLAUDE.md](../CLAUDE.md)                                      | Current-state reference for agents & humans (points to docs/ for depth)                                              |
| [ARCHITECTURE.md](architecture/ARCHITECTURE.md)                             | Technical architecture and stack                                                                                     |
| [DIRECTORY_STRUCTURE.md](architecture/DIRECTORY_STRUCTURE.md) | Repo directory map / target layout of the monorepo                                                                   |
| [QUESTION_TREE_ARCHITECTURE.md](voice/QUESTION_TREE_ARCHITECTURE.md) | **How a call actually works — the LIVE call flow** (`agent/src/checklist/`). Read before changing any call behaviour |
| [DIAGRAMS.md](design/DIAGRAMS.md)                                     | Mermaid diagrams (deployment, voice flow, call sequencing, booking, OAuth, etc.)                                     |
| [VOICE_AGENT_PLAYBOOK.md](voice/VOICE_AGENT_PLAYBOOK.md)             | Voice pipeline rules — STT/LLM/TTS, latency, turn-taking                                                             |
| [DEPLOYMENT.md](operations/DEPLOYMENT.md)                                 | How to run, deploy, and configure the system                                                                         |
| [SECURITY.md](operations/SECURITY.md)                                     | Security model, RLS, auth, and hardening                                                                             |
| [RUNBOOK.md](operations/RUNBOOK.md)                                       | Production incident + telephony recovery playbook                                                                    |
| [ALERTS.md](operations/ALERTS.md)                                         | Alerting rules (optional; paid observability decided against 2026-07-02)                                             |
| [DEPLOYMENT_CHECKLIST.md](operations/DEPLOYMENT_CHECKLIST.md)             | Sequence from "work is done" to "running in production" + the ways this repo has silently failed to deploy           |

## Planning, Tasks & Status

| File                                 | Purpose                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [TODO.md](planning/TODO.md)                   | **The one backlog** — all open work, prioritized (GAPS + ideas + go-live folded in 2026-07-05) |
| [TODO_ITEM_LIFECYCLE.md](planning/TODO_ITEM_LIFECYCLE.md) | **Start→finish→purge** for one TODO/roadmap task — clean path + parallel/conflict exception |
| [RESOLVED.md](planning/RESOLVED.md)           | Completed phases + historical bug tracker + session archive (incl. the folded-doc snapshots)   |
| [ROADMAP.md](planning/ROADMAP.md)             | Vertical-preset execution roadmap (steps 1–10 closed in CI)                                    |
| [TEST_COVERAGE.md](planning/TEST_COVERAGE.md) | Test coverage status and gaps                                                                  |
| [TEST_DB_AUDIT.md](planning/TEST_DB_AUDIT.md) | Mocked-DB vs real-SQL coverage map                                                             |
| [PRODUCT_ROADMAP.md](planning/PRODUCT_ROADMAP.md) | Work-order backlog with per-task proof commands (roles + handoff) |
| [CALL_FIX_PLAN.md](planning/CALL_FIX_PLAN.md) | The PR series (batches A–H, all merged) behind the 2026-07-30 call analysis |
| [LEGAL_HOLD_BACKSTOP_DESIGN.md](planning/LEGAL_HOLD_BACKSTOP_DESIGN.md) | Design only — technical backstop for the legal-hold items; nothing built |
| [MIGRATION_CHAIN_SQUASH_PLAN.md](planning/MIGRATION_CHAIN_SQUASH_PLAN.md) | Plan only — verdict: unsafe to squash the migration chain now |
| [RAILWAY_HEALTHCHECK_DECISION.md](planning/RAILWAY_HEALTHCHECK_DECISION.md) | Decision record: Railway `healthcheckPath` stays `/health`, not `/ready` |
| [SCHEDULER_C1_C2_PROPOSAL.md](planning/SCHEDULER_C1_C2_PROPOSAL.md) | Design proposal only — scheduler sub-view consolidation, awaiting Dale |

## Voice AI

| File                                                           | Purpose                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [VOICE_AGENT_PLAYBOOK.md](voice/VOICE_AGENT_PLAYBOOK.md)             | Authoritative rulebook for building customer voice scripts                      |
| [VOICE_DEADAIR_RESEARCH.md](voice/VOICE_DEADAIR_RESEARCH.md)         | Dead-air / latency research findings (mostly shipped)                           |
| [AIASSISTANT_PERSONA_DRAFT.md](voice/AIASSISTANT_PERSONA_DRAFT.md)   | Thinking Hammer persona + call-flow draft                                       |
| [aiassistant-knowledge-base.md](voice/aiassistant-knowledge-base.md) | Source content for the Thinking Hammer AI assistant KB                          |
| [FRAMEWORK_MIGRATIONS.md](voice/FRAMEWORK_MIGRATIONS.md)             | Voice-stack migration history (Vapi → LiveKit, Grok/OpenAI TTS → Deepgram Aura) |
| [CALL_ARCHITECTURE.md](voice/CALL_ARCHITECTURE.md)                   | The eight-phase shape every call has; which phases are platform guarantees vs per-tenant content |
| [RUNBOOK_QUESTION_TREES.md](voice/RUNBOOK_QUESTION_TREES.md)         | Rolling out database-driven per-tenant question trees |

## Onboarding & Operations

| File                                     | Purpose                                               |
| ---------------------------------------- | ----------------------------------------------------- |
| [BETA_ONBOARDING.md](operations/BETA_ONBOARDING.md) | First-day / first-week guide for new beta customers   |
| [OWNER_GUIDE.md](operations/OWNER_GUIDE.md)         | Plain-language guide to each dashboard tab for owners |
| [TICKET_SUPPORT.md](operations/TICKET_SUPPORT.md)   | Telnyx support ticket status and escalation           |

## Product & Strategy

| File                                                                           | Purpose                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [MISSION_STATEMENT.md](product/MISSION_STATEMENT.md)                                   | Product mission and goals                                                           |
| [STRATEGY.md](product/STRATEGY.md)                                                     | Product + competitive strategy (positioning)                                        |
| [COMPETITOR_WEAKPOINTS.md](product/COMPETITOR_WEAKPOINTS.md)                           | Competitor attack map                                                               |
| [SECRETARYHQ_FEATURES.md](product/SECRETARYHQ_FEATURES.md)                             | Organized capability outline with status legend                                     |
| [VERTICAL-PRESET-BLOCK-ARCHITECTURE.md](product/VERTICAL-PRESET-BLOCK-ARCHITECTURE.md) | Design for reusable block classes, business-type presets, and tenant-safe overrides |
| [DEPOSIT_COLLECTION.md](product/DEPOSIT_COLLECTION.md)                                 | Proposal only — Stripe Payment Link deposits; nothing built |
| [TCPA_SMS_CONSENT_COPY.md](product/TCPA_SMS_CONSENT_COPY.md)                           | SMS opt-in consent copy — Dale-approved, pending counsel review |

## Design

| File                                   | Purpose                                           |
| -------------------------------------- | ------------------------------------------------- |
| [DESIGN_HANDOFF.md](design/DESIGN_HANDOFF.md) | Visual brand system + design decisions (frozen)   |
| [UI_UX_DESIGN.md](design/UI_UX_DESIGN.md)     | Living design brief — interaction + UX principles |

## Workflow & Standards

| File                                                                 | Purpose                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| [DEVELOPMENT_WORKFLOW.md](workflow/DEVELOPMENT_WORKFLOW.md)                   | Repeatable dev process for this project                |
| [PORTABLE_DEVELOPMENT_WORKFLOW.md](workflow/PORTABLE_DEVELOPMENT_WORKFLOW.md) | Project-agnostic version of the workflow (copyable)    |
| [ADOPTING_THE_WORKFLOW.md](workflow/ADOPTING_THE_WORKFLOW.md)                 | How another project points at + adopts the workflow    |
| [CODING_STANDARDS.md](workflow/CODING_STANDARDS.md)                           | Naming conventions + code-style rules                  |
| [BRANCH_CHECKLIST.md](workflow/BRANCH_CHECKLIST.md)                           | Checklist for starting + finishing feature-branch work |
| [LESSONS_LEARNED.md](workflow/LESSONS_LEARNED.md)                             | Running log of hard-won debugging lessons              |
| [AGENTS.md](workflow/AGENTS.md)                                               | Agent-oriented codebase brief                          |

## Subfolders

- `architecture/` — core architecture + repo directory map
- `planning/` — one backlog (TODO + RESOLVED), roadmap, test audits
- `voice/` — playbook, question-tree arch, migrations, superseded call designs
- `product/` — mission, strategy, features, competitor map
- `design/` — UX principles, handoff, diagrams
- `workflow/` — dev workflow, standards, branch checklist, agents brief
- `operations/` — deploy, runbook, security, onboarding, tickets
- `legaldocs/` — consent/privacy + LLC setup
- `calls/` — archived prod call transcripts (evidence, not behaviour)
- `diagrams/` — Mermaid `.mmd` diagram sources
- `superpowers/` — per-feature specs + plans (see specs/ and plans/)
- `mockups/` — UI mockups (if present)

## Archived / Historical

Completed phases, the historical bug tracker (formerly `BUGS.md`), the product plan (formerly `PLAN.md`), per-session journals (formerly `sessions/`), and the long-form status archive (formerly `CURRENT_STATUS_ARCHIVED_2026-05-15.md`) have all been **consolidated into [RESOLVED.md](planning/RESOLVED.md)**. Those standalone files no longer exist.

### Superseded call architectures — kept, but NOT how calls work today

The call flow has been rebuilt twice. These docs describe the earlier designs and each
carries a banner saying so. They are retained because the **bugs** they catalogue are real
and the current design's guards exist because of them — read them for evidence, not for
behaviour.

| File                                                         | Describes                                                           | Status                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [BUILDING_SCRIPT_NOTES.md](voice/BUILDING_SCRIPT_NOTES.md)         | TaskGroup "rungs" (`agent/src/tasks/`)                              | Superseded 2026-07-21 · fallback behind `ENABLE_TASK_GROUP`                                     |
| [CALL_LADDER.md](voice/CALL_LADDER.md)                             | The prompt ladder — generated from `src/services/scripts/blocks.ts` | Superseded · fallback when both flags are off. Editing a rung changes nothing about a live call |
| [VOICE_DEADAIR_RESEARCH.md](voice/VOICE_DEADAIR_RESEARCH.md)       | Working around non-streaming OpenAI TTS                             | Core premise moot — TTS is Deepgram Aura (streaming) since 2026-07-14                           |
| [AIASSISTANT_PERSONA_DRAFT.md](voice/AIASSISTANT_PERSONA_DRAFT.md) | 2026-06-10 persona + call-flow brief                                | Stale; persona is `Piper`, flow is question trees                                               |

**The live architecture is [QUESTION_TREE_ARCHITECTURE.md](voice/QUESTION_TREE_ARCHITECTURE.md).**

---

**Last updated:** 2026-09-18 (index gap-fill: planning/voice/product/operations/architecture docs that existed but were unlisted; before that 2026-09-04 — docs reorganized: flat *.md moved into architecture/, planning/, voice/, product/, design/, workflow/, operations/; all internal links + tables + subfolder summary updated; DIRECTORY_STRUCTURE.md reflects new layout. Prior syncs as noted.)
