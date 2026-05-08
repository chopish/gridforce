// Flat config (ESLint v9+). Pulls in:
//   - @eslint/js recommended baseline
//   - typescript-eslint recommendedTypeChecked (one step below strict;
//     catches real issues without flagging stylistic preferences)
//   - eslint-config-prettier disables rules that conflict with formatting
//
// Lint runs across all three workspaces (shared/server/client). The
// projectService toggle auto-discovers each package's tsconfig so we
// don't have to enumerate them.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/server/.dist/**',
      // Vite's vite-env.d.ts is a triple-slash reference; nothing to lint.
      '**/vite-env.d.ts',
      // Vite/build configs sit outside the project tsconfigs and would
      // require a separate parser project to type-check. Not worth the
      // setup; they're tiny and rarely change.
      '**/vite.config.ts',
      '**/eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The `_` prefix is the established convention for intentionally
      // unused parameters/locals (e.g. interface impls that don't need
      // every arg). Match it; warn (not error) on real unused names.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // verbatimModuleSyntax expects type-only imports to be marked.
      // Auto-fixable, so this is low-friction.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      // Non-null assertion (!) is used liberally where invariants make a
      // value provably present (e.g. Map.get after a size check). Loud
      // warning is enough; banning would force noisy guards.
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // The integration tests legitimately assert numbers loosely; relax
      // float-comparison stylistic rules to avoid churn for no value.
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Empty catch blocks are the established "best-effort cleanup,
      // ignore failures" pattern (e.g. wrapping ws.close() in try/catch
      // because we don't care if it's already closed). Still flag empty
      // function bodies — those are usually accidents.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Tests can be looser. Particular pain point: `assert.equal` on union
  // types triggers some unsafe-* rules even though node:test's API is
  // typed enough to be safe in practice. node:test's `test()` returns
  // a promise the runner schedules — not awaiting is conventional.
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  prettierConfig,
);
