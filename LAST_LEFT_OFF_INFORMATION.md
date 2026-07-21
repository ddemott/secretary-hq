# LAST LEFT OFF — branch `feat/usage-billing-statement`

> Branch-local worklist. **Delete this file before this branch's PR merges.**
> Written 2026-07-21 when work paused to pivot to the question-tree architecture
> (branch `feat/question-tree-architecture`; rung-era rollback anchor: branch
> `rung-architecture` = main @ `909c8f2`).

## What is on this branch (one WIP commit, two strands)

### Strand 1 — Usage-billing statement ("no paper")

The online monthly statement: answered-call metering + pack-overage math, computed
live from `voice_sessions`. Decision record for the model (answered call ≥15s +
caller spoke = the billing unit; flat tiers + auto-applied packs; NEVER cut service
on quota) is in `docs/TODO.md` — landed there in this same diff.

- `src/services/billingUsage.ts` (NEW) — `computeUsageStatements(pool, tenantId, months)`
- `tests/routes/billing-usage.test.ts` (NEW)
- `src/routes/billing.ts` — `GET /billing/usage` (months clamped 1–24, default 6)
- `dashboard/lib/api.ts` — `Api.billing.usage()`; `dashboard/lib/types.ts` —
  `UsageStatementResult` / `MonthlyStatement`
- `dashboard/components/BillingView.tsx` (+test) — statement table on the Billing page
- `dashboard/components/AnalyticsView.tsx` (+test) — `AiUsageCard` REMOVED from
  Analytics (file deleted; AI-cost view superseded by the Billing statement;
  `Api.analytics.getAiCost` removed)

**State:** written same-session as the 2026-07-20 overage-model decision. Backend +
dashboard tests were written alongside; NOT verified green since — run
`npm test tests/routes/billing-usage.test.ts` and `cd dashboard && npm test` first.
**Not built (deliberate):** Stripe pack-charging — the endpoint is informational
until then. No migration involved (reads existing `voice_sessions` + `tenants.plan`).

### Strand 2 — Staged agent fixes from the 2026-07-21 Camille test calls (3 calls, +1 262-497-9039)

Defect log: `docs/TODO.md` § "Call-review defects — 2026-07-21". Items marked
**[staged]** there are fixed HERE and only need this branch deployed:

- `agent/src/tools.ts` — **`standing_fact`** pinned into every successful booking
  result (fix for call 1's P0: model booked 3:00, forgot it during long intake,
  denied the booking, double-booked 3:30). Unit-tested in `agent/src/tools.test.ts`.
- `agent/src/prompt.ts` — never RECITE caller-ID digits (ask "is the number you're
  calling from good?"); returning caller → "Is this {name}?" confirm + message
  attribution question; spoken numbers written digit-by-digit 3-3-4 no "+1".
- `src/services/scripts/blocks.ts` — IDENTITY: one read-back one yes, disputed
  caller-ID dropped fresh; CLOSE/LADDER_HEADER: "anything else?" allowed ONLY at
  RUNG 6 top.
- `agent/scripts/sim-toolselect.ts` — replay eval: "booking survives a long intake"
  (maxToolCalls + forbiddenSpeech graders). Was 15/15 incl. new case when written.
- `docs/CALL_LADDER.md` — updated to match.

**⚠️ These prompt fixes address live-call defects on the CURRENT prod ladder. If the
question-tree work runs long, consider cherry-picking strand 2 out and shipping it
alone — the defects recur on every real call until deployed.**

## To resume this branch

1. `git checkout feat/usage-billing-statement`
2. Run the test suites above; fix anything red (written-but-unverified risk).
3. Decide: split the two strands into separate PRs, or ship as one.
4. Delete this file, open the PR, green CI, Dale merges.

## Context of the pause

Dale redirected 2026-07-21: replace the rung/ladder systems with the QUESTION TREE
architecture (checklist-of-questions trees, purpose-selected, host-tracked,
free-form collection + always-on RAG). Design doc lives on
`feat/question-tree-architecture` in `docs/QUESTION_TREE_ARCHITECTURE.md`.
LoginView one-click prefill (2026-07-20 design session) was REVERTED before this
commit, per the standing rule.
