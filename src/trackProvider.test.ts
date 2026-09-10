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

const providerBbox = (res: Awaited<ReturnType<TrackApi['getTracks']>>) => res.features[0]!.properties.bbox

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

  // RFC 7946 writes a box crossing the antimeridian with west greater than
  // east. A plain min/max reports two fixes two degrees apart as spanning 358.
  it('reports a dateline-crossing track as the narrow box', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [0, 179],
          [0, -179],
        ],
        [t0, t0 + 1000],
      )

      expect(providerBbox(await providerOf(h).getTracks({}))).toEqual([179, 0, -179, 0])
    } finally {
      h.stop()
    }
  })

  it('leaves an ordinary track as west-to-east', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.1],
        ],
        [t0, t0 + 1000],
      )

      expect(providerBbox(await providerOf(h).getTracks({}))).toEqual([24.9, 60.1, 25.1, 60.2])
    } finally {
      h.stop()
    }
  })

  // The v2 contract: "a vessel that crossed the box an hour ago and has since
  // left still matches". The v1 routes match the last position instead, which
  // is the right answer to their own question ("vessels near here now") and
  // was wrong here — this returned nothing.
  it('matches a track that crossed the box and left', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.2, 25.0],
          [50, 22],
          [10, 20],
        ],
        [t0, t0 + 1000, t0 + 2000],
      )

      const res = await providerOf(h).getTracks({ bbox: [24, 59, 26, 61] })

      expect(res.features.map((f) => f.properties.context)).toEqual([SELF_CONTEXT])
      // Selected, not clipped: the whole track comes back, including the
      // stretches outside the box.
      expect(res.features[0]!.properties.pointCount).toBe(3)
    } finally {
      h.stop()
    }
  })

  it('still excludes a track that never entered the box', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [10, 20],
          [11, 21],
        ],
        [t0, t0 + 1000],
      )

      const res = await providerOf(h).getTracks({ bbox: [24, 59, 26, 61] })

      expect(res.features).toEqual([])
    } finally {
      h.stop()
    }
  })

  // A budget, not a fidelity contract: the spacing widens until the count fits,
  // and the response reports what was actually applied so a client can see it.
  it('applies maxPoints and reports the resolution used', async () => {
    const h = createHarness()
    try {
      // 300 rather than a longer track: every point is a real insert now that
      // the store is sqlite, and this is enough to make the budget bind. The
      // exact spacing arithmetic is pinned in timeWindow.test.ts, which is pure.
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      const positions: [number, number][] = []
      const timestamps: number[] = []
      for (let i = 0; i < 300; i++) {
        positions.push([60 + i * 0.0001, 24 + i * 0.0001])
        timestamps.push(t0 + i * 1000)
      }
      h.seedTrack(SELF_CONTEXT, positions, timestamps)

      const full = await providerOf(h).getTracks({})
      expect(full.features[0]!.properties.pointCount).toBe(300)
      expect(full.features[0]!.properties.resolution).toBeUndefined()

      const budgeted = await providerOf(h).getTracks({ maxPoints: 50 })
      const props = budgeted.features[0]!.properties
      expect(props.pointCount).toBeLessThanOrEqual(50)
      expect(props.pointCount).toBeGreaterThan(40)
      // Reported, and exact rather than rounded — a client re-querying with a
      // tidier value would get a different count than the budget it asked for.
      expect(props.resolution).toBe('PT6.103S')
    } finally {
      h.stop()
    }
  })

  it('leaves a track alone when it already fits the budget', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60, 24],
          [61, 25],
        ],
        [t0, t0 + 1000],
      )

      const res = await providerOf(h).getTracks({ maxPoints: 50 })

      expect(res.features[0]!.properties.pointCount).toBe(2)
      expect(res.features[0]!.properties.resolution).toBeUndefined()
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

  // The API accepts `PT0.0005S`, which is half a millisecond, and hands it
  // through intact. `Temporal.Duration.from` rejects a fractional value in any
  // unit, so reporting it back needs the sub-millisecond part split out — this
  // was a 500 for a query the server had already accepted.
  it('reports a sub-millisecond resolution without throwing', async () => {
    const h = createHarness()
    try {
      const t0 = Date.UTC(2026, 7, 14, 9, 0, 0)
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60, 24],
          [60.1, 24.1],
        ],
        [t0, t0 + 1000],
      )

      for (const unit of ['PT0.0005S', 'PT0.5S', 'PT24.47S']) {
        const res = await providerOf(h).getTracks({ resolution: Temporal.Duration.from(unit) })
        expect(res.features[0]!.properties.resolution, unit).toBe(unit)
      }
    } finally {
      h.stop()
    }
  })

  // Defensive: the server rejects months and years and normalises everything
  // else to hours before a provider sees it, so these no longer arrive over
  // HTTP. A provider called directly still must not throw on them — Temporal's
  // total() refuses weeks and larger without a reference point, which is what
  // surfaced as a 500 before the server normalised.
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

      for (const [unit, expected] of [
        ['P1W', 'PT168H'],
        ['P1M', 'PT744H'],
        ['P1Y', 'PT8784H'],
      ]) {
        const res = await providerOf(h).getTracks({ resolution: Temporal.Duration.from(unit!) })

        // Each spacing is far wider than the whole track, so thinning keeps the
        // first point and the last — thin() always ends on the newest fix.
        expect(res.features[0]!.properties.pointCount).toBe(2)
        // The spacing *applied*, in hours and below, rather than the calendar
        // form asked for: a maxPoints budget can widen it, so the field has to
        // report what was used. The server normalises the request the same way.
        expect(res.features[0]!.properties.resolution).toBe(expected)
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

// The v2 contract declares contextName: "Name of the vessel, aircraft or other
// context, where known. Not a name for the track itself." So a name the server
// knows must reach this field undecorated -- not missing, and not carrying v1's
// `AIS `/`Own Ship` label, which names the track rather than the vessel.
//
// The two routes differing for an *unidentified* context is correct, not a
// contradiction: v1 always renders something because a label has to, while v2
// omits the field because "where known" means absent.
describe('contextName in v2 properties', () => {
  it('carries the bare vessel name, not the v1 display label', async () => {
    const h = createHarness({
      selfPosition: [60, 24],
      paths: { [`${OTHER_CONTEXT}.name`]: 'Ariadne' },
    })
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await providerOf(h).getTracks({ contexts: [OTHER_CONTEXT] })

    expect(res.features[0]!.properties.contextName).toBe('Ariadne')
  })

  // v1 still labels this track `AIS 987654321` -- a label has to render
  // something -- but the v2 field names the vessel, and an MMSI is not a name.
  it('omits the field for a vessel whose name is not known yet', async () => {
    const h = createHarness({ selfPosition: [60, 24] })
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await providerOf(h).getTracks({ contexts: [OTHER_CONTEXT] })

    expect(res.features[0]!.properties).not.toHaveProperty('contextName')
  })

  // "where known" — an absent field, not an empty string or a raw context.
  it('omits the field entirely when nothing is known', async () => {
    const odd = 'vessels.urn:mrn:signalk:uuid:abc'
    const h = createHarness({ selfPosition: [60, 24] })
    h.emit(odd, [60.2, 24.8])

    const res = await providerOf(h).getTracks({ contexts: [odd] })

    expect(res.features[0]!.properties).not.toHaveProperty('contextName')
  })
})

// The v2 contract declares `simplify` and `epsilon`; until now the provider
// accepted and ignored them, which returns a superset of what was asked for
// rather than a wrong answer, but is not what the client wanted.
describe('simplify in v2', () => {
  // A zigzag: thinning by time keeps every other point, simplification by
  // shape keeps the corners. The two are not interchangeable.
  const zigzag = (n: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [60 + (i % 2 ? 0.0003 : 0), 24 + i * 0.0002] as [number, number])

  const seed = (h: ReturnType<typeof createHarness>, pts: [number, number][]) => {
    h.seedTrack(
      SELF_CONTEXT,
      pts,
      pts.map((_, i) => Date.now() - (pts.length - i) * 1000),
    )
  }

  it('leaves the geometry alone when nothing asked for simplification', async () => {
    const h = createHarness()
    seed(h, zigzag(60))

    const res = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT] })

    expect(res.features[0]!.properties.pointCount).toBe(60)
    expect(res.features[0]!.properties).not.toHaveProperty('epsilon')
  })

  it('honours an explicit epsilon and reports it back', async () => {
    const h = createHarness()
    seed(h, zigzag(60))

    const res = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], epsilon: 100 })

    expect(res.features[0]!.properties.pointCount).toBeLessThan(60)
    expect(res.features[0]!.properties.epsilon).toBe(100)
  })

  // "Simplification tolerance in metres. Implies simplify=true."
  it('treats epsilon as implying simplify', async () => {
    const h = createHarness()
    seed(h, zigzag(60))

    const withFlag = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], epsilon: 100, simplify: true })
    const without = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], epsilon: 100 })

    expect(without).toEqual(withFlag)
  })

  // The auto tolerance is one part in a thousand of the track's extent, so the
  // track has to actually cover ground for it to bite -- which a real one
  // does. A long leg with jitter on it stands in for a passage.
  it('chooses a tolerance when simplify comes without one', async () => {
    const h = createHarness()
    const leg: [number, number][] = Array.from(
      { length: 200 },
      (_, i) => [60 + i * 0.001 + (i % 2 ? 0.000005 : 0), 24 + i * 0.002] as [number, number],
    )
    seed(h, leg)

    const res = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], simplify: true })
    const props = res.features[0]!.properties

    // One part in a thousand of the track's diagonal -- pinned, so a change to
    // the documented policy shows up here rather than silently altering what
    // every simplify-only request returns.
    const [west, south, east, north] = props.bbox!
    const height = (north - south) * 111_320
    const width = (east - west) * 111_320 * Math.cos((((south + north) / 2) * Math.PI) / 180)
    expect(props.epsilon).toBeCloseTo(Math.hypot(width, height) / 1000, 6)
    expect(props.pointCount).toBeLessThan(200)
  })

  // pointCount, from/to and bbox must describe what was returned, not what was
  // read from the store — a client drawing the bbox of an unsimplified track
  // around a simplified one would draw the wrong box.
  it('describes the simplified track, not the stored one', async () => {
    const h = createHarness()
    seed(h, zigzag(60))

    const res = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], epsilon: 100, times: true })
    const props = res.features[0]!.properties
    const coords = res.features[0]!.geometry!.coordinates.flat()

    expect(props.pointCount).toBe(coords.length)
    expect(props.coordTimes!.flat()).toHaveLength(coords.length)
  })

  // The bbox must bound what came back. A fixture with an interior extremum
  // that simplification removes tells a bbox computed from the returned track
  // from one computed from the stored one -- the latter would draw a box the
  // track no longer reaches into.
  it('bounds the simplified track, not the stored one', async () => {
    const h = createHarness()
    // A long straight leg with one small northward blip in the middle: well
    // inside a 500 m tolerance, so it goes, taking the maximum latitude with it.
    const leg: [number, number][] = Array.from(
      { length: 40 },
      (_, i) => [60 + (i === 20 ? 0.0005 : 0), 24 + i * 0.01] as [number, number],
    )
    seed(h, leg)

    const res = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], epsilon: 500 })
    const coords = res.features[0]!.geometry!.coordinates.flat()
    const north = Math.max(...coords.map(([, lat]) => lat))

    expect(res.features[0]!.properties.bbox![3]).toBeCloseTo(north, 10)
    // ...and the blip really was dropped, or the assertion above is vacuous.
    expect(north).toBeLessThan(60.0005)
  })

  // The simplifier knows nothing about time gaps. Given the whole track it
  // sees two collinear legs as one straight line and keeps only the global
  // endpoints -- segmenting that afterwards yields one-point segments, which
  // are not drawable geometry. Splitting first is what keeps each leg whole.
  it('keeps each leg when a time gap splits the track', async () => {
    const h = createHarness({ config: { segmentGapMinutes: 10 } })
    const base = Date.now() - 5 * 60 * 60 * 1000
    const hours = 3 * 60 * 60 * 1000
    h.seedTrack(
      SELF_CONTEXT,
      [
        [60, 24],
        [60, 24.01],
        [60, 24.02],
        [60, 24.03],
      ],
      [base, base + 1000, base + hours, base + hours + 1000],
    )

    const res = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], epsilon: 100 })

    expect(res.features[0]!.geometry!.coordinates.map((seg) => seg.length)).toEqual([2, 2])
    expect(res.features[0]!.properties.pointCount).toBe(4)
  })

  it('keeps the endpoints, so from and to still bound the track', async () => {
    const h = createHarness()
    const pts = zigzag(60)
    seed(h, pts)

    const full = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT] })
    const cut = await providerOf(h).getTracks({ contexts: [SELF_CONTEXT], epsilon: 100 })

    expect(cut.features[0]!.properties.from).toBe(full.features[0]!.properties.from)
    expect(cut.features[0]!.properties.to).toBe(full.features[0]!.properties.to)
  })
})
