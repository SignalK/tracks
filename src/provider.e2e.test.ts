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
    // Each test below returns early without QuestDB and so counts as passed.
    // CI provides one and sets this, so losing it there fails the run.
    if (process.env.QUESTDB_REQUIRED) {
      throw new Error(`No QuestDB listening at ${QUESTDB_URL}, and QUESTDB_REQUIRED is set`)
    }
    console.warn(`No QuestDB listening at ${QUESTDB_URL}; history provider tests skipped`)
    return
  }
  server = await startServer({
    // A different port from plugin.e2e.test.ts so the two files never collide.
    port: 4790,
    // Moored pauses the own vessel's recording, which the history import fills.
    config: { source: 'history', resolution: 1000, pointsToKeep: 500, pauseWhenState: ['moored'] },
    // Named rather than left to registration order: any other history
    // provider in the server checkout would otherwise become the default and
    // answer these queries with nothing.
    historyProvider: 'signalk-questdb',
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
        // Every fix, not one each two seconds of wall clock: the history
        // import test feeds a fix a second and counts what comes back.
        defaultSamplingRate: 0,
      },
    },
    timeoutSeconds: 120,
  })
}, 300_000)

afterAll(async () => {
  await server?.stop()
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
    //
    // A fresh QuestDB holds nothing, and the list stays empty until the
    // provider records something, so give it an own-vessel fix to record.
    // Older than, and at the same spot as, what the later tests feed: the
    // plugin drops a fix older than the last one it stored, and the glitch
    // filter a jump it could not have sailed.
    const seededAt = Date.now() - 10 * MINUTE
    const contexts = await eventually(async () => {
      // Sent on every attempt, because a fix that arrives before the provider
      // is recording is lost. Repeats share a timestamp, so the plugin keeps one.
      await server!.feed(server!.selfContext, [60.1, 24.9], seededAt)
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

  // The plugin has two entry points into the same data. Both must reconcile
  // with the history provider, or a client moving from v1 to v2 silently loses
  // every point the provider held and the store did not.
  it('serves history through the v2 Track API as well as v1', async () => {
    if (!available || !server) return
    const t0 = Date.now() - 5 * MINUTE
    await server.feed(server.selfContext, [60.2, 25.0], t0)

    const v1 = (await server.api(`${SELF_PATH}?duration=1d`)) as TrackResponse
    const v2 = await server.apiV2(`/tracks?contexts=self&duration=P1D`)

    const v1Points = v1.coordinates.flat().length
    const feature = (v2.body as { features: { properties: { pointCount: number } }[] }).features[0]

    expect(v2.status).toBe(200)
    expect(feature).toBeDefined()
    // Not asserting equality: the two routes thin independently. What must hold
    // is that v2 is not answering from the store alone — one live fix — while
    // v1 reaches the provider for the rest.
    expect(v1Points).toBeGreaterThan(1)
    expect(feature!.properties.pointCount).toBeGreaterThan(1)
  })

  it('starts and serves even when the provider returns nothing useful', async () => {
    if (!available || !server) return
    // The bootstrap is best-effort: a provider with no data for the window must
    // leave a working, empty track rather than a failed plugin.
    const track = (await server.api(`${SELF_PATH}?from=1990-01-01T00:00:00Z&to=1990-01-02T00:00:00Z`)) as TrackResponse
    expect(track.coordinates).toEqual([])
  })
})

describe('the history import through a real history provider', () => {
  interface ImportState {
    startedAt: string
    firstDay?: string
    filled: number
    finishedAt?: string
    error?: string
  }

  it('fills what the recording paused for from what the provider recorded', async () => {
    if (!available || !server) return
    // Moored, the plugin records nothing of the own vessel, and the provider
    // records on. It stamps a fix with the time it arrives, not the one the
    // fix carries, so these are sent as now.
    await server.feedState(server.selfContext, 'moored')
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) {
      await server.feed(server.selfContext, [60.1 + i * 1e-5, 24.9], Date.now())
    }
    await server.feedState(server.selfContext, 'sailing')

    // Asked again until the provider has made the fixes readable: what an
    // import fills is the recording afterwards, so each run adds only what
    // the runs before it could not see.
    let filled = 0
    let last: ImportState | undefined
    const done = await eventually(async () => {
      const started = await server!.plugin('/history-import', { method: 'POST' })
      expect(started.status).toBe(202)
      const { startedAt } = (started.body as { state: ImportState }).state
      last = await eventually(async () => {
        const { body } = await server!.plugin('/history-import')
        const state = (body as { state?: ImportState }).state
        return state?.startedAt === startedAt && state.finishedAt !== undefined ? state : undefined
      }, 60_000)
      filled += last?.filled ?? 0
      return filled >= 20 ? last : undefined
    }, 120_000)

    // On a failure, what the provider says it holds since the fixes were sent.
    const held = done
      ? ''
      : await fetch(
          `${server.url}/signalk/v2/api/history/values?paths=navigation.position&resolution=1` +
            `&from=${new Date(t0 - MINUTE).toISOString()}&to=${new Date().toISOString()}`,
        )
          .then((res) => res.json() as Promise<{ data?: [string, unknown][] }>)
          .then(({ data = [] }) => {
            const rows = data.filter(([, value]) => value !== null)
            return `${rows.length} of ${data.length} rows hold a position: ${JSON.stringify(rows.slice(0, 25))}`
          })
    expect(done, `${JSON.stringify(last)} ${held}`).toBeDefined()
    expect(done!.error).toBeUndefined()
    expect(Date.parse(done!.firstDay!)).toBeLessThanOrEqual(t0)
    // The provider also holds the fixes the tests above fed, stamped when
    // they arrived, where the plugin recorded them at the times they carry.
    expect(filled).toBeGreaterThanOrEqual(20)
  }, 300_000)
})
