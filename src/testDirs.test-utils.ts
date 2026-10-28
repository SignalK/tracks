import { rmSync } from 'node:fs'

/**
 * Directories left for the end of their test file, each with what has to let
 * go of it first. A harness's data directory outlives its stop(), since a
 * test restarts the plugin on it, after changing the file at times.
 */
const pending: { dir: string; release: () => Promise<void> }[] = []

export const removeAfterFile = (dir: string, release: () => Promise<void>): void => {
  pending.push({ dir, release })
}

/**
 * Releases and removes every directory left so far; `fileTestSetup.ts` runs
 * it after each file. One that fails does not keep the rest: each is tried,
 * and the failures are thrown together at the end.
 */
export async function removePending(): Promise<void> {
  const failures: unknown[] = []
  for (const { dir, release } of pending.splice(0)) {
    try {
      await release()
    } catch (err) {
      failures.push(err)
    }
    try {
      // Windows can hold a file a moment after it is closed.
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      failures.push(err)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Some test directories could not be removed')
  }
}
