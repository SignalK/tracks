import { describe, expect, it } from 'vitest'
import {
  parseDuration,
  parseTrackQuery,
  segment,
  thin,
  Thinner,
  thinToBudget,
  TimeWindowError,
  TrackStream,
} from './timeWindow.js'
import type { StreamedPoint } from './timeWindow.js'
import type { TimedPosition } from './types.js'

const MINUTE = 60 * 1000

const NOW = Date.parse('2026-08-09T12:00:00Z')
const HOUR = 60 * 60 * 1000

describe('parseDuration', () => {
  it('treats a bare number as seconds', () => {
    expect(parseDuration('30')).toBe(30_000)
  })
  it('accepts s, m, h and d suffixes', () => {
    expect(parseDuration('5s')).toBe(5_000)
    expect(parseDuration('1m')).toBe(60_000)
    expect(parseDuration('2h')).toBe(2 * HOUR)
    expect(parseDuration('1d')).toBe(24 * HOUR)
  })
  it('rejects nonsense', () => {
    expect(() => parseDuration('soon')).toThrow(TimeWindowError)
    expect(() => parseDuration('')).toThrow(TimeWindowError)
    expect(() => parseDuration('5y')).toThrow(TimeWindowError)
  })
})

describe('parseTrackQuery', () => {
  it('returns no window when no time parameters are given', () => {
    expect(parseTrackQuery({}, NOW).window).toBeUndefined()
  })

  it('accepts exactly the parameters its schema declares, and names them when rejecting another', () => {
    expect(() => parseTrackQuery({ duratoin: '6h' }, NOW)).toThrow(
      'Unknown query parameter duratoin; accepted: from, to, duration, timespan, timespanOffset, resolution, times',
    )
  })

  it('resolves from/to', () => {
    const { window } = parseTrackQuery({ from: '2026-08-09T10:00:00Z', to: '2026-08-09T11:00:00Z' }, NOW)
    expect(window).toEqual({ from: NOW - 2 * HOUR, to: NOW - HOUR, inclusiveEnd: false })
  })

  it('defaults to now when only from is given, and includes the newest point', () => {
    const { window } = parseTrackQuery({ from: '2026-08-09T11:00:00Z' }, NOW)
    expect(window).toEqual({ from: NOW - HOUR, to: NOW, inclusiveEnd: true })
  })

  it('rejects an inverted range', () => {
    expect(() => parseTrackQuery({ from: '2026-08-09T11:00:00Z', to: '2026-08-09T10:00:00Z' }, NOW)).toThrow(
      TimeWindowError,
    )
  })

  it('rejects an unparseable instant', () => {
    expect(() => parseTrackQuery({ from: 'yesterday' }, NOW)).toThrow(TimeWindowError)
  })

  it('resolves duration as a window ending now', () => {
    expect(parseTrackQuery({ duration: '2h' }, NOW).window).toEqual({
      from: NOW - 2 * HOUR,
      to: NOW,
      inclusiveEnd: true,
    })
  })

  // Freeboard-SK compatibility: timespanOffset is a bare number of hours back
  // from now, and timespan is the length of the window ending there.
  it('resolves the Freeboard timespan/timespanOffset pair', () => {
    expect(parseTrackQuery({ timespan: '1h' }, NOW).window).toEqual({
      from: NOW - HOUR,
      to: NOW,
      inclusiveEnd: true,
    })
    // an offset band ends before now, so it stays half-open and tiles cleanly
    expect(parseTrackQuery({ timespan: '23h', timespanOffset: '1' }, NOW).window).toEqual({
      from: NOW - 24 * HOUR,
      to: NOW - HOUR,
      inclusiveEnd: false,
    })
  })

  it('tiles the three Freeboard bands without gaps or overlap', () => {
    const beyond24 = parseTrackQuery({ timespan: '24h', timespanOffset: '24' }, NOW).window
    const next23 = parseTrackQuery({ timespan: '23h', timespanOffset: '1' }, NOW).window
    const lastHour = parseTrackQuery({ timespan: '1h' }, NOW).window

    expect(beyond24?.to).toBe(next23?.from)
    expect(next23?.to).toBe(lastHour?.from)
    expect(lastHour?.to).toBe(NOW)
  })

  it('prefers from/to over duration and timespan', () => {
    const { window } = parseTrackQuery({ from: '2026-08-09T11:00:00Z', duration: '5h', timespan: '9h' }, NOW)
    expect(window).toEqual({ from: NOW - HOUR, to: NOW, inclusiveEnd: true })
  })

  it('parses resolution as a duration in milliseconds', () => {
    expect(parseTrackQuery({ resolution: '5s' }, NOW).resolution).toBe(5_000)
    expect(parseTrackQuery({ resolution: '1m' }, NOW).resolution).toBe(60_000)
    // Freeboard also sends bare numbers for resolution elsewhere in the API
    expect(parseTrackQuery({ resolution: '60' }, NOW).resolution).toBe(60_000)
  })

  it('ignores a zero resolution rather than thinning everything away', () => {
    expect(parseTrackQuery({ resolution: '0' }, NOW).resolution).toBeUndefined()
  })

  it('takes the first value when express repeats a parameter', () => {
    expect(parseTrackQuery({ timespan: ['1h', '9h'] }, NOW).window).toEqual({
      from: NOW - HOUR,
      to: NOW,
      inclusiveEnd: true,
    })
  })
})

