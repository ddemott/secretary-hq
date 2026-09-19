#!/usr/bin/env bash
#
# scripts/example-pre-push-hook.sh
#
# Stronger pre-push hook. Project-type aware.
#
# Runs the full "checks" + "unitTests" commands from workflow.config.json.
# A Python project will run whatever its "checks" and "unitTests" are
# (e.g. ruff + black + pytest). Never hardcodes npm or tsc.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/config-reader.sh
source "$SCRIPT_DIR/config-reader.sh"

PTYPE="$(get_project_type)"

echo "==> Running pre-push checks (projectType: $PTYPE)..."

# ── Docs-only fast path ──────────────────────────────────────────────────────
# A push whose changes touch ONLY documentation never needs the unit suite —
# prose can't break a test. Skip the expensive unitTests below, and swap the
# full `checks` step (eslint + two tsc runs) for just the format check and the
# CLAUDE.md drift detector — the only checks that can fail on prose.
#
# Git pipes the refs being pushed on the hook's stdin, one per line:
#   <local ref> <local sha> <remote ref> <remote sha>
# We classify off the ACTUAL pushed SHA range — not HEAD — so `git push origin
# other` (a ref that isn't checked out) is judged correctly. The fast path is
# enabled ONLY for a single-ref push whose exact range (remote sha → local sha)
# is all docs. ANY ambiguity — multiple refs (--all), no stdin (hook run by hand
# from a terminal), an unreadable range — falls back to running the full suite.
#
# A branch DELETION is the one case that skips outright rather than falling
# back. Git signals it with an all-zero LOCAL sha: the push uploads no objects
# and no ref on the remote gains any commit, so there is nothing a test could
# be testing. Running the suite there does not merely waste ~7 min — a suite
# that fails for an unrelated reason (machine under load, a real red test on
# another branch) BLOCKS the deletion entirely, which is how two already-merged
# branches sat un-purged on origin on 2026-09-03.
DOCS_ONLY=0
ZERO='0000000000000000000000000000000000000000'
if [ ! -t 0 ]; then
    STDIN_REFS="$(cat)"                  # the pushed-ref list (empty when no stdin)
    REF_COUNT="$(printf '%s\n' "$STDIN_REFS" | grep -c '[^[:space:]]' || true)"

    # Deletion-only push: every ref on stdin has an all-zero LOCAL sha. Nothing
    # is uploaded, so nothing can break. Exit before the checks below.
    NON_DELETE_COUNT="$(printf '%s\n' "$STDIN_REFS" \
        | grep '[^[:space:]]' \
        | awk -v z="$ZERO" '$2 != z' \
        | grep -c '' || true)"
    if [ "$REF_COUNT" != "0" ] && [ "$NON_DELETE_COUNT" = "0" ]; then
        echo "  🗑  Branch deletion only — no objects pushed, skipping all checks."
        exit 0
    fi

    if [ "$REF_COUNT" = "1" ]; then
        # shellcheck disable=SC2034
        read -r _lref lsha _rref rsha <<EOF_REF
$STDIN_REFS
EOF_REF
        if [ -n "${lsha:-}" ] && [ "$lsha" != "$ZERO" ]; then
            if [ "${rsha:-$ZERO}" = "$ZERO" ]; then
                # New branch (no remote counterpart yet): what the branch adds on
                # top of the default branch. THREE-dot (merge-base) on purpose: a
                # two-dot diff also lists main's newer commits in reverse whenever
                # the branch has fallen behind main, so a docs-only branch looked
                # like a code change and ran the whole suite.
                # `git symbolic-ref` fails when origin/HEAD was never set (fresh
                # clones and `git remote add` setups) — and it sits in a pipe, so
                # the old `|| echo main` never fired and BASE became just "origin/",
                # which made the diff error out and disabled the fast path.
                DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
                DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
                DIFF_RANGE="origin/$DEFAULT_BRANCH...$lsha"
            else
                DIFF_RANGE="$rsha..$lsha"   # existing branch: the exact pushed range
            fi
            CHANGED_FILES="$(git diff --name-only "$DIFF_RANGE" 2>/dev/null || true)"
            if [ -n "$CHANGED_FILES" ] && ! printf '%s\n' "$CHANGED_FILES" | grep -qvE '(\.md$|\.mdx$|\.txt$|^docs/)'; then
                DOCS_ONLY=1
                echo "  📝 Docs-only push — will skip the unit test suite."
            fi
        fi
    fi
fi

# Each command runs in its own subshell `( ... )` so a `cd` inside one step
# (e.g. `checks` ends with `cd dashboard && tsc`) can't leak its cwd into the
# next step. Without this, `unitTests` ("npm test") was silently running from
# dashboard/ — so the backend suite never ran on push.
CHECKS_CMD="$(get_command checks)"
if [ "$DOCS_ONLY" = "1" ]; then
    # eslint + two tsc runs cannot fail on prose. Keep what can: the formatter
    # and the CLAUDE.md drift detector (CI runs the detector on docs-only PRs too).
    FORMAT_CMD="$(get_command formatCheck)"
    DOCS_CHECKS=""
    if is_real_command "$FORMAT_CMD"; then DOCS_CHECKS="$FORMAT_CMD"; fi
    if grep -q '"verify:claude-md"' package.json 2>/dev/null; then
        DOCS_CHECKS="${DOCS_CHECKS:+$DOCS_CHECKS && }npm run verify:claude-md"
    fi
    if [ -n "$DOCS_CHECKS" ]; then
        echo "  - Docs-only push — running format check + doc drift only (skipping lint/typecheck)..."
        if ( eval "$DOCS_CHECKS" ); then
            echo "    ✅ Docs checks passed"
        else
            echo "    ❌ Docs checks failed. Fix before pushing."
            exit 1
        fi
    else
        echo "  - Quality checks (skipped — docs-only push, no docs checks defined)"
    fi
elif is_real_command "$CHECKS_CMD"; then
    echo "  - Running quality checks..."
    if ( eval "$CHECKS_CMD" ); then
        echo "    ✅ Quality checks passed"
    else
        echo "    ❌ Quality checks failed. Fix before pushing."
        exit 1
    fi
else
    echo "  - Quality checks (skipped — not defined for this projectType)"
fi

UNIT_CMD="$(get_command unitTests)"
if [ "$DOCS_ONLY" = "1" ]; then
    echo "  - Unit tests (skipped — docs-only push)"
elif is_real_command "$UNIT_CMD"; then
    echo "  - Running unit tests..."
    if ( eval "$UNIT_CMD" ); then
        echo "    ✅ Unit tests passed"
    else
        echo "    ❌ Some unit tests are failing. Fix before pushing."
        exit 1
    fi
else
    echo "  - Unit tests (skipped — not defined for this projectType)"
fi

echo "✅ Pre-push checks passed for projectType '$PTYPE'."
echo ""
E2E_CMD="$(get_command e2e)"
if is_real_command "$E2E_CMD"; then
    echo "Reminder: Consider running relevant E2E/integration tests before opening a PR:"
    echo "  $E2E_CMD \"<your-pattern>\""
fi
echo ""
exit 0
