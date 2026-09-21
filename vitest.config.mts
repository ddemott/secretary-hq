import { defineConfig } from 'vitest/config';

const perWorkerDb = process.env.TEST_PER_WORKER_DB !== '0';
const workers = perWorkerDb ? Math.max(1, Number(process.env.TEST_WORKERS ?? 6)) : 1;

// restoreRoleGrants.test.ts runs `ALTER ROLE api_user BYPASSRLS` — a cluster-wide change that
// every worker's database would see while its own RLS tests run.
const SERIAL_FILES = ['tests/scripts/restoreRoleGrants.test.ts'];

const BASE_EXCLUDE = [
  'dashboard/**',
  'node_modules/**',
  'supabase/**',
  // Agent package is tested via its own config. Its node_modules
  // contains third-party tests (LiveKit agents SDK) that fail in
  // isolation without their own fixtures.
  'agent/**',
  // Untracked, full nested repo checkouts created by `git worktree add`
  // for isolated agent sessions (Agent tool `isolation: "worktree"`).
  // Without this, `vitest run tests/ scripts/` from the main checkout
  // discovers and re-runs the ENTIRE suite again once per accumulated
  // worktree — measured 2026-09-14 with 2 stray worktrees present:
  // 27,735 tests instead of the real ~3,186 (9x), each copy hitting the
  // SAME shared local test_db concurrently. That is what several
  // `*_tenant_id_fkey` violation failures this session were actually
  // caused by (one suite's cleanup truncating rows a concurrent copy's
  // test was mid-transaction on) — not real regressions, and not
  // "too many agent sessions running in parallel" as first assumed.
  '.claude/**',
  // Same failure mode, different convention: ad hoc `git worktree add
  // .worktrees/<name>` (not under `.claude/`) used directly by a session
  // rather than the Agent tool's own isolation mechanism.
  '.worktrees/**',
];

export default defineConfig({
  test: {
    // Exclude dashboard tests — they have their own config with jsdom + React + @/ aliases.
    // Run dashboard tests separately: cd dashboard && npx vitest run
    exclude: BASE_EXCLUDE,
    // DB-backed test files run IN PARALLEL, each worker on its OWN database.
    //
    // History: they used to run one file at a time against one shared `test_db`, because tests
    // TRUNCATE tables and share seed tenants — parallel files deadlocked (40P01: TRUNCATE needs
    // AccessExclusiveLock while other files hold RowShareLocks) or wiped rows a concurrent file
    // was mid-test on. tests/setup/globalSetup.ts now clones a migrated + seeded template into one
    // database per worker and tests/setup/perWorkerDb.ts points each worker's DB env vars at its
    // own (VITEST_POOL_ID), so those collisions cannot happen. Measured on a 28-core machine:
    // 259s serial -> 73s wall with 6 workers, all 280 files / 3356 tests passing.
    //
    // TEST_WORKERS sets the worker count (default 6). TEST_PER_WORKER_DB=0 is the escape hatch:
    // one worker, one file at a time, against the single DB in DATABASE_URL (the old behaviour).
    fileParallelism: perWorkerDb,
    maxWorkers: workers,
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/perWorkerDb.ts'],
    // Files that change CLUSTER-WIDE state (roles are shared by every database, so per-worker
    // databases cannot isolate them) run alone, after the parallel project has finished.
    projects: [
      {
        extends: true,
        test: {
          name: 'parallel',
          exclude: [...BASE_EXCLUDE, ...SERIAL_FILES],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL_FILES,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    // CI runners are materially slower on real-DB suite setup/teardown than local.
    // Several files do heavy beforeAll/beforeEach work (clearDB, migrations-shaped
    // fixture setup, RLS client wiring) and were tripping Vitest's default 10s
    // hook timeout despite green local/full runs. Raise HOOK timeout only; this
    // is not a license for slower test bodies.
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Source code only — exclude tests, vendored, and runtime-only files
      include: ['src/**', 'shared/**'],
      exclude: [
        '**/*.test.ts',
        'tests/**',
        '**/test-utils*.ts',
        'src/types/**',
        'dist/**',
        'node_modules/**',
      ],
      // Output to coverage_data/ (already in .gitignore)
      reportsDirectory: './coverage_data',
    },
  },
});
