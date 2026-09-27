#!/usr/bin/env bash
#
# scripts/simulate.sh — On-demand system simulation + status harness.
#
# One control panel to answer "are all systems up?" and "does the whole thing
# actually work?" at any time, against local dev OR production.
#
# Subcommands:
#   status [--env local|prod] [--deep]   HTTP health board for every service.
#                                        --deep also dispatch-tests the agent
#                                        worker via LiveKit (spins a real
#                                        session, ~5s, cleans up after).
#   ci     [--watch]                     CI + local build status: GitHub Actions
#                                        runs for .github/workflows/ci.yml (job
#                                        stages, conclusions, per-job results)
#                                        + local src vs dist/.next staleness.
#                                        Requires 'gh' CLI + `gh auth login`
#                                        (for private repos). --watch follows
#                                        the latest run live in terminal.
#   tools  [--env local|prod] [--tenant <id>]
#                                        Functional simulation of everything the
#                                        voice agent DOES on a call (lookup,
#                                        book, OTP, preferences, session log) by
#                                        hitting /agent-tools/* — no telephony.
#                                        Defaults to a fresh /demo/start tenant
#                                        (ephemeral, 30-min TTL, self-cleaning).
#   rag    [--env local|prod]             RAG accuracy eval: seed a known KB into
#                                        a demo tenant, ask paraphrased caller
#                                        questions via /agent-tools/policy-answer,
#                                        grade retrieval, report a hit-rate (exit
#                                        non-zero below 80%). Real embeddings.
#   toolselect                            Agent tool-SELECTION eval: replays the
#                                        real system prompt + the real set of
#                                        23 tool schemas through gpt-4o-mini and grades
#                                        the tool sequence the model picks
#                                        (e.g. available_slots must lead to
#                                        book_with_scheduling, NEVER
#                                        book_appointment). Real OpenAI calls;
#                                        exit non-zero below 80%. Needs
#                                        OPENAI_API_KEY (.env).
#   call   [--env local|prod] --tenant <id>
#                                        Dispatch the agent into a LiveKit room
#                                        and print a browser join URL so you can
#                                        talk to the agent with a mic — real
#                                        STT/LLM/TTS/booking, NO phone needed.
#   stripe [--env local|prod]             Stripe billing path check: verifies
#                                        routes are reachable, webhook sig gate
#                                        rejects bad sigs, checkout reports key
#                                        configured or GAP (never charges anyone).
#   all    [--env local|prod]            status --deep, then tools.
#
# Env/secrets are read from the repo .env (local) or passed in (prod). The
# tiers map to: status = "systems up", ci = "build/CI pipeline state + freshness",
# tools = "brain works", stripe = "billing wired", call = "voice works without a phone".
# The only thing this CANNOT simulate is real PSTN inbound (Telnyx) — that needs a
# real carrier call.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

# ── Colors ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; DIM=''; BOLD=''; RESET=''
fi

ok()   { printf "  ${GREEN}[OK]${RESET}   %-22s %s\n" "$1" "$2"; }
fail() { printf "  ${RED}[FAIL]${RESET} %-22s %s\n" "$1" "$2"; }
skip() { printf "  ${DIM}[--]   %-22s %s${RESET}\n" "$1" "$2"; }

# ── Arg parsing ─────────────────────────────────────────────────────────────
ENV="local"
DEEP=0
TENANT=""
WATCH=0
SUBCMD="${1:-}"
shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --env)    ENV="$2"; shift 2 ;;
    --deep)   DEEP=1; shift ;;
    --tenant) TENANT="$2"; shift 2 ;;
    --watch)  WATCH=1; shift ;;
    -h|--help) sed -n '3,45p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── Targets per env ─────────────────────────────────────────────────────────
case "$ENV" in
  local)
    BACKEND="${BACKEND_URL:-https://localhost:4001}"
    DASHBOARD="${DASHBOARD_URL:-https://localhost:4400}"
    # -k skips cert check for self-signed local TLS; harmless for plain HTTP
    CURL_OPTS="-sk"
    ;;
  prod)
    BACKEND="https://secretary-hq-production.up.railway.app"
    DASHBOARD="https://dashboard-production-cee3.up.railway.app"
    CURL_OPTS="-s"
    ;;
  *) echo "Unknown env: $ENV (use local|prod)" >&2; exit 2 ;;
esac

# Pull a value out of a flat JSON blob without jq.
json_get() { echo "$1" | grep -oE "\"$2\":\"?[^\",}]*\"?" | head -1 | sed -E "s/\"$2\"://; s/\"//g"; }

