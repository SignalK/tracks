import { Temporal } from '@js-temporal/polyfill'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createHarness, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { HistoryValuesQuery, TestHarness } from './harness.test-utils.js'
import { decimate, positionsOf, toImportedTrack } from './importedTracks.js'
import type { TrackApi, TrackImport } from './trackApi.js'
import type { TimedPosition } from './types.js'

const t0 = Date.UTC(2026, 5, 1, 9, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

const passage = (overrides: Partial<TrackImport['properties']> = {}, timed = true): TrackImport => ({
  type: 'Feature',
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [24.9, 60.1],
        [25.0, 60.2],
      ],
      [
        [25.1, 60.3],
        [25.2, 60.4],
      ],
    ],
  },
  properties: {
    ...(timed
      ? {
          coordTimes: [
            [iso(t0), iso(t0 + 60_000)],
            [iso(t0 + 3_600_000), iso(t0 + 3_660_000)],
          ],
        }
      : {}),
    name: 'Race day',
    context: OTHER_CONTEXT,
    colour: 'red',
    ...overrides,
  },
})

const contextless = (): TrackImport => {
  const track = passage()
  delete track.properties.context
  return track
}

const providerOf = (h: TestHarness): Required<TrackApi> => {
  const provider = h.trackProvider()
  if (!provider?.storeTrack || !provider.getTrack || !provider.deleteTrack) {
    throw new Error('plugin registered no provider that stores tracks')
  }
  return provider as Required<TrackApi>
}

const day = {
  from: Temporal.Instant.fromEpochMilliseconds(t0 - 3_600_000),
  to: Temporal.Instant.fromEpochMilliseconds(t0 + 86_400_000),
}

describe('toImportedTrack', () => {
  it('keeps the client metadata apart from what the API defines', () => {
    const track = toImportedTrack(passage(), 'imported:x')
    expect(track).toMatchObject({ id: 'imported:x', name: 'Race day', context: OTHER_CONTEXT })
    expect(track.metadata).toEqual({ colour: 'red' })
    expect(track.segments[0]![0]).toEqual({ position: [60.1, 24.9], timestamp: t0 })
  })

  it('sorts times within a segment but never across segments', () => {
    const track = passage({
      coordTimes: [
        [iso(t0 + 60_000), iso(t0)],
        [iso(t0 - 1000), iso(t0 - 500)],
      ],
    })
    const segments = toImportedTrack(track).segments
    expect(segments[0]!.map(({ timestamp }) => timestamp)).toEqual([t0, t0 + 60_000])
    expect(segments[1]!.map(({ timestamp }) => timestamp)).toEqual([t0 - 1000, t0 - 500])
  })

  it('refuses a track with neither times nor a vessel', () => {
    const track = passage({}, false)
    delete track.properties.context
    expect(() => toImportedTrack(track)).toThrow(expect.objectContaining({ isTrackRejected: true }))
  })

  it('accepts a track without times when it names a vessel', () => {
    expect(toImportedTrack(passage({}, false)).segments[0]![0]).toEqual({ position: [60.1, 24.9] })
  })
})

describe('positionsOf', () => {
  it('starts each posted segment on a new line', () => {
    const points = positionsOf(toImportedTrack(passage()), null)
    expect(points.map(({ breakBefore }) => breakBefore === true)).toEqual([false, false, true, false])
  })

  it('clips each segment on its own, never borrowing a point from the one before', () => {
    // The second segment starts inside the box; the point before it, outside,
    // belongs to the first segment and must not be joined to it.
    const points = positionsOf(toImportedTrack(passage()), { sw: [60.25, 25.05], ne: [60.5, 25.5] })
    expect(points.map(({ position }) => position)).toEqual([
      [60.3, 25.1],
      [60.4, 25.2],
    ])
    expect(points[0]!.breakBefore).toBeUndefined()
  })
  it('keeps the break between segments when the window narrows them', () => {
    const track = toImportedTrack(passage())
    const points = positionsOf(track, null, { from: t0 + 30_000, to: t0 + 3_630_000 })
    expect(points.map(({ timestamp }) => timestamp)).toEqual([t0 + 60_000, t0 + 3_600_000])
    expect(points[1]!.breakBefore).toBe(true)
  })
})

describe('decimate', () => {
  const line = (n: number, breakAt?: number): TimedPosition[] =>
    Array.from({ length: n }, (_, i) => ({
      position: [60, 24 + i / 100],
      timestamp: 0,
      ...(i === breakAt ? { breakBefore: true } : {}),
    }))

  it('keeps the first and last of evenly chosen points', () => {
    const kept = decimate(line(101), 5)
    expect(kept.map(({ position }) => position[1])).toEqual([24, 24.25, 24.5, 24.75, 25])
  })

  it('passes a dropped break on to the next point kept', () => {
    const kept = decimate(line(101, 30), 5)
    expect(kept.map(({ breakBefore }) => breakBefore === true)).toEqual([false, false, true, false, false])
  })
})