describe('thin', () => {
  const points = (...offsets: number[]): TimedPosition[] =>
    offsets.map((offset) => ({ position: [offset, offset], timestamp: NOW + offset }))

  it('returns everything when no resolution is set', () => {
    const p = points(0, 1, 2)
    expect(thin(p, undefined)).toEqual(p)
  })

  it('drops points closer together than the resolution', () => {
    const p = points(0, 100, 200, 1000, 1100, 2000)
    expect(thin(p, 1000).map((x) => x.timestamp - NOW)).toEqual([0, 1000, 2000])
  })

  it('always keeps the last point so the track keeps its extent', () => {
    const p = points(0, 100, 200)
    const result = thin(p, 1000)
    expect(result[0]?.timestamp).toBe(NOW)
    expect(result[result.length - 1]?.timestamp).toBe(NOW + 200)
  })

  it('leaves one- and two-point tracks alone', () => {
    expect(thin(points(0), 1000)).toHaveLength(1)
    expect(thin(points(0, 1), 1000)).toHaveLength(2)
  })
  it('keeps both ends of every stretch of a clipped track', () => {
    const p = points(0, 100, 200, 300, 400, 500)
    p[3] = { ...p[3]!, breakBefore: true }
    expect(thin(p, 1000).map((x) => x.timestamp - NOW)).toEqual([0, 200, 300, 500])
  })

  // What a store reading row by row relies on to return what thinning the
  // whole read would.
  it('thins points fed one at a time as it thins them all at once', () => {
    const p = points(0, 100, 200, 1000, 1100, 2000, 2050)
    p[2] = { ...p[2]!, span: 300 }
    for (const track of [p, p.slice(0, 2), p.slice(0, 1), []]) {
      const thinner = new Thinner(1000)
      for (const point of track) {
        thinner.push(point)
      }
      expect(thinner.finish()).toEqual(thin(track, 1000))
    }
  })
})

describe('segment', () => {
  const at = (timestamp: number): TimedPosition => ({ position: [60, 24], timestamp })

  it('returns one segment when no gap is configured', () => {
    expect(segment([at(0), at(10 * MINUTE)], undefined)).toHaveLength(1)
    expect(segment([at(0), at(10 * MINUTE)], 0)).toHaveLength(1)
  })

  it('returns no segments for an empty track', () => {
    // Distinguishable from a track that has points, so a caller can tell
    // "nothing recorded" from "recorded, but empty after filtering".
    expect(segment([], 5 * MINUTE)).toEqual([])
  })

  it('splits where the gap is exceeded', () => {
    const points = [at(0), at(MINUTE), at(30 * MINUTE), at(31 * MINUTE)]
    const segments = segment(points, 5 * MINUTE)
    expect(segments.map((s) => s.length)).toEqual([2, 2])
  })

  it('does not split on a gap exactly equal to the threshold', () => {
    // `>` not `>=`: a vessel reporting on a fixed 5-minute interval should not
    // have every single fix become its own segment.
    expect(segment([at(0), at(5 * MINUTE)], 5 * MINUTE)).toHaveLength(1)
  })

  it('splits where a clipped track left the box, whatever the gap', () => {
    const points = [at(0), at(MINUTE), { ...at(2 * MINUTE), breakBefore: true }, at(3 * MINUTE)]
    expect(segment(points, 5 * MINUTE).map((s) => s.length)).toEqual([2, 2])
    expect(segment(points, 0).map((s) => s.length)).toEqual([2, 2])
  })

  it('keeps a single point as its own segment', () => {
    expect(segment([at(0)], 5 * MINUTE)).toEqual([[at(0)]])
  })

  it('composes with thin(): thinning first does not invent a join', () => {
    // thin() drops intermediate points but never moves them, so a real gap
    // survives thinning and still segments.
    const points = [at(0), at(MINUTE), at(2 * MINUTE), at(60 * MINUTE)]
    expect(segment(thin(points, 90 * 1000), 5 * MINUTE).map((s) => s.length)).toEqual([2, 1])
  })
})

