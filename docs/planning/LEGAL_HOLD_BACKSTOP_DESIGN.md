# Legal-hold technical backstop — design (not implemented)

**Status: design only.** Nothing in this document ships until Dale picks a
direction and a follow-up ticket builds it. No code changes accompany this
doc.

**Revised after adversarial review (Roady, 2026-09-15).** The first draft
claimed a CI check would be "enforced" without checking whether it would
actually be a *required* status check. It would not have been — verified
live against `gh api repos/ddemott/secretary-hq/branches/main/protection`:
today's required checks are exactly the 4 CI jobs (Backend, Dashboard, Agent,
E2E), the "Doc drift + secret scan" job this design wanted to piggyback on is
**not** among them, and `required_approving_review_count` is **0** — no human
reviewer is gated on `main` at all. That review also caught an overstated
factual claim, an incomplete PII table list relative to the product's own
stated erasure scope, and a likely day-one false positive in the
migration-scanning trigger. All four are fixed below; the corrections are
folded into the design rather than kept as a separate errata section, because
a design doc with a known-wrong claim left standing is exactly the kind of
prose-that-isn't-enforced this whole effort exists to stop producing.

## The gap (Roady, 2026-09-15 audit)

PR #68 (`POST /customers/:id/purge`) and PR #69 (retention worker) are
correctly kill-switched off (`ENABLE_CUSTOMER_PURGE`, `ENABLE_RETENTION_WORKER`
+ explicit `RETENTION_DAYS`; see `docs/planning/TODO.md` → 🟠 Legal-hold) and
are blocked on Dale + legal sign-off before either can merge or be enabled.

That is a real control on those two specific PRs. It is **not** a control on
the *capability*. Nothing stops a future session — human or agent, this one
included — from writing a **new** route, worker, or SQL function that does
the same irreversible customer/appointment/voice-session erasure under a
different name (`POST /gdpr/forget`, `anonymizeCustomer()`, a cron job called
`dataCleanup`, a migration-defined SQL function), with **no** `ENABLE_*` flag
at all, because the gate is textual — three docs (CLAUDE.md, TODO.md, the two
PR descriptions) saying "don't build this without sign-off" — and text is not
enforced by anything that runs. A session that never reads those three docs,
or reads them and decides its route is different enough not to count, ships
straight past the boundary the org believes exists.

This doc designs a **real, executable** backstop for that specific gap:
*reimplementing PII erasure under a new name bypasses the two named kill
switches entirely.* It does not re-litigate whether PR #68/#69 themselves
should ship — that decision stays exactly where it is, blocked on Dale +
legal.

## Threat model, precisely

What the backstop must catch:

1. A **new HTTP route** whose handler deletes or irreversibly overwrites rows
   in a PII table, reachable from the API surface, not gated by an
   `ENABLE_*` flag that defaults false.
2. A **new worker/scheduled job** (anything under `src/workers/`, or a new
   service invoked by one) that does the same on a timer, unconditionally or
   gated by a flag nobody logged as legal-hold.
3. A **new SQL function** (via a migration) that does bulk erasure at the DB
   layer, invisible to anyone reading only `src/`.

