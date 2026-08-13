import type {
  Context,
  Debug,
  LatLngTuple,
  TimedPosition,
  TimedTrackCollection,
  TimeWindow,
  TrackCollection,
  TrackParams,
} from './types.js'
import type { TrackQuery } from './timeWindow.js'

/**
 * A track store: somewhere positions are accumulated and queried back.
 *
 * The in-memory `Tracks` accumulator is one implementation; a persistent store
 * is another. The interface is deliberately the surface the plugin already
 * calls in `index.ts` and nothing more, so that adding an implementation cannot
 * quietly widen what a store is expected to do.
 *
 * Note what is *not* here. `getAllTracks` and `getFilteredTracks` are derived
 * operations — filtering is a predicate over whole tracks, which the in-memory
 * implementation applies in JS and a database implementation will want to push
 * into the query. Both stay on the interface for that reason: a store that can
 * filter in SQL must be allowed to, rather than being forced to materialise
 * every track so a caller can filter it afterwards.
 */
export interface TrackStore {
  /** Record a position for a context. `timestamp` defaults to now. */
  newPosition(context: Context, position: LatLngTuple, timestamp?: number): void

  /**
   * Seed a context's track, replacing whatever it held.
   *
   * Used by the History API bootstrap at startup. `timestamps` is positional
   * against `track`; points without one are dated to the start of time so a
   * time-window query treats them as older than anything live.
   */
  initialTrack(context: Context, track: LatLngTuple[], timestamps?: number[]): void

  /**
   * Positions for a context, oldest first, optionally narrowed to a window.
   *
   * Rejects when the context is unknown; the route handlers turn that into a
   * 404. Resolving with `[]` would be indistinguishable from a vessel that is
   * known but has not moved.
   */
  get(context: Context, window?: TimeWindow): Promise<LatLngTuple[]>

  /** As `get`, but keeping the timestamp of each point. */
  getTimed(context: Context, window?: TimeWindow): Promise<TimedPosition[]>

  /** Every known context and its track, thinned to `query.resolution`. */
  getAllTracks(query?: TrackQuery): Promise<{ context: string; track: LatLngTuple[] }[]>

  /** As `getFilteredTracks`, but keeping the timestamp of each point. */
  getFilteredTimedTracks(
    params: TrackParams,
    selfPosition?: LatLngTuple,
    debug?: Debug,
    query?: TrackQuery,
  ): Promise<TimedTrackCollection>

  /**
   * Tracks whose *last* position matches a spatial predicate.
   *
   * Matching on the last position rather than any position is what makes this
   * "vessels currently near here" rather than "vessels that ever passed here".
   */
  getFilteredTracks(
    params: TrackParams,
    selfPosition?: LatLngTuple,
    debug?: Debug,
    query?: TrackQuery,
  ): Promise<TrackCollection>

  /** Drop contexts whose newest position is older than `maxAge` ms. */
  prune(maxAge: number): void

  /**
   * Release any resources held by the store.
   *
   * A no-op for the in-memory implementation, which is why it is optional; a
   * store holding file handles must implement it and the plugin calls it from
   * `stop()`.
   */
  close?(): void
}
