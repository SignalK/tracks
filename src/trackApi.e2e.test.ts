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
    id?: string
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

afterAll(async () => {
  await server?.stop()
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

  // Weeks and days are fixed lengths, so they reach the provider normalised.
  it('answers a fixed-length calendar resolution rather than erroring', async () => {
    for (const unit of ['P1W', 'P1D']) {
      const { status, body } = await server.apiV2(`/tracks?contexts=${CTX}&resolution=${unit}`)

      expect(status).toBe(200)
      expect((body as Collection).features).toHaveLength(1)
    }
  })

  // Months and years are not fixed lengths — a month is 744h from January and
  // 672h from February — so the server rejects them rather than picking one.
  it('rejects a resolution in months or years', async () => {
    for (const unit of ['P1M', 'P1Y']) {
      const { status } = await server.apiV2(`/tracks?contexts=${CTX}&resolution=${unit}`)

      expect(status).toBe(400)
    }
  })

  // The server normalises a calendar-unit resolution to hours before a provider
  // sees it, so ?resolution=P1D no longer needs a reference date on this side.
  it('accepts a day-scale resolution through the real route', async () => {
    const { status, body } = await server.apiV2(`/tracks?contexts=${CTX}&resolution=P1D`)

    expect(status).toBe(200)
    expect((body as Collection).features[0]!.properties.resolution).toBe('PT24H')
  })

  it('honours maxPoints and reports the spacing it used', async () => {
    const { status, body } = await server.apiV2(`/tracks?contexts=${CTX}&maxPoints=2`)
    const feature = (body as Collection).features[0]!

    expect(status).toBe(200)
    expect(feature.properties.pointCount).toBeLessThanOrEqual(2)
    expect(feature.properties.resolution).toBeDefined()
  })

  // A spacing finer than a timestamp cannot thin anything, so the server
  // rejects it rather than handing a provider a value no store can act on.
  it('rejects a sub-millisecond resolution', async () => {
    const { status } = await server.apiV2(`/tracks?contexts=${CTX}&resolution=PT0.0005S`)

    expect(status).toBe(400)
  })

  // A fractional millisecond still reaches the provider from anything at or
  // above the floor, and `Duration.from` rejects a fractional value in any
  // unit, so reporting the applied spacing back has to survive it.
  it('answers a fractional-second resolution', async () => {
    const { status, body } = await server.apiV2(`/tracks?contexts=${CTX}&resolution=PT0.5S`)

    expect(status).toBe(200)
    expect((body as Collection).features[0]!.properties.resolution).toBe('PT0.5S')
  })

  it('rejects a malformed query before reaching the provider', async () => {
    const { status } = await server.apiV2(`/tracks?contexts=${CTX}&bbox=1,2,3`)
    expect(status).toBe(400)
  })
})

