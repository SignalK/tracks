import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// vite transpiles without typechecking, so the build only rejects unsound
// source because vite.config.ts adds vite-plugin-checker. That guarantee is
// worth an executed test rather than a comment: the plugin is skipped when
// VITEST is set, which is exactly the environment this suite runs in, so a
// regression here would otherwise be invisible from inside the suite.
//
// The build is spawned with VITEST removed, which is what the real `npm run
// build` looks like.
const PROBE = new URL('./buildTypecheckProbe.generated.ts', import.meta.url)
const VITE_CLI = new URL('../node_modules/vite/bin/vite.js', import.meta.url)

function buildWithoutVitest() {
  const env = { ...process.env }
  delete env.VITEST
  // The vite CLI is run through node rather than npx: `npx` is npx.cmd on
  // Windows, which spawnSync cannot execute without a shell, and CI runs this
  // suite there.
  return spawnSync(process.execPath, [fileURLToPath(VITE_CLI), 'build'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    encoding: 'utf8',
  })
}

describe('the build', () => {
  it('fails on a type error the transpiler would accept', () => {
    // Valid JavaScript once the types are erased, so only a typechecker
    // rejects it — which is the whole point of the assertion.
    writeFileSync(PROBE, 'export const broken: number = "not a number"\n')

    try {
      const result = buildWithoutVitest()

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('TS2322')
    } finally {
      rmSync(PROBE, { force: true })
    }
  }, 120_000)
})
