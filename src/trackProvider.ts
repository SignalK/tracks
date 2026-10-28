import { Temporal } from '@js-temporal/polyfill'
import { M_PER_DEG, simplify } from './simplify.js'
import { segment, thin, thinToBudget } from './timeWindow.js'
import type { TrackStore } from './store.js'
import { decimate, isImportedId, isTimed, positionsOf, toImportedTrack } from './importedTracks.js'
import { recordedContext, recordedId } from './recycleBin.js'
import { TrackRejectedError } from './trackApi.js'
import type {
  TrackApi,
  TrackBoundingBox,
  TrackFeature,
  TrackImport,
  TrackProperties,
  TrackSpan,
  TracksRequest,
  TracksResponse,
} from './trackApi.js'
import type {
  GeoBounds,
  ImportedTrack,
  LatLngTuple,
  OnOverlap,
  StoredImport,
  TimedPosition,
  TimeWindow,
  TrackSummary,
} from './types.js'
import { clipToBounds, createReachesBounds, longitudeSpan, toIsoTimes, unknownAs } from './utils.js'

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
   * Whether the history import could bring a vessel's track back into the
   * recording: the own vessel's, where a history provider is installed or an
   * import has started already, which goes on once its provider is back. A
   * delete of it then leaves its span behind even where the store held
   * nothing, so a later import leaves it deleted.
   */
  importable: (context: string) => Promise<boolean>
  /** Called after a delete, so whatever caches the deleted spans reloads them. */
  deleted: () => void
  /** The most positions read for a recorded track's answer without a box; MAX_TRACK_POINTS unless set. */
  maxTrackPoints?: number
}

/**
 * The most positions the provider reads for one recorded track's answer to
 * a query without a box, as it counts them before the read: fixes recorded
 * in between can add a few. A read thinned in time to fit can hold one
 * more, where positions share the last time; its answer is thinned to the
 * budget.
 *
 * A query for one vessel that names no window is its whole recording, and
 * with the history import that is years of positions: the 2 M of a boat's
 * four years took a process past 900 MB, read in full and built into one
 * answer before `maxPoints` or simplifying could shrink it. A track larger
 * than this is read simplified instead, to the smallest tolerance up to
 * 32 m whose levels hold it within the budget, or thinned in time where
 * `maxPoints` asks for spacing, where levels cannot be read, or where none
 * up to 32 m holds it; the answer reports which in `epsilon` or
 * `resolution`.
 */
export const MAX_TRACK_POINTS = 250_000

/**
 * The tolerances a track too large for its answer is read at, smallest
 * first: the levels `significant` keeps, 0.25 m times a power of two from
 * the lowest a read uses. Past the last, the track is thinned in time.
 */
const FIT_TOLERANCES = [4, 8, 16, 32]

/**
 * How a recorded track too large for its answer is read instead: at, and
 * simplified to at least, a tolerance in metres; or at least `resolution`
 * milliseconds apart, then thinned to `maxPoints` where that leaves more, as
 * positions sharing the last time or a `maxPoints` of 1 do.
 */
type Fit =
  { tolerance: number; resolution?: undefined } | { tolerance?: undefined; resolution: number; maxPoints: number }

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

/** A read's tolerance as a key left out when there is none, which exactOptionalPropertyTypes requires. */
const readAt = (tolerance: number | undefined): { tolerance?: number } => (tolerance === undefined ? {} : { tolerance })

/** The spacing a read thins to: the wider of the client's and the one a fit adds. */
const spacing = (requested: number | undefined, fitted: number | undefined): { resolution?: number } =>
  requested === undefined && fitted === undefined ? {} : { resolution: Math.max(requested ?? 0, fitted ?? 0) }

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

/** The Track API provider, plus the import route's way in with an overlap choice. */
export type TrackProvider = TrackApi & {
  importTrack(track: ImportedTrack, onOverlap: OnOverlap): Promise<KeptTrack>
}

