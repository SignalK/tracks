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
  prettier,
)
