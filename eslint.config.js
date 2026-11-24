import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Node built-ins must never reach Worker or browser code (Cloudflare Workers are not Node).
const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'tls',
  'tty',
  'url',
  'util',
  'vm',
  'worker_threads',
  'zlib',
];
const noNodeImports = {
  'no-restricted-imports': [
    'error',
    {
      paths: NODE_BUILTINS.map((name) => ({
        name,
        message: 'Node-only API: not available on Cloudflare Workers or in the browser.',
      })),
      patterns: [
        {
          group: ['node:*'],
          message: 'Node-only API: not available on Cloudflare Workers or in the browser.',
        },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // Worker, shared and web production code: no Node built-ins.
    files: ['apps/api/src/**/*.ts', 'packages/shared/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}'],
    rules: noNodeImports,
  },
  {
    // The logger is the one place allowed to write to the console.
    files: ['apps/api/src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    extends: [jsxA11y.flatConfigs.recommended],
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // Test files: asserting on mocks and parsing JSON legitimately trips a few type-aware rules.
    files: ['**/*.test.{ts,tsx}', 'apps/api/test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // Node-side tooling (config files, scripts, e2e): Node globals and Node imports are fine.
    files: [
      '*.config.{js,ts}',
      'apps/*/vite.config.ts',
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'playwright.config.ts',
      'e2e/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