describe('imported tracks through the Track API', () => {
  it('stores a track and reads it back whole, with its times', async () => {
    const h = createHarness()
    try {
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage())
      expect(id).toMatch(/^imported:[0-9a-f-]{36}$/)
      const feature = await provider.getTrack(id)
      expect(feature?.geometry?.coordinates).toEqual(passage().geometry.coordinates)
      expect(feature?.properties).toMatchObject({
        id,
        name: 'Race day',
        context: OTHER_CONTEXT,
        isSelf: false,
        colour: 'red',
        pointCount: 4,
        from: iso(t0),
        to: iso(t0 + 3_660_000),
        coordTimes: passage().properties.coordTimes,
      })
    } finally {
      await h.stop()
    }
  })

  it('returns a track without times without inventing any', async () => {
    const h = createHarness()
    try {
      const provider = providerOf(h)
      const feature = await provider.getTrack(await provider.storeTrack(passage({}, false)))
      expect(feature?.properties.pointCount).toBe(4)
      expect(feature?.properties).not.toHaveProperty('from')
      expect(feature?.properties).not.toHaveProperty('to')
      expect(feature?.properties).not.toHaveProperty('coordTimes')
    } finally {
      await h.stop()
    }
  })

  it('deletes an imported track and answers false for any other id', async () => {
    const h = createHarness()
    try {
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage())
      expect(await provider.deleteTrack(id)).toBe(true)
      expect(await provider.getTrack(id)).toBeUndefined()
      expect(await provider.deleteTrack(id)).toBe(false)
      expect(await provider.deleteTrack(`unknown:${SELF_CONTEXT}`)).toBe(false)
      expect(await provider.getTrack(SELF_CONTEXT)).toBeUndefined()
    } finally {
      await h.stop()
    }
  })

  it('lists an import as a feature of its own beside the recorded track', async () => {
    const h = createHarness()
    try {
      h.seedTrack(
        OTHER_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
        ],
        [t0, t0 + 60_000],
      )
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage())
      const { features } = await provider.getTracks({ ...day, contexts: [OTHER_CONTEXT] })
      expect(features.map(({ properties }) => properties.id)).toEqual([`recorded:${OTHER_CONTEXT}`, id])
      expect(await provider.getTrackContexts({ ...day, contexts: [OTHER_CONTEXT] })).toEqual([OTHER_CONTEXT])
    } finally {
      await h.stop()
    }
  })

  it('lists a track that names no vessel only when no vessel is asked for', async () => {
    const h = createHarness()
    try {
      const provider = providerOf(h)
      const id = await provider.storeTrack(contextless())
      const all = await provider.getTracks(day)
      expect(all.features.map(({ properties }) => properties.id)).toEqual([id])
      expect(all.features[0]!.properties).not.toHaveProperty('context')
      expect(all.features[0]!.properties).not.toHaveProperty('isSelf')
      expect((await provider.getTracks({ ...day, contexts: [OTHER_CONTEXT] })).features).toEqual([])
      expect(await provider.getTrackContexts(day)).toEqual([])
    } finally {
      await h.stop()
    }
  })

  it('cuts an import to the window and leaves out one without times', async () => {
    const h = createHarness()
    try {
      const provider = providerOf(h)
      await provider.storeTrack(passage())
      await provider.storeTrack(passage({}, false))
      const { features } = await provider.getTracks({
        from: Temporal.Instant.fromEpochMilliseconds(t0 + 3_600_000),
        to: Temporal.Instant.fromEpochMilliseconds(t0 + 86_400_000),
        times: true,
      })
      expect(features).toHaveLength(1)
      expect(features[0]!.properties.coordTimes).toEqual([[iso(t0 + 3_600_000), iso(t0 + 3_660_000)]])
    } finally {
      await h.stop()
    }
  })

  it('matches a box on the points and clips to it', async () => {
    const h = createHarness()
    try {
      const provider = providerOf(h)
      await provider.storeTrack(passage())
      const inside = await provider.getTracks({ ...day, bbox: [25.05, 60.25, 25.5, 60.5], clip: true })
      expect(inside.features[0]!.geometry?.coordinates).toEqual([
        [
          [25.1, 60.3],
          [25.2, 60.4],
        ],
      ])
      // The extent overlaps this box, but no point lies inside it.
      const between = await provider.getTracks({ ...day, bbox: [25.01, 60.21, 25.09, 60.29], clip: true })
      expect(between.features).toEqual([])
    } finally {
      await h.stop()
    }
  })

  it('applies the point budget to a track without times', async () => {
    const h = createHarness()
    try {
      const provider = providerOf(h)
      await provider.storeTrack(passage({}, false))
      const { features } = await provider.getTracks({ contexts: [OTHER_CONTEXT], maxPoints: 2 })
      expect(features[0]!.properties.pointCount).toBe(2)
      expect(features[0]!.properties).not.toHaveProperty('resolution')
    } finally {
      await h.stop()
    }
  })

  it('never asks the history provider about an import', async () => {
    const asked: HistoryValuesQuery[] = []
    const h = createHarness({ history: { contexts: [], rows: [], onValues: (query) => asked.push(query) } })
    try {
      const provider = providerOf(h)
      await provider.storeTrack(passage())
      expect((await provider.getTracks({ ...day, contexts: [OTHER_CONTEXT] })).features).toHaveLength(1)
      expect(asked).toEqual([])
    } finally {
      await h.stop()
    }
  })

  it('refuses a track with neither times nor a vessel as the client’s error', async () => {
    const h = createHarness()
    try {
      const track = passage({}, false)
      delete track.properties.context
      await expect(providerOf(h).storeTrack(track)).rejects.toMatchObject({ isTrackRejected: true })
    } finally {
      await h.stop()
    }
  })

  // v1 answers which vessels are where now; an imported passage is not a
  // vessel's position, so it must never appear there as one.
  it('keeps imports out of the v1 routes', async () => {
    const h = createHarness()
    try {
      await providerOf(h).storeTrack(passage())
      const res = await request(h.app).get('/signalk/v1/api/tracks?bbox=24,59,26,61').expect(200)
      expect(res.body).toEqual({})
      await request(h.app).get('/signalk/v1/api/vessels/urn:mrn:imo:mmsi:987654321/track').expect(404)
    } finally {
      await h.stop()
    }
  })
})
