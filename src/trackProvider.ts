import { Temporal } from '@js-temporal/polyfill'
import { M_PER_DEG, simplify } from './simplify.js'
import { segment, thinToBudget } from './timeWindow.js'
import type { TrackStore } from './store.js'
import type { TrackApi, TrackFeature, TracksRequest, TracksResponse } from './trackApi.js'
import type { GeoBounds, LatLngTuple, TimedPosition, TimeWindow } from './types.js'
import { toIsoTimes } from './utils.js'

/**
 * Serves the v2 Track API from this plugin's store.
 *
 * The store answers the hard parts — spatial filtering, time windows, thinning
 * — so what is left here is mostly translation: v2's GeoJSON coordinate order
 * and Temporal values in, GeoJSON Features out. Segmentation is done here,
 * by `segment()`, because it is what turns a thinned track into the
 * MultiLineString the wire format wants.
 *
 * Registered alongside the v1 routes rather than replacing them, so
 * Freeboard-SK keeps working until it moves.
 */

export interface TrackProviderDeps {
  store: () => TrackStore | undefined
  selfContext: () => string
  /** Gap in ms that starts a new segment; 0 leaves the track as one line. */
  segmentGap: () => number
  /**
   * The vessel's name for `contextName`, or undefined when unknown.
   *
   * Injected like the rest: resolving it needs the server's data model, which
   * the provider has no handle on. Called per query rather than cached,
   * because an AIS target's static report routinely lands well after its
   * first position.
   */
  contextName: (context: string) => string | undefined
  /**
   * Positions a history provider holds for a context and window, reconciled
   * with the store's own.
   *
   * Injected rather than reached for directly: the reconciliation belongs to
   * the plugin, and the v1 routes have done it since #73 — a query answered
   * through the v2 provider has to give the same answer as the same query
   * answered through v1, or the plugin contradicts itself depending on which
   * route a client happens to use.
   *
   * Resolves to the store's own points unchanged when no provider is
   * installed, which is the common case.
   */
  reconcileWithHistory: (
    context: string,
    stored: TimedPosition[],
    window: TimeWindow | undefined,
    resolutionMs: number | undefined,
  ) => Promise<TimedPosition[]>
}

/** v2 sends `[west, south, east, north]`; a bounds here is `[lat, lng]` corners. */
const toGeoBounds = (bbox: TracksRequest['bbox']): GeoBounds | null => {
  if (!bbox) {
    return null
  }
  const [west, south, east, north] = bbox
  return { sw: [south, west], ne: [north, east] }
}

/**
 * The window a request describes, in epoch milliseconds.
 *
 * The server resolves `duration` into `from`/`to` before a provider sees it,
 * so `duration` is handled only as a fallback for a caller that reaches this
 * directly.
 */
const toTimeWindow = (query: TracksRequest): TimeWindow | undefined => {
  const to = query.to ? query.to.epochMilliseconds : undefined
  const from = query.from ? query.from.epochMilliseconds : undefined
  if (from === undefined && to === undefined && !query.duration) {
    return undefined
  }
  const end = to ?? Date.now()
  const start =
    from ??
    (query.duration
      ? Temporal.Instant.fromEpochMilliseconds(end).toZonedDateTimeISO('UTC').subtract(query.duration).toInstant()
          .epochMilliseconds
      : Number.NEGATIVE_INFINITY)
  // Half-open when the caller named an end, closed when it defaulted to now.
  // A client walking adjacent windows — [T0,T1) then [T1,T2) — would otherwise
  // get the point at exactly T1 in both and draw it twice. When `to` was not
  // given the window ends at now, has no neighbour to overlap, and excluding
  // the newest point would just hide the latest fix. The v1 routes resolve it
  // the same way; see parseTrackQuery.
  return { from: start, to: end, inclusiveEnd: to === undefined }
}

