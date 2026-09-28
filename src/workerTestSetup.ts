import { resolve } from 'node:path'
import { build } from 'vite'
import type { TestProject } from 'vitest/node'

// Rebuild once before each test run, including watch reruns. This uses the
// production worker entry/bundler but avoids declaration generation per run.
export default async function setup(project: TestProject): Promise<void> {
  const rebuild = async () => {
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        target: 'node20.19',
        outDir: '.vitest-worker',
        lib: {
          entry: resolve(import.meta.dirname, 'trackStoreWorker.ts'),
          formats: ['es'],
          fileName: () => 'trackStoreWorker.js',
        },
        rollupOptions: {
          external: [
            /^node:/,
            'rxjs',
            'rxjs/operators',
            'express',
            /^typebox/,
            '@js-temporal/polyfill',
            '@xmldom/xmldom',
          ],
        },
        minify: false,
      },
    })
  }
  await rebuild()
  project.onTestsRerun(rebuild)
}
