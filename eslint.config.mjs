/**
 * Minimal lint gate: correctness rules that keep the two halves honest.
 *
 * `noUnusedLocals` in tsconfig already covers dead code; what it cannot see is
 * the React side — hook dependency lists and the rules of hooks — plus the
 * usual `no-undef`-class mistakes in the .mjs scripts. Deliberately NOT a
 * style linter: formatting is not policed here.
 *
 * Scope: source, scripts and the build config. Build output (lib/) is
 * generated and ignored; .workspace/ is scratch.
 */
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['lib/**', 'node_modules/**', '.workspace/**', 'report-output/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: { globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      // Underscore-prefixed names are the codebase's "intentionally unused".
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      // The two halves share one lint run: Node globals for the Host half and
      // the browser globals for the client half (the client bundle is loaded
      // into the harness web page).
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', {
        // Provider callbacks must keep their declared signature even when a
        // parameter goes unused (e.g. dsh-skill's `list(_options)`).
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Diagnostics in this plugin are deliberate and rare: every one carries
      // an inline disable explaining why, so a stray console.log is a smell.
      'no-console': 'warn',
    },
  },
)
