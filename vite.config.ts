import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import dts from 'vite-plugin-dts'
import checker from 'vite-plugin-checker'

// The plugin is loaded by the Signal K server, not bundled into a browser app,
// so everything outside src/ stays external and is resolved at runtime from
// node_modules. Bundling rxjs or express in would duplicate them in memory
// alongside the server's own copies.
export default defineConfig({
  build: {
    target: 'node20.19',
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        trackStoreWorker: resolve(import.meta.dirname, 'src/trackStoreWorker.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [/^node:/, 'rxjs', 'rxjs/operators', 'express', /^typebox/, '@js-temporal/polyfill', '@xmldom/xmldom'],
    },
    sourcemap: true,
    minify: false,
  },
  // vite transpiles without typechecking, so `vite build` alone reports a
  // successful build for source tsc rejects. checker runs tsc as part of the
  // build and fails it on the first error, which is what makes `npm run build`
  // mean the same thing as `npm run typecheck && npm run build` did by
  // convention. It also surfaces errors while `vite` is serving.
  //
  // This config is vitest's too; the checker is skipped under test, where the
  // suite is the thing being run and a type error in an unrelated file should
  // not stop it.
  plugins: [
    dts({ rollupTypes: true, tsconfigPath: './tsconfig.json' }),
    ...(process.env.VITEST ? [] : [checker({ typescript: true })]),
  ],
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
    //
    // Raised from 20s after Windows crossed it four times in one day, on three
    // different tests in trackProvider.test.ts -- including two that seed only
    // 60 points. That spread is the tell: it is not one expensive test but
    // contention across the 41 harnesses the file opens, so trimming any single
    // one would not have helped. The whole file still runs in about a second
    // locally.
    testTimeout: 45_000,
    // Teardown now waits for worker startup/draining too, under the same CI contention.
    hookTimeout: 45_000,
  },
})
