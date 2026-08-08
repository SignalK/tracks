import { BehaviorSubject, combineLatest, connectable, firstValueFrom, ReplaySubject, Subject } from 'rxjs'
import type { Connectable, Observable } from 'rxjs'
import { map, scan, startWith, throttleTime } from 'rxjs/operators'
import { thin } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import type { TrackStore } from './store.js'
import type { Context, Debug, LatLngTuple, TimedPosition, TimeWindow, TrackCollection, TrackParams } from './types.js'
import { createMatcher } from './utils.js'

interface TracksMap {
  [context: string]: TrackAccumulator
}

interface VesselTrack {
  context: string
  track: LatLngTuple[]
}

export interface TracksConfig {
  resolution: number
  pointsToKeep: number
  fetchInitialTrack?: boolean
}

/**
 * The in-memory store: a bounded sliding window of positions per context,
 * held in RxJS accumulators and lost on restart. `bootstrapSelfTrack()` in
 * index.ts is what re-hydrates it from a History provider at startup.
 */
export class Tracks implements TrackStore {
  tracks: TracksMap = {}
  debug: Debug
  config: TracksConfig
  constructor(config: TracksConfig, debug: Debug) {
    if (debug.enabled) {
      debug(JSON.stringify(config))
    }
    this.config = config
    this.debug = debug
  }

  newPosition(context: Context, position: LatLngTuple, timestamp?: number): void {
    this.getAccumulator(context)?.nextLatLngTuple(position, timestamp)
  }

  initialTrack(context: Context, track: LatLngTuple[], timestamps?: number[]): void {
    this.getAccumulator(context)?.setInitialTrack(track, timestamps)
  }

  getAccumulator(context: Context, createIfMissing = true): TrackAccumulator | undefined {
    if (context.indexOf('vessels.') === -1 && context.indexOf('aircraft.') === -1) {
      return undefined
    }
    let result = this.tracks[context]
    if (!result && createIfMissing) {
      const accParams: AccumulatorParams = this.config.fetchInitialTrack
        ? { ...this.config, fetchTrackFor: context }
        : { ...this.config }
      result = this.tracks[context] = new TrackAccumulator(accParams)
    }
    return result
  }

  get(context: Context, window?: TimeWindow): Promise<LatLngTuple[]> {
    return this.getTimed(context, window).then((points) => points.map(({ position }) => position))
  }

  /**
   * Track points with their timestamps, optionally narrowed to a time window.
   *
   * Rejects with EmptyError if the stream completes without emitting; the route
   * handlers turn that into the same 404 as an unknown context.
   */
  getTimed(context: Context, window?: TimeWindow): Promise<TimedPosition[]> {
    const accumulator = this.getAccumulator(context, false)
    if (!accumulator) {
      return Promise.reject(new Error(`No track accumulator for ${context}`))
    }
    return firstValueFrom(accumulator.timedTrack).then((points) =>
      window
        ? points.filter(
            ({ timestamp }) =>
              timestamp >= window.from && (window.inclusiveEnd ? timestamp <= window.to : timestamp < window.to),
          )
        : points,
    )
  }

  getAllTracks(query?: TrackQuery): Promise<VesselTrack[]> {
    return Promise.all(
      Object.keys(this.tracks).map((context) =>
        this.getTimed(context, query?.window).then((points) => ({
          context,
          track: thin(points, query?.resolution).map(({ position }) => position),
        })),
      ),
    )
  }

  // Return all / filtered vessels and their tracks
  async getFilteredTracks(
    params: TrackParams,
    selfPosition?: LatLngTuple,
    debug?: Debug,
    query?: TrackQuery,
  ): Promise<TrackCollection> {
    this.debug(params)
    this.debug('Self position', selfPosition)
    const matcher = createMatcher(params, selfPosition, debug)

    return this.getAllTracks(query).then((contextTracks) => {
      return contextTracks.reduce<TrackCollection>((acc, { context, track }) => {
        if (matcher(track)) {
          acc[context] = track
        }
        return acc
      }, {})
    })
  }

