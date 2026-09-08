import { defineConfig } from 'vitest/config'

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
})
