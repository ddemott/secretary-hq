/**
 * Vitest global setup: one Postgres database PER WORKER, cloned from a migrated + seeded template.
 *
 * Why: the DB-backed suites used to run one file at a time against a single shared `test_db`,
 * because tests TRUNCATE tables and share seed tenants (deadlocks, wiped rows — see the history
 * in vitest.config.mts). Giving each worker its own database removes the shared state, so files
 * run in parallel with no test changes. Per-worker databases cloned from a template is the
 * pattern most vitest/jest Postgres suites converge on (VITEST_POOL_ID picks the database).
 *
 * How:
 *  1. Build `test_db_tpl` (migrations + seed + question-tree templates) if missing or stale. It is
 *     keyed by a content fingerprint, so this costs ~10s only when a migration/seed changes.
 *     Nothing else connects to the template — Postgres refuses to clone a template that has
 *     other sessions — which is why we do NOT clone the everyday `test_db`.
 *  2. Clone it into WORKERS databases named `test_db_r<run>_<slot>` (unique per run, so two runs
 *     at once never collide). Cloning is serialised with an advisory lock: two clones of the
 *     same template cannot run at the same time.
 *  3. NO teardown. Dropping a database forces a checkpoint (~9s each, measured); six of them
 *     doubled the suite's wall time. Old run databases are dropped by a detached background
 *     process instead, and only once they are hours old so a concurrent run is never affected.
 *     CI runners are throwaway, so CI skips even that.
 *
 * Escape hatch: TEST_PER_WORKER_DB=0 runs everything serially against the one configured DB.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  TEMPLATE_DB,
  TEST_DB_PREFIX,
  assertLocalHost,
  newRunId,
  staleWorkerDbs,
  withDatabase,
  workerDbName,
} from './dbUrls';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Arbitrary key for the advisory lock that serialises template builds and clones. */
const LOCK_KEY = 7331001;

/** Everything the template's contents depend on. Any change here rebuilds the template. */
function fingerprint(): string {
  const hash = createHash('sha256');
  const add = (rel: string) => {
    hash
      .update(rel)
      .update('\0')
      .update(readFileSync(join(ROOT, rel)))
      .update('\0');
  };
  for (const file of readdirSync(join(ROOT, 'supabase/migrations')).sort()) {
    add(`supabase/migrations/${file}`);
  }
  for (const rel of ['supabase/seed.sql', 'scripts/setup-db.sh', 'scripts/seed-db.sh']) add(rel);
  add('scripts/seed-question-tree-templates.ts');
  const trees = 'agent/src/checklist';
  if (existsSync(join(ROOT, trees))) {
    for (const file of readdirSync(join(ROOT, trees)).sort()) {
      if (file.endsWith('.ts') && !file.endsWith('.test.ts')) add(`${trees}/${file}`);
    }
  }
  return `fp:${hash.digest('hex')}`;
}

function run(cmd: string, args: string[], databaseUrl: string): void {
  try {
    execFileSync(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(
      `test template build failed: ${cmd} ${args.join(' ')}\n${e.stderr || e.stdout || e.message}`
    );
  }
}

export default async function setup(): Promise<void> {
  if (process.env.TEST_PER_WORKER_DB === '0') return;
  // Several vitest projects share this file; only the first call in this process does the work.
  if (process.env.TEST_DB_RUN) return;

  const adminUrl =
    process.env.TEST_ADMIN_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5433/test_db';
  assertLocalHost(adminUrl);
  const maintenanceUrl = withDatabase(adminUrl, 'postgres');
  const workers = Math.max(1, Number(process.env.TEST_WORKERS ?? 6));
  const started = Date.now();

  const admin = new pg.Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const fp = fingerprint();
    const current = await admin.query<{ comment: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`,
      [TEMPLATE_DB]
    );
    const reuse = current.rows[0]?.comment === fp;
    if (!reuse) {
      const templateUrl = withDatabase(adminUrl, TEMPLATE_DB);
      await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
      run('bash', ['scripts/setup-db.sh'], templateUrl);
      run('bash', ['scripts/seed-db.sh'], templateUrl);
      run('npm', ['run', 'trees:seed', '--silent'], templateUrl);
      // Stamp last: a half-built template must never look current.
      await admin.query(`COMMENT ON DATABASE ${TEMPLATE_DB} IS '${fp}'`);
    }

    const runId = newRunId();
    for (let slot = 1; slot <= workers; slot++) {
      await admin.query(`CREATE DATABASE ${workerDbName(runId, slot)} TEMPLATE ${TEMPLATE_DB}`);
    }
    process.env.TEST_DB_RUN = runId;

    if (!process.env.CI) {
      const all = await admin.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE $1`,
        [`${TEST_DB_PREFIX}\\_r%`]
      );
      const stale = staleWorkerDbs(all.rows.map((r) => r.datname));
      if (stale.length > 0) {
        // Detached and unref'd on purpose: nothing waits for the drops (each forces a checkpoint).
        const script = stale
          .map(
            (name) => `psql "$MAINTENANCE_URL" -Atqc "DROP DATABASE IF EXISTS ${name} WITH (FORCE)"`
          )
          .join('; ');
        spawn('bash', ['-c', script], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, MAINTENANCE_URL: maintenanceUrl },
        }).unref();
      }
    }

    console.log(
      `[test-db] template ${reuse ? 'reused' : 'rebuilt'}; cloned ${workers} worker databases ` +
        `(run ${runId}) in ${Date.now() - started} ms`
    );
  } finally {
    await admin.end();
  }
}
