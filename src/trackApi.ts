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
 * implemented in https://github.com/SignalK/signalk-server/pull/2995; storing,
 * fetching and deleting a track by id in
 * https://github.com/SignalK/signalk-server/pull/3038.
 */

/** `[west, south, east, north]` — GeoJSON coordinate order. */
export type TrackBoundingBox = [number, number, number, number]

/**
 * A request as the server hands it to a provider.
 *
 * Not every field is honoured here. `properties` is accepted by the API and
 * ignored by this provider: it serves positions, and has no co-recorded values
 * to attach. Geometry comes back without them, which is a superset of what such
 * a request asked for rather than a wrong answer.
 *
 * `resolution`, `maxPoints`, `simplify` and `epsilon` are all applied, and the
 * response reports the spacing and tolerance actually used — neither is always
 * the one asked for, since a budget widens the spacing and `simplify` without
 * an epsilon leaves the tolerance to the provider.

 */
export interface TracksRequest {
  contexts?: string[]
  from?: Temporal.Instant
  to?: Temporal.Instant
  duration?: Temporal.Duration
  bbox?: TrackBoundingBox
  /**
   * Cut each track to `bbox`. The server resolves the default, so a provider
   * sees an explicit value; absent means a server that predates the
   * parameter, which returned whole tracks.
   */
  clip?: boolean
  resolution?: Temporal.Duration
  maxPoints?: number
  simplify?: boolean
  epsilon?: number
  times?: boolean
  properties?: string[]
  geometry?: boolean
}

export interface TrackProperties {
  /** Identifies a stored track within this provider; recorded tracks carry none. */
  id?: string
  /** Absent for an imported track that names no vessel. */
  context?: string
  /** Absent along with `context`. */
  isSelf?: boolean
  contextName?: string
  /** The track's own name, as an imported GPX `<trk><name>` carries. */
  name?: string
  /** Absent, with `to`, for a track whose points carry no times. */
  from?: string
  to?: string
  bbox?: TrackBoundingBox
  pointCount: number
  resolution?: string
  epsilon?: number
  coordTimes?: string[][]
  appliedProperties?: string[]
  values?: Record<string, (number | string | null)[][]>
  /** Whatever else an imported track was posted with, returned as posted. */
  [key: string]: unknown
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
  /** One stored track by id, or undefined when there is none. */
  getTrack?(id: string): Promise<TrackFeature | undefined>
  /** Keep a track a client supplied, resolving to the id it was given. */
  storeTrack?(track: TrackImport): Promise<string>
  /** Delete a stored track by id, resolving false when there is none. */
  deleteTrack?(id: string): Promise<boolean>
}

/**
 * A track offered for storage, in the canonical form the server reduces every
 * import to: a MultiLineString, `coordTimes` nested to match it and in UTC, a
 * qualified context, and none of the properties a provider derives itself.
 */
export interface TrackImport {
  type: 'Feature'
  geometry: {
    type: 'MultiLineString'
    coordinates: [number, number][][]
  }
  properties: TrackImportProperties
}

export interface TrackImportProperties {
  coordTimes?: string[][]
  name?: string
  context?: string
  /** The client's own metadata, stored as posted. */
  [key: string]: unknown
}

/**
 * Thrown by `storeTrack` when this provider will not keep the track, which
 * the server answers with a 400 rather than a 500.
 *
 * The server recognises it by `isTrackRejected` rather than by class, since
 * this is a copy of its own.
 */
export class TrackRejectedError extends Error {
  readonly isTrackRejected = true as const

  constructor(message?: string) {
    super(message)
    this.name = 'TrackRejectedError'
  }
}

/** Present on servers that carry the Track API; absent on older ones. */
export interface WithTrackApi {
  registerTrackApiProvider?: (provider: TrackApi) => void
}
