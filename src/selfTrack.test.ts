import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, SELF_CONTEXT } from './harness.test-utils.js'
import type { TestHarness } from './harness.test-utils.js'
import type { LatLngTuple } from './types.js'

const API = '/signalk/v1/api'
const HOUR = 60 * 60 * 1000

let harness: TestHarness | undefined

afterEach(() => {
  harness?.stop()
  harness = undefined
})

/**
 * A self track spanning three days, one point per hour, so time-window queries
 * have something to select from.
 *
 * The points are installed through `Tracks.initialTrack` rather than fed to the
 * position bus: `throttleTime` thins the bus against the wall clock, so a
 * synchronous burst would collapse to a single point whatever timestamps it
 * carried. This is the same entry point the History API bootstrap uses.
 */
function selfTrackOverTime() {
  const now = Date.now()
  const positions: LatLngTuple[] = []
  const timestamps: number[] = []
  for (let hoursAgo = 72; hoursAgo >= 0; hoursAgo--) {
    positions.push([60 + hoursAgo / 1000, 24])
    // Sit a second inside each hour boundary. The handler reads its own
    // Date.now() milliseconds later, so a point dated exactly on a boundary
    // would fall just outside the window and make these tests flaky.
    timestamps.push(now - hoursAgo * HOUR - 1000)
  }
  const h = createHarness({ selfPosition: [60, 24] })
  h.seedTrack(SELF_CONTEXT, positions, timestamps)
  harness = h
  return { h, now }
}

const pointCount = (body: { coordinates: unknown[][] }) => body.coordinates[0]?.length ?? 0

describe('GET /self/track', () => {
  it('serves the own vessel track', async () => {
    const { h } = selfTrackOverTime()

    const res = await request(h.app).get(`${API}/self/track`).expect(200)

    expect(res.body.type).toBe('MultiLineString')
    expect(pointCount(res.body)).toBe(73)
  })

  it('404s when the own vessel has no track', async () => {
    harness = createHarness({ selfPosition: [60, 24] })

    await request(harness.app).get(`${API}/self/track`).expect(404)
  })
})

describe('time windows', () => {
  it('narrows to the last hour with the Freeboard timespan parameter', async () => {
    const { h } = selfTrackOverTime()

    const res = await request(h.app).get(`${API}/self/track?timespan=1h`).expect(200)

    // hourly points, so a one-hour window holds the most recent one
    expect(pointCount(res.body)).toBe(1)
  })

  it('honours timespanOffset as hours back from now', async () => {
    const { h } = selfTrackOverTime()

    const res = await request(h.app).get(`${API}/self/track?timespan=23h&timespanOffset=1`).expect(200)

    // [now-24h, now-1h): 23 hourly points
    expect(pointCount(res.body)).toBe(23)
  })

  it('covers the whole track across the three bands Freeboard requests', async () => {
    const { h } = selfTrackOverTime()

    const [beyond, next23, last] = await Promise.all([
      request(h.app).get(`${API}/self/track?timespan=72h&timespanOffset=24`).expect(200),
      request(h.app).get(`${API}/self/track?timespan=23h&timespanOffset=1`).expect(200),
      request(h.app).get(`${API}/self/track?timespan=1h`).expect(200),
    ])

    // The bands are concatenated client-side, so the property that matters is
    // that they neither drop a point nor return one twice.
    const bands = [beyond!.body, next23!.body, last!.body] as { coordinates: number[][][] }[]
    const points = bands.flatMap((b) => b.coordinates[0] ?? []).map((p) => JSON.stringify(p))

    expect(points).toHaveLength(73)
    expect(new Set(points).size).toBe(73)
  })

  it('accepts the spec-shaped duration parameter', async () => {
    const { h } = selfTrackOverTime()

    const res = await request(h.app).get(`${API}/self/track?duration=2h`).expect(200)

    expect(pointCount(res.body)).toBe(2)
  })

  it('accepts explicit from/to', async () => {
    const { h, now } = selfTrackOverTime()
    const from = new Date(now - 3 * HOUR).toISOString()
    const to = new Date(now - HOUR).toISOString()

    const res = await request(h.app).get(`${API}/self/track?from=${from}&to=${to}`).expect(200)

    expect(pointCount(res.body)).toBe(2)
  })

  it('rejects an unparseable time with 400 rather than a silent full track', async () => {
    const { h } = selfTrackOverTime()

    const res = await request(h.app).get(`${API}/self/track?from=yesterday`).expect(400)

    expect(res.body.message).toMatch(/Invalid from/)
  })

  it('applies to the per-vessel route too', async () => {
    const { h } = selfTrackOverTime()
    const id = SELF_CONTEXT.replace('vessels.', '')

    const res = await request(h.app).get(`${API}/vessels/${id}/track?timespan=1h`).expect(200)

    expect(pointCount(res.body)).toBe(1)
  })
})

describe('resolution', () => {
  it('thins the track to the requested spacing', async () => {
    const { h } = selfTrackOverTime()

    const full = await request(h.app).get(`${API}/self/track`).expect(200)
    const thinned = await request(h.app).get(`${API}/self/track?resolution=6h`).expect(200)

    expect(pointCount(full.body)).toBe(73)
    // 72 hours at 6-hour spacing, plus the retained final point
    expect(pointCount(thinned.body)).toBeLessThan(pointCount(full.body))
    expect(pointCount(thinned.body)).toBe(13)
  })

  it('keeps the track extent when thinning', async () => {
    const { h } = selfTrackOverTime()

    const full = await request(h.app).get(`${API}/self/track`).expect(200)
    const thinned = await request(h.app).get(`${API}/self/track?resolution=6h`).expect(200)

    expect(thinned.body.coordinates[0][0]).toEqual(full.body.coordinates[0][0])
    expect(thinned.body.coordinates[0].at(-1)).toEqual(full.body.coordinates[0].at(-1))
  })

  it('combines a window and a resolution', async () => {
    const { h } = selfTrackOverTime()

    const res = await request(h.app).get(`${API}/self/track?timespan=24h&resolution=6h`).expect(200)

    expect(pointCount(res.body)).toBe(5)
  })
})

describe('segmentation', () => {
  it('returns one line by default, however large the gaps', async () => {
    // Segmenting is opt-in: without segmentGapMinutes the response shape is
    // exactly what it was before the setting existed.
    const h = createHarness()
    const now = Date.now()
    h.seedTrack(
      SELF_CONTEXT,
      [
        [60, 24],
        [60.1, 24],
        [60.2, 24],
      ],
      [now - 4 * HOUR, now - 2 * HOUR, now],
    )

    const res = await request(h.app).get(`${API}/self/track`).expect(200)
    expect(res.body.coordinates).toHaveLength(1)
  })

  it('splits the track when a gap exceeds segmentGapMinutes', async () => {
    const h = createHarness({ config: { segmentGapMinutes: 30 } })
    const now = Date.now()
    // Two clusters an hour apart: 30 minutes of silence in between.
    h.seedTrack(
      SELF_CONTEXT,
      [
        [60, 24],
        [60.1, 24],
        [60.2, 24],
        [60.3, 24],
      ],
      [now - 2 * HOUR, now - 2 * HOUR + 60_000, now - HOUR, now - HOUR + 60_000],
    )

    const res = await request(h.app).get(`${API}/self/track`).expect(200)
    expect(res.body.type).toBe('MultiLineString')
    expect(res.body.coordinates).toHaveLength(2)
    expect(res.body.coordinates.map((s: unknown[]) => s.length)).toEqual([2, 2])
  })
})
