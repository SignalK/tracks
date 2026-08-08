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
}

export interface Debug {
  (...args: unknown[]): void
  enabled: boolean
}
