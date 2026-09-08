/**
 * Playwright global setup — fires once before any spec runs.
 *
 * Rebuilds the database end-to-end via `scripts/rebuild-db.sh`:
 *   DROP SCHEMA public CASCADE
 *   → apply all migrations in order (tables, FKs, PKs, RLS, GRANTs,
 *     functions, triggers, indexes, types, extensions)
 *   → apply supabase/seed.sql (bare-bones tenants + owners + Bella's Hair Studio
 *     business owner user)
 *
 * Every E2E run therefore starts from identical, validated state —
 * cross-spec data pollution is structurally impossible, AND the
 * migration chain is exercised before any test runs (so a broken
 * migration fails loudly here instead of mid-spec). ~15-30s overhead
 * per full E2E invocation.
 *
 * Skip the reset by setting `PLAYWRIGHT_SKIP_DB_RESET=1` (useful when
 * iterating against a hand-set-up state you don't want clobbered).
 *
 * Why the rebuild script instead of a faster TRUNCATE: the
 * truncate-and-reseed shortcut (~1-2s) skips the migration chain
 * entirely, so a future migration regression would only surface on
 * the next CI `db:rebuild` rather than on the dev loop. User locked
 * in 2026-05-18: "this should be everything including creating the
 * tables, relationships, PKs, FKs, even permissions, roles, etc."
 * The 30s overhead pays for full correctness.
 */
import { spawnSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const BACKEND_URL = process.env.BACKEND_URL ?? 'https://localhost:4000';
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Hosts an E2E run is allowed to touch. Mirrors the allowlist in
 * scripts/rebuild-db.sh so the two guards cannot drift into disagreeing about
 * what "local" means. `db` / `postgres` / `secretary-hq-db` are container hostnames
 * (docker-compose, CI service containers).
 */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '',
  'db',
  'postgres',
  'secretary-hq-db',
]);

function hostOf(url: string): string {
  try {
    // postgres:// URLs parse fine as URL; hostname strips creds/port/db name.
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    // Unparseable → treat as suspicious rather than safe.
    return url;
  }
}

/**
 * REFUSE TO RUN AGAINST ANYTHING THAT ISN'T LOCAL.
 *
 * rebuild-db.sh already refuses to DROP SCHEMA a non-local host without
 * --force, and globalSetup never passes --force — so the database WIPE was
 * already guarded. This closes the other half, which was not guarded at all:
 * the SPECS' own targets. Every spec builds its world through
 * `registerFreshTenant` (POST /register against BACKEND_URL) and tears it down
 * through `cleanTenantData` (DELETE FROM tenants against PG_URL, which cascades
 * to every appointment, customer, message and consent record beneath it).
 *
 * Point BACKEND_URL or DATABASE_URL at production and the suite does not fail —
 * it succeeds, against the wrong database, creating ~40 junk tenants and
 * cascade-deleting each one. Nothing in the run would look wrong.
 *
 * There is deliberately NO bypass flag. Testing a remote deployment is a real
 * need, and it already has the right tool: `scripts/simulate.sh --env prod`,
 * which drives an ephemeral demo tenant instead of assuming a disposable
 * database. A destructive default with an easy override is how the accident
 * happens; if you genuinely mean to aim these specs elsewhere, edit this list
 * and say so in the commit.
 */
function assertLocalTargets(): void {
  const targets: Array<{ label: string; value: string }> = [
    { label: 'BACKEND_URL', value: BACKEND_URL },
    {
      label: 'DATABASE_URL',
      value: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres',
    },
  ];
  if (process.env.DASHBOARD_URL) {
    targets.push({ label: 'DASHBOARD_URL', value: process.env.DASHBOARD_URL });
  }

  const remote = targets.filter((t) => !LOCAL_HOSTS.has(hostOf(t.value)));
  if (remote.length === 0) return;

  throw new Error(
    [
      '[globalSetup] REFUSING TO RUN — the E2E suite is pointed at a non-local target.',
      ...remote.map((t) => `  ${t.label} → host "${hostOf(t.value)}"`),
      '',
      'These specs register tenants and then DELETE FROM tenants, which cascades to',
      'every appointment, customer, message and consent record under them. Against a',
      'real deployment the suite would PASS while destroying data.',
      '',
      `Allowed hosts: ${[...LOCAL_HOSTS].filter(Boolean).join(', ')}`,
      'To exercise a deployed environment, use: ./scripts/simulate.sh tools --env prod',
    ].join('\n')
  );
}

