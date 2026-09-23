#!/usr/bin/env bash
set -euo pipefail

# create-roadmap-issues.sh
# Creates trackable GitHub Issues for PASS 1 of docs/PRODUCT_ROADMAP.md.
#
# Usage:
#   GH_TOKEN=ghp_xxx ./scripts/create-roadmap-issues.sh
#   (or run `gh auth login` first and it will reuse the gh CLI token)
#
# Idempotency: this script does NOT check for existing issues. Run it once.
# Labels are created idempotently — an existing label (HTTP 422) is ignored,
# but any other HTTP failure (bad token, wrong repo, API outage) fails fast.

REPO="ddemott/secretary-hq"
API="https://api.github.com/repos/${REPO}"

# Fail fast if required tooling is missing (with `set -e`, a missing dep would
# otherwise abort mid-run after some issues/labels were already created).
for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "ERROR: required dependency '$dep' not found on PATH." >&2
    exit 1
  fi
done

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  if command -v gh >/dev/null 2>&1; then
    TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
fi
if [ -z "$TOKEN" ]; then
  echo "ERROR: No token. Set GH_TOKEN=... or run 'gh auth login' first." >&2
  exit 1
fi

auth=( -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" )

# ---------------------------------------------------------------------------
# 1. Ensure labels exist (422 = already exists, ignored)
# ---------------------------------------------------------------------------
make_label() {
  local name="$1" color="$2" desc="$3" code
  code="$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X POST "${API}/labels" \
    -d "$(jq -n --arg n "$name" --arg c "$color" --arg d "$desc" \
      '{name:$n,color:$c,description:$d}')")"
  # 201 = created, 422 = already exists (both fine); anything else is a real error.
  if [ "$code" != "201" ] && [ "$code" != "422" ]; then
    echo "ERROR: creating label '$name' failed (HTTP $code)." >&2
    exit 1
  fi
}

echo "Ensuring labels..."
make_label "pass-1"            "0e8a16" "Roadmap PASS 1 — Foundation"
make_label "roadmap"          "5319e7" "Tracked in docs/PRODUCT_ROADMAP.md"
make_label "owner:dale"       "fbca04" "Owner action (no code)"
make_label "owner:code"       "1d76db" "Engineering work"
make_label "owner:both"       "0052cc" "Requires both owner + code"
make_label "priority:critical" "b60205" "Critical priority"
make_label "priority:high"    "d93f0b" "High priority"
make_label "priority:medium"  "fbca04" "Medium priority"
make_label "priority:low"     "c2e0c6" "Low priority"
make_label "blocked"          "000000" "Has unmet dependencies"

# ---------------------------------------------------------------------------
# 2. Helper to create an issue; echoes the new issue number
# ---------------------------------------------------------------------------
create_issue() {
  local title="$1" body="$2" labels_json="$3"
  local resp num
  resp="$(curl -s "${auth[@]}" -X POST "${API}/issues" \
    -d "$(jq -n --arg t "$title" --arg b "$body" --argjson l "$labels_json" \
      '{title:$t, body:$b, labels:$l}')")"
  num="$(echo "$resp" | jq -r '.number // empty')"
  if [ -z "$num" ]; then
    echo "ERROR creating '$title':" >&2
    echo "$resp" | jq -r '.message // .' >&2
    exit 1
  fi
  echo "$num"
}

echo "Creating PASS 1 issues..."

# --- Dependency-free tasks first (so dependents can reference them) ---------

T001=$(create_issue "[T-001] Security Credentials Rotation" \
'**Priority**: CRITICAL — do immediately
**Owner**: Dale
**Effort**: 1 hour
**Dependencies**: none

- [ ] T-001a: Rotate Railway team token (exposed 2026-06-12) — Railway → Team → Tokens → delete + reissue
- [ ] T-001b: Update any CI/local scripts using the old token
- [ ] T-001c: Rotate Supabase DB password (exposed 2026-07-11) — Supabase → Database → Reset password
- [ ] T-001d: Update `DATABASE_URL` on all Railway services + local `.env`
- [ ] T-001e: Redeploy backend and verify `/health` returns 200

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:dale","priority:critical"]')
echo "  T-001 -> #$T001"

T002=$(create_issue "[T-002] SMS: 10DLC registration + ENABLE_SMS gating flip" \
'**Priority**: CRITICAL
**Owner**: Code
**Effort**: 6-12 hours
**Dependencies**: none

> NOTE: SMS is OFF BY DESIGN until 10DLC registration completes. `ENABLE_SMS` defaults false in `agent/src/configSchema.ts`. This task is a registration + gating flip, not a code bug fix.

- [ ] T-002a: Complete Telnyx 10DLC brand + campaign registration
- [ ] T-002b: Verify `TELNYX_API_KEY` and `TELNYX_PHONE_NUMBER` on Railway are valid + owned
- [ ] T-002c: Flip `ENABLE_SMS=true` once 10DLC approved
- [ ] T-002d: Send a test SMS via Telnyx API directly to isolate provider vs. code
- [ ] T-002e: Verify delivery-receipt webhook is wired
- [ ] T-002f: Add loud error logging on SMS failure (not silent `status=failed`)
- [ ] T-002g: Verify one full reminder cycle end-to-end (appointment → reminder → SMS → delivery receipt)

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:code","priority:critical"]')
echo "  T-002 -> #$T002"

T003=$(create_issue "[T-003] Live Voice Validation Call" \
'**Priority**: CRITICAL
**Owner**: Dale
**Effort**: 30 min call + 1 hour follow-up
**Dependencies**: none

> NOTE: There is no live human transfer on the question-tree flow today; escalation takes a message with an urgent flag. Validate that path, not a warm transfer.

- [ ] T-003a: Set forward/escalation contact on dashboard (Phone Assistant)
- [ ] T-003b: Wife calls `+1 630-822-9086` (not your phone)
- [ ] T-003c: Validate booking — appointment lands in DB for correct tenant + time
- [ ] T-003d: Validate escalation — "talk to a person" records a message with urgent flag
- [ ] T-003e: Validate dialog — agent natural, asks preferred time, no forced slots
- [ ] T-003f: Log findings (repeated questions, weird phrasing, dead air) to `docs/CALL_FIX_PLAN.md`

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:dale","priority:critical"]')
echo "  T-003 -> #$T003"

T004=$(create_issue "[T-004] Stripe Test-Mode Wiring" \
'**Priority**: CRITICAL
**Owner**: Dale
**Effort**: 2 hours
**Dependencies**: none

- [ ] T-004a: Decide final tier pricing ($99-129 Solo / $199-249 Growth / $349+ Pro)
- [ ] T-004b: Create 3 Stripe products + prices in TEST mode — note price IDs
- [ ] T-004c: Register webhook (TEST): `https://secretary-hq-production.up.railway.app/billing/webhook`, events `checkout.session.completed`, `invoice.payment_failed`, `invoice.paid`, `invoice.payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted` — copy `whsec_`
- [ ] T-004d: Set 5 Railway env vars (`STRIPE_WEBHOOK_SECRET`, 3 price IDs, `STRIPE_AUTO_TAX`)
- [ ] T-004e: Test round-trip — trigger checkout, verify webhook fires + gate activates
- [ ] T-004f: Run `./scripts/simulate.sh stripe` and confirm clean

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:dale","priority:critical"]')
echo "  T-004 -> #$T004"

T006=$(create_issue "[T-006] Add Monitoring & Alerting" \
'**Priority**: HIGH
**Owner**: Code
**Effort**: 6-10 hours
**Dependencies**: none

- [ ] T-006a: Choose observability platform (Better Stack recommended)
- [ ] T-006b: Instrument metrics: call start/end, outcomes, turn latency, SMS success/fail, reminder success/fail, booking success/fail, webhook receipts
- [ ] T-006c: Alert rules: reminder_batch_failed>3/10min → page; sms_failure_rate>5% → warn; call_rejection_rate>2% → investigate; turn_latency_p95>3000ms → warn; webhook_signature_failures>0/1h → page
- [ ] T-006d: Build ops status dashboard
- [ ] T-006e: Test alerts — trigger each manually, verify notification

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:code","priority:high"]')
echo "  T-006 -> #$T006"

T007=$(create_issue "[T-007] Fix E2E Test Flakiness" \
'**Priority**: HIGH
**Owner**: Code
**Effort**: 4-6 hours
**Dependencies**: none

- [ ] T-007a: Reproduce `SetupWizard > shows success state` failure (1115ms on CI)
- [ ] T-007b: Reproduce `customer-preferences-config.spec.ts` reload failure
- [ ] T-007c: Fix each: replace timing assertions with explicit `waitFor()` on actual state
- [ ] T-007d: Run each test 20x consecutively — zero flakes required
- [ ] T-007e: Confirm 3 consecutive CI green runs

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:code","priority:high"]')
echo "  T-007 -> #$T007"

T008=$(create_issue "[T-008] Validate New Intake Trees (As a Customer)" \
'**Priority**: HIGH
**Owner**: Both
**Effort**: 2-3 hours
**Dependencies**: none

- [ ] T-008a: Register as new tenant (https://www.secretaryhq.com)
- [ ] T-008b: Pick `Catering` as business type — verify it appears in picker
- [ ] T-008c: Complete 7-step setup wizard
- [ ] T-008d: Check agent Checklist tab — `catering_intake` block must appear
- [ ] T-008e: Query DB: `SELECT checklist_preset_id FROM tenants` → must be `catering_front_desk`
- [ ] T-008f: Run simulator `SIM_TRACE=1 npx tsx agent/scripts/sim-questiontree.ts` for catering
- [ ] T-008g: Spot-check 3 other verticals (plumber, salon, real_estate)

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:both","priority:high"]')
echo "  T-008 -> #$T008"

T010=$(create_issue "[T-010] Schedule Pattern Adoption (Existing Tenants)" \
'**Priority**: MEDIUM
**Owner**: Code
**Effort**: 2-4 hours
**Dependencies**: none

> NOTE: The `employee_schedule_pattern` migration is deliberately NO-BACKFILL. Existing tenants keep the clamped fallback until they next save their hours, at which point the declared rule lands. Do NOT do row archaeology.

- [ ] T-010a: Confirm `expandWeeklyToSchedule` writes the rule on save
- [ ] T-010b: Confirm `extendSchedules` prefers declared rule, falls back to derived clamped to CURRENT_DATE+14
- [ ] T-010c: For Thinking Hammer, prompt an hours re-save to adopt the rule
- [ ] T-010d: Verify new extends use the rule
- [ ] T-010e: Regression test: far-future shift no longer poisons the pattern

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:code","priority:medium"]')
echo "  T-010 -> #$T010"

T011=$(create_issue "[T-011] Verify Cost Tracking Ledger" \
'**Priority**: MEDIUM
**Owner**: Code
**Effort**: 2-3 hours
**Dependencies**: none

- [ ] T-011a: Confirm `aiCost/index.ts` tracks all 4 legs: GPT-4.1-mini LLM, Deepgram Aura TTS, Deepgram Nova-3 STT, 4o-mini summary
- [ ] T-011b: Pull 5 real prod calls and verify ledger cost ~$0.05-0.10/call
- [ ] T-011c: Compare against provider invoices (Deepgram + OpenAI) — within 5%

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:code","priority:medium"]')
echo "  T-011 -> #$T011"

T012=$(create_issue "[T-012] Deployment Checklist & Automation" \
'**Priority**: MEDIUM
**Owner**: Code
**Effort**: 3-4 hours
**Dependencies**: none

- [ ] T-012a: Write `docs/DEPLOYMENT_CHECKLIST.md` (pre-merge, post-merge, migrations, post-deploy)
- [ ] T-012b: Add GitHub Action: CLAUDE.md drift check + no secrets in code
- [ ] T-012c: Document the 3 gotchas (Railway "Wait for CI" unversioned, migration order, SKIPPED is terminal)

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_' \
'["pass-1","roadmap","owner:code","priority:medium"]')
echo "  T-012 -> #$T012"

# --- Dependent tasks (reference the numbers captured above) -----------------

T005=$(create_issue "[T-005] Stripe Live-Mode & Bank Account" \
"**Priority**: CRITICAL
**Owner**: Dale
**Effort**: 4 hours
**Dependencies**: Depends on #${T004}

- [ ] T-005a: Open LLC bank account for Thinking Hammer
- [ ] T-005b: Connect bank account to Stripe
- [ ] T-005c: Enable Stripe Tax (register IL nexus + customer states)
- [ ] T-005d: Recreate 3 products + prices in LIVE mode — new price IDs
- [ ] T-005e: Register webhook in LIVE mode — copy new whsec_live_
- [ ] T-005f: Swap all 5 Railway env vars to live values
- [ ] T-005g: Verify live webhook receives events

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_" \
'["pass-1","roadmap","owner:dale","priority:critical","blocked"]')
echo "  T-005 -> #$T005"

T009=$(create_issue "[T-009] Volume Metering & Tier Caps" \
"**Priority**: HIGH
**Owner**: Code
**Effort**: 8-12 hours
**Dependencies**: Depends on #${T004}

- [ ] T-009a: Add columns to \`tenants\`: subscription_tier, calls_this_month, month_reset_date
- [ ] T-009b: Increment calls_this_month on start_voice_session() in agent worker
- [ ] T-009c: Enforce tier cap before answering — reject over-limit calls gracefully
- [ ] T-009d: Auto-reset counter monthly
- [ ] T-009e: Webhook: checkout.session.completed → set subscription_tier from price_id
- [ ] T-009f: Webhook: customer.subscription.deleted → clear tier
- [ ] T-009g: Tests — simulate 300+ calls on Solo, verify call 301 rejected; upgrade + verify success

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_" \
'["pass-1","roadmap","owner:code","priority:high","blocked"]')
echo "  T-009 -> #$T009"

T013=$(create_issue "[T-013] Full Customer Onboarding Walk-Through" \
"**Priority**: MEDIUM
**Owner**: Dale
**Effort**: 3-4 hours
**Dependencies**: Depends on #${T003}, #${T008}

- [ ] T-013a: Register as new tenant (real email, real phone)
- [ ] T-013b: Complete all 7 wizard steps
- [ ] T-013c: Make a real test call
- [ ] T-013d: Check transcript, booking, SMS, CRM record
- [ ] T-013e: Document friction points + UX bugs → feed into PASS 2

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_" \
'["pass-1","roadmap","owner:dale","priority:medium","blocked"]')
echo "  T-013 -> #$T013"

T014=$(create_issue "[T-014] Dead Code Removal" \
"**Priority**: LOW
**Owner**: Code
**Effort**: 2-3 hours
**Dependencies**: Do last — after #${T001}..#${T013} are stable

- [ ] T-014a: Delete \`ReminderProcessor\` (unused parallel implementation)
- [ ] T-014b: Remove commented-out debug code
- [ ] T-014c: Remove any unused route stubs

_Tracked in docs/PRODUCT_ROADMAP.md § PASS 1_" \
'["pass-1","roadmap","owner:code","priority:low","blocked"]')
echo "  T-014 -> #$T014"

echo ""
echo "=========================================="
echo "PASS 1 issues created:"
echo "  T-001 #$T001   T-002 #$T002   T-003 #$T003"
echo "  T-004 #$T004   T-005 #$T005   T-006 #$T006"
echo "  T-007 #$T007   T-008 #$T008   T-009 #$T009"
echo "  T-010 #$T010   T-011 #$T011   T-012 #$T012"
echo "  T-013 #$T013   T-014 #$T014"
echo "=========================================="
echo "Done. View them: https://github.com/${REPO}/issues?q=is:issue+label:pass-1"
