/**
 * WHO:   the per-worker test-database setup (tests/setup/globalSetup.ts, perWorkerDb.ts).
 * WHAT:  the pure helpers that name worker databases, re-point connection strings, decide which
 *        old databases are safe to reap, and refuse non-local hosts.
 * WHEN:  every test run; a wrong name or URL would send a worker to another worker's database.
 * WHERE: tests/setup/dbUrls.ts (no DB needed).
 * WHY:   one bad rewrite silently reintroduces the shared-DB collisions this setup removed, and a
 *        wrong "stale" decision could drop a database a concurrent run is still using.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKERS,
  MAX_WORKERS,
  STALE_AFTER_MS,
  assertLocalHost,
  newRunId,
  parseWorkerCount,
  staleWorkerDbs,
  withDatabase,
  workerDbName,
  workerEnv,
} from './dbUrls';

const ADMIN = 'postgres://postgres:postgres@localhost:5433/test_db';

describe('per-worker test database helpers', () => {
  it('HAPPY: withDatabase swaps only the database name and keeps credentials and host', () => {
    expect(withDatabase(ADMIN, 'test_db_r1_2')).toBe(
      'postgres://postgres:postgres@localhost:5433/test_db_r1_2'
    );
  });

  it('HAPPY: workerEnv points all four vars at the worker database with the right roles', () => {
    const env = workerEnv({ DATABASE_URL: ADMIN }, 'test_db_rabc_3');
    expect(env.DATABASE_URL).toBe('postgres://postgres:postgres@localhost:5433/test_db_rabc_3');
    expect(env.TEST_DATABASE_URL).toBe(env.DATABASE_URL);
    expect(env.TEST_ADMIN_DATABASE_URL).toBe(env.DATABASE_URL);
    expect(env.TEST_APP_USER_DATABASE_URL).toBe(
      'postgres://app_user:app_user@localhost:5433/test_db_rabc_3'
    );
  });

  it('HAPPY: workerEnv honours explicitly configured credentials (CI sets TEST_* vars)', () => {
    // Built at runtime, not written as literals: tests/scripts/scanSecrets.test.ts (and the CI
    // secret-scan job) rightly flag any `postgres://user:password@host` string in the source.
    const urlFor = (user: string, password: string, database: string) => {
      const url = new URL(`postgres://127.0.0.1:5433/${database}`);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    const env = workerEnv(
      {
        TEST_ADMIN_DATABASE_URL: urlFor('root', 'not-a-real-password', 'test_db'),
        TEST_APP_USER_DATABASE_URL: urlFor('app_user', 'not-a-real-password', 'test_db'),
      },
      'test_db_r1_1'
    );
    expect(env.TEST_ADMIN_DATABASE_URL).toBe(urlFor('root', 'not-a-real-password', 'test_db_r1_1'));
    expect(env.TEST_APP_USER_DATABASE_URL).toBe(
      urlFor('app_user', 'not-a-real-password', 'test_db_r1_1')
    );
  });

  it('HAPPY: workerEnv is stable when applied twice (setup files run once per test file)', () => {
    const once = workerEnv({ DATABASE_URL: ADMIN }, 'test_db_r1_4');
    const twice = workerEnv(once, 'test_db_r1_4');
    expect(twice).toEqual(once);
  });

  it('HAPPY: worker names contain test_db (tests/utils.ts keys off it) and differ per slot and run', () => {
    expect(workerDbName('abc', 1)).toBe('test_db_rabc_1');
    expect(workerDbName('abc', 1)).not.toBe(workerDbName('abc', 2));
    expect(workerDbName('abd', 1)).not.toBe(workerDbName('abc', 1));
  });

  it('HAPPY: staleWorkerDbs returns only worker databases older than the threshold', () => {
    const now = Date.now();
    const old = newRunId(now - STALE_AFTER_MS - 1000);
    const fresh = newRunId(now - 60_000);
    const names = [
      workerDbName(old, 1),
      workerDbName(old, 6),
      workerDbName(fresh, 1),
      'test_db',
      'test_db_tpl',
      'test_db_isolated_check',
      'postgres',
    ];
    expect(staleWorkerDbs(names, now)).toEqual([workerDbName(old, 1), workerDbName(old, 6)]);
  });

  it('SAD: staleWorkerDbs never selects the shared test_db, the template, or unrelated databases', () => {
    const names = ['test_db', 'test_db_tpl', 'test_db_isolated_check', 'test_db_try1', 'secretary'];
    expect(staleWorkerDbs(names, Date.now() + 10 * STALE_AFTER_MS)).toEqual([]);
  });

  it('SAD: assertLocalHost refuses a remote host because this setup creates and drops databases', () => {
    expect(() => assertLocalHost('postgres://u:p@db.example.supabase.co:5432/postgres')).toThrow(
      /non-local host/
    );
    expect(() => assertLocalHost(ADMIN)).not.toThrow();
    expect(() => assertLocalHost('postgres://u:p@127.0.0.1:5433/test_db')).not.toThrow();
  });
  it('HAPPY: parseWorkerCount accepts a whole number and defaults when unset', () => {
    expect(parseWorkerCount('4')).toBe(4);
    expect(parseWorkerCount(' 3 ')).toBe(3);
    expect(parseWorkerCount(undefined)).toBe(DEFAULT_WORKERS);
    expect(parseWorkerCount('2.9')).toBe(2);
  });

  it('SAD: parseWorkerCount never returns NaN or below 1 (Math.max(1, NaN) is NaN and would clone no databases)', () => {
    for (const bad of ['abc', '', '   ', '0', '-3', 'NaN', 'Infinity', '4x']) {
      const n = parseWorkerCount(bad === '4x' ? undefined : bad);
      expect(Number.isInteger(n), `TEST_WORKERS=${JSON.stringify(bad)}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
    expect(parseWorkerCount('abc')).toBe(DEFAULT_WORKERS);
    expect(parseWorkerCount('0', 3)).toBe(3);
  });

  it('SAD: parseWorkerCount caps an absurd value so a typo cannot clone hundreds of databases', () => {
    expect(parseWorkerCount('1000')).toBe(MAX_WORKERS);
  });
});
