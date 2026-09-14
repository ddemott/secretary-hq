/**
 * THE PRESET CATALOG AND THE DATABASE MUST AGREE.
 *
 * WHY THIS EXISTS (2026-08-14). `tenants.checklist_preset_id` carries a CHECK
 * constraint enumerating the supported preset ids. `owner_for_hire_front_desk`
 * shipped in code on 2026-08-13 (#343, the fix for the unreachable `job` tree)
 * and was never added to that constraint, so the column could not physically
 * hold the id the code had just started producing:
 *
 *   ERROR: new row for relation "tenants" violates check constraint
 *          "tenants_checklist_preset_id_valid"
 *
 * `scripts/pin-owner-for-hire-preset.sql` is the ops step `docs/planning/TODO.md`
 * tells Dale to run against production after the agent deploys. It would have aborted.
 *
 * WHAT MAKES THIS CLASS OF BUG NASTY: nothing is red. TypeScript is happy —
 * both sides of the drift are in different languages. The unit tests are happy —
 * they never touch a real tenants row. The failure waits for an UPDATE against
 * production, which is the most expensive place to discover it and the one
 * furthest from whoever wrote the preset.
 *
 * WHO: any developer adding a vertical preset | WHAT: the SQL CHECK list vs the
 * shipped catalog | WHEN: CI, every run | WHERE: migrations vs
 * shared/checklistPresetDerivation.ts | WHY: so the next preset fails here, in
 * seconds, instead of at a production UPDATE.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHECKLIST_PRESET_IDS } from '../shared/checklistPresetDerivation';

const MIGRATIONS_DIR = resolve(__dirname, '../supabase/migrations');
const CONSTRAINT = 'tenants_checklist_preset_id_valid';

/**
 * The CHECK is defined more than once across the migration history (added, then
 * re-synced). The one that governs a freshly migrated database is the LAST one
 * to run, i.e. the highest-sorting filename — read that, not the first match.
 */
function latestConstraintDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const matches = files.filter((f) => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8');
    return sql.includes(`ADD CONSTRAINT ${CONSTRAINT}`);
  });

  expect(
    matches.length,
    `No migration defines ${CONSTRAINT}. If the constraint was intentionally ` +
      `dropped, delete this test with the migration that dropped it — do not ` +
      `leave a guard that silently protects nothing.`
  ).toBeGreaterThan(0);

  const file = matches[matches.length - 1];
  return { file, sql: readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8') };
}

/** Pull the quoted ids out of the `checklist_preset_id IN ( … )` list. */
function allowedIdsFrom(sql: string): string[] {
  const inList = sql.match(/checklist_preset_id\s+IN\s*\(([\s\S]*?)\)/i);
  expect(inList, `Could not find the IN (...) list for ${CONSTRAINT}`).not.toBeNull();
  return [...inList![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

describe('checklist preset catalog matches the database CHECK constraint', () => {
  it('HAPPY: every shipped preset id is accepted by the constraint', () => {
    const { file, sql } = latestConstraintDefinition();
    const allowed = allowedIdsFrom(sql);

    const missing = CHECKLIST_PRESET_IDS.filter((id) => !allowed.includes(id));

    expect(
      missing,
      `These preset ids ship in CHECKLIST_PRESET_IDS but the CHECK constraint in ` +
        `${file} rejects them: ${missing.join(', ')}.\n\n` +
        `Any tenant row set to one of these fails with "violates check constraint ` +
        `${CONSTRAINT}" — including the ops scripts under scripts/ that pin a ` +
        `preset in production. Add a migration that re-adds the constraint with ` +
        `the full list.`
    ).toEqual([]);
  });

  it('SAD: the constraint does not accept an id the code cannot produce', () => {
    const { file, sql } = latestConstraintDefinition();
    const allowed = allowedIdsFrom(sql);

    const orphaned = allowed.filter(
      (id) => !(CHECKLIST_PRESET_IDS as readonly string[]).includes(id)
    );

    expect(
      orphaned,
      `The CHECK constraint in ${file} accepts ${orphaned.join(', ')}, which no ` +
        `longer exists in CHECKLIST_PRESET_IDS. A tenant pinned to a preset the ` +
        `code does not recognize silently falls back to the business_type default ` +
        `— the exact invisible failure that hid the unreachable job tree.`
    ).toEqual([]);
  });
});
