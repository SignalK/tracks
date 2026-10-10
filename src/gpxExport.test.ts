import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { fromGpx, toGpx } from './gpx.js'
import { createHarness, OTHER_CONTEXT } from './harness.test-utils.js'
import type { TestHarness } from './harness.test-utils.js'
import type { TrackApi, TrackImport } from './trackApi.js'

const MINUTE = 60_000
const t0 = Date.parse('2026-09-01T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const withHarness = async (run: (h: TestHarness) => Promise<void>) => {
  const h = createHarness()
  try {
    await run(h)
  } finally {
    await h.stop()
  }
}

const store = async (h: TestHarness, track: TrackImport): Promise<string> => {
  const provider = h.trackProvider() as Required<TrackApi> | undefined
  if (!provider?.storeTrack) {
    throw new Error('plugin registered no provider that stores tracks')
  }
  return provider.storeTrack(track)
}

const passage = (properties: TrackImport['properties']): TrackImport => ({
  type: 'Feature',
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [24.9, 60.1],
        [25.0, 60.2],
      ],
    ],
  },
  properties,
})

describe('toGpx with untimed points', () => {
  // An untimed import written with times would come back as a 1970 passage.
  it('writes a point without a time as an empty trkpt', () => {
    const xml = toGpx([{ name: 'Plan', segments: [[{ position: [60.1, 24.9] }]] }])

    expect(xml).toContain('<trkpt lat="60.1" lon="24.9"/>')
    expect(xml).not.toMatch(/<trkpt[^>]*>\s*<time>/)
    expect(fromGpx(xml)[0]!.segments[0]![0]!.position).toEqual([60.1, 24.9])
  })
})

describe('exporting an imported track', () => {
  it('downloads it as GPX under its own name', () =>
    withHarness(async (h) => {
      const id = await store(
        h,
        passage({ name: 'Race day', context: OTHER_CONTEXT, coordTimes: [[iso(t0), iso(t0 + MINUTE)]] }),
      )

      const res = await request(h.app)
        .get(`/plugins/tracks/imports/${encodeURIComponent(id)}/track.gpx`)
        .expect(200)

      expect(res.headers['content-type']).toContain('application/gpx+xml')
      expect(res.headers['content-disposition']).toContain('Race-day.gpx')
      const [track] = fromGpx(res.text)
      expect(track).toEqual({
        name: 'Race day',
        context: OTHER_CONTEXT,
        segments: [
          [
            { position: [60.1, 24.9], timestamp: t0 },
            { position: [60.2, 25.0], timestamp: t0 + MINUTE },
          ],
        ],
      })
    }))

  it('writes no times for an untimed import', () =>
    withHarness(async (h) => {
      const id = await store(h, passage({ name: 'Plan', context: OTHER_CONTEXT }))

      const res = await request(h.app)
        .get(`/plugins/tracks/imports/${encodeURIComponent(id)}/track.gpx`)
        .expect(200)

      expect(res.text).not.toContain('<time>1970')
      expect(fromGpx(res.text)[0]!.segments[0]).toHaveLength(2)
    }))

  it('names an unnamed import after its vessel', () =>
    withHarness(async (h) => {
      const id = await store(h, passage({ context: OTHER_CONTEXT, coordTimes: [[iso(t0), iso(t0 + MINUTE)]] }))

      const res = await request(h.app)
        .get(`/plugins/tracks/imports/${encodeURIComponent(id)}/track.gpx`)
        .expect(200)

      expect(fromGpx(res.text)[0]!.name).toMatch(/^AIS /)
    }))

  it('answers 404 for an id that is no import', () =>
    withHarness(async (h) => {
      await request(h.app).get('/plugins/tracks/imports/imported%3Anope/track.gpx').expect(404)
      await request(h.app)
        .get(`/plugins/tracks/imports/${encodeURIComponent(`recorded:${OTHER_CONTEXT}`)}/track.gpx`)
        .expect(404)
    }))
})
