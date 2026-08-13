import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { TestHarness } from './harness.test-utils.js'

const API = '/signalk/v1/api'
const SELF_ID = SELF_CONTEXT.replace('vessels.', '')

let harness: TestHarness | undefined

afterEach(() => {
  harness?.stop()
  harness = undefined
})

const withTracks = (...positions: [string, [number, number]][]) => {
  harness = createHarness({ selfPosition: [60, 24] })
  for (const [context, position] of positions) {
    harness.emit(context, position)
  }
  return harness
}

describe('GET /vessels/:vesselId/track', () => {
  it('returns a MultiLineString in [lng, lat] order', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)

    expect(res.body.type).toBe('MultiLineString')
    // internal storage is [lat, lng]; GeoJSON output flips to [lng, lat]
    expect(res.body.coordinates[0][0]).toEqual([24.9, 60.1])
  })

  it('resolves the self alias to the self context', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/self/track`).expect(200)

    expect(res.body.coordinates[0][0]).toEqual([24.9, 60.1])
  })

  it('404s for a vessel with no track', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/urn:mrn:imo:mmsi:000000000/track`).expect(404)

    expect(res.body.message).toMatch(/No track available/)
  })
})

describe('GET /tracks', () => {
  it('returns every accumulated context keyed by context id', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]], [OTHER_CONTEXT, [60.2, 24.8]])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(Object.keys(res.body).sort()).toEqual([OTHER_CONTEXT, SELF_CONTEXT].sort())
    expect(res.body[SELF_CONTEXT].type).toBe('MultiLineString')
  })

  it('filters by bounding box on the last position', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]], [OTHER_CONTEXT, [10, 10]])

    const res = await request(h.app).get(`${API}/tracks?bbox=59,24,61,25`).expect(200)

    expect(Object.keys(res.body)).toEqual([SELF_CONTEXT])
  })

  // A coordinate of 0 is valid but falsy; a truthiness-based filter used to
  // reject the whole bbox, so any box touching the equator returned nothing.
  it('accepts a bounding box with zero coordinates', async () => {
    const h = withTracks([SELF_CONTEXT, [1, 1]])

    const res = await request(h.app).get(`${API}/tracks?bbox=0,0,2,2`).expect(200)

    expect(Object.keys(res.body)).toEqual([SELF_CONTEXT])
  })

  it('filters by radius from the self position', async () => {
    const h = withTracks([SELF_CONTEXT, [60, 24]], [OTHER_CONTEXT, [10, 10]])

    const res = await request(h.app).get(`${API}/tracks?radius=10000`).expect(200)

    expect(Object.keys(res.body)).toEqual([SELF_CONTEXT])
  })

  it('serves the wildcard form', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/tracks/anything`).expect(200)
  })
})

describe('when the plugin has been stopped', () => {
  it('keeps serving accumulated tracks without throwing', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])
    h.stop()

    // stop() unsubscribes from the bus but leaves the routes mounted and the
    // accumulator intact, mirroring the server. The handlers must degrade
    // rather than throw; `notAvailable` only applies before start().
    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[SELF_CONTEXT].coordinates[0][0]).toEqual([24.9, 60.1])
  })

  it('stops accumulating new positions', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])
    h.stop()
    h.emit(SELF_CONTEXT, [61, 25])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[SELF_CONTEXT].coordinates[0]).toEqual([[24.9, 60.1]])
  })
})

// ── Freeboard-SK compatibility ─────────────────────────────────────────────
// These pinned the gap before it was fixed: /self/track 404'd and the time
// parameters were ignored. Time-window behaviour itself is covered in
// selfTrack.test.ts; this just holds the route open.
describe('Freeboard-SK compatibility', () => {
  it('serves /self/track', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/self/track`).expect(200)

    expect(res.body.type).toBe('MultiLineString')
    expect(res.body.coordinates[0][0]).toEqual([24.9, 60.1])
  })

  it('accepts the timespan and resolution parameters', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/vessels/${SELF_ID}/track?timespan=1h&resolution=60`).expect(200)
  })
})

// Per-point recording times, for consumers that draw a track as dots spaced by
// time rather than as a line — the IMO AIS presentation in
// SignalK/signalk-server#2504. Opt-in so existing clients see no change.
describe('per-point timestamps', () => {
  const T0 = Date.UTC(2026, 7, 14, 9, 0, 0)
  const MINUTE = 60_000

  const seeded = () => {
    harness = createHarness({ selfPosition: [60, 24] })
    harness.seedTrack(
      SELF_CONTEXT,
      [
        [60.1, 24.9],
        [60.2, 25.0],
      ],
      [T0, T0 + MINUTE],
    )
    return harness
  }

  it('omits times unless asked', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)

    expect(res.body.times).toBeUndefined()
    expect(res.body.coordinates[0]).toHaveLength(2)
  })

  it('serves ISO-8601 UTC times aligned with the coordinates', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times=true`).expect(200)

    expect(res.body.times).toEqual([['2026-08-14T09:00:00.000Z', '2026-08-14T09:01:00.000Z']])
    expect(res.body.times[0]).toHaveLength(res.body.coordinates[0].length)
  })

  it('treats a valueless ?times as true', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times`).expect(200)

    expect(res.body.times[0][0]).toBe('2026-08-14T09:00:00.000Z')
  })

  it('honours times=false', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times=false`).expect(200)

    expect(res.body.times).toBeUndefined()
  })

  it('400s on an unparseable times value', async () => {
    await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times=maybe`).expect(400)
  })

  it('serves times on /self/track too', async () => {
    const res = await request(seeded().app).get(`${API}/self/track?times`).expect(200)

    expect(res.body.times[0]).toHaveLength(2)
  })
})