describe('parseTrackQuery: times', () => {
  it('is absent unless the parameter is given', () => {
    expect(parseTrackQuery({}, NOW).times).toBeUndefined()
  })

  it('reads a valueless ?times as true', () => {
    // Express parses `?times` into an empty string; that is how a query string
    // conventionally spells a flag.
    expect(parseTrackQuery({ times: '' }, NOW).times).toBe(true)
  })

  it('accepts the usual truthy and falsy spellings', () => {
    for (const value of ['true', '1', 'yes', 'TRUE']) {
      expect(parseTrackQuery({ times: value }, NOW).times).toBe(true)
    }
    for (const value of ['false', '0', 'no', 'FALSE']) {
      expect(parseTrackQuery({ times: value }, NOW).times).toBe(false)
    }
  })

  it('rejects a value that is neither', () => {
    expect(() => parseTrackQuery({ times: 'maybe' }, NOW)).toThrow(TimeWindowError)
  })

  it('combines with a time window', () => {
    const query = parseTrackQuery({ duration: '1h', times: 'true' }, NOW)
    expect(query.times).toBe(true)
    expect(query.window).toEqual({ from: NOW - HOUR, to: NOW, inclusiveEnd: true })
  })
})

describe('thinToBudget', () => {
  const at = (timestamp: number) => ({ position: [60, 24] as [number, number], timestamp })

  it('leaves a track that already fits alone', () => {
    const points = [at(0), at(1000), at(2000)]
    const result = thinToBudget(points, 10, undefined)
    expect(result.points).toHaveLength(3)
    expect(result.resolution).toBeUndefined()
  })

  it('widens the spacing until the budget fits, and reports it', () => {
    const points = Array.from({ length: 100 }, (_, i) => at(i * 1000))
    const result = thinToBudget(points, 10, undefined)
    expect(result.points.length).toBeLessThanOrEqual(10)
    expect(result.resolution).toBeGreaterThan(1000)
  })

  // `thin` appends the last point unconditionally, so a track whose final
  // fixes share a timestamp still yields three points at a spacing of exactly
  // the span — first, middle, and the appended last. Stopping the widening at
  // the span rather than past it overran the budget.
  it('meets the budget when the final timestamps are duplicated', () => {
    const result = thinToBudget([at(0), at(100), at(100)], 2, undefined)
    expect(result.points.length).toBeLessThanOrEqual(2)
  })

  it('never exceeds the budget across awkward spacings', () => {
    for (const gaps of [
      [0, 1, 1, 1, 1000],
      [0, 0, 0, 0],
      [0, 5, 5, 5, 5, 5, 1000000],
      [0, 100, 100],
    ]) {
      const points = gaps.map((t) => at(t))
      for (const budget of [2, 3, 4]) {
        expect(thinToBudget(points, budget, undefined).points.length, `${gaps} @ ${budget}`).toBeLessThanOrEqual(budget)
      }
    }
  })

  // The reported spacing is what the response advertises, so a client that
  // re-queries with it must get the same track rather than one over budget.
  it('reports a spacing that reproduces the result', () => {
    const points = Array.from({ length: 1200 }, (_, i) => at(i * 1000))
    const budgeted = thinToBudget(points, 50, undefined)

    expect(thin(points, budgeted.resolution).length).toBe(budgeted.points.length)
    expect(budgeted.points.length).toBeLessThanOrEqual(50)
  })

  it('meets a budget below two by truncating', () => {
    const points = [at(0), at(1000), at(2000)]

    expect(thinToBudget(points, 1, undefined).points).toHaveLength(1)
    expect(thinToBudget(points, 0, undefined).points).toHaveLength(0)
  })

  it('honours a resolution floor while meeting the budget', () => {
    const points = Array.from({ length: 100 }, (_, i) => at(i * 1000))
    const result = thinToBudget(points, 10, 5000)
    expect(result.points.length).toBeLessThanOrEqual(10)
    expect(result.resolution!).toBeGreaterThanOrEqual(5000)
  })
})