export function createTrackProvider(deps: TrackProviderDeps): TrackProvider {
  const matching = async (
    query: TracksRequest,
  ): Promise<{ tracks: Map<string, TimedPosition[]>; resolution: number | undefined; fits: Map<string, Fit> }> => {
    const store = deps.store()
    if (!store) {
      return { tracks: new Map(), resolution: undefined, fits: new Map() }
    }
    const window = toTimeWindow(query)
    const resolution = query.resolution ? totalMilliseconds(query.resolution) : undefined
    const wanted = query.contexts?.length
      ? [...new Set(query.contexts.map(resolveSelf(deps.selfContext())))]
      : undefined
    const bounds = toGeoBounds(query.bbox)
    // Without a box there is nothing to clip to, whatever `clip` says.
    const clipTo = query.clip === true ? bounds : null
    const { tolerance } = readTolerance(query, deps.segmentGap())

    // Thinning is handed to the store rather than applied to the result: it is
    // the same `thin()` either way, and asking twice is both wasted work and a
    // second place for the two to disagree about what a resolution means.
    //
    // The bbox path goes through the store's spatial filter, which the sqlite
    // store answers from its cell index rather than by reading every track,
    // and the requested contexts go with it so the store reads only those.
    const read = (contexts: string[] | undefined, fit?: Fit) =>
      store.getFilteredTimedTracks(
        // intersects: the v2 contract matches a track on any position within the
        // window, not on where the vessel ended up — "a vessel that crossed the
        // box an hour ago and has since left still matches". The v1 routes keep
        // the last-position rule, which is the right answer to their own
        // question.
        {
          bbox: bounds,
          radius: null,
          intersects: true,
          ...(contexts ? { contexts } : {}),
          ...(clipTo ? { clip: true } : {}),
        },
        undefined,
        undefined,
        {
          ...(window ? { window } : {}),
          // A track matched against a box is thinned after matching, below, so
          // thinning cannot drop the point inside it, and a clipped one keeps
          // the points that carry it to the box edge.
          ...(bounds ? {} : spacing(resolution, fit?.resolution)),
          ...readAt(fit?.tolerance ?? tolerance),
        },
      )

    // A read with a box is not counted: with `clip` it holds the stretches
    // near the box, and without it a named vessel's whole track. Without a
    // box, each track is counted first, and one over the budget is read on
    // its own to fit it.
    // The contexts counted are read by name, so the store need not list
    // them a second time, and the answer keeps the order it holds them in.
    const { fits, counted } = bounds
      ? { fits: new Map<string, Fit>(), counted: wanted }
      : await fitted(store, wanted, window, resolution, tolerance, query)
    const rest = counted?.filter((context) => !fits.has(context))
    const pieces = await Promise.all([
      rest === undefined || rest.length > 0 ? read(rest) : {},
      ...[...fits].map(([context, fit]) => read([context], fit)),
    ])
    const byContext = new Map(pieces.flatMap((piece) => Object.entries(piece)))
    const collection = counted
      ? counted.flatMap((context) => {
          const points = byContext.get(context)
          return points ? [[context, points] as const] : []
        })
      : [...byContext]

    const reaches = bounds ? createReachesBounds(bounds) : undefined
    const result = new Map<string, TimedPosition[]>()
    for (const [context, stored] of collection) {
      // The store matches a box on the stretches it reads near it, which the
      // match here decides on, with the lines between their points.
      if (reaches && !reaches(stored)) {
        continue
      }
      const points = clipTo
        ? thin(clipToBounds(stored, clipTo), resolution)
        : bounds
          ? thin(stored, resolution)
          : stored
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
    return { tracks: result, resolution, fits }
  }

  /**
   * The recorded tracks a read without a box would hold more of than the
   * budget, each with how it is read instead, and the contexts counted, in
   * the order the store holds them. A track is counted as the read would
   * return it, at its tolerance and thinned to a client's `resolution`. One
   * over the budget is read at the smallest of `FIT_TOLERANCES` above the
   * query's tolerance whose levels hold it within the budget; with
   * `maxPoints`, which asks for spacing, no tolerance is tried, and it is
   * spaced as `maxPoints` first spaces a track, where that holds it. Where
   * neither does, or, without `maxPoints`, the read may pass no tolerance
   * (tracks split at pauses), it is spaced in time to the budget.
   * A track within the budget is read as before, and `maxPoints` thins it
   * as it always did.
   */
  const fitted = async (
    store: TrackStore,
    wanted: string[] | undefined,
    window: TimeWindow | undefined,
    resolution: number | undefined,
    tolerance: number | undefined,
    query: TracksRequest,
  ): Promise<{ fits: Map<string, Fit>; counted: string[] | undefined }> => {
    const fits = new Map<string, Fit>()
    if (!store.countTimed || !store.timeExtent) {
      return { fits, counted: wanted }
    }
    const count = store.countTimed.bind(store)
    const budget = deps.maxTrackPoints ?? MAX_TRACK_POINTS
    // A read as `read()` makes it without a box, at `at` and thinned to `spacing`.
    const counted = async (contexts: string[] | undefined, at: number | undefined, spacing: number | undefined) =>
      count(
        contexts,
        { ...(window ? { window } : {}), ...readAt(at), ...(spacing === undefined ? {} : { resolution: spacing }) },
        budget + 1,
      )
    const counts = await counted(wanted, tolerance, undefined)
    for (const [context, total] of Object.entries(counts)) {
      if (total <= budget) {
        continue
      }
      // Gone since it was counted: the read leaves it out.
      const extent = await store.timeExtent(context, window).catch(unknownAs(undefined))
      const span = extent ? extent.last - extent.first : 0
      // Whether a read at `at`, thinned to `spacing`, holds no more than the
      // budget: thinning keeps a position per spacing at most and the last,
      // and where the track's extent leaves room for more, the store counts
      // what the thinning keeps.
      const within = async (spacing: number | undefined, at = tolerance) =>
        (spacing !== undefined && Math.floor(span / spacing) + 2 <= budget) ||
        ((await counted([context], at, spacing))[context] ?? 0) <= budget
      if (resolution !== undefined && (await within(resolution))) {
        continue
      }
      let fit: Fit | undefined
      if (query.maxPoints !== undefined) {
        // thinToBudget's first spacing, which keeps no more than maxPoints
        // but for positions sharing the last time, or a maxPoints of 1.
        // Read at it, a track of more positions than maxPoints gets the
        // answer it always got, without a resolution, but for those two:
        // thinToBudget then widens the spacing over what was read rather
        // than over every position, or keeps the first position and
        // reports the spacing read at. With a resolution, thinToBudget
        // spaced what was read at it.
        const first = Math.max(resolution ?? 0, Math.ceil(span / Math.max(1, query.maxPoints - 1)), 1)
        if (query.maxPoints <= budget || (await within(first))) {
          fit = { resolution: first, maxPoints: query.maxPoints }
        }
      } else if (deps.segmentGap() === 0) {
        for (const candidate of FIT_TOLERANCES.filter((t) => tolerance === undefined || t > tolerance)) {
          if (await within(resolution, candidate)) {
            fit = { tolerance: candidate }
            break
          }
        }
      }
      fits.set(
        context,
        fit ?? {
          resolution: Math.max(resolution ?? 0, Math.ceil(span / Math.max(1, budget - 1)), 1),
          maxPoints: budget,
        },
      )
    }
    return { fits, counted: Object.keys(counts) }
  }

  /**
   * A listing — `geometry=false` with nothing that reshapes the points: no
   * box, spacing, budget, simplification or times — answered from the
   * store's summaries rather than its points. A track's properties are then
   * its stored count, times and bounds, so reading every position only to
   * count them is the whole cost of a list over weeks of AIS traffic.
   */
  const listing = async (query: TracksRequest): Promise<TrackSummary[] | undefined> => {
    const store = deps.store()
    if (
      !store?.summarize ||
      query.geometry !== false ||
      query.bbox ||
      query.resolution ||
      query.maxPoints !== undefined ||
      query.simplify ||
      query.epsilon !== undefined ||
      query.times
    ) {
      return undefined
    }
    const wanted = query.contexts?.length
      ? [...new Set(query.contexts.map(resolveSelf(deps.selfContext())))]
      : undefined
    return store.summarize(wanted, toTimeWindow(query))
  }

  /**
   * Imported tracks the query matches, each with the points it returns.
   *
   * The same filters as a recorded track, applied to the import's own points:
   * a context names the vessel it was imported for, a window needs times, a
   * box needs a point inside it or a line through it and clips like a
   * recorded track.
   */
  const matchingImports = async (
    query: TracksRequest,
  ): Promise<{ track: StoredImport; points: TimedPosition[]; timed: boolean }[]> => {
    const store = deps.store()
    if (!store?.findImports) {
      return []
    }
    const window = toTimeWindow(query)
    const resolution = query.resolution ? totalMilliseconds(query.resolution) : undefined
    const bounds = toGeoBounds(query.bbox)
    const clipTo = query.clip === true ? bounds : null
    const reaches = bounds ? createReachesBounds(bounds) : undefined
    const imports = await store.findImports({
      ...(query.contexts?.length
        ? { contexts: [...new Set(query.contexts.map(resolveSelf(deps.selfContext())))] }
        : {}),
      ...(window ? { window } : {}),
      ...(bounds ? { bbox: bounds } : {}),
    })
    const result: { track: StoredImport; points: TimedPosition[]; timed: boolean }[] = []
    for (const track of imports) {
      const timed = isTimed(track)
      // Matched on the points inside the window, as a recorded track is.
      if (reaches && !reaches(positionsOf(track, null, window))) {
        continue
      }
      let points = positionsOf(track, clipTo, window)
      if (timed) {
        points = thin(points, resolution)
      }
      if (points.length > 0) {
        result.push({ track, points, timed })
      }
    }
    return result
  }

  /**
   * What names an imported track: its id, name and vessel, over what it was posted with.
   * `imported`, when it was kept, tells it apart from the recording of the same vessel, which it is listed beside.
   */
  const importIdentity = (track: StoredImport): Omit<TrackProperties, 'pointCount'> => {
    const contextName = track.context === undefined ? undefined : deps.contextName(track.context)
    return {
      ...track.metadata,
      id: track.id,
      imported: new Date(track.importedAt).toISOString(),
      ...(track.name === undefined ? {} : { name: track.name }),
      ...(track.context === undefined
        ? {}
        : {
            context: track.context,
            isSelf: track.context === deps.selfContext(),
            ...(contextName === undefined ? {} : { contextName }),
          }),
    }
  }

  type WritableStore = Required<
    Pick<TrackStore, 'storeImport' | 'recordTrack' | 'fillTrack' | 'getImport' | 'binImport' | 'binRecorded'>
  >

  /** The store, when it can keep and delete tracks; an ordinary failure otherwise. */
  const writableStore = (): WritableStore => {
    const store = deps.store()
    if (
      !store?.storeImport ||
      !store.recordTrack ||
      !store.fillTrack ||
      !store.getImport ||
      !store.binImport ||
      !store.binRecorded
    ) {
      throw new Error('Track storage is not available')
    }
    return store as WritableStore
  }

  const importTrack = (track: ImportedTrack, onOverlap: OnOverlap): Promise<KeptTrack> =>
    keepTrack(
      track,
      {
        store: writableStore(),
        selfContext: deps.selfContext(),
        importable: deps.importable,
        deleted: deps.deleted,
      },
      onOverlap,
    )

  /** The recorded feature's identity, which `getTracks` and `getTrack` share. */
  const recordedIdentity = (context: string): Omit<TrackProperties, 'pointCount'> => {
    const name = deps.contextName(context)
    return {
      id: recordedId(context),
      context,
      isSelf: context === deps.selfContext(),
      // Omitted rather than empty: the spec says "where known".
      ...(name === undefined ? {} : { contextName: name }),
    }
  }

  /**
   * Move a vessel's recording within the span to the recycle bin, resolving
   * false for a vessel the store does not know and no import could bring.
   *
   * `to` is the moment of the delete, never the end of time: recording goes
   * on, and what it records afterwards is a new track, not a deleted one.
   */
  const deleteRecorded = async (
    context: string,
    from: number | undefined,
    to: number | undefined,
  ): Promise<boolean> => {
    const now = Date.now()
    const end = Math.min(to ?? now, now)
    const importable = await deps.importable(context)
    // A span that starts after now holds nothing anyone recorded yet.
    const keepEmpty = importable && (from === undefined || from <= end)
    const { known } = await writableStore().binRecorded(context, from, end, now, keepEmpty)
    deps.deleted()
    return known || importable
  }

  return {
    async getTracks(query: TracksRequest): Promise<TracksResponse> {
      const summaries = await listing(query)
      const {
        tracks: matched,
        resolution: requested,
        fits,
      } = summaries
        ? { tracks: new Map<string, TimedPosition[]>(), resolution: undefined, fits: new Map<string, Fit>() }
        : await matching(query)
      const gap = deps.segmentGap()
      const features: TrackFeature[] = []
      for (const [context, all] of matched) {
        const feature = shapeFitted(all, gap, query, requested, recordedIdentity(context), fits.get(context))
        if (feature) {
          features.push(feature)
        }
      }
      for (const { context, pointCount, first, last, bbox } of summaries ?? []) {
        // What shapeFeature reports for the same points, which nothing reshapes.
        features.push({
          type: 'Feature',
          geometry: null,
          properties: {
            ...recordedIdentity(context),
            from: new Date(first).toISOString(),
            to: new Date(last).toISOString(),
            bbox,
            pointCount,
          },
        })
      }
      // Each import is a feature of its own, beside any recorded track of
      // the same vessel: an import names a vessel, it does not join its
      // recording. Its posted segments are the only breaks, so no gap rule.
      const requestedForImports = query.resolution ? totalMilliseconds(query.resolution) : undefined
      for (const { track, points, timed } of await matchingImports(query)) {
        const feature = shapeFeature(
          points,
          0,
          query,
          timed ? requestedForImports : undefined,
          importIdentity(track),
          timed,
        )
        if (feature) {
          features.push(feature)
        }
      }
      return { type: 'FeatureCollection', features }
    },

    async getTrackContexts(query: TracksRequest): Promise<string[]> {
      const [recorded, imported] = await Promise.all([matching(query), matchingImports(query)])
      const contexts = new Set(recorded.tracks.keys())
      for (const { track } of imported) {
        if (track.context !== undefined) {
          contexts.add(track.context)
        }
      }
      return [...contexts]
    },

    async getTrack(id: string): Promise<TrackFeature | undefined> {
      const recorded = recordedContext(id)
      if (recorded !== undefined) {
        // The whole recording, as an unbounded query for this one vessel
        // returns it, with its times.
        const context = resolveSelf(deps.selfContext())(recorded)
        const query = { contexts: [context], times: true }
        const { tracks, fits } = await matching(query)
        const points = tracks.get(context)
        return (
          points &&
          shapeFitted(points, deps.segmentGap(), query, undefined, recordedIdentity(context), fits.get(context))
        )
      }
      if (!isImportedId(id)) {
        return undefined
      }
      const track = await writableStore().getImport(id)
      if (!track) {
        return undefined
      }
      // Returned whole and with its times, so it can be posted to another
      // provider exactly as it was posted here.
      const timed = isTimed(track)
      return shapeFeature(positionsOf(track, null), 0, { times: timed }, undefined, importIdentity(track), timed)
    },

    async storeTrack(track: TrackImport): Promise<string> {
      return (await importTrack(toImportedTrack(track), 'keep')).id
    },

    importTrack,

    async deleteTrack(id: string): Promise<boolean> {
      const recorded = recordedContext(id)
      if (recorded !== undefined) {
        return deleteRecorded(resolveSelf(deps.selfContext())(recorded), undefined, undefined)
      }
      if (!isImportedId(id)) {
        return false
      }
      return (await writableStore().binImport(id, undefined, Date.now())) !== undefined
    },

    async deleteTrackSpan(id: string, span: TrackSpan): Promise<boolean> {
      const from = span.from?.epochMilliseconds
      const to = span.to?.epochMilliseconds
      const recorded = recordedContext(id)
      if (recorded !== undefined) {
        return deleteRecorded(resolveSelf(deps.selfContext())(recorded), from, to)
      }
      if (!isImportedId(id)) {
        return false
      }
      const store = writableStore()
      const track = await store.getImport(id)
      if (!track) {
        return false
      }
      if (!isTimed(track)) {
        throw new TrackRejectedError('This track has no times, so no part of it can be addressed by time')
      }
      await store.binImport(
        id,
        { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
        Date.now(),
      )
      return true
    },
  }
}

/**
 * A recorded track as a Feature, shaped to the fit it was read with: simplified
 * to at least the tolerance it was read at, or thinned to its budget at no
 * less than the spacing it was read at. Without a fit, as `shapeFeature`
 * shapes it.
 */
function shapeFitted(
  all: TimedPosition[],
  gap: number,
  query: TracksRequest,
  requested: number | undefined,
  identity: Omit<TrackProperties, 'pointCount'>,
  fit: Fit | undefined,
): TrackFeature | undefined {
  if (fit?.resolution !== undefined) {
    return shapeFeature(
      all,
      gap,
      { ...query, maxPoints: fit.maxPoints },
      spacing(requested, fit.resolution).resolution,
      identity,
    )
  }
  return shapeFeature(all, gap, query, requested, identity, true, fit?.tolerance)
}

/**
 * One track as a Feature, or undefined when the budget leaves nothing to draw.
 *
 * `identity` is whatever names the track — context, vessel name — and comes
 * first, so the derived properties after it always describe the geometry
 * actually returned.
 */
function shapeFeature(
  all: TimedPosition[],
  gap: number,
  query: TracksRequest,
  requested: number | undefined,
  identity: Omit<TrackProperties, 'pointCount'>,
  timed = true,
  minEpsilon?: number,
): TrackFeature | undefined {
  // The budget is applied per track, after the store's own thinning: a
  // client that named both is asking for this spacing *and* no more than
  // this many points, and the wider of the two wins. A track without times
  // has no spacing to widen, so it is met by keeping evenly chosen points.
  const { points, resolution: appliedMs } =
    query.maxPoints === undefined
      ? { points: all, resolution: requested }
      : timed
        ? thinToBudget(all, query.maxPoints, requested)
        : { points: decimate(all, query.maxPoints), resolution: undefined }
  if (points.length === 0) {
    return undefined
  }
  // Simplification runs after thinning, not before: thinning is what a
  // client asked for explicitly, and simplifying first would spend the
  // shape budget on points that are about to be dropped anyway.
  //
  // `epsilon` implies `simplify`, per the spec. With `simplify` and no
  // epsilon the tolerance is sized to the query's box, or to the track
  // itself when there is none; see chooseEpsilon.
  //
  // Segmenting comes first and each segment is simplified on its own.
  // The simplifier has no notion of a time gap, so given the whole track
  // it can drop the points either side of one — two collinear legs
  // three hours apart reduce to a single line, and segmenting that
  // afterwards yields one-point segments, which are not drawable
  // geometry. Splitting first keeps every leg's own endpoints.
  // A track read at a tolerance to fit its budget is simplified to at least
  // that tolerance, so the epsilon the answer reports is never below it.
  const asked = chooseEpsilon(points, query)
  const chosenEpsilon = minEpsilon === undefined ? asked : Math.max(asked ?? 0, minEpsilon)
  const segments = segment(points, gap).map((s) => (chosenEpsilon === undefined ? s : simplify(s, chosenEpsilon)))
  const shaped = segments.flat()
  const bbox = boundsOf(shaped)
  return {
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
      ...identity,
      ...(timed
        ? {
            from: new Date(shaped[0]!.timestamp).toISOString(),
            to: new Date(shaped[shaped.length - 1]!.timestamp).toISOString(),
          }
        : {}),
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
      ...(query.times && timed ? { coordTimes: segments.map(toIsoTimes) } : {}),
    },
  }
}

/**
 * The tolerance a query will be simplified to, where it is known before the
 * read: an explicit `epsilon`, or the one `simplify` sizes to the box. Passed
 * to the store, which may then leave out what simplifying drops. A tolerance
 * sized to the track itself is known only once the track is read.
 *
 * None where what follows the read judges a track by the points it is
 * given, since what a tolerance leaves out lies between them:
 * - tracks split at pauses: `segment()` would read a straight leg as a stop;
 * - a box without `clip`: a track matches on its points inside, and those a
 *   level leaves out can be all it had there.
 */
function readTolerance(query: TracksRequest, gap: number): { tolerance?: number } {
  if (gap > 0 || (query.bbox && query.clip !== true)) {
    return {}
  }
  if (query.epsilon !== undefined && query.epsilon > 0) {
    return { tolerance: query.epsilon }
  }
  return query.simplify === true && query.bbox ? { tolerance: extentEpsilon(query.bbox) } : {}
}

/**
 * The tolerance to simplify with, or undefined to leave the geometry alone.
 *
 * `epsilon` implies `simplify=true`, so an explicit tolerance is honoured
 * whether or not the flag came with it. `simplify` alone leaves the tolerance
 * to the provider, and the spec asks for one "suited to the size of the box":
 * with a `bbox` it is sized to that box, which for a chart viewer is its view,
 * so detail follows the zoom. With no box the choice is the provider's, and
 * the extent of the track *as thinning left it* stands in -- not the
 * simplified extent, since that is the thing being computed. A `bbox` without
 * `simplify` simplifies nothing.
 *
 * Chosen once per track rather than per segment, so every leg of one track is
 * simplified to the same tolerance and the single reported `epsilon` describes
 * all of them.
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
  if (query.simplify !== true) {
    return undefined
  }
  if (query.bbox) {
    return extentEpsilon(query.bbox)
  }
  const bounds = boundsOf(points)
  return bounds ? extentEpsilon(bounds) : undefined
}

/**
 * How much of an extent -- the query box, or the track without one -- the
 * automatic tolerance may deviate by.
 *
 * One part in a thousand: across a view that is roughly one screen pixel.
 * Provisional while the v2 API is designed in SignalK/signalk-server#2504: it
 * is only a provider-chosen default for `simplify` without an explicit
 * epsilon, and a client that calibrates against the exact ratio rather than
 * reading the reported `epsilon` back would make it expensive to change.
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
 * A tolerance scaled to how much ground an extent covers.
 *
 * One part in a thousand of its diagonal. For a track that drops the jitter of
 * a boat holding station while keeping every turn a passage is made of; for a
 * view it keeps what a pixel can show. A fixed metre value cannot do either —
 * 10 m erases nothing on an ocean crossing and erases a marina approach
 * entirely.
 */
function extentEpsilon([west, south, east, north]: TrackBoundingBox): number {
  const midLat = (south + north) / 2
  const height = (north - south) * M_PER_DEG
  // A box crossing the antimeridian is written west > east (RFC 7946), so a
  // plain subtraction turns a tenth of a degree into -359.8 and the derived
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

export type { OnOverlap }

export interface KeepTrackDeps {
  store: Required<Pick<TrackStore, 'storeImport' | 'recordTrack' | 'fillTrack'>>
  selfContext: string
  /** Whether the history import could bring the vessel's track back; see TrackProviderDeps. */
  importable: (context: string) => Promise<boolean>
  deleted: () => void
}

export interface KeptTrack {
  id: string
  /** Points left out because the vessel already had positions there. */
  overlapping: number
}

/**
 * Keep a client's track, resolving to the id that addresses it.
 *
 * A timed track of the own vessel is the vessel's own passage, from before
 * the plugin recorded it or from another plotter, so it is written into the
 * recording and answers as `recorded:<context>`: with `keep`, only where the
 * recording has nothing (see `fillGaps`), judged as the store writes
 * it; with `replace`, in place of what was recorded over the same time. Everything else is kept as an import: another vessel's track is not
 * this boat's recording, and an untimed one cannot be placed in it.
 */
export async function keepTrack(track: ImportedTrack, deps: KeepTrackDeps, onOverlap: OnOverlap): Promise<KeptTrack> {
  const context = track.context === undefined ? undefined : resolveSelf(deps.selfContext)(track.context)
  if (context === deps.selfContext && isTimed(track)) {
    const segments = track.segments.map((points) =>
      points.map(({ position, timestamp }): TimedPosition => ({ position, timestamp: timestamp! })),
    )
    if (onOverlap === 'keep') {
      // Judged inside the write, with nothing read first: another upload or a
      // restore could write into a gap between a read and the write. Not
      // recordTrack, which bins what lies in each span.
      const overlapping = await deps.store.fillTrack(context, segments)
      return { id: recordedId(context), overlapping }
    }
    // As a delete does: the binned span stays where the store held nothing,
    // so a history import later leaves the old passage out too.
    await deps.store.recordTrack(context, segments, Date.now(), await deps.importable(context))
    deps.deleted()
    return { id: recordedId(context), overlapping: 0 }
  }
  await deps.store.storeImport(track)
  return { id: track.id, overlapping: 0 }
}

/** v2 accepts the `self` alias; the store keys on the qualified context. */
const resolveSelf =
  (selfContext: string) =>
  (context: string): string =>
    context === 'self' || context === 'vessels.self' ? selfContext : context
