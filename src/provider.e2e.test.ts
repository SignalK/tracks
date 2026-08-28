import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { questdbAvailable, startServer, QUESTDB_URL } from './e2e.test-utils.js'
import type { E2EServer } from './e2e.test-utils.js'

/**
 * The History API bootstrap, against a real history provider.
 *
 * `source: 'history'` refills the own vessel's track at startup by calling
 * `app.getHistoryApi()` and reading `getValues()`. The unit suite stubs that
 * call, which proves the parsing but not that a real provider's responses fit
 * it — and every bootstrap bug this repo has had was a mismatch there, not in
 * the parsing.
 *
 * So this installs signalk-questdb into the server and lets the plugin
 * bootstrap through it for real. What matters is the History API contract:
 * how the provider stores anything is its own business, and this must keep
 * passing across any change to that.
 *
 * Skips when no QuestDB is listening.
 *
 * Note the first test carries the others: an empty track looks identical
 * whether the provider is missing or simply has no data for the window, so
 * without an explicit check that the registry is populated the rest would pass
 * against a server with no provider at all. Verified by removing the provider
 * and confirming that test — and only that test — fails.
 */

const MINUTE = 60_000
const SELF_PATH = '/self/track'

interface TrackResponse {
  type: string
  coordinates: [number, number][][]
  times?: string[][]
}

let server: E2EServer | undefined
let available = false

/** Poll until `probe` returns something, or give up. */
async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== undefined) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return undefined
}

beforeAll(async () => {
  available = await questdbAvailable()
  if (!available) {
    console.warn(`No QuestDB listening at ${QUESTDB_URL}; history provider tests skipped`)
    return
  }
  server = await startServer({
    // A different port from plugin.e2e.test.ts so the two files never collide.
    port: 4790,
    config: { source: 'history', resolution: 1000, pointsToKeep: 500 },
    plugins: {
      'signalk-questdb': {
        questdbHost: new URL(QUESTDB_URL).hostname,
        questdbHttpPort: Number(new URL(QUESTDB_URL).port),
        questdbIlpPort: 9009,
        questdbPgPort: 8812,
        // The container is already running; the plugin must not try to own it.
        managedContainer: false,
        recordSelf: true,
        recordOthers: false,
      },
    },
    timeoutSeconds: 120,
  })
}, 300_000)

afterAll(() => {
  server?.stop()
})

describe('bootstrap through a real history provider', () => {
  it('registers a history provider the plugin can resolve', async () => {
    if (!available || !server) return
    // getHistoryApi() resolves through the server's history registry, so a
    // provider that never registered would make every test below vacuous — an
    // empty track is exactly what "no provider" and "provider with no data"
    // both look like. Assert the registry is genuinely populated.
    //
    // Registration is not instant: signalk-questdb POSTs itself to
    // _providers/_default a few seconds after start, so this polls.
    const contexts = await eventually(async () => {
      const res = await fetch(`${server!.url}/signalk/v2/api/history/contexts?from=2026-01-01T00:00:00Z`)
      const body = (await res.json()) as string[]
      return body.length > 0 ? body : undefined
    })

    expect(contexts).toBeDefined()
    expect(contexts?.length).toBeGreaterThan(0)
  })

  it('serves a track for the own vessel after bootstrap', async () => {
    if (!available || !server) return
    // Positions fed live still have to arrive; bootstrap must not leave the
    // accumulator in a state that rejects them.
    const t0 = Date.now() - 5 * MINUTE
    await server.feed(server.selfContext, [60.1, 24.9], t0)
    await server.feed(server.selfContext, [60.11, 24.91], t0 + MINUTE)

    const track = (await server.api(SELF_PATH)) as TrackResponse
    expect(track.type).toBe('MultiLineString')
    expect(track.coordinates.flat().length).toBeGreaterThan(0)
  })

  it('keeps timestamps usable on a bootstrapped track', async () => {
    if (!available || !server) return
    // The bootstrap dates each point from the provider's response. If those
    // times were dropped the points would look infinitely old and a windowed
    // query would return nothing.
    const track = (await server.api(`${SELF_PATH}?times&duration=1d`)) as TrackResponse
    expect(track.times).toBeDefined()
    for (const segment of track.times ?? []) {
      for (const time of segment) {
        expect(Number.isNaN(Date.parse(time))).toBe(false)
      }
    }
  })

  it('starts and serves even when the provider returns nothing useful', async () => {
    if (!available || !server) return
    // The bootstrap is best-effort: a provider with no data for the window must
    // leave a working, empty track rather than a failed plugin.
    const track = (await server.api(`${SELF_PATH}?from=1990-01-01T00:00:00Z&to=1990-01-02T00:00:00Z`)) as TrackResponse
    expect(track.coordinates).toEqual([])
  })
})
