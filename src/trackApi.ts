import { Temporal } from '@js-temporal/polyfill'

/**
 * The v2 Track API contract, declared locally.
 *
 * These mirror `@signalk/server-api/tracks`, and are copied here for the same
 * reason the History API types are: depending on the package would pin this
 * plugin to a server version, and the subpath is not published yet. Swap the
 * imports when it is.
 *
 * Specified in https://github.com/SignalK/signalk-server/issues/2504 and
 * implemented in https://github.com/SignalK/signalk-server/pull/2995.
 */

/** `[west, south, east, north]` — GeoJSON coordinate order. */
export type TrackBoundingBox = [number, number, number, number]

/**
 * A request as the server hands it to a provider.
 *
 * Not every field is honoured here. `maxPoints`, `simplify`, `epsilon` and
 * `properties` are accepted by the API and ignored by this provider: it serves
 * positions, and has no co-recorded values to attach or geometry simplifier to
 * run. A caller gets the full, unsimplified track for the window it asked for,
 * which is a superset of what it requested rather than a wrong answer. The
 * response echoes `resolution` when one was requested, so a client can tell a
 * thinned track from a full one.
 *
 * Simplification and co-recorded properties are tracked separately; see
 * SignalK/tracks.
 */
export interface TracksRequest {
  contexts?: string[]
  from?: Temporal.Instant
  to?: Temporal.Instant
  duration?: Temporal.Duration
  bbox?: TrackBoundingBox
  resolution?: Temporal.Duration
  maxPoints?: number
  simplify?: boolean
  epsilon?: number
  times?: boolean
  properties?: string[]
  geometry?: boolean
}

export interface TrackProperties {
  context: string
  isSelf: boolean
  contextName?: string
  from: string
  to: string
  bbox?: TrackBoundingBox
  pointCount: number
  resolution?: string
  epsilon?: number
  coordTimes?: string[][]
  appliedProperties?: string[]
  values?: Record<string, (number | string | null)[][]>
}

export interface TrackFeature {
  type: 'Feature'
  geometry: {
    type: 'MultiLineString'
    /** `[longitude, latitude]` positions, per segment. */
    coordinates: [number, number][][]
  } | null
  properties: TrackProperties
}

export interface TracksResponse {
  type: 'FeatureCollection'
  features: TrackFeature[]
}

export interface TrackApi {
  getTracks(query: TracksRequest): Promise<TracksResponse>
  getTrackContexts(query: TracksRequest): Promise<string[]>
}

/** Present on servers that carry the Track API; absent on older ones. */
export interface WithTrackApi {
  registerTrackApiProvider?: (provider: TrackApi) => void
}
