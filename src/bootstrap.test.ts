import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ThePlugin from './index.js'
import type { Debug, LatLngTuple } from './types.js'
import express from 'express'
import { Temporal } from '@js-temporal/polyfill'

const API = '/signalk/v1/api'
const SELF = 'vessels.urn:mrn:imo:mmsi:123456789'

let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})

/**
 * Stand the plugin up with a stubbed History API returning `data` rows, and let
 * the bootstrap run. Providers disagree on how a position is encoded, so the
 * rows are supplied verbatim.
 */
const queries: { from: unknown; to: unknown }[] = []

async function bootstrapWith(data: unknown[]) {
  queries.length = 0
  vi.useFakeTimers()
  const debug: Debug = Object.assign(() => undefined, { enabled: false })
  const app = {
    debug,
    error: () => undefined,
    selfContext: SELF,
    getSelfPath: () => undefined,
    streambundle: { getBus: () => ({ onValue: () => () => undefined }) },
    getHistoryApi: () =>
      Promise.resolve({
        getValues: (q: { from: unknown; to: unknown }) => {
          queries.push(q)
          return Promise.resolve({ context: SELF, range: { from: '', to: '' }, values: [], data })
        },
      }),
  }
  const plugin = ThePlugin(app)
  plugin.start({ resolution: 0, pointsToKeep: 1000, maxAge: 600, bootstrapFromHistory: true })
  stop = () => plugin.stop()

  const expressApp = express()
  expressApp.use(API, plugin.signalKApiRoutes(express.Router()))

  // clear the bootstrap's initial delay and let its promise chain settle
  await vi.advanceTimersByTimeAsync(6000)
  vi.useRealTimers()
  return expressApp
}

const coords = (body: { coordinates: number[][][] }) => body.coordinates[0] ?? []

describe('bootstrap from the History API', () => {
  // The shape signalk-questdb actually returns, captured from a live server.
  // The original filter required a [lon, lat] array and silently dropped every
  // one of these rows, so the track bootstrapped empty.
  it('accepts positions encoded as {latitude, longitude}', async () => {
    const app = await bootstrapWith([
      ['2026-08-08T16:34:00.000000Z', { latitude: -17.7696467, longitude: 177.1797346 }],
      ['2026-08-08T16:35:00.000000Z', { latitude: -17.7696991, longitude: 177.1796442 }],
    ])

    const res = await request(app).get(`${API}/self/track`).expect(200)

    expect(coords(res.body)).toHaveLength(2)
    // GeoJSON output is [lng, lat]
    expect(coords(res.body)[0]).toEqual([177.1797346, -17.7696467])
  })

  it('accepts positions encoded as a [lon, lat] pair', async () => {
    const app = await bootstrapWith([
      ['2026-08-08T16:34:00.000000Z', [177.1797346, -17.7696467]],
      ['2026-08-08T16:35:00.000000Z', [177.1796442, -17.7696991]],
    ])

    const res = await request(app).get(`${API}/self/track`).expect(200)

    expect(coords(res.body)).toHaveLength(2)
    expect(coords(res.body)[0]).toEqual([177.1797346, -17.7696467])
  })

  it('skips malformed rows rather than failing the whole bootstrap', async () => {
    const app = await bootstrapWith([
      ['2026-08-08T16:34:00.000000Z', { latitude: -17.7696467, longitude: 177.1797346 }],
      ['2026-08-08T16:35:00.000000Z', null],
      ['2026-08-08T16:36:00.000000Z', { latitude: 'nope', longitude: 177 }],
      ['2026-08-08T16:37:00.000000Z', [177.1796442, -17.7696991]],
    ])

    const res = await request(app).get(`${API}/self/track`).expect(200)

    expect(coords(res.body)).toHaveLength(2)
  })

  // Bootstrapped points must carry their recorded time, or a time-window query
  // treats the restored track as infinitely old and returns nothing.
  it('dates bootstrapped points so time windows can select them', async () => {
    const now = Date.now()
    const at = (msAgo: number) => new Date(now - msAgo).toISOString()
    const app = await bootstrapWith([
      [at(3 * 60 * 60 * 1000), { latitude: 1, longitude: 1 }],
      [at(30 * 60 * 1000), { latitude: 2, longitude: 2 }],
    ])

    const all = await request(app).get(`${API}/self/track`).expect(200)
    const lastHour = await request(app).get(`${API}/self/track?timespan=1h`).expect(200)

    expect(coords(all.body)).toHaveLength(2)
    expect(coords(lastHour.body)).toHaveLength(1)
    expect(coords(lastHour.body)[0]).toEqual([2, 2])
  })

  it('leaves the track empty when history returns nothing usable', async () => {
    const app = await bootstrapWith([['2026-08-08T16:34:00.000000Z', 'not a position']])

    await request(app).get(`${API}/self/track`).expect(404)
  })

  // The History API hands providers Temporal.Instant values, not strings, and
  // providers call Instant methods on them — signalk-questdb does
  // `from.add(duration)`. Passing ISO strings produced a query that silently
  // returned the wrong range instead of throwing.
  it('passes the time range as Temporal.Instant, not ISO strings', async () => {
    await bootstrapWith([['2026-08-08T16:34:00.000000Z', { latitude: 1, longitude: 1 }]])

    expect(queries).toHaveLength(1)
    const query = queries[0]!
    expect(typeof query.from).not.toBe('string')
    expect(query.from).toBeInstanceOf(Temporal.Instant)
    expect(query.to).toBeInstanceOf(Temporal.Instant)
    // the shape providers actually exercise
    expect(typeof (query.from as Temporal.Instant).add).toBe('function')
  })
})