/**
 * A duration in milliseconds, including the calendar units.
 *
 * `total()` refuses weeks, months and years without a starting point, because
 * their length depends on where you start counting — and the API validates
 * `resolution` as any positive ISO 8601 duration, so `?resolution=P1W` reaches
 * here and would otherwise throw a RangeError out as a 500.
 *
 * Resolved against a fixed reference rather than the queried window: a
 * resolution is a spacing, not a position, so the same query has to thin to the
 * same grid wherever in the calendar it lands. Against the window instead, two
 * identical requests would thin differently depending on when they were asked.
 *
 * The reference makes `P1M` 31 days and `P1Y` 366 — January's length, and a
 * leap year. Which month it lands on is arbitrary either way; what matters is
 * that it is the *same* arbitrary choice every time, and at these scales a
 * day's difference in the spacing is not something a caller asking for
 * month-apart points is relying on.
 */
const CALENDAR_REFERENCE = Temporal.PlainDate.from('2000-01-01')

const totalMilliseconds = (duration: Temporal.Duration): number =>
  duration.total({ unit: 'milliseconds', relativeTo: CALENDAR_REFERENCE })

/**
 * Milliseconds back to a Duration, for reporting the spacing applied.
 *
 * Exact, not rounded to something tidier. A budget-derived spacing lands on
 * values like 24470ms, and `PT24.47S` does read as false precision — but the
 * field says what was applied, and a client re-querying with a rounded `PT24S`
 * gets 51 points where the budget it asked for was 50. Reproducibility beats
 * tidiness.
 */
const msToDuration = (ms: number): Temporal.Duration =>
  // Split into whole milliseconds and a nanosecond remainder: `Duration.from`
  // rejects a fractional value in any unit, and a resolution below a
  // millisecond reaches here intact — the API accepts `PT0.0005S`, which is
  // 0.5ms. Rounding it away would report a spacing that was not applied.
  Temporal.Duration.from({
    milliseconds: Math.trunc(ms),
    nanoseconds: Math.round((ms - Math.trunc(ms)) * 1e6),
  }).round({
    largestUnit: 'hour',
  })

const toLngLat = ([lat, lng]: LatLngTuple): [number, number] => [lng, lat]

/** Bounding box of the returned geometry, in GeoJSON order. */
const boundsOf = (points: TimedPosition[]): TracksRequest['bbox'] => {
  if (points.length === 0) {
    return undefined
  }
  let south = points[0]!.position[0]
  let north = south
  const longitudes: number[] = []
  for (const { position } of points) {
    const [lat, lng] = position
    if (lat < south) south = lat
    if (lat > north) north = lat
    longitudes.push(lng)
  }
  const [west, east] = longitudeSpan(longitudes)
  return [west, south, east, north]
}

/**
 * The narrower of the two longitude intervals covering these points.
 *
 * A plain min/max describes a track spanning the antimeridian as almost the
 * whole globe: two fixes at 179 and -179 are two degrees apart, but min/max
 * reports 358. RFC 7946 says a box crossing the antimeridian is written with
 * west greater than east, so the wrap-around interval is expressible — pick it
 * whenever it is the shorter of the two.
 *
 * The widest gap between adjacent longitudes is the part of the globe the track
 * does not cover, so the complement of that gap is the tightest interval that
 * does.
 */
const longitudeSpan = (longitudes: number[]): [number, number] => {
  const sorted = [...longitudes].sort((a, b) => a - b)
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  let widestGap = 360 - (max - min)
  let west = min
  let east = max
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!
    if (gap > widestGap) {
      widestGap = gap
      west = sorted[i]!
      east = sorted[i - 1]!
    }
  }
  return [west, east]
}

