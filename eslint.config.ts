import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'public', '.vitest-worker', 'coverage'] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The page's event handlers are async and handle their own failures; the
    // browser ignores what a listener returns, and the tests await it.
    files: ['web/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    },
  },
  {
    files: [
      '**/*.test.ts',
      '**/*.test-utils.ts',
      'vite.config.ts',
      'vite.web.config.ts',
      'vitest.e2e.config.ts',
      'eslint.config.ts',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The repository is TypeScript only: a JavaScript source would ship
    // unchecked by tsc.
    files: ['**/*.{js,mjs,cjs,jsx}'],
    ...tseslint.configs.disableTypeChecked,
    plugins: {
      local: {
        rules: {
          'no-javascript': {
            meta: { type: 'problem', schema: [] },
            create: (context) => ({
              Program: (node) =>
                context.report({
                  node,
                  message: 'Write this in TypeScript: the repository has no JavaScript sources.',
                }),
            }),
          },
        },
      },
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'local/no-javascript': 'error' },
  },
  prettier,
)
