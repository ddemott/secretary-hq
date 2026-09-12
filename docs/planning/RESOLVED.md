# SecretaryHQ — Resolved Issues Archive

Historical session journals, completed phases, and resolved bug logs. Moved out of `CLAUDE.md` on 2026-05-05 to keep the always-loaded context lean. Newest first.

---

## 2026-09-11 — "The owner" is said as Dale everywhere, and the booking RPC stops booking the past, nobody, or the wrong room

**"The owner" in the PROMPT was a request; the voice path is now a guarantee.** Dale:
_"I am the owner but do not refer to statements like 'I will pass this on to the
owner'. People don't know what that means."_ The 2026-09-09 prompt rule did not reach
the phrase's other sources — `tenant_question_nodes` wording ("a meeting on the owner's
calendar"), backend tool results relayed nearly verbatim ("Message saved — the owner
has been alerted."), and the model's habit. `speechSanitizer.ts` now rewrites "the
owner" / "the business owner" to the one active staff member's first name in
`ttsNode`, and `transcriptionNode` applies the same rewrite so the call record matches
what the caller heard. Deliberately narrow: never "the owner of …", never after "are
you / is / I'm …", never "the owners" / "homeowners"; with several staff (or none) the
phrase is left alone. Verified: 19 of 19 occurrences across three sets of
`sim-questiontree` transcripts came out as "Dale".

**Migration `20260909210000` — three rules `book_with_scheduling_atomic` did not
enforce.** (1) No booking in the past (`PAST_TIME`, one minute of grace) — the item
closed above as "still open". (2) Never an appointment with no person. (3) When the
service is known, the skill map's `service_employee` / `service_resource` links are the
whole rule, and an unlinked service is refused — Dale: _"Person → Role → Resource."_
`availabilitySearch.ts`, the available-slots date path, and the appointments conflict
suggestions read the same map. Guarded by `bookingRulesPastAndPerson.realdb.test.ts`
and `skillMapLinks.realdb.test.ts`. Prod precondition checked read-only before apply:
every Thinking Hammer service has a linked person and room; the only unlinked services
belong to the platform super-admin tenant, which has no shifts and has never taken a
call.

**Also fixed:** three `console.error('DEBUG …')` lines in `checklistTools.ts` that had
printed on every live call since August; e2e fixtures for the new rules; two
calendar-sync spec bugs hidden because that spec does not run in CI; and the simulator
itself, which told the model the wrong weekday, spoke "right now it is undefined", gave
every caller a phantom Thursday 2 PM booking, and booked a day the caller was never
offered. `sim-questiontree` can now move the CALLER off OpenAI too
(`SIM_CALLER_BASE_URL` / `SIM_CALLER_API_KEY`).

**`set_purpose` with no `trees` threw a TypeError — on live calls too, not only in the
sim.** A JOB-DIRECT run crashed with `Cannot read properties of undefined (reading
'includes')`, and the sim filed it as "API error after retries", so it was never
counted. The cause is structural: `set_purpose` declares `trees` as `required` in a plain
JSON schema, and LiveKit (`voice/generation.js`) validates arguments only for ZOD
schemas — a JSON-schema tool gets the model's raw arguments. So a model that omits
`trees` reached `trees.includes('job')`; LiveKit caught the throw and handed the model an
opaque tool error, and the purpose was never set. Now: a missing `trees` is normalised,
a `wrong_trees`-only call removes the tree as asked, and a call with neither is refused
with a sentence that names the fix. Repro tests failed with the exact TypeError before
the fix. The sim also stops hiding crashes: only provider errors count as "never reached
the model"; a code throw is a FAIL with its stack.

**Found and logged, not fixed** (all on `main`, see `TODO.md`): an urgent message saved
as ordinary, a declined meeting that leaves the goodbye gate shut, a wrong node id that
makes the agent re-ask, the morning half of a night shift unbookable, and the dashboard
path still falling back to skill tags on an unlinked service.

---

## 2026-09-09 (evening) — Four calls, eight things the agent said that were not true

Four prod calls between 18:02 and 18:18 CT on Thinking Hammer. Every booking landed
and both job inquiries captured in full — and inside those working calls the agent
told callers a series of things that were false.

**IT DID NOT KNOW WHAT TIME IT WAS, SO IT MADE ONE UP AND DEFENDED IT.** On
`SCL_HQNeyh5cVKd9`, at 18:08 CT, it offered "availability today from 1 to 5 PM" —
three hours after closing — then said "It's currently 3 PM here", twice, and when
the caller answered "it is not 3PM, it is 6PM" it replied "thanks for clarifying
that it's 6 PM there in Chicago time" while still holding its own 3 PM. Sixty-four
seconds of the call went to arguing about the clock. Root cause: `formatDateForPrompt`
emits the DATE only, so the model had no time at all. Verified first that this was
NOT a timezone bug — prod's HTTP `Date`, Postgres `now()`, this workstation and
`tenants.timezone` all agreed to the second. **A model with no clock does not decline
to answer; it guesses, and then defends the guess.** `CallRuntime.currentTime` +
`formatTimeForPrompt` now put the real local time in the prompt, declared the only
source for it, and the after-hours rule says both halves out loud: closed now, AND
the next time we can see you — a bare closure reads as a refusal and ends the call.

**IT REFUSED A TIME THAT WAS FREE.** Same call: offered 1:30/2:00/2:30, the caller
asked for 4 PM, and it said "4 PM is not available on September 10." The shift runs
to 5 and `open_times` held everything through 4:30. The response's own `note` already
said, in plain words, that a time in `open_times` must never be refused. It refused
anyway — which is the whole lesson: **an instruction it can skim loses to a sentence
it must read aloud.** `offerBreadthClause()` now appends the rest of the day to the
SPOKEN string, and returns empty when the offers really are the whole day, because
inviting a caller to name a time that does not exist trades one wrong answer for another.
(It first shipped as "any open quarter hour through 4:30 PM works too"; the PR #410 review
caught that this is heard as EVERY quarter hour up to 4:30 when `open_times` has gaps, so
since 2026-09-11 it reads "I have other openings too, as late as 4:30 PM.")

**IT PROMISED TEXTS, TWICE, ON A PLATFORM THAT HAS NEVER SENT ONE.** It ran an
invented consent flow — "you haven't given consent for text reminders yet… would you
want a text reminder?" — got a yes from both callers, and told them it was noted.
`consent_records` is empty, `communications_history` has ZERO rows all-time, and
`ENABLE_SMS` is unset pending 10DLC. Under question trees there was no texting
section at all, so the model built the idea from the one place it could see:
`reminder_lead_minutes`' own parameter description. **Silence in a prompt is not a
prohibition — the model fills it from whatever else is in front of it.** `smsEnabled`
now flows from the same capability list that builds the toolset; with SMS off the
parameter describes itself as impossible and the prompt opens "YOU CANNOT SEND A
TEXT MESSAGE."

**IT ASKED FOR WHAT SHE HAD JUST SAID, AND CALLED HER OWN BOOKING SOMEONE ELSE'S.**
On `SCL_A9GtJeZF7EwF` the caller opened with "there's a job opening at US Bank" and
was asked which company she was calling from ("I just told you, US Bank"), then which
company the work was for ("She already told you, US Bank"). Later `get_my_appointments`
returned HER OWN 2:30 booking from six minutes earlier and it was relayed as the
owner's calendar, then used to push her to another day — while 1:30, 3:00, 3:30 and
4:00 sat open. Both are now prompt/description guarantees: a company named in the
opener is recorded and CONFIRMED, never re-asked, and these appointments belong to
the person on the phone and never close a day.

**AND IT NEVER TOLD ONE CALLER HER MESSAGE WAS SAVED** (`SCL_n79MyVHh9TVe`): the row
was written and she heard only "You're all set, Camille." A success now owes one plain
sentence naming what exists.

Two more shipped alongside: **"the owner" became the owner's NAME** (Dale's note —
"owner sounds cold"), resolved from the live staff roster with "someone on the team"
for several and the role word only when there is no roster at all; the rule sits in
the PROMPT because a provisioned tenant runs its questions from `tenant_question_nodes`
rows and editing `trees.ts` would not have changed a single real call. And
**`with_person`**: the booking tool had no person parameter at all — it passed NULL
for `p_preferred_employee_id` — so a caller could ask for "Jane", hear "booked with
Jane", and be assigned whoever was free. The name is now resolved against live active
employees BEFORE the RPC and a miss refuses with Dale's own sentence: *"Jane doesn't
work here. Did you mean someone else?"*

**The guard caught what I did not.** Writing the "say the name, not the role" fix, I
hardcoded "Dale" into two tool descriptions that ship to every tenant — a salon's
agent would have read them. `tests/noHardcodedNames.test.ts` failed the suite by name.
Two of my own new route tests were also asserting inside an `if` that never ran and
would have passed with the fix deleted; the logic was extracted to `offerBreadthClause`
so the assertions are unconditional.

**Still open, deliberately:** a call that says "a possible job" still selects no `job`
tree (bare "job" is excluded on purpose — in this product "I have a job for you" is a
service request) and books a 15-minute Personal Callback, which then fragments the
day for every 30-minute service. And **production still books appointments in the
past** — `book_with_scheduling_atomic` has no past-time check; only the unused
`book_appointment_atomic` does. Demonstrated by booking 1:00 PM at 6:52 PM.

---

## 2026-09-09 — The call that collected everything and booked nothing (SCL_A5wnBexPbwCC)

**A caller asked for 1:00 PM, was offered 1:00 PM, and was told 1:00 PM was not on
the quarter hour.** Prod call 11:12 CT, 292 seconds. The model pinned the exact time
the way its own tool description invites — `window_from 13:00:00`, `window_to
13:01:00`, because `book_with_scheduling` books the earliest slot at or after
`from`. The route's grid guard checked BOTH ends, `13:01` is off-grid, and the
booking died twice (12ms and 31ms — no DB statement ran). `window.to` is an upper
bound the caller never hears and the RPC never reads: `book_with_scheduling_atomic`
sets `v_start := p_window_from` and ignores `p_window_to` entirely. The guard now
validates the START only, which is the only value that is a booking time.

Everything downstream was that one rejection wearing different clothes. The model
relayed the grid error as "I can only book times on the quarter hour. I have 1:00,
1:15, or 2:00" — twenty seconds after offering 1:00, so the caller pushed back
("Why couldn't you book? I thought you had one available") and got an invented
explanation about minutes. After the second failure the 2-strike rule flipped
purpose to `identity+message` with `booking` in `wrong_trees`, dropping what he rang
for. He then asked for 1:30; the agent said "I'll check the schedule for 1:30 PM and
confirm it for you" and **made no further tool call at all**. `job_inquiries` got a
perfect row — role, full_time, 128k, hybrid, address, callback. The calendar got
nothing.

**Shift boundaries are now fuzzy by one minute, in ONE place.** Dale's rule: people
butt meetings end to end and speak in round numbers, so a shift saved as ending 16:59
must still cover the 17:00 a caller actually says. `shift_covers_booking()`
(migration 20260909120000) takes a minute of slack at each edge and is called from
all four sites that had hand-copied the comparison — three inside the booking RPC and
one in `availabilitySearch.ts`. That duplication is not hypothetical debt: suggest and
enforce disagreeing IS the 2026-07-17 midnight-wrap call, where the agent offered
11:30 PM against a 1-5 PM shift and then booked it. The wrap guards are load-bearing
(`'23:59'::time + '1 minute'` = `'00:00'`), so the un-slacked comparison is always
tried first and the fuzzy path can only ever add a minute. Appointments stay on the
quarter-hour grid — the `appointments_start/end_time_15min` CHECKs are untouched, so
no odd-minute appointment is ever written and nothing else that assumes the grid had
to be revisited.

**He answered the same question twice.** Asked `hiring_for`, he said "I'm hiring for
my own"; the model recorded `hiring_own_company`. Valid keys are `own_company` /
`placing_with_client`. The 2026-08-19 repair strips the exact `hiring_for_` prefix —
one token more than the model actually fused — so the value fell through, the node
stayed open, and the question came back. The repair now walks off leading tokens
while each belongs to the node_id, which can only ever land on an option a bare check
would already have accepted.

**And the recovery line offered a message to a man who had just left one.** At 4:14,
with `take_message` already returned, the watchdog said "…I can take a message and
have someone get right back to you." He said "No. No message. Just pass this on." The
dead air was real, so firing was right; the OFFER was the lie. `markMessageTaken()`
now flips a runtime flag on a successful message or page, and deadline 2 switches to
a line that promises nothing it cannot deliver. Same rule as the hold line above it:
what the runtime speaks has to be true at the moment it plays.

Coverage: a real-DB guard on the slack function (11 cases — both edges at one minute,
both refused at two, day/night wrap rules preserved, plus assertions that the RPC and
the suggest side both call the function so the copies cannot come back), route tests
for the one-minute window booking and for an off-grid START still being refused,
tracker tests for the partial fusion and for a value that merely looks fused, and
watchdog tests for both recovery lines.

---

## 2026-09-09 — The nav badge counted a to-do nothing could clear, and sat on top of the theme button

**The badge was honest about a column nobody wrote.** The upper-right pill counts
`unanswered_questions` rows — questions a caller asked that RAG could not answer.
An owner cleared every call off the Calls screen and the pill still read `1 KB`,
so it looked like a stuck counter. It was not: the table has no FK to
`voice_sessions`, and call deletion is a soft delete on `voice_sessions` alone.
Nothing linked them.

The link was SUPPOSED to be `unanswered_questions.call_id`, which has existed since
migration 20260417000000 — and **no writer has ever set it**. The only INSERT
(`src/routes/agentTools/knowledge.ts`, the zero-RAG-hit branch of
`/agent-tools/policy-answer`) wrote `(tenant_id, question)`. A cascade keyed on that
column would have matched zero rows forever: a no-op that reads as a working feature.
So the fix is two halves that only work together — the agent now sends `call_id`
(`agent/src/tools/knowledge.ts`) and the route persists it, and
`resolveUnansweredForCalls()` in `src/routes/voice.ts` resolves those gaps on both
`DELETE /voice/session/:id` and `POST /voice/delete-old`. It is best-effort (a
failure there must not turn a committed delete into a 500), it skips the query
entirely when every deleted row has a NULL `call_id` rather than issuing
`call_id = ANY('{}')`, and it reports `unanswered_questions_resolved` in the event log.

**No backfill.** Rows written before this ship carry a NULL `call_id` and are
unreachable from the cascade by design — inventing an attribution for them would be
archaeology. They clear from the Phone Assistant tab, as they always did.

**The pill also covered the thing next to it.** It was `fixed top-3 right-4`, which is
the AppShell bar's own right slot: the theme button rendered as "Na" with the pill
over "vy". Fixed positioning was itself the second attempt — the first,
`-top-1 -right-1` inside the tab row, got sliced by the `pointer-events: none`
border trick that lifts the active tab. It is now an IN-FLOW row directly under the
tab bar, which cannot overlap anything because nothing else occupies that line.
Label `1 KB` → `1 unanswered`: "KB" reads as kilobytes, and the owner read it as a
customer waiting on them.

Coverage: 4 route tests (cascade, NULL-call_id skip, throw-still-200, bulk array),
one real-DB test that `call_id` actually lands on the row, 2 agent tool tests
(sends the id; OMITS it rather than sending null on a browser session, which the
optional non-empty-string Zod field would 400), and a dashboard test asserting the
strip is not `fixed` and says "unanswered".

---

## 2026-09-08 — The three warnings the suite printed on every green run, and the pg@9 break hiding in one of them

**The third one was production code with a real expiry date.** `/analytics/stats`,
`/analytics/calls` and `getCohortAnalytics` each ran
`await Promise.all([client.query(…), client.query(…), …])` against ONE pooled
client. node-postgres serialises statements on a single client no matter how they
are launched, so `Promise.all` bought **no concurrency at all** — it only started
each query before the previous one finished, which is precisely what pg deprecates
and **removes in pg@9**. `cohorts.ts`'s own header asserted the opposite ("six
queries run concurrently through Promise.all — running them in sequence would
multiply one round trip by six"); that was never true, and a comment that confidently
explains a benefit which does not exist is worse than no comment, because it argues
against the fix. All three now use `queryInSeries(...)` (`src/database/index.ts`),
which takes THUNKS so nothing starts out of turn, and takes them as REST parameters
so TypeScript still infers a tuple and each destructured result keeps its own row
type instead of collapsing to a union of all of them.

Guarded by `tests/regression/singleClientQueryOverlap.test.ts`: a source scan over
`src/**` (comments stripped — the first version flagged the doc comment on
`queryInSeries` itself, which quotes the bad pattern in order to explain it) plus an
ordering assertion on the helper with the SLOW thunk first, so a helper that
secretly parallelised would fail. Red-green proven: a probe file carrying the old
pattern fails the guard by name; deleting it passes.

**The other two were the reason nobody looked.** `vitest.config.ts` → `.mts` (what
the warning asked for), and `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` removed from
`npm test` — it was hiding the warning, not fixing it, and native config loading is
scheduled to become Vite's default. The rename broke
`tests/services/deadlock-prevention.test.ts`, which read the config off disk BY NAME
— the same off-disk coupling CLAUDE.md flags for `available-slots.test.ts`; it now
discovers the file, because the assertion is about `fileParallelism: false` and not
about an extension, while an absent config still fails loudly.
`tests/regression/type-safety.test.ts` gained the `.ts` suffix its dynamic import
pattern needs for `vite:dynamic-import-vars`.

**Acceptance, with nothing suppressed:** `npm run checks` exit 0;
`npm test` → **3,031 passing (255 files)**; `configLoader` 0, `DeprecationWarning` 0,
`dynamic-import-vars` 0 across the whole run. `ai_cost_model_unpriced` x4 remains and
should — that is the SAD path doing its job on fixture models with no price entry.

**The lesson worth keeping:** a warning that prints on every green run stops being
read, and the suppression that quiets it converts "we know about this" into "nobody
will ever look again". One of these three was a scheduled outage in the analytics
endpoints, sitting in the output everyone had learned to scroll past.

---

## 2026-09-08 — PR #402: one bootstrap path for the local test DB, and three docs that were lying

Merged as `58d5c68`. Prod deploy verified rather than assumed: backend `/health`
`started_at` moved `2026-09-08T06:00:29Z` → `18:32:34Z`, `npm run status --env prod`
reported 4/4 including a deep LiveKit dispatch to the agent worker.

**What it delivers.** `scripts/start-test-db.sh` (`npm run test-db:start`) is the one
entry point: bring up the canonical compose `db` service (ankane/pgvector, container
`secretary-hq-db`, port 5433), prove a connection **from the host**, then run
`scripts/setup-test-db.ts` for `test_db` + migrations + the `app_user` role. That
closes the 2026-08-18 blocker in which the root suite reported 9 failures because
`tests/regression/rlsIsolation.test.ts` could not reach `test_db` as `app_user`.

**The bug the script itself had, found by running it.** `secretary-hq-db` reported
`Up (healthy)` with `NetworkSettings.Ports` **empty** — the state a container is left
in by being started while something else holds 5433. `docker compose up -d db`
*starts* such a container rather than recreating it, so it inherits the broken state,
and `pg_isready` through `docker compose exec` passed the whole time because the
server really was up **inside** the container. `psql -h localhost -p 5433` said
`Connection refused`. The rule this encodes: **the tests run on the host, so the host
is where readiness has to be proven** — an in-container health check answers a
different question than the one being asked. The script now polls a real host
connection, recovers an unpublished port with one `--force-recreate`, and exits
non-zero naming the cause otherwise. Verified end to end afterwards: 192 migrations,
`app_user` with NOBYPASSRLS, verification passed; then `rlsIsolation` +
`rlsAppWritePaths.realdb` + `reminderClaimRealDb` against the fresh `test_db` → 19
passed.

**A second bootstrap on the same port, removed.** `dashboard/docker-compose.test.yml`
declared its own `db` on 5433 with a different image (`pgvector/pgvector:pg15`) and a
different volume, and `dashboard/scripts/start-test-db.sh` was a fork of the root
script hardcoding `/home/dale/projects/secretary-hq/dashboard/node_modules/pg`. Two
composes fighting for one port is two databases, and a bootstrap against the wrong
one looks like it worked — this repo has already lost a schema to that exact shape
(honcho on 5433, 2026-08-05). Nothing referenced either file.

**A second backlog, removed.** `dashboard/docs/planning/{TODO,RESOLVED,TEST_DB_AUDIT}.md`
plus `dashboard/docs/DIRECTORY_STRUCTURE.md` had grown a parallel "Pepper
Documentation Backlog" next to the file whose first line is "This is the one and only
backlog", and a TEST_DB_AUDIT that contradicted the root one about the container name.

**Two documents restored after being pruned as hindsight.**
`tests/regression/rlsAppWritePaths.realdb.test.ts` had lost the 27-line header
recording the 2026-07-27 incident (`POST /demo/start` 500ing on `tenant_skills` the
moment the role stopped bypassing RLS) and gained the word "Honcho" — a different
project, and its only occurrence anywhere in this repo. `docs/planning/TEST_DB_AUDIT.md`
had been overwritten with a bootstrap how-to, destroying the HIGH/MED real-SQL
coverage map, the five bugs that audit surfaced, and the standing rule for new
dynamic SQL; the how-to that replaced it already lived in root
`DEVELOPMENT_WORKFLOW.md`.

**A correction made inside the branch's own history, recorded because the mistake is
the instructive part.** An earlier commit removed `VITE_CONFIG_NATIVE_IGNORE_WARNING`
from `npm test`, calling it a no-op with an invented name — reasoning from the
warning's *absence* in a run where the variable was doing its job. Vite prints that
exact variable name inside the warning; running the suite without it showed the
warning immediately. Restored, and `docs/planning/TODO.md` P2 now says the true
thing: the warning is **suppressed, not fixed**, the cause is ESM syntax in a
CommonJS-loaded `vitest.config.ts`, and native config loading becoming Vite's default
is the day suppression stops being enough.

**CLAUDE.md** had nine doc paths left dangling by the #401 reorg and a Project Status
paragraph still reporting the failures this branch fixes. Re-measured 2026-09-08:
backend **3,029** passing (254 files), dashboard **1,069** (99), agent **981** (60),
32 route modules, 192 migrations, 40 e2e specs, `verify:claude-md` clean.

## 2026-07-05 through 2026-07-11 — doc-hygiene batch: Telnyx creds, deploy-gate proof, webhook/gate/vitest fixes, Setup-tabs scroll, transfer-fallback string

Trimmed from `docs/planning/TODO.md` 2026-09-12 (doc-hygiene; content dated as below,
each item was already `[x]`, nothing left open).

**Confirm `TELNYX_API_KEY` + `TELNYX_SIP_CONNECTION_ID` are set on Railway — DONE
2026-07-09.** All three present. `TELNYX_PHONE_NUMBER` held the dead `+16308661960`
(order deleted); corrected to `+16308229086` and the backend redeployed (`started_at`
`23:49:38Z`). What it was breaking: the var is the outbound-SMS `from` fallback
(`tenantConfig.inboundPhone || process.env.TELNYX_PHONE_NUMBER`, `smsService.ts:66,147`
+ `appointments.ts:710`) — any tenant without its own `inbound_phone` was sending
confirmations/reminders from a number Telnyx no longer owns, so the provider rejected
it and left silent `status='failed'` rows in `communications_history`. Inbound voice
was unaffected (routing is Telnyx number → SIP Connection, not this var), which is why
the 2026-06-30 live-call test passed while SMS was broken. Nothing caught it earlier
because `featureReadiness.ts:68,81` checks only that the var is *set*, never that
Telnyx still owns the number — a set-but-dead credential reads as healthy. Only the
backend reads this var (agent takes the transfer target from tenant config, not env),
so a single fix sufficed.

**Enable the "Wait for CI" toggle on the 3 Railway services — DONE 2026-07-09.** Enabled
on all three (`secretary-hq`, `secretary-hq-agent`, `dashboard`) at Railway → Service →
Settings → Source → "Wait for CI" ("Trigger deployments after all GitHub actions have
completed successfully"). Railway stages settings edits — they only take effect after
clicking Deploy on the "Apply N changes" banner. The Railway GitHub App already held
`checks` + `commit statuses` read/write on all repos, so no permission grant was needed.
Caveat: this is unversioned dashboard state — `railway.json` has no field for it, and if
a service is ever recreated the toggle silently reverts with nothing in the repo to say
so. Caveat: the setting waits on *all* GitHub Actions on the commit, not the
branch-protection required-checks list — any future workflow that runs on `main` and
can fail will also block deploys.

**Prove the gate end-to-end — PROVEN 2026-07-09 (PR #227).** A deliberately-failing test
made `Backend` red → `mergeStateStatus: BLOCKED` → `gh pr merge` refused with "the base
branch policy prohibits the merge". Deleting the test flipped all 4 checks green →
`CLEAN` → merge allowed. Branch protection holds. Not tested, deliberately: `gh pr merge
--admin` — the API reports `enforce_admins: true`, verified-by-config, not by
experiment. This proves the MERGE gate only; the deploy gate is the "Wait for CI" item
above (after #226 merged, Railway had brought up the new backend ~4 min ahead of CI
going green — exactly what that toggle closes).

**Telnyx webhook verifies a re-stringified body — FIXED 2026-07-09.**
`/communications/telnyx/status` now HMACs `req.rawBody` (the exact received bytes),
like `billing.ts`/`square.ts`. Signature verification was also moved before payload
parsing — previously an unsigned caller reached the parse path and the route's safety
rested on the id/status guard firing first (the parser synthesizes `{}` for an empty
body). Compare is now `timingSafeEqual`. The old happy-path test hardcoded
`JSON.stringify(payload)` as the signed bytes, so it could never see the bug; replaced
with a regression test that signs raw bytes whose key order + whitespace
`JSON.stringify` would not reproduce (asserted non-equal, so the test has teeth —
verified failing against the old code).

**`npm run prepare-commit` reported a false failure — FIXED 2026-07-09.** Two
independent causes, both of which kept the gate red on a pristine `main`: (1)
`run_or_skip` eval'd each configured command in the parent shell, so the `cd dashboard`
chained into `checks`/`unitTests` leaked out and stranded every later step in the wrong
directory (`Missing script: "verify:claude-md"`) — each command now runs in a subshell
(`if (eval "$cmd")`). (2) Step 4's `focusedTestScan` regex was `(\.only\(|\.skip\()`,
which flagged every conditional skip (`test.skip(process.env.FOO !== '1', …)`,
`ctx.skip()`) as if it were a focused test — 12 legitimate guards, so the step could
never pass. Extracted to `scripts/focused-test-scan.sh`, which flags only `.only(` and
skips/todos whose first argument is a string literal (a test disabled by name = dead
code). Verified: silent on the clean tree, and still catches an injected
`describe.only(...)` / `it.skip('name', …)`.

**Dashboard vitest exited nonzero with 0 failing tests — FIXED 2026-07-09.** Surfaced by
the now-working `prepare-commit` gate: `Tests 1012 passed` + `Errors 2 errors`.
`useEntityList` / `useServiceMappings` in `dashboard/lib/hooks.ts` fetched from an
effect with no cancellation, so an unmount mid-flight ran `setLoading(false)` after
vitest tore down jsdom — React read a dead `window` and threw an unhandled rejection.
Only reproduced under full-suite load. Fixed with a `useIsMounted()` guard on every
post-`await` setter; 5 regression tests in `dashboard/lib/hooks.test.tsx` simulate
teardown by deleting `globalThis.window` (verified failing without the guard). Lesson
recorded in `docs/LESSONS_LEARNED.md`.

**BUG — Setup tabs don't scroll — FIXED 2026-07-11** (reported by Dale). `SetupView`'s
sub-tab panel was a plain block `<div>` with `overflow-hidden`. Two failures at once:
the leaf views written as `flex-1 … overflow-y-auto` (Services, Resources, Employees,
Business Settings) only get a bounded height as flex children, so under a block parent
`flex-1` was inert — they sized to content, their own scrolling never engaged, and the
parent clipped the overspill; and the plain-`<div>` views (Billing, Audit Log, Answer
Debugger) had no scroll container at all. So no Setup tab scrolled. Fix: `flex-1
flex flex-col min-h-0 overflow-y-auto` (`min-h-0` is load-bearing — without it the
default `min-height:auto` re-inflates the box and the clipping returns). Regression
test: `dashboard/e2e/setup-tabs-scroll.spec.ts`, verified to fail against the pre-fix
build.

**`get_my_appointments` transfer-fallback string — DONE 2026-07-05 (PR #198).** The
no-caller-ID fallbacks in `get_my_appointments`/cancel/reschedule now capability-gate
the transfer offer (offer a message only when transfer is unwired).

## 2026-08-14 through 2026-08-28 — doc-hygiene batch: legal docs shipped, the ENABLE_OUTPUT_WATCHDOG chain (voice naturalness, turn-latency instrument, reminder pipeline outage + deploy-order lesson)

Trimmed from `docs/planning/TODO.md` 2026-09-12 (doc-hygiene, third batch; content
dated as below, each item was already `[x]`, nothing left open). Two live loose ends
in this same area of the file were deliberately left in place, NOT archived: the
"OPEN, needs Dale's ear" line asking whether `ENABLE_OUTPUT_WATCHDOG`'s filler line
sounds like cover or a stutter on a real call, and the bare "Fill real
TELNYX_PUBLIC_KEY in .env" note — both are still-open items, not history.

**Publish + link legal docs — SHIPPED 2026-08-14.** Public `/privacy`, `/terms`,
`/dpa`. Terms = Bonterms Standard Online Cloud Terms v1.0 by reference +
Provider-Specific Terms. DPA = Bonterms DPA v2.0 cover + subprocessors. Privacy =
ICO-style notice + product call-handling language. Footer + register checkbox link
all three. Not a lawyer review.

**Test voice naturalness on simulator (inflections, pauses) — PARTIAL 2026-08-19,
then closed out same day.** A live browser-simulator call against prod surfaced two
real defects. (1) Fixed: `agent/src/checklist/checklistTools.ts` — `job`/`fix_computer`
co-selected with `generic_subject` left `generic_subject`'s own "what does this
concern?" node open even after the topic was already known, so the caller got asked a
second time; now backfilled from `TREE_TOPIC` same as `meeting_topic`. (2)
Instrumented, not fixed at the time: no engine-level inflection/pacing control exists
(Aura's WS path rejects `?speed=`) and nobody had turn-latency numbers to diagnose
"long pauses" from — `agent/src/session/watchdog.ts` logs `turn_latency_ms` (INFO,
WARN at ≥2500ms) on every turn. That instrument was then pulled from a real prod call
the same day (`sim-call-1787158785189`, John Jones / job inquiry, 207s) and **found
itself broken**: `turn_latency_ms` never once appeared in the log for a call with two
turns of 17s and 20s of real dead air, because it had been added inside
`attachOutputWatchdog`, gated behind `ENABLE_OUTPUT_WATCHDOG`, and prod ran that flag
OFF. The same pull also caught a real re-ask bug in the transcript: the model recorded
`hiring_for` as `"hiring_for_own_company"` (fusing the node_id onto the valid option
`own_company`), `tracker.record()` rejected it as unknown, and the model re-asked the
caller instead of silently retrying with the corrected key its own rejection handed
it — fixed in `tracker.ts`'s choice-value check (strip a `${nodeId}_` prefix before
rejecting). The latency logging itself was moved into `attachSilentTurnRecovery`,
which is unconditional and the only thing that actually runs on every prod call. Both
fixes have unit test coverage (`tracker.test.ts`, `watchdog.test.ts`).

**Set `ENABLE_OUTPUT_WATCHDOG=true` on `secretary-hq-agent` — DONE 2026-08-28.** Dale
confirmed Railway Variables on `secretary-hq-agent` already has it set; the agent env
schema default is also ON (`undefined` → true; only the literal string `false`
disables it). The 2026-07-17 / 2026-08-19 "prod runs that flag OFF" finding above is
historical, not current.

**Reminder pipeline totally dead since 2026-08-06 — FOUND AND FIXED 2026-08-19** on
`fix/reminder-claim-status-constraint`. The atomic claim from #322 wrote a `status`
the CHECK constraint rejected, so every tick threw and zero reminders or confirmations
were sent for 13 days while the worker reported itself healthy. Migration
`20260819000000` + `processReminder` accepting `'sending'` + `releaseStaleClaims()`,
guarded by a real-DB regression suite; full write-up also in
`docs/workflow/LESSONS_LEARNED.md`. **Deploy order for this one was deliberately the
REVERSE of the house rule** ("prod DB migrations go in ahead of the merge"), because
that rule assumes the migration is inert until new code uses it — here prod was
ALREADY running code that wrote the value the constraint rejected, so widening the
constraint on its own (with the old code still live) would flip the claim from
throwing to SUCCEEDING, and the claimed rows would then strand in `'sending'` forever
because the claim query only ever selects `'scheduled'` — turning a loud, harmless,
total outage into a silent leak that damages rows, strictly worse. Correct sequence
used: (1) merge the fix PR; (2) confirm the backend deploy actually landed (`/health`
`started_at` moves — Railway can silently skip); (3) only then run the migration
against prod. The general lesson: ask which side (code or constraint) is already
emitting the value before choosing deploy order — "migrations before merge" is right
only when the migration is inert until new code starts using it.

## 2026-07-08 through 2026-08-28 — doc-hygiene batch: per-IP limiter investigation, alert-rules research, 2026-08-19 catch-up session, refactor sweep (test-tree/knowledge/analytics/tools), question-tree call review, outage voice, greeting disclaimer

Trimmed from `docs/planning/TODO.md` 2026-09-12 (doc-hygiene, second batch; content
dated as below, each item was already `[x]`, nothing left open). The whole
`## 🎙️ Voice — Phase 2` section (`Question-tree call review — 2026-07-21 07:34 call`
+ `Phase 2 backlog`) is archived here too — every item under both headers moved,
leaving the headers themselves empty scaffolding, so they were deleted along with
their content rather than left standing over nothing.

**`/demo/start` per-IP limiter is a global bucket — investigated 2026-07-08, NOT a
bug.** A controlled 16-min quiet-window test returned 200, so the window resets
normally; the persistent 429s were self-inflicted test traffic. A spoofed
`X-Forwarded-For` has no effect because Railway overwrites it with the true client IP
(correct, non-spoofable). No action.

**Alert rules — stand up a hosted monitoring destination — DROPPED 2026-07-09. No
vendor meets the "really free forever" bar.** Researched rather than assumed:
UptimeRobot free is not usable at all (since 2024-12-01 its ToS restricts the free
plan to personal, non-commercial use, explicitly prohibiting revenue-generating
applications — SecretaryHQ is a paid SaaS); Grafana Cloud free doesn't expire but is
capped (10K active series, 14-day retention, 3 users, $6.50/1K series beyond — our
worst case is 10 metrics × the 1000-series `MAX_LABEL_CARDINALITY` cap = exactly 10K,
realistically ~2–3K, so it would fit, but "free within limits the vendor can move" is
not free forever); Healthchecks.io free is heartbeat/cron monitoring (20 jobs), not
metric thresholds. Every "free forever" tier is free-within-limits. Paid vendors
(Sentry, Better Stack) were already declined 2026-07-02; the code keeps its no-op
hooks either way. `docs/ALERTS.md` stays as a reusable PromQL reference — the rules
are collector-agnostic and cost nothing to keep; paste-and-go if a destination is ever
chosen. The one signal actually worth having — "SMS failure ratio crossed 20%", which
would have caught the dead `TELNYX_PHONE_NUMBER` on day one — needed no vendor, which
led to:

**Zero-vendor alert — DONE 2026-08-28.** `.github/workflows/zero-vendor-alerts.yml`
every 30m curls prod `/metrics` with `METRICS_TOKEN`, `scripts/zeroVendorAlerts.ts`
evaluates ALERTS.md §3.9 on the boot-lifetime counters (`rate()` needs two scrapes; a
dead from-number pins the ratio at 1.0). Opens or comments one `[zero-vendor]` issue.
Unset token is SKIP, not a page. Pin: `tests/scripts/zeroVendorAlerts.test.ts` (5).

**2026-08-19 catch-up session** (after a stretch of local-only work): commit + deploy
the E2E sweep (20 defects, 4 livelocks fixed, PR #344 / `41c4d53`, `started_at`
`2026-08-19T08:22:19Z`, verified `GET /health` + `POST /demo/start` both 200); refresh
V8 coverage (stale since 05-22); fix 9 RLS failures blocking the test DB (`npm test`
back to green at repo root, `2750 passed`); sync `TEST_COVERAGE`/`DEPLOYMENT`/`HANDOFF`
docs with current code and corrected deployment env wording.

**Structural-refactor sweep, 2026-08-21/2026-08-28** (re-verified against the code on
2026-07-28, not carried over on trust — from the former root
`07_11_2026_IMPROVEMENTS.md`, since deleted as a duplicate backlog): moved the last
stray test file out of `src/` into `tests/` (`src/services/phoneLoopGuard.test.ts` →
`tests/shared/transferLoopGuard.test.ts`, renamed for what it covers; `find src -name
'*.test.ts'` returns 0); extracted `src/routes/knowledge.ts` (1,092 → 649 lines) into
six `src/services/knowledge/` modules (PR #367) — tests came first (coverage
74.77% → 83.18%), and the extraction surfaced three real defects fixed in their own
commits: `/knowledge/explain` scored at the stale 0.5 threshold against production's
0.30 and embedded the wrong (normalized, not expanded) query; embedding spend for
`/knowledge/add` and `PUT /knowledge/:id` was filed under the provenance value
`'policy-questionnaire'` instead of a real spend category; the embedding price was
duplicated in three modules instead of read from the one authoritative pricing table;
fixed `estimateCost` silently billing $0 for any model missing from `PRICING` (now
bumps `errors_total{event="ai_cost_model_unpriced"}` and logs the model name); added a
scheme/host guard (`assertSafeSiteFetchUrl`) to the website-scan fetch, refusing
loopback/private/link-local literals (incl. `169.254.169.254` and its
Node-canonicalized decimal form) and re-gating redirects so a public 302 cannot hop
onto metadata; extracted `src/routes/analytics.ts` (880 → 430 lines) into five
`src/services/analytics/` modules, writing characterization tests FIRST
(78.86% → 100% lines) so the same 43 tests stayed green through every extraction step;
grouped `agent/src/tools.ts` definitions by capability under `agent/src/tools/`
(`agent/src/tools.ts` is now a 12-line barrel); reconciled `tools.ts` against what the
model can actually reach (`DEFINED_UNREACHABLE_ON_QUESTION_TREE` parks the ladder
routers, superseded scheduling tools, SMS-gated tools, and the previously-undecided
`transfer_call` / `page_owner_via_sms` / `save_customer_preference` /
`get_detailed_customer_history` as KEEP-UNWIRED, `find_caller_by_name` still excluded
for its enumeration bug); confirmed `src/services/phoneUtils.ts` / `nameUtils.ts`
already re-export `shared/phone` / `shared/name` with no duplicate implementation
(entry had been misleading — nothing to dedupe); narrowed the two dead-CRM-provider
CHECK constraints (`entity_sync_map_provider_check`,
`tenant_integration_settings_provider_check`) that still enumerated
`jobber`/`hubspot`/`servicetitan` alongside `square` eleven weeks after those 21
adapters were deleted — both tables held zero prod rows, migration
`20260821020000_drop_dead_crm_providers`.

**Question-tree call review — 2026-07-21 07:34 call** (branch
`feat/question-tree-architecture`, room `sim-call-1784637271290`): the call succeeded
end-to-end (booked 4:30 PM, linked `job_inquiries.appointment_id`, semantic service
match, E.164 phone, "Dale" not "Dale DeMott", no snake_case spoken), with five
conversation-layer snags fixed, all re-verified stale-free 2026-08-21: a double
read-back of a dictated number (now recorded immediately, without an initial
read-back, per the invariant "read back exactly once — never skipped, never twice");
a redundant "What is the meeting about?" third-ask (`meeting_topic` /
`subject_details` now backfilled from `TREE_TOPIC` when `booking` rides with a subject
tree); silent-turn recovery firing during call close (`watchdog.ts` guards the nudge
on `session.closing`); `set_purpose` recording an empty volunteered `caller_name: ""`
(an empty value never records, node stays open); salary stored verbatim as words with
no readable range (`formatPayRangeDisplay` now renders "$140–160k (…words…)" in the
inbox and job-inquiry email, unparseable copy like "competitive" left unchanged, DONE
2026-08-28); and a 12-second wrap-up turn stacking three things at once (ending block
now forbids stacking passed-along + email + "anything else" in one turn, DONE
2026-08-28).

**OUTAGE VOICE — a caller must never get silence when the LLM is down — DONE
2026-08-21.** New `agent/src/session/outageGuard.ts` + `OUTAGE_LINE` in
`holdLines.ts`. On the 2nd consecutive `AgentSession` error with no successful speech
in between, the agent plays a pre-synthesized, cache-only line — "I'm having some
technical trouble on my end. Please try calling back in a few minutes" — and closes
the call. The line deliberately routes around the model, which is the whole lesson of
the 2026-07-21 08:56 call: every other recovery path here IS a `generateReply` or a
live TTS round trip, so when the LLM is the thing that is down they all die of the
same cause and the caller gets seven consecutive errors' worth of silence. 2 not 1
(a single transient error is survivable); the count is consecutive, reset by the
`speaking` state transition; fires exactly once per call so a second trip cannot talk
over the goodbye. The watchdog half of this item (the `reply_already_queued` branch
arming the escalation timer instead of standing down) had already shipped 2026-08-15.

**Recording disclaimer → deterministic verbatim greeting (Illinois 2-party consent) —
already done; entry was stale (verified 2026-08-28).** The prescribed `tenants.greeting`
column that `index.ts` would speak verbatim is the design `greeting.ts` exists to
reject: a tenant-controlled whole greeting silently deleted the disclosure. What
shipped instead: composed opener + unconditional disclosure + closer. Default: "this
call is transcribed for quality and service" (never "recorded", never "training").
Custom wording is `tenants.call_disclosure` with attestation (`20260711000000`), not a
`greeting` column.

## 2026-07-13 (re-verified 2026-08-21) — Code review four-reviewer sweep (backend, security, reliability, dead code)

Moved here from `docs/planning/TODO.md` §4b 2026-09-08 (doc-hygiene trim — every item in this section was `[x]` done, none open). Kept verbatim including the self-corrections and re-audit notes, because the corrections are as instructive as the findings.

> **Adversarially re-reviewed 2026-07-13 (Opus).** Two of my findings were **REFUTED and dropped**:
> **CORS is NOT open in prod** (`curl -H "Origin: https://evil.example.com"` → `access-control-allow-origin: https://www.secretaryhq.com`; Railway sets `CORS_ORIGIN`, only the code _default_ is bad), and my **`message_delivery_status` RLS finding was measured against the LOCAL database and reported as production** — where it is in fact RLS-enabled-with-zero-policies (see 4a). The proposed "fix" would have changed nothing under BYPASSRLS and then been written into `SECURITY.md` as "RLS enforced" — worse than leaving it.
>
> **Severity corrections:** `isTenantExempt`'s blanket `/tenants/*` exemption is **not latent** now that middleware is the sole boundary. The schedule-extender poison is **over-rated** (it is a _future_ regression needing an owner to add a far-future one-off shift — it is NOT the bug that killed the 2026-07-12 call, which was simply "the schedule ran out"). `ENABLE_VOICE_SESSION_REAPER`/`ENABLE_SCHEDULE_EXTENDER`: **my proposed "fix" was a regression** — those vars _do_ work outside production (that is how the realdb tests drive the workers); the real defect is the inverse (no way to turn a worker **off** in prod).

Every item below was **verified by reading the code**, not inferred. Ranked by what bites first.
The two CRITICALs are **fixed on branch `fix/jwt-type-confusion-and-context-gate`** (not yet merged).

> ## ⚠️ Re-verified end-to-end 2026-08-19 — and this list had drifted badly
>
> Two consecutive sessions found that most of what this section called open had
> already been fixed weeks earlier. Every remaining unchecked item was re-read
> against the working tree; the results are recorded inline below, including where
> the ORIGINAL FINDING WAS WRONG (`/templates/full` is not anonymous;
> `isTenantExempt` was never a behaviour bug) and where it was overstated
> (`find-customer-by-name` no longer matches a single letter).
>
> **Scoreboard:** 4 genuinely broken and now fixed (alternatives-search duration,
> purge `--older-than` NaN, `telnyxNumbers` timeout, plus the reminder-claim
> outage from the previous session) · 3 already fixed and merely unmarked
> (`'Caller'` placeholder, `/metrics` `!==`, and five items in the SMS/reminders
> block) · 2 wrong or overstated as written · 6 dead-code items still real and
> deliberately deferred to their own PR.
>
> **The meta-lesson, which is worth more than any single item:** a backlog nobody
> re-verifies becomes actively misleading, and it costs more than an empty one —
> it sends the next session to fix what is already fixed while the real outage
> (13 days of zero reminders) sat one line below, unnoticed. Mark items done when
> they ship, and re-verify before trusting an entry older than a few weeks.

**A grounding fact that reframes the rest:** production has **never booked an appointment** — 5 voice
calls, **0 appointments, 0 reminder_schedules, 0 communications_history**, all time. So no reminder
has ever been seeded, no SMS ever sent, and no self-service token ever minted. Several findings below
are unexploited _only because the feature has never once run_. The first real call is the moment they
all go live at the same time.

**CRITICAL — fixed on branch, awaiting merge**

- [x] ~~**Self-service SMS link authenticated as tenant OWNER.**~~ Cancel/reschedule tokens are signed with the same `JWT_SECRET` as sessions; `verifyToken` couldn't tell them apart and the hook did `role: decoded.role ?? 'owner'`. Anyone holding an appointment-confirmation text could replay it as a Bearer token and dump the tenant's customers/appointments/transcripts via `GET /export/tenant-data` for 24h, no password. Never exploited — no SMS has ever been sent. **Fix: every token declares a `typ`; each verifier accepts only its own kind; no owner default.**
- [x] ~~**The OTP gate guarded 1 of 3 doors.**~~ `identify-caller` was gated 2026-07-13; `customer-context` and `customer-history` returned the same name/preferences/history with **no check**, and the LLM picks the phone number it passes. Found independently by two reviewers. **Fix: one shared `callerMayHearCustomerData()` in front of all three; `phone_source` defaults to the cautious `'spoken'`.**

**HIGH — the OTP gate is still weaker than it looks**

> **Re-audited 2026-08-03 while wiring the tools into the live call (below): three of the four findings here were already fixed in `src/routes/agentTools/identity.ts` — this section had drifted stale the same way §4a had. Re-verified by reading the current code, not carried over on trust.**

- [x] ~~**OTP verification is phone-global for 24h, not call-bound.**~~ **FIXED** (`identity.ts:99-116`, `callerMayHearCustomerData`) — the gate now requires a `phone_verifications` row whose `call_id` matches the live call; a NULL/missing `call_id` can never satisfy it. Backed by migration `20260714000000_phone_verification_call_binding.sql`.
- [x] ~~**A 4-digit code is brute-forceable because the attempt cap resets per code.**~~ **FIXED** (`identity.ts:837-874`) — attempts are now summed per `(tenant, phone)` over a rolling 1-hour window across every code issued (not per-row); a resend expires all prior live codes first (one live code at a time); a lockout emits `errors_total{event="otp_phone_locked_out"}`.
- [x] ~~**A verified caller still can't cancel, reschedule, or hear their appointments.**~~ **FIXED** (`agent/src/tools.ts:854-876`, `verify_phone_code`) — on `verified:true` the tool now sets `ctx.callerPhone` to the server-normalized E.164 number, so `get_my_appointments`/`send_self_service_link`/cancel/reschedule stop hard-bailing after a successful OTP.
- [x] ~~**(code)** **`find-customer-by-name` enumerated real customers' NAMES on an unanchored `ILIKE '%…%'`.**~~ — **FIXED 2026-08-19.** The 4-character floor and LIKE-metacharacter escaping (2026-08-07) removed the cheapest probes and left the oracle intact: a 4+ character surname still returned up to 5 real customers plus the last four digits of each phone, with the guessed name as the only credential. **The match is now near-exact and LIKE is gone entirely** (`identity.ts`): the caller must supply BOTH name parts, and they must match exactly modulo case, punctuation, honorifics, and an extra middle name or suffix on either side (`normalizeNameForSearch` + `nameMatchesNearExactly`). One token — a bare first name or a bare surname — short-circuits before any SQL runs, and so does initials-only input under the retained 4-character floor. SQL prefilters on the surname as a whole word (same normalization on both sides) and the precise rule runs in-process, so a shared surname can no longer return the family that shares it. **What it costs, stated plainly:** fuzzy recovery. "Thornbury" for "Thornberry" now returns nothing and the caller is treated as new — the safe direction to fail. The route stays OUT of the model's toolset; tighten before wiring, not after. Tests: 8 in `tests/routes/agentTools/agentTools.test.ts` (guards + in-process filter, mocked pool) and 20 real-Postgres cases in `tests/integration/agentToolsCustomerSearch.realdb.test.ts` (three of them assert the old partial-match probes now return nothing). Tool description in `agent/src/tools.ts` updated to demand a full name.
- [x] ~~**None of the above ever ran on a live call anyway.**~~ **FIXED 2026-08-03.** All three backend fixes above were correct and complete — and entirely unreachable. Production runs question trees (`agent/src/checklist/`), and `checklistTools.ts`'s `selectedTools()` builds the model's toolset from an allowlist (`TREE_PASSTHROUGH_TOOLS`) that never included `send_verification_code`, `verify_phone_code`, or `get_customer_context` — they existed fully built in `agent/src/tools.ts` but no call could ever reach them. **They ARE capability-gated, in a second and independent place** (corrected 2026-08-07 from PR review — the earlier "confirmed unconditional" reading was wrong): `tools.ts:87-88` maps both OTP tools to the `'verification'` capability, `buildTools` drops them unless `capabilities` includes it (`tools.ts:280`), and `index.ts:884-890` filters `'verification'` out of `activeCapabilities` whenever `ENABLE_PHONE_VERIFICATION` is false. So a tool must clear BOTH gates to reach a live call — the tree allowlist AND the capability list — and neither implies the other. Do not read the fix below as "the OTP tools are always present in ToolContext"; with phone verification off they are absent regardless of the allowlist. A forwarded-line caller could never be recognized or verified, no matter what the backend was ready to do. Fix: added `identity: ['get_customer_context', 'send_verification_code', 'verify_phone_code']` to `TREE_PASSTHROUGH_TOOLS` — the `identity` tree is selected on every goal-bearing call. `find_caller_by_name` deliberately excluded (see item above). 2 new tests in `checklistTools.test.ts`; full agent suite (83 files / 1295 tests) + typecheck green.

**HIGH — SMS/reminders.** Re-audited against the code 2026-08-19. **Most of this
block had already been fixed and the list still said otherwise** — every claim below
is now re-verified against the source, not carried forward.

- [x] ~~The retry policy is unreachable dead code~~ — **DONE (2026-07-13).** `processReminder` rethrows; the worker's catch owns `decideRetry` / `retry_count` / the 5m/30m/2h backoff. Verified in `src/services/reminders/index.ts` (`ReminderSendError`).
- [x] ~~A reminder cancelled for "no consent" is silent~~ — **DONE.** `remindersSkippedTotal.inc({reason:'no_consent'})` + a 5W warn, plus `appointment_cancelled` / `appointment_passed` on the neighbouring branches.
- [x] ~~`reminders_sent_total` is never incremented~~ — **DONE.** `remindersSentTotal` fires on both outcomes inside the LIVE `ReminderService`, and `smsSendsTotal` is incremented at 5 call sites in the live `smsService.ts` / `telnyxSms.ts`. (The dead parallel `ReminderProcessor` is still to be deleted — see the dead-code item below.)
- [x] ~~Unbounded `fetch()` to Telnyx can wedge the reminder worker~~ — **DONE for the SMS paths.** `AbortSignal.timeout(10_000)` in `TelnyxSmsAdapter.ts:60` and `telnyxSms.ts` (`SEND_TIMEOUT_MS`). **Narrower remainder FIXED 2026-08-19:** `src/services/telnyxNumbers.ts` (the number-PROVISIONING client — it could never wedge the reminder tick, only hang a provisioning request an owner is watching) now carries `AbortSignal.timeout(TELNYX_REQUEST_TIMEOUT_MS)` on every call, and its catch names the cap instead of reporting the generic `TimeoutError` message.
- [x] ~~SIGTERM doesn't drain in-flight worker ticks~~ — **DONE.** `stopReminderScheduler()` awaits `_currentTick` behind a 10s timeout, wired to SIGTERM/SIGINT.

**MEDIUM — correctness in the code shipped 2026-07-12/13**

- [x] ~~**(code)** **One far-future shift row poisons the schedule extender forever.**~~ — **FIXED 2026-08-20** on `fix/schedule-extender-stores-the-rule`. `tail` was `MAX(shift_date)` over _all time_ and the pattern was the 7 days ending there, so one one-off shift 300 days out ("annual inventory Saturday") made the pattern **Saturday-only**; Mon–Fri quietly stopped being extended and the business went unbookable in ~180 days, killed by the worker written to prevent exactly that.
  - **Done as prescribed: STORE THE RULE.** Migration `20260820000000` adds `employee_schedule_pattern (tenant_id, employee_id, day_of_week, start_time, end_time)` — natural composite PK, RLS + admin bypass matching `employee_schedule`. `expandWeeklyToSchedule` now writes it from the same weekly grid the wizard already collects (both callers pass the COMPLETE pattern for one employee, so the rule is **replaced, not merged** — merging would resurrect a weekday the owner dropped, the same bug one table over). `extendSchedules` projects the declared rule where one exists; the `tail` CTE excludes rule-bearing employees outright, so declared and derived are disjoint by construction and `UNION ALL` cannot double-count.
  - **The derived fallback survives, with its tail clamped to `CURRENT_DATE + 14`.** That clamp is what fixes every tenant who predates the table. It keeps the two properties that mattered — a lapsed schedule is still backfilled (the tail is wherever it actually ended, however far back) and a dropped weekday is still not resurrected — while putting a far-future one-off out of reach. It is a fixed point, not a feedback loop: past the clamp the tail week IS the worker's own output, a faithful copy of the same pattern. The three rejected derivations are recorded in the file header so nobody re-proposes them.
  - **NO BACKFILL, deliberately.** Inventing a rule from existing rows is the archaeology the table exists to end. Existing tenants (Thinking Hammer included) keep the clamped fallback until they next save their hours, at which point the rule lands and the guessing stops for them permanently. **Consequence to know:** the poisoning is fixed for them by the clamp, not by the rule.
  - Tests: 5 real-DB cases in `tests/services/extendSchedules.realdb.test.ts` (incl. the far-future-Saturday regression, **verified to fail with the clamp removed**) + 3 in `tests/services/expand-weekly-integration.test.ts` (rule written / rule replaced on drop / empty pattern leaves the rule alone).
- [x] ~~**`SIGTERM drain` + `atomic claim` are ONE bug, and it fires on EVERY DEPLOY**~~ —
      **BOTH SHIPPED, AND THE CLAIM HALF THEN TOOK THE WHOLE PIPELINE DOWN FOR 13 DAYS.**
      Fixed 2026-08-19 on `fix/reminder-claim-status-constraint`. The claim landed in
      #322 (`6d94cf9`, 2026-08-06) exactly as prescribed here —
      `UPDATE ... SET status='sending' ... FOR UPDATE SKIP LOCKED RETURNING *` — and
      `reminder_schedules_status_check` allowed only `scheduled|sent|failed|cancelled`.
      So every 60s tick threw `violates check constraint`, `processBatch`'s outer catch
      bumped `errors_total{event="reminder_batch_failed"}` on the token-gated `/metrics`
      that nothing scrapes, and returned 0. **Not one reminder or confirmation was sent
      between 2026-08-06 and 2026-08-19.** `/health` green, worker "running", no alert.
      Reproduced against real Postgres before any code was written.
      **Three things ship together and all three must stay together:** migration
      `20260819000000` (widen the enum), `processReminder` accepting `'sending'` (it
      gated on `!== 'scheduled'`, so the moment the claim worked it would have silently
      skipped every claimed row and stranded it where the claim query never looks
      again — a second bug hiding behind the first), and `releaseStaleClaims()`
      returning rows abandoned in `'sending'` past 5 minutes (a claim introduces a way
      to LOSE a reminder that `'scheduled'` never had). `triggerReminder` deliberately
      still refuses `'sending'`.
      **The lesson, which is the whole point:** a reliability fix shipped with green
      unit tests that all mocked the pool, and a mock has no CHECK constraints. The
      guard is now `tests/regression/reminderClaimRealDb.test.ts` — real DB, running
      the worker's claim statement verbatim. Verified both directions: 5 of its 6 tests
      fail with the migration reverted, all 6 pass with it.

- [x] ~~**The alternatives search offers slots the booking then refuses**~~ — **FIXED 2026-08-19.** Re-verified as REAL before fixing, and the original description was half right: skills/capabilities were already threaded through, but the duration was not. The failure branch built its search from `args.requirements.*` — the MODEL's guess, which usually omits `durationMinutes` — while the RPC above used `resolved.duration_minutes` and preferred `resolved.required_skills`. A 90-minute skill-gated service was offered a 30-minute gap with an unskilled employee; the caller accepted and got `NO_SKILLED_EMPLOYEE`. The dead end became a rejection loop. **The reason it was not a one-line fix:** `resolved` is scoped inside the `outcomeOfBooking` callback and is not in scope at the failure branch (a first attempt failed `tsc` on exactly that), so the resolved duration + skills are now carried out on the callback's return value. Guarded by a new case in `agentTools.test.ts` asserting the slots query receives the resolved `90` and `['alignment']`; verified it fails with the fix reverted.
- [x] ~~**`'Caller'` is still an unfixable placeholder on the OTHER write path**~~ — **ALREADY FIXED 2026-07-13; this entry was stale.** `identity.ts`'s `ON CONFLICT DO UPDATE` now tests `customers.name = ANY($4::text[])` against the shared `PLACEHOLDER_NAMES` (`['Valued Customer', 'Caller', 'Unknown']`), so the `'Caller'` that `scheduling.ts:594` writes on a nameless booking IS overwritten when the caller later gives a name. The fix even carries a comment describing this exact bug. A real name is still never clobbered; a 2026-08-01 `is_correction` flag additionally allows a same-call correction.
- [x] ~~**`purge-soft-deleted.ts` `--older-than` typo → `NaN` → cutoff silently dropped**~~ — **FIXED 2026-08-19.** Verified real: `Number(valueOf('--older-than') ?? 0)` yielded NaN, `NaN > 0` was false, and the `AND deleted_at < …` clause was omitted ENTIRELY, so `--older-than abc --execute --yes` hard-deleted every soft-deleted tenant while the operator believed they had set a floor. Now rejects non-finite and negative values and exits non-zero before any DB connection is attempted (a negative would push the cutoff into the future — the same over-broad purge by another route). New `scripts/purge-soft-deleted.test.ts` drives the real script as a subprocess, because the guard runs at module scope and calls `process.exit`; verified both cases fail with the guard removed.
- [x] ~~`/metrics` compares its bearer token with `!==`~~ — **ALREADY FIXED; this entry was stale.** `health.ts:81` uses `safeEquals(provided, token)`, with a comment explaining the timing oracle.
- [x] ~~**(code)** **`GET /templates/full`**~~ — **FIXED 2026-08-20** on `fix/templates-full-super-admin`, **and the prescribed fix was wrong too.** The first finding (anonymous read) was already known to be wrong — the route is absent from `PUBLIC_ROUTES`, so the JWT preHandler rejects an unauthenticated request. The follow-up prescription, "add `requireSuperAdmin`, matching `/templates/create`", **would have broken onboarding for every real customer**: five owner-facing surfaces read this route (`SetupView`, `SetupWizard/index`, `SoloWizard`, `DashboardHome`, `BusinessTypeSection`), and the picker's own `TemplatePreviewModal` RENDERS `system_prompt_template` and `first_message` to the owner on purpose, under the headings "AI System Prompt" and "Greeting Message". Owners are not withheld the prompt anywhere in this product — `AIConfigView` lets them edit their own copy. A route whose whole job is showing templates to owners cannot be owner-inaccessible. **What was actually wrong was `SELECT *`** — an implicit contract that grows by itself: every column ever added to `business_templates` was published to every authenticated user the moment the migration landed, with nobody deciding to publish it. Today that meant `voice_provider` / `voice_name` (backfilled `'cartesia'` / `'elevenlabs'` — TTS providers this stack has never used, so the dashboard was handed values that are simply false) and `example_resources` (no client has ever heard of it). The route now selects an explicit 15-column list matching `BusinessTemplate` in `dashboard/lib/types.ts` field for field, pinned by two real-DB tests in `tests/integration/tenants.realdb.test.ts` — **both verified to fail against the old `SELECT *`** — so publishing a new column is a deliberate act, not a side effect of a migration. **Open decision, not code:** whether to narrow the audience from "any authenticated user" to owners/admins. It would exclude `front_desk` staff and, more to the point, self-serve `POST /demo/start` tenants — which mint an owner-role token, so anyone on the internet can read every template today. Left alone because `DashboardHome`'s business-type picker is a Primary tab and I could not prove no front-desk user reaches it; that is a product call.
- [x] ~~`isTenantExempt` exempts _all_ of `/tenants/*` regardless of the list~~ — **the code was rewritten 2026-08-19, but be clear about what that did: it changed NOTHING about behaviour.** The old predicate `path === r || path.startsWith('/tenants/')` ignores its loop variable, so `.some()` answered on the first element for any `/tenants/*` path — but the result is identical to an explicit prefix rule for every input, which was confirmed by running the new tests against the OLD implementation and watching all 46 pass. So this was never a live hole, and the backlog's "a new `/tenants/*` route inherits no middleware protection" is true of the intended design (those routes self-check with `requireSuperAdmin`), not of a defect. The rewrite splits `TENANT_EXEMPT_ROUTES` (exact matches) from `TENANT_EXEMPT_PREFIXES` (`/tenants/`, `/agent-tools/`) so the prefix rule is stated rather than smuggled into a predicate, and two tests now pin both halves.

**Dead code / simplification** (see also 🧹 Doc hygiene)

> **Every item below was re-verified against the working tree on 2026-08-19 and all
> of them are still real** — unlike the correctness block above, which was mostly
> stale. Deliberately NOT bundled into the fix PR: deleting ~600 lines is a
> different risk class from fixing four bugs, and mixing them makes both harder to
> review. Evidence is recorded per item so the follow-up does not have to re-derive
> it.

- [x] ~~**Delete the orphaned parallel reminder implementation — 391 lines, zero prod callers.**~~ — **DONE 2026-08-20.** Deleted `reminderProcessor.ts`, `reminderScheduler.ts`, `reminderRepository.ts` and `reminderProcessor-metrics.test.ts`. **The metrics halo was worse than "redundant coverage":** that test asserted `reminders_sent_total{channel: email|sms}` and `reminders_skipped_total{reason: processing_error}` — shapes the LIVE service has never emitted (it partitions by reminder `type`, and rethrows processing failures into `errors_total`). `metrics.ts` and `docs/ALERTS.md` documented the dead shape too, so any dashboard or alert filtering on `channel` matched nothing and read as "healthy". Replaced with `tests/services/reminders/reminderService-metrics.test.ts` against the live emitter, descriptions corrected, and `appointment_not_found` — documented since forever, never incremented — is now emitted (it fired 8 times in one prod minute on 2026-08-20 with nothing counting it). Original text: **Re-verified 2026-08-19:** `services/reminders/reminderScheduler.ts` has **zero** importers anywhere in `src/` or `tests/`; `reminderProcessor.ts` is reached only by that dead file's discarded `_ReminderProcessor` dynamic import and by its own metrics test. `services/reminders/reminderProcessor.ts` + `services/reminders/reminderScheduler.ts` are a second, unused implementation whose only caller is a discarded `_`-prefixed dynamic import and a test. The **name collision with the live `workers/reminderScheduler.ts` is what hid it** — and it holds the metrics that were supposed to be watching prod. Its `reminderProcessor-metrics.test.ts` gives the dead class a green-CI halo. Textbook "test it or delete it".
- [x] ~~**(code)** **Live `n8n` trigger fired on every appointment INSERT**~~ — **DONE 2026-08-21**, migration `20260821000000_drop_n8n_webhook`: trigger, SECURITY DEFINER function, and `tenants.n8n_webhook_url` all dropped. **Checked against PROD before touching schema — 0 tenants held a value and `pg_net` was not installed**, so nothing was lost and nothing behaved differently. What it cost while it lived: a `SELECT` against `tenants` on every appointment INSERT, inside the booking transaction, to read a column with zero readers and zero writers. What made it worth removing rather than leaving inert: with `pg_net` present the POST runs SYNCHRONOUSLY inside that transaction, so `book_with_scheduling_atomic` would block on an external host while holding the GiST exclusion constraints — a slow webhook endpoint becomes a booking outage. Guarded by `tests/regression/n8nWebhookRemoved.realdb.test.ts` (4 real-DB cases: trigger gone, function gone, column gone, and **a booking still INSERTs** — proving the drop by writing, not by reading the catalog).
- [x] ~~**`shared/dateTime.ts` — 85 lines, 8 exports, zero importers.**~~ — **DELETED 2026-08-20.** Import grep across `src/`, `shared/`, `dashboard/`, `agent/src/` and `tests/` returned nothing; removed from CLAUDE.md's `/shared` resident list at the same time. **Re-verified 2026-08-19:** still exactly 85 lines / 8 exports, and an import grep across `src/`, `shared/`, `dashboard/`, `agent/src/` and `tests/` returns nothing.
- [x] ~~**`TelephonyProvider`: 4 of 5 methods are dead Twilio residue**~~ — **DONE 2026-08-20.** Collapsed to `{ getName, sendSMS }`; `TelephonyCallRequest` removed. Verified zero callers of `makeCall` / `createInstruction` / `wrapResponse` / `generateInstruction` anywhere in `src/` or `tests/` before deleting, and `TelnyxSmsAdapter` threw on all four anyway. A knock-on the deletion exposed: `smsServiceMetrics.test.ts` carried an `as unknown as` cast that existed only to paper over the four members its literal did not implement — now unnecessary, and lint caught it. `ProviderRegistry`'s dead `JEST_WORKER_ID` disjunct went too (repo is Vitest-only). Original text: — both adapters `throw` on them, and `MockAdapter` still emits **TwiML XML** for a stack that dropped Twilio months ago. Collapse to `{ getName, sendSMS }` (~120 lines); the registry's one real job (the no-creds Mock switch) is a one-liner.
- [x] ~~**(code)** **42 migrations self-managed a transaction the runner already owns.**~~ — **DONE 2026-08-21.** All 42 stripped of their top-level `BEGIN;`/`COMMIT;`. The runner applies each file as `psql --single-transaction <<SQL \i <file> / INSERT INTO schema_migrations … SQL`, so `--single-transaction` wraps the whole heredoc — a file's own `COMMIT;` ended that wrapper early and the tracking INSERT landed outside it, meaning a later failure could leave DDL applied with no `schema_migrations` row. The file's own `BEGIN;` was separately a no-op that only warned "there is already a transaction in progress". Inert against prod (all 42 long applied); the damage was confined to fresh rebuilds and new environments. **Verified end-to-end by `npm run db:rebuild -- --yes`** — DROP SCHEMA, full chain, seed, clean, and `supabase/baseline.sql` came back byte-identical, which is the proof that stripping changed no schema. The strip skipped dollar-quoted bodies so `DO $$ BEGIN … END $$;` was never touched. Guarded by `tests/regression/migrationsOwnTransaction.test.ts`, which carries both a negative control (plpgsql must NOT be flagged) and a positive one (a real top-level transaction MUST be flagged) — a guard nobody has watched fail is not a guard. `scripts/setup-db.sh`'s comment now states the dependency instead of assuming it.
- [x] ~~**(code)** Inert columns to drop~~ — **DONE 2026-08-21**, migration `20260821010000_drop_inert_columns`. **Checked against prod first:** `business_templates` held 30 rows with `voice_provider` ∈ {cartesia, elevenlabs, NULL} and `voice_name` ∈ {Josh, Rachel, Default Male, NULL} — an ElevenLabs vocabulary for a product whose TTS has only ever been OpenAI and then Deepgram Aura, so those were not stale values but FALSE ones; `tenant_integration_settings` holds **zero rows**, so `webhook_secret` dropped nothing at all. All three had zero TypeScript readers. **`ENABLE_VOICE_SESSION_REAPER` / `ENABLE_SCHEDULE_EXTENDER` / `ENABLE_REMINDER_SCHEDULER`: decided and fixed.** The asymmetry is kept — prod ON by default, elsewhere OFF by default — because defaulting a worker off in prod because nobody set a variable is the failure this project has already lived through (13 days of zero reminders). What was missing was the escape hatch: `isProduction || flag === 'true'` is simply `true` in prod, so a misbehaving worker could only be stopped by shipping a deploy. New `src/services/workerEnabled.ts` honours an exact `ENABLE_X=false` in production and is otherwise byte-for-byte the old behaviour; near-misses (`False`, `0`, `no`, `' false'`) deliberately do NOT disable, because a kill switch that fires on a typo stops a worker silently. 7 unit tests. **`JEST_WORKER_ID` was already removed** in #353 (`ProviderRegistry.ts:42` now carries only the two live `VITEST` checks) — this entry was stale. **`STRIPE_AUTO_TAX` needs no code change**: it is correctly gated at `billing.ts:107` and `docs/planning/RESOLVED.md` accurately describes the code as shipped while naming the Railway step as an outstanding user action — so `automatic_tax` has genuinely never been sent, and that remains a **(Dale)** item under P0 §2, not a code defect.
- [x] ~~**CLAUDE.md called `tts_soft`/`tts_cheerful` "inert"** — false, and dangerous next to "delete on sight."~~ **Fixed 2026-07-13.** They are live LLM prompt-style flags with dashboard toggles; deleting them would have removed two working features. HIPAA-residue sweep came back **clean**.

---

## 2026-08-29 — dashboard appointments/knowledge/analytics slice (53 → 38)

Moved AppointmentView family into `appointments/`, KnowledgeBaseView/KnowledgeSuggestions/ExplainAnswerView into `knowledge/`, AnalyticsView/UtilizationHeatmap/AIInsightsView into `analytics/`. One PR. Migration item stays open at 38 remaining loose `.tsx` files.

---

## 2026-08-29 — dashboard crm slice (57 → 53)

Moved CRMView and CRMIntegrationCard into `dashboard/components/crm/`. Migration item stays open at 53 remaining loose `.tsx` files.

---

## 2026-08-29 — dashboard records slice (61 → 57)

Moved AuditLogView and RecordHistoryModal into `dashboard/components/records/`. Migration item stays open at 57 remaining loose `.tsx` files.

---

## 2026-08-29 — dashboard team slice (66 → 61)

Moved SuperAdminDashboard, TenantCard, TenantCreateForm, TenantEditPanel into `dashboard/components/team/`. Migration item stays open at 61 remaining loose `.tsx` files.

---

## 2026-08-28 — dashboard billing slice (68 → 66)

Moved BillingView into `dashboard/components/billing/`. Migration item stays open at 66 remaining loose `.tsx` files.

---

## 2026-08-28 — dashboard communications slice (71 → 68)

Moved CommsSentView and ReminderDeliveryStats into `dashboard/components/communications/`. Migration item stays open at 68 remaining loose `.tsx` files.

---

## 2026-08-28 — dashboard layout shell slice (75 → 71)

Moved AppShell and OutlookLayout into `dashboard/components/layout/`. Migration item stays open at 71 remaining loose `.tsx` files.

---

## 2026-08-28 — dashboard auth slice (81 → 75)

Moved LoginView, ProfileView, FirstRunTour into `dashboard/components/auth/`. Migration item stays open at 75 remaining loose `.tsx` files.

---

## 2026-08-28 — recording disclaimer already composed, not a greeting column

Phase 2 item asked for `tenants.greeting` spoken verbatim from `index.ts`. That is the 2026-07-10 bug: a tenant First Message deleted the disclosure. Shipped path is `greeting.ts` composition + `call_disclosure` with attestation. Pin: `greeting.test.ts` default never says "recorded"/"training".

---

## 2026-08-28 — zero-vendor SMS alerts

`.github/workflows/zero-vendor-alerts.yml` + `scripts/zeroVendorAlerts.ts`. Evaluates ALERTS.md §3.9 on a single `/metrics` scrape (boot-lifetime ratio, not Prometheus `rate()`). Opens one `[zero-vendor]` GitHub issue on breach. `npx vitest run tests/scripts/zeroVendorAlerts.test.ts --run` → `5 passed (5)`.

---

## 2026-08-28 — dashboard ui primitives slice (89 → 81)

Moved VersionBadge, ErrorBoundary, DemoBanner, SetupProgressPill into `dashboard/components/ui/`. Migration item stays open at 81 remaining loose `.tsx` files.

---

## 2026-08-28 — refresh uncustomized tenant question trees

`copy_question_tree_templates_to_tenant` never overwrites existing trees, so `npm run trees:local` could not pick up the 2026-08-15 `qa_summary` reword. `--refresh-uncustomized` deletes and recopies only tenants whose trees are all still `is_customized = false`. One customized tree parks the whole tenant. `trees:local` now passes the flag.

`npx vitest run tests/questionTreeRoundTrip.test.ts --run` → `12 passed (12)`.

---

## 2026-08-28 — wrap-up is one question, not a 12s stack

Ending guidance in `checklistAgent.ts` now forbids combining a passed-along line, an email instruction, and "anything else" in one turn. Email stays `best_email`. COMPLETE wrap-up is only "Anything else I can help you with?" then `finish_call`. Pin: `checklistAgent.test.ts`. `npx vitest run src/checklist/checklistAgent.test.ts --run` → `75 passed (75)`.

---

## 2026-08-28 — salary display $k next to caller words

Job leads stored spoken pay as words. `shared/payRange.ts` `formatPayRangeDisplay` keeps verbatim and prefixes `$140–160k` when parseable. Wired in MessagesInbox Rate row and job-inquiry email bits. DB column unchanged.

`npx vitest run tests/shared/payRange.test.ts --run` → 5 passed.

---

## 2026-08-28 — ENABLE_OUTPUT_WATCHDOG is on; living docs said off

Dale confirmed Railway `secretary-hq-agent` Variables has `ENABLE_OUTPUT_WATCHDOG=true`. Agent env schema default was already ON (`undefined` → true; only the literal string `false` disables it). Living comments and playbook still said prod runs the flag OFF (true on 2026-07-17 / 2026-08-19). Comments, PLAYBOOK RULE 8.1/10.2, TODO, and the research remaining-gap text now match: default ON, Railway true. No runtime change.

Still open: Dale listening on a real call (filler vs stutter). CI cannot grade that.

Agent: `npx vitest run src/session/holdLines.test.ts src/session/watchdog.test.ts --run` → `Test Files  2 passed (2)` / `Tests  36 passed (36)`.

---

## 2026-08-28 — agent tools split by capability + reachability inventory

Closed the two P2 items that had to move together. `buildTools` is still the public API. Definitions moved from a 1,822-line `agent/src/tools.ts` into `agent/src/tools/{knowledge,messaging,identity,scheduling,verification,transfer,sms}.ts`. Nothing was deleted: tools the question-tree path does not offer are listed in `DEFINED_UNREACHABLE_ON_QUESTION_TREE` (KEEP-UNWIRED, including `find_caller_by_name` for the enumeration hole). `reachability.test.ts` fails CI if a new tool is defined without a tree wiring or a parked verdict.

Agent suite: `968 passed (968)`.

---

## 2026-08-28 — website-scan SSRF guard

Closed the P2 item filed from PR #367. `POST /knowledge/import-website` used to `fetch()` whatever URL an authenticated owner typed: Zod `.url()` accepts `file:` and `http://169.254.169.254`. `src/services/knowledge/siteScrape.ts` now gates every scrape (start URL, crawl links, redirect `Location`) behind `assertSafeSiteFetchUrl`: http/https only, block loopback/private/link-local literals, and block hostnames that resolve there. Redirects are `manual` so a public 302 cannot follow onto metadata.

Tests: `tests/services/knowledge/siteScrapeUrlGuard.test.ts` + a route case in `knowledge.importWebsite.test.ts`. Verified both directions: before the guard, fetch was called with `http://169.254.169.254/latest/meta-data/`; after, it is not. `npx vitest run tests/services/knowledge/siteScrapeUrlGuard.test.ts tests/routes/knowledge.importWebsite.test.ts --run` → `15 passed (15)`.

---

## 2026-08-21 — estimateCost unpriced-model miss is loud

Closed the item filed from PR #367. `src/services/aiCost.ts` `estimateCost` still returns 0 for an unknown model (ingest must not throw) but now increments `errors_total{event="ai_cost_model_unpriced"}` and logs the model name. The voice route already warned under that event; `recordAiCostEvent` did not. Priced model + zero tokens stays quiet.

Website-scan SSRF (owner-supplied URL, no host guard) was flagged on #367 as pre-existing; left as a live TODO rather than mixed into the extraction.

---

## 2026-08-13 — Live checklist presets + required-field overrides (#338, #339)

Closed ROADMAP Steps 8 and 9 slices 1–3. Prod is on `4610d10` (`/health` `started_at` 2026-08-13T14:00:35Z).

- **#338** `feat(runtime): ship live checklist presets and safe overrides` — three presets (`auto_shop_front_desk`, `salon_front_desk`, `local_service_front_desk`), `tenants.checklist_preset_id` + `checklist_overrides`, live `ChecklistAgent({ runtimeConfig })`, Business Settings → Call checklist. First `main` deploy SKIPPED (E2E npm-install flake); forced `serviceInstanceDeployV2` of `2a0894a`.
- **#339** `feat(runtime): enforce required checklist fields` — `required_node_ids` allowlist; `record_answer` refuses `declined:true`; `finish_call` stays shut; cannot mark the same field required and optional. Main CI green; Railway deployed all 3 services.

Still open on that roadmap: wording editor (deferred), preview/dry-run, Step 10 E2E journeys.

## 2026-08-03 — Project rename `ai-sec` → `secretary-hq` (repo, Railway, LiveKit, Telnyx, local Docker)

The GitHub repo was `ddemott/ai-sec` while the working directory, product, and domain were all `secretary-hq`. Renamed end-to-end. **Every layer below was renamed in lockstep with the system that owns the name — a repo-only rename would have left the docs describing a service that no longer answers to that name.**

- **GitHub** — `ddemott/ai-sec` → `ddemott/secretary-hq`; local `origin` set-url'd. GitHub redirects the old URL, so existing clones keep working. `scripts/simulate.sh`'s hardcoded `repo=` (the `ci` subcommand) had to move with it or `npm run ci:status` would query a name GitHub only redirects for.
- **Railway** — services `ai-sec` → `secretary-hq` and `ai-sec-agent` → `secretary-hq-agent` (`serviceUpdate`); generated domain `ai-sec-production.up.railway.app` → `secretary-hq-production.up.railway.app` (`serviceDomainUpdate`). **The domain rename is a hard cutover — the old hostname 404s the instant it changes**, there is no redirect, so all four consumers were repointed in the same pass: agent `BACKEND_URL`, backend `BACKEND_PUBLIC_URL` + `NEXT_PUBLIC_API_BASE_URL`, dashboard `NEXT_PUBLIC_API_BASE_URL`. The dashboard's is **build-time** (`NEXT_PUBLIC_`), so it kept calling the dead host until its rebuild landed — a var change alone is not enough. Verified: new host 200, old host 404, backend + dashboard deployments `SUCCESS`, `/health` `started_at` moved.
- **LiveKit** — agent name `ai-secretary-agent` → `secretary-hq-agent`. Done **without a code deploy**: `agent/src/index.ts` reads `process.env.AGENT_NAME ?? '<default>'`, so setting `AGENT_NAME` on the Railway service repointed the worker, and only then was dispatch rule `SDR_WEL49AwBB4NW` flipped. **Order matters — the worker must already answer to the new name before the rule asks for it, or inbound calls hit dead air.** Note `roomConfig.agents` is a list but dual-listing is NOT a zero-downtime trick: LiveKit dispatches *every* listed agent, so two names means two agents on one call. Verified with `simulate.sh status --env prod --deep` (real dispatch, 4/4 up).
- **Telnyx** — messaging profile `default-outbound` webhook repointed to the new host.
- **Local Docker** — container + volume `ai-sec-db` → `secretary-hq-db`. `COMPOSE_PROJECT_NAME=ai-sec` in `.env` also had to change or Compose keeps namespacing volumes `ai-sec_*`; that pin was missed on the first pass precisely because it lives in a gitignored file (see the grep lesson below). Renaming the volume means a **new, empty** volume — `postgres` and `test_db` were both rebuilt (179 migrations + seed each).
- **Code/docs** — log + Sentry service tags (`ai-sec-backend`/`-agent`/`-dashboard`), both package names, the `ai-sec:*` DOM CustomEvent names, and every doc/script reference.

**Deliberately NOT renamed:** `ai-secretary-nmlkkmgf.sip.livekit.cloud` — a LiveKit-assigned project subdomain, still the live SIP FQDN in Telnyx. It is not ours to rename; editing it in docs would only record a host that does not exist.

**Lesson — a `.gitignore`-aware grep will hide live config from a rename sweep.** The interactive `grep` here is a wrapper that passes `--ignore-files`, so repo-wide scans silently skipped every gitignored file. Three real misses survived several "clean" sweeps: `.env`'s `COMPOSE_PROJECT_NAME`, `.env.production`'s API base URL, and 15 stale paths/domains in `.claude/settings.local.json`. Use `command grep -rnI` (real grep) for any rename audit, and treat "the sweep came back empty" as evidence only after confirming what the tool declined to read.

**Found while renaming, unrelated to it, still open:** the **Stripe webhook was never registered** — prod `STRIPE_SECRET_KEY` is an `sk_test` key and the account has zero webhook endpoints, while `CLAUDE.md` documents the webhook URL as wired. Also corrected: `ARCHITECTURE.md`, `DIAGRAMS.md`, and an `agent/src/index.ts` comment all cited dispatch rule `SDR_if97ky4Zf7e6` as live, though `planning/RESOLVED.md` itself records it as deleted; the real rule is `SDR_WEL49AwBB4NW` / `thinkinghammer-dispatch` (the code comment also named `dynatire-dispatch`, a tenant removed 2026-06-03).

Verification: 5,032 tests green (backend 2,637 / agent 1,366 / dashboard 1,029), 3 typechecks clean, 3 builds clean, prod 4/4 on `simulate.sh status --env prod --deep`.

## 2026-07-03 — Verbal SMS-consent capture + docs-only CI fast path

- **Verbal SMS-consent capture on the call** (PR #178, `feat/verbal-sms-consent-capture`). Closed the "the agent asks, but a yes went nowhere" gap: it could *offer* SMS reminders, but nothing recorded consent, so `reminderProcessor` then skipped that number for `no_consent`. New agent-secret `POST /agent-tools/record-consent` → `INSERT INTO consent_records` (`consent_type='sms'`, `consent_given=true`, `consent_method='verbal'`, `consent_source='voice_call:<call_id>'`), phone normalized to match `checkConsent`'s send-time lookup; try/catch → soft failure (never 500 mid-call) + `reply.log.error`. New `record_sms_consent(phone)` agent tool (scheduling capability, 20th tool) + a prompt "Text reminders" block that delivers the four TCPA informational-consent disclosures (business name + appointment-only + "message and data rates may apply" + reply STOP), confirms the number, and records only on a clear yes. **Informational only — never marketing** (Dale's explicit scope). Real-DB companion `src/agentToolsRecordConsent.realdb.test.ts` (verbal yes → normalized `sms`/`verbal` row; no `call_id` → generic source; incomplete phone → nothing written). No prod migration (`consent_records` already exists). 10DLC carrier registration remains a separate Telnyx ops step.
- **Docs-only fast path** (PR #179, `chore/prepush-docs-only-skip`) — per Dale, docs-only changes shouldn't pay for the full suite. (1) Local pre-push hook (`scripts/example-pre-push-hook.sh`): reads the pushed refs from stdin and, for a single-ref push whose exact range is all docs (`*.md`/`docs/**`), skips the unit suite; multiple refs (`--all`), a deletion, or no stdin fall back to running everything; `checks` stays as a safety net. (2) CI (`.github/workflows/ci.yml`): replicated the `e2e` job's `dorny/paths-filter` into backend/dashboard/agent — docs-only PRs report all 4 required checks green without running migrations/seed/tsc/tests. The CLAUDE.md drift detector stays un-gated (it validates docs). This RESOLVED entry's own push is the first live exercise of the fast path.

## 2026-07-01 — Blind-spot P0 verification trio + 5 real bugs found-and-fixed (branch test/blindspot-p0-verification)

The three P0 testing items (source now folded into `docs/planning/TODO.md` "Verification blind spots"), all shipped in one branch (full audit doc: `docs/TEST_DB_AUDIT.md`):

- **Real-DB end-to-end booking integration test in CI** — `src/agentToolsBookingIntegration.test.ts`: real `/agent-tools/book-with-scheduling` route → `book_with_scheduling_atomic` RPC → real Postgres; asserts the stored row (UTC instant computed independently via Intl, assigned employee, status), tenant-local read-back, EMPLOYEE_NOT_SCHEDULED + TIMESLOT_OCCUPIED sad paths, and the serviceResolver ambiguous-`name` regression via `available-slots`. Mutation-verified (reverting the tz fix → 2 tests red). Runs in the existing CI backend job (real Postgres + `REQUIRE_DB_TESTS=1`).
- **Agent tool-selection eval** — `agent/scripts/sim-toolselect.ts` via `./scripts/simulate.sh toolselect`: replays the real `buildSystemPrompt` + real 20 tool schemas through `gpt-4o-mini`, feeds synthetic tool results, grades the chosen tool sequence (required-subsequence + forbidden set). 6 scripted-caller cases incl. the bug-#3 regression (`get_available_slots` → `book_with_scheduling`, never `book_appointment`). Baseline 6/6; on-demand (real OpenAI), not CI.
- **Mocked-DB test audit + real-DB companions** — every backend test mocking pg classified HIGH/MED/LOW in `docs/TEST_DB_AUDIT.md`; all 6 HIGH-risk gaps got companions: `analytics.realdb` (9), `routes/auditLog.realdb` (13), `versionHistory.realdb` (33), `voice.realdb` (11), `services/reminders/scheduleForAppointment.realdb` (7), `agentToolsCustomerSearch.realdb` (17).

Writing the companions surfaced 5 real bugs, all fixed same-day on the branch:

1. `/agent-tools/find-customer-by-name` ILIKE wildcard over-disclosure (`%` in a transcribed name dumped up to 5 address-book entries) → LIKE metacharacters escaped.
2. `GET /voice/history` unvalidated `limit`/`offset`/`customer_id` → pg NaN/22P02 500s → digits-only + `requireValidUUID` validation, clean 400s.
3. `scheduleForAppointment` double-seed (retry ⇒ duplicate reminder bundle ⇒ double-reminded customers) → DB-level idempotency: partial unique index (migration `20260701020000`, one `scheduled` row per appointment+type) + `ON CONFLICT DO NOTHING`; race-safe under concurrency, no cross-statement locks (an advisory-lock transaction attempt deadlocked the appointments cascade in E2E); reschedule (cancel-then-seed) unaffected.
4. Version-history rot from the 2026-05 PK renames: `restore_fields_from_version()` + `copy_fields_between_records()` queried bare `id` → 42703 on EVERY table (field-restore/copy dead in prod); deleted-records list hardcoded `t.name, t.phone` → 500 on 4/6 tables. → migration `20260701010000_fix_version_rpc_pk_names.sql` (PK-aware via information_schema, same pattern as `soft_delete_record`) + per-table display columns in the route.
5. Restore stringified jsonb into text columns (only reachable once #4 was fixed — restored name came back literally `"Versioned Vera"` with quotes) → `jsonb_populate_record` decode in the same migration.
6. `/agent-tools/find-customer-by-name` over-disclosure of full phone numbers / one-letter sweeps → mask `phone` in route output and return empty on single-character probes; agent tool docs/tests updated so the confirmation path still works without reading full numbers aloud.

Verification: all new suites green against real local Postgres (migration `APPLIED=1`, baseline regenerated via `npm run db:baseline`), mutation test proved the tz guard bites, mocked suites unchanged-green, `tsc`/eslint/prettier clean.

---

## 2026-06-23 — Mechanical doc consistency hygiene pass (route counts + migrations + partial hosting refs)

- Synchronized all stale "26/27 route modules" and "140 migrations" references in secondary docs (root README.md, dashboard/README.md, docs/ARCHITECTURE.md, docs/DIAGRAMS.md, docs/diagrams/01-deployment-topology.mmd) to the canonical current values maintained in CLAUDE.md (29 route modules, 142 migrations) and enforced by `scripts/verify-claude-md.ts`.
- Refreshed the outdated enumerated list in docs/ARCHITECTURE.md §9.1 to accurately reflect current registered routes (incl. post-2026-06 additions: exportData for tenant portability, auditLog for owner history, selfService, health extraction; competitor CRMs removal noted).
- One Vercel "to be deployed" reference proactively aligned in ARCHITECTURE.md as part of the pass (full Vercel→Railway hosting alignment is follow-up mechanical task).
- Reworded the eslint-disable header comment across 38 files (35 `src/`+`shared/` modules, 3 `*.test.ts`) from "REFACTORING_TODO.md item 10" to "historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details)" — comment-only, no logic change.
- **Verification as proof (per CODING_STANDARDS review checklist + user instruction on tests/coverage for changes)**: 
  - Pre/post exhaustive `grep` for stale strings across *.md + *.mmd → 0 remaining stragglers reported.
  - Re-ran `npx tsx scripts/verify-claude-md.ts` (clean both times).
  - Re-ran `npm run format:check` (clean).
  - Re-ran full `npx tsc --noEmit` (root backend + `cd dashboard` + agent) — all clean, no output.
  - Re-ran `npm run checks` (format:check + lint --max-warnings 0 + all tsc) — exit 0, all gates green.
  - No behavioral .ts changes (the `.ts` edits are comment-only eslint-header rewords), so no new unit tests or 5W test blocks required (per AGENTS.md mechanical scope); the project's automated gates + full sweeps + 0-count proofs serve as the supporting verification that the consistency edits are safe and accurate. Full backend suite re-run green against test_db (1935 passed, 0 failed, 0 skipped). Updated RESOLVED per checklist.
- This keeps docs in sync with reality after the analytics/export/audit/RAG batch (PRs #56-59, #64-67) without introducing drift that would fail the guard on next PR.
- **PR #72 Copilot-review follow-up**: the sweep missed two agent tool-count mentions outside CLAUDE.md — fixed `README.md` ("12 tools" → "17 voice tools", phrased to note `transfer_call` uses SIP REFER not `/agent-tools/*`) and `docs/ARCHITECTURE.md` §0 ("12 voice tools" → 17). Also reworded the README ASCII diagram label (`Fastify /agent-tools/* (29 route modules)` → `Fastify backend (29 route modules; agent calls /agent-tools/*)` — the 29 is the whole backend, not the `/agent-tools/*` prefix), bumped the `docs/planning/TODO.md` GAPS cross-ref date (GAPS.md was refreshed to 2026-06-23 in this PR), de-conflicted the `docs/DEPLOYMENT.md` Supabase-CLI bullet (drop global install → `npx supabase` / `npm run db:migrate`), and disambiguated bare doc references (`see RESOLVED` → `planning/RESOLVED.md`; `per CLAUDE/HANDOFF` → `` `CLAUDE.md` / `HANDOFF.md` ``).

---

## 2026-05-29 — Improvement ideas triage + quick-win batch

- **IMPROVEMENT_IDEAS.md restructured** — verified all items against current code; 3 stale items closed (KB alert, shared Tenant type, SA tests already done); 1 item closed as invalid (parseDateRange in calendar.ts — no date params exist there); remaining items reworded to bite-size format with file:line, one-sentence do, concise done-when, size+impact.
- **UUID_RE → requireValidUUID in mappings.ts** — removed file-local `UUID_RE` regex; all 4 assign/unassign handlers now use `requireValidUUID` from routeHelpers. Tests updated to assert per-param error messages.
- **Tenant reorder batched** — replaced N-query for-loop with single `UPDATE … FROM unnest($1::uuid[], $2::int[])`. Reorder test updated to assert 1 query with correct array params.
- **CRM auth-init success envelope** — all 4 CRM providers (jobber, hubspot, square, servicetitan) now return `{ success: true, authUrl }` instead of `{ url }`. Updated: 4 backend routes, `api.ts` (4 type annotations), `CRMIntegrationCard` interface + `res.authUrl`. 4 auth test assertions updated.

---

## 2026 Early Reviews (March–April) — Bug & UX Cleanup (Historical)

During March–April 2026 code reviews, 72 bugs and 47 UX/a11y issues were tracked in a standalone bug log (the former `docs/BUGS.md`, since removed).

**Outcome:** All resolved (71 fixed, 2 not-a-bug, 47 UX issues resolved).

The standalone detailed log and per-session journals (`docs/sessions/`, `docs/BUGS.md`) have since been removed; the summary retained in this file is the surviving historical record.

This work established many of the consistency, accessibility, and empty-state patterns still used in the dashboard.

---

## 2026-05-28 — E2E flake fixes (timing synchronization in 3 tests)

Three known Playwright flakes fixed by replacing `waitForTimeout` with explicit DOM + network waits.

**1. `booking-alignment.spec.ts:295` — List sub-tab popover cancel**
- Root cause: fixed `waitForTimeout(800)` after clicking the Schedule tab wasn't long enough for `NewSchedulerView` (and its `view-tab-list` tab button) to mount. If the click landed before the button appeared in the DOM, Playwright would time out looking for the element. The Refresh button conditional check (`isVisible` with 2s grace) also silently skipped on slow renders, leaving stale data.
- Fix: replaced `waitForTimeout(800)` with `expect(view-tab-list).toBeVisible({ timeout: 8000 })`; replaced the conditional Refresh click with `expect(refreshBtn).toBeVisible({ timeout: 8000 })` + `refreshBtn.click()` + `waitForLoadState('networkidle')`.
- Same fix applied to `openAppointmentPopoverFromList` helper in `appointment-cancel-ui.spec.ts` (waited for `appointment-list-view` which is absent when the list is empty — now waits for the Refresh button which is always in the list header).

**2 & 3. `wizard-welcome-auto-open.spec.ts` — welcome dialog auto-open timing**
- Root cause: `switchToFreshTenant` used `waitForTimeout(600)` + `waitForTimeout(2000)` (total 2.6s) for `DashboardHome.loadData()` (6 parallel API calls) to settle. If the backend was under load or cold, loading took longer than 2s and the `AUTO_OPEN` effect hadn't fired when the assertions ran (even with an 8s assertion timeout, that wasn't the issue — the test assertions started before the load was done).
- Fix: removed `waitForTimeout(600)` (redundant after `page.goto` which waits for `'load'` by default) and replaced `waitForTimeout(2000)` with `page.waitForLoadState('networkidle')`. `networkidle` fires when all 6 `loadData()` responses have returned and there's 500ms of quiet — at that point `loading=false` is guaranteed, and the auto-open effect fires synchronously in the same render cycle.

---

## 2026-05-21 — Unauthenticated cross-tenant data access via `?tenant_id=` (CVE-class) + threadpool fix

**Two findings, fixed together; kept in separate commits.**

### Security: anonymous tenant-data access (read + write + delete)

While verifying that login worked end-to-end, an unauthenticated probe surfaced a serious hole:

```
GET /services?tenant_id=<any-tenant-uuid>     # no Authorization header → HTTP 200 + that tenant's data
DELETE /services/<id>/delete?tenant_id=<uuid>  # no auth → reached handler (404 on fake id, would delete a real one)
POST /services/create  {tenant_id:<uuid>,...}  # no auth → reached handler
```

**Cause chain:** (1) `registerJwtAuthHook` lets a request with no `Authorization: Bearer` header proceed anonymously (by design — handlers self-gate). (2) `tenantMiddleware` resolved the request tenant as `candidate || jwtTenant`, where `candidate` is the user-supplied `?tenant_id=`/body value; the 2026-05-06 cross-tenant override guard only fired when a `jwtTenant` already existed, so for an anonymous request it was skipped and the attacker-supplied tenant was trusted. (3) `requireTenantId` also fell back to `req.body.tenant_id` directly. (4) `withTenantClient` set RLS scope to the attacker-chosen tenant and returned its rows. RLS faithfully scoped to whatever tenant was set — RLS was never authentication, and there was no JWT to bound it. The 2026-05-06 isolation probe only tested an *authenticated* user overriding to another tenant; it never tested the *no-token-at-all* case, so this stayed open.

**Fix (`src/middleware.ts`):**
- `tenantMiddleware` now rejects any non-public, non-tenant-exempt request with no `req.auth` → **401**, *before* any tenant resolution can trust a user-supplied `tenant_id`. Public routes (login, password reset, demo, metrics, OAuth callbacks, HMAC-signed webhooks) and secret-authed `/agent-tools/*` (tenant-exempt, returns earlier) are unaffected.
- `requireTenantId` no longer falls back to `req.body.tenant_id` (trusts only the middleware-validated `req.tenantId`) and returns **401** ("Authentication required") when there is no authenticated session, rather than the misleading **400**.

**Verification:** live re-probe of GET/POST/DELETE anonymously → all **401**; authed own-tenant → 200; authed cross-tenant override → 403 (existing guard intact); public `/health` → 200. Added Probe 8 (5 cases: GET/POST/DELETE anonymous + body-injection + positive control) to `src/multi-tenant-isolation.test.ts` (now 39 probes). Full backend suite updated — 23 tests across 7 files had been pinning the old behavior (the misleading 400, the removed body fallback, and one test — `middleware.test.ts > "permits anonymous requests … to fall through"` — that literally encoded the hole); all rewritten to assert the correct fail-closed behavior, not weakened. Documented in `docs/SECURITY.md`.

### Perf: per-request `fs.readFileSync` on public routes

`GET /` and `GET /demo` re-read their HTML from disk on every request (blocking the event loop; spammable on unauthenticated routes). Moved the reads to module load (`LANDING_HTML` / `DEMO_HTML` constants); `{{DASHBOARD_URL}}` token still substituted per-request. `/demo` dropped from a per-request fs read to ~0.6ms.

### Production hardening + gap fixes (same day, 12 commits total `2461f08..cd185dd`, CI green, live in prod)

- **Deep `/ready`** — DB ping + pool saturation stats (`total/idle/waiting`), 503 when DB unreachable. `/health` stays shallow liveness. A monitoring signal, not a traffic gate.
- **Pool fail-fast** — `connectionTimeoutMillis=5000`: a checkout that can't get a slot under load now errors fast (→ `errors_total`) instead of hanging forever. The server-side GUCs (`statement/lock/idle-txn`) don't cap client checkout; this does.
- **Alerting visibility** — `withHandler`'s unhandled-error branch routes through `logError` so unknown route errors (incl. pool-checkout timeouts) increment `errors_total` and reach Sentry; previously a raw `req.log.error` did neither.
- **Gap 3 — bad client input → 400, not 500** — `withHandler` maps Postgres class-22 data exceptions (`22P02` etc., e.g. a non-UUID `:id`) to 400 and does NOT tick `errors_total`. Fixes ~12 unvalidated `:id` routes in one place + stops client garbage polluting 5xx/error-rate alerts. Verified live (`GET /records/customers/not-a-uuid/history` 500→400).
- **Gap 1A — agent graceful recovery** — `agent/src/prompt.ts` "Technical glitches" section: the LLM never speaks raw error text (`500`/`timed out`/`backend`), recovers in-character, never stalls silently on a backend tool failure. (Exact wording is owner-tunable.)
- **Gap 1 — agent dead-air guard** — the agent `entry` session-build/start/greeting is wrapped in try/catch → `runFallback`; a `session.start`/plugin-init throw now degrades to a "sorry" message instead of a silent job crash.
- **Testability extractions** — `jsonContentTypeParser` (+ bad-JSON now 400, was 500) and `readinessHandler` extracted to unit-tested modules; the route-test harness used a *different* parser, so the real one had never been covered (it's the one that once hung every JSON POST).
- **CI** — added an `agent` job (tsc + 99 tests; previously ungated entirely). E2E coverage added (anonymous-tenant 401, `/ready`, malformed-JSON). Fixed the `verify:claude-md` drift (migration count 122→126) that had main CI red ~3 days — first all-green 3-job run.
- **UX Cluster-B defect 1** — `SetupWizard/StepServices` duration field is clearable again (was forced to `0` by `parseInt||0`); 0 renders empty, save still rejects it. +regression spec.
- **UX Cluster-B defect 2** — `SuperAdminDashboard` business-search input was uncontrolled/dead; now filters the sidebar cards by name with a no-match message, and disables drag-reorder while filtering (new `draggable` prop on `TenantCard` — reorder is full-array-index based, so a filtered subset would corrupt order). +3 tests.
- **UX Cluster-B defect 3** — `SetupWizard` template-seed failure was a silent `console.warn` that left setup half-seeded with no recovery. Now: seed logic hoisted to a `runSeed` callback that **reconciles by name-diff** (creates only missing starter services, captured once in `seedTargetRef` so a user's own services aren't topped-up) → a partial-failure retry can finish (the old `services.length === 0` gate made retry impossible). Failure surfaces a Retry banner in the wizard body. +2 tests (failure surfaces banner; retry re-invokes + clears). All three Cluster-B defects now closed.
- **Mechanical refactor hygiene (REFACTORING_TODO #1)** — Eliminated duplication of voice CRM context types (`CustomerNote`, `VoiceSession*`, `CustomerContext`, `AppointmentSummary`/`History`, `formatContextForAI`) that lived in both `src/types/voiceCrm.ts` and `dashboard/lib/types.ts`. Single source moved to new `shared/voiceCrm.ts` (cross-runtime, no deps). Backend wrapper + dashboard re-exports preserve all public APIs. Both `tsc --noEmit` clean; zero stragglers per grep. CLAUDE.md + README.md + REFACTORING_TODO.md updated. Demonstrates the "extract after 3–4 consumers" + "shared/ for pure cross-boundary logic" principle in action.

**Still open (TODO → Production hardening):** P0 gate Railway deploy on CI green, P1 E2E-in-CI (needs Actions secrets), P2 healthcheck→`/ready`, Railway `METRICS_TOKEN`/`BETTER_STACK_TOKEN` + alert rules, gap-1 B/C, UX Cluster-B 2/3.

---

## 2026-05-17 — Production migration apply: prod brought from 86 → 122 migrations

Closes the long-standing **IN FLIGHT (prod-apply)** TODO item. Pre-apply, the production Supabase DB was 9 days behind `main` (latest applied was `20260508000001`, latest in repo was `20260514000000`). The TODO listed 4 dated groups (~9 files) but a `schema_migrations` diff against the filesystem showed **36 pending**, not 9 — the gap included the 26-file May-12 PK rename sweep and 3 May-9 RLS/error fixes that had never been called out separately.

**What got applied (36 migrations, version order):**

- **3 × May-9 fixes** — `password_resets_rls` (missing RLS on the table — direct security gap), `force_rls_voice_sessions_record_versions` (defense-in-depth FORCE RLS), `restore_granular_booking_errors` (re-adds specific error codes that an earlier RPC recreate had clobbered).
- **26 × May-12 PK rename sweep** — `ALTER TABLE … RENAME COLUMN id TO <table_singular>_id` across every domain entity table (record_versions, tenant_skills, reminder_schedules, consent_records, opt_out_records, voice_sessions, tenant_docs, users, services, resources, employees, employee_schedule, appointments, customers, tenants, user_feedback, soft_reservations, audit_log, unanswered_questions, phone_verifications, password_resets, call_transcripts, call_summaries, entity_sync_map) + 2 auto-version-trigger PK-aware recreates. Implements the PK column-name convention captured in CLAUDE.md (every single-column PK named `<table_singular>_id`, not bare `id`).
- **1 × May-11** — `employees_services_tenant_fk_cascade` (adds the missing `ON DELETE CASCADE` to `employees.tenant_id` + `services.tenant_id` — tenant delete previously left orphan rows; 85 orphans on local pre-fix).
- **5 × May-13** — `service_employee_tenant_fk_cascade` (same cascade fix; `ADD COLUMN IF NOT EXISTS` had silently no-op'd the original cascade clause in March), `tenants_notification_preferences` (adds `sms_enabled` + `email_enabled` columns — `PostgresTenantConfigService` was already mapping these column names but the schema lacked them, latent crash), `opt_out_records_fk_rename` (PK-rename follow-up: `original_consent_id` → `original_consent_record_id`), `deleted_customers_view_recreate` (rebinds the view's public columns after the customers PK rename), `soft_delete_restore_pk_aware` (`soft_delete_record()` / `restore_deleted_record()` now look up the PK column name from `information_schema` instead of hardcoding `id` — self-healing across future renames).
- **2 × May-01 → already on prod**, skipped (atomic booking GiST exclusion constraints + RPC exception wrapper — these had been applied earlier).
- **1 × May-14** — `reminder_retry_columns` (`retry_count INT DEFAULT 0` + `next_retry_at TIMESTAMPTZ NULL` on `reminder_schedules`, plus partial index — unlocks the retry-on-transient-failure worker logic that shipped May 14 in `src/workers/reminderScheduler.ts`).

**How the apply ran:**

- `./scripts/preflight-cloud.sh "$DATABASE_URL"` against `.env.production` first: 8 passed, 0 failed, 2 warnings (`pg_net` extension not enabled — irrelevant for these migrations; 31 existing tables — expected, not a fresh DB). Direct connection on port 5432 (not pooler 6543) confirmed.
- `./scripts/setup-db.sh "$DATABASE_URL"` — script reads `schema_migrations` once, then applies each pending file inside its own `--single-transaction` with `ON_ERROR_STOP=1`. Already-applied files SKIP cleanly. Stop-on-first-failure (script default; pass `--continue-on-error` to override, not used here).
- Output streamed: 86 SKIPs + 36 APPLYs + `APPLIED=36 SKIPPED=86 FAILED=0`. Total wall-clock under 30 seconds against the us-west-2 Supabase pooler endpoint.

**Post-apply verification (six invariants, all green):**

| Invariant | Expected | Actual |
|---|---|---|
| `schema_migrations` row count | 122 | 122 |
| GiST exclusion constraints on `appointments` | 2 (`_no_resource_overlap`, `_no_employee_overlap`) | both present |
| `reminder_schedules.retry_count` + `next_retry_at` | both | both |
| `tenants.sms_enabled` + `email_enabled` | both | both |
| PK renames took (sampled customers, appointments, tenants) | `<table>_id`, not `id` | all three renamed |
| FK cascade type on `employees` / `services` / `service_employee` `tenant_id_fkey` | `'c'` | all three `'c'` |

Backend smoke: `curl https://secretary-hq-production.up.railway.app/health` → `HTTP 200` in 301ms post-apply. Backend code was already deployed assuming the renamed columns (local tests pass against them), so this apply brings prod-DB column shape into line with prod-code expectations — prior to this, any code path PKing renamed tables by name would have errored on prod.

**Discovery-vs-spec gap that bears calling out:** the TODO underspecified scope by 4x (9 files listed, 36 actually pending). The 27-file delta wasn't dropped on purpose — it was the cumulative result of two work weeks of merges where new migrations were added to the filesystem without the TODO being amended. Going forward, the safer pattern is to make `setup-db.sh` itself the source of truth (its `APPLIED_VERSIONS` query + filesystem diff) rather than a hand-maintained list in TODO.md.

**Still IN FLIGHT for Phase 13 launch (unchanged):** Telnyx PSTN unblock, `DASHBOARD_URL` + `SENTRY_DSN` env vars on Railway, browser-verify role gating + invite flow.

---

## 2026-05-17 — UX backlog: B3 + C3 + D1 + D3 + D4 + E3 (Phone Assistant KB, Home New Booking, wizard welcome, default-resource auto-seed, persistent setup-progress pill, active-call badge)

Closes six items from the 2026-05-16 `/ux-expert` audit plus the Phase 13 first-run guided tour:

- **B3** — Knowledge Base sub-tab moved from My Business → Phone Assistant. Sub-tab order under Phone Assistant is now Persona → Knowledge Base → Analytics (setup → setup → outcome). `'knowledge'` removed from `MyBusinessView`'s `VALID_SUB_TABS` — stale `?subtab=knowledge` bookmarks land on Services.
- **C3** — Primary "New Booking" button on Home. QuickBookPanel state hoisted into `DashboardHome`; `Api.customers.list` added to the `Promise.allSettled` batch; button is `disabled` when tenant needs setup so empty pickers can't look like a bug. Front-desk decision count for "book a call-in": 8+ (audit) → 3 (Quick Book hoisted) → 1.
- **D1** — Welcome screen ahead of `WizardModeChooser`. New `WizardWelcome` component sets scope ("~10 minutes from going live") and offers an explicit "I'll set up later, just show me around" exit before the binary solo/team fork. Wired into both auto-open (DashboardHome, new-tenant landing) and explicit-open (MyBusinessView Setup Assistant button) paths. Re-entry via the post-dismiss "Open Setup Assistant" banner skips welcome — the user has already chosen.
- **D3** — Auto-create default resource for 1-location team wizards. Extended the team wizard's existing `seedFromTemplate` effect to also create one resource when `resources.length === 0` on open. Vocab-driven name matches the SoloWizard finalize formula: `"Main Location"` for generic templates, `"<resource_label> 1"` otherwise (e.g. `"Bay 1"`, `"Chair 1"`, `"Truck 1"`). The "No resources yet" empty state in StepResources never shows for fresh tenants now — owners can rename, add more, or delete-and-replace, but the manual-create friction is gone for the common single-location case.
- **Coding standards: ESLint + Prettier adoption + CODING_STANDARDS.md expansion.** Installed `prettier@^3.3.3` across backend / agent / dashboard with a shared `.prettierrc.json` at repo root (semi: true, single quotes, 100 width, JSX double quotes, ES5 trailing commas) + `.prettierignore` covering build artifacts, `supabase/migrations/`, and historical post-mortem docs. Installed `@typescript-eslint@^7.18.0` for backend + agent (dashboard already had it transitively via `eslint-config-next`); all three projects now extend `plugin:@typescript-eslint/recommended-type-checked` — the official preset from the TypeScript team that uses the full type-checker for rules like `no-floating-promises`, `no-misused-promises`, `consistent-type-imports`. Created `tsconfig.eslint.json` (extends `tsconfig.json`, adds `scripts/` + `tests/` + test files) so typed lint covers everything without polluting the build graph. All rules land as `warn` initially so existing surface is visible without blocking CI; promotion-to-error per family tracked as cleanup TODOs. `CODING_STANDARDS.md` (184 → 626 lines) gained: **Tooling baseline** (with published-standards citations — typescript-eslint, Effective TypeScript, TS Handbook), **Testing conventions** (5W + HAPPY/SAD + isolation), **Backend route conventions** (`withHandler`, response envelope, `assertRowAffected`, Zod, tenant isolation), **Dashboard conventions** (Api namespacing, hook usage, component shape, `EmptyState`), **Commit message conventions** (Conventional Commits), **Code-review checklist**, **Formatting** (Prettier as enforcer + per-setting rationale), **Function and file size** (soft heuristics), **Pattern guidance** (composition over inheritance, hooks not HOCs, throw `AppError` not Results, flat services until 3rd caller). Verified: dashboard 680/680, backend 1910/1910, agent 91/91, all three tsc clean, all three `npm run lint` exit 0.
- **Trim CLAUDE.md** (154 → 125 lines, ~19% reduction). Removed: the Framework Migrations section (replaced with a one-line pointer to `docs/FRAMEWORK_MIGRATIONS.md`), the "Two persistent in-flight items" block (duplicated `docs/planning/TODO.md`), the "Migrated, Not Yet Wired" section (`DatabaseTenantConfigService`, `ConsentRecord`/`OptOutRecord` — belong in TODO.md as deletion candidates), the "Test-skip honesty" + "Sentry error monitoring" narrative blocks (one-time-fix history, already in `planning/RESOLVED.md`), and `/src/routes`/`/src/services`/`/src/types`/`/shared`/`/supabase/seed.sql`/`/docs`/`/certs` entries in Key Directories (derivable from the filesystem). Collapsed the 8-line Railway Deployment section to 4 lines pointing at `docs/DEPLOYMENT.md` (kept the prod URL, phone number, and webhook URL since those are commonly-referenced). Kept all high-signal content: Build Principles, Database Key Details (RLS, booking RPCs, ID + PK conventions), Code Conventions, `tenantMiddleware` 403-enforcement rule, tenant IDs / login / ports. Drift detector `npx tsx scripts/verify-claude-md.ts` still clean, 25/25 drift-detector unit tests still pass.
- **B1** — Merged "Service Assignments" (SkillMatrixView, grid) and "Skill Map" (SkillRelationshipMap, node graph) into a single My Team → Service Assignments sub-tab via the new `SkillAssignmentsView` wrapper with a Grid/Map toggle in the top-right. Both views operate on the same `service_employee` + `service_resource` mapping data at different zoom levels — keeping them as separate tabs was H4 (consistency and standards) noise. Active view persists to `?view=grid|map`; stale `?subtab=skill-map` bookmarks are normalized on mount to `?subtab=skills&view=map`. Switching off the merged tab discards the view override so the next visit defaults to Grid (the bulk-edit affordance most owners reach for first).
- **E2** — Consistent empty-state pattern across views. New `components/ui/EmptyState.tsx` primitive (icon + title + description + action slot, `centered` / `compact` variants). Migrated 4 high-visibility callsites: `AnalyticsView` ("No booking data yet"), `CRMView` ("No customers yet"), `NewSchedulerView` ("No staff to display" — preserved `data-testid="scheduler-empty"` for E2E hooks), `TeamAccessView` ("No team logins yet"). Left intentional drop-zone styled empties alone (`KnowledgeBaseView` upload zone, `SkillManagementView` skill grid, wizard internal steps) — they communicate "drop something here" not "you have nothing." Standardizes the H4 (consistency and standards) violation without flattening intentional distinctions.
- **First-run guided tour** (Phase 13 launch-blocker) — `FirstRunTour` overview modal that fires the first time a tenant lands on Home after completing the setup wizard. Single-modal design (not coachmark/spotlight) for v1: lists the five primary tabs (Schedule, Customers, Calls, My Business, Phone Assistant) with one-line descriptions and "jump to tab" clickable cards. Trigger: the Done button on both `SetupWizard` step 7 and `SoloWizard` step 3 calls `markFirstRunTourPending(tenantId)`, which writes `firstRunTour_<tenantId>` = 'pending' to localStorage. The tour reads on mount, sets the flag to 'shown' immediately to prevent StrictMode/re-render replays, and renders. Per-tenant gating so a super-admin managing many tenants sees the tour once per tenant.
- **E3** — Active-call badge on the Calls tab. Mirrors the unanswered-questions badge on the AI Insights tab: fetch `Api.voice.getActiveCalls(tenantId)` on mount + tab change, render a small numeric pill on the Calls tab when `total > 0`. Uses `var(--danger)` with `animate-pulse` (vs. the KB badge's calm `var(--accent)`) so a live call is visually distinct from "unanswered questions piled up." Rendered on both desktop FolderTabBar and mobile bottom-nav.
- **D4** — Persistent "Setup: N of 6 done" pill in OutlookLayout's top utility row (next to theme picker). New `useSetupProgress` hook counts six wizard-step proxies (services / resources / active employees / shifts in `employee_schedule` next 30d / `service_employee` mappings / auto-credited "Look it over" when steps 1-5 done). Auto-dismisses at 6/6. Click pushes `?tab=dashboard&wizard=open` and dispatches popstate; `DashboardHome` consumes the param on mount and force-opens the wizard past the welcome (pill clicks are second-touch — user already saw welcome on auto-open). Refetch via `notifySetupProgressChanged` window event, dispatched from both wizard-close handlers so the pill vanishes the same tick setup completes.

Verified: backend 1910/1910, dashboard 655/655 (+21 from D1+D4: 5 WizardWelcome + 4 DashboardHome staging + 7 useSetupProgress + 5 SetupProgressPill), agent 91/91, E2E 99 passed / 7 skipped (+6 cases on wizard-welcome-auto-open.spec.ts: 4 D1 auto-open + 1 D4 pill flow). Zero TS errors across all three projects.

Bug caught during D4 E2E: first pass pushed `tab=home` from the pill but the internal tab id is `dashboard` (the FolderTab label says "Home" but `VALID_TABS` lists `'dashboard'`). The popstate listener silently ignored the unknown tab, leaving the URL updated and the user stranded on Schedule. Spotted from the test-failure screenshot showing the pill rendering correctly but no tab change.

---

## 2026-05-14 — Per-tenant SMS rate limiter + 429 retry-policy carve-out

Closes TODO Phase 5 Ops "Rate limiting for SMS sends." Pre-fix the project relied entirely on the legacy SMS provider's account-wide throttle to bound SMS volume — a single tenant batching 200 reminders could exhaust the per-second budget for everyone else on the same account. (Legacy SMS provider support fully removed 2026-06; Telnyx is the only provider.) New behavior caps each tenant individually so a noisy tenant only slows itself down.

**Implementation:**

- New `src/services/communications/smsRateLimit.ts`:
  - `SmsRateLimiter` class — token bucket per `tenantId`, refilled lazily on each `acquire()` call based on elapsed wall-clock time.
  - Defaults: capacity=60, refillRate=1/sec (matches the TODO spec line "1 SMS/sec, 60/min"). Both env-configurable via `SMS_RATE_LIMIT_CAPACITY` / `SMS_RATE_LIMIT_REFILL_PER_SEC` for production tuning without a code change.
  - `acquire(tenantId)` throws `RateLimitedError` with `status: 429` and `retryAfterMs` (computed from bucket state — how long until the next whole token).
  - `tryAcquire(tenantId)` is the boolean alternative for call sites that prefer a flag.
  - Fresh tenants start with a full bucket so a small first send doesn't immediately rate-limit.
  - Defensive: a clock running backwards (NTP adjustment, DST boundary) doesn't refill the bucket.
  - Singleton `smsRateLimiter` shared across the process; tests construct fresh instances for isolation.

- Wiring in `src/services/communications/smsService.ts`:
  - `SMSService.sendSMS` calls `smsRateLimiter.acquire(tenantId)` after the consent check, before the provider call. On `RateLimitedError`, re-throws so the worker's retry policy sees the structured error.
  - `sendSystemSMS` deliberately does NOT rate-limit — opt-out confirmations are themselves bounded by inbound STOP/UNSUBSCRIBE volume, and dropping one would leave a customer wondering whether their opt-out took effect.

- Retry policy carve-out in `src/services/reminders/retryPolicy.ts`:
  - `isRetryable` now special-cases HTTP 429 as retryable before applying the generic "4xx → don't retry" rule. 429 is HTTP's canonical "wait and retry" signal — both the new in-process limiter and the (then) legacy provider's external throttle emit it. (Legacy SMS provider support fully removed 2026-06; Telnyx is the only provider.) Without this carve-out the reminder retry policy would mark rate-limited rows failed immediately, defeating the whole feature.

**Composition with retry logic (yesterday's commit):** rate-limited send → `RateLimitedError` (status 429) → reminder retry policy sees retryable → row's `retry_count` increments + `next_retry_at` set to now + 5/30/120 min → worker picks up after backoff → bucket has likely refilled → send succeeds. Zero new error plumbing required.

**Tests added** (+10 backend total):

- `src/services/communications/smsRateLimit.test.ts` (9 unit tests): fresh-bucket-full; drain-and-block at capacity; refill-rate math; capacity-cap (quiet tenants don't accumulate unbounded budget); RateLimitedError carries status=429 + retryAfterMs; **separate-tenants-have-independent-buckets** (load-bearing — the entire point of the feature); tryAcquire boolean shape; reset() for tests; clock-going-backwards defense.
- `src/services/reminders/retryPolicy.test.ts` (+1 test): 429 retryable carve-out. Existing 4xx-non-retryable test pinned the inverse — together they document the exact policy line.

**Configuration knobs for production tuning** (no code change needed):

- `SMS_RATE_LIMIT_CAPACITY` — max burst size (default 60). Raise for tenants with legitimate bulk-send needs.
- `SMS_RATE_LIMIT_REFILL_PER_SEC` — sustained rate (default 1.0). Raise to allow more sustained throughput per tenant.

**After-state:** backend 1,893 → 1,903 (+10). Zero TS errors. Drift detector clean. No migration needed — pure in-memory rate limiting.

---

## 2026-05-14 — Beta customer onboarding guide

Closes TODO Pre-launch hardening "Beta customer onboarding guide" — pre-fix the next beta customer would have needed a screen-share with the founder to get from "I'd like to try this" to "my voice AI is taking real calls." Now `docs/BETA_ONBOARDING.md` (~280 lines) walks through it.

**Contents:**

1. Pre-flight checklist — 8 items to collect before Day 1 (business name, timezone, employees + phones, services + duration/price, resources, weekly hours, skill-service mapping, policy answers). Explicitly flags timezone as "get this right on Day 1 — changing later requires re-converting historical timestamps."
2. Dashboard tab tour — the 4 primary tabs (Home / Schedule / Customers / Calls) + the 3 Back Office sub-tabs (My Business / My Team / AI & Knowledge), with what each is for.
3. Setup wizard — all 7 steps (Business type → Employees → Resources → Services → Assignments → Shifts → Go live) with what each step asks for and the most common mistakes (skipping shifts, service-skill mismatch, wrong timezone).
4. First test call — 4 scripted scenarios (book an appointment, ask a policy question, try an unavailable time, try a service you don't offer) with the expected AI behavior for each.
5. Knowledge base setup — the 9 policy categories with the questions to fill in first per category. PDF/doc upload path noted.
6. Daily workflow — the 5-min morning check (Home → flagged calls → mark-off-today). Frames most days as "I open Home and that's it; the AI handles everything else."
7. Weekly Copy Week — explains the date-based `employee_schedule` model + the Friday-afternoon copy-forward ritual. Includes the failure symptom (>4-week-out callers get "no availability") so the operator knows what to look for.
8. Common admin tasks — 7 entries (add employee, add service, update hours, mark off today, cancel appointment, move appointment via drag, invite front-desk login) each with the exact dashboard location.
9. Troubleshooting — 6 real failure modes likely to surface in beta (phone rings but AI never picks up, booked outside shifts, customer got wrong-time reminder, missing call in Calls tab, wrong price, "Something went wrong" boundary), each with diagnostic steps and root-cause hypothesis order.
10. Escalation — support email + status page + founder direct line for the first 30 days of beta.
11. HIPAA-excluded-verticals note — preserved from CLAUDE.md, called out so prospective beta customers know up-front.

**Out of scope** (left to the founder's first-30-days direct line): screenshots/screen-recordings, video walkthrough, per-template playbooks beyond mobile-tire's DynaTire example. Those are higher-fidelity content for later; this doc gets a beta customer unblocked on Day 1 without a human in the loop.

No code changes; pure docs. Linked from `docs/planning/TODO.md` close note. Backend tests unchanged (1,893). Migration count unchanged (122). Drift detector clean.

---

## 2026-05-14 — Retry logic for failed reminder sends

Closes TODO Phase 5 Ops "Retry logic for failed sends." Pre-fix, `src/workers/reminderScheduler.ts` caught any send failure and immediately flipped the row to `status='failed'` — meaning a single transient legacy provider 5xx or DNS blip lost the reminder permanently. (Legacy SMS provider support fully removed 2026-06; Telnyx is the only provider.) The cure surface is one migration + one new module + one worker rewrite.

**Migration `20260514000000_reminder_retry_columns.sql`** adds two columns to `reminder_schedules`:

- `retry_count INT NOT NULL DEFAULT 0` — counts attempts spent; 0 = original attempt has not yet failed.
- `next_retry_at TIMESTAMPTZ` (nullable) — earliest pickup time after a transient failure. NULL = original attempt or terminal state.

Plus a partial index on `(scheduled_for, next_retry_at) WHERE status='scheduled'` so the worker's batch query stays fast as the row count grows.

**Policy module `src/services/reminders/retryPolicy.ts`** (pure helpers, no DB / no provider calls):

- `MAX_RETRIES = 3` — total retry attempts before permanent failure (4 total send attempts).
- `BACKOFF_MIN = [5, 30, 120]` — wait minutes before the 1st / 2nd / 3rd retry. Matches the policy line in the TODO ("5m / 30m / 2h").
- `isRetryable(error)` — `false` for 4xx HTTP errors (input is broken; re-send produces same result), `true` for 5xx and any error without HTTP status info (conservative: better over-retry than lose).
- `nextRetryAt(currentRetryCount, now?)` — returns the timestamp for the next attempt, or `null` if MAX exhausted. `now` injectable for tests.
- `decideRetry(error, currentRetryCount, now?)` — top-level composition; returns `{action: 'retry', nextRetryCount, nextRetryAt}` or `{action: 'fail', reason: 'non_retryable' | 'max_retries_exceeded'}`. Worker calls this once per failure and acts on the result.

**Worker rewrite** in `src/workers/reminderScheduler.ts` catch block:

Pre-fix: any error → `status='failed'`.
Post-fix: catch error → `decideRetry(err, row.retry_count ?? 0)` → either `UPDATE reminder_schedules SET status='scheduled', retry_count=N+1, next_retry_at=...` (transient + budget remaining) or `UPDATE ... SET status='failed', error='msg (reason: max_retries_exceeded)'` (4xx or budget exhausted). The `4xx vs max-retries` distinction surfaces in the `error` column for operator diagnostics.

**Pickup-query change** in `src/database/index.ts:getDueReminders`:

```sql
WHERE status = 'scheduled'
  AND scheduled_for <= NOW()
  AND (next_retry_at IS NULL OR next_retry_at <= NOW())  -- NEW
```

The `IS NULL` branch preserves back-compat: rows that have never failed (or that pre-date the migration) still qualify on the original `scheduled_for` clock. Rows mid-backoff are held back until their next_retry_at clears.

**Tests added**:

- `src/services/reminders/retryPolicy.test.ts` (13 unit) — `isRetryable` against 4xx / 5xx / network / no-status / 3xx-and-6xx edge cases; `nextRetryAt` against each backoff slot + MAX-exhausted; `decideRetry` composition; `BACKOFF_MIN.length === MAX_RETRIES` invariant.
- `src/reminder-retry-worker.test.ts` (7 real-DB integration) — schema introspection of the two new columns; pickup-query temporal contract across the 3 next_retry_at states (NULL / future / past); end-to-end worker write path for 5xx-retryable, 4xx-non-retryable, and 5xx-at-MAX-retries dispositions.

After-state: backend 1,873 → 1,893 (+20); migration count 121 → 122. Zero TS errors across backend / dashboard / agent. **Outstanding for prod-apply**: `20260514000000` joins the queue with the other 35 pending migrations. Production reminder workers will continue marking-failed-on-first-error until prod is migrated; the worker code is backward-compatible (it reads `retry_count ?? 0` so missing-column rows would behave as the pre-fix did — but the column-add migration is forward-only so this safety net only applies during the deployment gap).

---

## 2026-05-13 — PK rename pilot 28: real-DB integration coverage + final code-residue sweep

Closes the May 12 PK-rename sprint. After the per-pilot renames, only ~44% of the new `<table>_id` columns had real-DB test coverage. Pilot 28 added comprehensive coverage and cleaned up residual `id` references.

**Key outcomes:**
- New `src/pk-rename-coverage.test.ts` (30 tests) exercises every renamed PK against actual Postgres.
- 121 follow-up renames across routes, services, tests, shared/, dashboard, e2e, and seed.sql.
- 5 latent bugs surfaced and fixed during the sweep.
- All single-column PKs in public schema now follow the `<table_singular>_id` convention.

Full details (28 pilots, specific migrations, bugs found, and the 121-edit sweep) are in the original session notes and earlier entries in this file.

See also the compact summary table of all PK-rename pilots added in the May 12–13 block above.

## 2026-05-12 — PK naming convention conversion, Part 2: **non-domain cleanup (9 pilots, 9 migrations)**

Continuation of the sprint into the nine leaf tables. These still violated the `<table_singular>_id` convention even though they were "non-domain."

**Pilots summary (Part 2):**

| Pilot | Commit | Table | Notes / Latent Bugs |
|-------|--------|-------|---------------------|
| 17 | e570197 | user_feedback | Terminal table. Surfaced stale JOINs in analytics.ts |
| 18 | 766e07b | soft_reservations | Pure rename |
| 19 | a8d1379 | audit_log | Surfaced stale id ref in tenant-delete-cascade e2e spec |
| 20 | 0fca817 | unanswered_questions | Backend-compat alias kept on GET |
| 21 | f92a566 | phone_verifications | Backward-compat alias on API + e2e |
| 22 | dda9ddd | password_resets | Two latent bugs from pilot 9 (users.id) surfaced in invite + e2e teardown |
| 23 | 34d5387 | call_transcripts | Pure rename + RPC recreation |
| 24 | 9bb65e1 | call_summaries | Pure rename |
| 25 | (this commit) | entity_sync_map | Largest surface (20 files). Three latent bugs from prior pilots fixed in syncMapHelpers + jobberSync |

All green. Every single-column PK in the public schema now follows the convention.

Two follow-on pilots after Part 2 closed the schema-rename work itself. No migrations — pure code/test sweep — but they fixed real production bugs that the unit-test CI gate hadn't been catching.

**Pilot 26 — code-residue sweep** (`ad72daa`):

## 2026-05-12 — PK rename code-residue + test-mock sweep (pilots 26 + 27)

Two follow-on sweeps after the schema renames (no new migrations).

**Pilot 26 — code-residue sweep:** ~50 stale `WHERE id` / `RETURNING id` references found across the codebase. Reasons: Playwright e2e specs aren't in unit CI gate; multi-line SQL strings; a few production routes had stale SELECT projections. Touched 12 e2e spec files + many backend services/routes. Used `RETURNING ..._id AS id` backward-compat alias where needed.

**Pilot 27 — test-mock alignment:** Fixed real production bugs that mocked tests had hidden (mostly from earlier pilots).

Both pilots: backend + dashboard green. Significant latent bug surface area cleaned up.

| Pilot | Commit | Tables | Key Notes / Latent Bugs |
|-------|--------|--------|-------------------------|
| 1+2 | 40c57d5 | record_versions, tenant_skills | Recipe template set; view + 2 RPCs recreated |
| 3 | 29c27c1 | reminder_schedules | First SERIAL PK pilot |
| 4 | a89fd50 | consent_records | SERIAL PK |
| 5 | cb88e6c | opt_out_records | Same shape as pilot 4 |
| 6 | df44c50 | voice_sessions | Terminal table; RPC recreated |
| 7+8 | 6607873 | tenant_docs, tenant_integration_settings | No inbound FKs; tenant_calendar_settings deferred (composite PK) |
| 9 | c02ac5c | users | High entanglement (auth, JWT, polymorphic assignment_id) |
| 10 | 4e65bb1 | services | Major RPC entanglement; surfaced `auto_version_trigger` latent bug (fixed + SECURITY DEFINER + cascade guard restored). 14 dashboard components |
| 10 (fix) | e4f173c | — | Missed `BusinessSettingsView.test.tsx` Service-shape type (CI red) |
| 11 | d682ecf | resources | 3 RPCs; surfaced `fn_audit_trigger` latent bug. 25 dashboard files |
| 12 | b8287b9 | employees | 5 RPCs; night-shift test caught `check_availability_with_tz`. Kept `employee_id::text AS id` alias for polymorphic UNION |
| 13 | 010c6dc | employee_schedule | Smallest pilot; 2 RPCs |
| 14 | 389245e | appointments | Largest blast radius. 4 RPCs (table-qualified RETURNING to avoid ambiguity). Surfaced stale `services.id` in appointments.ts |
| 15 | 1dacf9b | customers | 4 RPCs. Surfaced stale `resources.id` in jobberSync |
| 16 | f486f6b | tenants | Sprint complete. 3 RPCs + trigger guards. Surfaced 3 latent bugs (notify_n8n, create_default_resources, database/index tenant existence check) |

**Trigger evolution:** Both `auto_version_trigger` and `fn_audit_trigger` now use CASE ON TG_TABLE_NAME for every versioned/audited table (required because each has its own renamed PK column).

**Standing authorization:** After the first two pilots, the user granted standing autonomous-commit approval (continue without re-asking as long as CI is green on first push). One pause only (pilot 10 dashboard tsc miss).

**Recipe (locked by repetition):** (1) Migration RENAME, (2) recreate affected RPCs, (3) extend triggers if needed, (4) code sweep with perl one-liner, (5) tests with `RETURNING ... AS id` backward-compat alias, (6) dashboard types + tsc sweep, (7) docs + drift detector, (8) one commit.

**Latent bugs surfaced during the sweep (real production issues that mocked tests had hidden):** See individual pilots above + detailed notes in the original May 12–13 entries.

**After-state:** backend 1,781 / dashboard 620 / agent 85 — all green. Zero TS errors. Drift detector clean. The sprint is **complete** for every domain entity table.

**Remaining decision:** `tenant_calendar_settings` (composite PK) — tracked in `docs/planning/TODO.md`.

**Outstanding:** All 17 PK-rename migrations still need to land on production Supabase (forward-only, must be applied in order).
- `04a96b4` — **fix(e2e): stabilize two latent flakes.** `workflows.spec.ts` smoke asserted on seed-customer names visible in TODAY's calendar view (empty on weekends since DynaTire seeds Mon-Fri shifts only); replaced with unconditional `scheduler-date-display` check. `quick-book-shift-overrides` booking test used `today` for the booking date (failing legitimately on weekends) plus a broken `/shifts/overrides` URL that hit the dashboard's catch-all (HTML response) instead of the backend (port 4001) — `res.json()` threw, helper silently returned null, auto-assign landed on a non-scheduled employee. Fixed by walking to the next weekday, using the absolute backend URL, and skipping the service selection (orthogonal to the test's shift-coverage contract). Test also lacked cleanup — it had been "passing by failing" pre-fix; added try/finally with capture-from-response → DELETE.
- `07103cc` — **test(e2e): mobile-responsiveness audit on iPhone 14 + Pixel 7 viewports.** `mobile-responsive.spec.ts` (4 tests) drives the three daily-use flows (today's schedule, Quick Book, customer lookup) at 390×844 and 412×915 via `page.setViewportSize`. Asserts mobile bottom nav (`md:hidden`) surfaces the primary tabs, critical inputs/controls render visible, page never overflows its viewport horizontally. Audit found no regressions — `OutlookLayout`'s mobile nav + Tailwind responsive classes work cleanly at both widths.
- `ae7dd12` — **feat(schema): close tenant-delete cascade gap on employees + services.** **Surfaced a real data-integrity bug** while writing E2E coverage for the `DELETE /tenants/:id` cascade: `employees.tenant_id` and `services.tenant_id` were declared `NOT NULL UUID` but lacked the `REFERENCES tenants(id) ON DELETE CASCADE` constraint that every other tenant-scoped table has. (Initial-schema migration declared the FK; a later column-rename or table-recreate appears to have dropped it without restoring it.) Local DB had accumulated 77 orphan employee rows + 8 orphan service rows from past test runs. Migration `20260511000000_employees_services_tenant_fk_cascade.sql`: DELETE orphans whose tenant_id no longer exists → ADD CONSTRAINT FK CASCADE on both. Pre-fix, tenant offboarding silently leaked rows — would have been a GDPR posture issue at beta scale. **Production Supabase still needs this applied.** Plus `tenant-delete-cascade.spec.ts` (3 tests: full cascade across 11 tables, cross-tenant isolation, owner-403 authz gate). Migration count 89 → 90.
- `f43e535` — **test(e2e): soft-delete → restore round-trip on customers.** `version-history-restore.spec.ts` (3 tests) covers the "we accidentally deleted X — restore it" customer-trust scenario. Happy round-trip: create → `/soft-delete` → filtered from `/customers` + appears in `/records/customers/deleted` → `/restore` → back in active list + gone from deleted list. Sad paths: 404 `RECORD_NOT_DELETED` on never-deleted (distinguishes stale UI from gone record); 400 `INVALID_TABLE` on non-whitelisted table name (`foobar`, `tenants`) — pins SQL-injection defense on the inlined table name. Audit found no regressions; feature was already solid end-to-end.
- `4d30eff` + interleaved doc commits — TODO.md marks all 5 closed items with detailed notes; TEST_COVERAGE.md tracks the 14 new workflow rows across 4 new spec files; CLAUDE.md migration count 89 → 90.

**After-state:** backend 1,770 → 1,775; dashboard 617 → 620; agent unchanged at 85; E2E 55 → 69 passing (7 intentional skips). All typecheck clean. Zero failures. **Outstanding for next session:** apply migration `20260511000000` to production Supabase.

---

## 2026-05-09 — Booking-RPC granular errors restored + 12 pre-existing test failures closed

Same-day follow-up to security pass 2. The full-suite run had surfaced 12 pre-existing failures in 4 test files; this session closes them all. Net green: 1,770/1,770 backend tests pass for the first time today.

**Root cause: granular error codes regressed in migration `20260508000001`.** That migration's intended change was the auto-assignment policy rewrite (alphabetical → fewest-skills + least-busy + random) for senior-time preservation. But the rewrite accidentally collapsed the four-code diagnostic block from migration `20260401000001` (NO_SKILLED_EMPLOYEE / EMPLOYEE_NOT_SCHEDULED / TIMESLOT_OCCUPIED / NO_AVAILABILITY) into a single NO_AVAILABILITY return when the candidate JOIN produced no rows. Real impact: the agent prompt branches on these specific codes — without them, callers hear "nothing's open there" when the actual issue is "we don't have a tech with that skill" — misleading and unhelpful.

**Fix: migration `20260509000002_restore_granular_booking_errors.sql`.** Keeps the 2026-05-08 assignment policy intact and re-incorporates the diagnostic block from `20260401000001`, updated to use `employee_schedule` (the `employee_shifts` table the original used was dropped 2026-04-30). After applying, all `scheduling-atomic.test.ts` and `skill-resource-matching-sweep.test.ts` tests that asserted on specific codes pass cleanly.

**Side fixes along the way:**

- **2 tests needed `DELETE FROM resources` after `createTenant`.** `scheduling-atomic.test.ts` "matches employee by skill and shift" and `skill-resource-matching-sweep.test.ts` "salon: books haircut..." both asserted on a specific resource_id/name. The `auto-shop` and `salon` business templates auto-seed resources via DB trigger; the new assignment policy's `random()` tiebreaker (added 2026-05-08) picks any matching resource. Adding the DELETE matches the existing pattern in test 128 ("fails when all resources are booked") and gives deterministic resource selection.
- **3 `crm-appointments.test.ts` tests violated the 15-min CHECK constraint.** They inserted appointments with `NOW() + interval '1 day'` which is rarely on a 15-min boundary. Migration `20260508000000` added `appointments_start_time_15min` / `appointments_end_time_15min` checks. Switched to `date_trunc('hour', NOW() + interval '1 day')` to land on `:00`, which satisfies the constraint.
- **1 booking-concurrency test was `Promise.all` over 20 deadlocking transactions.** Under extreme concurrency, the GiST exclusion-constraint check can deadlock between two transactions; one rolls back with `40P01`. Promise.all rejects fast on first rejection so the test crashed before asserting. Switched to `Promise.allSettled`, kept the at-most-one-winner contract (data integrity preserved), added a defense-in-depth `SELECT COUNT(*)` row-count assertion, and bumped the test timeout to 30s (deadlock detection takes ~1s per pair, cascading deadlocks among 20 callers can exceed 5s). The underlying limitation — that a deadlock-rolled-back loser doesn't see the prettiest error code — is acceptable: data integrity holds, the agent prompt would surface "something went wrong, please try again" which is OK user-facing behavior under that load.

**Files touched:** `supabase/migrations/20260509000002_restore_granular_booking_errors.sql` (new), `src/scheduling-atomic.test.ts`, `src/skill-resource-matching-sweep.test.ts`, `src/crm-appointments.test.ts`, `src/booking-concurrency.test.ts`.

Backend test count: 1,770/1,770 pass (was 1,758 / 1,770 with 12 failing earlier this session).

---

## 2026-05-09 — Security review pass 2: RLS coverage + JWT/refresh + AGENT_SECRET rotation

Three sub-audits, three findings. New `docs/SECURITY.md` documents the as-shipped posture for future audits.

**RLS coverage audit on tables since 2026-03.** Inventoried every CREATE TABLE migration, cross-referenced against the global FORCE-RLS migration `20260323000000_force_rls_single_pool.sql`. Three real gaps:

1. `password_resets` (created `20260422000000`) had **zero RLS** — no `ENABLE`, no policy. Holds short-lived account-recovery tokens; cross-tenant leak material if any future caller joined or read this table from a tenant-context-set connection. Closed by migration `20260509000000_password_resets_rls.sql`: ENABLE + FORCE + a permissive policy that only allows access when `app.current_tenant_id` is empty (the unauthenticated `/forgot-password` and `/reset-password` flows). Authenticated tenant sessions get NO access — defense in depth.
2. `voice_sessions` (created `20260409000000`) had `ENABLE ROW LEVEL SECURITY` + a tenant-isolation policy but lacked FORCE. On Supabase managed Postgres (where we connect as `postgres`, a non-super non-BYPASSRLS role per the 2026-03-23 migration's rationale), policies-without-FORCE may bypass — `voice_sessions` stores call_id + transcript + AI-judged outcome, all cross-tenant leak-worthy.
3. `record_versions` (same migration date) had the same shape gap. Stores soft-delete + version-history rows — leaking these would expose prior values of edited records (e.g. customer's old phone number, appointment's prior status).

Closed by migration `20260509000001_force_rls_voice_sessions_record_versions.sql` applying FORCE to both. Pinned by Probe 6 in `multi-tenant-isolation.test.ts` (4 tests checking `pg_class.relrowsecurity` + `relforcerowsecurity` metadata + the `pg_policies` row for password_resets + a positive-control INSERT/SELECT under empty tenant context). Local test `postgres` is SUPERUSER+BYPASSRLS so behavioral cross-tenant probes under that role are meaningless locally; the metadata probes catch a future migration that drops RLS or FORCE on these tables.

**JWT lifetime + refresh + revocation.** No fixes needed. The current shape is robust: 8h stateless tokens, `/auth/refresh` sliding-window, and the cleverest piece — every authenticated request looks up `users.password_changed_at` and rejects tokens with `iat < password_changed_at` epoch. Password rotation is the revocation mechanism. Documented gaps: no admin "lock account" UI without password change (workaround: SQL `UPDATE users SET password_changed_at = NOW()`), no per-token denylist (acceptable for stateless tokens at this scale).

**AGENT_SECRET timing-safe + rotation.** Pre-fix the auth comparison was plain `provided !== AGENT_SECRET` — short-circuit on first mismatched byte → timing oracle in principle. Switched to `crypto.timingSafeEqual` with a length-mismatch guard so the helper doesn't crash on different-length input. Added `AGENT_SECRET_OLD` for hot rotation: backend accepts either primary or old during the transition window. Rotation procedure: set new + old on backend, redeploy worker with new, drop old. Pinned by 3 new auth tests in `agentTools.test.ts` (length-mismatch no-crash, OLD accepted, OLD doesn't wildcard-accept third values).

**Out of scope this session (deliberate):** ServiceTitan webhook contract test (no real integration today). Admin "lock account" UI surface. Per-worker agent identity (only matters when running multiple agent workers). Investigation of the 12 pre-existing test failures from migration `20260508000001` — same-day discovery during the full-suite run, tracked separately in `docs/planning/TODO.md`.

**Backend tests:** 1,763 → 1,770 from this session's adds (+7). 12 pre-existing failures unrelated to this work tracked separately. Net green: 1,758 backend tests passing.

---

## 2026-05-09 — Security review pass 1: webhook signature verification + CRM HMAC bug fix

Audit + fix in one session. Two findings, both closed.

**Finding 1 — Stripe webhook signature contract had zero tests.** The `/billing/webhook` route correctly used `stripe.webhooks.constructEvent` against the raw body (preserved by the global content-type parser at `src/index.ts:142`), but no test pinned the contract. A refactor that reordered constructEvent before the sig check, removed the rawBody preservation, or replaced constructEvent with `JSON.parse(req.body)` for "convenience" would slip past the suite. New file `src/webhook-signatures.test.ts` adds 3 Stripe contract tests: missing-signature → 400 with no DB activity, invalid-signature → 400 (logged via `stripe_webhook_signature_failed`), valid-signature → 200 with the checkout.session.completed handler running and the tenants UPDATE firing. Tests use `Stripe.webhooks.generateTestHeaderString` so the signature math is real, not stubbed.

**Finding 2 — HubSpot, Square, and Jobber webhooks had broken HMAC verification.** All three routes had `const rawBody = JSON.stringify(req.body)` and passed that into `verifyWebhookSignature`. This is fundamentally broken: providers sign the EXACT bytes they sent, and re-serializing through V8's `JSON.stringify` doesn't byte-match — whitespace, key order, number formatting, escape sequences can all differ. Production-impact today is contained because no real CRM is wired (all four CRM integrations are OAuth-pending env vars), but the bug would have surfaced on the first real webhook. Fixed all three routes to read `req.rawBody` (already preserved globally) with a defensive 400 fallback if rawBody is somehow missing. New tests in `webhook-signatures.test.ts` pin the contract per provider: bad-signature → 401, valid-signature → 200, plus replay-protection on HubSpot's timestamp-freshness window and a no-active-integration → 404 short-circuit on Jobber.

**Test scaffolding side-effect.** The fix required `req.rawBody` to be available in test apps. `buildRouteTestApp` in `src/test-utils-mock.ts` was updated to mirror the production content-type parser. The three existing route tests (`hubspot-routes.test.ts`, `square-routes.test.ts`, `jobber-routes.test.ts`) build their own Fastify instances directly, so they got a copy-paste of the same parser block — small duplication accepted to keep the change minimal.

**Pass 2 of the security review deferred to a future session:** RLS coverage audit on tables added since 2026-03; JWT lifetime + refresh story (revocation strategy); `/agent-tools/*` shared-secret rotation plan.

**Backend tests:** 1,752 → 1,763 (+11 webhook signature tests). Dashboard / agent unchanged.

---

## 2026-05-09 — Booking enforcement chain closed end-to-end (5 sub-slices in one session)

Backend 1,733 → 1,747 (+14). Agent 81 → 85 (+4). Dashboard 617 unchanged. Six TODO entries closed under the `Booking enforcement hardening` section: Slice 1, 1.5, 2, 3, AI prevention prompt-only, AI prevention E2E coverage. Only `pre-flight tool fallback` remains and it's deliberately deferred ("only ship if beta data shows the prompt rule is unreliable").

**Slice 1 — backend conflict-details on overlap.** `src/services/conflictLookup.ts` (helper, dashboard wiring, dashboard tests) was already shipped 2026-05-08; the gap was the agent route. Wired `findOverlappingAppointment` + `isOverlapError` into `/agent-tools/book-appointment` (`src/routes/agentTools.ts`): on `"already booked"`, runs the lookup in the same transaction and returns `{ success: false, error_code: 'TIMESLOT_OCCUPIED', conflict }` at status 200 (agent's conversational shape). Non-overlap errors keep the legacy `{ success: false, error }` plain shape so the existing agent-prompt parsing is undisturbed. Tests: `conflictLookup.test.ts` +7 (four overlap geometries — start, end, contained, containing — plus two flavors — resource-conflict, employee-conflict); `agentTools.test.ts` +2 (overlap → conflict block + TIMESLOT_OCCUPIED contract; non-overlap → plain shape + no third query).

**Slice 1.5 — 15-min increment enforcement.** Migration + validator already shipped 2026-05-08; gap was `INVALID_INCREMENT` not surfaced as `error_code`. Refactored `validateAppointmentTimeRange` to return `{ error, code } | null` with stable `AppointmentValidationCode` union (`INVALID_PARAMS` | `INVALID_RANGE` | `INVALID_DURATION` | `INVALID_INCREMENT`). Threaded through 3 call sites: `POST /appointments/create`, `POST /appointments/:id/update`, `POST /agent-tools/book-appointment`. Tests: `appointmentValidation.test.ts` updated to assert structured shape (+1 unparseable-date INVALID_PARAMS test); `routes/appointments.test.ts` +3 (off-grid start/end on create + off-grid update); `agentTools.test.ts` +2 (off-grid start/end agent route, both pin no-DB-call).

**Slice 2 — dashboard conflict modal + 15-min time picker.** Audit-only — already fully shipped (`ConflictModal.tsx` with bonus next-available alternatives section, both panels using `<input type="datetime-local" step="900">`, 17 component tests passing, `ui-conflict-modal` + `15min-form-rejection` E2E both pass). Spec said "dropdown of options", implementation uses `step="900"` — functionally equivalent (browser snap + `reportValidity()`), captured the divergence in TODO.md.

**Slice 3 — E2E with self-contained data lifecycle.** New `dashboard/e2e/helpers/fixtures.ts` exports `registerFreshTenant()` (POST `/register` → unique tenant + admin token), `seedBookingScenario()` (creates N employees + M resources + 1 customer + shifts on requested dates), `seedAppointment()` (direct INSERT for "blocker" rows), `bookAppointmentAs()` / `updateAppointmentAs()` (API conveniences), `cleanTenantData()` (single-statement DELETE that cascades). Refactored `booking-enforcement.spec.ts` tests 1-4 + 7 (out-of-hours, employee/resource double-book, partial-overlap, edit-overlap) to drop Page entirely and drop the DynaTire seed dependency: each test registers its own tenant, asserts via `request` context, cleans up via tenant cascade. UI tests 5-6 keep their existing pattern (need real dashboard navigation). Speedup: API tests went from ~4.8s each (Page-mediated) to ~100-460ms each. Three consecutive full runs (12.9s / 12.2s / 12.2s) — the prior auth-bleed flake on `15min-form-rejection` is gone since the surrounding API tests no longer touch Page state.

**AI prevention — prompt-only enforcement + E2E coverage.** Tightened `agent/src/prompt.ts` "Availability discipline" section: replaced the soft "the booking tools enforce this server-side" framing (which gave the LLM license to skip the check) with a "this is a hard rule, not a guideline" framing + an explicit "Don't rely on the backend to catch you — by the time it rejects, the caller has already heard you propose a time you can't deliver" warning. Added 15-min grid rule for spoken proposals (":00, :15, :30, :45 — never :07, :23, :40") so the agent doesn't propose an off-grid time the booking call will then reject with INVALID_INCREMENT. New "When the caller can't be accommodated" section directs the agent to STOP guessing and take a message (capturing name + reason, no fake callback windows promised) once alternatives are exhausted. `check_availability` now mentioned alongside `get_available_slots` / `get_scheduling_options` as a third gate entry-point. Pinned with 4 new CONVERSATION-SHAPE prompt-content tests in `agent/src/prompt.test.ts` covering scenarios (a) hard-rule check-before-book, (b) TIMESLOT_OCCUPIED → propose alternative, (c) 15-min grid in spoken times, (d) take-a-message escalation. LLM-in-the-loop conversation harness deliberately deferred — non-deterministic, costs OpenAI tokens per run, and `scripts/qa-live-test.py` is the proper place for end-to-end conversational validation once Telnyx unblocks.

**Files touched:** `src/services/appointmentValidation.ts` (+ test), `src/services/conflictLookup.test.ts`, `src/routes/appointments.ts` (+ test), `src/routes/agentTools.ts`, `src/agentTools.test.ts`, `agent/src/prompt.ts` (+ test), `dashboard/e2e/helpers/fixtures.ts` (new), `dashboard/e2e/booking-enforcement.spec.ts` (refactored), `docs/planning/TODO.md`, `docs/TEST_COVERAGE.md`, `docs/CURRENT_STATUS.md`, `CLAUDE.md`, `planning/RESOLVED.md`.

---

## 2026-05-08 — Quick-book e2e deflake (date reach + local-time bug)

Surface area: `dashboard/e2e/workflows.spec.ts` quick-book test only. No production code touched.

Two compounding bugs were causing the test to fail intermittently — and consistently in the full-suite run vs. passing in isolation, which is the classic shape of a hidden race-or-state issue. Both turned out to be deterministic once unpacked:

1. **Date reach.** Test booked +35 days out, but `refresh-seed-data.sql` (applied this morning) only extends `employee_schedule` ~12 days forward. Beyond that there are zero shifts → booking RPC rejects with `EMPLOYEE_NOT_SCHEDULED` → no row inserted → `expect(rowCount).toBeGreaterThanOrEqual(1)` fails. The test's prior "+35 days" was tolerant of an older, longer seed window; the seed-refresh tightened it.
2. **Local-vs-UTC datetime-local.** `setHours(9, 15)` sets local hours; `toISOString()` returns UTC; `<input type="datetime-local">` then interprets the string we fill as LOCAL again. On a CDT machine, hour 13 → "T18:00" → form picker reads 18:00 LOCAL → outside Mike's 07-16 shift, outside Carlos's 08-17, exactly at Dana's 18 boundary. Consequence: the random hour 9-13 choice silently became 14-18 LOCAL and only the bottom of that range was bookable. Failure rate scaled with whichever employee the booking RPC's auto-assign happened to pick.

**Fix.** Walk +3 days, skip Sat/Sun to land on a covered weekday. Build the datetime-local string from local Y/M/D + HH:mm components directly (no `toISOString()` round-trip). Range tightened to 10-14 LOCAL so even the ends of the random distribution sit comfortably inside every seed employee's shift window.

**Doc fix bundled in same commit.** `docs/TEST_COVERAGE.md` previously claimed "58 passed, 1 skipped" — that count came from a `SYNC_TEST_RECORDER=1` run during validation, but the standard developer run is 52 passed + 7 skipped (the 6 calendar-sync tests skip-guard themselves when the env var is unset, plus 1 historic skip in full-functional-audit). Now stated accurately with both counts (default + recorder-enabled) called out. Quick-book passing again brings the default-env run back to 52 / 7 / 0.

---

## 2026-05-08 — Observability slice 2: in-process Prometheus metrics + scrape endpoint

Backend 1,719 → 1,733 (+14 metrics-registry unit tests). Dashboard / agent / Playwright unchanged. The "Basic metrics" item in `docs/planning/TODO.md` Observability section is now `[x]`.

- **`src/services/metrics.ts` — in-process registry, no external deps.** Standard counter + histogram shapes, Prometheus text-format exposition. Hard-coded label cardinality cap (1000 series per metric, overflow funnels to `overflow="true"`) so a misbehaving caller emitting per-phone-number labels can't pin process memory. Singleton registry exported as `registry`. Six pre-declared metrics live in the same file so the taxonomy is discoverable in code review:
  - `http_requests_total{route,method,status}` — partitioned by route PATTERN (e.g. `/appointments/:id`), not rendered URL, to keep cardinality bounded.
  - `http_request_duration_ms` — histogram with the same labels. Buckets `[10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` cover the realistic range for this service (most routes <100ms, booking RPC sometimes 500ms p99, anything >2s should alert).
  - `booking_attempts_total{outcome, source}` — outcome ∈ `success | timeslot_occupied | employee_not_scheduled | no_skilled_employee | no_availability | validation_error | past_time | other_error`; source ∈ `api | agent`. Powers booking success-rate dashboards.
  - `tool_calls_total{tool, outcome}` — outcome ∈ `success | error | validation_error`. tool name is the `/agent-tools/<name>` suffix (10 tools today; bounded cardinality).
  - `sync_dispatches_total{provider, entity, action}` — 5 providers × 2 entities × 3 actions = 30 series max. Lets us verify in prod that the orchestrator is firing the way `calendar-sync.spec.ts` proves it does in dev.
  - `errors_total{event}` — sibling counter inside `logError()`. Pair with `rate(errors_total[5m])` alerts in Grafana for higher-signal alerting than scraping log lines.
- **Auto HTTP metrics via Fastify onResponse hook (`src/index.ts`).** Status code is rolled up to family (`2xx`/`4xx`/`5xx`) to keep cardinality sane. Skips `/health` (constant traffic, no signal) and `/metrics` (avoids recursive scrape). Uses `req.routerPath` (not `req.url`) so `/appointments/abc-123` and `/appointments/def-456` collapse into the same `/appointments/:id` series. `reply.elapsedTime` (Fastify built-in) feeds the histogram.
- **Domain counters wired at the call sites that matter.** Booking outcomes in `/appointments/create` (4 paths: validation, success, conflict-409, other-error) and the agent's `/agent-tools/book-appointment` + `/agent-tools/book-with-scheduling`. Tool-call outcomes via the existing `toolRoute()` wrapper — `ok()`/`fail()` set a `_toolOutcome` marker on the reply, the wrapper reads it after the handler returns and bumps the counter. Sync dispatches alongside the recorder hook (single dispatch loop, both call sites), error counter in `logError()`.
- **`GET /metrics` scrape endpoint, gated by `METRICS_TOKEN`.** Strict opt-in: returns 404 when the env var is unset (so a fresh deploy can't leak tenant counters publicly), 401 on missing or wrong Bearer header, 200 with `text/plain; version=0.0.4` body when correct. Added `/metrics` to `PUBLIC_ROUTES` in `middleware.ts` so the JWT auth hook doesn't try to validate the bearer as a JWT before the route handler runs. Verified live with curl against a backend started with `METRICS_TOKEN=...`: counters populate per-request, no public exposure when env var is removed.
- **`src/metrics.test.ts` — 14 unit tests.** Counter inc with no labels / multiple label combos / sort-stable label keys, by=N step argument, cardinality cap behavior. Histogram cumulative bucket placement, sum + count accumulation, separate-series by labels, ascending-bucket validation. Registry double-registration semantics (same type returns same instance, different type throws), exposition format (HELP / TYPE / +Inf / _sum / _count), label-value escaping (quotes / backslashes / newlines per Prometheus spec).
- **Doc deltas.** `CLAUDE.md` documents the metrics taxonomy + `METRICS_TOKEN` env var; bumps backend tests 1,719 → 1,733 (Phase 13 line). `docs/TEST_COVERAGE.md` headline refreshed; counts bumped. `docs/planning/TODO.md` marks "Basic metrics" `[x]` with a one-paragraph wrap-up.

---

## 2026-05-08 — Calendar + CRM sync E2E (last beta-blocker P1 closed)

Backend 1,712 → 1,719 (+7 recorder semantics). Dashboard 617 unchanged (recorder logic lives backend-side). Playwright 52 → 58. Last unchecked P1 in `docs/planning/TODO.md` Test Suite Gap Analysis is now `[x]`.

- **Sync-test recorder hook in `syncOrchestrator.ts`.** Test-only in-memory ring buffer (cap 500) gated by `SYNC_TEST_RECORDER=1`. Strict opt-in — `"true"`, `"yes"`, `"on"`, empty string all stay disabled. `record()` is a no-op outside test mode so prod paths are untouched. `record()` runs synchronously inside the dispatch loop BEFORE the provider promise fires, so the recorder reflects intent-to-dispatch even when a provider's `.catch()` is still pending.
- **`/agent-tools/_test/sync-events` route.** GET reads the buffer, DELETE clears it. Both gated by both the env var (404 when off) AND the existing agent-secret hook. The recorder + endpoint live alongside the 10 production agent tools but are clearly namespaced under `/_test/` so a code review can spot test infrastructure at a glance.
- **`dashboard/e2e/calendar-sync.spec.ts` — 6 tests.** API-only design (uses Playwright's `APIRequestContext`, no page navigation), so it sidesteps any dashboard SSR/hydration flake. Logs in as `admin@dynatire.com` (DynaTire tenant admin) rather than `admin@secretaryhq.com` (super-admin) — `DELETE /appointments/:id` and `PUT /customers/:id` read tenant_id from JWT only, no super-admin override path, so logging in as platform admin would 404 against rows in the DynaTire tenant. Asserts: each appointment lifecycle event (create/update/delete) dispatches all 5 providers with the right action label; each customer event dispatches the 4 CRMs (no calendar — by contract); fire-and-forget HTTP returns in <3s with 5 sync promises in flight. Each test creates its own customer + employee_schedule + appointment in `try`, cleans up in `finally` per the test-isolation feedback memory; clears the recorder buffer in `beforeEach` so cross-test contamination is structurally impossible.
- **`src/sync-orchestrator.test.ts` — 7 unit tests.** Pin recorder semantics in isolation: enabled mode appends 5 appointment / 4 customer events with the right shape, disabled mode (env unset OR any value other than literal `"1"`) records nothing, `clearSyncRecorder()` empties the buffer, ring-buffer caps at 500 events dropping oldest, append-order is preserved across multiple calls. Co-exists with the prior `src/services/syncOrchestrator.test.ts` (file-grep regression tests) — different files, different mechanisms; both pass.
- **Two test-fixture bugs surfaced + fixed during validation.**
  - DELETE requests with `Content-Type: application/json` and no body trip Fastify's parser (`Invalid JSON` → 500). Removed the header on the body-less DELETEs (appointment-delete, customer-delete, recorder clear).
  - DynaTire's tenant timezone is `America/Chicago`, so the booking RPC translates UTC `start_time` to local before checking shift coverage. Initial fire-and-forget test used `11:00 UTC` (`06:00 CDT`, before Mike's 09:00 shift) → `EMPLOYEE_NOT_SCHEDULED` 400. Moved to `17:00 UTC` (`12:00 CDT`, mid-shift). Comment in the spec calls out the timezone math so a future refactor doesn't drift back.
- **Doc deltas.** `CLAUDE.md` documents the `SYNC_TEST_RECORDER` flag + the namespaced test endpoints, bumps backend tests 1,712 → 1,719 + Playwright 52 → 58. `docs/TEST_COVERAGE.md` headline refreshed; "Calendar sync" + "CRM sync" struck through with a note that orchestration layer is now covered (outbound HTTP shape still only at unit level). `docs/planning/TODO.md` marks Calendar sync E2E as `[x]` — last unchecked P1 in that section.

---

## 2026-05-08 — 7 prod migrations applied (3 silently overdue) + customer-create as a separate transaction

Backend 1,659 → 1,666 (+7: customerLookup helper +4, agentTools persistence regressions +3). Dashboard + agent untouched.

- **Applied 7 pending migrations to production Supabase.** Initial intent: apply `20260505000000_user_roles.sql` only, after the audit found the new Logins UI's `users.role` column was missing in prod and would 500 the route. Pre-flight read-only check confirmed the column genuinely didn't exist on `public.users` (an `auth.users.role` returned by an earlier broader query was Supabase's own auth schema, not ours). Manual `psql` + `INSERT INTO schema_migrations` to avoid the bulk `setup-db.sh` path picking up other pending work. Then drafted `scripts/preflight-booking-overlap.sql` for the GiST exclusion-constraint pair (`appointments_no_resource_overlap` + `appointments_no_employee_overlap`); pre-flight returned 0 conflicting pairs against the half-open `tstzrange(start_time, end_time, '[)')` predicate. Ran `setup-db.sh` to apply `20260501000000` + `20260501000001` + `20260507000000` (mapping-aware skill check + `appointments.service_id` column). **Surprise:** the run also applied `20260430000000` + `20260430000001` + `20260430000002` — three migrations the docs had claimed prod-applied 8 days prior. They had not been: prod was running `check_coverage_gaps()` and `check_availability_with_tz()` RPCs that still referenced the dropped `shift_overrides` table name, and the `employee_shifts` legacy weekly-pattern table was still alive. No traffic was hitting them so the breakage went unnoticed; lucky catch before first live call. All 7 applied cleanly via `--single-transaction` with `ON_ERROR_STOP=1`.
- **Test-data audit (`scripts/audit-test-data.sql`).** Kept as a re-runnable artifact with the pre-flight scan. 8-section sweep (time integrity, tenant-FK boundary, FK reference integrity, status hygiene, business-hours alignment via `employee_schedule`, resource/employee/customer overlap, schedule sanity, per-tenant inventory). Findings on prod data: 3 stale `scheduled` appointments 35-37 days past, 1 appointment violating shift-coverage (Mike Rivera 2026-04-02 14:00 CT with no covering shift in his week), 2 unassigned 2026-03-31 appointments where DynaTire had zero employee shifts that day, "Wrong Tenant" customer leftover from a prior multi-tenant probe in the super-admin tenant, and Bella's Hair Studio empty-stub tenant. None block the migrations (the new constraints are forward-only) but tracked as a discrete cleanup task in `docs/planning/TODO.md` under Pre-launch validation.
- **Customer-create as a separate transaction.** Surfaced 2026-05-08 by walking the booking flow: `/agent-tools/book-with-scheduling` did customer get-or-create INSIDE `book_with_scheduling_atomic`'s plpgsql function, so the row's persistence on RPC failure was a side-effect of `RETURN QUERY ... RETURN` semantics + connection-level auto-commit. A future refactor wrapping `withTenantClient` in explicit `BEGIN/COMMIT` (audit logging, savepoints, etc.) would silently start rolling back the customer on every booking failure, forcing the agent to re-collect identity on every retry. Fix: extracted `src/services/customerLookup.ts` with `getOrCreateCustomerByPhone(withTenantClient, tenantId, phone, name)`. Each call acquires its own pool client → runs auto-committed statements → releases, so the customer write is structurally a separate transaction regardless of how the caller is wrapped. Both `/agent-tools/book-appointment` and `/agent-tools/book-with-scheduling` now call the helper before the booking RPC, in two distinct `withTenantClient` blocks. RPC bodies and signatures untouched — they still support inline-create for any future direct caller, but our actual callers now drive the persistence decision at the Node layer where the transactional intent is visible.
- **Tests.** 4 helper unit tests in `customerLookup.test.ts` (HAPPY existing-row short-circuits INSERT, HAPPY no-match → INSERT, SAD soft-deleted row doesn't block fresh INSERT, WIRING tenant_id forwarded to withTenantClient for RLS scope). 3 persistence regressions in `agentTools.test.ts` (book-appointment + book-with-scheduling: customer SELECT/INSERT runs BEFORE the RPC even when RPC returns failure; existing-customer reuse with only SELECT + RPC). 3 pre-existing book-with-scheduling tests updated with the new fixture shape (helper SELECT response prepended). All 5W-annotated.
- **Doc deltas.** `CLAUDE.md` test count refreshed 1,659 → 1,666. `docs/TEST_COVERAGE.md` refreshed (counts + headline date). `docs/planning/TODO.md` marks the prod-apply items done and adds a new "Refresh DynaTire test/seed data" task with the 5 specific findings from the audit. `docs/CURRENT_STATUS.md` removes the resolved atomic-booking row from the in-flight table.

---

## May 7, 2026 — Audit punch list + coverage consistency + Jest cleanup + observability + booking alignment (UI + RPC) + cross-view appointment actions

Backend 1,637 → 1,659 across the day (+9 coverage-consistency, +7 logger, +6 booking-mapping). Dashboard 516 → 575 (+3 Quick Book trigger, +12 Mark off today, +11 CustomerCombobox, +9 empty-cell click, +5 date-nav chips, +1 cell-gate per-employee, +13 booking-alignment filter, +5 popover Edit/Cancel). Agent 72 → 78 (+6 logger). Plus a Fastify-5 boot-time logger fix (`loggerInstance` not `logger`) that production startup needed. Audit punch list 100% complete + booking enforces "everything aligns" at BOTH the UI level AND the RPC level + appointment Edit/Cancel now work from any view via the popover. Thirteen pieces total:

- **Front-desk click-count audit** (formerly `docs/sessions/2026-05-07-front-desk-audit.md`, since removed; summary retained here). Read-only walk through the four daily-use tasks for the `front_desk` role shipped 2026-05-05. Found that 3 of 4 daily tasks fail the docs/planning/TODO.md "≤3 decisions" threshold: book a call-in (8+ decisions on the default Calendar path), look up tomorrow (3, borderline), mark someone unavailable (∞ — front_desk role literally cannot do it; `Staff & Shifts` is owner-only), find a customer (2 ✓). Top finding: the dashboard has two parallel scheduler implementations on the Schedule tab (`AppointmentView` calendar default, `NewSchedulerView` staff sub-tab) and Quick Book — the only sane create flow — appears only on Resources/List sub-tabs. Six-item priority punch list in the audit doc; items 1-3 are P0 launch-blockers.
- **Coverage gap detection backend↔UI consistency (`src/coverage-ui-consistency.test.ts`, 9 tests).** Closes the docs/planning/TODO.md "Pre-launch validation" entry. Surfaced a real bug while writing the test: pre-fix, both `StepReview.tsx` and `SoloStepReview.tsx` derived the wizard review badge from `coverage_pct`, and the RPC returns `coverage_pct = 100.0` for the divide-by-zero case (`WHEN sc.open_count > 0 THEN ... ELSE 100.0`). Net effect: a tenant with no employees scheduled saw a green "Full Coverage / You're ready to go!" banner — the worst possible UX on the highest-stakes onboarding step. Fix: extracted `dashboard/lib/coverage.ts` with `statusToBadge(status)` + `isAllCovered(rows)`. Both wizard review components now derive from the backend's 5-state `status` field (mapped to 3 dashboard badges). Edge cases pinned: employee on leave (all `is_off=true`), shift starting before typical business hours (04:00-08:00), day with zero scheduled employees (Sat/Sun in a Mon-Fri shop), service with no qualified employees but other staff on shift, zero-staff tenant.
- **Quick Book hoisted to the Schedule tab toolbar (audit P0 #1).** Pre-fix, the Quick Book button only existed on Resources/List sub-tabs. Front-desk operators landing on the default Calendar view had to switch sub-tabs first, costing two clicks before the form. Fix: consolidated `SchedulerView.tsx`'s three returns into one — Quick Book button now visible in Calendar's toolbar (next to view tabs), Resources/List's toolbar (existing location), and the Staff sub-tab via a new optional `onQuickBook` prop on `NewSchedulerView`. Side benefit: `QuickBookPanel`, `EmployeeDayFocusPanel`, and `AppointmentPopover` now render at the outer level so they're reachable from every sub-tab (previously dead on Calendar + Staff). 3 new regression tests pin the trigger contract. Decision-count for "book a call-in" on the default landing: 8+ → 5.
- **Mark off today action on `StaffProfileCard` (audit P0 #2).** Closes the audit's biggest functional gap: the `front_desk` role literally could not mark someone unavailable without leaving Schedule (the off-day affordance lived only in `Staff & Shifts`, which is owner-only). Fix: optional `onMarkOff` / `markOffLabel` / `isMarkingOff` props on `StaffProfileCard` render a "Mark off today" button below Skills when (a) the parent wires the callback and (b) the employee has a shift on the viewed date. Parent (`NewSchedulerView`) owns the API call, confirm dialog (via existing `useConfirm` + `ConfirmModal`), success/error toast, and scheduler refresh — the card stays presentational. Label adapts: "Mark off today" when viewing today, "Mark off Mon, May 11" otherwise, so the button doesn't lie when the operator is on a different date. Disabled while in-flight to prevent duplicate writes on slow networks. 6 new card unit tests in `dashboard/components/scheduler/StaffProfileCard.test.tsx` pin the contract (button hidden by default, hidden when no shift, label override, click invokes parent, disabled+progress copy while in-flight). 6 new integration tests in `NewSchedulerView.test.tsx` pin the wiring (button visible/hidden based on shift data, confirm copy names employee+day, payload shape matches `Api.shifts.schedule.save({ employee_id, shift_date, is_off: true })`, success path toasts+refreshes+closes the card, save failure surfaces error toast and leaves modal open for retry, Cancel exits cleanly with no API call). Decision-count for "mark someone unavailable" as `front_desk`: ∞ → 3.
- **Searchable customer combobox (audit P0 #3).** `AppointmentDetailPanel` previously rendered every tenant customer in a single 50+-item native `<select>` — Hick's Law violation that the audit cited as the worst affordance on the create-appointment surface. Pre-fix, the only search UI lived inline in `QuickBookPanel.tsx:164-188` (search input filtering a `<select>`); the two surfaces shared the pattern in spirit but not in code. Fix: extracted `dashboard/components/ui/CustomerCombobox.tsx` — search input + filtered native `<select>` with consistent label format (`Name (formatted-phone)`), name + phone-substring filtering, prompt option, optional disabled state, and parent-owned value/onChange. Both `QuickBookPanel` and `AppointmentDetailPanel` now consume it. AppointmentDetailPanel's address pre-fill side effect (look up `findCustomerById` and populate location) is preserved — the parent still owns the side effect, the combobox just delivers the new id. Edge cases handled at the combobox level: customer with no phone (omits parens, no `(undefined)` leak), customer with no name (`(no name)` fallback so the row stays selectable), zero-match search (prompt option remains so the control isn't visibly broken). 11 new unit tests in `CustomerCombobox.test.tsx` (default copy, name filter case-insensitive, phone-substring filter, onChange contract, prompt-clear path, disabled, override copy, formatPhone in labels, no-phone fallback, no-name fallback, zero-match prompt-only). The two surfaces now drift as a compile error if the combobox API changes — replacing two inline implementations with one shared one was the audit's explicit recommendation.
- **Empty-cell click → Quick Book prefilled (audit P1 #4).** Two surfaces shipped together. (1) Staff sub-tab (`NewSchedulerView`) — every empty hour cell on a staff row that the row's employee actually has a shift for is a click target with full keyboard support: `role=button`, `aria-label="Book {employee} at {hour}"`, `tabIndex=0`, cursor pointer + hover tint. Click / Enter / Space delivers `{ employeeId, hour, date }` to `onQuickBook`. Skills mode keeps cells passive. **Out-of-shift cells (whether outside the building's open window OR inside the open window but outside this specific employee's shift) stay passive — no role, no click, no hover.** Original P1 #4 left them clickable with the rationale "operators may book early/late," but that path landed `EMPLOYEE_NOT_SCHEDULED` immediately on submit, so the click was an invitation to a guaranteed-failure state. The system's design contract is "book only when employee+skill+resource+time align"; the UI must enforce the time half before the operator types in a customer name. Off-schedule one-offs require adding an `employee_schedule` entry first (Back Office → Shifts), then booking. (2) Calendar sub-tab (`AppointmentView`) — added optional `onSelectSlot?: (range: { start, end }) => void` prop. When wired, BigCalendar runs `selectable=true` and slot click/drag fires the callback; when omitted, the calendar stays read-only on slots. Parent (`SchedulerView`) wires both: `handleNewQuickBook` widened from no-args to accept an optional prefill, merging `selectedDate` so cell-supplied date wins for cross-day clicks. The toolbar Quick Book button still calls `handleNewQuickBook()` no-args. 10 tests in `NewSchedulerView.test.tsx` pin the contract: click delivers `{employeeId, hour, date}`; slot is passive when prop omitted; role/aria-label/tabIndex appear when prop wired AND the row's employee is on shift at that hour; Enter and Space activate; non-activation keys ignored; skills mode passive; **per-employee gate** (Carlos's 9am clickable, Mike's 6am NOT clickable even though both are on the same shop's grid); toolbar button passes no args.
- **Removed unused Jest from devDependencies (`7658fc5`).** Audit confirmed the entire test stack is Vitest 4.0.18 across all three workspaces; zero Jest API calls anywhere in `src/` / `dashboard/` / `agent/`; zero imports from `jest` or `@jest/*`. Yet root `package.json` declared `"jest": "^30.2.0"` and `"@types/jest": "^30.0.0"` — pure dead weight. Dropped both, refreshed `package-lock.json` (shrank 4,384 lines — jest dragged in 100+ transitive deps including babel runtimes, jest-runtime, alternate jsdom). Kept `@testing-library/jest-dom` (matcher library that works natively with Vitest via `dashboard/tsconfig.json`'s `"types": ["vitest/globals", "@testing-library/jest-dom/vitest"]`). Verified post-install: backend 1,646 + dashboard 551 + agent typecheck all clean.
- **Default Schedule sub-tab flipped to Staff (audit P1 #5).** `SchedulerView.tsx:37` `useState<SchedulerViewTab>('calendar')` → `'staff'`. The Staff sub-tab is the daily-use surface for front-desk operators (rows = staff, hours across, today highlighted, empty cells now click through to Quick Book per P1 #4); making it the landing eliminates the "switch sub-tabs first" friction that the audit flagged on the most-frequent task. Calendar branch's narrative subtitle reworked from "Start with the calendar. Switch to staff or resources only when you need detail" (which positioned itself as the recommended default and contradicted the flip) to neutral descriptive copy: "Month, week, or day view. Click a slot to book." No tests assumed Calendar-as-default; the existing e2e spec was already forward-compatible. Open-question from prior session ("design call on whether to flip given the inconsistent narrative copy") closed by reworking the copy in the same change.
- **Yesterday | Today | Tomorrow date chips (audit P2 #6).** `SchedulerDateNav` now renders three peer chips replacing the single Today button. Each meets WCAG 2.5.5 with `min-w-[48px] min-h-[48px]` (audit specified 48×48 for mobile reliability — tire shop / salon owners check schedules on their phones between customers per the audit theme). `aria-pressed` reflects which chip matches `selectedDate` so screen readers see the toggle state the visual primary-variant cue communicates to sighted users. Outside the today±1 window all three chips show un-pressed state — keeping the chips' job as "click to jump" affordances rather than a date-display widget. ChevronLeft/Right preserved for further-out dates. 5 new tests pin Yesterday/Tomorrow click behavior, aria-pressed truthing under varied selected dates, the touch-target minimums, and the outside-window un-pressed contract.
- **E2E coverage for the booking-alignment work.** Closed the gap that the user explicitly flagged: "does the E2E suite verify booking with people resources + skills + availability + time alignment?" Honest answer was no — the existing `quick-book-shift-overrides.spec.ts` only happy-pathed shift coverage; `workflows.spec.ts` quick-book test commented "booking can fail validly (no employee skilled+scheduled)" and treated alignment failures as acceptable. New `dashboard/e2e/booking-alignment.spec.ts` (4 tests, 5W-annotated, all passing against live servers in ~25s): (1) **UI alignment filter** — picks Balancing service in QuickBook → asserts Carlos and Dana drop OUT of the Tech dropdown (only mapped to Mike per seed), Mike + Unassigned remain. (2) **RPC enforcement** — POSTs to `/appointments/create` directly with Balancing + Carlos (unmapped pair), asserts 400 + "not assigned to perform" + zero rows inserted. (3) **Cross-view popover Cancel** — pre-INSERTs an appointment for today with a 13:23 offset, navigates to the List sub-tab (NOT Calendar), clicks the row by `data-testid="list-item-${id}"`, clicks the new popover Cancel button, accepts the native confirm, asserts DB row is `status='canceled'` AND row still exists (soft cancel, not hard delete). (4) **Cancel frees the slot** — books appointment A, cancels via API, books appointment B at the same resource+time → asserts both end up in DB (A canceled, B scheduled) proving the slot opens up after cancel. Each test cleans up in a try/finally with explicit DELETE. Total Playwright suite: 28 → 32 passing.

- **Cross-view Edit + Cancel for appointments (+ soft-cancel switch).** Closes a real architectural gap surfaced by the user during browser verification: pre-fix, the `<AppointmentDetailPanel>` (with Edit + Cancel buttons) was rendered ONLY inside `<AppointmentView />` (the Calendar sub-tab). On Resources / List / Staff sub-tabs, clicking an appointment opened only an `<AppointmentPopover>` — read-only, no way to edit or remove. The operator had to navigate to Calendar and click the appointment again to access either action. Plus the existing "Cancel Appointment" button on AppointmentDetailPanel was wired to the hard-DELETE endpoint (`DELETE /appointments/:id`) despite saying "Cancel" — a stale-list re-click after delete returned 404 ("Appointment not found"), which the user reported as the symptom that drove this slice. **Two fixes shipped together:** (1) `AppointmentPopover` gains optional `onEdit` and `onCancel` props with `appointment-popover-edit` / `-cancel` testids. Both buttons hide when the appointment is already canceled. `SchedulerView` wires them: `onEdit` switches to the Calendar sub-tab and passes `pendingEditAppointmentId` to `<AppointmentView />` so it pre-selects the appointment + enters edit mode on next render (new `initialEditAppointmentId` + `onInitialEditConsumed` prop pair). `onCancel` calls `Api.appointments.cancel(id, tenantId)` (soft endpoint) with a confirm dialog, refreshes both the scheduler data and the static data, shows a success/error toast. (2) `AppointmentView.handleDelete` (the existing "Cancel Appointment" button on the detail panel) switched from `Api.appointments.delete` to `Api.appointments.cancel`. Soft-cancel keeps the row in the DB with `status='canceled'` so a stale-list re-click can't 404, the audit trail is preserved, and the row can still be referenced by reports / call summaries. The backend's `POST /appointments/:id/cancel` route also drops the slot from synced calendars + CRMs (matches what an operator expects from "cancel"). 5 new tests in `dashboard/components/scheduler/AppointmentPopover.test.tsx` (popover renders neither button when callbacks omitted; Edit invokes with id; Cancel invokes with id; both hide when status='canceled'; Edit-only wiring renders alone). The existing `appointment.test.tsx` mock-mode guard test rewritten to pin BOTH (a) usingMockData still short-circuits and (b) the request shape that would have gone out is the new POST `/cancel` not the old DELETE — so a future regression that reverts to hard delete or re-orders the guards surfaces here.

- **Booking alignment slice 2: backend enforcement of skill+resource mapping.** Closes the determined-caller gap that slice 1 (UI filtering) couldn't reach: a curl/Postman call hitting `/appointments/create` directly could still post an incompatible booking because `book_appointment_atomic` was checking the `services.required_skills` text array against `employees.skills`, and seed data populates the `service_employee` mapping table but not the skills arrays — so the array check passed everything. Migration `20260507000000_appointments_service_id_mapping_check.sql`: (1) `appointments` gains nullable `service_id UUID FK` with `ON DELETE SET NULL` so deleting a service doesn't cascade-delete history; index on `service_id WHERE NOT NULL`. (2) `book_appointment_atomic` updated so when `p_service_id` is provided, it prefers `service_employee` mapping (when populated for that service) as the authoritative skill check, falling back to the `required_skills` array only when the mapping is empty — same precedence for `service_resource`. Mapping miss → "Employee/Resource is not assigned to perform this service". (3) Schema: `AppointmentCreateSchema.service_id` (optional UUID); `/appointments/create` route threads it to the RPC. (4) Dashboard: `QuickBookPanel` passes `service_id: serviceId || null`; `AppointmentView.handleCreateAppointment` derives it from `services.find(s => s.name === form.description)?.id`. Backward-compat: callers that omit `service_id` get unchanged behavior — every existing test passes. 6 new tests in `src/book-appointment-mapping.test.ts` (real DB + transaction-rollback): HAPPY mapped employee booking + service_id persisted on the row, SAD employee not in mapping → rejected with no row inserted, OPEN-SERVICE no rows = booking accepted, LEGACY-FALLBACK array check fires when mapping empty + skills set, NO-SERVICE-ID legacy callers unchanged, SAD resource not in mapping. Backend 1,653 → 1,659.

- **Booking alignment: dashboard dropdowns now filter to valid combinations.** Closes a real operational gap: the dashboard previously let an operator pick (employee + service + resource + time) combinations the booking RPC would reject — picking Mike + Tire Mount when Mike isn't tire-mount-trained, or Bay 3 for a service that requires Bay 1/2. The system's design contract was "book only when employee+skill+resource+time align," but only the agent's `get_available_time_slots` and the RPC's specific error codes (NO_SKILLED_EMPLOYEE, NO_AVAILABILITY) enforced it; the dashboard let the operator try and surfaced the error as a post-submit toast. Fix: new `dashboard/lib/availability.ts` exporting `buildMappingMaps(seRows, srRows)` + `filterEmployeesByService(employees, serviceId, map)` + `filterResourcesByService(resources, serviceId, map)`. New `useServiceMappings(tenantId)` hook in `dashboard/lib/hooks.ts` loads `Api.mappings.listServiceEmployee` + `listServiceResource` and exposes `O(1)` lookup Sets keyed by service_id. Both `QuickBookPanel` and `AppointmentDetailPanel` consume it and apply the filters: the Tech and Bay dropdowns narrow when a service is picked, and a stale selection that's no longer in the dropdown auto-clears. When a service has zero qualified options (orphaned mapping or service-with-no-staff-assignments), an inline `role=status` block shows "No Tech is configured to perform this service. Assign one in Back Office → Service Assignments first." and the Book/Save button disables. Open services (no `service_employee` rows) keep all options selectable, mirroring the booking RPC's "empty required-skills array = no constraint" branch — onboarding flow that introduces services before mapping them stays unblocked. 13 new tests: 8 in `availability.test.ts` (helper purity: nullable inputs, missing-key fall-open, empty-Set fall-open, defensive row guards) + 5 in `QuickBookPanel.test.tsx` (no-service all-visible, mapped-service narrows, open-service all-still-visible, blocking-message + disabled-button, reactive un-narrow when service cleared). `scheduler.test.tsx` got a one-time top-level mock for `Api.mappings.listServiceEmployee` / `listServiceResource` + `useActiveTenantId` so the legacy QuickBookPanel test cases pass under the hook's new mount-time fetch. **Out of scope for this slice (backend enforcement)**: the dashboard's `/appointments/create` calls `book_appointment_atomic`, which doesn't enforce skill matching — appointments table doesn't store `service_id`. Adding backend enforcement is a separate slice involving an appointments-table schema change. UI filtering is the practical guard: the operator can't easily pick incompatibly, but a determined caller hitting the API directly could still bypass it.

- **Observability slice 1: structured-log aggregation (backend + agent).** Picked Better Stack (Logtail's successor; free tier 1 GB / 3 days, sufficient for current secretary-hq scale). Backend gained `src/services/logger.ts` — a Pino factory that writes JSON to stdout always and, when `BETTER_STACK_TOKEN` is set, additionally forwards via `@logtail/pino` worker-thread transport. Agent gained `agent/src/logger.ts` mirroring the same shape with a singleton cache. Both services tag every line with `service` + `env`. Backend's `tenantMiddleware` already enriched the request logger with `tenant_id`; agent's `index.ts` now builds a per-call child logger with `tenant_id` + `call_id` + `caller_phone` + `room` after `sessionCtx` resolves, so a single Better Stack filter (`call_id: <id>`) returns the full timeline of a specific call. Lifecycle events instrumented in agent entry: `call_start`, `session_context_resolved`, `tenant_config_fetched`, `session_started`, `fallback_triggered` (with `reason` discriminator: `dispatch_metadata_invalid` / `session_context_lost`). Pino transport runs in a worker thread → Better Stack downtime / invalid token never blocks the main thread. 13 new tests (7 backend + 6 agent) pin the token-absent fallback (most important: a missing token must NEVER crash the boot), base-context tags, env-derived defaults (info in prod, debug in dev), `LOG_LEVEL` override, and child-logger inheritance. Setup runbook in `docs/DEPLOYMENT.md` → "Observability" with the support-query patterns ("the call dropped at 2:14pm", "why did the AI not book this customer?", "did fallback trigger today?"). **Deferred for follow-up slices:** dashboard logs (Next.js — lower priority than call path), fallback-internal logging (would touch the 13 fallback unit tests), Sentry-style error grouping, basic metrics (call success rate, booking success rate, tool-call latency), expanded live QA suite. All tracked separately in `docs/planning/TODO.md` → Observability.

**Standing-authorization rule activated.** User granted blanket commit+push authority conditional on four objective gates being met (docs updated / tests have 5Ws / tests pass / coverage good). Memory file `feedback_per_commit_approval.md` rewritten and `~/.claude/skills/commit-code/SKILL.md` updated to encode the rule in Steps 9, 12, the Confirmation discipline preamble, the Failure handling section, and the Non-negotiables list. The earlier per-action approval rule is rescinded for secretary-hq only; other projects retain whatever their own memory files define.

---

## May 6, 2026 — Test cleanup batch + skill-resource sweep + coverage tooling

Backend tests: 1,592 → 1,605 (+13 from new launch-readiness sweep). Dashboard 514/514 held. Theme: continue the any-type debt drawdown from the morning, ship the skill+resource matching reliability sweep that the pre-launch validation list called out, then wire `@vitest/coverage-v8` so the next coverage push has a real baseline to measure against.

- **`dd642bf` — Drop 41 `'any'` casts across 5 backend test files.** normalizer (12 → 0): `mockResponse as unknown as Response` for partial fetch mocks, typed RequestInit destructure. provisioning (10 → 0): `as unknown as typeof fetch` for global.fetch overrides, `init: RequestInit` parameter. coverage (7 → 0): defined `CoverageRow` type for `client.query<CoverageRow>(...)` rows. auth (7 → 0): typed `MockReply`, `RouteCapture`, `AppRequest`; `typeof import('./routes/auth').registerAuthRoutes`. routeHelpers (5 → 0): typed MockReply with FastifyReply intersection, ZodIssue import, dropped redundant `as any` on `{}`. Audited bugfix-comprehensive: 11 supposed instances were all comment-text matches in 5W headers ("WHO: any API caller"), zero work needed — same false-positive class flagged the imprecise regex artifact. TODO count refreshed (215 → 77).
- **`bbda0da` — Drop 19 `'any'` casts in 4 backend sync/regression tests.** servicetitan-sync (6 → 0): `[string, unknown[]?][]` for vitest mock-call shape; `unknown[]` for pg query params and rows; `{ id: 0, customerId: 0 } as ServiceTitanJob` for cancelJob/updateJob mock returns. high-bugs (5 → 0): `import type { JwtPayload }` + `import type { ZodIssue }`; defined `TestJwtPayload` for the 3 jwt.verify casts. square-sync (4 → 0): same vitest-mock and pg-params pattern. jobber-sync (4 → 0): same pattern; one cast became `as unknown as jobber.JobberVisit` for the deliberate null-client sad-path that exercises the runtime null guard. Audited middleware: 8 supposed instances all "WHO: any service / route..." in `it()` description strings. TODO count refreshed (77 → 58).
- **`4a4b9b4` — Drop "Axiom" from log-aggregation candidate list.** Replaced with "Better Stack, Grafana Loki" because Axiom (axiom.co) — a real log-aggregation SaaS — collides with the user's other project also named Axiom. Memory file added (`feedback_axiom_naming.md`) so future suggestions don't reintroduce it. Doc-only.
- **Pending: skill-resource matching reliability sweep + backend coverage tooling.** New file `src/skill-resource-matching-sweep.test.ts` (13 tests, 5W-annotated). Closes the docs/planning/TODO.md "Pre-launch validation" entry "Skill + resource matching reliability sweep — across all 5 industry templates." Three sections: (1) per-industry HAPPY paths covering all 5 templates — automotive with hyphenless skills, salon with empty capabilities, mobile_tire with hyphenated `tire-mount`, auto_bays with cross-axis skill×capability join, ai_platform with no requirements at all; (2) error-code matrix pinning each of the 5 specific codes (`INVALID_PARAMS`, `NO_SKILLED_EMPLOYEE`, `EMPLOYEE_NOT_SCHEDULED`, `TIMESLOT_OCCUPIED`, `NO_AVAILABILITY`) plus a second `NO_AVAILABILITY` variant for the no-skill-required-but-capability-mismatch path; (3) cross-template guards covering tenant isolation under skill-name collision and exact-match-not-substring skill semantics. The file deliberately does not duplicate `scheduling-atomic.test.ts` (abstract logic), `booking-concurrency.test.ts` (races), `scheduling-timezone-bug.test.ts` (DST), or `scheduling-overrides.test.ts` (override mechanics). What it catches that the prior tests did not: hyphenated skill names breaking under any future regex/substring matching change; empty-capabilities arrays vocabulary-colliding with the no-skill ELSE branch; cross-axis skill×capability JOIN drift; the `NO_AVAILABILITY` catch-all becoming unreachable if a future refactor moves a more-specific code below it; substring skill matching ("cut" matching "haircut") being introduced "for convenience". Same commit also wires `@vitest/coverage-v8` into `vitest.config.ts` so backend coverage is now measurable: first baseline run shows lines 62.67%, statements 60.58%, branches 53.80%, functions 64.47%. Logic coverage on launch-critical paths is strong (95%+ on auth/users/voice/agentTools/booking RPCs/all CRM clients/most services), route-handler coverage is the gap (5-50% on appointments/billing/calendar/mappings/provisioning/reminders/communications/vocabulary route handlers because tests exercise the underlying RPC/service layer rather than going through fastify.inject()). Dashboard `dashboard/package.json` also got `@vitest/coverage-v8` declared explicitly so a fresh `npm ci` in dashboard installs the dep that `dashboard/vitest.config.ts:11` already references.

---

## May 6, 2026 — Multi-tenant isolation audit + CI rot recurrence

Backend tests 1,551 → 1,592 (+41 over the day's two commits). Dashboard 514/514 held. Theme: pre-launch hardening — close two cross-tenant authorization gaps surfaced by a verify-first probe, then unbreak ~3 days of red CI on main.

- **`3a72f0d` — Multi-tenant isolation probe + cross-tenant leak fixes.** Built `src/multi-tenant-isolation.test.ts` (25 tests across 5 probe categories: query-string override, cross-tenant id under JWT-only, body-tenant_id FK injection, positive controls, admin-only `/tenants/*` gating). Real Fastify + real Postgres + RLS-enforced via api_user pool. Probe found two findings, both closed in the same commit:
  - **Finding 1 — application-layer cross-tenant override (read + write).** `tenantMiddleware` precedence (`query > body > JWT`) had no auth gate; any non-admin could pass `?tenant_id=<other>` to read another tenant's data, OR POST `body.tenant_id=<other>` to write to another tenant. 12 of 21 initial probes failed (8 read-leak shapes + 4 write-injection shapes). Closed by adding a 403 gate in `tenantMiddleware` for any cross-tenant override unless caller is super-admin; mismatched query-vs-body returns 400.
  - **Finding 2 — `/tenants/*` admin routes had no super-admin gate.** Every route used `requireAuth()` only, which checks "is authenticated" not "is super-admin." Any tenant user could `GET /tenants` (enumerate every customer), `DELETE /tenants/<other>`, `POST /tenants/reorder`, etc. Added `requireSuperAdmin()` helper to `src/middleware.ts` and applied to the destructive surface; `GET /tenants/:id/config` + `POST /tenants/:id/update-config` get a "super-admin OR own-tenant" gate so tenant users can still manage their own config.
  - **Fallout repaired:** `src/tenant-routes.test.ts` had `authStub` shape using camelCase (`tenantId`) while the production JWT payload is snake_case (`tenant_id`). New gate exposed the mismatch via undefined `req.auth.tenant_id`; fixed the stub to match. 10 new middleware unit tests pin the gate + `requireSuperAdmin` at the unit layer in addition to the integration probe.
  - Severity: pre-beta, no real customer data was at risk because DynaTire isn't live. But either finding alone would have been a critical breach in a paying-tenant SaaS once one beta customer was on the platform; both closed before launch. The probe is now permanent regression coverage; the existing DB-level `rls.test.ts` stays unchanged (DB layer was correctly enforcing whatever context the app set — the bug was that the app set the wrong context).

- **CI rot recurrence — pgvector image, set-e blind spot, dashboard tsconfig.** After pushing the security fix, discovered CI on main had been red since 2026-05-04. Three independent root causes, all fixed in one commit:
  - **CI postgres image had no pgvector.** `.github/workflows/ci.yml` used `postgres:16` (vanilla); the first migration calls `CREATE EXTENSION vector` and silently failed. Switched the CI service image to `ankane/pgvector:v0.5.1` to match the local Docker stack documented in CLAUDE.md.
  - **`scripts/setup-db.sh` swallowed migration errors.** `OUTPUT=$(psql ... 2>&1); RC=$?` looks like it captures the exit code, but with `set -e` the script exits on `OUTPUT=...` failure *before* `RC=$?` runs — the FAIL handler that prints the error never ran. Three days of red CI showed `exit 3` with no message. Wrapped the psql call with `set +e` / `set -e` so the FAIL block actually fires and prints the psql output.
  - **`dashboard/tsconfig.json` had `"types": ["vitest", "jest"]` placed at the JSON root level instead of inside `compilerOptions`.** TypeScript silently ignores misplaced fields, so the directive was dead config. It worked locally because `tsc` auto-discovers everything in `node_modules/@types/*` and lifecycle-hook globals leaked in transitively. Fresh CI installs didn't get the same tree, so `afterAll`/`afterEach` resolved as `Cannot find name`. Moved into `compilerOptions` and switched to the proper values: `["vitest/globals", "@testing-library/jest-dom/vitest"]`.
  - Verified against a fresh `npm ci` install to simulate CI before pushing: dashboard tsc clean, 514/514 tests pass, lint clean. Setup-db script tested locally — exits 1 with a visible psql error on real failure (was silent exit-3 before).

---

## May 5, 2026 — Cleanup Sweep (7 commits, type-safety + lint debt + audit truth-up)

Continuation of the verify-first pattern. Backend tests: 1,514 → 1,536 (+22, all from new helper test coverage). Skip count: 0 (held). Dashboard: 500 → 504 (+4 from new vocabulary-guard regex patterns). Theme: drive down `any`-type debt across backend tests, extract two more shared helpers, ship a UX vocabulary pass, truth up TODO entries that had drifted from reality.

- **`f686672` → `b293813` → `9364773`** — High-value 5W backfill across `rls`, `schema`, `customer`, `tenant-reorder`, `critical-bugs` test suites. 23 tests gained WHO/WHAT/WHEN/WHERE/WHY annotations covering security-critical RLS isolation invariants, the booking RPC contract (overlap-rejection error_message string the agent prompt depends on), the customer schema timezone defaults, the drag-reorder schema invariants, and the BUG-001/002/006 regression suite. Backend 5W coverage: 64 → 70/90 files.
- **`33f83cd` + `01b7009`** — Backend test `any`-type cleanup. Top-5 offender files (reminders, consentService, communications, middleware, bugfix-comprehensive) cleaned with `vi.mocked(...)` for typed mock access + `as unknown as Type` for partial-mock structural casts + proper Fastify/Pool type imports. Net: 215 → 129 instances across backend tests (40% cleared); rest tracked in TODO.md.
- **`5f12215` + `2cd381a`** — Destructive-flow tests (NEW). Four flows pinned: tenant DELETE (3 tests), tenant POST /reorder (5 tests, asserts sort_order = 0..N-1 invariant + ROLLBACK on partial UPDATE failure + auth gates), shift override CRUD (9 tests across POST create + POST update + DELETE), and AppointmentView mock-mode `handleUpdate` + `handleDelete` guards (2 tests verifying no `/update` POST and no DELETE fetch happen when `usingMockData=true`).
- **`88701c0`** — NEEDS-REFACTORING #11 deferred-part verify-first. Reusable pieces (`useStaticData`, `useActiveTenantId`, `useVocabulary`, `AppointmentDetailContext`) were already extracted; remaining orchestration is component-specific with one consumer each.
- **`cbf22b0`** — Dashboard test `any`-type cleanup. ~27 instances → 0 across `superadmin.test.tsx` + `settings.test.tsx`. New `dashboard/lib/test-utils.ts` exports a typed `mockJsonResponse(body, init?)` helper. Caught a real latent bug: a `lastCall = .find(...)` deref of a `T | undefined` that the prior `as any` cast had been hiding.
- **`b293813`** — Vocabulary pass on UI strings. 4 user-visible jargon strings replaced: "Multi-Tenant Management" → "Multi-Business Management", "Skill Matrix" / "Service Assignment Matrix" → "Service Assignments", "coverage gaps" → "aren't fully staffed yet". `vocabulary-guard.test.ts` extended with 4 new banned-pattern regexes.
- **`3eba91b`** — `disconnectCrmIntegration` helper extracted. Verify-first found CRM disconnect/sync-status response *shapes* were already normalized. The remaining duplication was at the *implementation* level — 4 × 16-line disconnect handlers differing only in the provider literal. Extracted to `src/services/crmDisconnect.ts`. 5 unit tests. Net: ~30 lines deduped.
- **`faf3056`** — Canonical `TenantFull` typing for the dashboard. Three components (TenantCard, SuperAdminDashboard, TenantEditPanel) had local `type Tenant = { ... }` declarations. Migrated to `import type { TenantFull }`. Two canonical-type fixes: relaxed `Tenant.{voice_id, system_prompt, first_message}` to `string | null` (matches DB nullability), added `TenantFull.{system_prompt_template, first_message_template}` as optional read-only.

## May 4, 2026 — Refactor Marathon (8 commits, ~−800 lines net)

Backend tests: 1,456 → 1,514 (+58, mostly from new helper test files). Skip count: 2 → 0. Dominant pattern: extract-helper-then-migrate-callers, with verify-first redirecting two original framings ("unify token refresh" → "extract OAuth state JWT"; "drop withTenantClient param" → "extract mock test helpers") toward higher-ROI targets.

- **`9b0a572`** — UsageTrackingService deleted (NEEDS-REFACTORING #3). In-memory stub with no DB persistence, no Stripe meter reporter, no metered-tier customer. Deleted under the test-or-delete lens. Removed `src/services/usage/`, `src/types/usage.ts`, the optional `usageTracker?` constructor param on `CommunicationService` + `SMSService`, and the `await trackSMS(...)` block.
- **`f4ac89a`** — `paginateSync()` helper extracted (NEEDS-REFACTORING #10, narrow). 7 inline pagination loops across the 4 CRM sync modules collapsed into calls to `src/services/syncPaginate.ts`. Generic over both item type and cursor type (handles Jobber GraphQL `pageInfo`, HubSpot `paging.next.after`, Square `result.cursor`, ServiceTitan page-number `hasMore`). 9 5W-annotated tests including a regression test for the null-initial-cursor case caught mid-refactor.
- **`c12d075`** — CLAUDE.md drift detector (NEEDS-REFACTORING #13). New `scripts/verify-claude-md.ts` runs five checks (route count, migration count, template count, listed-directory existence, commit reachability from main). Wired into the backend CI job + `npm run verify:claude-md`. Numeric-count checks scope to the current-state portion (skip historical Resolved Issues archive); commit-reachability scans the full document. Inline `<!-- verify-claude-md: unmerged -->` marker opts known-unreachable hashes out. 25 5W-annotated tests pin the pure check functions.
- **`24a2e47`** — `improvement-ideas.md` pruned (NEEDS-REFACTORING #12). 6 closed task blocks deleted, 1 ALREADY SHIPPED entry preserved as audit evidence. Preamble rewritten to declare the file as generator output, not a curated backlog. 2137 → 2089 lines.
- **`cdfd0b4`** — Mock test helpers extracted (~350 lines deduped). Surfaced by the verify-first on the deferred part of NEEDS-REFACTORING #11: 13 test files duplicated `createMockClient` / `createMockPool` / `mockWithTenantClient` (~25 lines each). New `src/services/test-utils-mock.ts` is a strict superset: always tracks queries, always bypasses `SET LOCAL` / `RESET` session-variable scaffolding, mock pool exposes both `connect()` and `query()`. 12 5W-annotated helper tests.
- **`647866a`** — OAuth state JWT helpers extracted (~72 lines deduped). The truly shared code wasn't the token refresh (Google SDK vs Outlook fetch genuinely differ) but the **OAuth state JWT** — sign + verify duplicated across 6 files (Google + Outlook calendars + Jobber + HubSpot + Square + ServiceTitan clients) with only the `purpose` discriminator differing. New `src/services/oauthStateJwt.ts` with 10 5W-annotated tests covering round-trip, payload shape, env-secret fallback, custom expiry, and four sad paths including cross-provider replay defense.
- **`ed26cbc`** — Tenant bootstrap doc cleanup. Verify-first found `src/services/tenants/bootstrap.ts` was already shipped on 2026-04-30 (commit `19d6b8b`); both call sites already consumed it; 9 unit tests with 5W comments already covered happy + sad. Pure `docs/planning/TODO.md` truth-up.
- **`f686672`** — `get_effective_shifts` skips re-enabled (2 → 0). Both `it.skip`'d tests in `src/shift-overrides-edge.test.ts` (skipped 2026-04-30 when the `employee_shifts` pattern fallback was retired) replaced with new tests under the `employee_schedule`-only contract: HAPPY "multi-day range returns every row in date order" (5 weekday seeds, asserts row order + content) and SAD "rows outside the queried range are filtered out" (3 seeds Mon/Wed/Fri, query Wed-only, expect exactly 1 row).

## May 3, 2026 — Voice Fallback Validation + Tenant-Config Redo on Main

Two-part day. The fallback validation surfaced a documented-but-not-actually-shipped feature, and the same investigation found that NEEDS-REFACTORING #2 (tenant-config wiring) was in the same shape — claimed shipped, actually on a forgotten branch. Both closed.

**Voice fallback path validation** (queue #9). CLAUDE.md / ARCHITECTURE.md / NEEDS-REFACTORING.md #9 had all claimed `runFallback()` used OpenAI TTS as a guard against Grok outage, but the actual code on main wired GrokTTS in both the primary path and the fallback — meaning a Grok outage would leave the fallback unable to speak. Three closures:

- Extracted `runFallback()` to `agent/src/fallback.ts` with injectable provider deps.
- Switched the fallback TTS to OpenAI (matches what docs already claimed). Provider keys are passed in as a `FallbackConfig` arg rather than imported, so the function is testable without going through the env-validation `process.exit(1)` path.
- Awaited `session.say()` so a synthesis-time TTS failure is caught inside the try block instead of escaping as an unhandled promise rejection.

13 new 5W-annotated tests in `agent/src/fallback.test.ts`: happy path message + interruption blocking + start-before-say ordering + VAD wiring; OpenAI-not-Grok provider-choice contract (3 tests including a dedicated negative test); never-throw contract under each failure mode.

**Tenant-config wiring redone on main** (closes NEEDS-REFACTORING #2). The fallback validation surfaced that commit `e92b3bf` <!-- verify-claude-md: unmerged --> ("feat(agent): fetch tenant display config from backend at call start"), claimed on 2026-05-01 to close NEEDS-REFACTORING #2 P0, actually lived on a `hold-tenant-config` branch and was never merged to main. Path B (redo on main) taken:

- New `POST /agent-tools/tenant-config` route in `src/routes/agentTools.ts` returns `{ name, timezone }`; null timezone → `'America/Chicago'`. 4 backend tests.
- New `agent/src/tenantConfig.ts` module with `fetchTenantConfig(client, tenantId)` and `TENANT_FALLBACK` constant. Returns the fallback on any non-success envelope. 6 agent-side tests.
- Agent worker wired — `agent/src/index.ts` now calls `await fetchTenantConfig(...)` and uses the result for `buildSystemPrompt(...)` and the spoken greeting. The hardcoded DynaTire block deleted.

Backend: 1,475 → 1,479. Agent suite: 53 → 72 tests.

## May 2, 2026 — Concurrency Fix + Structural Refactors + Test-or-Delete Policy

12-commit unblocked-work session that closed a real launch blocker, slimmed `src/index.ts` by 28%, and captured the decision principle as a durable Build Principle.

**Booking concurrency hole closed** (`55be6dc`):
- Race confirmed under READ COMMITTED with a 20-caller load test: 9/20 winners on the resource race, 20/20 on the employee race. The find-then-insert pattern in `book_appointment_atomic` / `book_with_scheduling_atomic` could pass two `NOT EXISTS` checks before either committed.
- Closed by two GiST exclusion constraints (`appointments_no_resource_overlap`, `appointments_no_employee_overlap`) scoped to scheduled, non-deleted appointments, paired with `exclusion_violation` handlers in both RPCs that return the existing `TIMESLOT_OCCUPIED` error code.
- New test file `src/booking-concurrency.test.ts` (2 real-DB race tests).
- Migrations `20260501000000` + `20260501000001` shipped to repo, **not yet applied to prod Supabase** — pre-flight overlap-scan needed first.

**`src/index.ts` 385 → 279 lines** across three commits:
- `fbc1eaf` — JWT preHandler extracted to `src/middleware.ts` as `registerJwtAuthHook(app, pool)`. Includes `JWT_SECRET`/`JWT_EXPIRY`/`generateToken`/`verifyToken`/`PUBLIC_ROUTES` and the password-rotation check.
- `9b78030` — DB pool config consolidated. `src/database/index.ts:getPool()` is now the canonical singleton with deadlock-prevention timeouts.
- `5077fd6` — `withTenantClient` factory moved to `src/database/index.ts` as `createWithTenantClient(pool)`.

**`src/services/crm/` deleted** (`2cc782a`, NEEDS-REFACTORING #1):
- 21 dormant CRM adapters + `BaseCRMAdapter` interface + `createCRMAdapter()` factory + the mocked-API test file removed (3,480 lines).
- Two of the deleted adapters (`dentrix.ts`, `eaglesoft.ts`) were dental-practice CRMs that violated the platform's HIPAA-excluded-vertical policy.
- Decision policy locked: anything we can't test against gets deleted. The four working flat clients (jobber/hubspot/square/servicetitan) are unaffected.

**Build Principles captured in CLAUDE.md** (`18181bc`):
- Test it or delete it. Build for real customers. Working flat code beats a dormant abstraction. HIPAA verticals permanently excluded.
- NEEDS-REFACTORING.md gained a "Resolution lens" preamble.

**Other landings:**
- `c9f40c6` — `scripts/setup-db.sh` bootstrap bug fixed (psql `-c` and stdin heredoc were mutually exclusive).
- `6f91b7b` — OTP Phase 3 status truthed up in CLAUDE.md (work had already shipped in commit `18caffe` on 2026-04-24).
- `c18c996` — Telnyx PSTN ticket re-submitted to LERG/porting team after the original `#2850682` went 4 days without a human response.
- `889d25b` — All *.md files aligned with the day's landings.
- `444dad1` — Last three pre-existing test files (`index.test.ts`, `normalizer.test.ts`, `scheduling.test.ts`) gained 5W diagnostic comments — 47 tests annotated; the 5W convention is now universal.

**Test state at session close (May 2):** 1,475 backend + 498 dashboard = 1,973 passing + 2 documented skips, 0 failures, typecheck clean both surfaces.

## April 24, 2026 — UX Review & Polish Batch

Full UX review of the dashboard identified 20 items across P0–P3. 14 shipped across commits `dac97cb`, `91c9903`, `7042a8e`, `3954d4c` + supporting refactors (`2f74991`). Deferred items need design input (admin-mode color, theme-selector placement, first-run nav callout) or bigger investment (skeleton screens, Remember-me refresh tokens).

**P0 trust fixes:**
- Visible load-error banner + retry on `DashboardHome`. Uses `Promise.allSettled` so partial data still renders.
- Login copy stripped of developer-internal terminology ("Multi-Tenant Management Console", "Ready for Live Integration", "Is the backend server running?").
- `ErrorBoundary` shows a friendly message in production; raw `Error.message` only renders when `NODE_ENV !== 'production'`.

**P1 affordances:**
- Login: create-account link, password show/hide toggle, `autoComplete="username"`, label/input a11y wiring.
- Today's Schedule empty state offers CTAs ("View this week", "See staff shifts").
- Unanswered-questions badge bubbles up to the Back Office mode tab.
- Fitts's Law: entire Today's Schedule card header is a single large click target.
- Icon-only buttons in `OutlookLayout` top bar carry `aria-label`. Profile button has `aria-expanded` + `aria-haspopup`.
- `ErrorBoundary` has a "Reload page" escape hatch.

**P2 polish:**
- Tenant switcher dropdown uses CSS vars (themes correctly across all 8 palettes).
- Quick-actions grid: `md:grid-cols-3` → `md:grid-cols-2 lg:grid-cols-3`.
- "Setup Assistant" quick action label corrected to "Services & Resources".
- User-facing "tenant" replaced with "business" in error messages. `vocabulary-guard.test.ts` prevents regression.

**Backend hardening:**
- Startup warnings extracted from `index.ts` into `src/services/envWarnings.ts` (pure function, 10 unit tests). Added a warning for missing `TELNYX_API_KEY`.

**Test coverage added:** +50 dashboard tests, +10 backend tests.

## April 23, 2026 — Phone Verification (SMS OTP)

- New table `phone_verifications` (tenant_id, phone, code_hash, expires_at, attempt_count, verified_at). RLS + FORCE RLS. Migration `20260423000000_phone_verifications.sql`.
- New service `src/services/telnyxSms.ts` — Telnyx Messaging API wrapper + `generateVerificationCode(digits)` using `crypto.randomInt`.
- New agent tools: `POST /agent-tools/send-verification-code` (rate-limited: 3/phone/hour, 100/tenant/day) and `POST /agent-tools/verify-phone-code` (5 tries max, 10-min TTL, bcrypt-hashed codes).
- SMS body locked: `Your SecretaryHQ verification code is: 123456. Reply STOP to opt out.` (TCPA opt-out required).
- Booking routes (`book-appointment`, `book-with-scheduling`) gate on `isValidPhone(args.phone)`. Invalid phone → route returns the ask-for-phone message; LLM reads it, asks the caller verbally, kicks into the OTP flow. Valid caller-ID phone skips verification.
- 12 new tests in `agentTools.test.ts`, 7 in `telnyxSms.test.ts`, 3 in booking-route gates.
- **System prompt (Phase 3):** Done in commit `18caffe` (2026-04-24) when the LiveKit `agent/src/prompt.ts` was created.

## April 12, 2026 — Improvement Hardening

- Employee update route missing `AND tenant_id` in WHERE clause — cross-tenant employee updates were possible. Fixed by adding tenant_id scoping + `assertRowAffected` guard.
- Zero-row mutation guards added to employees, customers, appointments, tenants, knowledge, resources, services routes — all previously returned `{ success: true }` when UPDATE/DELETE affected 0 rows (silent no-op).
- Shared route helpers extracted to `src/routes/routeHelpers.ts`.
- `nameUtils.ts` extended with `slugify()` and `buildDisplayName()`.

## April 1, 2026 — Voice AI Bug Fixes

- BUG-059: Timezone regression in `book_with_scheduling_atomic()` — hardcoded UTC instead of tenant timezone for shift validation. Fixed with migration `20260401000000_fix_scheduling_timezone_bug.sql`.
- BUG-060: Phone number stored as "+1" (incomplete) — `normalizePhone()` now rejects < 10 digits.
- BUG-061: Wrong date booked — Vapi assistant had hardcoded stale date in system prompt, now uses dynamic date.
- BUG-062: No employee assigned — AI wasn't passing `requiredEmployeeSkills` array, prompt updated with service-to-skill mapping.
- BUG-063: Call hangs up on booking failure — added error handling to Vapi assistant prompt.
- BUG-064: Generic booking error messages — added specific error codes (TIMESLOT_OCCUPIED, NO_SKILLED_EMPLOYEE, EMPLOYEE_NOT_SCHEDULED) via migration `20260401000001_specific_booking_errors.sql`.

## April 1, 2026 — Remaining Bug Fixes

- BUG-030: `link_orphaned_transcripts()` now called automatically in `dispatcher.handleCallEnded()` after every call.
- BUG-031: `checkAvailability()` now uses `check_availability_with_tz()` RPC for timezone-aware results.
- BUG-032: n8n workflow now generates embeddings (text-embedding-3-small) and stores in `call_summaries.embedding`.
- BUG-038: All edge function queries on soft-deletable tables filter `is_deleted`. `deleteEmployee()` uses soft delete.
- BUG-039: ARIA attributes added to Toast, Card, FeedbackButton, CoverageBar, OutlookLayout tabs.

## March 2026 — Code Review

- 58 bugs identified and resolved across Critical/High/Medium/Low severity.
- `users.email` scoped to per-tenant uniqueness (BUG-002).
- RLS standardized on `app.current_tenant_id` (BUG-006).
- Dev bypass button removed (BUG-005).
- `handleEditFormChange` fixed in CRMView (BUG-004).
- Fastify monolith broken into 20 route modules with RLS enforcement (BUG-017).
- Scheduling logic consolidated into `shared/scheduling.ts` (BUG-016).

## Phase 12 — Scheduler, Assignments & Coverage Visibility (Complete)

- **12A — Repeatable Setup Wizard**: 7-step guided setup (Services, Resources, Employees, Shifts, Assignments, Review, Go Live), live coverage badges, phone activation on final step.
- **12B — Scheduler Views**: Staff swimlanes (24hr, zoom), resource columns, appointment list, calendar sub-view. Quick Book panel, Employee Day Focus panel.
- **12C — Skill Relationship Map**: Interactive 3-column mind map with click-to-connect/disconnect.
- **12D — Coverage Visibility**: `check_coverage_gaps()` RPC, coverage bars, status badges, `GET /coverage` endpoint.
- **12E — RAG Normalization Layer**: `shared/normalizeForEmbedding.ts` (gpt-4o-mini), `normalized_text` column, query normalization in edge functions.
- **12F — Stripe Lite**: Solo ($129/mo) + Growth ($279/mo), Stripe Checkout, webhook (3 events), subscription gate middleware (402).

**Additional features shipped with Phase 12:**
- 8-theme system (light, dark, midnight, nord, sunset, forest, high-contrast, solarized) — ThemeProvider + CSS custom properties + palette picker.
- Admin tenant reorder via drag-and-drop with save/discard. `sort_order` column, `POST /tenants/reorder`.
- Type-to-confirm modal for tenant deletion.
- `tenantsVersion` counter in SessionContext keeps the dropdown in sync with the admin panel.

## Design Session — March 24, 2026

Full UI/UX design session. All decisions documented in `docs/UI_UX_DESIGN.md`, `docs/DECISIONS.md`, `docs/DESIGN_HANDOFF.md`. Do not second-guess these without explicit instruction from Dale.

**Work items (all complete as of 2026-03-25):**
1. Apply dark sidebar visual style — all components use CSS vars, all themes dark.
2. Rebuild theme system — `--font-display`/`--font-body` in all 8 themes, dropdown switcher.
3. Flip the scheduler — NewSchedulerView: rows=staff, cols=hours, 24hr, split-panel scroll sync, business hours shading, zoom.
4. Staff quick profile card — read-only, anchored, outside-click dismiss, skills as indented vertical list.
5. Skills toggle — Hours mode (shift bar + appointments) / Skills mode (stacked skill-colored bars).
6. Drag to reorder staff rows — grip handles, save/discard, persists to localStorage per tenant.
7. Rebuild analytics — 3 active metrics (booking data), 3 Phase 2 placeholders (Vapi).
8. Remove Coverage Map — `ServiceCoverageView.tsx` deleted, zero references remain.

**Locked decisions:**
- **Fonts:** Bebas Neue (`--font-display`) + DM Sans (`--font-body`). Universal. Use CSS variables only.
- **Coverage Map:** Removed. `CoverageBar` and `CoverageStatusBadge` primitives retained (used by SetupWizard, SkillMap, ResourceColumns).
- **Analytics:** Rebuilt. 6 metrics — 3 active from booking data (Busiest Hours, Return Rate, No-Show Pattern), 3 pending call log integration.
- **Logo:** "Secretary HQ" (space between words).
- **Philosophy:** We show data. They manage their business. No warnings, no grades, no opinions. See `docs/UI_UX_DESIGN.md` Design Philosophy section.

## 2026-06-23 — Mechanical TODO hygiene batch 2 (10 items, separate branch/PR)

New branch `chore/mechanical-todo-hygiene-batch-2` (created via `bash scripts/create-feature-branch.sh` from latest main for separation from prior `chore/eslint-header-comment-refresh` hygiene work).

10 mechanical items (only doc + comment consistency / ref standardization; no logic, no new features, no test fixes, per AGENTS.md scope strictly):

1. Fixed incorrect `src/routes/export.ts` reference in Gap inventory "Key files per gap" table in docs/planning/TODO.md (updated to actual `src/routes/exportData.ts` and improved description).

2. Populated the previously "(empty)" "## Documentation" section in docs/planning/TODO.md with 4 small current mechanical/doc tasks (hygiene sweeps, Gap table sync, footers, etc.).

3-10. Mass + targeted mechanical cleanup of remaining old/short REFACTORING_TODO / NEEDS-REFACTORING references (using bash grep + sed for cross-file patterns + search_replace for precision + post-edit `grep -r "old_pattern" . | wc -l` confirmations reporting 0 stragglers):

   - Updated short "REFACTORING_TODO #9" in describe() in scripts/verify-schema-alignment.test.ts.
   - Updated "REFACTORING_TODO.md item 10" in scripts/ingest-knowledge.ts and verify-*.ts comments to include "historical ... (see RESOLVED.md)".
   - Updated 4 "See REFACTORING_TODO.md item 10." in src/services/*/ *.test.ts + tests/template_test.ts + tests/schema_test.ts to "See historical ... (see RESOLVED.md for details).".
   - Updated "REFACTORING_TODO.md Item 2" in src/services/reminders/types.ts.
   - Updated several "Part of ESLint debt reduction (REFACTORING_TODO.md item 10)." in src/database/, src/services/tokenManagement.ts, src/services/crm/squareClient.ts, reminders/ etc.
   - Mass sed normalized ~35+ "as part of full cleanup (REFACTORING_TODO.md item 10)." eslint-disable header comments in shared/, src/routes/*, src/services/*, src/workers/, src/*.ts etc. to the canonical "historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details)." form used elsewhere.
   - Additional targeted fixes in src/types/index.ts (header + inline comment).

All changes are string/comment/doc only. Final verification grep for bad short forms: 0 remaining.

**Gates run (per standards):**
- `npm run verify:claude-md`: clean.
- `cd dashboard && npx tsc --noEmit`: clean (empty output).
- `npm run checks`: format:check clean, lint clean (exit 0 overall).
- No `npm test` (per AGENTS).

Updated docs/planning/TODO.md (Status at a Glance + the 10 listed) and this RESOLVED entry. BRANCH_CHECKLIST.md copied by create script.

This batch continues the mechanical hygiene theme from TODO's "Small mechanical hygiene pass completed" and "Tooling cleanup" notes, without touching any non-mechanical P0/P1/P2 items. 

Ready for prepare-commit / commit-code / PR.

---

## 2026-06-23 — Additional mechanical doc hygiene batch (10 independent items on chore/eslint-header-comment-refresh)

Continuation of the prior 2026-06-23 hygiene pass (route counts, eslint header comments). 10 small, independent, solo-doable mechanical refactors / doc syncs (no new logic, no design, no test authoring/fixing per AGENTS.md scope). All changes are comment/doc/string consistency only. Branch already clean at start; edits + gates only.

Picked from spirit of open doc hygiene / stale ref items tracked in TODO/RESOLVED/GAPS (e.g. "Doc hygiene pass (route counts, Vercel refs, phone quals, REFACTORING comments) done mechanically", "full Vercel→Railway hosting alignment is follow-up mechanical task", lingering historical file refs, count drift in secondary docs).

Items executed (each independent, verifiable by grep + tsc/checks/verify):

1. Replaced stale "134 migrations" (x2) → "142 migrations" in root README.md (table row + project structure tree).
2. Replaced stale "Backend routes (26 modules)" → "Backend routes (29 modules)" in root README.md coverage table.
3. Synced approximate test counts in root README "Testing" section + commands (Backend ~1,770→~1,940; Dashboard ~747→~790; E2E note updated for accuracy per CLAUDE).
4. Fixed docs/ARCHITECTURE.md: "### 9.1 Route modules (27)" header → (29); cleaned parenthetical "28 distinct registered..." claim to accurate "28 registered calls ... + 1 internal scaffold helper".
5. Removed duplicated " `src/index.ts` is slim — ..." paragraph (was repeated verbatim right after itself) in docs/ARCHITECTURE.md §9.1.
6. Mechanical cross-file normalization (bash grep + sed + targeted edit + post-grep zero stragglers for live pointers): removed lingering "lives in `planning/RESOLVED.md` / `NEEDS-REFACTORING.md`" phrasing and the table row for the deleted file in root + docs/README.md (historical narrative refs in TODO/RESOLVED/DIAGRAMS left as-is).
7. Updated CLAUDE.md agent description "tools (12 tools)" → "tools (17 tools)" (actual count: `grep -c 'llm\.tool(' agent/src/tools.ts` = 17 — tools are registered via `llm.tool(...)`, not `createTool`); drift verify re-ran clean.
8. Bumped "Last updated" / "Last verified" footers in root README.md, docs/README.md, docs/ARCHITECTURE.md to document this additional hygiene pass (and noted the 10-item batch).
9. Sweep + zero additional fixes needed: grepped *.md + *.mmd for other stale "2[0-9] route", "13x migrations", old test nums, etc. Confirmed uniformity at 29/142 after prior items; no actionable stragglers beyond historical cites.
10. Full verification gates (per CODING_STANDARDS + DEVELOPMENT_WORKFLOW + BRANCH_CHECKLIST + PR template): `npm run verify:claude-md` (clean), `npm run checks` (format:check + lint --max-warnings 0 + tsc root + dashboard; exit 0, no output on tsc means zero errors), explicit `npx tsc --noEmit` (backend/dashboard/agent — all clean). No `npm test` per AGENTS mechanical scope. Updated this RESOLVED + TODO status note. Changes are doc-only so no e2e or behavioral tests required.

**Verification proofs (as in prior hygiene entry):**
- Pre/post `grep` for stale strings (134 migrations, 26 modules, (27), NEEDS-REFACTORING live paths, etc.) → 0 remaining actionable.
- `npm run verify:claude-md` clean (twice).
- `npm run checks` exit 0.
- Full `npx tsc --noEmit` (root + dashboard + agent) — zero errors, no output.
- `grep -r "old" .` style confirmations reported in session for each replace.
- Git working tree had only these targeted doc edits.

This keeps secondary docs from drifting after the 29/142 state (post PRs #56-67 etc). No prod impact, no migration, no runtime change. Ready for `npm run prepare-commit` style close if committing.

**Test state note:** Units per CLAUDE ~1,940+790+360 (no new tests added in this mechanical pass).

---

## 2026-07-04 — GAPS.md trim: delivered specs moved here from GAPS.md

GAPS.md is the "did we miss a whole category?" inventory — it should scan as *what's still missing*, not carry full design specs for shipped work. Two now-shipped design specs were moved out of GAPS.md, lightly edited to past tense (GAPS keeps a one-line `SHIPPED — <what> (<file/route>)` pointer). History preserved below.

### Customer Self-Service Action Links (SHIPPED — see `src/routes/selfService.ts`, `dashboard/app/self/*`)

Original 2026-06-15 gap state + delivered design spec:

Current state (confirmed 2026-06-15):

- All notifications were one-way. SMS bodies in `src/services/communications/smsService.ts:204-210`:
  - Confirmation: `✅ Confirmed: ${service} with ${staff} on ${dateTime}. Reply STOP to opt out.`
  - Reminder: `🔔 Reminder: ... Reply STOP...`
  - Cancellation: `❌ Cancelled...`
- No URLs, no "tap to change", no "reply YES to confirm change".
- `appointmentService.ts:139-213` built the data but passed only service/staff/datetime; no action links generated.
- Auth'd routes existed: `POST /appointments/:id/cancel` and `/reactivate` (`src/routes/appointments.ts:341-438`), but they required full tenant JWT + `withTenantClient`.
- No unauthenticated or token-gated customer paths. Emails had password-reset style links (`systemEmail.ts`) but nothing for appointments.
- `AppointmentData` interface (in communications/types) lacked any link fields.

Minimal viable design (actionable spec — as delivered):

- Generate short-lived, single-use or short-expiry signed tokens (JWT with `appointment_id`, `action: 'cancel'|'reschedule'|'view'`, `tenant_id`, `exp`, signed by existing JWT_SECRET or dedicated secret).
- Or opaque DB-backed tokens in a new small `appointment_action_tokens` table (appointment_id, action, token_hash, expires_at, used_at, one-time).
- New route file or extension: e.g. unauthenticated-but-validated `POST /self-service/appointments/:appointment_id/cancel?token=...` (or better, a small dedicated router mounted without tenantMiddleware for these).
  - Validate token matches appointment + tenant.
  - Call the existing cancel logic (or share the RPC/service).
  - Return simple success page (or redirect to a "your appointment was cancelled" branded static with rebook CTA).
- Extend `AppointmentData` + email/SMS templates (both Handlebars in emailTemplates + the applySMSTemplate switch) to accept `actionLinks?: { rescheduleUrl?: string; cancelUrl?: string; manageUrl?: string }`.
- In `appointmentService.ts` (and callers in reminders + appointment creation paths), after booking, generate the links using `DASHBOARD_URL` + `/self/...` + token and pass them down.
- For SMS: use a URL shortener (or just full URL; keep total < 160 chars — possible with terse copy + one primary link e.g. "Change: https://.../a/123?tk=abc123").
- Dashboard: on AppointmentDetailPanel or list, button "Send customer self-service links" (or auto-include on all confirmations going forward). Show which links were sent.
- Edge cases: token expiry (clear error + "call us"), concurrent staff change (409 + explanation), already-cancelled (idempotent or informative), rate-limit the self-service actions.
- Persistence: on success, write to `communications_history` + perhaps bump a `customer_action_via_self_service` metric.
- DB impact: minimal (new optional column on appointments? or pure token table). Existing soft-delete/cascade already handles cleanup.
- Tests: new integration test for token redemption (no auth header), E2E for "owner books → customer gets SMS with link → link cancels", negative cases (expired, wrong tenant, double use).
- Comms consent: self-service actions should still respect opt-out (don't send links to opted-out).

Why this was big: Turns the AI from "booker only" into full lifecycle receptionist. Directly attacks competitor weakness "receptionist is rigid / half-baked". Reduces owner phone time dramatically. Easy to A/B (include links or not).

### Owner Billing Experience (SHIPPED — see `dashboard/components/BillingView.tsx`, `POST /billing/portal`)

Delivered spec (was "Concrete owner billing experience that is needed"):

- A "Billing" section (or card in My Business / Settings) that shows `subscription_status` + `subscription_plan` (from the status endpoint), current period, price, next bill.
- Plan comparison or upgrade buttons that call the existing `/billing/checkout` and redirect to the returned `url` (Stripe Checkout).
- "Manage payment method / invoices" button that creates and redirects to a Stripe Billing Portal session (one extra Stripe API call: `stripe.billingPortal.sessions.create({ customer, return_url })`).
- On success/cancel redirects, refresh status and show toast ("Thanks! Your plan is now active").
- Surface subscription gate errors nicely in UI (currently only 402 on API calls).
- Metered add-ons later (see Cost section).
- Quick win realized: Stripe Customer Portal first (invoices, payment methods, plan change, cancel) + "current plan" display + upgrade path.

**Still open (not code):** live-Stripe verification (test-mode + `stripe listen` + full round-trip) — a Dale/env action.

### Fully-shipped one-liners purged from GAPS.md (2026-07-04 sweep)

These closed items were annotated `SHIPPED` inline in GAPS.md; they had no remaining open tail, so the receipts now live here and the GAPS.md lines were removed:

- Billing/plan management surface — `dashboard/components/BillingView.tsx` + Stripe Customer Portal (`POST /billing/portal`, `src/routes/billing.ts:228`).
- `dashboard/lib/api.ts` `billing` namespace types `'solo' | 'growth' | 'professional'` + `status(tenantId)` (missing-`professional` stub fixed in checkout + all client billing paths).
- `automatic_tax` passed to the Stripe checkout session (gated behind `STRIPE_AUTO_TAX=true`).
- Owner "Delete old calls" soft-delete (single + bulk older-than-N-days) in `VoiceCallsView`.
- Tenant-visible audit log — `GET /audit-log` (owner-gated, paginated, table + date filters) + `AuditLogView` (Setup → "Audit Log" sub-tab, old→new field diff); audit trail extended to services + employees (migration `20260622000000`).
- Full-tenant data export — `GET /export/tenant-data` (`src/routes/exportData.ts`, owner-gated JSON dump of 25 tables, `password_hash` excluded) + "Download my data" button in `BusinessSettingsView`. Delivered as JSON, not ZIP-of-CSV, to avoid a new dep.
- Owner admin guide + "how to read the analytics" — `docs/OWNER_GUIDE.md`.
- Prod incident + telephony runbook — `docs/RUNBOOK.md` (agent-silent, reminders-not-sending, Stripe-webhook-400, backend-down, DB-pool-saturation, full Telnyx→LiveKit→agent path).
- Stale edge-functions section removed from `docs/DEPLOYMENT.md` (phases renumbered).

---

## 2026-07-05 — Documentation consolidation: single TODO.md

`docs/planning/TODO.md` is now the **one** backlog. Four scattered TODO-bearing docs were folded into it and deleted: `AIASSISTANT_GO_LIVE_TODO.md`, `GAPS.md`, `IMPROVEMENT_IDEAS.md`, `IMPROVEMENTS_TODO.md`. Their **open** items were deduped + prioritized into the new TODO.md; their **done** items + analysis prose are archived verbatim below (git also preserves the originals). Reusable procedure/reference docs that merely use checkbox syntax were left intact (`BRANCH_CHECKLIST.md`, `CODING_STANDARDS.md`, `DEPLOYMENT.md`, `DEVELOPMENT_WORKFLOW.md`, `ALERTS.md`) — they are not backlogs. Telnyx/REFER go-live ops detail now lives solely in `docs/RUNBOOK.md` §7.

### Migrated DONE items from docs/planning/TODO.md (verbatim)

- [x] **P0 verification gaps — testing trio** — DONE 2026-07-01 (branch: `test/blindspot-p0-verification`; per-item detail: `docs/planning/TODO.md` "Verification blind spots" section, audit: `docs/TEST_DB_AUDIT.md`)
  - Real-DB booking integration test in CI: `src/agentToolsBookingIntegration.test.ts` (mutation-verified against the tz bug).
  - Tool-selection eval: `agent/scripts/sim-toolselect.ts` via `./scripts/simulate.sh toolselect` (baseline 6/6).
  - Mocked-DB audit + 6 real-DB companion suites (analytics, auditLog, versionHistory, voice, reminders seed, customer search).
- [x] **🐛 BUG — `/agent-tools/find-customer-by-name` ILIKE wildcard over-disclosure** — FOUND + FIXED same day (2026-07-01, by `agentToolsCustomerSearch.realdb.test.ts`). LIKE metacharacters (`%`/`_`/`\`) are now escaped before interpolation into `'%' || $2 || '%'`, so a `%` in a transcribed name matches literally instead of dumping the tenant address book. Regression test asserts zero matches for bare `%` and `___`.
- [x] **🐛 BUG — `GET /voice/history` unvalidated query params → 500s** — FOUND + FIXED same day (2026-07-01, by `voice.realdb.test.ts`). `limit`/`offset` now digits-only-validated and `customer_id` UUID-validated (`requireValidUUID`) → clean 400s instead of pg `NaN`/22P02 500s. Regression tests added.
- [x] **`scheduleForAppointment` reminder double-seed** — FOUND + FIXED same day (2026-07-01, by `scheduleForAppointment.realdb.test.ts`). Idempotency enforced at the DB layer: partial unique index `reminder_schedules_one_scheduled_per_type` (migration `20260701020000`) + `ON CONFLICT DO NOTHING` on the seed INSERT — race-safe under concurrency (parallel-seed test) with no cross-statement locks. (First attempt used an app-level probe, then a transaction + advisory lock per Copilot review — the lock deadlocked the appointments cascade in CI E2E; the unique index is the durable design.) Reschedule still reseeds (cancel-then-seed vacates the partial index).
- [x] **🐛 BUG — version-history: deleted-list 500s on 4/6 tables + `restore_fields_from_version()` / `copy_fields_between_records()` dead on ALL tables** — FOUND + FIXED same day (2026-07-01, by `versionHistory.realdb.test.ts`, 33 tests). The two RPCs still queried bare `id` after the 2026-05 PK renames (`column "id" does not exist` — field-restore/copy-fields were 500ing in prod for every table); the deleted-records list hardcoded `t.name, t.phone` which don't exist on appointments/voice_sessions/services/resources. Fix: migration `20260701010000_fix_version_rpc_pk_names.sql` (PK-aware RPCs, same pattern as `soft_delete_record`, PLUS `jsonb_populate_record` decode — the original SET clause stringified jsonb, so a restored text field came back JSON-quoted; only reachable once the PK fix made the functions run) + per-table display columns in `versionHistory.ts`. **Prod migration apply needed before/at merge** (fix-forward: the functions are already dead in prod, so ordering can't make anything worse).

- [x] **Blindspot P0 round 2 — multi-employee scheduling coverage + agent tool-call arg logging** — DONE 2026-07-02 (branch `test/blindspot-p0-round2`; detail: `docs/planning/TODO.md` "Verification blind spots"). (1) `src/multiEmployeeScheduling.realdb.test.ts` — 7 real-DB tests proving skill matching, employee spillover, shift-aware assignment, capability-gated resource exhaustion, and the first true PARALLEL GiST double-book race (exactly 1 winner, 3 clean TIMESLOT_OCCUPIED). (2) `agent/src/redactToolArgs.ts` — the `function_tools_executed` log line now carries each tool call's ARGS (PII-redacted: phone/code keys digit-masked, time strings + names preserved) + per-call `is_error`; 13 unit tests. Remaining P0 observability: paid vendors (SENTRY_DSN / BETTER_STACK_TOKEN) ❌ DROPPED by decision (2026-07-02); alert rules stay optional/free — see "Prod config / observability" below.
- [x] **UI — hero feature grid looks incomplete (empty 4th slot)** — DONE 2026-07-01. Added a 4th `feat-tile` to the hero `feat-grid-hero`: **"Shows You Why You're Losing Jobs"** (green bar-chart icon) — the WHY differentiator — so the 2-col grid is a full 2×2. `dashboard/app/page.tsx`.
- [x] **🐛 BUG — deleting a customer orphans their appointments (can't cancel)** — FIXED 2026-07-02 (branch `fix/customer-delete-cancels-upcoming`). (Reported 2026-07-01, Dale — "Ab Smith".) `DELETE /customers/:id` now runs soft-delete + **auto-cancel of the customer's UPCOMING scheduled appointments in one transaction** (frees the slots; past/completed kept for history; already-canceled untouched), and mirrors `/appointments/:id/cancel` by dispatching `syncAppointmentToAll(…,'delete')` per canceled appointment so external calendars free too. One-time backfill migration `20260702000000_cancel_orphaned_appointments_of_deleted_customers` cancels the pre-fix orphans (data-only, no baseline regen; verified against a seeded orphan on local DB). 3 real-DB route tests (`src/customerDelete.realdb.test.ts`): upcoming-canceled/past-kept/already-canceled-stays, other-customer untouched, 404-path cancels nothing. **Prod migration APPLIED + VERIFIED 2026-07-02** (`schema_migrations` head = `20260702000000`, 154 total; the backfill matched zero rows on prod — no soft-deleted customers exist there, so it was a safety no-op).
- [x] **🐛 BUG — landing page: pricing toggle + mobile hamburger menu are dead** — FIXED 2026-07-02 (branch `fix/landing-pricing-toggle-hamburger`). (Found 2026-07-01.) Root cause confirmed: `<script>` inside `dangerouslySetInnerHTML` never executes. Moved BOTH the pricing toggle (Monthly/Annual price swap + active state + annual note) and the full hamburger menu (open/close, backdrop tap, link-click close, Escape, body scroll lock, icon animation) into `useEffect`s in `LandingPage` — same pattern as the capability grid (PR #151); deleted the entire dead inline `<script>` (its `.reveal` observer part was already duplicated in a working effect) and the dead `onclick=` attributes. 5 component tests (`dashboard/app/page.test.tsx`): price swap both directions, annual-note visibility, hamburger open/backdrop-close, Escape/link-close, auth-redirect sad path.
- [x] **Voice: "thinking" cover — looping key-typing bed** — DONE 2026-06-29 (`feat/thinking-sound-bed`), part (b). The SFX bed ships via LiveKit's built-in `voice.BackgroundAudioPlayer` (`thinkingSound: KEYBOARD_TYPING`, the clip ships in `@livekit/agents/resources` — no asset to source). `agent/src/session/thinkingSound.ts` (`attachThinkingSound`) wires it on a started session whose room is connected; the framework owns the 2nd-track publish, loop, mix, and `agent_state=thinking`→play / `speaking`→stop. Flag `ENABLE_THINKING_SOUND` (default OFF, RULE 10.2) + `THINKING_SOUND_VOLUME` env (0–1, default 0.5, live-tunable). 3 wiring unit tests (start / detach-idempotent / start-failure-swallowed); 402 agent tests green. **Part (a)** — the spoken cached filler — was already built as the output watchdog (`watchdog.ts`, `ENABLE_OUTPUT_WATCHDOG`); left as-is. The two are **independent, not layered** (watchdog `say()`→`speaking` would stop the bed; composing is a future real-call design). **Caveats stand:** the bed plays before ~every reply in pipeline (no per-turn deadline; fine as ambient); it MASKS a stall, doesn't fix it (RULE 2.4 — raise TPM / fix the tool). **Real-call validation (Dale, not CI):** does the 2nd track mix through to PSTN, volume, feel — flag stays OFF until confirmed. See VOICE_AGENT_PLAYBOOK §8.2.
- [x] **Dashboard: "Delete old calls" button** — DONE 2026-06-29 (`feat/delete-old-calls`). Owner-gated **soft-delete** (recoverable; sets the already-existing `voice_sessions.is_deleted/deleted_at/deleted_by` — no migration needed). Backend: `DELETE /voice/session/:id` (single) + `POST /voice/delete-old {older_than_days}` (bulk, excludes `status='active'`); both owner-gated (front-desk 403, super-admin bypass) + RLS-scoped; also fixed `/voice/active` + `/voice/history` to filter `is_deleted = false` (they were leaking soft-deleted rows). Dashboard: `useConfirm()` dialogs + per-call delete (detail pane) + bulk "older than 30/90/180/365 days" control in the Call History header — both owner-only. Hard-delete (true PII erasure of caller_phone/transcripts) deliberately deferred to the legal-held GDPR/retention work (#68/#69). Tests: 8 backend (`src/voice.test.ts`) + 3 dashboard (`VoiceCallsView.test.tsx`); SQL + full owner JWT→gate→RLS path smoke-verified against a real local DB. Analytics already filtered `is_deleted = false`, so deleted calls drop out of stats too.

- [x] **Per-tenant default buffer between appointments — SHIPPED 2026-07-01 via PR #137** (superseded the parked `feat/default-appointment-buffer`/PR #41, now CLOSED). `src/services/tenantBuffer.ts` + `getTenantBufferMinutes()` wired into the agent booking tools, buffer UI on the AI Persona / preferences page, and both migrations (`20260607000000_tenants_default_buffer` + `20260607000001_booking_buffer_enforcement`) — all in main. **Prod: both migrations applied + `tenants.default_buffer_minutes` column verified present 2026-07-02.** (The old #41 line here claimed "genuinely missing" — stale; reconciled 2026-07-02.)
- [x] **`feat/knowledge-suggestions` (PR #42) — improved variant of the website-scan Q&A review UI. DONE 2026-06-23, re-landed as PR #82 (`6afed91`) → merged to main.** Recovered from `refs/pull/42/head` after the branch was deleted, re-applied clean on current main. Matched items now enter as `'suggested'` (owner reviews everything before live KB); approve path wrapped in a try/catch txn with ROLLBACK; the 0-row status-guard race now throws a 409 (was a reply.send() inside the txn callback → double-send + false approval log — fixed + tested). Also updated the `kb-import-website-stub` E2E to the new all-items-suggested contract (0 confirmed, ≥4 suggested) and renamed `confirmedItems`→`matchedItems`. No migration (table+statuses already in main). Grok's `feat/website-knowledge-import` overlaps the same handler — rebase that work on this.
- [x] **`docs/website-import-priority` — RESOLVED 2026-07-02 (landed/superseded).** The branch no longer exists (not on origin, not local — verified). The feature it specced **shipped**: `src/routes/knowledge.ts` carries the website-import path (`knowledge.importWebsite.test.ts`), the review-UI landed via PR #82 (knowledge-suggestions, MERGED), and the design specs live in main under `docs/superpowers/plans/2026-06-09-website-knowledge-import-plan1-question-bank.md` + `docs/superpowers/specs/2026-06-09-website-knowledge-import-design.md`. Nothing to recover.
- [x] **`fix/agent-tenant-resolution` — RESOLVED 2026-07-02 (superseded).** The branch no longer exists (not on origin, not local — verified) and its go-live-docs commits (`GO_LIVE_FINDINGS.md` / `TELNYX_HANDOVER.md`) are unreachable in git (no PR to restore). The Telnyx go-live ops detail they held is now covered in `docs/RUNBOOK.md` (12 Telnyx/REFER/SIP references) and `docs/AIASSISTANT_GO_LIVE_TODO.md` (40) — closed as superseded, no unique delta to fold.

- [x] **PSTN inbound — CONFIRMED 2026-06-30.** A real call to `+1 630-822-9086` reached the agent (Beth) and held a full ~3-min conversation (`voice_sessions` row + transcript landed). Inbound path Telnyx → LiveKit → `secretary-hq-agent` works; the `secretary-hq-agent` deploy is validated. (The earlier "wrong number" symptom was a documentation transcription error — `866-9086` was never ours; `822-9086` is the real owned+routed DID.) Booking on that call failed for a separate reason — the employee-skills gap, root-caused + prod-patched same day; needs one more live call to confirm end-to-end (see below).
- [x] **Remove DynaTire rows from prod DB** — DONE 2026-06-29: prod inspected, **zero DynaTire rows** present — already clean, no-op. Same pass found + removed a **stray duplicate demo-tenant row** (older seed superseded by the canonical one; no transactional data). The dup carried a second owner row for the same email → nondeterministic login (email is unique PER-tenant, not global). Removed; canonical intact. Login query hardened in PR #123 (`ORDER BY` + multi-tenant warning). Operational specifics in session memory, not the repo.

- [x] **GAPS solo-backlog batch — 10 items, DONE + DEPLOYED 2026-07-04 (PRs #187–#192, all merged to main + live on prod, migration-free + dep-free).** Verified live via authenticated prod probe (`/analytics/utilization` 200, `/export/customers.csv` 200, `/admin/feature-readiness` 403-gated) + `simulate status --env prod --deep` = 4/4.
  - **#188 — 3 new voice tools (20→23):** `page_owner_via_sms` (urgent mid-call owner SMS page, one-per-call guard, take_message fallback), `get_detailed_customer_history` (last ~10 appts any-status + prefs + last ~3 call summaries, phone server-injected), `send_self_service_link` (texts the caller a reschedule/cancel link reusing the selfService token path, consent+ownership gated; prompt now offers it proactively). Tenant-tz date formatting (review fix). toolselect eval → 8 cases (baseline 7/8, take_message case = model drift not regression).
  - **#189 — CSV bulk import/export:** owner-gated `GET /export/{customers,appointments,calls}.csv` (`src/services/csv.ts` hand-rolled RFC-4180 + formula-injection guard incl. leading-whitespace bypass) + `POST /customers/import` (liberal headers, zod+normalizePhone, in-file + existing dedupe, 1 MB / 2000-row caps, per-row error report). Buttons in `CRMView` + `BusinessSettingsView`.
  - **#190 — session revocation UI + feature-readiness:** `POST /users/me/revoke-sessions` + `POST /users/:id/revoke-sessions` (owner-gated, tenant-pinned, 404-no-leak) bumping `password_changed_at`; `ProfileView` + `TeamAccessView` buttons (try/finally guards). `src/services/featureReadiness.ts` (shared with `envWarnings`) → boot log + `GET /admin/feature-readiness` (super-admin).
  - **#191 — analytics + comms:** `/analytics/cohorts` `first_time_fix` (share of distinct callers whose FIRST call booked); `GET /communications/history?status=failed` drill-down — **and the send-failure paths of smsService/emailService now record `status='failed'` rows** (the drill-down was inert before; found in review). `CommsSentView` "Failed only" filter.
  - **#192 — utilization heatmap:** `GET /analytics/utilization` (weekday×hour staffed-vs-booked, tenant-local, cross-midnight-clamped) + `UtilizationHeatmap` theme-var CSS-grid panel in `AnalyticsView`.
  - **#187 — docs:** GAPS.md trimmed (shipped specs/one-liners → RESOLVED.md).
  - _5W/coverage note:_ all new tests happy+sad with inline 5W; every code-review-bot finding fixed + threads resolved before merge.
- [x] **AI cost / usage meter** — instrument spend at call sites (added recording via aiCost helper to kb_ingestion, kb_query/policy paths in knowledge routes + agentTools; voice session via existing record-ai-cost + LiveKit collector; summary/classify costs folded into model_usage). Uses ai_cost_events table (data model chosen). "Usage this month" surfaced via /analytics/ai-cost + breakdown in AnalyticsView (partial UI pre-existed). 2026-06. (Remaining agent-side explicit TTS etc. covered by session usage.)
- [x] **Self-service links — dashboard surface** — "Send self-service links" button (with loading + toast) in `AppointmentDetailPanel.tsx`; API client + POST /appointments/:id/send-self-service-links (generates tokens, sends via Telnyx SMS, returns links; also embedded in normal booking confirmations via appointmentService + templates). Backend + unit tests complete. (PR #34 + follow-ups.) 2026-06.
- [x] **Self-service links — SMS consent gate** — `POST /appointments/:id/send-self-service-links` now checks `consent_records` before sending the cancel/reschedule SMS, matching `agentTools/messaging.ts` and the rest of the communications stack. Added regression coverage for consented + no-consent paths. 2026-08.
- [x] **Self-service E2E** — added in workflows.spec.ts: book via helper → send-links trigger (API) → customer uses public /self/cancel and /self/reschedule pages (confirm, success states, DB effect) → negatives (invalid token UI) + double-use (idempotent already-canceled). Uses generated tokens matching backend + e2e fixtures. 2026-06.
- [x] **Analytics depth — DONE 2026-06-22..23** (reconciled 2026-07-02: item was still `[ ]` though the body shows every sub-part shipped; the one genuine remainder — pure-inquiry abandonment — is carved out as its own item below). **RAG debugger API DONE 2026-06-22** (dashboard surface DONE — `ExplainAnswerView.tsx` in Setup → "Answer Debugger", verified 2026-07-02): `POST /knowledge/explain` (`src/routes/knowledge.ts`) — owner-gated; embeds the question the SAME way `/agent-tools/policy-answer` does (normalize → embed) and runs the real `search_tenant_docs_normalized` retrieval, returning ranked candidate chunks + similarity scores annotated with `above_threshold` / `used_in_production` (top-3 above 0.5) + a `would_answer` flag, so an owner sees WHY the AI answered (or didn't); 5 tests. **Dashboard DONE 2026-06-22**: `ExplainAnswerView` (Setup → "Answer Debugger" sub-tab — question box → ranked candidates with % match + "Used by AI" badges + a would-answer verdict + a **"What the AI would draw from" composed-answer box** (the exact cited context the agent would relay, via `composed_answer` on `/knowledge/explain`); tests updated). [x] **caller-facing source citations DONE 2026-06-22**: `/agent-tools/policy-answer` now resolves each matched chunk's source-doc title (joins `tenant_docs`) and prefixes the context with `[From "<title>"]` so the agent can attribute answers; prompt updated to use the marker naturally; agentTools + integration tests cover it. [x] **cohort + bookings-by-service DONE 2026-06-22**: `GET /analytics/cohorts` (`src/routes/analytics.ts`) — repeat-caller cohorts (grouped on phone DIGITS so format variants collapse; `HAVING count>1`) + bookings-by-service (join booked calls → appointment → service) + a repeat-caller summary (distinct/repeat/share); dashboard "Repeat Callers" + "Bookings by Service" panels in `AnalyticsView`; backend (2) + component (1) + E2E (1) tests. [x] **CLV DONE 2026-06-22**: `/analytics/cohorts` also returns `top_customers` (top 20 by lifetime booked revenue = `sum(service.price)` per customer, ::float8) + a "Top Customers" panel in `AnalyticsView`; unit + component + E2E-shape tests. [x] **abandonment-by-service DONE 2026-06-22**: migration `20260622010000` adds `voice_sessions.requested_service_id`; the `book-with-scheduling` agent tool best-effort fuzzy-resolves the requested service name → `service_id` and records it on the call's `voice_session` **whether the booking succeeds or fails** (no agent-worker change needed — that handler already carries `call_id` + `serviceType`); `/analytics/cohorts` returns `abandonment_by_service` (abandoned calls `appointment_id IS NULL` grouped by requested service) + an "Abandoned by Service" panel; backend capture test + analytics test + component + E2E-shape. **Prod action DONE 2026-06-23**: migration `20260622010000` applied + verified on prod (`voice_sessions.requested_service_id` column present). (Pure-inquiry abandonment — callers who only asked availability without a booking attempt — still untracked: the `available-slots`/`scheduling-options` tools don't carry `call_id`; would need an agent-worker change.) **Analytics depth complete** except that inquiry-only edge. [x] **From/To date-range filtering DONE 2026-06-22** (PRs #65/#66): `/analytics/calls` + `/analytics/cohorts` take optional `start_date`/`end_date` via new `optionalDateBounds` (all-time when absent; calendar-invalid dates like `2026-02-30` rejected to null by `isValidDateOnly` so they never reach a `$n::date` cast; `end` is day-inclusive; voice queries bound on `started_at`, revenue query on `start_time`); `AnalyticsView` gets From/To controls (range-change refetch keeps the page + controls on screen); backend + component tests. (#66 was a fix-forward for #65: a watcher race merged #65 before its review-fix commit registered, so the calendar-invalid-date guard + two other Copilot fixes landed via #66.)
- [x] **Docs / runbooks** — DONE 2026-06-22: `docs/RUNBOOK.md` (incident + telephony playbook — triage, agent-silent, reminders-not-sending, Stripe-webhook-400, backend-down, DB-pool-saturation, full Telnyx→LiveKit→agent path incl. REFER + blocked-caller-ID OTP) **and** `docs/OWNER_GUIDE.md` (owner admin guide — dashboard tour, how-to-read-analytics: Call Volume / Booking Conversion / Caller Abandonment / Why Callers Reached Out, + FAQ). All three sub-parts (owner guide, telephony playbook, prod incident runbook) covered.
- [x] **Agent reliability — idempotent-read retry** in `toolsClient` — DONE 2026-06-22: code wired (`agent/src/toolsClient.ts:50` `maxAttempts = opts.isReadOnly ? 2 : 1` — mutations never retried; one retry on transient 5xx / network throw; 7 read-tool call sites in `agent/src/tools.ts`) **+ now tested** — added 5 cases to `toolsClient.test.ts` (read retry→success, read exhaust both-5xx, mutation no-retry on 5xx, read retry on network throw, mutation no-retry on throw). The mutation-no-retry cases are the double-book guardrail. 14/14 green.
- [x] **`simulate tools` → CI** — DONE: wired as a hard regression gate in `.github/workflows/ci.yml:269` ("Run simulate tools" step, `./scripts/simulate.sh tools --env local`; non-zero exit fails the E2E job). Runs the booking + recall journey against the live servers and flags `[dev]` gaps the same way the local harness does.
- [x] **Remove vestigial edge-function section** from `docs/DEPLOYMENT.md` — DONE 2026-06-22: dropped the dead "Phase 3: Deploy Edge Functions" section (incl. vestigial `3.1 Link the Supabase CLI` — migrations apply via `setup-db.sh`, no CLI link needed) and renumbered Phases 4–8 → 3–7 + subsections.
- [x] **Booking RPCs ignore `is_deleted` in overlap/availability checks** — **DONE 2026-07-01 (PR #139, migration `20260701000000`, prod-applied + verified).** Added `AND (is_deleted IS NULL OR is_deleted = false)` to all 8 appointment subqueries in `book_appointment_atomic` (3: resource/employee/user overlap) + `book_with_scheduling_atomic` (5: resource+employee availability, unskilled-branch resource, timeslot-occupied + employee-occupied diagnostics); `check_availability_with_tz` already filtered. Confirmed the bug was reachable (`soft_delete_record` is PK-aware since `20260513000004` → soft-deleting an appointment sets `is_deleted=true`, leaves `status='scheduled'`). Offer/book symmetry verified intact (the slot-offering reads already filtered). Also guarded 3 agentTools reads (`get_my_appointments`, cancel, reschedule) that still counted soft-deleted rows. Real-DB TDD (RED→GREEN, `booking-soft-delete.test.ts`); full suite 2020/2020.
- [x] **Pure-inquiry abandonment tracking** — DONE 2026-07-02. `get_available_slots` + `get_scheduling_options` agent tools now thread `call_id` (schemas accept optional `call_id`); both handlers fire the same best-effort `requested_service_id` write as `book-with-scheduling`, extracted into a shared `captureRequestedService()` helper (fire-and-forget, COALESCE-guarded, never blocks the call). So a caller who only asks availability and never books is now attributed to their `voice_session` → counted in abandonment-by-service. Tests: 3 mocked route tests (available-slots + scheduling-options fire the capture with the right params; no `call_id` → no write) mirroring the existing book-with-scheduling capture test. Backend 2179 + agent 423 green.
- [x] `@typescript-eslint/unbound-method` — DONE 2026-06-22. Zero violations across all 3 packages (the "heavy in tests" concern never materialized — vitest `vi.fn()` mocks are plain object properties the rule ignores); promoted to `error` in all three eslint configs. Also fixed a stray `no-unnecessary-type-assertion` error in `agent/src/tools.test.ts` that had slipped past CI (agent CI runs tsc+tests, not lint).

- [x] **🐛 BUG (infra) — `supabase/baseline.sql` was STALE; local E2E used a schema missing 3 shipped tables.** Found + FIXED 2026-06-19 (`fix/baseline-sql-drift`). `rebuild-db.sh` prefers the single-file `baseline.sql` then `setup-db.sh --baseline` marks every later migration applied **without running it** — so tables created after the 2026-05-18 squash (`knowledge_suggestion`, `customer_messages`, `ai_cost_events`) were absent from any baseline-built DB (local Playwright `globalSetup`, `npm run db:rebuild`) while CI dodged it (builds from the chain + `PLAYWRIGHT_SKIP_DB_RESET=1`). **Fix:** (1) regenerated `baseline.sql` from the chain (33→36 tables); (2) added `scripts/generate-baseline.sh` + `npm run db:baseline` (spins a throwaway DB, applies the chain, `pg_dump --schema-only --no-owner --no-privileges`) as the canonical regen so it can't silently rot; (3) closed the guard hole — `verify-schema-alignment.ts` only scanned `ADD COLUMN`, so `CREATE TABLE` (inline columns) escaped it; added `checkMigrationTablesInBaseline` (every migration-created table, minus dropped/renamed, must appear in baseline) + 4 unit tests. Verified: full KB e2e 15/15 green via the **baseline** path; guard catches the old drift, passes the new baseline. Note: CI exercises the _chain_ path, not baseline — this drift class is only observable locally, so the guard now runs in prepare-commit/CI as the catch.

- [x] **Gap #2: Analytics — DONE 2026-06-12** (shipped to main, deployed). `GET /analytics/stats` + `GET /analytics/calls` built; dashboard panels now real — Call Volume / Booking Conversion / Caller Abandonment from `voice_sessions` ("booked" keyed on `appointment_id IS NOT NULL`), + a first "Why Callers Reached Out" outcome breakdown. Backend unit + dashboard component + `analytics.spec.ts` E2E all green; harness asserts both routes.
  - [x] **Follow-up: richer WHY classification — DONE 2026-06-12.** Agent's post-call classifier (`agent/src/callClassify.ts`, bounded/failsafe) categorizes non-booking calls into `no_availability` / `wrong_service` / `price` / `message` / `info` (null when unclear → stays `no_outcome` = abandoned, preserving that metric). Wired into the shutdown hook (only when no booking/transfer tool already set the outcome). Dashboard "Why Callers Reached Out" panel renders friendly labels. +8 agent + dashboard component tests; analytics E2E extended to seed a `no_availability` call and assert the label (run-verified).
- [x] **Website-scan as onboarding step (fetch + LLM extract to KB).** Core backend + dedicated wizard step implemented: new step 7 "Import from website" (right before the policy questions step 8) with scan that prefills and saves answers for the starter questions. The questions step loads prefilled from DB. See details in the Back-to-Front subsection below. Backend, migration, UI step, prefill logic done. Advanced suggestion review still pending.

- [x] **[prod]** **Reminder/comms SMS silently runs MockAdapter** — FIXED 2026-06-16: ProviderRegistry now defaults to Telnyx; boot warning fires if `TELNYX_PHONE_NUMBER` unset. **Prod action**: set `TELNYX_PHONE_NUMBER=+16308229086` on Railway.
- [x] **[prod]** **Email silently runs mock transporter** — code FIXED: boot warning fires when `EMAIL_USER`/`EMAIL_PASS` unset (`envWarnings.ts:35`), matching the Telnyx/CORS/`DASHBOARD_URL` silent-degrade siblings. (Without the env, `emailService.ts:22` installs a mock returning a fake messageId → emails never send.) **Prod action**: set Gmail app-password env (`EMAIL_USER`/`EMAIL_PASS`) on Railway.
- [x] **[prod]** **Agent `BACKEND_URL` defaults to `http://localhost:4001`** — FIXED 2026-06-16: `.default()` removed; agent now exits at startup if unset. **Prod action**: confirm `BACKEND_URL=https://secretary-hq-production.up.railway.app` is set on `secretary-hq-agent` Railway service.
- [x] **[prod]** **`STRIPE_WEBHOOK_SECRET` empty → every webhook 400s** — FIXED 2026-06-17: boot warning now fires when `STRIPE_SECRET_KEY` is set but `STRIPE_WEBHOOK_SECRET` is missing. **Prod action**: set `STRIPE_WEBHOOK_SECRET` on Railway.
- [x] **[prod] (security)** **`CORS_ORIGIN` unset reflects ANY origin** — FIXED 2026-06-16: boot warning now fires. **Prod action**: set `CORS_ORIGIN=<dashboard URL>` on Railway.
- [x] **[prod]** **`DASHBOARD_URL` defaults to `https://localhost:4000`** — FIXED 2026-06-16: boot warning now fires. **Prod action**: set `DASHBOARD_URL=<dashboard URL>` on Railway.

- [x] **[dev]** **Voice-session capture (outcome + appointment link + summary)** — DONE 2026-06-12. `CallOutcomeTracker` (`agent/src/callOutcome.ts`) is mutated by the booking tools (`recordBooking(appointment_id)`, guarded on a real id in the response) and the transfer tool (`recordTransfer`); the shutdown hook reads it and sends `outcome` + `appointment_id` + a bounded/failsafe post-call `summary` (`agent/src/callSummary.ts` — never throws, can't drop the session-end write) to `voice-session-end`. Backend `VoiceSessionEndSchema` now accepts `summary` + UUID-validated `appointment_id` and forwards them to the RPC (was hardcoded null). +14 agent + 2 backend tests; `simulate tools` now proves the link **persisted** via a `voice_sessions` DB read-back (appointment_id matches the booking, outcome=booked, summary stored).
- [x] **[dev]** **Transfers invisible in Calls tab** — DONE (see Back-to-Front section line 215 + Gap #1). `recordTransfer()` sets `outcome='transferred'`; `end_voice_session` RPC sets `status='transferred'` when outcome matches. UI badge wired.
- [x] **[dev]** **`GET /analytics/stats` missing** — DONE 2026-06-12 (Gap #2). Route at `src/routes/analytics.ts:24`; dashboard panels fully wired. See active build queue above.
- [x] **[dev] SMS delivery monitoring** — DONE 2026-06-12: Delivery status webhooks + `message_delivery_status` table + metrics for Telnyx (legacy provider path removed 2026-06). `POST /communications/telnyx/status` wired.
- [x] **[dev] `GET /communications/history` implemented** — DONE 2026-06-12 (`feat/communications-history`): real `communications_history` table, written on the Email/SMS send-success path, tenant-scoped paginated query. No live UI consumer yet (backend-only).
- [x] **[dev]** **Stripe tax code wired** — `automatic_tax: { enabled: true }` added to checkout session in `billing.ts`, gated on `STRIPE_AUTO_TAX=true` env var. Set that on Railway after: (1) enable Stripe Tax in Stripe dashboard, (2) register nexus for IL + customer states. See Phase 13 user-action item.

- [x] **[dev] — HIGH** **`supabase/baseline.sql` stale → drift guard** — DONE 2026-06-12. Baseline was missing `is_demo`/`demo_expires_at`/`tts_*`/`forward_phone`, so every `db:rebuild` + Playwright `globalSetup` DB lacked columns (`/demo/start` 500'd). Fix: proved the migration chain replays clean on empty (131 applied), regenerated `baseline.sql` via `pg_dump --schema-only` from the chain-built DB (now all 8 columns), and verified a full baseline rebuild → `simulate tools` journey passes. Added a **self-maintaining drift guard** (`checkMigrationColumnsInBaseline` in `scripts/verify-schema-alignment.ts` + 3 tests): scans every `ADD COLUMN` across migrations (minus dropped/renamed) and fails if any is absent from baseline — so this can't silently recur. Found by `scripts/simulate.sh tools`.

- [x] Replace the dead `qa-live-test.py` references — DONE 2026-06-17: updated DEVELOPMENT_WORKFLOW.md, TEST_COVERAGE.md, ARCHITECTURE.md to reference `simulate.sh tools`.
- [x] Add `simulate tools` (or an E2E equivalent) to CI — DONE: `ci.yml:269` runs `./scripts/simulate.sh tools --env local` as a hard gate in the E2E job (non-zero exit fails). (Canonical entry in the P2 master list above.)
- [x] **Test RAG accuracy — DONE 2026-06-12.** `scripts/sim-rag.mjs` + `./scripts/simulate.sh rag` — seeds a known KB into a demo tenant (real embeddings via `/knowledge/add`), asks paraphrased caller questions through `/agent-tools/policy-answer`, grades retrieval (expected content present, + out-of-scope must fall back not hallucinate), reports a hit-rate and exits non-zero below 80%. On-demand quality tool (real OpenAI → not a CI gate; non-deterministic + costs). Run-verified: **9/9 (100%)** after query expansion fix. **Gates the website-scan onboarding idea** (`docs/STRATEGY.md`).
  - [x] **Finding from the eval — FIXED 2026-06-12.** _"what's your address"_ fell back instead of retrieving the location doc — `address`↔`located` shares no vocabulary and scored 0.31 below threshold. Root cause: reductive `normalizeForEmbedding` applied to _query_ collapsed terse inputs below out-of-scope floor. Fix: new `shared/expandQueryForEmbedding.ts` (additive synonym expansion, inverse of normalize) on policy-answer path only + threshold 0.5→0.30. Docs/ingest untouched (no re-embed needed). See `shared/expandQueryForEmbedding.ts` + `src/queryExpander.test.ts`. Now ready for website-scan reliance.

- [~] **Telnyx provisioning — DONE 2026-06-02.** Account for Thinking Hammer LLC funded ($10) + upgraded (trial 1-order cap lifted). SIP Connection `livekit-outbound` (`2945038451784812111`) → FQDN `ai-secretary-nmlkkmgf.sip.livekit.cloud:5060`. `TELNYX_API_KEY` + `TELNYX_SIP_CONNECTION_ID` set (local `.env`; verify on Railway `secretary-hq`). Number **`+1 630-866-1960`** purchased (id `2973794140900296302`), routed to `livekit-outbound`, connection activated. Old `+1-630-937-9478` is dead (order deleted). **2026-06-04 UPDATE:** LiveKit creds work (not dead); inbound trunk `ST_aUM3GuCuc9wL` already points at the numbers (normalized to +E.164). `+16308661960` is a dead recycled DID — **new test number `+1 630-822-9086` (id `2975078589701031880`) bought + fully wired.** Config verified clean end-to-end; remaining blocker is PSTN carrier propagation, not config. **NEXT:** different-carrier call to `+16308229086` while watching LiveKit `listRooms()`. See `docs/TICKET_SUPPORT.md` (the 2026-06-04 provisioning audit detail was folded in there; the standalone `PROVISIONING_AUDIT.md` was removed).
  **2026-06-30 UPDATE:** Live number `+1 630-822-9086` — the real owned + routed DID (dial for the PSTN test). The long-documented `+1 630-866-9086` was a transcription error: never owned (routes to another business). `+1 630-866-1960` dead. Landing pages, dashboard constants, tests, and docs all corrected to 822-9086.
- [x] **Browser-verify role gating + invite flow** — DONE 2026-06-03. Covered by green e2e: `auth-flows.spec.ts` (front_desk → 403 on /users/invite, /users/:id/role, GET /users), `workflows.spec.ts:630` (front-desk sees only Primary tabs; stale `?tab=my-business` URL snaps back to Home), `workflows.spec.ts:676` (owner invite creates user + reset token). Full suite 111 passed / 7 skipped.

- [x] **Apply migration `20260606000000_tenants_customer_preferences.sql` to prod DB** — DONE 2026-06-11. Audit found the two columns (`save_preferences_enabled`, `preferences_instructions`) were already present in prod (hand-applied, untracked), so the AI-config page was NOT broken. `npm run db:migrate` against prod reconciled the tracker (recorded `20260606000000` + `20260610000000_tenant_grok_voice` which was in the same untracked-gap) and the run was a safe no-op on the existing columns.

- [x] **SECURITY** Unauthenticated cross-tenant data access via `?tenant_id=` (read+write+delete) closed — `tenantMiddleware` 401s non-public/non-exempt requests with no `req.auth`; `requireTenantId` drops the body fallback. Probe 8 added (isolation suite now 39 probes). See `planning/RESOLVED.md` + `docs/SECURITY.md`.
- [x] **Deep `/ready` endpoint** — DB ping + pool saturation stats (`total/idle/waiting`); 503 when DB unreachable. `/health` stays shallow (liveness). A monitoring signal, not yet a traffic gate.
- [x] **Pool fail-fast** — added `connectionTimeoutMillis: 5000`; pool-checkout under exhaustion now errors fast instead of hanging forever (the "many callers" failure mode).
- [x] **Alerting visibility** — `withHandler` unhandled errors now route through `logError` → `errors_total` ticks (pre-fix pool-exhaustion errors were invisible to `rate(errors_total)` alerting).
- [x] **Threadpool** — `GET /` + `/demo` no longer `fs.readFileSync` per request.
- [x] **Gap 3 — client-error 500s → 400** `withHandler` now maps Postgres class-22 data exceptions (`22P02`/`22003`/`22007`/`22008` — e.g. a non-UUID `:id`) to 400 and does NOT tick `errors_total`. Confirmed live: `GET /records/customers/not-a-uuid/history` 500→400. Unit tests added (incl. a guard that non-class-22 errors stay 500). Fixes the ~12 unvalidated `:id` routes in one place + stops client garbage polluting 5xx/error-rate alerts.
- [x] **Gap 1A — agent graceful recovery** `agent/src/prompt.ts` "Technical glitches" section: never speak raw error text (`500`/`timed out`/`backend`), recover in-character, never stall silently. Regression test pins it. (Wording is a placeholder for Dale to tune.)
- [x] **Gap 2 — agent CI job** `agent/` (tsc + 99 tests) now runs in CI — was previously ungated entirely.
- [x] **Testability extractions** `jsonContentTypeParser` (+ 400-on-bad-JSON fix) and `readinessHandler` extracted to modules with unit tests (incl. the `/ready` 503 DB-down branch). E2E added: anonymous-tenant 401, `/ready`, malformed-JSON.

- [x] **`METRICS_TOKEN` on Railway backend — DONE** (confirmed set 2026-06-29: prod `/metrics` returns 401 not 404, i.e. the token gate is active). The metric data is exposed; standing up a scraper over it is optional (free path) per the observability decision above.
- [x] **Load-test the booking path** — DONE 2026-06-19 (`feat/booking-load-probe`). Built `scripts/sim-load.mjs` (localhost-guarded — refuses any non-localhost backend without `--force` so a decrypted prod URL can't be blasted): provisions/uses a tenant, fires ramping concurrency (5/10/20/40) at `/agent-tools/book-with-scheduling`, buckets outcomes (success/conflict/pool-or-5xx/other/net) with p50/p95/p99 + throughput. **Finding (reframed per the architecture):** the deliverable is the failure MODE, not an absolute ceiling — a local dev-box + docker-Postgres number doesn't transfer to Railway. At 4× pool concurrency (40 vs `max=10`) the path **fails fast and cleanly** — flat p99 (~30–60ms locally), **zero pool-checkout-timeout / 5xx / dropped-connection errors**; contention is handled gracefully, validating the `connectionTimeoutMillis=5000` fail-fast design. **Context:** the agent runs ONE LiveKit worker per tenant, so concurrent bookings are bounded by simultaneous calls across DISTINCT tenants — a handful at beta scale — so `pool=10` is near-certainly fine for real load today; revisit pool/LiveKit sizing only when multi-tenant concurrency grows. Run: `SIM_AGENT_SECRET=… node scripts/sim-load.mjs` (optional `SIM_TENANT=…`).
- [x] **Pool-exhaustion integration test** — DONE 2026-06-07 (`src/poolExhaustion.test.ts`). Real `Pool({max:1, connectionTimeoutMillis:500})`, holds the only client, hits a `withHandler`+`withPoolClient` route → checkout rejects at ~504ms (bounded, not a hang) → 500 + `errors_total{unhandled_route_error}` ticks via `withHandler`→`logError`. Control tests (free slot → 200; release → 200 again) prevent false-pass and prove recovery. Closes the gap left by the synthetic `middleware.test.ts` version.

- [x] **P1 — Add E2E (Playwright) job to CI.** DONE 2026-05-28. `e2e` job added to `.github/workflows/ci.yml`: pgvector service, migrations + seed, backend build + start, dashboard build + start, `wait-on`, Playwright chromium install + test run, artifact upload on failure. **Needs first-run green in Actions before marking required.** The runtime security proof (anonymous-401, cross-tenant 403, `/ready`) runs only locally today. Concrete plan: new `e2e` job — `ankane/pgvector` service (mirror backend job) → `npm ci` (root + dashboard) → `npm run build` (backend) → start backend + dashboard → `npx playwright install --with-deps chromium` → `cd dashboard && npx playwright test`. **Needs first-run validation in Actions** (browser install + server startup are the usual flake sources) — don't mark required until one green run.
- [x] **P2 — Wrap the agent `entry` tail in try/catch → `runFallback`.** DONE 2026-05-28. Added outer try/catch around ToolsClient + buildTools + fetchTenantConfig + buildSystemPrompt. Inner session.start catch retained; outer catch catches setup failures before session.start. Agent TS clean, 1397 tests passing.
- [x] **P3 — (B) idempotent-read retry** in `toolsClient` — DONE 2026-06-22: one retry on transient 5xx / network throw for READ tools only (never mutations: a timed-out booking may have succeeded server-side → double-book). Wired (`toolsClient.ts:50`, gated `isReadOnly ? 2 : 1`; 7 read-tool call sites) + 5 tests added to `toolsClient.test.ts` (incl. the mutation-no-retry double-book guardrail). See canonical item above.
- [x] **P3 — (C) latency filler** — DONE 2026-06-16. `buildTools` accepts optional `speakFiller` callback; wired into `get_available_slots`, `book_appointment`, `book_appointment_with_scheduling`, `answer_policy_question`. `index.ts` passes `session.say` (builds tools inside session try-block). Also fixed pre-existing TS error (`AgentHandoffItem` type narrowing in transcript handler).

- [x] **P3 — Audit the ~12 `:id` routes** — DONE 2026-05-28. All 26 route files use `withHandler` (class-22 mapper fires automatically). One route (`jobber.ts:95`) bypasses `withHandler` but has its own manual UUID check. `requireValidUUID` is defined but unused — not needed since the mapper covers every route. No gaps found.

- [x] Call transcript + summary flow end-to-end — DONE 2026-06-12 (TranscriptRecorder + callSummary.ts + callOutcome.ts, all wired into shutdown hook)
- [x] Expanded live QA suite — REPLACED by `./scripts/simulate.sh tools` (qa-live-test.py deleted)
- [x] Reminder delivery monitoring dashboard — DONE (`GET /reminders/delivery-stats` + ReminderDeliveryStats component in AnalyticsView)
- [x] Add coverage for OTP + booking error codes — covered by agent unit tests; qa-live-test.py path is gone

- [x] Apply migration `20260611000000_tenant_forward_phone.sql` to prod DB — DONE 2026-06-12 (column live, tracker records it).
- [x] Commit + merge the transfer + transcript feature — DONE 2026-06-12 (PR #7 → main, CI green on all 4 checks, all 3 services deployed).
- [x] **Capture + send transcript** — DONE 2026-06-10. New `agent/src/transcript.ts` `TranscriptRecorder` accumulates `conversation_item_added` turns (caller STT + agent replies incl. greeting); shutdown callback sends `transcript.render()` to `voice-session-end`; `agentTools.ts` schema gains `transcript` (max 100k) → `end_voice_session` param 5. DB column + `VoiceCallsView.tsx:611` display already existed. +5 agent + 2 backend tests; agent 127 / backend voice-session 7 green, both typecheck clean. **Validation pending: live call to confirm real transcript lands.**
- [x] **Generate + send call summary** — DONE (Gap #1, 2026-06-12). `callSummary.ts` post-call GPT-4o-mini summary in shutdown hook → `voice-session-end`.
- [x] **Set call outcome** — DONE (Gap #1, 2026-06-12). `CallOutcomeTracker` set by booking + transfer + `callClassify.ts`; shutdown hook sends `outcome` to `voice-session-end`.
- [x] **Link booked appointment to the call** — DONE (Gap #1, 2026-06-12). `recordBooking(appointment_id)` in tools → shutdown hook → `voice-session-end` param.
- [x] **Register transfer events in the call record** — DONE (via `recordTransfer()` setting outcome + migration-updated `end_voice_session` that sets status='transferred' when outcome='transferred'). UI already supported it. See feat/transfers-invisible-calls + related list work.

- [x] **Implement `GET /analytics/stats`** — DONE 2026-06-12. Route live at `src/routes/analytics.ts`; dashboard panels fully wired with real `voice_sessions` data.
- [x] **Wire the 3 stubbed call-based panels** — DONE 2026-06-12. Call Volume / Booking Conversion / Caller Abandonment all pull from real `voice_sessions`; "Why Callers Reached Out" breakdown wired via `callClassify.ts`.
- [x] **Reminder delivery dashboard** — landing via PR #50 (`feat/reminder-delivery-stats`, cherry-picked from the never-merged `feat/transfers-invisible-calls`); mark fully done once #50 merges. `GET /reminders/delivery-stats` (tenant-isolated `reminder_schedules` aggregates: sent total/7d/30d, failed total/7d, scheduled, cancelled) + `ReminderDeliveryStats` cards wired into `AnalyticsView`. + route unit test (happy + empty/zeros, asserts tenant-scoped query). NOTE: the prior "[x] DONE" claims here and at the top of this file were premature — the code lived only on an unmerged branch and was absent from main until this cherry-pick (a baseline-drift-class bookkeeping gap). Now actually in main.

- [x] **Surface pending/error sync counts** — Extended `CRMIntegrationCard` (and square provider config) to fetch + display `pending_count` / `error_count` / `total_mapped` from the existing `/.../sync/status` endpoints below the last-sync line. See list work on backfill branch. Prometheus metrics remain for ops.

- [x] **Dedicated "Import from website" step in the SetupWizard (right before the questions/policy step).** Inserted as step 7 ("Import from website") after the review step (6), immediately before the "Teach Your AI" questions step (now 8). New component `Step7WebsiteScan.tsx` with URL input + scan button that runs the backend extract and saves matching starter answers via knowledge.add. The questions step now loads pre-existing answers (by matching question text in the tenant_docs) on mount and prefills + marks saved, so the scan directly helps answer the questions in the following step. Wizard updated (type to 9 steps, labels, arrays, "of 9", next button text, expand timing, comments). User-facing explanatory copy added to scan page per spec: "when questions are asked of your AI Assistant, the information from your company comes from here. Our system will scan your website... The following page is to answer any...". Also cleaned duplicate import box from questions step in main wizard (kept for Solo via prop). See the implementation in `Step7WebsiteScan.tsx`, updates to `Step7CallerQuestions.tsx` (load prefill + conditional import box), `index.tsx`, `WizardStepContent.tsx`, `types.ts`. Advanced per-question suggestion review UI with badges still pending (see other sub-items).
- [x] **Wire question bank resolver into import + wizard.** DONE 2026-06-19 (`feat/question-bank-shared`). Moved the question bank to `shared/questionBank.ts` (single cross-runtime source) — killed the brittle backend→dashboard runtime import (`import('../../dashboard/lib/policyQuestions.js')`); `dashboard/lib/policyQuestions.ts` is now a thin re-export so all wizard / `KnowledgeBaseView` imports are unchanged. Added `resolveQuestions({ customs })` = static bank + tenant custom questions (`tenant_docs` source='custom-question'), deduped by normalized text. `import-website` now resolves via this (direct in-process resolve). **Deliberately NOT built** (build-principle / no dormant abstraction): `GET /knowledge/questions` endpoint (no HTTP consumer — backend resolves in-process, dashboard imports shared directly), `business_type` filtering (all 9 categories are universal across verticals), and a `question_bank` DB table. Unit + handler regression tests guard the silent-`[]` path.
- [~] **E2E + simulate coverage for the step.** PARTIAL 2026-06-19 (`feat/question-bank-shared`). Added to `dashboard/e2e/knowledge-base.spec.ts`: tests 11-13 (suggestion review lifecycle — seed `knowledge_suggestion` → GET queue → PATCH confirmed ingests into live KB source=`website-scan` + status flips / PATCH rejected discards / cross-tenant approve → 404) and test 14 (`kb-import-website-stub`) which drives the REAL import-website handler — `resolveQuestions` (static bank + tenant custom questions) → real staging INSERT — with deterministic canned extraction via `KNOWLEDGE_IMPORT_E2E_STUB=1` (set on the e2e backend in `ci.yml`; CI's OPENAI key is `sk-dummy` so a real scan can't run there). Asserts the owner's custom question reaches the DB. Plus backend handler unit test (`src/routes/knowledge.importWebsite.test.ts`, mocked fetch). Run-verified 15/15 green against a migration-chain DB. **Real OpenAI scan path: live-smoke verified 2026-06-19** — real `POST /knowledge/import-website` against a local fixture site (`Joe's Auto Shop`) extracted 8 answers → 8 confirmed staged rows (real fetch + real GPT-4o-mini + real DB); not automated (cost/flake/network). **Still TODO (deferred):** wizard UI click-path E2E (paste URL → suggestions render → approve in the React UI). Deferred 2026-06-19 after a feasibility probe: the Suggestions surface sits under `AIInsightsView`'s `activeSubTab` (internal React state, NOT URL-routable — only `KnowledgeBaseView`'s inner `?tab=suggestions` is), and no existing e2e asserts KB UI _content_ as the super-admin storageState user (active-tenant selection is the blocker). Forcing one risks a flaky test; the approve logic is already covered at the component-unit (`KnowledgeSuggestions.test.tsx`) + API-E2E (tests 11-14) layers. Also `simulate.sh tools` import coverage (OpenAI-dependent — on-demand, like `simulate rag`). Gate on the RAG accuracy eval.
- [x] **Docs / UX polish.** DONE 2026-06-19 (`feat/knowledge-import-polish`). (1) **Docs**: `docs/BETA_ONBOARDING.md` now documents the optional "Import from website" wizard step + the scan/review flow + "from your website" provenance (wizard section + Knowledge base section). (`aiassistant-knowledge-base.md` is tenant content, not onboarding — left alone.) (2) **Empty-vs-unanswered**: `KnowledgeBaseView` PolicyQuestionRow now shows a persistent green "Answered" marker for answers loaded from the DB (previously only current-session saves showed a marker, so a prior-session answer looked identical to a blank one). Per-category `answeredCount` badge already existed. (3) **Cost guardrails**: added `fetchWithTimeout` (AbortController) to the scan path — 8s per site page + 30s on the OpenAI extract — matching the codebase's OpenAI-timeout discipline; combined with existing bounds (maxPages 6, 8KB/page, 12KB prompt, max_tokens 3000, customs LIMIT 50) the endpoint can't hang a request/pool slot. Per-tenant scan rate-limit deferred (no abuse evidence; YAGNI). Verified: tsc clean (backend+dashboard), KB e2e 15/15 green.
  - [x] **Per-row "from your website" provenance badge** — DONE 2026-06-19 (`feat/knowledge-import-low-items`). The wizard scan now saves matched answers with `source='website-scan'`; `KnowledgeBaseView` prefill accepts BOTH `policy-questionnaire` and `website-scan` (additive — scanned answers still pre-fill), carries `source` through the saved-answers map, and renders a distinct "From your website" marker (vs "Answered") on scan-sourced rows; scanned answers are excluded from the uploaded-files list + labeled "From website" in Review Everything. Editing a scanned answer drops the badge (server resets source on update — once edited it's owner-authored). The wizard's own questions-step prefill is title-based (not source-keyed) so onboarding is unaffected. **Regression guard:** new `KnowledgeBaseView.test.tsx` asserts both sources pre-fill + the two markers render. (Low-risk path chosen after confirming `tenant_docs` has no metadata column — `source` change was the only option short of a migration.)

- [x] **RAG: "address" queries don't retrieve the address doc — FIXED 2026-06-29 (`fix/rag-address-vocab`).** Both the durable doc-side fix and the query-side palliative shipped (owner chose "both"). Original diagnosis (2026-06-23, real `text-embedding-3-small` cosines): every other positive scored 0.59–0.63; both address phrasings scored an outlier-low **0.302**; out-of-scope negatives ≤0.20. At the strict `> 0.30` threshold the address case cleared by only 0.002 → run-to-run embedding variance flipped hit/miss (nondeterministic at the boundary). Two root causes, both now addressed:
  - **(1) Doc-side — the real fix.** The ingest normalizer was reducing the Q/A pair to a declarative `"Located at 123 Main Street downtown."`, **dropping the question form** `"Where are you located?"` — exactly the retrieval signal a caller asking "what's your address" needs. `prepareQADocument` (`src/services/knowledgeIngestion.ts`) now **prepends the raw question** to the normalized body before embedding, so the interrogative form always survives. NEW ingests benefit immediately; existing docs are backfilled by `scripts/reembed-qa-docs.mjs` (re-runs the same `prepareQADocument` over `tenant_docs` Q/A rows — pure data backfill, no schema change). **Manual prod step:** `npm run build && DATABASE_URL=… OPENAI_API_KEY=… node scripts/reembed-qa-docs.mjs --yes` (preview with `--dry-run`, scope with `--tenant <uuid>`).
  - **(2) Query-side palliative.** `shared/expandQueryForEmbedding.ts` prompt now instructs the expander to emit **morphological / doc word-forms** (address→`located locate location where situated directions`), not just abstract synonyms — so it matches the doc's actual word "located" instead of "location".
  - **Threshold untouched (0.30).** The "do NOT just lower the global threshold" guidance still holds — the fix raises the address vector above the cutoff rather than widening it, so the safe fall-back for genuinely-unknown topics is preserved.
  - **Measured (real `text-embedding-3-small`, direct cosine probe over a 5-doc KB incl. deliberate near-neighbors):** address now scores **0.394** (was 0.302) — clears the strict `>0.30` cutoff by **~0.09** (vs 0.002 before, which is what made it flaky); nearest other real topic 0.255, true out-of-scope ≤0.19. **Not** the ~0.6 of lexically-overlapping positives — address↔located is a genuine semantic gap; 0.394 with ~0.09 headroom is enough to kill the boundary nondeterminism, not more. **False-positive check** (the dangerous direction, since both doc-prepend and a more aggressive expander widen the surface): "how much to color my hair" correctly ranks coloring (0.609) above haircut (0.382) — right doc wins by 0.23; out-of-scope "hamburgers" peaks at 0.191, all below 0.30 → still falls back. No new confident-wrong-answer surface observed on this corpus (still worth a re-check against a real dense tenant KB).
  - **Verified:** `./scripts/simulate.sh rag --env local` (real OpenAI embeddings) PASS **9/9 (100%)** across **3 consecutive runs**, both address phrasings HIT every time, all out-of-scope falls back. `scripts/reembed-qa-docs.mjs` run-verified (`--dry-run` + a real `--yes` pass: 15/15 processed, 0 failed). Unit: `src/services/knowledgeIngestion.test.ts` (regression test asserting the question survives) + `src/queryExpander.test.ts` green.

- [x] Continue `src/index.ts` extraction / cleanup — DONE 2026-05-28. Health/admin inline routes (/, /demo, /health, /ready, /metrics, /admin/purge-soft-reservations) extracted to `src/routes/health.ts`. index.ts: 386→303 lines. `/admin/purge-soft-reservations` now wrapped in `withHandler` (was bare try/catch). health.ts has no file-wide eslint-disable (targeted inline disables only).
- [x] Finish broader CRM sync structure extraction (NEEDS-REFACTORING #10) — DONE (verified 2026-06-03). Clients + adapters moved to `src/services/crm/` (`e75b029`); shared layer fully extracted: `tokenManagement.getIntegrationTokens` (OAuth refresh), `syncMapHelpers` (sync-map/dedup incl. `ensureRemoteCustomer`/`isAlreadySynced`), `crmSyncStatus`, `syncPaginate`, `crmDisconnect`, `syncOrchestrator` dispatch loop. The remaining per-adapter code (jobber/hubspot/square/servicetitan) is genuinely provider-specific CRM-API logic over that shared layer — kept flat per "working flat beats a dormant abstraction." No further extraction warranted.

- [x] **B4** Sub-tab URL persistence — verified working (2026-05-28). `?tab=` init + `history.pushState` on change + `popstate` for back/forward all wired in `dashboard/app/dashboard/page.tsx:70–95`. No changes needed.
- [x] **C1 + C2** Schedule: 4 sub-views → 2, unify the 3 headers — DONE 2026-05-29 (`1a269ab`, verified 2026-06-03). `SchedulerView` now has 2 top-level tabs (`day`/`calendar`) + a segmented Day-mode control (Staff/Resources/List), one unified header bar (3 dup headers removed), and the "More" overflow dropdown gone. URL syncs `?subtab=day|calendar&daymode=…`. The TODO predated the commit.
- [x] **E1** Demo mode — DONE 2026-05-29 (`4934ed5`, verified 2026-06-03). `/demo` now provisions a per-session isolated demo tenant (`is_demo=true`, 30-min TTL) seeded with automotive sample data — no real account needed. `src/routes/demo.ts` + `src/services/demoSeed.ts` + `dashboard/app/demo`. The TODO predated the commit.

- [x] **Cluster B — verified defects** (3 sites, all done)
  - [x] `SetupWizard/StepServices.tsx` — DONE 2026-05-21. Duration field now uses a raw-text display state; clearing leaves it empty (was forced to `0`), empty propagates `0` (saveService's `< 1` guard rejects it), never NaN. +3-test regression spec `StepServices.test.tsx`. (Note: it was an input-UX bug, not silent data loss — `saveService` already rejected `0`.)
  - [x] `SuperAdminDashboard.tsx` — DONE 2026-05-21. Search input now controlled; filters sidebar cards by name (case-insensitive), shows a no-match message, and **disables drag-reorder while filtering** (added `draggable` prop to `TenantCard`; reorder math is by full-array index so a filtered subset would corrupt order). +3 tests in `superadmin.test.tsx`.
  - [x] `SetupWizard/index.tsx` — DONE 2026-05-21. Seed hoisted to `runSeed` (reconcile by name-diff via `seedTargetRef`, so partial-failure retry finishes without topping-up a user's own services); failure now surfaces a Retry banner instead of a silent `console.warn`. +2 tests. **All three Cluster-B defects closed.**

- [x] **Cluster C — overlay/dialog focus management.** DONE 2026-05-28. `useFocusTrap` hook (`dashboard/lib/useFocusTrap.ts`) added; all 8 surfaces updated: `WizardModeChooser` (role/aria + trap + backdrop), `WizardWelcome` (trap + Escape + backdrop), `FirstRunTour` (trap + Escape + backdrop), `SetupWizard/index` (trap + Escape), `AppointmentPopover` (Tab trap + X button), `StaffProfileCard` (role + X + focus management), `EmployeeDayFocusPanel` (role + aria-labelledby + trap), `SkillMapFixPanel` (aria-label on ✕). 743 tests passing (+17 new).
- [x] **Cluster D — accessible action controls.** DONE 2026-05-28. All 7 surfaces: Step{Employees,Services,Resources} — `onMouseEnter/Leave` → CSS `hover:` + `focus-visible:` + rings; SkillManagementView delete — `focus-visible:ring-2`; StaffSwimLaneView — aria-label specific with shift times; AppointmentBlock — `role="button"`, `tabIndex=0`, `onKeyDown` Enter/Space, `aria-label`. 746 tests (+3 new).
- [x] **Cluster E — empty / loading / filtered-no-results distinctness.** DONE 2026-05-28. `AppointmentListSidebar` — skeleton rows during load; `VoiceCallsView` — Filter icon + "Clear filter" CTA for no-results (vs PhoneOff for "no calls ever"); `EmployeeManagementView` — dashed empty state after load; `CustomerDetailPanel` — 3 italic-text empties → `EmptyState` compact with icons. `KnowledgeBaseView`/`DeletedRecordsPanel` already had strong distinction; `MyTeamView` is routing-only. 746 tests passing.

- [x] `SetupWizard/WizardWelcome.tsx` — DONE 2026-05-28 (`c804025`). Removed inaccurate "10 minutes / 6 quick questions" copy.
- [x] `SkillMatrixView.tsx` footer + `Step7GoLive.tsx` — drop persuasive/reassurance phrasing; state what changes factually. Done 2026-05-28.
- [x] `SetupProgressPill.tsx` — DONE 2026-05-28 (`bdd549e`). Removed `hidden` class; pill visible on all screen sizes.
- [x] `ProfileView.tsx` — "Security" card "coming soon" placeholder → replaced with factual account info (session expiry 8h + password-change instruction). DONE 2026-05-28.

- [x] **`tenants /update-config` partial-update safety.** Already implemented — read-then-merge in place (lines 204–207 `body.field !== undefined` check inside the `FOR UPDATE` transaction). Verified 2026-05-28. Standalone small PR.

- [x] Responsive fallbacks for wide matrices/maps — verified present 2026-06-03. `ResourceColumnsView`/`SkillRelationshipMap` already scroll (`overflow-x-auto`/`overflow-auto`); `OutlookLayout` has an `md:hidden` mobile nav; `SchedulerDateNav` is compact. `mobile-responsive.spec.ts` covers no-horizontal-overflow on 390px + Android. No change needed.

- [x] `@typescript-eslint/no-explicit-any` + `no-unsafe-*` family — DONE 2026-05-28. Fixed all 13 files / 59 warnings: typed `response.json()` casts in `api.ts`, `hooks.ts`, `LoginView`, `register`, `forgot-password`, `reset-password`; cast `JSON.parse` returns in `NewSchedulerView`; eslint-disable for `react-big-calendar` third-party `any` (unfixable at source); removed unused `Wrench`/`QuickAction`/`Save`/`rate` symbols; fixed unescaped entities in `Step7CallerQuestions`. Dashboard lint: **0 warnings, 0 errors**.
- [x] `@typescript-eslint/no-misused-promises` — DONE 2026-05-28. Zero violations across all 3 packages; promoted to `error` in all three eslint configs.
- [x] `@typescript-eslint/await-thenable` — DONE 2026-05-28. Zero violations; promoted to `error` in all three eslint configs.
- [x] `@typescript-eslint/unbound-method` — DONE 2026-06-22. Zero violations across all 3 packages; promoted to `error` in all three eslint configs (matches the no-misused-promises / await-thenable pattern above). Stray pre-existing `no-unnecessary-type-assertion` error in `agent/src/tools.test.ts` fixed in the same PR.

- [x] **End-to-end booking integration test in CI** — DONE 2026-07-01 (`src/agentToolsBookingIntegration.test.ts`): real route → `book_with_scheduling_atomic` → real Postgres; asserts stored UTC instant, assigned employee, `status='scheduled'`, local read-back, EMPLOYEE_NOT_SCHEDULED + TIMESLOT_OCCUPIED sad paths, + the serviceResolver ambiguous-`name` regression. Mutation-verified. Runs in CI.
- [x] **Agent tool-selection eval** — DONE 2026-07-01 (`agent/scripts/sim-toolselect.ts`, `./scripts/simulate.sh toolselect`): replays the REAL prompt + 20 tool schemas through gpt-4o-mini, grades the chosen tool sequence. 6 cases incl. bug-#3 regression. On-demand (OpenAI-gated), not CI. Baseline 6/6. (2026-07-04: now 23 tool schemas / 8 cases after the page-owner / customer-history / self-service-link tools; baseline 7/8 — the take_message case rotted via model drift, fails identically on unmodified main; see VOICE_AGENT_PLAYBOOK gotchas.)
- [x] **Audit every DB-mocking `*.test.ts`** — DONE 2026-07-01: full audit in `docs/TEST_DB_AUDIT.md`. All HIGH-risk gaps got real-DB companions (surfaced 3 real issues). MED round-2 companions added 2026-07-02; advisor verdict: MED vein exhausted.
- [x] **Multi-employee / multi-service scheduling coverage** — DONE 2026-07-02 (`src/multiEmployeeScheduling.realdb.test.ts`, 7 tests): skill matching, employee spillover, shift-aware assignment, capability-gated resource exhaustion, first true PARALLEL GiST double-book race. Runs in CI.

- [x] **Agent logs tool-call ARGS** (PII-redacted) — DONE 2026-07-02 (`agent/src/redactToolArgs.ts` + 13 tests). `function_tools_executed` carries `tool_calls:[{name,args,is_error}]`; phone/code keys digit-masked, time strings + names preserved.

- [~] **Books 30 min early** — a 4:30 request stored 4:00. **CODE DONE 2026-07-04 (branch `fix/booking-confirm-actual-time`); live-proof pending.** Root: `book_with_scheduling_atomic` books the EARLIEST open slot ≥ `window_from`, so a window that starts before the caller's pick books them earlier. Sharpened the `book_with_scheduling` tool description + prompt step 4 to set `window_from` to EXACTLY the picked time (not earlier). **Note: this MITIGATES, not prevents** — a hard stop would need intent-aware slot selection in the RPC; instead the confirm-real-slot fix below makes any early booking *audible* to the caller (safety net). Verified by unit tests only; the behavior closes on a live booking call + `toolselect`.
- [~] **Agent confirms the REQUESTED time, not the actual `booked_start`** — it said "4:30" while booking 4:00. **CODE DONE 2026-07-04 (same branch).** The backend already returns the actual tenant-local `booked_start`/`booked_end` + `employee_name` (agentTools.ts:1677); the gap was agent-side — `book_with_scheduling` dumped raw JSON with no directive. New `formatBookingResponse(res, requestedStart)` (`agent/src/tools.ts`) surfaces the ACTUAL booked time (`booked_time`) + employee, and when the caller named a specific time (new optional `requested_start` param) and the slot differs, flags `time_changed` with an explicit "their time wasn't open, tell them the real one" directive. Prompt step 5 + a scoped exception to the one-confirmation rule now require confirming the response's time and re-engaging on `time_changed`. **Regression-guarded:** the mismatch fires ONLY off the explicit `requested_start`, NOT `window_from` — so the "next available" flow (window_from is a search bound) never gets a spurious "your 9am wasn't open" note. 4 deterministic unit tests (match/mismatch/next-available-no-note/legacy-fallback); 430 agent tests green, tsc + eslint clean. Live-proof: a real booking call where the requested slot is taken.
- [x] **`book_appointment` / `check_availability` resource_id trap** — **FIXED 2026-07-03 (branch `fix/booking-tool-resource-id-trap`).** Both require a `resource_id` that only `get_scheduling_options` returns; `get_available_slots` yields spoken times with NO resource_id, so the LLM would dead-end here (prod bug #3). Made misuse fail loudly instead of removing the valid path: (1) sharpened the three tool descriptions (`get_available_slots` now states it returns no bookable resource_id → use `book_with_scheduling`; `book_appointment`/`check_availability` state the resource_id must come from `get_scheduling_options`, else use `book_with_scheduling`); (2) added a runtime guard — an empty/blank `resource_id` short-circuits to a `RESOURCE_ID_REQUIRED` redirect toward `book_with_scheduling` **without hitting the backend** (which would 400 on the non-UUID anyway). 3 new unit tests in `agent/src/tools.test.ts` (guard fires + no backend call, for both tools; plus a check_availability happy path); 42/42 green, agent tsc clean. The `toolselect` eval already pins the bug-#3 sequence (`get_available_slots → book_with_scheduling`, never `book_appointment`) — run `./scripts/simulate.sh toolselect` (OpenAI-gated, on-demand) to confirm the sharpened descriptions hold.

- [~] **Duplicate `Dale DeMott` employee** in prod (one soft-deleted, one active) — **GUARD ADDED 2026-07-03 (branch `fix/duplicate-active-employee-guard`); prod-row cleanup still pending (needs prod DB access).** `POST /employees/create` now rejects (409) a new employee whose normalized name (`LOWER(TRIM(name))`) collides with an existing **non-deleted** employee in the same tenant — so an accidental double-create can't split schedules/skills across two active rows again. Soft-deleted twins do NOT block (re-hire path preserved); blank names skip the check. Chose an app-level 409 over a partial UNIQUE index because genuine same-named staff are rare-but-legal (owner disambiguates the display name) and an index couldn't apply while prod still holds the duplicate. 3 real-DB tests (`src/routes/employees.realdb.test.ts`: happy create, dup-active 409 + no second row, soft-deleted-twin re-add allowed). **Remaining (Dale/prod):** delete or merge the existing duplicate active `Dale DeMott` row in prod.
- [~] **No cleanup pass** for soft-deleted employees/services lingering in mapping tables (`service_employee`). **INVESTIGATED 2026-07-03 → not a live problem; do NOT auto-clean.** Soft-deleting an employee/service leaves its `service_employee`/`service_resource` rows in place, but since PR #139 (migration `20260701000000`) the booking RPCs filter `is_deleted` employees out of every availability/overlap check, so a stale mapping can never surface a deleted employee/service in a booking — the rows are inert. Hard-deleting them on a *soft*-delete would also break restore symmetry (a restored employee would silently lose their skill/service mappings). Any future cleanup must be a scoped hard-delete-only pass (drop mappings only when the parent is HARD-deleted), not wired into the soft-delete path.
- [x] **`password_resets` RLS conflicts with the invite flow (latent, prod-safe today)** — **FIXED 2026-07-03 (branch `fix/password-resets-rls-invite`, option b).** `POST /users/invite` used to INSERT `password_resets` inside `withTenantClient` (tenant context set), tripping the `password_resets_unauthenticated_only` `WITH CHECK` → `42501` under a non-`BYPASSRLS` role (latent — prod's `postgres`/`rolbypassrls=true` bypassed it). Fix: the token INSERT now runs via `withPoolClient(pool, …)` with **no** tenant context — structurally identical to how the forgot/reset-password flow writes the table (`auth.ts`), honoring the policy's intent (only the unauthenticated flow writes `password_resets`). No migration; pure code. The real-DB suite's invite **HAPPY** path is now exercisable under the locked-down `api_user` (was previously un-testable) — `src/routes/users.realdb.test.ts` asserts both the `users` row and the `password_resets` token land; 7/7 green. Chose (b) over (a) a scoped policy because (a) would poke an authenticated-write hole in a table that has no tenant isolation to enforce (keyed by `user_id`), weakening the invariant.


### Archived: docs/AIASSISTANT_GO_LIVE_TODO.md (deleted 2026-07-05; open items → TODO.md P0 Voice; ops detail → RUNBOOK §7)

<details><summary>Full pre-deletion snapshot</summary>

# **PERSONA_NAME** Go-Live — Resume Checklist

> **SINGLE SOURCE for go-live / Telnyx ops detail (2026-07-02).** `docs/planning/TODO.md` tracks go-live *blockers* as one-line items and defers here for the operational detail (REFER enablement, DID routing, recording disclaimer, transfer wiring). Don't duplicate step-by-step go-live procedure into TODO.md.

# (file renamed to AIASSISTANT\_ for generic codename, was BETH_GO_LIVE_TODO.md)

# Persona name variable in seed (currently 'Chris')

# Marker: **PERSONA_NAME** (use in docs/comments for the name; change only in seed var)

Last worked: 2026-06-05. Owner: Dale. Claude walks you through each step.

**Goal:** **PERSONA_NAME** answers real calls on `+1 630-822-9086` (live) for Thinking Hammer LLC
(tenant `d5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0`). Test verification number `+1 630-822-9086`. (Previous `+1 630-866-1960` dead.)

> ## 📩 2026-06-05 — Telnyx support escalated; account healthy
>
> Telnyx (Mark Morse, 13:55 UTC) replied: _"We have escalated these call examples to
> our team for investigation — we will let you know as soon as we hear back."_ Ticket
> alive + escalated; awaiting Telnyx. Account suspension (30-day negative balance,
> 2026-05-25 — the real inbound-killer) cleared 2026-06-03: paid → re-enabled →
> upgraded → ID + account verification approved. Full thread in `docs/TICKET_SUPPORT.md`.
> **Still blocked on:** (a) Telnyx's escalation findings, AND (b) the different-carrier
> dial test below.

> ## 🔄 2026-06-30 UPDATE — live number corrected to 822-9086
>
> Live number `+1 630-822-9086` — the real owned + routed Telnyx DID. **Inbound CONFIRMED reachable 2026-06-30** (a real call reached the agent + logged a session/transcript).
> The long-documented `+1 630-866-9086` was a transcription error: that DID was **never owned** (it routes to another business that answers). `+1 630-866-1960` is a dead recycled DID.
> Landing pages, CLAUDE, RUNBOOK, TODO, tests, and `inbound_phone` fixtures now all use **822-9086**. Open PSTN verification steps target **822-9086**.

> ## ⚠️ 2026-06-04 UPDATE — supersedes the "NOT LiveKit / Telnyx-domain / do NOT
>
> ## mutate the trunk" conclusion below.
>
> Full live-API audit found **all config correct**; the inbound failure is **PSTN
> number-reachability**, not LiveKit or Telnyx config. Details in
> `docs/TICKET_SUPPORT.md` (top) — the 2026-06-04 provisioning-audit detail was folded in there; the standalone `PROVISIONING_AUDIT.md` was removed.
>
> - The earlier "INVITE never reaches LiveKit → don't touch the trunk" was based on a
>   broken test (Dale dialing from his cursed/unsynced carrier — that call never even
>   reaches Telnyx). We **did** touch the trunk (correctly): normalized its number to
>   `+E.164` and added the new number.
> - **New test number bought + fully wired today: `+1 630-822-9086`** (Telnyx id
>   `2975078589701031880`, on connection `2945038451784812111`, in LiveKit trunk
>   `ST_aUM3GuCuc9wL`). `+16308661960` is a dead recycled DID — stop testing it.
> - **NEXT STEP:** call `+16308229086` from a **different carrier** (not Dale's phone)
>   while monitoring LiveKit `listRooms()`. Room appears → pipe works, wait for
>   carrier propagation. Nothing → investigate UDP transport to LiveKit Cloud.

> ## 🔁 2026-06-11 — Live call-transfer (transfer_call) shipped; needs Telnyx REFER enabled
>
> Built `transfer_call`: when a caller needs a human, the agent cold-transfers the
> live PSTN leg off LiveKit to `tenants.forward_phone` (owner cell) via SIP REFER
> (`SipClient.transferSipParticipant` → `tel:<E.164>`). Set the number on the
> dashboard AI Persona page ("Forward Calls to a Person"). Code + tests green; NULL
> = no forwarding (agent takes a message).
> **RUNTIME DEPENDENCY — not solvable in code:** LiveKit's transfer rides a SIP
> REFER back through the **inbound trunk**, so the **Telnyx SIP Connection must
> have call transfer / REFER enabled**. Until that's turned on Telnyx-side, every
> transfer fails at runtime (the agent degrades to taking a message). Verify on the
> same different-carrier test call as the inbound-path check below.
> Caller ID on the transferred leg shows the trunk number (can't be set per-transfer).

---

## DONE (verified)

- [x] **PERSONA_NAME** persona + booking model + 19 KB docs seeded on tenant d5e3c6a1 (prod DB).
- [x] Telnyx account funded ($10) + upgraded (trial 1-order cap lifted).
- [x] Number **`+1 630-866-1960`** purchased. Resource id `2973794140900296302`. Status: active.
- [x] Number routed to Telnyx SIP connection **`livekit-outbound`** (`2945038451784812111`).
- [x] That connection activated (was `active:false`).
- [x] **2026-06-03** Step 1 — live LiveKit creds recovered from Railway (`secretary-hq-agent`
      service vars, key `APILz8…4i7Y`) + synced to local `.env`; `listRooms()` verified OK.
      Dead key was `APIUXRAMQuWQkkk`.
- [x] **2026-06-03** Step 2 — inbound trunk rebuilt with new number. List-field update is
      unsupported, so old trunk+rule were deleted and recreated. **Current live IDs:** - trunk **`ST_aUM3GuCuc9wL`** (`telnyx-inbound`, numbers `["16308661960"]`,
      **allowedAddresses `["0.0.0.0/0"]`**). - dispatch rule **`SDR_WEL49AwBB4NW`** (`thinkinghammer-dispatch`, individual,
      roomPrefix `call-`) → trunk above → agent `secretary-hq-agent`, metadata
      `{"tenant_id":"d5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0"}`. - ⚠️ CIDR fix: first rebuild carried `allowedAddresses:["0.0.0.0"]` from the old
      (never-proven-live) trunk — that's the literal host 0.0.0.0, a deny-all allowlist
      that silently rejects every caller. Corrected to `0.0.0.0/0` (accept any source IP).
      Number format kept WITHOUT leading `+` (`16308661960`), matching the old working shape.
      TODO security hardening (post-go-live): tighten `allowedAddresses` to Telnyx's
      published SIP signaling CIDRs instead of accept-any. - Dead intermediates (already deleted, ignore): `ST_Li58t3gXgo4N`/`SDR_if97ky4Zf7e6`
      (orig), `ST_w2eymtkQpKcq`/`SDR_Cvs2989McV68` (broken CIDR).
- [x] **2026-06-03** Step 3 — tenant phone fields written to prod DB (was `phone_status='failed'`,
      now `inbound_phone='+16308661960'`, `phone_status='active'`, `telnyx_phone_number_id='2973794140900296302'`).
- [x] **2026-06-03** Step 4 — `secretary-hq-agent` deployment SUCCESS; logs show "registered worker";
      `agent/src/index.ts:253` registers `agentName: 'secretary-hq-agent'` (matches new rule).
      PROVEN LIVE: an explicit `AgentDispatchClient.createDispatch(room, "secretary-hq-agent",
    {tenant_id:d5e3c6a1})` was picked up in ~1s (agent participant joined). Worker is
      connected NOW, not just booted. Test room cleaned up. → only the PSTN leg is untested.

---

## TODO — to finish go-live (in order)

> Steps 1–4 COMPLETE 2026-06-03 (see DONE section). Only the live test remains.

### 5. LIVE TEST — call `+1 630-866-1960` ← ONLY REMAINING STEP (Dale dials)

- **PERSONA_NAME** should greet (name + recording notice + 3-path question).
- Walk each path: personal / programming / SecretaryHQ.
- Try a real booking → confirm row lands in `appointments` for tenant d5e3c6a1
  inside Dale's Mon–Fri 1–5pm window (out-of-window should reject).

**2026-06-03 ~16:00 UTC — INSTRUMENTED DIAL (decisive). Leg localized: NOT LiveKit.**
Telnyx support (earlier) said the number is active but the FQDN connection "lacks inbound
call handling." Re-verified via API: connection `2945038451784812111` inbound
`default_primary_fqdn_id` = `2945040817925916333`, which MATCHES the live LiveKit FQDN
`ai-secretary-nmlkkmgf.sip.livekit.cloud:5060` — so the static config LOOKS correctly wired.
To stop guessing, ran a measured dial:

- Baseline `RoomServiceClient.listRooms()` = 0. Dale dialed `+16308661960`. Polled again at
  +0s and +5s = **still 0 rooms.** No `call-*` room, no participant — **the SIP INVITE never
  reached LiveKit.**
- Dale heard his **carrier's** recorded intercept: "The number you dialed is not in service…
  dial 611 for customer service. **Message EL402IL53**" (EL…IL = an Illinois carrier SIT).
- **Conclusion:** the call dies UPSTREAM of LiveKit (Telnyx or originating carrier). LiveKit
  is exonerated — the earlier LiveKit trunk `+`/no-`+` DNIS-format theory is RULED OUT (no
  INVITE arrives to reject). Do NOT mutate the LiveKit trunk. This matches Telnyx support's
  "inbound not handled" direction: despite the inbound FQDN pointer being set, Telnyx is not
  delivering inbound INVITEs to our SIP server.
- **Next (Telnyx-domain, see `docs/TICKET_SUPPORT.md` for the reply):** go back to Telnyx with
  the data — "We use FQDN SIP trunking (your Option 1) to LiveKit; connection
  `2945038451784812111` inbound `default_primary_fqdn_id` points to our FQDN; on an inbound
  call NOTHING arrives at our SIP server. Are you (a) finding no inbound route, or (b) routing
  to the FQDN and getting a SIP failure — and what cause code do you see?" Plus Dale checks
  Mission Control → the number's inbound routing + the FQDN connection's SIP debugging/call
  flow. Do NOT create a Call Control/TeXML app (their options 2/3 — wrong for LiveKit).

---

**2026-06-03 09:33 UTC — first dial returned SIT "the number you dialed is not in service."**
Diagnosed as PSTN activation lag, NOT config. Verified correct end-to-end:

- Telnyx: `+16308661960` status active, voice-enabled, on FQDN connection `livekit-outbound`
  (`2945038451784812111`) → FQDN `ai-secretary-nmlkkmgf.sip.livekit.cloud:5060`, no
  call-forwarding, inbound_call_screening disabled.
- LiveKit: trunk `ST_aUM3GuCuc9wL` accepts the number + `0.0.0.0/0`; rule `SDR_WEL49AwBB4NW`
  → agent; worker proven live (explicit dispatch picked up in ~1s).
- Number was only ~8h old at dial time (purchased 2026-06-03T01:18Z). SIT intercept =
  originating carrier's routing tables not yet propagated; often per-carrier.
- Could NOT pull CDRs (Telnyx detail_records record_type=voice rejected; cdr_usage_reports 404) to prove whether the call reached Telnyx. The different-carrier retest below closes that.
- **Next:** (1) retest from a DIFFERENT phone/carrier; (2) wait up to 24h from purchase;
  (3) if dead past 24h from multiple carriers, open Telnyx ticket (number active +
  voice-configured but SIT not-in-service, no inbound CDRs).

**2026-06-03 ~12:40 UTC — STILL DEAD. Dale dialed by hand, heard recorded
"Sorry, no longer in service."** Number now ~11h old (bought 01:18Z). Full Telnyx
re-verification via API (all clean — config is NOT the problem):

- Number order `success`; number `status=active`, `release_in_progress=false`,
  `phone_number_type=local`, `source_type=number_order` (recycled DID).
- `/voice` settings: connection `livekit-outbound` (`2945038451784812111`) assigned,
  `inbound_call_screening=disabled`, `call_forwarding_enabled=false`, `translated_number=""`.
- FQDN connection: `active=true`, primary FQDN `ai-secretary-nmlkkmgf.sip.livekit.cloud:5060`.
- LiveKit trunk/rule/worker all proven live 2026-06-03 (see DONE §, Step 4).

**Root cause (high confidence): recycled-DID sticky disconnect at the PSTN layer, NOT
SIP/config.** The symptom is decisive: a _recorded_ "no longer in service" announcement is
a **carrier intercept** — the call dies at the originating/transit carrier and never reaches
Telnyx. A SIP/trunk/LiveKit fault would give dead air, fast-busy, or rings-then-silence —
never a spoken announcement. `+16308661960` is a recycled local number; its prior owner's
disconnect record is still cached in carrier LERG/routing tables. Telnyx now owns + routes it
correctly, but the wider PSTN has not refreshed.

**Action plan (Dale — cannot be fixed from code/API):**

1. **Open a Telnyx support ticket now** (most effective). Wording: "Inbound calls to
   +16308661960 from multiple carriers hit a recorded 'no longer in service' intercept. No
   inbound CDRs. Number shows active + voice-configured on FQDN connection `livekit-outbound`.
   Suspect a stale disconnect record on a recycled DID — please push an upstream
   routing/activation refresh." Log the ticket number in `docs/TICKET_SUPPORT.md`.
2. **Retest from a different carrier** (phone on another network) — confirms carrier-cache
   vs universal failure.
3. **Wait** — recycled-number intercepts commonly clear 24–72h post-purchase on their own.
4. **Fastest fallback:** release this DID, buy a _different_ fresh number (no disconnect
   history routes immediately) via `POST /provisioning/activate` (search→purchase→assign),
   then redo Step 2 (trunk numbers) + Step 3 (tenant phone fields) for the new number.

> Minor config note for whoever picks this up: connection inbound has `dnis_number_format=e164`
> (Telnyx sends `+16308661960` with leading `+`), but the LiveKit trunk number list is
> `["16308661960"]` (no `+`). Irrelevant while calls never reach Telnyx, but verify the match
> once the PSTN intercept clears — if **PERSONA_NAME** still doesn't answer after a real INVITE lands,
> normalize one side.

**If the call fails, the symptom tells you the layer:**

- **Dead air / instant hangup / fast-busy** → Telnyx not forwarding to LiveKit's inbound
  SIP URI, or trunk rejecting. Check the Telnyx connection's INBOUND routing actually
  targets LiveKit's inbound SIP host (the connection is named `livekit-outbound` — verify
  its inbound leg, not just outbound). Trunk allowlist/number-match already fixed.
- **Rings, connects, then silence (no agent joins)** → worker not connected to LiveKit
  _right now_. Deployment shows SUCCESS but that only proves it booted 2026-06-02; pull
  FRESH `secretary-hq-agent` logs (Railway token method: memory `reference-railway-headless`)
  and look for a recent reconnect/crash. Redeploy the service to force a fresh registration.
- ****PERSONA_NAME** answers but booking fails** → tenant data / booking RPC, not telephony.

---

## PHASE 2 — after live (separate work, needs agent code + redeploy)

- [ ] Recording disclaimer → deterministic verbatim greeting (Illinois 2-party
      consent). Needs `tenants.greeting` column + tenant-config route +
      `tenantConfig.ts` + `agent/src/index.ts` greeting line (currently hardcoded
      "Thanks for calling…").
- [ ] Personal-call transfer tool → Dale's cell, via
      `livekit-server-sdk` TransferSipParticipant. Depends on Telnyx outbound PSTN
      (now that account is upgraded, may work — untested). v1 fallback: **PERSONA_NAME** books
      a callback / takes a message.

---

## Side items (not blocking)

- [ ] Review the 1 pending improvement proposal: `/improve` → "Wizard pre-fill
      from business template" (a/r/s).
- [ ] Correct stale note: old SIP connection id `2973577228794726874` in earlier
      memory does NOT exist. Real LiveKit connection = `2945038451784812111`.

</details>

### Archived: docs/GAPS.md (deleted 2026-07-05; open gaps → TODO.md; analysis retained here)

<details><summary>Full pre-deletion snapshot</summary>

# SecretaryHQ — Gaps & Missing Pieces

**Deep dive analysis** — 2026-06-23 (main branch; post doc hygiene pass)

> **Closed 2026-07-04 (PRs #187–#192, all merged + deployed to prod, migration-free):** 3 new voice tools (`page_owner_via_sms`, `get_detailed_customer_history`, `send_self_service_link` → 23 tools); CSV bulk import/export (`/export/*.csv` + `/customers/import`); session-revocation UI (`/users/*/revoke-sessions`) + feature-readiness report (`/admin/feature-readiness`); first-time-fix analytics + failed-delivery drill-down (`/communications/history?status=failed`, now recording failed rows); weekday×hour utilization heatmap (`/analytics/utilization`). GAPS body lines below flipped in place.
>
> **Closed since this inventory was written (banner refreshed 2026-06-30 — body below not yet line-edited):** AI cost/usage metering (`ai_cost_events` + `/analytics/ai-cost`), customer **self-service action links** (cancel/reschedule tokens + dashboard "Send links" + public pages + E2E), **data export + audit-log** APIs and dashboard surfaces (`/export/tenant-data`, `/audit-log`), website-scan onboarding + RAG answer-debugger, analytics depth (cohorts/CLV/abandonment-by-service/date-range), forwarded-line caller matching (PR #125), and the RAG address-vocab fix. Treat any "missing/❌" claim below as **possibly already shipped** — cross-check `docs/planning/TODO.md` (the live queue) before acting. GDPR purge (#68) + retention worker (#69) remain **legal-held**; PSTN inbound + Telnyx REFER + observability tokens remain the live P0 blockers.

This document captures a comprehensive inventory of what the project is missing, from every angle. It is derived from live code (`src/`, `agent/`, `dashboard/`, `shared/`), schema (154 migrations), tests, CI, runtime behavior (mocks, env gates), and all key docs (TODO.md, AIASSISTANT_GO_LIVE_TODO.md, STRATEGY.md, COMPETITOR_WEAKPOINTS.md, DEPLOYMENT.md, SECURITY.md, TEST_COVERAGE.md, RESOLVED.md, HANDOFF.md, etc.).

**Context**: Multi-tenant Voice AI Reception SaaS for service businesses (tire shops, salons, auto, trades, fitness, food & beverage). **HIPAA verticals are permanently excluded.** Strong foundation in voice (Telnyx + LiveKit), atomic booking, RLS multi-tenancy, dashboard, and recent shipments (live call-transfer + transcripts + summaries + outcomes + analytics + simulate harness + competitor CRM removal + data export/audit/RAG debugger + doc consistency hygiene).

Many items below are already tracked in `docs/planning/TODO.md` (especially Phase 13 production wiring, `[prod]` silent-degrade risks, and AIASSISTANT checklist). This file expands into unstated angles and provides a single "get to these things" reference. Use it alongside (not instead of) the active TODOs, simulate harness, and prepare-commit workflow.

**Update rule**: Refresh this file after major shipments or when a new class of gap surfaces. Cross-link back to specific files/lines and docs when possible.

---

## Executive Summary

The project is unusually mature for a solo-dev codebase. Core engine (booking RPCs + RLS + voice agent tools + recent call outcome plumbing) is production-grade. The remaining gaps are primarily:

- **Wiring & config** (silent mocks, missing prod envs, un-gated deploys).
- **Last-mile product** (customer self-service, billing UI, comms providers live, no-show depth).
- **Live validation** (PSTN inbound is the single biggest blocker for any real customer).
- **Ops visibility** (observability tokens, cost metering, load testing).
- **Business surface** (legal docs, support tooling, plan management).

Focus next sessions on the AIASSISTANT checklist + all `[prod]` silent items + Stripe verification. That unblocks paid customers and makes everything else visible.

---

## 1. Production Readiness & Go-Live Blockers (Highest Risk)

From `docs/planning/TODO.md` + `AIASSISTANT_GO_LIVE_TODO.md` + source:

- **PSTN inbound path unverified** for the live number (`+1 630-822-9086`). Different-carrier dial to test number `+1 630-822-9086` + `listRooms()` monitoring still required. Previous `+1 630-866-1960` dead. Carrier propagation / recycled-DID issues diagnosed; Telnyx ticket escalated. Agent + LiveKit + Telnyx SIP config proven in isolation, but real voice is the blocker for `__PERSONA_NAME__` (tenant `d5e3c6a1...`) and any paying customer.
- **Telnyx REFER / call transfer not enabled** on the SIP Connection. `transfer_call` tool (shipped) degrades to "take a message" when `forward_phone` is set.
- **`[prod]` silent-degrade risks — code fixes shipped 2026-06-16/17** (boot warnings now fire for all of these; prod env vars still need to be set):
  - ~~Reminders/comms SMS → MockAdapter~~ — FIXED: `ProviderRegistry` defaults to Telnyx. Set `TELNYX_PHONE_NUMBER=+16308229086` on Railway.
  - Email → mock transporter without `EMAIL_USER`/`EMAIL_PASS` — boot warning fires; set Gmail app-password on Railway.
  - ~~Agent `BACKEND_URL` defaults to localhost~~ — FIXED: config validation now fails at startup if unset. Set `BACKEND_URL` on `secretary-hq-agent`.
  - ~~`STRIPE_WEBHOOK_SECRET` empty → webhooks 400~~ — boot warning fires; set on Railway.
  - ~~`CORS_ORIGIN` unset reflects ANY origin~~ — boot warning fires; set on Railway.
  - ~~`DASHBOARD_URL` defaults to localhost~~ — boot warning fires; set on Railway.
- **Observability — paid vendors DECLINED (decision 2026-07-02)**: `BETTER_STACK_TOKEN` + `SENTRY_DSN` intentionally not set — no paid observability vendor at this stage. In place + free: `/metrics` (Prometheus-style, gated by `METRICS_TOKEN`), Pino JSON logs on Railway live-tail, `/ready` deep readiness. No error-grouping/alerts until a free path (e.g. Grafana Cloud over `/metrics`) is chosen. Not a gap — a cost decision.
- **Railway deploy gated on CI green via GitHub** (progress 2026-06-15): branch protection applied on `main` requiring the 4 CI jobs (Backend, Dashboard, Agent, E2E) + PR + enforce admins. Auto-deploys from `main` now blocked on red CI. **Remaining**: Enable "Wait for CI" on Railway services. (See `docs/planning/TODO.md` Production Wiring Checklist.)
- **Stripe never verified live** (test mode + CLI webhook replay outstanding per TODO). Checkout + 3-event webhook + `/billing/status` + `subscriptionGate` exist, but automatic tax missing, price IDs not on prod, no owner-facing flow.
- **Legal / insurance / ops (user actions)**: Bonterms ToS/Privacy/DPA, TCPA-compliant SMS opt-in language at booking time, E&O + Cyber Liability insurance, LLC bank account (Stripe payouts), S-Corp election later. No in-app customer support/ticketing.
- **Env/config surface risks**: Telnyx for provisioning/OTP; calendars and remaining CRM need their OAuth triples. **SHIPPED 2026-07-04** — a single "feature readiness" report: `src/services/featureReadiness.ts` (shared source of truth that `envWarnings` now consumes) emitted once as a structured boot log + served live at `GET /admin/feature-readiness` (super-admin), per-capability `ready|mocked|disabled|missing_config`.

**Status**: Phase 13 in progress. Core is wired; the gaps are config + live validation + gates.

---

## 2. Core Product / Receptionist Feature Gaps

Voice booking + context + policy RAG + preferences + transfer (recently completed) are solid. Missing receptionist table stakes:

- **SHIPPED (partial)** — **customer self-service reschedule/cancel links**: token-gated public pages (`src/routes/selfService.ts` + `dashboard/app/self/*`) + "Send self-service links" dashboard action + E2E. **Still missing**: public booking widget/embed, full customer portal/login, "manage all my appointments" hub, web callback request. Intake is still voice-only + staff dashboard.
- **No waitlist, callback queue, or "call me back" tooling** beyond `transfer_call`. NULL `forward_phone` just takes a message.
- **No-show / follow-up automation is thin**. Reminders exist (60s poll scheduler, retry columns, `GET /reminders/delivery-stats`, some UI). No auto no-show marking from external calendars, predictive scoring, auto-rebook offers, or waitlist promotion. Cancellations supported via API/UI; voice "cancel" flows limited.
- **Call recordings absent from product**. `voice_sessions` now captures transcripts (`transcript.ts`), summaries (`callSummary.ts`), outcomes (`callOutcome.ts`), and `appointment_id` links (all recently wired). No audio storage, dashboard playback, redaction, or retention policy. (Upstream LiveKit/Telnyx recording possible but unwired.)
- **Limited multi-party / warm transfer**. Cold SIP REFER only.
- **Shallow "book for someone else" / family / group support**. Basic `CustomerContext` + notes exist; no advanced corporate or recurring profiles.
- **No rich media during calls** (e.g., photo of tire damage for auto shops).
- **Outcome classification is good** (`callClassify.ts`: booked / no_availability / wrong_service / price / message / info + abandoned) but not yet driving automations (e.g., price-sensitive follow-up SMS).

**Agent tools** (`agent/src/tools.ts` — 23 tools as of 2026-07-04):

- `get_customer_context`: CRM lookup + history + preferences (called early when caller ID present).
- `find_caller_by_name`: name-first CRM lookup for forwarded lines (caller ID is not the caller's own number); returns matching contacts + phone on file to confirm. Empty list = new caller.
- `get_service_catalog`: list services with duration/price.
- `get_available_slots`: open times for a service_type on a YYYY-MM-DD (tenant TZ).
- `get_scheduling_options`: (resource, employee) combos in a window + capability/skill filters.
- `check_availability`: exact resource+start/end check (noted as SLOW; prompt auto-injects filler).
- `book_appointment`: specific slot (requires verified phone; wires `call_id` and records outcome for voice_sessions link).
- `book_with_scheduling`: window + requirements → auto-pick + book (preferred for "next available").
- `get_company_policy_answer`: RAG over tenant_docs (uses query expansion + pgvector).
- `send_verification_code` + `verify_phone_code`: Telnyx SMS OTP for blocked-CID bookings.
- `identify_caller`: upsert customer by phone+name (non-booking capture).
- `save_customer_preference`: durable facts (preferred_stylist etc.) for future calls.
- `transfer_call`: SIP REFER to `tenants.forward_phone` (or message fallback); records outcome.
- `take_message`: collect caller name + message + optional callback phone, persist to `customer_messages`, SMS-notify owner. (Added 2026-06-16.)
- `get_my_appointments`: list caller's upcoming scheduled appointments by phone (server-injected — LLM never supplies it). Returns service_name + employee_name for natural voice ("your Oil Change with Mike"). (Added 2026-06-16.)
- `cancel_appointment`: cancel caller's own appointment by UUID; phone ownership gate at backend — LLM can never cancel another caller's booking. (Added 2026-06-16.)
- `reschedule_appointment`: move appointment to new start/end; same phone ownership gate; backend validates future time + non-overlap via GiST exclusion. (Backend endpoint + reminder reschedule added 2026-06-18.)
- `capture_job_inquiry`: record a work/job inquiry (company, contract vs full-time, rate, onsite/remote, etc.) after intake and email it to the owner. (Added 2026-06-25.)
- `page_owner_via_sms`: urgent mid-call SMS page to the owner (caller name + callback + one-line reason); persists a `[URGENT PAGE]`-flagged `customer_messages` row; at most one page per call (guard in session context); graceful fallback to take_message when no owner number is configured. (Added 2026-07-04.)
- `get_detailed_customer_history`: deep history — last ~10 appointments (any status, with service/employee/date/status), saved preferences, and last ~3 `voice_sessions` call summaries. Phone server-injected like my-appointments. (Added 2026-07-04.)
- `send_self_service_link`: texts the caller a secure cancel/reschedule link for one of their own upcoming appointments (default: next upcoming). Reuses the selfServiceToken machinery; SMS is consent-gated (opt-outs respected). Prompt proactively offers it in the cancel/reschedule flow. (Added 2026-07-04.)

Current vs. desired for a complete receptionist:

- Have: book, lookup, policy, basic transfer, preference capture, cancel, reschedule, my-appointments, take message, urgent owner page, deep customer history, self-service link by text.
- Missing (lower priority): real-time "is my tech running late?" status, warm transfer.

**SHIPPED — Customer Self-Service Action Links** (was the P1 highest-leverage gap). Token-gated cancel/reschedule links generated + embedded in confirmations, public `/self/*` pages, dashboard "Send self-service links" button, token redemption + negative-case E2E all landed. Files: `src/routes/selfService.ts`, `dashboard/app/self/*`. Full original gap state + delivered design spec archived in `docs/planning/RESOLVED.md` (2026-07-04 entry).

**SHIPPED 2026-07-04 — next-level voice tools that pair with self-service**: the agent now proactively offers "I can text you a link to reschedule yourself" (send_self_service_link tool + prompt step 3 in the cancel/reschedule flow) instead of always doing it live.

---

## 3. Integrations Maturity

- **CRM**: Only Square remains (strategic removal of Jobber/HubSpot/ServiceTitan — they bundle competing AI receptionists; see `docs/STRATEGY.md` and `COMPETITOR_WEAKPOINTS.md`). Full `src/services/crm/` (client + sync + status + disconnect + webhook + scaffold). Tested via `SYNC_TEST_RECORDER`. No deep bidirectional reads (pull open jobs/tickets into voice context).
- **Calendar**: Google + Outlook fully coded (`googleCalendar.ts`, `outlookCalendar.ts`, `calendarSync.ts`, OAuth factory, mutation-driven sync) but entirely env-gated (`GOOGLE_*` / `OUTLOOK_*`) and unproven in production. No per-tenant calendar view or live conflict surface beyond the internal scheduler grid.
- **Communications (SMS/Email)**: Routes + history (`communications_history` table + `GET /communications/history`) + consent + opt-out + delivery receipts + per-tenant rate limiting + retry policy all wired. ProviderRegistry defaults to Telnyx (see silent-degrade section). Email is nodemailer-only (no SendGrid/etc.). Templates are basic Handlebars.
  - **Actionability gap** (ties directly to self-service): Current SMS (smsService.ts applySMSTemplate) are 1-2 sentences with only STOP. No "tap here to reschedule", no deep links, no structured replies parsed back into the system. Reminders are scheduled in `reminderScheduler.ts` (polling) + `scheduleForAppointment.ts`; delivery stats added recently, and the comms-history view now has a per-row failed-delivery drill-down (`GET /communications/history?status=failed` + "Failed only" filter with the recorded provider error detail on `CommsSentView`).
  - Reliability: retryPolicy + rate limiter good on paper; live behavior unknown until providers are set (mock always "succeeds"). No bounce / complaint handling beyond basic opt-out.
- **Provisioning/Phone**: Excellent — `/provisioning/activate` does search → purchase → assign to SIP connection and writes tenant fields. Telnyx + LiveKit plumbing mature. No porting, vanity numbers, or easy multi-number support.
- **No payments processing** for the business's own customers (intentional per strategy).
- **No accounting** (QuickBooks/Xero), no marketing automation, no inventory sync.
- OAuth state (JWT) and webhook HMAC/raw-body verification are strong (SECURITY.md).

---

## 4. Billing & Monetization

Backend (`src/routes/billing.ts`):

- `POST /billing/checkout` (customer create/upsert + Stripe session with metadata).
- `POST /billing/webhook` (handles `checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted`).
- `GET /billing/status`.
- `subscriptionGate` middleware (returns 402 for non-active tenants except super-admin + exempt paths like `/billing`, `/health`, auth).

Tiers (Solo/Growth/Pro) + price ID env vars exist.

**Everything from the original 2026-06-15 audit is SHIPPED** (billing UI `BillingView.tsx`, typed `billing` API namespace incl. `'professional'`, `automatic_tax` behind `STRIPE_AUTO_TAX=true`, Stripe Customer Portal via `POST /billing/portal`; full delivered spec archived in `docs/planning/RESOLVED.md`, 2026-07-04 entry) **except**:

- **STILL OPEN** — never run against real Stripe (test-mode + `stripe listen` + full round-trip). This is a Dale/env action, not code.

---

**Usage / Cost Metering tie-in** (see also Reliability section): **SHIPPED** — AI spend is now metered (`ai_cost_events` table) and surfaced via `/analytics/ai-cost` + a breakdown in `AnalyticsView`. **Still open**: tying metered usage to Stripe as billing items, and soft/hard plan caps.

---

## 5. Onboarding, Knowledge & Setup

- Wizard (solo + team modes), 30 business templates (now in seed + `business_templates` table), vocabulary system, first-run tour, setup progress pill, and `/demo` ephemeral tenant are strong.
- **Website scan onboarding**: Core fetch + LLM extract + `knowledge_suggestion` staging + dedicated Step 7 (`Step7WebsiteScan.tsx`) + prefill of later policy questions step shipped 2026-06-12. **SHIPPED since**: per-question suggestion review UI (`KnowledgeSuggestions`), scan happy-path + wizard click-path E2E, and cost/rate-limit guardrails (`src/services/scanRateLimit.ts`). **Still pending**: periodic re-scan of stale KB (deferred — needs a `last_scanned` column + is a cost/product call).
- Knowledge base: File upload, `knowledgeIngestion.ts` (chunking + embeddings), pgvector RAG via `/agent-tools/policy-answer` + `shared/expandQueryForEmbedding.ts` (recent accuracy win). `simulate rag` harness reports 100% hit-rate on known seeds. **SHIPPED**: caller-facing source citations (`[From "<title>"]` in `policy-answer`) + admin "explain this answer" debugger (`POST /knowledge/explain` + `ExplainAnswerView`). **Still missing**: periodic re-scan.
- Policy questions: Static bank + tenant customs.
- No "import from existing calendar/CRM" step beyond the website scan.

---

## 6. Dashboard, UX & Staff Features

Strong primitives (`EmptyState`, focus-trap Modal, Toast, Badge, etc.), role gating (owner vs front_desk snaps back), `?tab=` / `?subtab=` URL sync, mobile responsive spec, guided tour, setup pill.

**Gaps** (many already in UX backlog / TODO.md):

- Analytics (`AnalyticsView.tsx`): Real data from `/analytics/stats` + calls + conversion + abandonment + "Why Callers Reached Out" + reminder delivery stats (recent work). Still surface-level; lacks a true "ask anything over my transcripts" owner copilot.
- Scheduler: Mature (single source `employee_schedule`, atomic RPCs with 5 specific error codes, overrides, quick-book). Pending items include full sub-view consolidation and neutral language on any remaining "grading" UI.
- Wizard: Draft-state Phase B (hold services/employees/shifts/etc. in local state until final "Done"; discard on dismiss) still open (large).
- CRM + CustomerDetail: Functional + internal notes + history. No deep synthesis of "what this customer has said on calls."
- **SHIPPED 2026-07-04** — CSV bulk import/export: owner-gated `GET /export/{customers,appointments,calls}.csv` (hand-rolled RFC-4180 + formula-injection guard, no new dep) + `POST /customers/import` (bulk customer import: liberal header matching, per-row zod+normalizePhone validation, in-file + existing-tenant dedupe, 1 MB / 2000-row caps, per-row error report); Export/Import buttons in `CRMView` + appointment/call CSV exports in `BusinessSettingsView`. **Still missing**: mass in-app actions (bulk edit/delete), PDF export.
- **SHIPPED 2026-07-04** — utilization heatmap: `GET /analytics/utilization` (weekday × hour grid of staffed vs booked minutes, tenant-local, cross-midnight-clamped, optional From/To) + `UtilizationHeatmap` CSS-grid panel in `AnalyticsView` (single-hue theme-var shading, per-cell aria-labels, neutral language). Prior "no visual coverage/utilization heatmap beyond scheduler bars" closed.
- "Active call" badge exists; deeper live monitoring/barge does not.

Neutral-language rule ("no percentages/warnings/opinions") partially applied after UX audits.

---

## 7. Voice AI & Reliability Specifics

Prompt system (tenant persona override via `{{ }}` placeholders, customer preferences, availability discipline, "Technical glitches" recovery section) + post-call classify/summary/transcript + graceful fallback all present and recently hardened (`agent/src/` modules: `prompt.ts`, `callClassify.ts`, `callSummary.ts`, `transcript.ts`, `callOutcome.ts`, `transferClient.ts`, `fallback.ts`).

**Known issues**:

- Occasional filler phrases ("Absolutely!", etc.) still slip through.
- Agent resilience: Outer try/catch + fallback shipped; "speak filler before slow tools" (getAvailableSlots etc.) and idempotent-read retry still open (P3 items).
- Single LiveKit agent worker per tenant (no automatic scaling for high-volume shops).
- No multi-language or accent surface (English primary; per-tenant `tts_voice` (OpenAI ids: shimmer/nova/...) / `tts_speed` via `tenants` columns; legacy `tts_soft`/`tts_cheerful` columns are inert Grok-only artifacts).
- No real-time owner listen-in or coaching during calls.

---

## 8. Reliability, Ops, Scaling & Cost Control

- DB pool well-tuned (`max=10`, `connectionTimeoutMillis=5000` fail-fast, server-side GUC timeouts, RLS via `withTenantClient`).
- Load testing of the booking path (concurrent calls until pool exhaustion or latency cliff) deferred (explicit note in TODO).
- Reminders: Pure polling worker (`src/workers/reminderScheduler.ts`, 60s tick, batch ≤100). Not event-driven or queue-backed.
- **AI cost blind spot (historical at time of writing)**: Per-call spend (OpenAI GPT-4o-mini + embeddings + summaries + Grok TTS + Deepgram) was completely untracked per-tenant or globally at one point. (AI cost metering via `ai_cost_events` + /analytics/ai-cost has since shipped; see CLAUDE.md and recent PRs. Legacy 'xai' provider rows may exist in the table from before the 2026-06-25 removal.)
  - Instrumentation points included (and former Grok TTS calls were in the now-deleted `agent/src/grokTTS.ts`).
  - Proposed data model (additive, low risk):
    - New table `tenant_usage` or daily aggregates `tenant_daily_usage (tenant_id, date, calls: int, llm_tokens: bigint, tts_chars: bigint, stt_seconds: int, embedding_calls: int, estimated_cost_usd: numeric)`.
    - Or simpler start: append to `voice_sessions` a `cost_usd` column + `models_used` json (populated in the `voice-session-end` handler).
    - Prometheus counters already exist in `src/services/metrics.ts` — extend with cost labels or a separate `ai_cost_usd_total{tenant, provider}`.
  - Exposure: owner dashboard "Usage this month" card (calls + est. AI cost), soft cap warnings ("approaching plan"), hard cap optional (return "busy" or fall back to cheaper model).
  - Tie to billing: later, report usage to Stripe as metered billing items on the subscription.
  - Owner-visible in P1 cluster below.
- No horizontal scaling story for agent workers or backend under concurrent voice load.
- Soft-reservation purge + GiST exclusion constraints + atomic booking RPCs provide good race safety.
- No chaos/failure-injection harness beyond `scripts/simulate.sh`.

---

## 9. Security, Privacy & Compliance (Non-HIPAA)

**Very strong** (SECURITY.md + 2026-05-21 hardening pass):

- RLS + `FORCE ROW LEVEL SECURITY` on all tenant-scoped tables.
- `tenantMiddleware` (401 on unauthenticated non-public requests; 403 on cross-tenant override under JWT).
- JWT (8h) with `password_changed_at` revocation.
- Webhook signature verification (raw body, HMAC) for Stripe + all providers.
- Agent secret with `timingSafeEqual` + `AGENT_SECRET_OLD` rotation support.
- `subscriptionGate`, class-22 input errors mapped to 400 (not 500 + error metric), 39 isolation probes run in every CI build.
- Consent / opt-out records + per-tenant SMS rate limiting.

**Gaps** (with concrete "what good looks like"):

- No explicit "right to be forgotten" flow beyond soft-delete + cascades (voice transcripts/summaries/notes remain).
  - Current soft-delete (`versionHistory.ts`, `deleted_customers_view`, restore RPC) is good for accidents but not for "erase my data".
  - Need a hard-purge path (GDPR/CCPA style) that: (a) redacts/anonymizes voice_sessions (null phone + transcript), (b) deletes or anonymizes customer notes/preferences, (c) keeps aggregate analytics if desired, (d) writes to audit.
  - UI: "Delete all my customer data" (with confirmation + export-first) in Settings or Customers.
- No automated data retention / purge policy (old calls, transcripts, recordings).
  - No worker or cron that purges `voice_sessions` + transcripts/summaries older than N days (configurable per tenant? or global 1-2 years).
  - Same for communication_history, old soft-deleted rows.
- Call audio (if ever captured upstream) has zero retention/redaction/consent workflow. (LiveKit has Egress recording capability; Telnyx can record on the trunk. Nothing in the product wires storage (S3/Supabase Storage), playback in Calls tab, or per-call consent flag.)
- **SHIPPED (voice capture)** — the AI now records verbal SMS-reminder consent → `consent_records` via the `record_sms_consent` tool + `/agent-tools/record-consent`, with TCPA disclosures in the prompt (informational reminders only, never marketing; PR #178). **Still open (legal)**: final ToS/consent wording sign-off + confirming the disclosure fires before the first confirmation SMS in production.
- **SHIPPED 2026-07-04** — account lock / session revocation now has a UI: `POST /users/me/revoke-sessions` ("log out everywhere", any role) + `POST /users/:id/revoke-sessions` (owner revokes a staff login; tenant-pinned UPDATE → cross-tenant/unknown 404 without existence leak). Both bump `password_changed_at`, which the JWT hook already treats as a revocation cut-off. "Log out of all sessions" button in `ProfileView` + per-staff owner action in `TeamAccessView`.
- CORS still permissive by default in source.
- No per-worker agent identity (single global secret).
- Local test DB uses superuser (bypasses RLS); prod trusts Supabase managed role + FORCE.

---

## 10. Analytics, Insights & Intelligence

Major recent progress (2026-06-12): `/analytics/stats`, call volume/conversion/abandonment from `voice_sessions`, outcome classification wired into shutdown, transcripts + summaries + appointment links, reminder delivery stats, "Why Callers Reached Out" panel.

**Still light**:

- **SHIPPED** — cohort (repeat-caller), CLV (`top_customers` by lifetime revenue), bookings-by-service, service-specific abandonment (`abandonment_by_service`), and first-time-fix rate (`first_time_fix`: share of distinct callers whose FIRST call ended in a booking — "resolved on first contact") via `GET /analytics/cohorts` + panels in `AnalyticsView`; optional From/To date-range filtering.
- No owner "ask anything" copilot over their own call transcripts + KB + appointments.
- Prometheus metrics (`booking_attempts_total`, `tool_calls_total`, `errors_total`, HTTP histograms, etc.) exist in `src/services/metrics.ts` but are token-gated ops-only.
- No A/B testing surface for prompts/greetings per tenant.

---

## 11. Testing & QA

**Excellent for solo project** (~1910 backend + 716 dashboard + 91 agent unit tests; ~146 Playwright E2E covering major workflows; all green on recent runs). Strong 5W comments, real-DB isolation, `SYNC_TEST_RECORDER` for sync contract, drift detectors.

- `scripts/simulate.sh` (status, tools journey that flags `[dev]` gaps, rag eval at 100%, browser call dispatch) is a standout recent addition.
- E2E covers booking races, wizard-to-first-booking, role gating, mobile, tenant delete cascade, analytics, comms history, cancel/restore, etc.

**Gaps**:

- Live PSTN voice end-to-end (the `__PERSONA_NAME__` blocker; one E2E skip is voice calls).
- Real external OAuth + Stripe + live CRM paths (orchestration only via recorder).
- RAG eval is manual/on-demand (costs money, non-deterministic).
- No property-based or sustained load tests.
- Low coverage pockets remain (reminder processor/repository, some comms adapters, certain dashboard primitives).
- Full multi-step wizard still mostly unit-tested (E2E cost is high).

---

## 12. DevOps, Deployment, CI/CD

- All three Railway services (secretary-hq backend, secretary-hq-agent, dashboard) deploy exclusively from `main` (verified via Railway GraphQL).
- Nixpacks + `railway.json`. Full portable workflow kit (`PORTABLE_DEVELOPMENT_WORKFLOW.md`, hooks, `prepare-commit.sh`, `pre-pr`, `checks`, branch creator).
- CI (`.github/workflows/ci.yml`): backend (pgvector service + forced DB tests), dashboard (typecheck + vitest), agent, e2e (Playwright). First all-green achieved recently.
- Health endpoints: shallow `/health`, deep `/ready` (pool saturation + DB ping; 503 on unreachable).
- Backend changes require explicit `npm run build` + restart (documented).

**Major gaps**:

- **SHIPPED (partial)** — GitHub branch protection on `main` gates merges (and thus Railway deploys from `main`) on the 4 CI jobs green. **Still open**: enable Railway's own "Wait for CI" toggle on the 3 services for defense-in-depth.
- Env var drift produces silent production failure modes (mocks, localhost URLs).
- No canary / blue-green / feature flags.
- Observability tokens not set → no metrics, no log aggregation, no Sentry in prod.
- **SHIPPED 2026-07-04** — automated "feature readiness" report at boot (`featureReadiness.ts` structured boot log + `GET /admin/feature-readiness`; see §1).

---

## 13. Documentation & Process

**Outstanding** self-documentation hygiene:

- `CLAUDE.md` (living spec with key directories, DB conventions, build principles, "test it or delete it").
- `docs/planning/TODO.md` (active queue with `[prod]`/`[dev]` tags, simulate harness results).
- `planning/RESOLVED.md`, `HANDOFF.md`, `SECURITY.md`, `TEST_COVERAGE.md`, `DEPLOYMENT.md`, `BETA_ONBOARDING.md`, `STRATEGY.md`, `COMPETITOR_WEAKPOINTS.md`, diagrams, session archives.
- Drift detectors (`npm run verify:claude-md`, `verify:schema`), AGENTS.md mechanical refactor rules, 5W test comments, prepare-commit.

**Gaps**: none open — previous items (owner admin guide `docs/OWNER_GUIDE.md`, incident/telephony runbook `docs/RUNBOOK.md`, stale edge-functions section removed from `docs/DEPLOYMENT.md`) all shipped; archived in `docs/planning/RESOLVED.md` (2026-07-04 entry).

---

## 14. Business / Legal / GTM / Ops

- Strong strategy (receptionist wedge first, then optional ops; cross-platform; no seat tax; attack platform-bundler weaknesses; focus non-trades verticals where incumbents don't bundle receptionists).
- No in-product support/ticketing system for customers (internal `TICKET_SUPPORT.md` only for Telnyx).
- No usage-based alerts for owners ("47 calls this week — approaching plan limits").
- Pricing tiers well-documented in strategy but not productized in the dashboard UI.
- No public marketing/landing site beyond minimal static assets + demo.
- No partner/affiliate/reseller program.
- Solo-founder concentration risk (bus factor 1).

---

## 15. Scalability, Performance & Cost

- Known limits: pool `max=10` + single agent worker per tenant. Never load-tested under realistic concurrent voice load.
- AI spend (OpenAI + former xAI + Deepgram per call) is invisible and uncapped. (Note: ai_cost_events metering has been added since this inventory was first written.)
- RAG is pure pgvector cosine + expansion; no hybrid search, reranking, or response caching.
- No CDN/edge story for dashboard or static KB.
- Reminder scheduler is simple polling.
- No read replicas or advanced connection strategies.

---

## 16. Additional "Table Stakes" or Future-Proofing Gaps

- International numbers / multi-country support (Telnyx capable; code and templates are US-centric).
- White-label / reseller dashboard theming.
- Granular RBAC beyond owner/front_desk.
- Public API surface for power users or external integrators (current endpoints are internal + agent-tools + dashboard).
- SSO/SAML (currently password + magic-link invites only).
- Rich exports — **CSV of calls, appointments, customers SHIPPED 2026-07-04** (`GET /export/*.csv`, see §6); PDF + analytics-export still open.
- Smart proactive suggestions ("your Saturdays are empty — want to promote them to callers?").
- Voice biometrics or "known caller" shortcuts.
- Post-call SMS "how did we do?" review link or NPS.
- Payments for the tenant's own customers (explicitly out of scope for now per strategy).

---

## Prioritized Action Clusters (Rough Order)

**P0 — Unblock any real customer / `__PERSONA_NAME__` go-live**

- Complete AIASSISTANT checklist (different-carrier PSTN test + Telnyx REFER enable + forward_phone set on dashboard).
- Set remaining Railway env vars (TELNYX*PHONE_NUMBER, DASHBOARD_URL, CORS_ORIGIN, STRIPE*\* vars, EMAIL_USER/PASS, BACKEND_URL on agent) — code fixes shipped, boot warns on missing.
- Set Railway observability tokens + basic alerts (`errors_total`, booking failures, pool waiting, etc.).
- Gate Railway deploys on CI green (branch protection or Railway "wait for CI").
- Stripe live verification (test keys + CLI replay + full owner checkout → webhook → status → gate).
- Legal docs (Bonterms) + TCPA language + basic insurance.

**P1 — Customer success & trust**

- Customer self-service (detailed design above). Entry points: `src/services/communications/{smsService.ts, appointmentService.ts, emailTemplates.ts}`, `src/routes/appointments.ts` (add token-gated handlers or new `selfService.ts` route), `dashboard/lib/api.ts`, new or extended components in `AppointmentDetailPanel.tsx` or a new `SelfServiceLinks.tsx`. Add `?token=` handling that bypasses normal auth for these actions only. Start with cancel link (easiest).
- Live comms providers: Telnyx is default (SMS + provisioning + SIP for LiveKit). ProviderRegistry + direct telnyxSms paths wired. Set TELNYX\_\* creds on Railway. (See `TELEPHONY_PROVIDER` for any override, though none planned.)
- Billing UI for owners (current plan, upgrade buttons, invoices). See expanded Billing section. Start with Stripe Customer Portal session creation (quick) + status display. Entry: `src/routes/billing.ts` + `dashboard/components/` (new card or Settings subsection) + api.ts extension (add `createPortalSession`).
- Richer outcome-driven automations (follow-up on "price" or "no_availability" calls). Wire `callClassify.ts` results into reminder or post-call comms paths.
- Owner-facing cost/usage meter (calls + AI spend). See Cost subsection. Instrument the 5-6 points listed; surface in Analytics or new Usage card.
- Full calendar sync live (Google/Outlook) for at least one tenant. Env vars + OAuth app setup + prove a real sync round-trip (use the existing `calendarSync.ts` + test recorder pattern).

**P2 — Quality, scale & defensibility**

- Agent latency fillers + resilience items.
- Load test booking path + define scaling knobs (pool size, worker count).
- Data export + retention/purge policy + visible audit log for owners.
- Website-scan polish + E2E + RAG gating.
- Calendar sync proven + exposed.
- Deeper analytics / owner copilot over transcripts.
- Multi-language / voice style surface if demand appears.

**P3 — Moat & expansion**

- Safe-partner CRM depth (Square or future non-bundling platforms).
- Public booking widget / embed (when strategy says it's time).
- White-label / reseller.
- Public API.

---

## How to Use This Document

1. Treat `docs/planning/TODO.md` as the living execution queue (it has the `[prod]` tags, simulate results, and concrete next steps).
2. Use this `GAPS.md` for "did we miss an entire category?" thinking before planning a phase.
3. Before any customer onboarding, walk the P0 cluster above + run `./scripts/simulate.sh status --deep && ./scripts/simulate.sh tools`.
4. After shipping something big (e.g., billing UI, self-service links), add a dated section here and move closed items to RESOLVED.md style notes.

**Ship = merge to main via PR + prod DB migration apply (if any) + Railway deploy from main + live validation with simulate + real call if voice-related.**

This file was generated from a full-repo deep dive on 2026-06-15 and expanded same-day with deeper design specs on self-service (full token + template + route sketch), billing (API surface + Stripe Portal quick win), AI cost instrumentation points, data export/retention requirements, and comms actionability. It will decay if not maintained — run the drift detectors (`npm run verify:claude-md`) after touching related code/docs and update this file (add dated "Expanded" or "Closed" notes).

**Inconsistencies spotted during expansion (low-hanging polish)**: all three (billing.checkout plan typing, in-app billing surface, `'professional'` client paths) SHIPPED — archived in `docs/planning/RESOLVED.md` (2026-07-04 entry).

---

**Next step for the reader**: Open `docs/planning/TODO.md` and `docs/AIASSISTANT_GO_LIVE_TODO.md`, pick the top unblocked item from the P0 cluster, create a feature branch, and start executing. The simulate harness will tell you immediately when a link is wired.

</details>

### Archived: docs/IMPROVEMENT_IDEAS.md (deleted 2026-07-05; open ideas → TODO.md P3/UX)

<details><summary>Full pre-deletion snapshot</summary>

# Improvement Ideas — Curated Backlog

> **Restructured 2026-05-29.** Items verified against current code; done items moved to Closed section. All remaining items reworded to be bite-size.
>
> **Where things live:**
> - Mechanical/type/naming/convention work → complete (history in `planning/RESOLVED.md`)
> - Blocking launch + UX audit pass 2 → `docs/planning/TODO.md`
> - "Would be nice someday" → this file

---

## Quick wins (< 30 min each)


---

## Small (< 1 hr each)

### Agent: speak filler before slow tool calls
**File:** `agent/src/tools.ts`
**Do:** Before `getAvailableSlots`, `bookAppointment`, and `searchKnowledgeBase` tool calls, emit a short filler utterance (e.g. `"One moment while I check that."`) to cover the up-to-8s silence window. **First verify:** check LiveKit Agents Node SDK for the correct mid-session speech API (not `say()` — look for `session.say()`, `agent.say()`, or equivalent in the LiveKit agent context object passed to tool handlers).
**Done when:** Caller hears a phrase before tool network round-trip; no dead air on slow calls.
**Why:** 8s silence sounds like a dropped call. P3(C) from production hardening backlog.
`small` | impact: `medium`

---

## Medium (1–3 hr each)

---

## Large (dedicated session each)

### ~~Finish CRM sync structure extraction~~ — CLOSED 2026-06-30 (invalid)
**No longer actionable.** Two reasons: (1) Jobber/HubSpot/ServiceTitan were **removed** 2026-06-12 as competitors (`docs/STRATEGY.md`) — only Square remains; the `jobberSync.ts`/`hubspotSync.ts`/`servicetitanSync.ts` files no longer exist. (2) The extraction itself was **DONE** (verified 2026-06-03, see `docs/planning/TODO.md` "Non-blocking / Polish") — Square's client/sync live under `src/services/crm/` over a shared layer (`tokenManagement`, `syncMapHelpers`, `crmSyncStatus`, `syncOrchestrator`). Nothing left to do.

### Schedule C1+C2: consolidate 4 sub-views → 2 + unified header
**File:** `dashboard/components/SchedulerView.tsx` (currently 4 sub-views: calendar, staff, resources, list)
**Do:** Merge list into calendar view (Day/Month toggle); merge staff + resources into one Team/Resources view. Unify the three separate sub-view headers into one consistent shell.
**Done when:** Schedule tab has 2 sub-views; single header renders across both; all scheduler E2E tests pass.
**Why:** UX audit C1+C2 — 4 sub-views with 3 different headers is fragmented for a core daily-use screen.
`large` | impact: `high`

### E1: Threaded demo mode (session flag + sample data)
**Do:** Replace the static `/demo` page with a session flag (`isDemoMode`) that injects sample data into the live dashboard. Super-admin can activate demo mode for any tenant; data is read-only and resets on flag clear.
**Done when:** `/demo` route removed; demo mode works within the real dashboard shell; no static page.
**Why:** Static demo page requires maintenance in parallel with real UI — a session-flag approach stays in sync automatically.
`large` | impact: `medium`

### P2.5: Wizard draft state Phase B
**Files:** `dashboard/components/SetupWizard/` (~5K lines across wizard infrastructure)
**Do:** Hold services/resources/employees/shifts/mappings in local state during wizard flow; commit to DB only on Step 7 "Done" click; discard on dismiss. Requires `useWizardCrud.ts` rewrite + `VocabularyProvider` accepting `overrideTemplate` for draft business_type.
**Done when:** No DB writes during wizard navigation; back/dismiss discards all state; `SetupWizard.backToPicker.test.tsx` auto-seed-rollback contract preserved.
**Why:** Phase A fixed visible re-pick bug; Phase B is the principled fix for "data should not be solid until wizard completes."
`large` | impact: `high`

### P3: Dense-view decomposition (multiple sessions)
**Targets:** `SettingsView`, `TenantEditPanel`, `AppointmentView`, `DashboardHome`, `CustomerDetailPanel`, `DeletedRecordsPanel`, `NewSchedulerView`/`SchedulerView` overlap, `ShiftManagementView`, `ServiceAssignmentView`/`SkillAssignmentsView`/`SkillMatrixView`
**Do:** Split each overloaded view into focused sub-components. Sequence with C1+C2 (scheduler consolidation) and Cluster C (Modal primitive migration) to avoid duplicated churn.
**Done when:** Each target view is split with no single file over ~300 lines; existing tests pass.
**Why:** These screens mix rendering, orchestration, and form state — each is a regression risk in a frequently-touched area.
`large` | impact: `high`

---

## Closed / Done

Items confirmed done against current code (2026-05-29):

- **parseDateRange in calendar routes** — calendar.ts has no date-range params (only OAuth code/state). Item was invalid; closed.
- **UUID_RE → requireValidUUID in mappings.ts** — done 2026-05-29. `UUID_RE` deleted; all 4 handlers use `requireValidUUID` from routeHelpers. Tests updated.
- **Batch tenant reorder** — done 2026-05-29. Single `UPDATE … FROM unnest($1::uuid[], $2::int[])` replaces per-row loop. Test updated.
- **CRM auth-init success envelope** — done 2026-05-29. All 4 CRM providers (jobber, hubspot, square, servicetitan) return `{ success: true, authUrl }`. `api.ts` types + `CRMIntegrationCard` updated. Tests updated.
- **KB alert() → toast** — `KnowledgeBaseView.tsx` already uses `showToast()` for delete failures. `alert()` count: 0.
- **Shared Tenant type** — `SuperAdminDashboard.tsx`, `TenantCard.tsx`, `TenantEditPanel.tsx` all import `TenantFull` from `dashboard/lib/types.ts`. No local duplicates.
- **Super-Admin destructive/reorder tests** — `dashboard/superadmin.test.tsx` covers reorder, duplicate-name rejection, and delete confirmation gate.
- **Date-range query parsing (analytics)** — `analytics.ts` already imports and uses `parseDateRange` from `routeHelpers`. *(Calendar routes have no date params.)*
- **Extract Shared Route Guards** — `routeHelpers.ts` already provides `sendValidationError`, `sendNotFound`, `sendSuccess`, `sendConflict`, `assertRowAffected`, `requireValidUUID`, `parseDateRange`, `parsePagination`. Used across route modules.
- **All mechanical-refactor backlog items** (former `REFACTORING_TODO.md`) — fully closed 2026-05-27; history in `planning/RESOLVED.md`.

Items completed 2026-05-29 (this session):

- **Add skill route tests (delete + not-found)** — `src/routes/skills.test.ts` (7 tests): GET list, POST create happy+2 sad, DELETE success, DELETE 404, DELETE 401. Commit `2471d58`.
- **Move appointment calendar config to a shared module** — `dashboard/lib/appointments/calendarConfig.ts` exports `localizer`, `CalendarEvent`, `ZOOM_LEVELS`, `CALENDAR_TIMESLOTS`, `CALENDAR_MIN/MAX/SCROLL_TO`, `toCalendarEvent()`. `AppointmentView.tsx` imports from there. Commit `178f7c3`.
- **Persist KB tab + search to URL query params** — `KnowledgeBaseView.tsx` reads `?tab=` and `?q=` on mount; tab/search changes update URL via `replaceState`; `popstate` listener syncs back/forward. Commit `8122ae1`.
- **Normalize skill/service names via `shared/name.ts`** — `skills.ts` imports `slugify` from `shared/name`; inline `toLowerCase().trim().replace(/\s+/g, '-')` removed. Commit `0e19b58`.
- **Analytics feedback access tests** — `src/analytics.test.ts`: 4 new tests covering `GET /call-summaries` missing param → 400, tenant-scoped query, `GET /feedback` normal tenant scoped, super-admin cross-tenant. Commit `cda0e05`.
- **Billing + provisioning unhappy-path tests** — `src/routes/billing.test.ts` (4 tests), `src/routes/provisioning.test.ts` (7 tests). Activate 503/400/409×2, deactivate partial-cleanup warning → 200+warnings, status happy+404, billing 503+404. Commit `b7b6aaf`.
- **CRM disconnect + sync-status parity tests** — already covered by existing `jobber-routes.test.ts`, `hubspot-routes.test.ts`, `square-routes.test.ts` (verified 2026-05-29).
- **Mapping-route tests (idempotency + tenant scoping)** — already covered in `src/routes/mappings.test.ts` (verified 2026-05-29).
- **Appointment mock-mode + super-admin routing tests** — `dashboard/appointment.test.tsx` extended with 2 super-admin routing tests: create routes to customer's `tenant_id`, guard blocks create with no customer. Commit `84e58d8`.
- **Extract provisioning state machine into a service** — `src/services/provisioningService.ts` (`activatePhone` + `deactivatePhone`); route thinned to validation + switch(result.status); all 5 log events preserved via result union fields. Service tests (6). Commit `3aefcb7`.
- **CRM route scaffold unification** — `src/routes/crmRouteScaffold.ts` handles 6 shared endpoints; all 4 provider files (jobber/hubspot/square/servicetitan) reduced to scaffold call + webhook. Commit `85a8524`.
- **Extract Super-Admin state into `useSuperAdminTenants` hook** — `dashboard/lib/useSuperAdminTenants.ts`; `SuperAdminDashboard.tsx` 490→210 lines. Commit `4f77a64`.
- **Extract knowledge document ingestion into a service** — `src/services/knowledgeIngestion.ts` (extractFileContent, splitIntoChunks, prepareQADocument, validators); `knowledge.ts` route uses service. Service tests (10). Commit `125d6a4`.
- **VoiceCallsView: extract row subcomponents** — `<ActiveCallRow>`, `<HistoryCallRow>`, `<OutcomeBadge>` extracted; inline row JSX removed; OutcomeBadge also used in right-panel detail view. Commit `6d63653`.

## Self-Review — 2026-05-28
**Cycles since last self-review:** 0
**What's working:** The UX backlog is finally back to zero, and the current process correctly treated root `improvement-ideas.md` as retired while continuing to use the canonical root `ux-review-notes.md` for component coverage. The rebuilt UX notes also stayed useful by clustering related views instead of spraying random one-file entries.
**What I changed in HEARTBEAT.md:** No changes needed
**Why:** The current instructions were enough to handle the tricky parts, canonical-file resets, full-path matching, and append-only behavior. The only important live adjustment was following the repo’s own archival note that moved idea work to `docs/IMPROVEMENT_IDEAS.md`.

## Ideas — 2026-05-30 (code patterns)

### Task: Extract reusable URL query state hook for dashboard shallow state
**Status:** ✅ DONE 2026-07-02 (PR #167) — `dashboard/lib/useUrlQueryState.ts` (TDD, 8 cases); KnowledgeBaseView (tab+q) and SkillAssignmentsView (view) migrated off their own useSearchParams/replaceState/popstate wiring.
**Files to change:** `dashboard/components/KnowledgeBaseView.tsx:L396-L437`, `dashboard/components/SkillAssignmentsView.tsx:L31-L51`, `dashboard/lib/useUrlQueryState.ts` (new), `dashboard/components/SkillAssignmentsView.test.tsx:L1-L106`
**What to do:** Add a small client-side hook that owns four things currently being hand-written in view components: reading an initial query-param value, validating it against an allowed set, writing updates with `window.history.replaceState`, and reacting to browser `popstate`. Move the `tab` and `q` handling in `KnowledgeBaseView` and the `view` handling in `SkillAssignmentsView` onto that hook instead of each component building its own `URLSearchParams` logic. Keep the hook shallow, string-based, and intentionally limited to URL state, not API state.
**Done when:**
- [ ] `KnowledgeBaseView` no longer contains its own `useSearchParams` + `replaceState` + `popstate` wiring for `tab` and `q`
- [ ] `SkillAssignmentsView` uses the same hook for `view` and still keeps `grid` as the default canonical URL state
- [ ] `SkillAssignmentsView.test.tsx` still passes, and new or updated assertions cover back/forward synchronization through the shared hook
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** This removes duplicated browser-state plumbing from two screens, makes future deep-linkable tabs cheaper to build, and centralizes the tricky `popstate` behavior in one place.
**Tradeoff:** Small abstraction cost up front, plus a little care needed to keep the hook generic without becoming a mini-router.
**Size:** medium (1-3hr)
**Impact:** medium
**Effort vs Gain:** About 1-2 hours of straightforward extraction buys back repeated, easy-to-get-wrong URL state code across multiple dashboard shells, so the return is solid.

### Task: Add popstate-safe view persistence to SkillAssignmentsView
**Status:** ✅ DONE 2026-07-02 (PR #167) — `view` now driven by the shared hook (not a one-time initialView snapshot); browser back/forward re-syncs the Grid/Map view. New popstate test proves the flip.
**Files to change:** `dashboard/components/SkillAssignmentsView.tsx:L31-L83`, `dashboard/components/SkillAssignmentsView.test.tsx:L1-L106`
**What to do:** Keep the existing `?view=map` deep-link behavior, but make the rendered view stay in sync when navigation changes happen outside the click handler, especially browser back/forward and parent-shell URL rewrites. The simplest path is to drive `view` from the extracted query-state helper instead of a one-time `initialView` snapshot from `useSearchParams()`. Extend the component test file with a case that starts on `?view=map`, rewrites the URL back to grid, dispatches `popstate`, and verifies the rendered marker flips back to Grid.
**Done when:**
- [ ] `SkillAssignmentsView` no longer relies on a one-time `initialView` read for long-lived state
- [ ] A test proves browser back/forward style URL changes update the rendered Grid/Map view
- [ ] Existing toggle and `aria-pressed` tests still pass
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** Right now the toggle is deep-linkable but not fully navigation-safe, which is exactly the sort of subtle shell bug that is annoying to debug later.
**Tradeoff:** Slightly more state wiring and one more test branch for a bug that only shows up during navigation edge cases.
**Size:** small (< 1hr)
**Impact:** medium
**Effort vs Gain:** Under an hour of focused cleanup closes a real navigation edge case in a high-traffic admin view, which is a good trade.

### Task: Persist AIInsights sub-tab selection with the shared URL-state helper
**Status:** ✅ DONE 2026-07-02 (PR #167) — sub-tab mirrored to a scoped `?aiTab=persona|knowledge` via the shared hook; new `AIInsightsView.test.tsx` covers default/deep-link/click/popstate. (The spec's `analytics` sub-tab no longer exists; mirrored the real 2 tabs.)
**Files to change:** `dashboard/components/AIInsightsView.tsx:L1-L53`, `dashboard/lib/useUrlQueryState.ts` (new), `dashboard/components/AIInsightsView.test.tsx` (new)
**What to do:** Mirror the active `AIInsightsView` sub-tab to a query param such as `?aiTab=persona|knowledge|analytics`, using the same shared hook instead of local `useState` only. Initialize from the URL, preserve the existing default of `persona`, and add a focused component test file that verifies default render, deep-link render, click-to-update URL behavior, and back/forward synchronization. Keep the param scoped so it does not collide with existing `tab`, `subtab`, or `view` usage elsewhere in the dashboard.
**Done when:**
- [ ] Reloading or revisiting the page preserves the selected AI Persona / Knowledge Base / Analytics sub-tab
- [ ] `AIInsightsView` uses validated URL-backed state rather than local-only tab state
- [ ] A new test file covers default, deep-link, click update, and `popstate` sync behavior
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** This brings one more tabbed shell into line with the dashboard’s growing deep-link conventions and makes debugging or sharing exact Phone Assistant states much easier.
**Tradeoff:** Adds one more query param convention to maintain, so naming and validation need to stay disciplined.
**Size:** small (< 1hr)
**Impact:** medium
**Effort vs Gain:** This is a small polish task with moderate day-to-day value, especially once the shared hook exists, so it is worth doing after the extraction.

## Self-Review — 2026-05-30
**Cycles since last self-review:** 1
**What's working:** The UX pass now has full component coverage, and the improvement review was strongest when it stayed narrow, read a small file cluster deeply, and proposed bounded follow-up instead of broad “refactor this” advice.
**What I changed in HEARTBEAT.md:** Added one line telling future runs not to append a status-only UX note once full coverage is complete and no new component files were found.
**Why:** That avoids burning cycles and cluttering `ux-review-notes.md` with empty confirmation entries now that the component backlog is exhausted.

## Ideas — 2026-05-31 (developer experience)

### Task: Extend useFocusTrap to handle outside-dismiss overlays and migrate StaffProfileCard onto it
**Status:** ✅ DONE 2026-07-02 (PR #168) — added opt-in `onOutsideDismiss` (5th positional param, existing callers unaffected); StaffProfileCard dropped its ~55-line hand-rolled effect. Existing keyboard tests pass + 2 new outside-mousedown tests.
**Files to change:** `dashboard/lib/useFocusTrap.ts:L1-L79`, `dashboard/components/scheduler/StaffProfileCard.tsx:L1-L106`, `dashboard/components/scheduler/StaffProfileCard.test.tsx:L49-L86`, `dashboard/components/scheduler/scheduler.test.tsx:L694-L729`
**What to do:** Expand `useFocusTrap` so callers can opt into outside-click dismissal in addition to Escape, Tab trapping, focus restore, and optional scroll locking. Then delete the custom `mousedown`/`keydown`/focus-restore effect from `StaffProfileCard` and replace it with the shared hook. Keep the hook small: accept an optional `onInteractOutside` callback or boolean flag, register the outside listener only while open, and preserve the current “do not steal focus if autofocus already landed inside” behavior.
**Done when:**
- [ ] `StaffProfileCard` no longer owns its own focus trap, Escape handler, outside-click wiring, or previous-focus restore effect
- [ ] `useFocusTrap` supports the outside-dismiss case without regressing existing modal/panel callers
- [ ] Existing `StaffProfileCard` keyboard tests still pass, and a test proves outside click still closes the card through the shared hook
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** Overlay accessibility behavior is currently split between one shared hook and one hand-rolled implementation. Pulling the card back onto the common primitive reduces subtle drift and makes future overlay fixes land in one place.
**Tradeoff:** Slightly broadens the hook API, so the abstraction needs discipline to stay overlay-focused instead of growing into a generic event manager.
**Size:** medium (1-3hr)
**Impact:** medium
**Effort vs Gain:** Roughly 1-2 hours of careful consolidation removes duplicate accessibility plumbing in a high-interaction area, which is a healthy return.

### Task: Extract a shared SchedulerSidePanel shell for right-edge scheduler drawers
**Status:** ✅ DONE 2026-07-02 — `dashboard/components/scheduler/SchedulerSidePanel.tsx` owns the fixed drawer container + slide-in + header chrome + scrolling body + optional sticky footer. QuickBookPanel (footer CTA) + EmployeeDayFocusPanel (role=dialog + focus-trap ref) both adopt it via props so each keeps its exact behavior. scheduler suite 145/145; dashboard 816/816.
**Files to change:** `dashboard/components/scheduler/QuickBookPanel.tsx:L246-L357`, `dashboard/components/scheduler/EmployeeDayFocusPanel.tsx:L55-L168`, `dashboard/components/scheduler/SchedulerSidePanel.tsx` (new), `dashboard/components/scheduler/scheduler.test.tsx:L694-L862`, `dashboard/components/scheduler/QuickBookPanel.test.tsx:L65-L183`
**What to do:** Create a narrow presentational shell for the repeated right-edge scheduler drawer pattern: fixed right positioning, width, border, slide-in animation, header row with title/icon/close action, scrollable body, and optional sticky footer. Move `QuickBookPanel` and `EmployeeDayFocusPanel` onto that shell while leaving their business logic, data shaping, and inner content in place. Pass the panel title, icon, close label, main content, and optional footer as props so both drawers keep their current behavior without carrying duplicated layout chrome.
**Done when:**
- [ ] `QuickBookPanel` and `EmployeeDayFocusPanel` no longer duplicate the outer fixed drawer container and header chrome
- [ ] The new shell supports an optional footer so Quick Book keeps its sticky CTA while Employee Focus remains body-only
- [ ] Existing panel tests still pass with selectors updated only where the shared shell intentionally changes markup
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** These two scheduler drawers already share a lot of shell behavior, and the next overlay tweak will otherwise need to be made twice. A small shell reduces copy-paste churn without forcing the inner flows into the same component.
**Tradeoff:** Adds one more component boundary, and if the shell becomes too opinionated it could fight legitimate differences between quick-book and focus-review workflows.
**Size:** medium (1-3hr)
**Impact:** medium
**Effort vs Gain:** About 1-2 hours of extraction should pay back quickly because scheduler overlay polish currently has to be duplicated by hand.

### Task: Move StaffProfileCard action controls onto shared button primitives and tokens
**Status:** ✅ DONE 2026-07-02 — the close control (→ `<Button variant="ghost" size="sm">`) and the Mark-off action (→ `<Button variant="warning">`) now render through the shared Button primitive instead of raw `<button>` + hand-rolled classes/inline styles. Mark-off keeps its exact disabled + "Marking off…" progress behavior (uses `disabled`, not `isLoading`, so no new spinner). Existing keyboard/aria/disabled tests still pass (11/11); dashboard 816/816.
**Files to change:** `dashboard/components/scheduler/StaffProfileCard.tsx:L131-L257`, `dashboard/components/ui/Button.tsx`, `dashboard/components/scheduler/StaffProfileCard.test.tsx:L88-L141`
**What to do:** Replace the card’s custom close button and custom “Mark off” action button with the shared `Button` primitive, adding a small variant or size only if the current primitive truly cannot express the compact icon-close and warning-tinted full-width action. Keep the card’s current copy and behavior, but stop hand-authoring hover, disabled, and font styles inline. If the primitive needs one scheduler-safe warning style, add it centrally instead of leaving this card as a one-off.
**Done when:**
- [ ] The close control and Mark off action in `StaffProfileCard` render through shared button primitives instead of raw `<button>` styling
- [ ] Disabled/loading behavior for the Mark off action still matches current behavior
- [ ] Existing StaffProfileCard tests still pass, with any new assertions covering the primitive-backed disabled and accessible-label behavior
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** This keeps a frequently used scheduler popover aligned with the dashboard’s shared interaction system and cuts one more pocket of bespoke styling that will drift over time.
**Tradeoff:** If `Button` needs a new variant, that adds a little design-surface maintenance to avoid turning the primitive into a catch-all.
**Size:** small (< 1hr)
**Impact:** low
**Effort vs Gain:** Less than an hour of tidy-up removes a bespoke control pair in a high-traffic surface, so the gain is modest but clean.

## Self-Review — 2026-05-31
**Cycles since last self-review:** 0
**What's working:** The UX pass now stays cheap because full coverage can be confirmed with a quick path-count diff, and the improvement pass still produces better output when it sticks to one tight file cluster instead of sampling the whole repo.
**What I changed in HEARTBEAT.md:** No changes needed
**Why:** The current heartbeat instructions already handled the finished UX backlog correctly and still left enough freedom to pivot into a fresh code slice for improvement review.

## Ideas — 2026-06-01 (architecture)

### Task: Split version history routes into focused registrars and shared helpers
**Status:** ✅ DONE 2026-07-02 (PR #169) — shared helpers/config/schemas extracted to `src/routes/versionHistoryHelpers.ts` (versionHistory.ts 858→721 lines); 89/89 unit+realdb tests unchanged. Deliberately kept routes in one registrar (the helper duplication was the real payload; a multi-registrar split adds churn with no behavior gain).
**Files to change:** `src/routes/versionHistory.ts:L18-L187`, `src/routes/versionHistory.ts:L198-L520`, `src/routes/versionHistory.ts:L527-L850`, `src/routes/versionHistory/validators.ts` (new), `src/routes/versionHistory/historyRoutes.ts` (new), `src/routes/versionHistory/recoveryRoutes.ts` (new), `src/versionHistory.test.ts:L1-L1188`
**What to do:** Keep `registerVersionHistoryRoutes()` as the public entrypoint, but move the current inline helpers and route blocks into smaller modules grouped by concern. Put shared table validation, body validation, error-response creation, and table metadata in `validators.ts`. Move history, compare, and restore-preview reads into `historyRoutes.ts`. Move restore-fields, restore deleted, copy-fields, and deleted-record listing into `recoveryRoutes.ts`. Have the top-level file compose those registrars so route URLs and behavior stay unchanged. Update `src/versionHistory.test.ts` only as needed to keep imports and route registration pointed at the same public function.
**Done when:**
- [ ] `src/routes/versionHistory.ts` becomes a thin composition file instead of owning every helper and route body inline
- [ ] Shared validation and error-shape code lives in one helper module, not repeated inside route closures
- [ ] Route URLs, payloads, and response shapes remain unchanged
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** The current 850-line route file mixes validation, SQL shaping, recovery logic, and read-only history logic in one place, which makes future fixes risky and keeps the file stuck in any-heavy territory.
**Tradeoff:** This is mostly structural work, so the payoff is maintainability rather than visible user-facing change, and careless extraction could create import churn if the boundaries are not kept simple.
**Size:** medium (1-3hr)
**Impact:** medium
**Effort vs Gain:** A couple hours of careful extraction should pay back quickly because this is a dense route cluster with a lot of behavior packed into one file.

### Task: Centralize version-history system-field exclusion by table-aware primary key
**Status:** ✅ DONE 2026-07-02 — `shared/versionHistoryFields.ts` (`excludedSystemFields(table)` — common audit cols + the table's real PK) now backs the backend restore-preview builder + DeletedRecordsPanel + RecordHistoryModal (killed 3 duplicate `id`-only lists). Also folded the canonical `VERSIONED_TABLES`/`PK_COLUMN_BY_TABLE` here (versionHistoryHelpers re-exports). Realdb test asserts restore-preview no longer emits the table PK; 5 shared-helper unit tests.
**Files to change:** `src/routes/versionHistory.ts:L66-L76`, `src/routes/versionHistory.ts:L795-L816`, `dashboard/components/DeletedRecordsPanel.tsx:L166-L174`, `dashboard/components/RecordHistoryModal.tsx:L428-L440`, `shared/versionHistoryFields.ts` (new), `src/versionHistory.test.ts:L330-L356`
**What to do:** Create one shared helper that returns the non-restorable, non-display system fields for each versioned table, including the real table-specific primary key (`customer_id`, `appointment_id`, `employee_id`, etc.), tenant metadata, and soft-delete audit fields. Use that helper in the backend restore-preview builder and in both dashboard recovery surfaces instead of maintaining three separate exclusion lists that only know about a bare `id` column. Add or update a route test proving restore-preview does not emit the table PK as a selectable field.
**Done when:**
- [ ] Restore preview excludes the table-specific primary key, not just a generic `id`
- [ ] DeletedRecordsPanel and RecordHistoryModal use the same exclusion source instead of local hard-coded arrays
- [ ] No recovery UI shows internal PK or audit-only fields as copy/restore choices
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** Right now the recovery stack duplicates exclusion logic and is out of sync with the project’s renamed PK convention, which makes internal fields more likely to leak into restore or copy workflows.
**Tradeoff:** Shared cross-runtime constants add one more module to keep clean, and the helper needs to stay narrowly scoped so it does not turn into a dumping ground for unrelated field rules.
**Size:** small (< 1hr)
**Impact:** high
**Effort vs Gain:** Under an hour of focused cleanup closes a real correctness gap in a recovery flow, so the return is strong.

### Task: Add a batch restore payload so mixed-version field restores use one request
**Status:** ✅ DONE 2026-07-02 — `RestoreFieldsSchema` now accepts either the legacy `{ source_version, fields }` OR a batch `{ restores: [{ source_version, fields }] }`. The restore-fields route runs every group inside ONE `BEGIN…COMMIT` transaction (ROLLBACK on any failed group — no partial restore); audit metadata applies to all groups. RecordHistoryModal sends one grouped request instead of N sequential ones. Real-DB tests: multi-version batch restore + partial-failure rollback (row unchanged). Mocked route tests updated for the BEGIN/COMMIT sequence. Backend 2178/2178.
**Files to change:** `dashboard/components/RecordHistoryModal.tsx:L211-L257`, `dashboard/lib/api.ts:L1043-L1059`, `src/routes/versionHistory.ts:L342-L420`, `src/versionHistory.test.ts:L180-L205`
**What to do:** Replace the modal’s per-version restore loop with a single batch payload that can carry multiple `{ source_version, fields[] }` groups in one submit. Extend the restore-fields route schema to accept either the current single-group shape or a new `restores` array, then execute the grouped restores inside one request-scoped transaction while preserving the existing audit metadata. Update the dashboard API client to send the grouped payload and keep the success response shape stable so the modal can still reload history and close cleanly after one submit.
**Done when:**
- [ ] RecordHistoryModal no longer loops over grouped versions and fires multiple sequential restore requests for one user action
- [ ] The backend accepts and processes a multi-group restore payload in one request
- [ ] Audit metadata (`restored_by`, `change_source`) still applies to every grouped restore
- [ ] All existing tests pass, new tests cover the change
**Why it matters:** The current modal turns one restore action into several network round trips, which is slower, harder to reason about on partial failure, and more likely to leave the UI mid-operation if one request fails after earlier ones succeeded.
**Tradeoff:** The route schema and handler become a little more complex because they need to support grouped work, and test coverage has to be explicit about partial-failure behavior.
**Size:** medium (1-3hr)
**Impact:** medium
**Effort vs Gain:** About 1-2 hours of API tightening removes avoidable multi-request restore behavior in a sensitive recovery flow, which is a solid payoff.

## Self-Review — 2026-06-01
**Cycles since last self-review:** 0
**What's working:** The heartbeat process handled a fully complete UX backlog correctly, and the latest improvement ideas stay strongest when they zoom into one subsystem and name exact line ranges instead of proposing broad “clean up version history” work.
**What I changed in HEARTBEAT.md:** No changes needed
**Why:** The current instructions already prevented wasted UX-note churn after full coverage and still pushed this cycle toward concrete, non-duplicate architecture work.

</details>

### Archived: docs/IMPROVEMENTS_TODO.md (deleted 2026-07-05; inbox drained, 1 open = Wizard Phase B → TODO.md UX)

<details><summary>Full pre-deletion snapshot</summary>

# Improvements TODO

Proposals generated by the `/continuously-improve` background loop.
**Review and approval required before implementing anything here.**

Status lifecycle: `proposed` → `approved` / `rejected` → `done`

This file is append-only by the loop. Humans update Status fields.

> **Status 2026-06-30:** inbox effectively drained — 3 of the 4 proposals below are `done`. The one remaining open item ("Wizard pre-fill from business template", approved) is the **SetupWizard draft-state Phase B** work tracked canonically in `docs/planning/TODO.md` (UX backlog → "Wizard Phase B") and `docs/IMPROVEMENT_IDEAS.md`. Nothing new from the loop since 2026-06-03.

Cross-references: [docs/planning/TODO.md](TODO.md) | archived `docs/IMPROVEMENT_IDEAS.md` section below

---

### [2026-06-02] process — Wizard pre-fill from business template

**Target:** `dashboard/` onboarding wizard + `src/templates/`
**Category:** process
**Priority:** high
**Effort:** M (30min–2hr)
**Status:** approved

**Proposal:**
When a new tenant selects a business type during onboarding (e.g., "Hair Salon"), the wizard should pre-populate every form field with values from the matching YAML template (`salon_v1`, `automotive_v1`, etc.). The user reviews, tweaks their specific details (name, hours, address), and confirms — one tab-through instead of a blank form. Currently templates apply data to the DB after the wizard but fields are blank during entry.

**Rationale:**
Templates exist but the UX doesn't realize their value — users still type everything from scratch. Pre-fill turns a 20-minute setup into a 2-minute review. Bella's Hair Studio in the seed serves as the reference dataset for building and testing this flow.

**Implementation note (2026-06-02, approved):** real effort is L, not M. This IS the SetupWizard draft-state rework already scoped in [docs/planning/TODO.md](TODO.md) → "`SetupWizard` + `SoloWizard` draft state" (Phase B): hold services/resources/employees/shifts/mappings in local state, pre-fill from the matching YAML template, commit to DB only on the Step 7 Done click, discard on dismiss. Touches `useWizardCrud.ts` + every `Step*.tsx` + ~5 test files (~5K lines); needs `VocabularyProvider` to accept an `overrideTemplate`. **Open on a fresh branch in a dedicated session.** Preserve the auto-seed-rollback contract in `dashboard/components/SetupWizard/SetupWizard.backToPicker.test.tsx`.

---

### [2026-06-03] skill — commit-code embeds Pixel Agents project specifics

**Target:** `skill: commit-code` (SKILL.md Step 4, lines ~84–86)
**Category:** skill
**Priority:** medium
**Effort:** S (<30min)
**Status:** done 2026-06-03

**Proposal:**
Step 4 of the global `commit-code` skill hardcodes test commands for a different project: "For the Pixel Agents project specifically: `npm run test:daemon` / `npm run test:webview` … `npm run e2e`". This repo has none of those scripts (its tests are `npm test` → vitest, `cd dashboard && npm test`, Playwright e2e). Baking one project's commands into a global skill misleads every other repo. Replace the Pixel-Agents block with project-agnostic guidance (detect the runner from package.json, run the fast suite, gate E2E on whether changes touch the relevant surface) — or move the project-specific note into that project's local memory/CLAUDE.md. Done = no project name appears in the global skill's Step 4.

**Resolution (2026-06-03):** Approved by Dale + fixed. Genericized the leak in BOTH global skills (the same audit found `start-feature` had it too):
- `commit-code` SKILL.md Step 4: dropped the "For the Pixel Agents project specifically" block; kept the already-generic "detect runner / gate E2E on touched surface" guidance.
- `start-feature` SKILL.md: 5 sites genericized — intro line, "Pixel Agents Feature Lifecycle" heading, baseline gates (`npm run check-types`/`daemon`/`webview` → generic typecheck/lint/build/test), dev-loop test commands, closing "proper way for Pixel Agents" line.
- Verified: `grep -niE "pixel agents|test:daemon|test:webview|check-types"` across both skills → 0 hits.
- Note: global skills live in `~/.claude/skills/` (outside this repo), so the edits are not in this commit — only this status update is.

---

### [2026-06-03] skill — continuously-improve: `fully_analyzed` skip is unwired (no state field backs it)

**Target:** `skill: continuously-improve` (SKILL.md — skills-phase "Skip a skill if" + State file schema)
**Category:** skill
**Priority:** medium
**Effort:** S (<30min)
**Status:** done 2026-06-03 (option B)

**Resolution (2026-06-03):** Fixed via option B — removed the dead "Skip a skill if `fully_analyzed`…" paragraph from the skills phase. It referenced state fields the schema never defined and no step ever wrote, so the optimization could never fire; deleting it removes the contradiction with zero added state complexity (per "delete the dormant abstraction"). Skill lives in `~/.claude/skills/`; only this status update is committed.

**Proposal:**
The skills-phase says "Skip a skill if its path in state has `fully_analyzed: true` AND its file mtime hasn't changed since that flag was set" and "Mark `fully_analyzed` only after 2 passes with no findings" — but the documented `.improve/state.json` schema has no per-skill structure, no `fully_analyzed` field, and no mtime store, and no step ever writes them. So the optimization can never fire: a skill that's been analyzed twice with zero findings gets re-analyzed forever, wasting one of the 3 capped analyses per session. Fix by adding a defined state sub-object (e.g. `"skill_state": { "<name>": { "fully_analyzed": true, "mtime": "<iso>", "clean_passes": 1 } }`) to the schema + a Step-5 instruction to write it, OR drop the skip-optimization paragraph entirely if it's not worth the state complexity. Done = the skip rule references a field the schema actually defines and a step actually writes.

---

### [2026-06-03] skill — create-tests: Step 6 mislabels the Vitest shuffle flag

**Target:** `skill: create-tests` (SKILL.md Step 6 — Verify independence, line ~114)
**Category:** skill
**Priority:** low
**Effort:** S (<30min)
**Status:** done 2026-06-03

**Proposal:**
Step 6 says "Vitest/Jest: `--shuffle` (Vitest) or `--randomize` equivalent" — but `--shuffle` is Jest's flag (Jest 28+); Vitest has no bare `--shuffle` and randomizes via `--sequence.shuffle` (CLI) / `sequence.shuffle` (config). `npx vitest run --shuffle` errors out. Since Vitest is this repo's primary runner (backend + dashboard), the independence-verification step is broken on the main path — the reader falls back to the "run each file alone" alternative, but the documented command is simply wrong. Fix: relabel to `Vitest: --sequence.shuffle · Jest: --shuffle`. Done = each runner is paired with its real flag.

**Resolution (2026-06-03):** Fixed in the global skill — line now reads
`Vitest: --sequence.shuffle · Jest: --shuffle`. (Skill lives in `~/.claude/skills/`,
outside this repo; only this status update is committed.)

---

</details>

---

## 2026-07-05 — Doc-hygiene: trimmed cold session logs from CLAUDE.md

Moved here from the CLAUDE.md "Project Status" section (kept lean per the docs principle; the durable current-state stays in CLAUDE.md, and the #68/#69 legal-hold guardrail was preserved there as a one-liner):

**Shipped + merged to main + DEPLOYED to prod 2026-06-22, PRs #56/#57/#58/#59** (verified live via `./scripts/simulate.sh status --env prod --deep` = 4/4 + new routes return 401 not 404 on prod): idempotent-read retry coverage in `toolsClient`; tenant-data export `GET /export/tenant-data`; per-tenant website-scan rate-limit; incident + telephony runbook (`docs/RUNBOOK.md`); owner audit-log API `GET /audit-log`; "explain this answer" RAG-debugger `POST /knowledge/explain`; owner admin guide (`docs/OWNER_GUIDE.md`); dashboard surfaces for audit-log + answer-debugger (Setup sub-tabs) + a "Download my data" export button; caller-facing source citations in `policy-answer`; website-scan happy-path + wizard browser-click E2E (stub-gated). No prod DB migration needed (all read existing schema).

**Also shipped + merged 2026-06-22, PRs #64/#65/#66/#67:** abandonment-by-service analytics (migration `20260622010000` adds `voice_sessions.requested_service_id`; `book-with-scheduling` best-effort captures the requested service on success OR failure; `/analytics/cohorts` returns `abandonment_by_service`); optional From/To date-range filtering on `/analytics/calls` + `/analytics/cohorts` (`optionalDateBounds` — all-time when absent, calendar-invalid dates rejected via `isValidDateOnly`, end day-inclusive; From/To controls on `AnalyticsView`); `@typescript-eslint/unbound-method` promoted `warn → error` in all 3 eslint configs (0 violations). **Prod migrations DONE 2026-06-23:** `20260622000000` (audit-extend) + `20260622010000` (requested_service_id) applied + verified on prod (`requested_service_id` column + `trg_audit_services`/`trg_audit_employees` triggers present; `schema_migrations` at `20260622010000`).

---

## 2026-07-05/06 — Wizard Phase B: draft-commit SetupWizard + phone go-live UX layer (reversed from "held")

TODO.md had carried a 2026-07-05 entry marking this **held, recommend not building** (rewrite risk vs. no customer ask). It was reversed same-session after a fresh design pass and fully shipped — all PRs merged only after green CI (4/4) + Copilot review threads resolved. No prod DB migration needed for any of the three PRs.

- **PR B** (#205, backend): `POST /setup/commit` — shares `src/services/setupGraph.ts` with the already-shipped `POST /coverage/dry-run` (PR #203). Full column set insert (fixed a lossy-insert bug design review caught), soft-delete-aware idempotency guard (409 on re-commit), per-tenant advisory lock closing a TOCTOU double-insert race.
- **PR C** (#206, frontend): `useWizardCrud.ts`/`index.tsx` rewritten so services/resources/employees/shifts/mappings live in local draft state — nothing writes to the DB until the whole graph commits in one call on the transition **into step 9** (not the final Done click — closes a real bug where an abandoned wizard could activate a live phone number backed by nothing). Cascade-delete on removing any entity. Deleted `docs/HANDOFF.md`-era per-entity CRUD entirely.
- **PR D** (#207, phone UX): `dashboard/components/phone/GoLivePanel.tsx` — new 3-stage flow (provision → verify via a real `/voice/history` poll → fork: new-number/forwarding-with-proof/porting-notify-email). Mounted in both `Step7GoLive.tsx` and `AIConfigView.tsx` (replaced the old raw "Forwarded-From Number" input there). `deactivatePhone()` now warns before releasing a DID still used for forwarding.
- **PR E** (#208, E2E coverage): added `PROVISIONING_E2E_STUB=1` (mirrors `KNOWLEDGE_IMPORT_E2E_STUB`) so CI can exercise the real `activatePhone()` state machine with zero Telnyx creds, plus `e2e/wizard-golive-commit.spec.ts` (real wizard UI → real `/setup/commit` → real DB assertion) and `e2e/golive-panel-stages.spec.ts` (Stage B/C driven by real `voice_sessions` inserts + polling). **Found a real production bug this way:** `Api.setup.commit`/`Api.coverage.dryRun` never sent `tenant_id` in the body (unlike every other `Api.*` method) — a super-admin impersonating a managed tenant would silently commit the wizard into their OWN platform tenant instead. Only a real E2E run against a real backend surfaced it; unit tests mock tenant resolution away. Fixed in `dashboard/lib/api.ts`.

Full design: `docs/superpowers/specs/2026-07-05-wizard-phase-b-design.md` — two judge-panel syntheses (entity-graph architecture, then phone go-live strategy) + Dale's 5 locked decisions.

**Open items explicitly deferred** (design doc §5, not bugs — tracked as a follow-up in TODO.md): abandoned-test-number reaper; auto forwarding-verification heuristic (SIP caller-ID match instead of asking the owner); real Telnyx porting API integration (deferred until a real port customer per YAGNI).

**Lessons:** stale-closure bugs in `useCallback`/plain-function React patterns when the closed-over value (a fresh-every-render hook result) isn't in the dep array, caught via tests not review; E2E fixtures that pre-seed state via direct API calls silently break when the UI stops reading that channel; `example_services` is empty for every real `business_templates` row in seed data — don't assume auto-seed produces test data; Copilot review caught 2-3 genuinely real bugs per PR; unit tests mock away tenant resolution so a missing-`tenant_id` scoping bug is invisible to them by construction — always check a new mutating `Api.*` method sends `tenant_id` explicitly like its siblings; stale `next start`/`node dist` zombie processes served old builds after a rebuild, producing misleading "bug" symptoms twice.