export function createTrackProvider(deps: TrackProviderDeps): TrackApi {
  const matching = async (
    query: TracksRequest,
  ): Promise<{ tracks: Map<string, TimedPosition[]>; resolution: number | undefined }> => {
    const store = deps.store()
    if (!store) {
      return { tracks: new Map(), resolution: undefined }
    }
    const window = toTimeWindow(query)
    const resolution = query.resolution ? totalMilliseconds(query.resolution) : undefined
    const wanted = query.contexts?.length ? new Set(query.contexts.map(resolveSelf(deps.selfContext()))) : undefined

    // Thinning is handed to the store rather than applied to the result: it is
    // the same `thin()` either way, and asking twice is both wasted work and a
    // second place for the two to disagree about what a resolution means.
    //
    // The bbox path goes through the store's spatial filter, which the sqlite
    // store answers from its cell index rather than by reading every track.
    const collection = await store.getFilteredTimedTracks(
      // intersects: the v2 contract matches a track on any position within the
      // window, not on where the vessel ended up — "a vessel that crossed the
      // box an hour ago and has since left still matches". The v1 routes keep
      // the last-position rule, which is the right answer to their own
      // question.
      { bbox: toGeoBounds(query.bbox), radius: null, intersects: true },
      undefined,
      undefined,
      {
        ...(window ? { window } : {}),
        ...(resolution === undefined ? {} : { resolution }),
      },
    )

    const result = new Map<string, TimedPosition[]>()
    // Reconciled per context rather than in one pass: a history provider is
    // asked per context, and the store's own points are what a provider-less
    // install returns unchanged.
    const contexts = Object.entries(collection).filter(([context]) => !wanted || wanted.has(context))
    const reconciled = await Promise.all(
      contexts.map(
        async ([context, stored]) =>
          [context, await deps.reconcileWithHistory(context, stored, window, resolution)] as const,
      ),
    )
    for (const [context, points] of reconciled) {
      // Dropped here rather than in getTracks, so both entry points agree on
      // what matched. A store filters on the *last* position, so a context can
      // match spatially and still have no point inside the time window;
      // listing it while getTracks returns nothing for it sends a client to
      // fetch a track that is not there.
      if (points.length === 0) {
        continue
      }
      result.set(context, points)
    }
    return { tracks: result, resolution }
  }

  return {
    async getTracks(query: TracksRequest): Promise<TracksResponse> {
      const { tracks: matched, resolution: requested } = await matching(query)
      const gap = deps.segmentGap()
      const selfContext = deps.selfContext()
      const features: TrackFeature[] = []
      for (const [context, all] of matched) {
        // The budget is applied per track, after the store's own thinning: a
        // client that named both is asking for this spacing *and* no more than
        // this many points, and the wider of the two wins.
        const { points, resolution: appliedMs } =
          query.maxPoints === undefined
            ? { points: all, resolution: requested }
            : thinToBudget(all, query.maxPoints, requested)
        if (points.length === 0) {
          continue
        }
        // Simplification runs after thinning, not before: thinning is what a
        // client asked for explicitly, and simplifying first would spend the
        // shape budget on points that are about to be dropped anyway.
        //
        // `epsilon` implies `simplify`, per the spec. With `simplify` and no
        // epsilon the tolerance is chosen from the track's own extent, which
        // is the spec's "a tolerance suited to the size of the box" — derived
        // from what was actually returned rather than from the query, so a
        // bbox-less request still gets a sensible one.
        //
        // Segmenting comes first and each segment is simplified on its own.
        // The simplifier has no notion of a time gap, so given the whole track
        // it can drop the points either side of one — two collinear legs
        // three hours apart reduce to a single line, and segmenting that
        // afterwards yields one-point segments, which are not drawable
        // geometry. Splitting first keeps every leg's own endpoints.
        const chosenEpsilon = chooseEpsilon(points, query)
        const segments = segment(points, gap).map((s) => (chosenEpsilon === undefined ? s : simplify(s, chosenEpsilon)))
        const shaped = segments.flat()
        const bbox = boundsOf(shaped)
        const name = deps.contextName(context)
        features.push({
          type: 'Feature',
          // geometry=false asks for the metadata only, so a client can list
          // what exists before paying for the coordinates.
          geometry:
            query.geometry === false
              ? null
              : {
                  type: 'MultiLineString',
                  coordinates: segments.map((s) => s.map(({ position }) => toLngLat(position))),
                },
          properties: {
            context,
            isSelf: context === selfContext,
            // Omitted rather than empty: the spec says "where known".
            ...(name === undefined ? {} : { contextName: name }),
            from: new Date(shaped[0]!.timestamp).toISOString(),
            to: new Date(shaped[shaped.length - 1]!.timestamp).toISOString(),
            ...(bbox ? { bbox } : {}),
            pointCount: shaped.length,
            // The spacing actually applied, which is not always the one asked
            // for: a maxPoints budget widens it. Reported so a client can tell
            // a thinned track from a full one, and see what produced it.
            ...(appliedMs === undefined ? {} : { resolution: msToDuration(appliedMs).toString() }),
            // The tolerance simplification ran with, absent when it did not
            // run at all. Note a tolerance can legitimately change nothing —
            // a track with no point further than epsilon from its own line is
            // already as simple as it gets — so this reports what was applied
            // rather than implying the geometry differs from the stored one.
            ...(chosenEpsilon === undefined ? {} : { epsilon: chosenEpsilon }),
            ...(query.times ? { coordTimes: segments.map(toIsoTimes) } : {}),
          },
        })
      }
      return { type: 'FeatureCollection', features }
    },

    async getTrackContexts(query: TracksRequest): Promise<string[]> {
      return [...(await matching(query)).tracks.keys()]
    },
  }
}

