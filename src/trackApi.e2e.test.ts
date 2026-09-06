import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from './e2e.test-utils.js'
import type { E2EServer } from './e2e.test-utils.js'

/**
 * The plugin as a registered v2 Track API provider, inside a real server.
 *
 * This is what the unit suite cannot show: that the server offered
 * `registerTrackApiProvider` to a plugin loaded from a packed tarball, that the
 * plugin took it, and that a query arriving over HTTP — parsed and validated by
 * the server, not by a test stub — reaches this provider and comes back as
 * GeoJSON.
 *
 * Needs a server checkout carrying SignalK/signalk-server#2995 at
 * SIGNALK_SERVER_DIR. Run with `npm run test:e2e`.
 */

const CTX = 'vessels.urn:mrn:imo:mmsi:244170002'
const MINUTE = 60_000

interface Feature {
  type: string
  geometry: { type: string; coordinates: [number, number][][] } | null
  properties: {
    context: string
    isSelf: boolean
    providerId?: string
    from: string
    to: string
    bbox?: [number, number, number, number]
    pointCount: number
    resolution?: string
    coordTimes?: string[][]
  }
}

interface Collection {
  type: string
  features: Feature[]
}

let server: E2EServer
let t0: number

beforeAll(async () => {
  server = await startServer({ config: { segmentGapMinutes: 5 } })
  t0 = Date.now() - 10 * MINUTE
  await server.feed(CTX, [60.1, 24.9], t0)
  await server.feed(CTX, [60.11, 24.91], t0 + MINUTE)
  await server.feed(CTX, [60.12, 24.92], t0 + 2 * MINUTE)
}, 180_000)

afterAll(() => {
  server?.stop()
})

describe('the plugin registers as a track provider', () => {
  // Without a registration the server answers 501 "No track api provider
  // configured", which is what this server does with the plugin absent.
  it('answers a v2 query rather than reporting no provider', async () => {
    const { status, body } = await server.apiV2(`/tracks?contexts=${CTX}`)

    expect(status).toBe(200)
    const collection = body as Collection
    expect(collection.type).toBe('FeatureCollection')
    expect(collection.features).toHaveLength(1)
  })

  // The server stamps which provider answered, so a fan-out response can be
  // attributed. It is added by the server, not by this plugin.
  it('is attributed to this plugin', async () => {
    const { body } = await server.apiV2(`/tracks?contexts=${CTX}`)
    const [feature] = (body as Collection).features

    expect(feature!.properties.providerId).toBe('tracks')
  })
})

describe('a v2 query through the real HTTP route', () => {
  it('returns GeoJSON in lng,lat order', async () => {
    const { body } = await server.apiV2(`/tracks?contexts=${CTX}`)
    const [feature] = (body as Collection).features

    expect(feature!.type).toBe('Feature')
    expect(feature!.geometry!.type).toBe('MultiLineString')
    // Longitude first, and roughly where the positions were fed.
    const [first] = feature!.geometry!.coordinates[0]!
    expect(first![0]).toBeCloseTo(24.9, 1)
    expect(first![1]).toBeCloseTo(60.1, 1)
    expect(feature!.properties.context).toBe(CTX)
    expect(feature!.properties.isSelf).toBe(false)
    expect(feature!.properties.pointCount).toBeGreaterThanOrEqual(2)
  })

  it('serves coordTimes when ?times is asked for', async () => {
    const { body } = await server.apiV2(`/tracks?contexts=${CTX}&times`)
    const [feature] = (body as Collection).features

    const segments = feature!.geometry!.coordinates
    expect(feature!.properties.coordTimes).toHaveLength(segments.length)
    expect(feature!.properties.coordTimes![0]).toHaveLength(segments[0]!.length)
    expect(Date.parse(feature!.properties.coordTimes![0]![0]!)).not.toBeNaN()
  })

  it('omits the geometry for ?geometry=false, keeping the metadata', async () => {
    const { body } = await server.apiV2(`/tracks?contexts=${CTX}&geometry=false`)
    const [feature] = (body as Collection).features

    expect(feature!.geometry).toBeNull()
    expect(feature!.properties.pointCount).toBeGreaterThanOrEqual(2)
  })

  // The server parses bbox as west,south,east,north and hands the provider the
  // same order; a swap anywhere along that path shows up here.
  it('filters by bbox in GeoJSON order', async () => {
    const inside = await server.apiV2(`/tracks?contexts=${CTX}&bbox=24,59,26,61`)
    expect((inside.body as Collection).features).toHaveLength(1)

    const elsewhere = await server.apiV2(`/tracks?contexts=${CTX}&bbox=130,-35,139,-33`)
    expect((elsewhere.body as Collection).features).toHaveLength(0)
  })

  // duration is resolved into from/to by the server, so this exercises the
  // server's parsing and the provider's window handling together.
  it('honours a duration window', async () => {
    const wide = await server.apiV2(`/tracks?contexts=${CTX}&duration=PT30M`)
    expect((wide.body as Collection).features).toHaveLength(1)

    // The track ends ~8 minutes ago, so a one-minute window excludes it.
    const narrow = await server.apiV2(`/tracks?contexts=${CTX}&duration=PT1M`)
    expect((narrow.body as Collection).features).toHaveLength(0)
  })

  // The server validates `resolution` as any positive ISO 8601 duration, so a
  // calendar unit passes validation and reaches the provider. Resolving one
  // needs a reference point; without it this came back as a 500.
  it('answers a calendar-unit resolution rather than erroring', async () => {
    for (const unit of ['P1W', 'P1M', 'P1Y']) {
      const { status, body } = await server.apiV2(`/tracks?contexts=${CTX}&resolution=${unit}`)

      expect(status).toBe(200)
      expect((body as Collection).features).toHaveLength(1)
    }
  })

  it('rejects a malformed query before reaching the provider', async () => {
    const { status } = await server.apiV2(`/tracks?contexts=${CTX}&bbox=1,2,3`)
    expect(status).toBe(400)
  })
})
