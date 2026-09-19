const Module = require('node:module');

const originalLoad = Module._load;
const ts6 = require('typescript-eslint-ts6');

Module._load = function patchedTypescript(request, parent, isMain) {
  if (request === 'typescript') return ts6;
  return originalLoad.call(this, request, parent, isMain);
};

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

Module._load = originalLoad;

const typedRecommended = tsPlugin.configs['recommended-type-checked']?.rules ?? {};

module.exports = [
  {
    ignores: [
      'dist/',
      'node_modules/',
      // Nested full-repo checkouts made by `git worktree add` for isolated agent
      // sessions. Without this `eslint .` lints every accumulated worktree's src/
      // too and dies with a 4 GB heap OOM (which blocked pre-push 2026-09-18);
      // vitest.config.mts excludes the same directory for the same reason.
      '.claude/',
      'coverage/',
      'coverage_data/',
      'dashboard/',
      'agent/',
      'supabase/',
      'docs/',
      '*.config.js',
      '*.config.cjs',
      '*.config.ts',
      '*.mjs',
      'scripts/**/*.mjs',
    ],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'shared/**/*.ts', 'shared/**/*.tsx', 'scripts/**/*.ts', 'scripts/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...typedRecommended,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      }],
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/unbound-method': 'error',
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', 'src/test-utils*.ts', 'tests/utils.ts', 'tests/mock.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
];