/**
 * The tolerance to simplify with, or undefined to leave the geometry alone.
 *
 * `epsilon` implies `simplify=true`, so an explicit tolerance is honoured
 * whether or not the flag came with it. `simplify` alone leaves the tolerance
 * to the provider: the spec says "a tolerance suited to the size of the box",
 * and the extent of the track *as thinning left it* is the honest basis for
 * that — a query bbox may be absent, and when present it is what the client
 * searched in rather than what came back. It cannot be the simplified extent,
 * since that is the thing being computed.
 *
 * Chosen from the whole track rather than per segment, so every leg of one
 * track is simplified to the same tolerance and the single reported `epsilon`
 * describes all of them.
 *
 * A non-positive `epsilon` is not reachable through the API — the schema
 * declares `exclusiveMinimum: 0`, so the server rejects it — and is treated
 * here as no tolerance given, falling through to `simplify` if that was asked
 * for. Simplifying by zero would be a no-op reported as if it had done
 * something.
 */
function chooseEpsilon(points: TimedPosition[], query: TracksRequest): number | undefined {
  const explicit = query.epsilon
  if (explicit !== undefined && explicit > 0) {
    return explicit
  }
  return query.simplify === true ? autoEpsilon(points) : undefined
}

/**
 * How much of a track's own extent the automatic tolerance may deviate by.
 *
 * One part in a thousand. Provisional while the v2 API is designed in
 * SignalK/signalk-server#2504: it is only a provider-chosen default for
 * `simplify` without an explicit epsilon, and a client that calibrates against
 * the exact ratio rather than reading the reported `epsilon` back would make
 * it expensive to change.
 */
const AUTO_EPSILON_DIVISOR = 1000

/**
 * Floor, in metres, under the automatic tolerance.
 *
 * Below the noise of any GPS fix, so it collapses the thousands of near
 * identical points a vessel records at anchor without altering a track that
 * actually moved.
 */
const MIN_AUTO_EPSILON = 1

/**
 * A tolerance scaled to how much ground a track covers.
 *
 * One part in a thousand of the track's diagonal: enough to drop the jitter of
 * a boat holding station while keeping every turn a passage is made of. A
 * fixed metre value cannot do both — 10 m erases nothing on an ocean crossing
 * and erases a marina approach entirely.
 */
function autoEpsilon(points: TimedPosition[]): number | undefined {
  const bounds = boundsOf(points)
  if (!bounds) {
    return undefined
  }
  const [west, south, east, north] = bounds
  const midLat = (south + north) / 2
  const height = (north - south) * M_PER_DEG
  // boundsOf writes an antimeridian-crossing box as west > east (RFC 7946), so
  // a plain subtraction turns a tenth of a degree into -359.8 and the derived
  // tolerance into something that would erase the whole track.
  const lngSpan = east >= west ? east - west : east + 360 - west
  const width = lngSpan * M_PER_DEG * Math.cos((midLat * Math.PI) / 180)
  const diagonal = Math.hypot(width, height)
  // A floor, not a fallback for a zero extent. A vessel swinging at anchor
  // covers tens of metres, so the proportional tolerance works out at
  // centimetres and drops nothing -- leaving the track most worth collapsing
  // untouched. One metre is below any GPS's own noise, so applying it as a
  // minimum cannot alter a track that actually went somewhere.
  return Math.max(diagonal / AUTO_EPSILON_DIVISOR, MIN_AUTO_EPSILON)
}

/** v2 accepts the `self` alias; the store keys on the qualified context. */
const resolveSelf =
  (selfContext: string) =>
  (context: string): string =>
    context === 'self' || context === 'vessels.self' ? selfContext : context
