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
  prettier,
)