What it deliberately does **not** try to catch (scoped out, stated up front
so the design isn't sold as more than it is):

- **Manual, human-operated maintenance scripts under `scripts/`.**
  `scripts/purge-soft-deleted.ts` already hard-deletes `tenants` (cascading to
  every customer/appointment/voice_session under that tenant) and is a
  legitimate, shipped tool — dry-run by default, requires `--execute --yes`,
  requires a human with prod DB credentials to type a command. That is a
  different risk category from "a route merges and Railway deploys it to
  every caller automatically." Flagging every hard-delete-capable maintenance
  script would be noisy (the tenant-purge script exists precisely because
  destruction sometimes has to be possible) without closing a real gap — the
  actual control there is prod DB access + the script's own dry-run/--execute
  ergonomics, not CI. This is a conscious scope line, not an oversight;
  revisit if `scripts/` ever becomes a realistic route for scope-creeping
  customer-level erasure rather than tenant-closure cleanup.
- Someone with a live `psql` session against prod running ad hoc SQL. No
  static analysis of the checked-in repo reaches that. The backstop protects
  the **code path**, not an operator who already holds prod credentials.
- Deliberate obfuscation (string-built table names, a query builder that
  never spells `DELETE FROM customers` literally, decomposing a bulk erasure
  across several innocuous-looking commits so no single diff trips the
  heuristic). Static grep-based analysis is not proof against a determined
  bypass; it raises the bar and creates an audit trail, it does not make the
  gap unreachable. Same honesty standard this repo already applies to
  `presetCatalog.test.ts`'s `deliberatelyUnreachable` allowlist and
  `scan-secrets.ts`.

## Options considered

### A. CI static-analysis grep + explicit allowlist (recommended)

A new script (e.g. `scripts/scan-pii-erasure.ts`) that scans `src/` and
`supabase/migrations/*.sql` on every PR for the erasure *shape* described
below, and fails the build unless every match is pre-declared in a checked-in
allowlist file that a human had to type.

**Why this shape specifically, and not a plain keyword grep:** a plain
`grep -i purge` produces too many false positives (`purge-soft-deleted.ts`
itself, code comments, `PLAN ONLY` migration-squash docs) and too many false
negatives (nothing stops `anonymizeCustomer` or `dataCleanup`, which say
nothing about purging). The check needs to key on **what the code does**
(bulk-shaped writes against a fixed list of PII tables), not what it's named,
with the vocabulary match as a secondary, cheaper signal layered on top.

Detection, three independent triggers (any one fires a fail):

1. **Vocabulary match on new route/worker/function names or paths** —
   `/purge|erase|anonymiz|redact|forget|gdpr|ccpa|retention/i` against a
   newly-added Fastify route path/handler name, or a new file under
   `src/workers/` or `src/routes/`. Cheap, catches the obvious case, and is
   the same "route path decides what's reachable" logic already used
   throughout this codebase's checklist-preset reasoning.
2. **Bulk-shape match against a shared PII-table list** — a single source of
   truth (`scripts/piiTables.ts`, exporting `PII_TABLES = ['customers',
   'appointments', 'voice_sessions', 'customer_messages', 'job_inquiries',
   'phone_verifications', 'consent_records', 'opt_out_records',
   'communications_history', 'intake_submissions', 'call_transcripts',
   'call_summaries', 'customer_preferences']`, same "one list, byte-for
   -byte agreed" instinct as `shared/checklistPresetDerivation.ts`). The
   first-draft list omitted `call_transcripts`/`call_summaries`/
   `customer_preferences` — caught on review: `docs/planning/TODO.md`'s own
   description of PR #69 names "voice_sessions/transcripts/appointment
   descriptions" as in-scope, and PR #68's own description says it does
   "atomic anonymize-in-place **+ audit_log PII redact**" — the worked
   example the design is built around touches a table its first draft didn't
   watch. A match fires when a function body contains a `DELETE FROM
   <pii_table>` or `UPDATE <pii_table> SET ... = NULL` **that is not a
   single-row, parameterized, tenant-scoped WHERE** (i.e. lacks the
   `WHERE <pk> = $n AND tenant_id = $m` shape), **or** touches 2+ distinct PII
   tables in one function body regardless of WHERE shape (a purge/anonymize
   operation is definitionally cross-table). This is the trigger that catches
   a differently-named retention worker or purge route that a keyword grep
   would miss entirely.
   **Deliberate gap in this trigger, not caught on the first draft:**
   `audit_log` and `record_versions` are polymorphic (`table_name` /
   `record_id` / `data` jsonb, one row can be *any* tracked table's history).
   `DELETE FROM record_versions WHERE record_id = $1` is textually
   indistinguishable from deleting one version row of a wholly unrelated,
   non-PII table — the single-row-parameterized carve-out would wave a full
   purge of a customer's version/audit history straight through. No shape
   -based fix is proposed here; it is named as a known blind spot the
   follow-up ticket must either accept explicitly or solve (e.g. a
   `table_name = 'customers'` literal alongside the delete would need its own
   sub-pattern).
3. **New SQL function in a migration** containing the same bulk-shape pattern
   against the same table list — closes the "do it at the DB layer, not in
   TypeScript" bypass of triggers 1–2. **This trigger is NOT proven clean
   against the existing 203 migrations** (unlike triggers 1–2, which were
   dry-run-checked against `src/` before this doc's first draft — see
   correction below). A targeted check found a likely day-one false
   positive: `supabase/migrations/20260801000000_customer_messages_one_per_
   call.sql` runs `DELETE FROM customer_messages cm USING ranked r WHERE
   cm.message_id = r.message_id AND r.rn > 1` — a legitimate dedupe against a
   listed PII table, cross-tenant in one statement, with no `tenant_id =`
   literal in the DELETE's own WHERE. Migrations also have no `$n` bind
   parameters at all (they're static SQL), so the "parameterized" half of the
   trigger-2 carve-out doesn't transfer to migrations as written and needs
   its own definition (e.g. a literal single-value `WHERE <pk> = '<uuid>'` or
   a scoped CTE keyed by one row, vs. a `USING`/join-based multi-row delete).
   **Before this trigger ships, the follow-up ticket must run it against all
   203 existing migrations and pre-seed the allowlist with every legitimate
   hit found** (this one confirmed, there may be others) — shipping it
   "clean" without that pass would break the first PR that touches an
   unrelated migration file in the same directory, or worse, get quietly
   disabled the first time it cries wolf.
4. **PII-table-list drift tripwire** — added on review, not in the first
   draft. `PII_TABLES` is itself a hand-maintained enumeration, and this
   codebase has already been burned by that shape of list rotting silently
   more than once (`verify-claude-md.ts`'s route-count regex missed its own
   drift for weeks; the preset-catalog CHECK constraint fell behind its own
   code for a shipped preset until `presetCatalogConstraint.test.ts` was
   added). A new migration that adds a column named `customer_id`, `phone`,
   `email`, or `raw_text`/`transcript`/`summary` to a table **not** already in
   `PII_TABLES` or a small explicit `NOT_PII` allowlist should fail CI too —
   otherwise `PII_TABLES` degrades the same way it already had, silently,
   before this review caught it once by hand.

**Escape hatch, modeled on `presetCatalog.test.ts`'s `deliberatelyUnreachable`
set:** a checked-in allowlist file (`scripts/piiErasureAllowlist.ts`) listing
`{ file, functionOrRouteName, reason, flagEnvVar }` entries. A match not in
the allowlist fails CI with a message pointing at this doc and at
`docs/planning/TODO.md` → Legal-hold. Adding an entry is "a decision someone
must type," same as moving a tree into `deliberatelyUnreachable` — and a
companion assertion (a small test alongside the scanner) checks that every
allowlisted entry's `flagEnvVar` actually exists as a `process.env.<FLAG>`
guard in that same file, defaulting to a falsy/off value — so the allowlist
can't be satisfied by a comment alone, it has to point at a real, off-by
-default kill switch. **Strengthening beyond `deliberatelyUnreachable`:** the
allowlist entry also stores a hash of the matched statement text. Any edit to
an already-allowlisted erasure function (e.g. PR #68's purge route quietly
widened to also touch `voice_sessions`) changes the hash, invalidates the
entry, and re-fails CI — allowlisting once must not be a permanent exemption
for that code forever.

**Where it runs, and the correction that matters most in this whole doc:**
the first draft said this would run "alongside `verify:claude-md` and
`scan-secrets.ts`" in `pre-merge-checks.yml` and called that "a required
check." **That was wrong, and checkable — it was not checked before writing
it.** Verified live on review:

```
gh api repos/ddemott/secretary-hq/branches/main/protection
  → required_status_checks.contexts = [Backend, Dashboard, Agent, E2E]  (the 4 CI jobs only)
  → required_approving_review_count = 0
```

`pre-merge-checks.yml`'s own job — the one running `verify:claude-md` and
`scan-secrets.ts` today — is **not** in that list. A red result there does
not block the merge button. So the two precedents this design leaned on for
credibility are themselves advisory, not enforced, and a PII-erasure scanner
added the same way would inherit exactly that weakness — which is precisely
the "moves the boundary somewhere equally proseable" failure mode the review
was asked to check for. Two changes follow from this, and both are now
**mandatory implementation steps, not optional hardening**:

1. Add whichever job hosts the new scanner (either `pre-merge-checks.yml`'s
   existing job, or a new one) to `required_status_checks.contexts` in the
   branch-protection settings, alongside the 4 CI jobs — a one-time GitHub
   settings change, not code, but load-bearing enough that skipping it makes
   the rest of this design theater.
2. Given `required_approving_review_count = 0`, the same session that writes
   a new erasure route can also write its own `piiErasureAllowlist.ts` entry
   and merge once CI is green, with zero independent human gate. At minimum,
   add a CODEOWNERS entry requiring a specific human (Dale) to approve any
   diff that touches `scripts/piiErasureAllowlist.ts` — narrower than
   requiring review on every PR (which this repo has not chosen to do
   generally), but the one file in this design where self-approval defeats
   the entire point.

**Pros:** fits an existing, proven pattern in this exact codebase (three
precedents: `presetCatalog.test.ts`'s reachability allowlist,
`verify-claude-md.ts`'s drift detector, `scan-secrets.ts`'s pre-merge scan) —
provided the required-check gap above is closed rather than inherited. Fast,
no infra, reviewable in a normal PR diff, and the failure message can name
the exact doc a future session needs to read before proceeding — turning
"three docs of prose" into "a build failure that cites the three docs of
prose," which is a categorically different thing, once it is actually a
required check.

**Cons:** static analysis, defeatable by a determined obfuscation (see threat
model exclusions above); heuristic, not a proof; only fires in CI, so a
branch-protection regression or a direct push to `main` (both already outside
this repo's normal path, per CLAUDE.md's branch-protection section) would
skip it same as any other CI gate. And — until the two mandatory steps above
land — this option provides **zero enforced backstop**, not "one enforced
layer plus a documented escalation tier." That sequencing gap should be
named to Dale explicitly rather than assumed away: between "this design is
approved" and "the required-check + CODEOWNERS steps are actually applied in
GitHub settings," the org has exactly the same textual-only boundary it has
today.

### B. DB-level rule/trigger refusing hard-deletes on PII tables outside a flagged transaction

A Postgres `BEFORE DELETE` rule/trigger on each PII table that raises unless
a session-local GUC (e.g. `app.legal_hold_override`) is set to a value that
only the two legal-hold-approved code paths ever set, inside their own
transaction, immediately before the delete.

**Pros:** enforced at the layer that actually destroys data — catches
literally any code path, including ones this design's static analysis
can't anticipate (a raw migration, a future ORM, a different repo entirely
connecting to the same DB with valid credentials). Real defense in depth,
not just a build-time lint.

**Cons, why not recommended as the first move:**

- **Heavier and more invasive than the problem currently warrants.** This
  repo's own Build Principles say "build for real customers, not the
  imagined Pro tier" and "test it or delete it" — there is no live GDPR/CCPA
  erasure request today (both erasure PRs are inert), and a DB trigger this
  load-bearing needs its own migration, its own test suite proving it
  doesn't false-positive against **every legitimate delete already in this
  schema** (appointment cancellation, `DELETE /tenants/:id`'s soft-delete
  path, `service_employee`/`service_resource` unlink-on-service-delete, the
  entire `purge-soft-deleted.ts` tenant-cascade path which is a *real*,
  *intentional* hard delete that would need its own override), and a rollback
  story if it ever misfires in prod and blocks a legitimate delete under
  load. That is a multi-day migration-and-test project, not a design-doc
  follow-up.
- **It doesn't obviously close the gap better, given who the threat actor
  is.** Roady's finding is about *code getting written and merged* without
  the kill switch — a CI check stops that at PR time, before it ever reaches
  a database that could enforce anything. A DB trigger only matters once code
  bypassing the CI check has *already* been merged and deployed; it's a
  second line behind option A, not a replacement for it.
- **It reintroduces the exact override-plumbing risk this codebase has
  already been burned by twice** (the `admin_bypass` RLS policies'
  `current_setting(...) = ''` NULL-on-cold-connection landmine, and the
  `clearTenantContext()` empty-string-vs-NULL mismatch — both documented in
  `docs/operations/SECURITY.md`). A session-local override GUC for "this
  transaction is allowed to hard-delete PII" is precisely the kind of
  connection-pool-state footgun that class of bug lives in. Building it
  requires the same rigor CLAUDE.md already demands of RLS context handling,
  and that rigor is worth spending only once the CI-layer control is proven
  insufficient.

**Verdict:** worth keeping as the documented **escalation path** — if the CI
check is ever bypassed in practice, or if a real erasure request arrives
before PR #68/#69 clear legal sign-off, this is the next tier to build — but
not the first thing to ship.

### C. Combination (not proposed as a single ticket)

Ship A now; keep B written down (this section) as the pre-scoped next step if
A is ever shown insufficient. Not a third option so much as the sequencing
decision this document is making explicit.

## Recommendation

**Option A — the CI static-analysis grep + explicit, hash-pinned allowlist,
wired as a required check with CODEOWNERS on the allowlist file.** It
matches this codebase's existing enforcement idiom
(`presetCatalog.test.ts`, `verify-claude-md.ts`, `scan-secrets.ts`) and is
buildable in a single small PR. On the dry-run claim: the two `DELETE FROM`
calls checked by name in this doc (`appointments.ts:336`, `users.ts:190`)
are confirmed single-row and parameterized and would not trip trigger 2. The
first draft over-generalized this to "every other existing `DELETE FROM` in
`src/`" — false as stated; counterexamples exist
(`tenants.ts:569,573`, `setupGraph.ts:369,373`, `crmDisconnect.ts:41,44` are
all tenant-scoped **bulk** deletes, not single-row). None of those
counterexamples touch a table on the `PII_TABLES` list, so the practical
"reports zero matches on `src/` today" conclusion still likely holds — but
that has to be re-verified by an actual dry run in the follow-up ticket, not
asserted from a claim this draft already got wrong once. Trigger 3
(migrations) is **not** claimed clean — see the correction above; it needs
its own dry run against all 203 migrations and at least one pre-seeded
allowlist entry before it ships. Option B is documented as the deliberate
next escalation, not built now, because there is no live erasure request to
justify its migration-and-test cost yet, and because this codebase's own
RLS-context history is a direct warning about how much rigor a DB-layer
override mechanism demands before it's trustworthy.

## Rough implementation scope (for the follow-up ticket, not this one)

- `scripts/piiTables.ts` — the shared table-name constant, including the 3
  tables added on review (`call_transcripts`, `call_summaries`,
  `customer_preferences`) (~15 lines).
- `scripts/piiErasureAllowlist.ts` — the checked-in allowlist, pre-seeded
  with whatever legitimate migrations trigger 3's dry run finds (at least
  the `20260801000000_customer_messages_one_per_call.sql` dedupe delete
  identified above), not empty at ship time as the first draft assumed
  (~15–30 lines depending on dry-run findings).
- `scripts/scan-pii-erasure.ts` — the four detectors (vocabulary, bulk-shape,
  migration bulk-shape, `PII_TABLES`-drift) + allowlist/hash check +
  CI-friendly exit code and message. Estimate ~180–250 lines, comparable to
  `scripts/scan-secrets.ts`.
- A small self-test (e.g. `scripts/scan-pii-erasure.test.ts` or a fixture
  directory) proving the scanner (a) flags a synthetic new route matching
  the erasure shape, (b) flags a synthetic bulk cross-table delete with no
  allowlist entry, (c) passes clean on the current tree — **actually run**,
  not asserted, including trigger 3 against all 203 migrations, (d) fails
  when an allowlisted function's hash no longer matches its source, (e)
  flags a synthetic new PII-shaped column on a table not in `PII_TABLES`.
  ~100–140 lines.
- One new step in `.github/workflows/pre-merge-checks.yml`, mirroring the
  existing `verify:claude-md` / `scan-secrets.ts` steps (`always() &&
  steps.<prev>.conclusion != 'cancelled'` so both new and existing checks
  report independently in one PR round-trip).
- **Two GitHub-settings changes, not code, both mandatory per the
  enforcement-gap correction above:** (1) add the hosting job to
  `required_status_checks.contexts` on the `main` branch-protection rule;
  (2) a `CODEOWNERS` entry requiring Dale's approval on any diff touching
  `scripts/piiErasureAllowlist.ts`. Skipping either leaves this design at
  "advisory," not "enforced."
- Optional but recommended given the seriousness of the surface: a
  notification (Slack/email/whatever channel Dale already watches) on any
  PR diff to `scripts/piiErasureAllowlist.ts`, so an allowlist addition is
  seen even by someone not actively reviewing that PR.
- Total: a single small PR + two settings changes, no DB migration, no
  runtime behavior change — CI-only, same class of change as this PR.

## Explicit boundary

This document is a design. Nothing here is implemented. The follow-up
ticket that builds `scripts/scan-pii-erasure.ts` is separate work, to be
scoped once Dale confirms Option A is the direction — including the two
GitHub-settings changes above, without which the built script would be
advisory only.

**Nothing in this document, and nothing in the review that shaped it,
approves PR #68, PR #69, or any PII-erasure capability as ready to merge or
enable.** That stays exactly where it is: blocked on Dale + legal sign-off,
independent of whether or when this backstop is built.
