import type { TimedPosition } from './types.js'

const LAT = 0
const LNG = 1

/**
 * Metres per degree of latitude. Good to ~0.5% over the WGS84 ellipsoid.
 *
 * Exported because the provider derives its automatic tolerance from the same
 * figure: "one part in a thousand of the diagonal" only holds while both use
 * one metres-per-degree value.
 */
export const M_PER_DEG = 111_320

/**
 * Douglas-Peucker simplification of a recorded track.
 *
 * Distinct from `thin()`, and the difference is the whole point: thinning
 * decimates by *time*, so it keeps a point every N seconds whether the boat was
 * turning or holding a course, and a corner falling between two samples is
 * simply lost. Simplification decimates by *shape* — it keeps the points that
 * carry the geometry and drops the ones a straight line already describes.
 *
 * That is what makes this the piece a route conversion needs. 5,550 points at
 * 1.2 s spacing is a recording, not a route; thinning it to 30 points gives 30
 * evenly spaced positions that miss every turn, while simplifying it to 30
 * gives the turns and nothing else.
 *
 * `epsilon` is a tolerance in **metres**: no point of the original track is
 * further than this from the simplified line.
 */
export function simplify(points: TimedPosition[], epsilon: number): TimedPosition[] {
  if (!(epsilon > 0) || points.length <= 2) {
    return points
  }
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  // Iterative rather than recursive: a long track recursing per segment can
  // exhaust the stack, and a track is exactly the kind of input that arrives
  // with tens of thousands of points.
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    if (last <= first + 1) {
      continue
    }
    let worst = 0
    let worstAt = -1
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i]!, points[first]!, points[last]!)
      if (d > worst) {
        worst = d
        worstAt = i
      }
    }
    if (worstAt >= 0 && worst > epsilon) {
      keep[worstAt] = 1
      stack.push([first, worstAt], [worstAt, last])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/**
 * Distance in metres from `p` to the segment `a`-`b`.
 *
 * Positions are projected to a local plane with longitude scaled by
 * cos(latitude): over a track segment the error is far below the metre-scale
 * tolerances this is used with, and it avoids a great-circle computation per
 * point per recursion level.
 */
function perpendicularDistance(p: TimedPosition, a: TimedPosition, b: TimedPosition): number {
  // Scale longitudes at the latitude midway along the segment, so a track near
  // the poles is not simplified as though a degree of longitude were 111 km
  // wide. Taking the *midpoint* rather than the start matters once a segment
  // spans latitudes: scaling an 80N-to-equator segment at 80N shrinks every
  // longitude by cos(80) and reports a point 111 km off the line as 19 km.
  const cos = Math.cos((((a.position[LAT] + b.position[LAT]) / 2) * Math.PI) / 180)
  const originLng = a.position[LNG]
  const ax = originLng * cos
  const ay = a.position[LAT]
  const bx = nearestLongitude(b.position[LNG], originLng) * cos
  const by = b.position[LAT]
  const px = nearestLongitude(p.position[LNG], originLng) * cos
  const py = p.position[LAT]

  const dx = bx - ax
  const dy = by - ay
  let t = 0
  const lenSq = dx * dx + dy * dy
  if (lenSq > 0) {
    // Clamped, so a point beyond either end measures to the endpoint rather
    // than to the infinite line — otherwise a track that doubles back on
    // itself reports a distance far smaller than the real deviation.
    t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  }
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy) * M_PER_DEG
}

/**
 * The smallest epsilon that simplifies `points` to at most `target` of them.
 *
 * Epsilon is meaningful in the physical world but not in the thing a user
 * cares about: "accurate to 10 m" gives 8 waypoints across an open bay and 400
 * through an archipelago, so a client asking for a usable route cannot pick a
 * number in advance. A point budget is predictable; the tolerance that
 * achieved it is what gets reported back.
 *
 * Binary search over tolerance rather than an exact solve: Douglas-Peucker is
 * monotonic in epsilon — a larger tolerance never keeps more points — so this
 * converges, and the search is bounded by iteration count rather than by
 * reaching an exact hit that may not exist.
 *
 * Not reachable through the v2 API, which takes a tolerance rather than a
 * budget. It is here for the track-management webapp's "convert to route",
 * where the user asks for a usable number of waypoints and is told the
 * accuracy that produced them.
 */
export function simplifyToBudget(
  points: TimedPosition[],
  target: number,
): { points: TimedPosition[]; epsilon: number } {
  // Two endpoints always survive, so a smaller budget is unmeetable: the
  // search would grow its bound to the 1e9 ceiling and return the endpoints
  // anyway, having reported an absurd tolerance for doing so.
  const budget = Math.max(2, target)
  if (points.length <= budget) {
    return { points, epsilon: 0 }
  }
  let lo = 0
  let hi = 1
  // Grow the upper bound until it is loose enough to meet the budget. A track
  // can span an ocean, so a fixed ceiling would either fail on large tracks or
  // waste iterations on small ones.
  while (simplify(points, hi).length > budget && hi < 1e9) {
    hi *= 4
  }
  let best = simplify(points, hi)
  let bestEpsilon = hi
  for (let i = 0; i < 40 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2
    const candidate = simplify(points, mid)
    if (candidate.length > budget) {
      lo = mid
    } else {
      hi = mid
      best = candidate
      bestEpsilon = mid
    }
  }
  return { points: best, epsilon: bestEpsilon }
}

/**
 * `lng` shifted by whole turns to sit within 180 degrees of `origin`.
 *
 * A track crossing the antimeridian is stored as 179.9 then -179.9, a tenth of
 * a degree apart on the ground but 359.8 apart numerically. Without this, a
 * straight line across it reads as a segment spanning almost the whole globe,
 * and points that lie exactly on that line measure kilometres away from it —
 * so simplification keeps every one of them.
 */
function nearestLongitude(lng: number, origin: number): number {
  return lng - 360 * Math.round((lng - origin) / 360)
}
