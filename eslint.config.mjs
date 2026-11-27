// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.vscode-test/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      // Conflicts with promise-function-async for interface methods that resolve synchronously.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/require-array-sort-compare': ['error', { ignoreStringArrays: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
      ],
    },
  },
  {
    files: ['src/webview/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Test doubles (e.g. the vscode API stand-in) are typed by their usage.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  prettier,
);
