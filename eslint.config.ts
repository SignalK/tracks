import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
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
    files: ['**/*.test.ts', '**/*.test-utils.ts', 'vite.config.ts', 'vitest.e2e.config.ts', 'eslint.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The webapp ships as plain static files with no build step, so it is not
    // part of the TypeScript project and cannot be type-checked -- but it is
    // still code worth linting, and it runs in a browser rather than node.
    files: ['public/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // projectService would otherwise look for these in tsconfig and fail.
      parserOptions: { projectService: false, project: false },
      globals: {
        AbortSignal: 'readonly',
        console: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },
  prettier,
)