# Read one var from the repo .env (cut -f2- so values with '=' survive; strip quotes).
env_get() { grep -E "^$1=" "$ROOT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\''' || true; }

# Export LIVEKIT_* from .env for the node helpers.
load_livekit_env() {
  LK_URL="$(env_get LIVEKIT_URL)"; LK_KEY="$(env_get LIVEKIT_API_KEY)"; LK_SECRET="$(env_get LIVEKIT_API_SECRET)"
  if [ -z "$LK_URL" ] || [ -z "$LK_KEY" ] || [ -z "$LK_SECRET" ]; then
    echo "  ${RED}LIVEKIT_URL/API_KEY/API_SECRET not found in $ROOT_DIR/.env${RESET}" >&2
    return 1
  fi
}

# ── status ──────────────────────────────────────────────────────────────────
cmd_status() {
  printf "${BOLD}SecretaryHQ — System Status${RESET} ${DIM}(env: %s)${RESET}\n" "$ENV"
  local up=0 total=0

  # 1. Backend liveness
  total=$((total+1))
  local health; health="$(curl $CURL_OPTS --max-time 8 "$BACKEND/health" 2>/dev/null || true)"
  if echo "$health" | grep -q '"status":"ok"'; then
    ok "backend /health" "up since $(json_get "$health" started_at)"
    up=$((up+1))
  else
    fail "backend /health" "no response from $BACKEND"
  fi

  # 2. Backend readiness (DB ping + pool)
  total=$((total+1))
  local ready; ready="$(curl $CURL_OPTS --max-time 8 "$BACKEND/ready" 2>/dev/null || true)"
  if echo "$ready" | grep -q '"db":"ok"'; then
    local pool; pool="$(echo "$ready" | grep -oE '"pool":\{[^}]*\}')"
    ok "backend /ready" "db ok $(json_get "$ready" latency_ms)ms ${DIM}${pool}${RESET}"
    up=$((up+1))
  else
    fail "backend /ready" "DB unreachable (${ready:-no response})"
  fi

  # 3. Dashboard reachability
  total=$((total+1))
  local code; code="$(curl $CURL_OPTS --max-time 8 -o /dev/null -w '%{http_code}' "$DASHBOARD/" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    ok "dashboard" "HTTP 200"
    up=$((up+1))
  else
    fail "dashboard" "HTTP $code from $DASHBOARD"
  fi

  # 4. Agent worker (deep — real LiveKit dispatch into a throwaway room)
  total=$((total+1))
  if [ "$DEEP" = "1" ]; then
    # LiveKit creds from .env → node helper (resolves livekit-server-sdk from agent/node_modules).
    if load_livekit_env && \
       LIVEKIT_URL="$LK_URL" LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" \
       SIM_TENANT="${TENANT:-}" \
       node "$ROOT_DIR/agent/scripts/sim-agent-liveness.mjs"; then
      ok "agent worker" "dispatch picked up (LiveKit)"
      up=$((up+1))
    else
      fail "agent worker" "no participant joined within timeout (see above)"
    fi
  else
    skip "agent worker" "pass --deep to dispatch-test the LiveKit worker"
    total=$((total-1))  # not counted unless deep-checked
  fi

  printf "${BOLD}Result:${RESET} %s/%s core checks up\n" "$up" "$total"

  # Quick local build staleness note (full details in `simulate ci`)
  if [ "$ENV" = "local" ]; then
    local src_newest dist_newest
    src_newest=$(find "$ROOT_DIR/src" "$ROOT_DIR/dashboard" "$ROOT_DIR/shared" -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.next/*' -printf '%T@\n' 2>/dev/null | sort -nr | head -1 || echo 0)
    dist_newest=$(find "$ROOT_DIR/dist" "$ROOT_DIR/dashboard/.next" -type f 2>/dev/null -printf '%T@\n' | sort -nr | head -1 || echo 0)
    if [ "${src_newest:-0}" -gt "${dist_newest:-0}" ] 2>/dev/null; then
      echo "  ${YELLOW}[STALE]${RESET} build — run 'npm run build' before relying on running servers or tests (see 'simulate ci' for delta)"
    fi
  fi

  [ "$up" = "$total" ]
}

# ── ci (GitHub Actions + local build freshness) ─────────────────────────────
cmd_ci() {
  printf "${BOLD}SecretaryHQ — CI / Build Status${RESET} ${DIM}(env: %s)${RESET}\n" "$ENV"
  echo ""

  # Derive repo from git remote (fallback to known)
  local repo="ddemott/secretary-hq"
  local remote_url
  remote_url=$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || echo "")
  if echo "$remote_url" | grep -q 'github.com'; then
    repo=$(echo "$remote_url" | sed -E 's|.*github.com[:/]||; s|\.git$||')
  fi
  echo "Repo: $repo"
  echo "Workflow: .github/workflows/ci.yml (backend | dashboard | agent | e2e)"
  echo ""

  # 1. Local build staleness / freshness (addresses "must build + restart" rule)
  echo ">>> Local build freshness (src vs artifacts)"
  if [ "$ENV" = "local" ]; then
    local src_newest dist_newest backend_ok dashboard_ok
    # Newest source under our control (ignore node_modules, dist, .next)
    src_newest=$(find "$ROOT_DIR/src" "$ROOT_DIR/dashboard" "$ROOT_DIR/shared" \
      -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) \
      -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.next/*' \
      -printf '%T@\n' 2>/dev/null | sort -nr | head -1 || echo 0)
    # Newest built artifact (dist for backend, .next for dashboard)
    dist_newest=$(find "$ROOT_DIR/dist" "$ROOT_DIR/dashboard/.next" -type f 2>/dev/null \
      -printf '%T@\n' | sort -nr | head -1 || echo 0)

    [ -z "$src_newest" ] && src_newest=0
    [ -z "$dist_newest" ] && dist_newest=0

    if [ "$src_newest" -gt "$dist_newest" ] 2>/dev/null; then
      local delta_min=$(( (src_newest - dist_newest) / 60 ))
      fail "build staleness" "source is newer than dist/.next by ~${delta_min}m — 'npm run build' (or 'npm start') is required"
    else
      ok "build freshness" "backend dist/ + dashboard .next/ up to date vs source"
    fi

    # Also give a quick note on running process (health has started_at)
    echo "    (use ./scripts/simulate.sh status to see running server started_at)"
  else
    skip "build freshness" "only relevant for --env local (src mtimes vs built artifacts)"
  fi
  echo ""

  # 2. GitHub Actions CI status
  echo ">>> GitHub Actions CI runs"
  if command -v gh >/dev/null 2>&1; then
    if gh auth status --hostname github.com >/dev/null 2>&1; then
      local cur_branch
      cur_branch=$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || echo "")
      echo "Recent runs (most recent first):"
      # Pretty one-line per run. Columns chosen for scannability.
      gh run list --repo "$repo" --workflow=ci.yml --limit=6 \
        --json databaseId,status,conclusion,headBranch,displayTitle,updatedAt,url \
        --jq '
          .[] |
          "  \(.status|ascii_upcase) \(.conclusion // "queued") | \(.headBranch) | \(.displayTitle | .[0:55]) | \(.updatedAt) | \(.url)"
        ' 2>/dev/null || echo "  (failed to list runs — repo permissions or network)"

      if [ -n "$cur_branch" ]; then
        echo ""
        echo "Runs on your branch ($cur_branch):"
        gh run list --repo "$repo" --workflow=ci.yml --branch "$cur_branch" --limit=4 \
          --json databaseId,status,conclusion,headBranch,displayTitle,updatedAt,url \
          --jq '
            .[] |
            "  \(.status|ascii_upcase) \(.conclusion // "queued") | \(.displayTitle | .[0:55]) | \(.updatedAt) | \(.url)"
          ' 2>/dev/null || echo "  (none or failed to query branch-specific runs)"
      fi
    else
      fail "gh auth" "not logged in for GitHub"
      echo "    Run: gh auth login"
      echo "    Web: https://github.com/$repo/actions/workflows/ci.yml"
    fi
  else
    fail "gh cli" "GitHub CLI not found on PATH"
    echo "    Install: https://cli.github.com/"
    echo "    Web UI:  https://github.com/$repo/actions/workflows/ci.yml"
    echo "    Tip: after install + auth, re-run this for live job-by-job status"
  fi
  echo ""

  if [ "$WATCH" = "1" ]; then
    if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
      echo ">>> Watching latest CI run (press Ctrl-C to stop)..."
      gh run watch --repo "$repo" || true
    else
      echo "${YELLOW}Cannot watch — gh not available or not authenticated.${RESET}"
    fi
  else
    echo "Tip: add --watch to tail the most recent run live (gh run watch under the hood)."
  fi
  echo ""
  echo "Local equivalents while developing:"
  echo "  npm run checks          # format + lint + typecheck (fast)"
  echo "  npm run pre-pr          # checks + full unit tests"
  echo "  npm run prepare-commit  # full automated gate (checks + tests + drift + more)"
  echo "  npm test                # vitest (backend + shared)"
  echo "  cd dashboard && npx playwright test --grep \"pattern\"   # targeted e2e"
}

# ── tools ───────────────────────────────────────────────────────────────────
cmd_tools() {
  # Server's AGENT_SECRET. From .env (matches the LOCAL backend). For prod,
  # the prod secret differs — allow override via SIM_AGENT_SECRET in the env.
  local secret="${SIM_AGENT_SECRET:-$(env_get AGENT_SECRET)}"
  if [ -z "$secret" ]; then
    echo "  ${RED}AGENT_SECRET not found (.env) and SIM_AGENT_SECRET not set${RESET}" >&2
    exit 1
  fi
  if [ "$ENV" = "prod" ] && [ -z "${SIM_AGENT_SECRET:-}" ]; then
    echo "  ${YELLOW}note:${RESET} using the .env (local) AGENT_SECRET against prod — agent-tools will 401" >&2
    echo "  ${YELLOW}      unless it matches prod's. Set SIM_AGENT_SECRET=<prod secret> to target prod.${RESET}" >&2
  fi
  # Local backend uses self-signed certs → let node fetch accept them.
  #
  # SIM_DB_URL lets the journey READ voice_sessions back and prove the
  # call→appointment link actually persisted, rather than trusting that the
  # endpoint returned ok. Local gets it from .env automatically.
  #
  # For prod this used to be hard-blanked ("prod has no direct DB access here"),
  # which was an assumption about the OPERATOR, not a fact about the run — and it
  # cost us: every prod journey reported `[GAP] call → appointment link (DB)`, so
  # the single most important write of a booking call — the row that ties a call
  # to the appointment it produced — was UNVERIFIED IN PRODUCTION, while the
  # output said "known gap, awaiting wiring". The feature was wired the whole
  # time. A missing credential had been rendered as a missing feature.
  #
  # Now: whoever HAS prod DB access can pass SIM_DB_URL explicitly and the
  # read-back runs anywhere. The env-derived default stays local-only, so the
  # behaviour without the flag is unchanged. The read-back is SELECT-only.
  local tls="" dburl="${SIM_DB_URL:-}"
  if [ "$ENV" = "local" ]; then
    tls="NODE_TLS_REJECT_UNAUTHORIZED=0"
    dburl="${SIM_DB_URL:-$(env_get DATABASE_URL)}"
  fi
  env $tls SIM_BACKEND="$BACKEND" SIM_AGENT_SECRET="$secret" SIM_TENANT="${TENANT:-}" \
    SIM_DB_URL="$dburl" \
    node "$ROOT_DIR/scripts/sim-tools.mjs"
}

# ── rag ─────────────────────────────────────────────────────────────────────
cmd_rag() {
  # Seeds a known KB into a demo tenant, asks paraphrased questions, grades
  # retrieval accuracy. Needs the server's AGENT_SECRET (policy-answer) + OPENAI
  # on the target backend (real embeddings).
  local secret="${SIM_AGENT_SECRET:-$(env_get AGENT_SECRET)}"
  if [ -z "$secret" ]; then
    echo "  ${RED}AGENT_SECRET not found (.env) and SIM_AGENT_SECRET not set${RESET}" >&2
    exit 1
  fi
  local tls=""
  [ "$ENV" = "local" ] && tls="NODE_TLS_REJECT_UNAUTHORIZED=0"
  env $tls SIM_BACKEND="$BACKEND" SIM_AGENT_SECRET="$secret" \
    node "$ROOT_DIR/scripts/sim-rag.mjs"
}

# ── toolselect ──────────────────────────────────────────────────────────────
cmd_toolselect() {
  # LLM tool-selection eval (docs/TODO.md "Verification blind spots" P0). Pure OpenAI replay of
  # the agent's prompt + tool schemas — no backend, no LiveKit, no DB. Needs
  # OPENAI_API_KEY; read from the environment first, then the repo .env.
  local key="${OPENAI_API_KEY:-$(env_get OPENAI_API_KEY)}"
  if [ -z "$key" ]; then
    echo "  ${RED}OPENAI_API_KEY not found (.env) and not set in the environment${RESET}" >&2
    exit 2
  fi
  (cd "$ROOT_DIR/agent" && OPENAI_API_KEY="$key" npx tsx scripts/sim-toolselect.ts)
}

# ── stripe ──────────────────────────────────────────────────────────────────
cmd_stripe() {
  local tls=""
  [ "$ENV" = "local" ] && tls="NODE_TLS_REJECT_UNAUTHORIZED=0"
  env $tls SIM_BACKEND="$BACKEND" \
    node "$ROOT_DIR/scripts/sim-stripe.mjs"
}

# ── call ────────────────────────────────────────────────────────────────────
cmd_call() {
  load_livekit_env || exit 1
  LIVEKIT_URL="$LK_URL" LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" \
    SIM_TENANT="${TENANT:-}" \
    SIM_CALL_JOIN_FIRST=1 \
    node "$ROOT_DIR/agent/scripts/sim-call.mjs"
}

case "$SUBCMD" in
  status) cmd_status ;;
  ci)     cmd_ci ;;
  tools)  cmd_tools ;;
  rag)    cmd_rag ;;
  toolselect) cmd_toolselect ;;
  stripe) cmd_stripe ;;
  call)   cmd_call ;;
  all)    cmd_status && echo "" && cmd_tools && echo "" && cmd_rag ;;
  ""|-h|--help) sed -n '3,60p' "$0" ;;
  *) echo "Unknown subcommand: $SUBCMD" >&2; exit 2 ;;
esac