describe('an imported track through the real HTTP routes', () => {
  // Storing tracks arrived in SignalK/signalk-server#3038. A server without it
  // has no POST route, which says nothing about this plugin, so the test steps
  // aside there rather than failing.
  it('is stored, listed, fetched and deleted by its id', async (context) => {
    const posted = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [24.5, 60.5],
          [24.6, 60.6],
        ],
      },
      properties: {
        name: 'Imported passage',
        coordTimes: [new Date(t0).toISOString(), new Date(t0 + MINUTE).toISOString()],
        colour: 'red',
      },
    }
    const stored = await server.apiV2('/tracks', { method: 'POST', body: posted })
    if (stored.status === 404 || stored.status === 405) {
      context.skip()
    }
    expect(stored.status).toBe(201)
    const { id } = stored.body as { id: string }
    expect(id).toMatch(/^tracks:imported:/)

    const fetched = await server.apiV2(`/tracks/${encodeURIComponent(id)}`)
    expect(fetched.status).toBe(200)
    expect((fetched.body as Feature).properties).toMatchObject({ id, name: 'Imported passage', colour: 'red' })

    const from = new Date(t0 - MINUTE).toISOString()
    const listed = await server.apiV2(`/tracks?from=${from}&bbox=24.4,60.4,24.7,60.7`)
    expect((listed.body as Collection).features.map(({ properties }) => properties.id)).toEqual([id])

    expect((await server.apiV2(`/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' })).status).toBe(200)
    expect((await server.apiV2(`/tracks/${encodeURIComponent(id)}`)).status).toBe(404)
  })
})

describe('deleting a recorded track through the real HTTP routes', () => {
  const VESSEL = 'vessels.urn:mrn:imo:mmsi:244170003'
  const trackId = `recorded:${VESSEL}`
  const url = (query = '') => `/tracks/${encodeURIComponent(`tracks:${trackId}`)}${query}`
  const iso = (t: number) => new Date(t).toISOString()
  const pointCount = async () => {
    const { status, body } = await server.apiV2(url())
    return status === 200 ? (body as Feature).properties.pointCount : status
  }
  const binEntry = async () => {
    const { status, body } = await server.plugin('/recycle-bin')
    expect(status).toBe(200)
    return (body as { id: number; trackId: string; whole: boolean; pointCount: number }[]).find(
      (entry) => entry.trackId === trackId,
    )
  }
  let start: number
  /**
   * Whether the server routes a track id to its provider at all. Fetching
   * and deleting by id arrived in SignalK/signalk-server#3038; a server
   * without it answers every id with its own not-found page rather than the
   * Track API's JSON, which says nothing about this plugin.
   */
  let routesIds = false

  beforeAll(async () => {
    start = Date.now() - 8 * MINUTE
    for (let i = 0; i < 4; i++) {
      await server.feed(VESSEL, [60.3 + i / 100, 25], start + i * MINUTE)
    }
    // The positions are written asynchronously after the delta arrives, so
    // wait for all four rather than racing the store.
    const deadline = Date.now() + 10_000
    for (;;) {
      const { status, body } = await server.apiV2(url())
      routesIds = typeof body === 'object'
      if (!routesIds || (status === 200 && (body as Feature).properties.pointCount === 4)) {
        break
      }
      if (Date.now() > deadline) {
        throw new Error(`the recorded track never reached four points: ${status} ${JSON.stringify(body)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })

  // Deleting part of a track arrived with a server change of its own. A server
  // without it refuses from and to as unknown parameters, which says nothing
  // about this plugin, so the test steps aside there.
  it('moves a span to the recycle bin and restores it', async (context) => {
    if (!routesIds) {
      context.skip()
    }
    expect(await pointCount()).toBe(4)
    const deleted = await server.apiV2(url(`?from=${iso(start + MINUTE)}&to=${iso(start + 2 * MINUTE)}`), {
      method: 'DELETE',
    })
    if (deleted.status === 400 && JSON.stringify(deleted.body).includes('from')) {
      context.skip()
    }
    expect(deleted.status).toBe(200)
    expect(await pointCount()).toBe(2)

    const v1 = (await server.api(`/vessels/${VESSEL.slice('vessels.'.length)}/track`)) as {
      coordinates: unknown[][]
    }
    expect(v1.coordinates.flat()).toHaveLength(2)

    const entry = await binEntry()
    expect(entry).toMatchObject({ whole: false, pointCount: 2 })
    expect((await server.plugin(`/recycle-bin/${entry!.id}/restore`, { method: 'POST' })).status).toBe(200)
    expect(await pointCount()).toBe(4)
    expect(await binEntry()).toBeUndefined()
  })

  // A recording goes on after it is deleted, so the bin keeps it as the span
  // up to the delete rather than as a whole track.
  it('deletes the whole track and purges it from the bin', async (context) => {
    if (!routesIds) {
      context.skip()
    }
    expect((await server.apiV2(url(), { method: 'DELETE' })).status).toBe(200)
    expect(await pointCount()).toBe(404)
    const entry = await binEntry()
    expect(entry).toMatchObject({ whole: false, pointCount: 4 })
    expect(entry).not.toHaveProperty('from')

    expect((await server.plugin(`/recycle-bin/${entry!.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await binEntry()).toBeUndefined()
    expect((await server.plugin(`/recycle-bin/${entry!.id}/restore`, { method: 'POST' })).status).toBe(404)
    expect(await pointCount()).toBe(404)
  })

  it('answers 404 for a vessel nobody recorded', async (context) => {
    if (!routesIds) {
      context.skip()
    }
    const id = encodeURIComponent('tracks:recorded:vessels.urn:mrn:imo:mmsi:000000001')
    expect((await server.apiV2(`/tracks/${id}`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('a GPX file through the import route', () => {
  it('is stored and listed with the own vessel as its owner', async () => {
    const start = Date.now() - 20 * MINUTE
    const point = (i: number) =>
      `<trkpt lat="${61 + i / 100}" lon="23"><time>${new Date(start + i * MINUTE).toISOString()}</time></trkpt>`
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Old passage</name><trkseg>${[0, 1, 2].map(point).join('')}</trkseg></trk></gpx>`
    const imported = await server.plugin('/imports?self=true', {
      method: 'POST',
      body: gpx,
      contentType: 'application/gpx+xml',
    })
    expect(imported.status).toBe(201)
    const [id] = (imported.body as { ids: string[] }).ids

    const listed = await server.apiV2(`/tracks?duration=PT1H&bbox=22.9,60.9,23.1,61.1`)
    // The route names the track as the Track API does on a server that
    // prefixes ids with the provider; an older one lists it bare.
    const local = id!.replace(/^tracks:/, '')
    const features = (listed.body as Collection).features.filter(({ properties }) => properties.id?.endsWith(local))
    expect(features.map(({ properties }) => [properties.context, properties.isSelf, properties.pointCount])).toEqual([
      [server.selfContext, true, 3],
    ])
    // The webapp's list of every import, through the server's own access check.
    const all = await server.plugin('/imports')
    expect(all.status).toBe(200)
    expect((all.body as { id: string; name: string }[]).find((entry) => entry.id === id)?.name).toBe('Old passage')
  })
})
