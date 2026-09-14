#!/usr/bin/env bash
set -euo pipefail

# list-data-migrations.sh: Classify every migration under supabase/migrations
# as pure-DDL or data-bearing, as prep for the migration-chain-squash plan.
#
# WHO   : whoever is advancing docs/planning/MIGRATION_CHAIN_SQUASH_PLAN.md
#         §3 entry criterion 4 ("data inventory complete") — read-only, no
#         prod gate needed (plan §5).
# WHAT  : greps each migration file for INSERT/UPDATE/COPY/DELETE statements
#         that are NOT purely inside a DDL-only context (CREATE TABLE column
#         defaults, comments) and prints a two-column classification.
# WHEN  : before any squash execution PR; re-run after new migrations land
#         so the inventory doesn't silently go stale.
# WHERE : runs against the files on disk — no DB connection required.
# WHY   : the squash plan's §2.2 risk is that data migrations aren't fully
#         represented by baseline.sql + seed.sql. This script is the first
#         pass at finding every migration that needs a manual "obsolete /
#         folded into seed / must remain as a post-squash step" call —
#         it does not make that call itself, a human still has to look at
#         each DATA row below and decide.
#
# Output: TSV to stdout — <classification>\t<filename>
#   DATA  = contains a real data-mutating statement outside CREATE/ALTER DDL
#   DDL   = schema-only (CREATE/ALTER/DROP TABLE|FUNCTION|INDEX|TRIGGER etc.)
#
# Heuristic only — grep-based, not a SQL parser. False positives are cheap
# (an extra file to eyeball); false negatives are the real risk, so this
# errs toward classifying as DATA when in doubt (matches an INSERT/UPDATE/
# DELETE/COPY keyword ANYWHERE outside a trigger function body definition
# is enough to flag DATA).

MIGRATIONS_DIR="${1:-supabase/migrations}"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "No such directory: $MIGRATIONS_DIR" >&2
  exit 1
fi

data_count=0
ddl_count=0

for f in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$f")"
  # Strip SQL line comments and blank lines before matching, so a comment
  # mentioning "insert" doesn't false-positive.
  body="$(grep -v '^\s*--' "$f")"
  if echo "$body" | grep -qiE '\b(INSERT INTO|UPDATE[[:space:]]+[a-z_]+[[:space:]]+SET|DELETE FROM|COPY[[:space:]]+[a-z_]+[[:space:]]+FROM)\b'; then
    echo -e "DATA\t$name"
    data_count=$((data_count + 1))
  else
    echo -e "DDL\t$name"
    ddl_count=$((ddl_count + 1))
  fi
done

{
  echo ""
  echo "# Summary: $data_count DATA-classified, $ddl_count DDL-only (of $((data_count + ddl_count)) total)"
  echo "# Heuristic grep only — every DATA row still needs a human call:"
  echo "#   obsolete | folded into seed | must remain as a post-squash step"
  echo "# per MIGRATION_CHAIN_SQUASH_PLAN.md §3.4."
} >&2
