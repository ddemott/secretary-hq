# Deployment checklist

**What this is:** the sequence to follow from "the work is done" to "it is
actually running in production", plus the three ways this repo has silently
failed to deploy. Reference doc, not a backlog — see `docs/planning/TODO.md` for work.

**Why it exists:** every step here is written from a failure that happened.
Nothing below is precautionary.

Related: `docs/operations/DEPLOYMENT.md` (env vars, Railway service setup),
`docs/workflow/BRANCH_CHECKLIST.md` (per-branch hygiene), `docs/operations/RUNBOOK.md` (incidents),
`docs/operations/ALERTS.md` (what pages you afterwards).

---

## 0. The three gotchas, first, because they are the ones that bite

### Gotcha 1 — a red `main` run makes the deploy SKIPPED, and SKIPPED is terminal

Railway's "Wait for CI" is enabled on all three services. When the `main` run for
a commit fails, Railway marks that commit's deployments **SKIPPED**. Turning CI
green afterwards does **not** retry: the skipped deployments report
`canRedeploy: false`. Production then sits on the previous build while every
service reports healthy — indistinguishable from a successful deploy.

Not hypothetical: 21ea335 (#298) merged green, the `main` re-run of E2E failed on
a Docker Hub outage (`docker pull ankane/pgvector` → `context deadline
exceeded`, no test ever ran), and all three services skipped.

**Consequence for how you work:** flaky tests are not a hygiene problem here,
they are an availability problem. Four wall-clock flakes have reddened CI to
date (`docs/planning/RESOLVED.md` → "Flaky gates that blocked prod deploys"). Recovery when it happens: re-run the failed
job, confirm green, then trigger the deploy **explicitly** —
`serviceInstanceDeployV2(serviceId, environmentId, commitSha)` against
`https://backboard.railway.com/graphql/v2` for each of the three service ids, or
press Deploy in the Railway UI.

### Gotcha 2 — "Wait for CI" is unversioned

The toggle lives in Railway's UI, not in this repo. Nothing in a diff tells you
it changed, and nothing fails if someone turns it off — deploys simply stop
waiting for tests. Verified enabled on all three services 2026-07-27 via the
Railway GraphQL API (`checkSuites: true` on every deployment trigger). Re-check
it when deploy behaviour surprises you; it is not covered by any test.

### Gotcha 3 — migration order is NOT always "migration first"

The house rule is: apply prod DB migrations **before** merging the code that
uses them. That is right for an **additive** migration which is inert until new
code reads it.

It is **wrong** when the migration relaxes a constraint that RUNNING code is
already violating. Migration `20260819000000` widened a CHECK that live code was
already tripping on every tick. Applying it first would have turned a loud,
harmless, total outage (nothing written at all) into a **silent leak that
damaged rows** — the claim would start succeeding, and the old code would strand
every claimed row where nothing could recover it.

**The question to ask, every time:** _is any code already in production emitting
the value this migration would newly permit?_ If yes, ship the code first, then
the migration.

---

## 1. Before you open the PR

- [ ] `npm run checks` (format + lint + typecheck) passes.
- [ ] Full suites pass locally: `npm test`, `cd agent && npx vitest run`,
      `cd dashboard && npx vitest run`.
- [ ] `npm run verify:claude-md` — no doc drift.
- [ ] `npm run scan:secrets` — no plaintext credentials.
- [ ] `npm run verify:schema` if a migration was added, and
      `npm run db:baseline` to refresh the snapshot.
- [ ] **If a test asserts real I/O** (a DB round-trip, a subprocess, a rendered
      async component), it carries an explicit timeout sized to that work. The
      vitest default is 5s and four separate tests have now missed it on a
      loaded runner. See the "Flaky gates that blocked prod deploys" section of `docs/planning/RESOLVED.md`.
- [ ] If the local DB behaves oddly, suspect its migration state before
      suspecting the code: `schema_migrations` can list migrations as applied
      whose data statements never ran (a `--baseline` adoption after a
      `baseline.sql` restore). Rebuild the way CI does — `scripts/setup-db.sh`,
      then `scripts/seed-db.sh`, then `npm run trees:seed`.

## 2. On the PR

- [ ] All four CI jobs green: Backend, Dashboard, Agent, E2E.
- [ ] `Pre-merge checks` green (doc drift + secret scan).
- [ ] Every review thread resolved — branch protection requires it, and an
      unresolved thread blocks the merge button with `mergeStateStatus: BLOCKED`
      even when every check is passing.
- [ ] Roadmap status set to 🟡 IN_PROGRESS, not ✅. Per
      `docs/planning/PRODUCT_ROADMAP.md` §0.7, DONE means merged to `main`; a PR
      claiming DONE is claiming a merge that has not happened.

## 3. Migration ordering (if the PR has one)

Decide which case you are in — see Gotcha 3 above.

Prod migrations are manual. A PR that adds a file under `supabase/migrations/` gets an automatic, non-blocking "Migration reminder" comment from the `Pre-merge checks` workflow — it is a nudge, not a gate.

**Additive migration** (new table/column nothing reads yet):

1. `DATABASE_URL="$PROD" bash scripts/setup-db.sh`
2. Merge the PR.

**Constraint-relaxing migration** (running code already emits the new value):

1. Merge the PR.
2. Confirm the deploy actually landed (§4) — not just that the merge happened.
3. `DATABASE_URL="$PROD" bash scripts/setup-db.sh`

> Pass the URL as an **environment variable**, never as an npm argument. `npm run
db:migrate -- "$PROD"` echoes the argument, which has printed the production
> password into a session transcript twice.

## 4. After the merge — verify the deploy HAPPENED

The merge is not the deploy. Check, do not assume:

- [ ] The `main` CI run for the squashed commit is **green**. If it is red, the
      deploys are SKIPPED and terminal — go to Gotcha 1.
- [ ] `curl -s https://secretary-hq-production.up.railway.app/health` — the
      `started_at` timestamp **moved**. This is the single decisive check: an
      unchanged `started_at` with a green `status: ok` is exactly what a skipped
      deploy looks like.
- [ ] `npm run status -- --env prod --deep` — backend `/health` + `/ready`,
      dashboard, and an actual LiveKit dispatch to the agent worker.
- [ ] Normal lag between green CI and a moved `started_at` is ~3-6 minutes. Do
      not declare the trigger broken before that.

## 5. After the deploy — verify the CHANGE, not just the process

- [ ] Exercise the thing you shipped against prod, at the cheapest honest level:
      an unauthenticated `curl` proving a route is gated, a `/metrics` scrape
      proving a new series exists, a dashboard page load.
- [ ] Say plainly which parts you verified and which are covered only by tests.
      "Deployed" is not "confirmed working", and a probe you did not run is not
      evidence.
- [ ] Update `docs/planning/PRODUCT_ROADMAP.md` — a task is ✅ DONE only now.
- [ ] Watch `errors_total` and the §3.10-3.12 rules in `docs/operations/ALERTS.md` for the
      first few minutes if the change touched the call path, reminders, or
      webhooks.

## 6. Rollback

- Railway keeps previous deployments; redeploy the prior commit from the UI.
- A migration is not automatically reversible. Before applying one to prod, know
  what undoing it looks like — for a constraint change that is usually a
  compensating migration, not a `DOWN`.
- Feature flags are the cheaper rollback where one exists
  (`ENABLE_QUESTION_TREE`, `ENABLE_SMS`, `AURA_TTS_STREAMING`,
  `ENABLE_OUTPUT_WATCHDOG`). Flipping an env var on Railway beats a revert PR.
