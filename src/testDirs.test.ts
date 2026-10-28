import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeAfterFile, removePending } from './testDirs.test-utils.js'

const testDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-dirs-'))
  writeFileSync(join(dir, 'tracks.db'), '')
  return dir
}

describe('directories left for the end of a test file', () => {
  it('are released before they are removed, and removed once', async () => {
    const dir = testDir()
    const seen: boolean[] = []
    removeAfterFile(dir, async () => {
      seen.push(existsSync(dir))
    })

    await removePending()
    await removePending()

    expect(seen).toEqual([true])
    expect(existsSync(dir)).toBe(false)
  })

  it('are all removed when one fails to release, and the failure is thrown', async () => {
    const failing = testDir()
    const next = testDir()
    removeAfterFile(failing, () => Promise.reject(new Error('close failed')))
    removeAfterFile(next, async () => {})

    const thrown = await removePending().catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors.map((err: Error) => err.message)).toEqual(['close failed'])
    expect(existsSync(failing)).toBe(false)
    expect(existsSync(next)).toBe(false)
  })
})
