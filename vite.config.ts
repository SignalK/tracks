import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import dts from 'vite-plugin-dts'

// The plugin is loaded by the Signal K server, not bundled into a browser app,
// so everything outside src/ stays external and is resolved at runtime from
// node_modules. Bundling rxjs or express in would duplicate them in memory
// alongside the server's own copies.
export default defineConfig({
  build: {
    target: 'node20.19',
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [/^node:/, 'rxjs', 'rxjs/operators', 'express', /^typebox/, '@js-temporal/polyfill', '@xmldom/xmldom'],
    },
    sourcemap: true,
    minify: false,
  },
  plugins: [dts({ rollupTypes: true, tsconfigPath: './tsconfig.json' })],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // e2e runs against a real Signal K server and a real QuestDB, neither of
    // which exists in CI. `npm run test:e2e` opts in.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.e2e.test.ts'],
    // Above vitest's 5s default because every harness now creates a real sqlite
    // file rather than an in-memory accumulator, and CI's Windows runners are
    // slow enough at filesystem work to cross that line. The tests themselves
    // finish in milliseconds locally; this is headroom for the platform, not
    // permission for a slow test.
    testTimeout: 20_000,
  },
})
