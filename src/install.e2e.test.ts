import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from './e2e.test-utils.js'
import type { E2EServer } from './e2e.test-utils.js'

/**
 * The plugin as the App Store leaves it: installed, never configured.
 *
 * Run with `npm run test:e2e`.
 */

const CTX = 'vessels.urn:mrn:imo:mmsi:244170002'
const MINUTE = 60_000

let server: E2EServer

beforeAll(async () => {
  server = await startServer({ unconfigured: true })
}, 180_000)

afterAll(async () => {
  await server?.stop()
})

describe('a fresh install', () => {
  it('is enabled and saved as enabled, so it can be disabled later', () => {
    const saved = JSON.parse(readFileSync(join(server.configDir, 'plugin-config-data', 'tracks.json'), 'utf8')) as {
      enabled?: boolean
    }
    expect(saved.enabled).toBe(true)
  })

  it('records positions without any configuration', async () => {
    // Spaced wider than the default resolution, which applies with no config.
    const t0 = Date.now() - 10 * MINUTE
    await server.feed(CTX, [60.1, 24.9], t0)
    await server.feed(CTX, [60.11, 24.91], t0 + 2 * MINUTE)

    const tracks = (await server.api('/tracks')) as Record<string, unknown>
    expect(Object.keys(tracks)).toContain(CTX)
  })
})
