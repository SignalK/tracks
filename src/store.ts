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
 * `getAllTracks` and `getFilteredTracks` are derived operations, and they are
 * on the interface deliberately: filtering is a predicate over whole tracks,
 * which the in-memory implementation applies in JS and a database
 * implementation will want to push into the query. A store that can filter in
 * SQL must be allowed to, rather than being forced to materialise every track
 * so a caller can filter it afterwards.
 */
export interface TrackStore {
  /** Record a position for a context. `timestamp` defaults to now. */
  newPosition(context: Context, position: LatLngTuple, timestamp?: number): void

  /**
   * Seed a context's track, replacing whatever it held.
   *
   * A test helper: it is how a known track is installed without going through
   * the position bus, which throttles on write. `timestamps` is positional
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

  /**
   * Drop contexts whose newest position is older than `maxAge` ms.
   *
   * `keep` is never pruned however long it has been idle. The own vessel's
   * track is the one a user came for — it has to survive a winter on a
   * mooring, a passage with the server off, and any gap in reception. Other
   * vessels age out: a harbour puts hundreds of AIS targets past a receiver in
   * a day, and keeping every one of them forever is not what anybody asked for.
   *
   * An implementation must also apply whatever row-level retention it was
   * configured with, scoped to `keep`. The two are separate: one drops a whole
   * vessel that has gone quiet, the other trims old points from the vessel a
   * user is actually recording, and neither may switch the other off.
   *
   * `Infinity` ages nothing out, which is how a caller asks for the retention
   * pass alone. A negative `maxAge` puts the cutoff in the future and so drops
   * every context — the tests use `-1` for exactly that; the plugin's schema
   * keeps it out of a real configuration.
   */
  prune(maxAge: number, keep?: Context): void

  /**
   * Release any resources held by the store.
   *
   * A no-op for the in-memory implementation, which is why it is optional; a
   * store holding file handles must implement it and the plugin calls it from
   * `stop()`.
   */
  close?(): void
}
