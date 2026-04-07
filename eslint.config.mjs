// @ts-check

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    name: 'mihomo-cli/base',
    ...js.configs.recommended,
  },
  {
    name: 'mihomo-cli/node',
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
    ignores: ['node_modules/', '.claude/', '.husky/', 'eslint.config.mjs'],
  },
];