/**
 * Recursively find the newest mtime under a directory tree. Used to
 * detect when source files have been edited after the backend process
 * was last started (which means dist/ AND the running process are both
 * older than the bytes on disk → a rebuild + restart is owed).
 */
function newestMtime(dir: string): number {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      const sub = newestMtime(full);
      if (sub > max) max = sub;
    } else if (entry.isFile()) {
      const m = statSync(full).mtimeMs;
      if (m > max) max = m;
    }
  }
  return max;
}

/**
 * Check that the running backend was started AFTER the most-recently-
 * modified file under src/. If src is newer, the backend is serving an
 * older binary than the test suite assumes and any "false-red E2E"
 * mystery is going to look like a flake instead of a stale-dist issue.
 *
 * Bypass via PLAYWRIGHT_SKIP_BACKEND_STALENESS_CHECK=1 for niche cases
 * where you genuinely want to test against an older backend (e.g.
 * reproducing a regression).
 */
async function assertBackendFresh(): Promise<void> {
  if (process.env.PLAYWRIGHT_SKIP_BACKEND_STALENESS_CHECK === '1') return;

  let startedAt: string | undefined;
  try {
    // Self-signed cert on https://localhost:4001 — bypass via env var
    // so we don't have to wire a global rejectUnauthorized override.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const res = await fetch(`${BACKEND_URL}/api/health`);
    const body = (await res.json()) as { started_at?: string; status?: string };
    startedAt = body.started_at;
  } catch (err) {
    throw new Error(
      `[globalSetup] could not reach ${BACKEND_URL}/api/health to verify backend freshness: ${
        err instanceof Error ? err.message : String(err)
      }. Start the backend (\`npm start\` from the repo root) and re-run.`
    );
  }

  if (!startedAt) {
    // Older backend deploys don't expose started_at — treat as a soft
    // warning instead of a hard fail. The watchdog still helps next
    // time around once the backend is updated.
    console.warn(
      '[globalSetup] /health did not include started_at — backend may be older than the staleness guard. Skipping check.'
    );
    return;
  }

  const backendMs = Date.parse(startedAt);
  const srcMs = newestMtime(join(REPO_ROOT, 'src'));
  if (Number.isNaN(backendMs) || srcMs === 0) return;

  if (srcMs > backendMs) {
    const lagSeconds = Math.round((srcMs - backendMs) / 1000);
    throw new Error(
      [
        `[globalSetup] STALE BACKEND DETECTED — running process is ${lagSeconds}s older than src/.`,
        `Backend started_at: ${startedAt}`,
        `Newest src/ mtime: ${new Date(srcMs).toISOString()}`,
        '',
        'TypeScript edits in src/ compile into dist/, but the running `node dist/src/index.js`',
        'process holds the OLD code in memory until killed + restarted. Run:',
        '',
        '  npm start                                                       (kills + rebuilds + restarts everything)',
        '  kill $(lsof -ti :4001) && npm run build && node dist/src/index.js &  (surgical)',
        '',
        'See CLAUDE.md Build Principles → "Backend code changes require BOTH a rebuild AND a restart."',
      ].join('\n')
    );
  }
}

export default async function globalSetup() {
  // FIRST, before anything reaches out or rebuilds: prove we are aimed at a
  // disposable local stack. Everything below this line is destructive or
  // assumes it may be.
  assertLocalTargets();

  await assertBackendFresh();

  if (process.env.PLAYWRIGHT_SKIP_DB_RESET === '1') {
    console.log('[globalSetup] PLAYWRIGHT_SKIP_DB_RESET=1 — keeping current DB state.');
    return;
  }
  const script = resolve(__dirname, '..', '..', 'scripts', 'rebuild-db.sh');
  console.log(
    `[globalSetup] rebuilding DB from scratch via ${script} — this validates the migration chain too.`
  );
  const result = spawnSync('bash', [script, '--yes'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`[globalSetup] rebuild-db.sh exited ${result.status}; aborting test run`);
  }
}
