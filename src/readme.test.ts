import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createHarness, SELF_CONTEXT } from './harness.test-utils.js'
import { createInBounds, validateParameters } from './utils.js'
import { parseTrackQuery } from './timeWindow.js'

// Every example printed in the README, executed. Documentation that has not
// been run is a claim, not a fact.
describe('README examples', () => {
  it('?bbox=-35,130,-33,139 selects South Australia', () => {
    const { bbox } = validateParameters({ bbox: '-35,130,-33,139' }, undefined)
    expect(createInBounds(bbox!)([-34, 135])).toBe(true)
  })

  it('?bbox=-10,175,10,-175 crosses the antimeridian', () => {
    const { bbox } = validateParameters({ bbox: '-10,175,10,-175' }, undefined)
    const inBounds = createInBounds(bbox!)
    expect(inBounds([0, 179])).toBe(true)
    expect(inBounds([0, -179])).toBe(true)
    expect(inBounds([0, 170])).toBe(false)
  })

  it('?duration=6h is a six hour window ending now', () => {
    const now = Date.parse('2026-08-09T12:00:00Z')
    expect(parseTrackQuery({ duration: '6h' }, now).window).toEqual({
      from: now - 6 * 3600_000,
      to: now,
      inclusiveEnd: true,
    })
  })

  it('?from=...&to=... uses the given bounds', () => {
    const now = Date.parse('2026-08-09T12:00:00Z')
    const { window } = parseTrackQuery({ from: '2026-08-09T06:00:00Z', to: '2026-08-09T12:00:00Z' }, now)
    expect(window?.from).toBe(Date.parse('2026-08-09T06:00:00Z'))
    expect(window?.to).toBe(Date.parse('2026-08-09T12:00:00Z'))
  })

  it('?timespan=23h&timespanOffset=1 is 23 hours ending an hour ago', () => {
    const now = Date.parse('2026-08-09T12:00:00Z')
    expect(parseTrackQuery({ timespan: '23h', timespanOffset: '1' }, now).window).toEqual({
      from: now - 24 * 3600_000,
      to: now - 3600_000,
      inclusiveEnd: false,
    })
  })

  it('?resolution=5m accepts the documented suffixes', () => {
    const now = Date.now()
    expect(parseTrackQuery({ resolution: '5m' }, now).resolution).toBe(300_000)
    expect(parseTrackQuery({ resolution: '30' }, now).resolution).toBe(30_000)
    expect(parseTrackQuery({ resolution: '1d' }, now).resolution).toBe(86_400_000)
  })
})

// The `?times` example above, executed end to end: the documented alignment
// invariant (times[i][j] describes coordinates[i][j]) is the part a consumer
// relies on, so it is pinned against the real route rather than the parser.
describe('README ?times example', () => {
  it('returns times aligned with coordinates', async () => {
    const h = createHarness({ selfPosition: [60, 24] })
    try {
      // Dated against the real clock: `duration=6h` is relative to now, so
      // fixed calendar timestamps would fall outside the window.
      const t0 = Date.now() - 60_000
      h.seedTrack(
        SELF_CONTEXT,
        [
          [60.1, 24.9],
          [60.2, 25.0],
        ],
        [t0, t0 + 30_000],
      )

      const res = await request(h.app).get('/signalk/v1/api/self/track?duration=6h&times').expect(200)

      expect(res.body.coordinates).toEqual([
        [
          [24.9, 60.1],
          [25.0, 60.2],
        ],
      ])
      expect(res.body.times).toEqual([[new Date(t0).toISOString(), new Date(t0 + 30_000).toISOString()]])
    } finally {
      h.stop()
    }
  })
})
