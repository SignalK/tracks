import { BehaviorSubject, combineLatest, ConnectableObservable, Observable, ReplaySubject, Subject } from 'rxjs'
import { map, publishReplay, scan, take, throttleTime } from 'rxjs/operators'
import { Context, Debug, LatLngTuple, Position, QueryParameters, TrackCollection, TrackParams } from './types'
import { createMatcher } from './utils'

interface tracksMap {
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
  tracks: tracksMap = {}
  debug: Debug
  config: TracksConfig
  constructor(config: TracksConfig, debug: Debug) {
    debug(JSON.stringify(config))
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
      const accParams: AccumulatorParams = { ...this.config }
      if (this.config.fetchInitialTrack) {
        accParams.fetchTrackFor = context
      }
      result = this.tracks[context] = new TrackAccumulator(accParams)
    }
    return result
  }

  get(context: Context): Promise<LatLngTuple[]> {
    const accumulator = this.getAccumulator(context, false)
    if (accumulator) {
      return accumulator.track.pipe(take(1)).toPromise()
    } else {
      return Promise.reject()
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
        const c = context as string
        const t = track as LatLngTuple[]
        if (matcher(t)) {
          acc[c] = t
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
      this.debug(`deleted tracks for ${deleted}`)
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
  accumulatedTrack: Observable<LatLngTuple[]>
  track: Observable<LatLngTuple[]>

  constructor({ resolution, pointsToKeep, fetchTrackFor }: AccumulatorParams) {
    this.accumulatedTrack = this.input.pipe(
      throttleTime(resolution),
      scan<LatLngTuple, LatLngTuple[]>((acc, position) => {
        acc.push(position)
        return acc.slice(Math.max(0, acc.length - pointsToKeep))
      }, []),
      publishReplay(1),
    )
    this.track = combineLatest([this.initialTrack, this.accumulatedTrack]).pipe(
      map(([initialTrack, accumulatedTrack]) => [...initialTrack, ...accumulatedTrack]),
    )
    const connectable = this.accumulatedTrack as ConnectableObservable<LatLngTuple[]>
    connectable.connect()

    if (fetchTrackFor) {
      fetchTrack(fetchTrackFor).then((trackGEOJson) => {
        if (trackGEOJson && trackGEOJson.coordinates && trackGEOJson.coordinates[0]) {
          this.initialTrack.next(trackGEOJson.coordinates[0])
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

const fetchTrack = (context: Context) => {
  const contextParts = context.split('.')
  if (contextParts[0] !== 'vessels') {
    return Promise.resolve({})
  }
  return fetch(`/signalk/v1/api/vessels/${contextParts[1]}/track`, {
    credentials: 'include',
  }).then((r) => (r.status === 200 ? r.json() : Promise.resolve({})))
}
