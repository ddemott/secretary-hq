/**
 * Guard for `find-abandoned-test-numbers.ts`'s `--older-than` age guard.
 *
 * Same class of bug this pattern already caught once in `purge-soft-deleted.ts`
 * (PR #351): `valueOf` returns `undefined` both when a flag was never passed
 * and when it was passed last with nothing after it, so a naive parse treats
 * "operator typed the flag" the same as "operator never touched it" — here
 * that would silently fall back to the default 14-day window instead of
 * refusing. This script is read-only (it never touches Telnyx or writes to
 * the DB), so a dropped guard costs a misleading report rather than a
 * destructive action — but a misleading report about which numbers are
 * "abandoned" is still the wrong answer to give an operator about to release
 * a real phone number.
 *
 * Driven as a subprocess (same approach as `purge-soft-deleted.test.ts`)
 * because the guard runs at module scope and calls `process.exit`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'find-abandoned-test-numbers.ts');

// See purge-soft-deleted.test.ts for why these two constants are set this
// way and kept apart by a margin: npx tsx pays resolution + compile before a
// line of the script runs, and the margin lets spawnSync's own timeout always
// win the race against vitest's, so a genuine hang is reported with an exit
// status and output instead of a bare "timed out" that names nothing.
const SUBPROCESS_BUDGET_MS = 60_000;
const SUBPROCESS_TEST_TIMEOUT_MS = SUBPROCESS_BUDGET_MS + 5_000;

function run(args: string[]) {
  return spawnSync('npx', ['tsx', SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: SUBPROCESS_BUDGET_MS,
    // The age guard runs BEFORE any connection, so a rejected value must exit
    // non-zero without ever attempting to connect — point DATABASE_URL at a
    // deliberately unreachable host so a test can never touch a real database.
    env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nonexistent' },
  });
}

describe('find-abandoned-test-numbers --older-than guard', () => {
  it(
    'SAD: refuses a non-numeric age instead of silently using the default window',
    () => {
      const res = run(['--older-than', 'abc']);
      expect(res.status).not.toBe(0);
      expect(`${res.stderr}${res.stdout}`).toMatch(/--older-than expects a non-negative number/);
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );

  it(
    'SAD: refuses a negative age',
    () => {
      const res = run(['--older-than', '-5']);
      expect(res.status).not.toBe(0);
      expect(`${res.stderr}${res.stdout}`).toMatch(/--older-than expects a non-negative number/);
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );

  it(
    'SAD: refuses --older-than passed with NO value at all',
    () => {
      const res = run(['--older-than']);
      expect(res.status).not.toBe(0);
      expect(`${res.stderr}${res.stdout}`).toMatch(/--older-than was passed with no value/);
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );

  it(
    'SAD: refuses --older-than immediately followed by another flag',
    () => {
      const res = run(['--older-than', '--db']);
      expect(res.status).not.toBe(0);
      expect(`${res.stderr}${res.stdout}`).toMatch(/--older-than was passed with no value/);
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );

  it(
    'HAPPY: a valid age is accepted (fails later, at the DB, not at the guard)',
    () => {
      const res = run(['--older-than', '30']);
      expect(`${res.stderr}${res.stdout}`).not.toMatch(/--older-than expects/);
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );

  it(
    'SAD: refuses when no database is configured at all',
    () => {
      const res = spawnSync('npx', ['tsx', SCRIPT], {
        encoding: 'utf-8',
        timeout: SUBPROCESS_BUDGET_MS,
        env: { ...process.env, DATABASE_URL: '' },
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stderr}${res.stdout}`).toMatch(/no database/);
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );
});