describe('provider selection', () => {
  /**
   * The server's default history provider falls back to whichever plugin
   * registered first until the configured one is up. An early bootstrap could
   * therefore be answered by a provider with no positions — verified on a live
   * server, where `kip` answered with 0 rows while signalk-questdb held 121.
   */
  it('asks for the configured provider by name', async () => {
    const asked: (string | undefined)[] = []
    const debug: Debug = Object.assign(() => undefined, { enabled: false })
    vi.useFakeTimers()
    const plugin = ThePlugin({
      debug,
      error: () => undefined,
      selfContext: SELF,
      getSelfPath: () => undefined,
      streambundle: { getBus: () => ({ onValue: () => () => undefined }) },
      config: { settings: { historyApi: { defaultProvider: 'signalk-questdb' } } },
      getHistoryApi: (providerId?: string) => {
        asked.push(providerId)
        return Promise.resolve({
          getValues: () =>
            Promise.resolve({
              context: SELF,
              range: { from: '', to: '' },
              values: [],
              data: [['2026-08-08T16:34:00.000000Z', { latitude: 1, longitude: 1 }]],
            }),
        })
      },
    })
    plugin.start({ resolution: 0, pointsToKeep: 10, maxAge: 600, bootstrapFromHistory: true })
    stop = () => plugin.stop()
    await vi.advanceTimersByTimeAsync(6000)

    expect(asked).toEqual(['signalk-questdb'])
  })

  it('retries when a provider answers with no data instead of giving up', async () => {
    let call = 0
    const debug: Debug = Object.assign(() => undefined, { enabled: false })
    vi.useFakeTimers()
    const plugin = ThePlugin({
      debug,
      error: () => undefined,
      selfContext: SELF,
      getSelfPath: () => undefined,
      streambundle: { getBus: () => ({ onValue: () => () => undefined }) },
      getHistoryApi: () =>
        Promise.resolve({
          getValues: () => {
            call++
            // first answer is empty, as a not-yet-ready provider gives
            return Promise.resolve({
              context: SELF,
              range: { from: '', to: '' },
              values: [],
              data: call === 1 ? [] : [['2026-08-08T16:34:00.000000Z', { latitude: 5, longitude: 5 }]],
            })
          },
        }),
    })
    plugin.start({ resolution: 0, pointsToKeep: 10, maxAge: 600, bootstrapFromHistory: true })
    stop = () => plugin.stop()

    const app = express()
    app.use(API, plugin.signalKApiRoutes(express.Router()))

    await vi.advanceTimersByTimeAsync(6000) // first attempt: empty
    await vi.advanceTimersByTimeAsync(16000) // retry: has data
    vi.useRealTimers()

    expect(call).toBeGreaterThan(1)
    const res = await request(app).get(`${API}/self/track`).expect(200)
    expect(coords(res.body)).toEqual([[5, 5]])
  })
})

describe('bootstrap resilience', () => {
  it('does not throw when the server has no History API', async () => {
    const debug: Debug = Object.assign(() => undefined, { enabled: false })
    const errors: unknown[][] = []
    const plugin = ThePlugin({
      debug,
      error: (...a: unknown[]) => errors.push(a),
      selfContext: SELF,
      getSelfPath: () => undefined,
      streambundle: { getBus: () => ({ onValue: () => () => undefined }) },
    })
    plugin.start({ resolution: 0, pointsToKeep: 10, maxAge: 600, bootstrapFromHistory: true })
    stop = () => plugin.stop()

    const positions: LatLngTuple[] = [[1, 1]]
    plugin.getTracks()?.initialTrack(SELF, positions, [Date.now()])

    expect(errors).toHaveLength(0)
  })
})
