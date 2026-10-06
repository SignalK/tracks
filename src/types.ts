export type Context = string

export type LatLngTuple = [number, number]
export type LngLatTuple = [number, number]

/**
 * A track point with the time it was recorded, in epoch milliseconds.
 *
 * Positions are stored as bare `LatLngTuple`s on the wire and in the public
 * `track` observable; timestamps are kept alongside so time-window queries
 * (`from`/`to`/`duration`) can slice a track without changing that shape.
 */
export interface TimedPosition {
  position: LatLngTuple
  timestamp: number
  /**
   * The longest pause in the recording between the point before this one and
   * this one, set where thinning dropped the points in between. Without it,
   * the time between the two is itself the recorded step.
   */
  pauseBefore?: number
  /**
   * The stretch of time this point stands for, when it is a history
   * provider's bucket rather than a fix. The fixes it summarises can lie
   * anywhere in that stretch.
   */
  span?: number
  /**
   * Starts a new line here whatever the time since the point before: the
   * track left a clipping box between the two and came back.
   */
  breakBefore?: boolean
}

/**
 * A time window in epoch milliseconds, half-open as `[from, to)`.
 *
 * Half-open so the bands a client requests to cover a long trail tile exactly:
 * `[now-24h, now-1h)` and `[now-1h, now]` share the boundary point without
 * returning it twice. `inclusiveEnd` closes the final band so the newest fix is
 * not dropped from a "last hour" query.
 */
export interface TimeWindow {
  from: number
  to: number
  inclusiveEnd?: boolean
}

export interface Position {
  latitude: number
  longitude: number
}

export interface TrackCollection {
  [key: string]: LatLngTuple[]
}

/** As `TrackCollection`, but each point keeps the time it was recorded. */
export interface TimedTrackCollection {
  [key: string]: TimedPosition[]
}

export interface GeoBounds {
  ne: LatLngTuple
  sw: LatLngTuple
}

/**
 * Express `req.query` shape: a value may be absent, a single string, or repeated
 * into an array when the same key appears more than once in the query string.
 */
export type QueryParameters = Record<string, unknown>

export interface TrackParams {
  bbox: GeoBounds | null
  radius: number | null
  /**
   * Match a track on *any* position rather than its last.
   *
   * The v1 routes answer "vessels near here now", so they match the last
   * position — a vessel that has left is no longer near. The v2 Track API asks
   * a different question, "tracks that passed through this box within the
   * window", and its contract says a vessel that crossed an hour ago and has
   * since left still matches. Same filter, two questions.
   */
  intersects?: boolean
  /**
   * Only these contexts, fully qualified; absent for every context. A store
   * reads nothing for the others, so asking for one vessel does not cost a
   * read of every track it holds.
   */
  contexts?: Context[]
  /**
   * The caller clips each track to `bbox`, so a store need read only the
   * stretches near the box rather than every position in the window. A read
   * narrowing, not a filter: a store may ignore it and return whole tracks.
   */
  clip?: boolean
}

export interface Debug {
  (...args: unknown[]): void
  enabled: boolean
}
