import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ThePlugin from './index.js'
import type { Debug } from './types.js'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789'
const API = '/signalk/v1/api'
const MINUTE = 60_000

/**
 * The plugin serving a query with a history provider present.
 *
 * The provider is the finer source where it reaches; the plugin's own store is
 * what remains of everything older, and of any period the provider missed.
 */
const stand = (historyRows: unknown[] | null) => {
  const debug: Debug = Object.assign(() => undefined, { enabled: false })
  const app = {
    debug,
    error: () => undefined,
    selfContext: SELF,
    getSelfPath: () => undefined,
    streambundle: { getBus: () => ({ onValue: () => () => undefined }) },
    ...(historyRows === null
      ? {}
      : {
          getHistoryApi: () =>
            Promise.resolve({
              getValues: () =>
                Promise.resolve({
                  context: SELF,
                  range: { from: '', to: '' },
                  values: [],
                  data: historyRows,
                }),
            }),
        }),
  }
  const plugin = ThePlugin(app)
  plugin.start({ resolution: 60000, pointsToKeep: 1000, maxAge: 3600, source: 'memory' })
  const server = express()
  server.use(API, plugin.signalKApiRoutes(express.Router()))
  return { plugin, server, stop: () => plugin.stop() }
}

/** A stored point at a given latitude. */
const storedAt = (lat: number): [number, number] => [lat, 24.9]

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE).toISOString()

const coords = (body: { coordinates: [number, number][][] }) => body.coordinates.flat()

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})

describe('history and store together', () => {
  it('uses the store alone when no provider is installed', async () => {
    const h = stand(null)
    stop = h.stop
    h.plugin.getTracks()?.initialTrack(SELF, [storedAt(60.1)], [Date.now() - 5 * MINUTE])

    const res = await request(h.server).get(`${API}/self/track`).expect(200)
    expect(coords(res.body)).toHaveLength(1)
  })

  it('prefers the provider where it has the same minute', async () => {
    // The same physical fix, timestamped differently by the two sources.
    const minuteAgo = Date.now() - MINUTE
    const h = stand([[new Date(minuteAgo).toISOString(), { latitude: 61, longitude: 24.9 }]])
    stop = h.stop
    h.plugin.getTracks()?.initialTrack(SELF, [[60, 24.9]], [minuteAgo + 1212])

    const res = await request(h.server).get(`${API}/self/track?timespan=1h`).expect(200)
    const points = coords(res.body)
    expect(points).toHaveLength(1)
    expect(points[0]?.[1]).toBe(61)
  })

  it('fills what the provider does not cover from the store', async () => {
    // The provider reaches back an hour; the store holds the older track.
    const h = stand([[iso(30), { latitude: 61, longitude: 24.9 }]])
    stop = h.stop
    const old = Date.now() - 5 * 60 * MINUTE
    h.plugin.getTracks()?.initialTrack(
      SELF,
      [
        [60, 24.8],
        [60.5, 24.85],
      ],
      [old, Date.now() - 30 * MINUTE + 900],
    )

    const res = await request(h.server).get(`${API}/self/track?timespan=24h`).expect(200)
    // The old store point survives; the recent minute comes from history.
    expect(coords(res.body).length).toBeGreaterThanOrEqual(2)
    expect(coords(res.body).some((p) => p[1] === 61)).toBe(true)
    expect(coords(res.body).some((p) => p[1] === 60)).toBe(true)
  })

  it('reconciles on the width the provider actually used', async () => {
    // The History API takes whole seconds, so a 1500ms resolution is asked for
    // as 2s. Reconciling on 1500ms would leave a stored point at 1600ms in a
    // bucket the provider already covered, and keep both.
    const base = Math.floor((Date.now() - 10 * MINUTE) / 2000) * 2000
    const h = stand([[new Date(base).toISOString(), { latitude: 61, longitude: 24.9 }]])
    stop = h.stop
    h.plugin.getTracks()?.initialTrack(SELF, [[60, 24.9]], [base + 1600])

    const res = await request(h.server).get(`${API}/self/track?timespan=1h&resolution=1.5`).expect(200)
    expect(coords(res.body)).toHaveLength(1)
  })

  it('falls back to the store when the provider fails', async () => {
    // Best-effort: a broken provider must not fail a query the store can answer.
    const debug: Debug = Object.assign(() => undefined, { enabled: false })
    const app = {
      debug,
      error: () => undefined,
      selfContext: SELF,
      getSelfPath: () => undefined,
      streambundle: { getBus: () => ({ onValue: () => () => undefined }) },
      getHistoryApi: () => Promise.reject(new Error('provider down')),
    }
    const plugin = ThePlugin(app)
    plugin.start({ resolution: 60000, pointsToKeep: 1000, maxAge: 3600, source: 'memory' })
    stop = () => plugin.stop()
    const server = express()
    server.use(API, plugin.signalKApiRoutes(express.Router()))
    plugin.getTracks()?.initialTrack(SELF, [[60, 24.9]], [Date.now() - 5 * MINUTE])

    const res = await request(server).get(`${API}/self/track?timespan=1h`).expect(200)
    expect(coords(res.body)).toHaveLength(1)
  })

  it('answers from the store when the provider never responds', { timeout: 15000 }, async () => {
    // The provider is an enrichment, not a dependency. Without a bound on the
    // await, a wedged provider would hold the request open and the store
    // fallback would never be reached.
    const debug: Debug = Object.assign(() => undefined, { enabled: false })
    const app = {
      debug,
      error: () => undefined,
      selfContext: SELF,
      getSelfPath: () => undefined,
      streambundle: { getBus: () => ({ onValue: () => () => undefined }) },
      // Never settles, which is the point of this test.
      getHistoryApi: () => new Promise<never>(() => undefined),
    }
    const plugin = ThePlugin(app)
    plugin.start({ resolution: 60000, pointsToKeep: 1000, maxAge: 3600, source: 'memory' })
    stop = () => plugin.stop()
    const server = express()
    server.use(API, plugin.signalKApiRoutes(express.Router()))
    plugin.getTracks()?.initialTrack(SELF, [[60, 24.9]], [Date.now() - 5 * MINUTE])

    // Real timers: the bound is 5s, so this test genuinely waits for it.
    const res = await request(server).get(`${API}/self/track?timespan=1h`)

    expect(res.status).toBe(200)
    expect(coords(res.body)).toHaveLength(1)
  })

  it('consults the provider even when the query names no window', async () => {
    // `/self/track` with no parameters is the common call; skipping the
    // provider there would quietly serve store-only data.
    const h = stand([[iso(2), { latitude: 61, longitude: 24.9 }]])
    stop = h.stop
    h.plugin.getTracks()?.initialTrack(SELF, [[60, 24.8]], [Date.now() - 30 * MINUTE])

    const res = await request(h.server).get(`${API}/self/track`).expect(200)
    const lats = coords(res.body).map((p) => p[1])
    expect(lats).toContain(61)
    expect(lats).toContain(60)
  })

  it('ignores provider rows outside the requested window', async () => {
    // A provider returning a wider range must not widen the answer.
    const h = stand([
      [iso(180), { latitude: 61, longitude: 24.9 }],
      [iso(10), { latitude: 62, longitude: 24.9 }],
    ])
    stop = h.stop

    const res = await request(h.server).get(`${API}/self/track?timespan=1h`).expect(200)
    const lats = coords(res.body).map((p) => p[1])
    expect(lats).toContain(62)
    expect(lats).not.toContain(61)
  })
})
