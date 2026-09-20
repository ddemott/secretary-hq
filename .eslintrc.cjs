/**
 * Backend ESLint config — extends @typescript-eslint/recommended-type-checked,
 * the official preset from the TypeScript team that uses the type-checker
 * to catch real bugs `tsc` alone misses (floating promises, misused promises,
 * unsafe-any propagation).
 *
 * Scope: src/, shared/, scripts/. Tests are linted too — same rules apply.
 * Agent has its own config under agent/.eslintrc.cjs. Dashboard layers
 * these rules on top of next/core-web-vitals in dashboard/.eslintrc.json.
 *
 * Coexists with the in-progress any-types cleanup (commits
 * `chore(types): clean up backend any-types — batch N`): the `no-explicit-any`
 * family is set to `warn` so existing sites are visible in CI output
 * without blocking green builds. Flip to `error` once the cleanup lands.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // tsconfig.eslint.json includes test files + scripts/ + tests/ which
    // the main tsconfig.json excludes from the build. Without this,
    // ESLint can't type-check those files and falls back to parsing
    // errors. Keep tsconfig.json as the build's source of truth.
    project: ['./tsconfig.eslint.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended-type-checked'],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    'coverage_data/',
    'dashboard/',
    'agent/',
    'supabase/',
    'docs/',
    // Runtime-only, never tracked in git: full nested checkouts created by
    // `git worktree add` for isolated agent sessions (see Agent tool
    // `isolation: "worktree"`). None of these files are in
    // tsconfig.eslint.json's `include` (which only matches root-relative
    // src/**, shared/**, scripts/**, tests/**), so `eslint .` was enumerating
    // every nested copy's source tree as lint targets it can't actually
    // resolve a TS project for — pure waste at best. Found 2026-09-14 while
    // debugging a full-repo `eslint .` OOM during a multi-agent batch with
    // several worktrees accumulated; this exclusion is correct hygiene
    // regardless, but did NOT fully explain the OOM on its own (it still
    // reproduced under an 8GB NODE_OPTIONS override after this fix — some
    // other factor, not isolated further, accounts for the rest. 16GB
    // cleared it). Same class of exclusion as the dashboard/agent/supabase/
    // docs sibling trees above. `.worktrees/` is the same failure mode via
    // a different convention: ad hoc `git worktree add .worktrees/<name>`
    // used directly by a session rather than the Agent tool's own
    // `.claude/` isolation mechanism — vitest.config.mts already excludes
    // both (`.claude/**` + `.worktrees/**`); this list needed to match.
    '.claude/',
    '.worktrees/',
    '*.config.js',
    '*.config.cjs',
    '*.config.ts',
    // Standalone node scripts (simulate harness helpers) aren't in the
    // tsconfig.eslint project, so typed linting can't parse them. They're plain
    // node ESM run directly, not part of the build.
    '*.mjs',
    'scripts/**/*.mjs',
  ],
  rules: {
    // ── In-progress cleanup: warn, not error ─────────────────────────
    // The backend has an active any-types cleanup series. These rules
    // surface remaining sites without blocking CI. Promote to 'error'
    // once `noImplicitAny: true` lands in tsconfig.json (currently
    // explicitly set to false as a transition carve-out).
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',

    // ── Real-bug catchers ─────────────────────────────────────────────
    // These catch entire bug classes that tsc + unit tests routinely miss.
    // First pass lands them as `warn` so the existing surface is visible
    // (27 floating promises, 15 require-await, etc.) without blocking
    // CI. Promote to 'error' per family once the count hits zero — same
    // play as the no-explicit-any cleanup.
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': [
      'error',
      {
        // Allow void-returning async handlers in places that expect
        // void callbacks (e.g., Fastify route handlers — handled via
        // `withHandler`, so the floating-promise check is enough).
        checksVoidReturn: false,
      },
    ],
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/require-await': 'error',
    '@typescript-eslint/restrict-template-expressions': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-base-to-string': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // Allow unused destructured siblings — common when extracting a
        // single field: `const { foo, ...rest } = obj`.
        ignoreRestSiblings: true,
      },
    ],
    '@typescript-eslint/consistent-type-imports': [
      'error',
      {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      },
    ],
    // `require()` in .cjs config files is normal; turn off the rule
    // entirely rather than try to scope it per-file.
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    // Catches passing a class/interface method as a value without binding
    // `this` (a real runtime-crash bug class). The codebase is clean of it, so
    // this is enforced as an error to keep it that way. (The historical
    // "fires heavily in test spies" concern never materialized — vitest's
    // `vi.fn()` mocks are plain object properties, which the rule ignores.)
    '@typescript-eslint/unbound-method': 'error',
    'no-constant-condition': ['warn', { checkLoops: false }],
  },
  overrides: [
    {
      // Tests can use looser rules — fixtures often need any-shapes
      // to model unhappy paths the production types don't allow.
      files: [
        '**/*.test.ts',
        '**/*.spec.ts',
        'src/test-utils*.ts',
        'tests/utils.ts',
        'tests/mock.ts',
      ],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        // Tests use `expect(value).toBe(...)` patterns that
        // typescript-eslint sometimes flags as await-thenable false-positives.
        '@typescript-eslint/await-thenable': 'off',
        // Mock fetch / nodemailer / repository shapes routinely declare
        // `async () => data` because the interface they satisfy returns
        // Promise<T>. Rewriting hundreds of test mocks to `() =>
        // Promise.resolve(data)` adds noise without catching bugs (these
        // are intentional Promise-returning stubs, not forgotten awaits).
        '@typescript-eslint/require-await': 'off',
      },
    },
  ],
};