describe('segmenting a thinned track', () => {
  const at = (timestamp: number): TimedPosition => ({ position: [60, 24], timestamp })

  it('keeps a stretch recorded without a break whole when thinned wider than the gap', () => {
    const recorded = Array.from({ length: 15 }, (_, i) => at(i * MINUTE))

    expect(segment(thin(recorded, 3 * MINUTE), 2 * MINUTE)).toHaveLength(1)
  })

  it('still splits at a recorded stop that thinning left nothing to drop around', () => {
    const recorded = [at(0), at(6 * MINUTE)]

    expect(segment(thin(recorded, 3 * MINUTE), 2 * MINUTE)).toHaveLength(2)
  })

  it('splits exactly where the recording stopped, however it was thinned', () => {
    // Seeded, so a failure reproduces.
    let seed = 133
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let run = 0; run < 300; run++) {
      const gap = (1 + Math.floor(random() * 5)) * MINUTE
      // Fixes at most `gap` apart, with the occasional real stop well beyond it.
      const recorded: TimedPosition[] = []
      const stretchOf = new Map<number, number>()
      let t = 0
      let stretch = 0
      for (let i = 0; i < 150; i++) {
        recorded.push(at(t))
        stretchOf.set(t, stretch)
        if (random() < 0.05) {
          t += gap + 1 + Math.floor(random() * 3 * gap)
          stretch++
        } else {
          t += 1 + Math.floor(random() * gap)
        }
      }
      const spacing = 1 + Math.floor(random() * 3 * gap)
      const wider = spacing + Math.floor(random() * 3 * gap)

      // Thinned once, and twice as the store's pass followed by a budget.
      for (const thinned of [thin(recorded, spacing), thin(thin(recorded, spacing), wider)]) {
        const segments = segment(thinned, gap)
        for (const [i, s] of segments.entries()) {
          // Nothing split that the recording did not.
          expect(new Set(s.map((p) => stretchOf.get(p.timestamp))).size).toBe(1)
          // Nothing joined that the recording split.
          const next = segments[i + 1]
          if (next) {
            expect(stretchOf.get(next[0]!.timestamp)).not.toBe(stretchOf.get(s[s.length - 1]!.timestamp))
          }
        }
      }
    }
  })
})

// The GPX export reads a long track a day at a time through TrackStream; the
// JSON route reads it in one piece. The two must answer a query alike.
describe('TrackStream', () => {
  // Seeded, so a failure reproduces.
  let seed = 271
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed / 2 ** 31
  }
  /** Fixes seconds to minutes apart, now and then a stop, and now and then a stretch read apart. */
  const recorded = (): TimedPosition[] => {
    const points: TimedPosition[] = []
    let t = 0
    for (let i = 0, n = Math.floor(random() * 200); i < n; i++) {
      t += random() < 0.05 ? (20 + random() * 40) * MINUTE : 1000 + Math.floor(random() * 90_000)
      points.push({ position: [60 + i * 1e-4, 24], timestamp: t, ...(random() < 0.03 ? { breakBefore: true } : {}) })
    }
    return points
  }
  const streamed = (
    points: TimedPosition[],
    resolution: number | undefined,
    gap: number | undefined,
    cut: () => number,
  ) => {
    const stream = new TrackStream(resolution, gap)
    const segments: TimedPosition[][] = []
    const take = (out: StreamedPoint[]) => {
      for (const { point, starts } of out) {
        if (starts) segments.push([])
        segments.at(-1)!.push(point)
      }
    }
    for (let i = 0; i < points.length;) {
      const n = Math.max(1, cut())
      take(stream.push(points.slice(i, i + n)))
      i += n
    }
    take(stream.finish())
    return segments
  }

  it('comes out as segment(thin()) does, in whatever pieces it is fed', () => {
    for (let run = 0; run < 100; run++) {
      const points = recorded()
      for (const resolution of [undefined, 1000, 30_000, 5 * MINUTE]) {
        for (const gap of [undefined, 10 * MINUTE]) {
          const whole = segment(thin(points, resolution), gap)
          for (const cut of [() => points.length, () => 1, () => Math.floor(random() * 20)]) {
            expect(streamed(points, resolution, gap, cut)).toEqual(whole)
          }
        }
      }
    }
  })

  // Read in one piece, months of a recording keep hundreds of thousands of
  // points: more than a call can take as arguments.
  it('takes a piece of hundreds of thousands of points', () => {
    const points = Array.from({ length: 300_000 }, (_, i): TimedPosition => ({
      position: [60, 24],
      timestamp: i * 1000,
    }))
    const stream = new TrackStream(1000, 10 * MINUTE)

    expect(stream.push(points).length + stream.finish().length).toBe(points.length)
  })

  it('hands points on before the track ends', () => {
    const stream = new TrackStream(30_000, 10 * MINUTE)
    const points = Array.from({ length: 100 }, (_, i): TimedPosition => ({ position: [60, 24], timestamp: i * 10_000 }))

    expect(stream.push(points.slice(0, 50)).length).toBeGreaterThan(10)
  })
})
