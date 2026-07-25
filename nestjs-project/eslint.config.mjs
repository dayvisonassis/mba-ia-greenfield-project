// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // `unbound-method` is a known false positive on Jest assertions: passing a
    // mocked method reference to `expect(...)` is the idiomatic form, and the
    // rule cannot tell it apart from a genuinely unbound call. typescript-eslint
    // documents this and points to eslint-plugin-jest's variant of the rule.
    // Scoped to test files only — production code keeps the rule enforced.
    files: [
      '**/*.spec.ts',
      '**/*.integration-spec.ts',
      '**/*.e2e-spec.ts',
      'test/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
