import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, it, vi } from 'vitest'
import { createHarness, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { TrackApi } from './trackApi.js'

/**
 * The plugin as a v2 Track API provider.
 *
 * Driven through the harness rather than by constructing the provider
 * directly, so registration itself is covered: a provider that is never
 * offered to the server is as broken as one that answers wrongly.
 */

const providerOf = (h: { trackProvider: () => TrackApi | undefined }): TrackApi => {
  const provider = h.trackProvider()
  if (!provider) {
    throw new Error('plugin registered no track provider')
  }
  return provider
}

describe('track provider registration', () => {
  it('registers a provider on a server that offers the v2 Track API', () => {
    const h = createHarness()
    try {
      expect(h.registrations()).toBe(1)
      expect(typeof providerOf(h).getTracks).toBe('function')
      expect(typeof providerOf(h).getTrackContexts).toBe('function')
    } finally {
      h.stop()
    }
  })

  // Older servers have no registerTrackApiProvider. The optional call must not
  // throw, or the plugin fails to start there at all.
  it('starts on a server without the Track API', () => {
    const h = createHarness({ withoutTrackApi: true })
    try {
      expect(h.trackProvider()).toBeUndefined()
      expect(h.errors).toEqual([])
    } finally {
      h.stop()
    }
  })
})

describe('getTracks', () => {
  it('returns a GeoJSON FeatureCollection in lng,lat order', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
        ],
        [t0, t0 + 30_000],
      )

      const res = await providerOf(h).getTracks({})

      expect(res.type).toBe('FeatureCollection')
      expect(res.features).toHaveLength(1)
      const [feature] = res.features
      expect(feature!.type).toBe('Feature')
      // Internally [lat, lng]; GeoJSON is [lng, lat]. Getting this backwards
      // puts a Baltic track in Somalia, which renders without erroring.
      expect(feature!.geometry).toEqual({
        type: 'MultiLineString',
        coordinates: [
          [
            [24.9, 60.1],
            [25.0, 60.2],
          ],
        ],
      })
      expect(feature!.properties.context).toBe(SELF_CONTEXT)
      expect(feature!.properties.isSelf).toBe(true)
      expect(feature!.properties.pointCount).toBe(2)
      expect(feature!.properties.from).toBe(new Date(t0).toISOString())
      expect(feature!.properties.to).toBe(new Date(t0 + 30_000).toISOString())
      // bbox is west,south,east,north — GeoJSON order, like the coordinates.
      expect(feature!.properties.bbox).toEqual([24.9, 60.1, 25.0, 60.2])
    } finally {
      h.stop()
    }
  })

  it('marks other vessels as not self', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(OTHER_CONTEXT, [[10, 20]], [t0])

      const res = await providerOf(h).getTracks({})
      const feature = res.features.find((f) => f.properties.context === OTHER_CONTEXT)

      expect(feature!.properties.isSelf).toBe(false)
    } finally {
      h.stop()
    }
  })

  // v2 accepts the `self` alias, but the store keys on the qualified context.
  // Resolving it is SignalK/tracks#18; forgetting it returns an empty result
  // for the one query every client makes.
  it('resolves the self alias to the qualified context', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60, 24]], [t0])
      h.seedTrack(OTHER_CONTEXT, [[10, 20]], [t0])

      for (const alias of ['self', 'vessels.self', SELF_CONTEXT]) {
        const res = await providerOf(h).getTracks({ contexts: [alias] })
        expect(res.features.map((f) => f.properties.context)).toEqual([SELF_CONTEXT])
      }
    } finally {
      h.stop()
    }
  })

  it('narrows to the requested contexts', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60, 24]], [t0])
      h.seedTrack(OTHER_CONTEXT, [[10, 20]], [t0])

      const all = await providerOf(h).getTracks({})
      expect(all.features).toHaveLength(2)

      const one = await providerOf(h).getTracks({ contexts: [OTHER_CONTEXT] })
      expect(one.features.map((f) => f.properties.context)).toEqual([OTHER_CONTEXT])
    } finally {
      h.stop()
    }
  })

  it('applies a time window', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
          [60.3, 25.1],
        ],
        [t0, t0 + 60_000, t0 + 120_000],
      )

      const res = await providerOf(h).getTracks({
        from: Temporal.Instant.fromEpochMilliseconds(t0 + 30_000),
        to: Temporal.Instant.fromEpochMilliseconds(t0 + 90_000),
      })

      expect(res.features[0]!.properties.pointCount).toBe(1)
      expect(res.features[0]!.geometry).toEqual({
        type: 'MultiLineString',
        coordinates: [[[25.0, 60.2]]],
      })
    } finally {
      h.stop()
    }
  })

  // The HTTP route never sends `duration` — the server resolves it into
  // from/to and deletes it. This covers the fallback for a caller reaching the
  // provider directly, and pins the UTC framing: Instant.subtract refuses
  // day-and-larger units, so `P1D` has to go via a zoned date-time.
  it('resolves duration back from the end of the window', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
          [60.3, 25.1],
        ],
        // One point before the window, one inside it, one at its exclusive end.
        [t0, t0 + 90_000, t0 + 120_000],
      )

      const res = await providerOf(h).getTracks({
        to: Temporal.Instant.fromEpochMilliseconds(t0 + 120_000),
        duration: Temporal.Duration.from({ minutes: 1 }),
      })

      expect(res.features[0]!.properties.pointCount).toBe(1)
      expect(res.features[0]!.properties.from).toBe(new Date(t0 + 90_000).toISOString())
    } finally {
      h.stop()
    }
  })

  it('accepts a day-scale duration', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60.1, 24.9]], [t0 - 12 * 3_600_000])

      const res = await providerOf(h).getTracks({
        to: Temporal.Instant.fromEpochMilliseconds(t0),
        duration: Temporal.Duration.from({ days: 1 }),
      })

      expect(res.features[0]!.properties.pointCount).toBe(1)
    } finally {
      h.stop()
    }
  })

  // A client fetching a long track in pieces walks adjacent windows. With a
  // closed end the point at the shared boundary lands in both and is drawn
  // twice, so an explicit `to` is exclusive — as the v1 routes have it.
  it('does not repeat the boundary point across adjacent windows', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
          [60.3, 25.1],
        ],
        [t0, t0 + 60_000, t0 + 120_000],
      )
      const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms)

      const first = await providerOf(h).getTracks({ from: at(t0), to: at(t0 + 60_000), times: true })
      const second = await providerOf(h).getTracks({ from: at(t0 + 60_000), to: at(t0 + 120_000), times: true })

      const times = (r: Awaited<ReturnType<TrackApi['getTracks']>>) =>
        r.features[0]?.properties.coordTimes?.flat() ?? []
      const overlap = times(first).filter((t) => times(second).includes(t))

      expect(overlap).toEqual([])
      // and nothing is lost at the seam
      expect([...times(first), ...times(second)]).toEqual([
        new Date(t0).toISOString(),
        new Date(t0 + 60_000).toISOString(),
      ])
    } finally {
      h.stop()
    }
  })

  // Without an explicit end the window runs to now, has no neighbour to
  // overlap, and must keep the newest fix.
  it('keeps the newest point when no end is given', async () => {
    const h = createHarness()
    try {
      const now = Date.UTC(2026, 7, 14, 9, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(now)
      try {
        h.seedTrack(
          SELF_CONTEXT,
          [
            [60.1, 24.9],
            [60.2, 25.0],
          ],
          // The newest point sits exactly on the window's end, which is where
          // an exclusive end would silently drop the latest fix.
          [now - 60_000, now],
        )

        const res = await providerOf(h).getTracks({
          from: Temporal.Instant.fromEpochMilliseconds(now - 120_000),
        })

        expect(res.features[0]!.properties.pointCount).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    } finally {
      h.stop()
    }
  })

  // The bbox arrives in GeoJSON order and has to be swapped to the [lat, lng]
  // corners the store filters on.
  it('filters by bbox in west,south,east,north order', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60.2, 25.0]], [t0])
      h.seedTrack(OTHER_CONTEXT, [[-34, 135]], [t0])

      const baltic = await providerOf(h).getTracks({ bbox: [24, 59, 26, 61] })
      expect(baltic.features.map((f) => f.properties.context)).toEqual([SELF_CONTEXT])

      // The same box written latitude-first must not match it.
      const swapped = await providerOf(h).getTracks({ bbox: [59, 24, 61, 26] })
      expect(swapped.features.map((f) => f.properties.context)).not.toContain(SELF_CONTEXT)
    } finally {
      h.stop()
    }
  })

  it('omits geometry when geometry=false, keeping the metadata', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60.1, 24.9]], [t0])

      const res = await providerOf(h).getTracks({ geometry: false })

      expect(res.features[0]!.geometry).toBeNull()
      expect(res.features[0]!.properties.pointCount).toBe(1)
      expect(res.features[0]!.properties.bbox).toEqual([24.9, 60.1, 24.9, 60.1])
    } finally {
      h.stop()
    }
  })

  it('serves coordTimes aligned with the coordinates when times is asked for', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
        ],
        [t0, t0 + 30_000],
      )

      const without = await providerOf(h).getTracks({})
      expect(without.features[0]!.properties.coordTimes).toBeUndefined()

      const res = await providerOf(h).getTracks({ times: true })
      const { coordTimes } = res.features[0]!.properties
      expect(coordTimes).toEqual([[new Date(t0).toISOString(), new Date(t0 + 30_000).toISOString()]])
      // The alignment invariant a consumer relies on.
      expect(coordTimes![0]!).toHaveLength(
        (res.features[0]!.geometry as { coordinates: [number, number][][] }).coordinates[0]!.length,
      )
    } finally {
      h.stop()
    }
  })

  it('thins to the requested resolution and reports it', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
          [60.3, 25.1],
        ],
        [t0, t0 + 10_000, t0 + 60_000],
      )

      const full = await providerOf(h).getTracks({})
      expect(full.features[0]!.properties.pointCount).toBe(3)
      // Absent rather than echoed, so a client can tell a thinned track apart.
      expect(full.features[0]!.properties.resolution).toBeUndefined()

      const thinned = await providerOf(h).getTracks({
        resolution: Temporal.Duration.from({ seconds: 30 }),
      })
      expect(thinned.features[0]!.properties.pointCount).toBe(2)
      expect(thinned.features[0]!.properties.resolution).toBe('PT30S')
    } finally {
      h.stop()
    }
  })

  // The API validates `resolution` as any positive ISO 8601 duration, so a
  // calendar unit reaches the provider. Temporal's total() refuses weeks,
  // months and years without a reference point, which surfaced as a 500 for a
  // perfectly valid query string.
  it('accepts a calendar-unit resolution', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
          [60.3, 25.1],
          [60.4, 25.2],
        ],
        [t0, t0 + 60_000, t0 + 120_000, t0 + 180_000],
      )

      for (const unit of ['P1W', 'P1M', 'P1Y']) {
        const res = await providerOf(h).getTracks({ resolution: Temporal.Duration.from(unit) })

        // Each spacing is far wider than the whole track, so thinning keeps the
        // first point and the last — thin() always ends on the newest fix.
        expect(res.features[0]!.properties.pointCount).toBe(2)
        expect(res.features[0]!.properties.resolution).toBe(unit)
      }
    } finally {
      h.stop()
    }
  })

  // The reference point decides what a calendar unit is worth, and the doc
  // comment states those numbers. Pinned so the two cannot drift apart.
  it('resolves calendar units against a fixed reference', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      const day = 86_400_000
      const spacings: [string, number][] = [
        ['P1W', 7 * day],
        ['P1M', 31 * day],
        ['P1Y', 366 * day],
      ]

      for (const [unit, expected] of spacings) {
        // Four points bracketing the spacing: one a day short of it, one a
        // millisecond past it, and a terminal point far beyond. The terminal
        // point is there so that thin()'s unconditional keep-the-last rule
        // lands on a point no assertion depends on — otherwise a track whose
        // last point sits exactly on the boundary would be kept either way,
        // and the spacing itself would go untested.
        h.seedTrack(
          SELF_CONTEXT,
          [
            [60.1, 24.9],
            [60.2, 25.0],
            [60.3, 25.1],
            [60.4, 25.2],
          ],
          [t0, t0 + expected - day, t0 + expected + 1, t0 + 3 * expected],
        )

        const res = await providerOf(h).getTracks({
          resolution: Temporal.Duration.from(unit),
          times: true,
        })

        const kept = res.features[0]!.properties.coordTimes!.flat()

        // The short point is dropped, the one past the spacing is kept.
        expect(kept).toEqual([
          new Date(t0).toISOString(),
          new Date(t0 + expected + 1).toISOString(),
          new Date(t0 + 3 * expected).toISOString(),
        ])
      }
    } finally {
      h.stop()
    }
  })

  // The same hazard on the duration path, which resolves through a zoned
  // date-time and so handles calendar units already.
  it('accepts a calendar-unit duration', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60.1, 24.9]], [t0 - 3 * 86_400_000])

      const res = await providerOf(h).getTracks({
        to: Temporal.Instant.fromEpochMilliseconds(t0),
        duration: Temporal.Duration.from('P1W'),
      })

      expect(res.features[0]!.properties.pointCount).toBe(1)
    } finally {
      h.stop()
    }
  })

  it('splits into segments across a recording gap', async () => {
    const h = createHarness({ config: { segmentGapMinutes: 5 } })
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
          [60.3, 25.1],
        ],
        [t0, t0 + 60_000, t0 + 3_600_000],
      )

      const res = await providerOf(h).getTracks({ times: true })
      const { coordinates } = res.features[0]!.geometry as { coordinates: [number, number][][] }

      expect(coordinates).toHaveLength(2)
      expect(coordinates[0]).toHaveLength(2)
      expect(coordinates[1]).toHaveLength(1)
      expect(res.features[0]!.properties.coordTimes).toHaveLength(2)
    } finally {
      h.stop()
    }
  })

  it('returns an empty collection when nothing has been recorded', async () => {
    const h = createHarness()
    try {
      await expect(providerOf(h).getTracks({})).resolves.toEqual({
        type: 'FeatureCollection',
        features: [],
      })
    } finally {
      h.stop()
    }
  })
})

