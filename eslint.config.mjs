// SPDX-License-Identifier: MIT
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'vendor/**',
      '**/fixtures/**',
      'eval/corpus*/**',
      'eval/dev/**',
      'eval/holdout/**',
      'demo-vault/**',
      'templates/**',
      'release/dist/**',
      'dist-release/**',
      '.tmp/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }]
    }
  }
];
