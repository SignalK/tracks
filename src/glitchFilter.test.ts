import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createHarness } from './harness.test-utils.js'
import { DEFAULT_MAX_SPEED_KNOTS, GlitchFilter } from './glitchFilter.js'
import type { Context, LatLngTuple } from './types.js'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789' as Context
const OTHER = 'vessels.urn:mrn:imo:mmsi:987654321' as Context
const MINUTE = 60_000

/** Helsinki, and a point ~1.1km north of it. */
const HELSINKI: LatLngTuple = [60.1, 24.9]
const NEARBY: LatLngTuple = [60.11, 24.9]
/** Roughly the Gulf of Guinea — the classic null-island-ish glitch. */
const GLITCH: LatLngTuple = [0, 0]

const filter = (maxSpeedKnots = DEFAULT_MAX_SPEED_KNOTS) => new GlitchFilter({ maxSpeedKnots })

describe('GlitchFilter', () => {
  it('accepts the first position for a context, having nothing to compare', () => {
    expect(filter().accept(SELF, HELSINKI, 0)).toBe(true)
  })

  it('accepts a plausible move', () => {
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    // ~1.1km in a minute is about 36 knots: fast, but not impossible.
    expect(f.accept(SELF, NEARBY, MINUTE)).toBe(true)
  })

  it('rejects a jump across the world in a minute', () => {
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    expect(f.accept(SELF, GLITCH, MINUTE)).toBe(false)
  })

  it('keeps the last good position as the reference, not the rejected one', () => {
    // Otherwise one glitch would make the next real fix look like a jump back,
    // and the track would lose good data after every bad fix.
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    f.accept(SELF, GLITCH, MINUTE)
    expect(f.accept(SELF, NEARBY, 2 * MINUTE)).toBe(true)
  })

  it('allows the same distance when the gap is long enough', () => {
    // The test is speed, not distance: a vessel that was away for a month may
    // legitimately reappear a long way off.
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    expect(f.accept(SELF, GLITCH, 30 * 24 * 60 * MINUTE)).toBe(true)
  })

  it('tracks contexts independently', () => {
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    // A different vessel's first fix is never compared against another's.
    expect(f.accept(OTHER, GLITCH, MINUTE)).toBe(true)
  })

  it('accepts an out-of-order fix rather than guessing', () => {
    // A negative interval yields no meaningful speed. Bootstrapped history is
    // back-dated, so this happens in normal operation.
    const f = filter()
    f.accept(SELF, HELSINKI, MINUTE)
    expect(f.accept(SELF, GLITCH, 0)).toBe(true)
  })

  it('accepts two fixes sharing a timestamp', () => {
    const f = filter()
    f.accept(SELF, HELSINKI, MINUTE)
    expect(f.accept(SELF, GLITCH, MINUTE)).toBe(true)
  })

  it('is disabled by a non-positive ceiling', () => {
    for (const max of [0, -1]) {
      const f = filter(max)
      f.accept(SELF, HELSINKI, 0)
      expect(f.accept(SELF, GLITCH, MINUTE)).toBe(true)
    }
  })

  it('honours a lower ceiling', () => {
    const f = filter(5)
    f.accept(SELF, HELSINKI, 0)
    // ~36 knots, fine by default but over a 5-knot ceiling.
    expect(f.accept(SELF, NEARBY, MINUTE)).toBe(false)
  })

  it('counts rejections per context and in total', () => {
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    f.accept(SELF, GLITCH, MINUTE)
    f.accept(SELF, GLITCH, 2 * MINUTE)
    f.accept(OTHER, HELSINKI, 0)
    f.accept(OTHER, GLITCH, MINUTE)

    expect(f.rejectedCount(SELF)).toBe(2)
    expect(f.rejectedCount(OTHER)).toBe(1)
    expect(f.totalRejected()).toBe(3)
  })

  it('reports no rejections for a context it has never seen', () => {
    expect(filter().rejectedCount(SELF)).toBe(0)
  })

  it('forgets everything when cleared', () => {
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    f.accept(SELF, GLITCH, MINUTE)
    f.clear()

    expect(f.totalRejected()).toBe(0)
    // With no reference point the next fix is a first fix again.
    expect(f.accept(SELF, GLITCH, 2 * MINUTE)).toBe(true)
  })

  it('leaves a realistic fast vessel alone at the default ceiling', () => {
    // 40 knots sustained — a fast ferry or RIB — must not be filtered.
    const f = filter()
    f.accept(SELF, HELSINKI, 0)
    const metresPerMinute = (40 * 1852) / 60
    const degreesNorth = metresPerMinute / 111_320
    expect(f.accept(SELF, [60.1 + degreesNorth, 24.9], MINUTE)).toBe(true)
  })
})

// The filter wired into the plugin: a glitched delta must not reach the store.
describe('glitch filtering through the plugin', () => {
  const API = '/signalk/v1/api'
  const SELF_ID = SELF.replace('vessels.', '')

  const coordinatesFor = async (h: ReturnType<typeof createHarness>) => {
    const res = await request(h.app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)
    return (res.body.coordinates as [number, number][][]).flat()
  }

  /**
   * Feed two positions so that both reach the store.
   *
   * `throttleTime` thins on the leading edge against the wall clock, so two
   * synchronous emits arrive as a single point whatever the filter decides —
   * which would make every assertion below pass with the filter removed.
   * Yielding to the event loop between them is what makes these tests about
   * the filter rather than about throttling.
   */
  const feedBoth = async (h: ReturnType<typeof createHarness>, second: LatLngTuple): Promise<[number, number][]> => {
    const t0 = Date.now() - 10 * MINUTE
    h.emit(SELF, HELSINKI, t0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    h.emit(SELF, second, t0 + MINUTE)
    return coordinatesFor(h)
  }

  it('keeps a glitched position out of the track', async () => {
    const h = createHarness({ selfPosition: [60, 24], config: { resolution: 0 } })
    try {
      const coordinates = await feedBoth(h, GLITCH)

      // GeoJSON output is [lng, lat], so the glitch would appear as [0, 0].
      expect(coordinates).toContainEqual([24.9, 60.1])
      expect(coordinates).not.toContainEqual([0, 0])
    } finally {
      h.stop()
    }
  })

  it('records a plausible second position', async () => {
    const h = createHarness({ selfPosition: [60, 24], config: { resolution: 0 } })
    try {
      const coordinates = await feedBoth(h, NEARBY)

      expect(coordinates).toContainEqual([24.9, 60.1])
      expect(coordinates).toContainEqual([24.9, 60.11])
    } finally {
      h.stop()
    }
  })

  it('records the glitch when the filter is disabled', async () => {
    const h = createHarness({
      selfPosition: [60, 24],
      config: { resolution: 0, maxSpeedKnots: 0 },
    })
    try {
      const coordinates = await feedBoth(h, GLITCH)

      // Both asserted: if the first emit stopped reaching the store the glitch
      // would become the first accepted position — always kept, since there is
      // nothing to compare it against — and this would pass regardless of the
      // configuration path.
      expect(coordinates).toContainEqual([24.9, 60.1])
      expect(coordinates).toContainEqual([0, 0])
    } finally {
      h.stop()
    }
  })
})
