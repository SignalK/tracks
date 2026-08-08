import { BehaviorSubject, combineLatest, connectable, firstValueFrom, ReplaySubject, Subject } from 'rxjs'
import type { Connectable, Observable } from 'rxjs'
import { map, scan, throttleTime } from 'rxjs/operators'
import type { Context, Debug, LatLngTuple, TrackCollection, TrackParams } from './types.js'
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

export class Tracks {
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

  newPosition(context: Context, position: LatLngTuple): void {
    this.getAccumulator(context)?.nextLatLngTuple(position)
  }

  initialTrack(context: Context, track: LatLngTuple[]): void {
    this.getAccumulator(context)?.setInitialTrack(track)
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

  get(context: Context): Promise<LatLngTuple[]> {
    const accumulator = this.getAccumulator(context, false)
    if (accumulator) {
      // Rejects with EmptyError if the stream completes without emitting; the
      // route handlers turn that into the same 404 as an unknown context.
      return firstValueFrom(accumulator.track)
    } else {
      return Promise.reject(new Error(`No track accumulator for ${context}`))
    }
  }

  getAllTracks(): Promise<VesselTrack[]> {
    return Promise.all(
      Object.keys(this.tracks).map((context) =>
        this.get(context).then((track) => ({
          context,
          track,
        })),
      ),
    )
  }

  // Return all / filtered vessels and their tracks
  async getFilteredTracks(params: TrackParams, selfPosition?: LatLngTuple, debug?: Debug): Promise<TrackCollection> {
    this.debug(params)
    this.debug('Self position', selfPosition)
    const matcher = createMatcher(params, selfPosition, debug)

    return this.getAllTracks().then((contextTracks) => {
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
  initialTrack: Subject<LatLngTuple[]> = new BehaviorSubject<LatLngTuple[]>([])
  input: Subject<LatLngTuple> = new Subject()
  latestLatLngTuple = 0
  accumulatedTrack: Connectable<LatLngTuple[]>
  track: Observable<LatLngTuple[]>

  constructor({ resolution, pointsToKeep, fetchTrackFor }: AccumulatorParams) {
    // rxjs 7 replaces the publishReplay operator + ConnectableObservable cast
    // with an explicit connectable(); the ReplaySubject(1) connector preserves
    // the replay-latest behaviour a late subscriber depends on.
    this.accumulatedTrack = connectable(
      this.input.pipe(
        throttleTime(resolution),
        scan<LatLngTuple, LatLngTuple[]>((acc, position) => {
          acc.push(position)
          return acc.slice(Math.max(0, acc.length - pointsToKeep))
        }, []),
      ),
      { connector: () => new ReplaySubject<LatLngTuple[]>(1), resetOnDisconnect: false },
    )
    this.track = combineLatest([this.initialTrack, this.accumulatedTrack]).pipe(
      map(([initialTrack, accumulatedTrack]) => [...initialTrack, ...accumulatedTrack]),
    )
    this.accumulatedTrack.connect()

    if (fetchTrackFor) {
      void fetchTrack(fetchTrackFor).then((trackGEOJson) => {
        const coordinates = trackGEOJson?.coordinates?.[0]
        if (coordinates) {
          this.initialTrack.next(coordinates)
        }
      })
    }
  }

  nextLatLngTuple(position: LatLngTuple): void {
    this.input.next(position)
    this.latestLatLngTuple = Date.now()
  }

  setInitialTrack(track: LatLngTuple[]): void {
    this.initialTrack.next(track)
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