describe('getTrackContexts', () => {
  // A store matches on the *last* position, so a context can pass the spatial
  // filter and still have nothing inside the time window. Listing it while
  // getTracks returns no feature for it sends a client to fetch a track that
  // is not there.
  it('agrees with getTracks about what matched', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60, 24]], [t0])

      const query = {
        from: Temporal.Instant.fromEpochMilliseconds(t0 + 999_000),
        to: Temporal.Instant.fromEpochMilliseconds(t0 + 1_999_000),
      }

      const features = (await providerOf(h).getTracks(query)).features
      const contexts = await providerOf(h).getTrackContexts(query)

      expect(features).toEqual([])
      expect(contexts).toEqual([])
    } finally {
      h.stop()
    }
  })

  it('lists the contexts that match, without the geometry', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(SELF_CONTEXT, [[60.2, 25.0]], [t0])
      h.seedTrack(OTHER_CONTEXT, [[-34, 135]], [t0])

      await expect(providerOf(h).getTrackContexts({})).resolves.toEqual(
        expect.arrayContaining([SELF_CONTEXT, OTHER_CONTEXT]),
      )
      await expect(providerOf(h).getTrackContexts({ bbox: [24, 59, 26, 61] })).resolves.toEqual([SELF_CONTEXT])
    } finally {
      h.stop()
    }
  })
})