  prune(maxAge: number): void {
    const cutoff = Date.now() - maxAge
    const deleted: string[] = []
    Object.entries(this.tracks).forEach(([key, value]) => {
      if (value.latestLatLngTuple < cutoff) {
        delete this.tracks[key]
        deleted.push(key)
      }
    })
    if (this.debug.enabled) {
      this.debug(`deleted tracks for ${deleted.join(', ')}`)
    }
  }
}

interface AccumulatorParams {
  resolution: number
  pointsToKeep: number
  fetchTrackFor?: string
}

export class TrackAccumulator {
  initialTrack: Subject<TimedPosition[]> = new BehaviorSubject<TimedPosition[]>([])
  input: Subject<TimedPosition> = new Subject()
  latestLatLngTuple = 0
  accumulatedTrack: Connectable<TimedPosition[]>
  /** Timestamped points, used to answer time-window queries. */
  timedTrack: Observable<TimedPosition[]>
  /** Positions only — the long-standing public shape. */
  track: Observable<LatLngTuple[]>

  constructor({ resolution, pointsToKeep, fetchTrackFor }: AccumulatorParams) {
    // rxjs 7 replaces the publishReplay operator + ConnectableObservable cast
    // with an explicit connectable(); the ReplaySubject(1) connector preserves
    // the replay-latest behaviour a late subscriber depends on.
    this.accumulatedTrack = connectable(
      this.input.pipe(
        throttleTime(resolution),
        scan<TimedPosition, TimedPosition[]>((acc, point) => {
          acc.push(point)
          return acc.slice(Math.max(0, acc.length - pointsToKeep))
        }, []),
        // combineLatest below only emits once every source has, and `scan` stays
        // silent until the first live position. Without this an accumulator that
        // has only been given an initial track — the state after a History API
        // bootstrap, before any live delta — never yields a readable track.
        startWith<TimedPosition[]>([]),
      ),
      { connector: () => new ReplaySubject<TimedPosition[]>(1), resetOnDisconnect: false },
    )
    this.timedTrack = combineLatest([this.initialTrack, this.accumulatedTrack]).pipe(
      map(([initialTrack, accumulatedTrack]) => [...initialTrack, ...accumulatedTrack]),
    )
    this.track = this.timedTrack.pipe(map((points) => points.map(({ position }) => position)))
    this.accumulatedTrack.connect()

    if (fetchTrackFor) {
      void fetchTrack(fetchTrackFor).then((trackGEOJson) => {
        const coordinates = trackGEOJson?.coordinates?.[0]
        if (coordinates) {
          // The fetched track carries no timestamps; date them at the start of
          // time so a time-window query treats them as older than anything live.
          this.initialTrack.next(coordinates.map((position) => ({ position, timestamp: 0 })))
        }
      })
    }
  }

  nextLatLngTuple(position: LatLngTuple, timestamp: number = Date.now()): void {
    this.input.next({ position, timestamp })
    this.latestLatLngTuple = timestamp
  }

  setInitialTrack(track: LatLngTuple[], timestamps?: number[]): void {
    this.initialTrack.next(track.map((position, i) => ({ position, timestamp: timestamps?.[i] ?? 0 })))
  }
}

interface TrackGeoJson {
  coordinates?: LatLngTuple[][]
}

// Browser-side helper for the exported TrackAccumulator: only reachable when a
// webapp constructs one with fetchInitialTrack, never on the server.
const fetchTrack = (context: Context): Promise<TrackGeoJson> => {
  const contextParts = context.split('.')
  if (contextParts[0] !== 'vessels') {
    return Promise.resolve({})
  }
  return fetch(`/signalk/v1/api/vessels/${contextParts[1]}/track`, {
    credentials: 'include',
  }).then((r) => (r.status === 200 ? (r.json() as Promise<TrackGeoJson>) : Promise.resolve({})))
}
