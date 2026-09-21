/**
 * Pure helpers for the per-worker test database setup (see globalSetup.ts).
 * Kept free of side effects so they can be unit-tested (tests/setup/dbUrls.test.ts).
 */

/** Every test database name starts with this; tests/utils.ts keys off `test_db` in the URL. */
export const TEST_DB_PREFIX = 'test_db';
/** Migrated + seeded template that the per-worker databases are cloned from. */
export const TEMPLATE_DB = `${TEST_DB_PREFIX}_tpl`;
/** Per-worker databases are dropped by the background reaper once older than this. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

const WORKER_DB = new RegExp(`^${TEST_DB_PREFIX}_r([0-9a-z]+)_(\\d+)$`);

/** Default worker count; also what an unset or unusable TEST_WORKERS falls back to. */
export const DEFAULT_WORKERS = 6;
/** Upper bound so a typo like TEST_WORKERS=1000 cannot try to clone a thousand databases. */
export const MAX_WORKERS = 32;

/**
 * TEST_WORKERS as a whole number in 1..MAX_WORKERS. Anything else (unset, empty, non-numeric,
 * zero, negative) falls back to the default: `Math.max(1, Number('abc'))` is NaN, which would
 * skip cloning every worker database while still pointing workers at them.
 */
export function parseWorkerCount(
  raw: string | undefined,
  fallback: number = DEFAULT_WORKERS
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_WORKERS);
}

/** Same connection string, different database name (credentials/host/query kept). */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/** `test_db_r<base36 start time>_<worker slot>` — unique per test run, so concurrent runs never collide. */
export function workerDbName(runId: string, slot: number | string): string {
  return `${TEST_DB_PREFIX}_r${runId}_${slot}`;
}

export function newRunId(now: number = Date.now()): string {
  return now.toString(36);
}

/** Worker databases whose run started more than `STALE_AFTER_MS` ago. Ignores every other name. */
export function staleWorkerDbs(names: string[], now: number = Date.now()): string[] {
  return names.filter((name) => {
    const match = WORKER_DB.exec(name);
    if (!match) return false;
    const startedAt = parseInt(match[1], 36);
    return Number.isFinite(startedAt) && now - startedAt > STALE_AFTER_MS;
  });
}

/** Local databases only — this setup creates and drops databases, so it must never point at a remote one. */
export function assertLocalHost(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(
      `Refusing to create per-worker test databases on non-local host "${host}". ` +
        'Point DATABASE_URL / TEST_ADMIN_DATABASE_URL at a local Postgres, or set TEST_PER_WORKER_DB=0.'
    );
  }
}

/**
 * The four env vars the tests read for a database URL, re-pointed at `database`.
 * Credentials come from whatever the environment already set; defaults match the
 * local Docker DB and the CI service container.
 */
export function workerEnv(
  env: NodeJS.ProcessEnv,
  database: string
): Record<
  'DATABASE_URL' | 'TEST_DATABASE_URL' | 'TEST_ADMIN_DATABASE_URL' | 'TEST_APP_USER_DATABASE_URL',
  string
> {
  const admin =
    env.TEST_ADMIN_DATABASE_URL ||
    env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5433/test_db';
  const adminUrl = withDatabase(admin, database);
  const appUserBase =
    env.TEST_APP_USER_DATABASE_URL ||
    (() => {
      const u = new URL(admin);
      u.username = 'app_user';
      u.password = 'app_user';
      return u.toString();
    })();
  return {
    DATABASE_URL: adminUrl,
    TEST_DATABASE_URL: adminUrl,
    TEST_ADMIN_DATABASE_URL: adminUrl,
    TEST_APP_USER_DATABASE_URL: withDatabase(appUserBase, database),
  };
}
