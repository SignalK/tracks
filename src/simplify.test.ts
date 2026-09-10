import { describe, expect, it } from 'vitest'
import { simplify, simplifyToBudget } from './simplify.js'
import type { TimedPosition } from './types.js'

const at = (lat: number, lng: number, t = 0): TimedPosition => ({ position: [lat, lng], timestamp: t })

/** ~1 m in degrees of latitude, for building tracks with known deviations. */
const M = 1 / 111_320

describe('simplify', () => {
  it('drops points a straight line already describes', () => {
    const line = [at(60, 24), at(60, 24.001), at(60, 24.002), at(60, 24.003)]

    expect(simplify(line, 1)).toEqual([line[0], line[3]])
  })

  it('keeps a corner', () => {
    const corner = [at(60, 24), at(60.01, 24.005), at(60, 24.01)]

    expect(simplify(corner, 1)).toHaveLength(3)
  })

  // The distinction from thin(): a deviation smaller than the tolerance goes,
  // a larger one stays, regardless of how the points are spaced in time.
  it('keeps a deviation larger than epsilon and drops a smaller one', () => {
    const big = [at(60, 24), at(60 + 20 * M, 24.001), at(60, 24.002)]
    const small = [at(60, 24), at(60 + 2 * M, 24.001), at(60, 24.002)]

    expect(simplify(big, 10)).toHaveLength(3)
    expect(simplify(small, 10)).toHaveLength(2)
  })

  it('always keeps the first and last point', () => {
    const track = Array.from({ length: 50 }, (_, i) => at(60, 24 + i * 0.0001, i))

    const result = simplify(track, 100)

    expect(result[0]).toEqual(track[0])
    expect(result.at(-1)).toEqual(track.at(-1))
  })

  it('preserves timestamps on the points it keeps', () => {
    const track = [at(60, 24, 1000), at(60.01, 24.005, 2000), at(60, 24.01, 3000)]

    expect(simplify(track, 1).map((p) => p.timestamp)).toEqual([1000, 2000, 3000])
  })

  it('returns the track unchanged for a non-positive epsilon', () => {
    const track = [at(60, 24), at(60, 24.001), at(60, 24.002)]

    expect(simplify(track, 0)).toEqual(track)
    expect(simplify(track, -1)).toEqual(track)
  })

  it('handles tracks too short to simplify', () => {
    expect(simplify([], 10)).toEqual([])
    expect(simplify([at(60, 24)], 10)).toHaveLength(1)
    expect(simplify([at(60, 24), at(61, 25)], 10)).toHaveLength(2)
  })

  // A track that doubles back has its far point close to the *infinite* line
  // through the endpoints but far from the segment. Measuring to the line
  // would drop the excursion entirely.
  it('keeps an out-and-back excursion', () => {
    const outAndBack = [at(60, 24), at(60 + 500 * M, 24), at(60, 24.00001)]

    expect(simplify(outAndBack, 50)).toHaveLength(3)
  })

  // Longitude degrees shrink towards the poles. Scaling by cos(latitude) is
  // what keeps a tolerance in metres meaning the same thing at every latitude.
  //
  // A north-south leg at 80N with an east-west deviation: 0.001 deg of
  // longitude is ~19 m there but would read as ~111 m unscaled. An epsilon
  // between the two tells the scaled implementation from the unscaled one.
  it('applies the tolerance in metres, not degrees, at high latitude', () => {
    const leg = [at(80, 0), at(80.001, 0.001), at(80.002, 0)]

    // Truly ~19 m out, so a 50 m tolerance drops it.
    expect(simplify(leg, 50)).toHaveLength(2)
    // ...and a 10 m tolerance keeps it. Unscaled, the deviation would read as
    // ~111 m and the first assertion would fail.
    expect(simplify(leg, 10)).toHaveLength(3)
  })

  // The antimeridian is written 179.9 then -179.9: a tenth of a degree apart
  // on the ground, 359.8 apart numerically. Read literally, a straight line
  // across it spans most of the globe and every point on it measures
  // kilometres away, so nothing is ever simplified.
  it('simplifies a straight line across the antimeridian', () => {
    const crossing = [at(0, 179.9), at(0, 180), at(0, -179.9)]

    expect(simplify(crossing, 100)).toHaveLength(2)
  })

  it('still keeps a real corner at the antimeridian', () => {
    const corner = [at(0, 179.9), at(0.01, 180), at(0, -179.9)]

    expect(simplify(corner, 100)).toHaveLength(3)
  })
})

describe('simplifyToBudget', () => {
  const zigzag = Array.from({ length: 400 }, (_, i) => at(60 + (i % 2 ? 30 * M : 0), 24 + i * 0.0002, i * 1000))

  it('meets the point budget', () => {
    const { points } = simplifyToBudget(zigzag, 30)

    expect(points.length).toBeLessThanOrEqual(30)
  })

  it('reports the tolerance that achieved it', () => {
    const { points, epsilon } = simplifyToBudget(zigzag, 30)

    // The reported epsilon must reproduce the result, or a client re-querying
    // with it gets a different track than the one it was told about.
    expect(simplify(zigzag, epsilon).length).toBe(points.length)
  })

  it('leaves a track already within budget alone, at zero tolerance', () => {
    const short = [at(60, 24), at(60.01, 24.005), at(60, 24.01)]

    expect(simplifyToBudget(short, 10)).toEqual({ points: short, epsilon: 0 })
  })

  it('never returns fewer than the two endpoints', () => {
    const { points } = simplifyToBudget(zigzag, 1)

    expect(points.length).toBeGreaterThanOrEqual(2)
  })

  // Douglas-Peucker is monotonic in epsilon, which is what makes the search
  // converge; a violation would mean the binary search can miss the budget.
  it('is monotonic in epsilon', () => {
    let previous = Infinity
    for (const eps of [0.5, 1, 2, 5, 10, 20, 50]) {
      const n = simplify(zigzag, eps).length
      expect(n).toBeLessThanOrEqual(previous)
      previous = n
    }
  })
})
