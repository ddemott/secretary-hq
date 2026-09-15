import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude dashboard tests — they have their own config with jsdom + React + @/ aliases.
    // Run dashboard tests separately: cd dashboard && npx vitest run
    exclude: [
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
    ],
    // DB integration tests share one Postgres instance and use TRUNCATE / savepoints for cleanup.
    // Parallel execution causes deadlocks (40P01) because TRUNCATE needs AccessExclusiveLock
    // while other test files hold RowShareLocks in open transactions. Sequential execution
    // ensures each file completes its cleanup before the next starts.
    fileParallelism: false,
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
