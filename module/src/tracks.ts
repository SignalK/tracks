import { BehaviorSubject, combineLatest, ConnectableObservable, Observable, ReplaySubject, Subject } from 'rxjs'
import { map, publishReplay, scan, take, throttleTime } from 'rxjs/operators'
import { Context, LatLngTuple, Position, QueryParameters, VesselCollection  } from './types'
import { distanceTo, inBounds, latLonTupleToPosition } from './utils'

interface tracksMap {
  [context: string]: TrackAccumulator
}

export interface TracksConfig {
  resolution: number
  pointsToKeep: number
  maxAge: number
  fetchInitialTrack?: boolean,
  maxRadius: number
}

export class Tracks {
  tracks: tracksMap = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: any
  config: TracksConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(config: TracksConfig, debug: any) {
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

    // Return all / filtered vessels and their tracks
  async getAll(params?: QueryParameters, position?: Position): Promise<VesselCollection> {
    const res: VesselCollection= {}
    let keys= Object.keys(this.tracks)
    for( let k of keys) {
      await this.get(k).then( (t:LatLngTuple[])=> {
        // filter results based on supplied params
        if(this.applyFilters(t, params, position)) { res[k]= t }
      })
      .catch ( (err)=> { console.log(err) })
    }
    return Promise.resolve(res)
  }

  // returns true if last track point passes filter tests
  applyFilters(t:LatLngTuple[], params?: QueryParameters, vesselPosition?: Position): boolean {
    let result: boolean= true
    if(params && Object.keys(params).length!=0) {
      let lastPoint: any= (t.length!=0) ? t[t.length-1] : null
      // within supplied bounded area
      if(params.geobounds) { 
        if(lastPoint && inBounds(lastPoint, params.geobounds)) {
          result= result && true
        }
        else { result= false }
      }
      // within supplied radius of vessel position
      if((this.config.maxRadius || params.radius) && vesselPosition) { 
        let radius= (params.radius) ? params.radius : this.config.maxRadius
        if(lastPoint && distanceTo(latLonTupleToPosition(lastPoint), vesselPosition)<= radius) {
          result= result && true
        }
        else { result= false }
      }
    }
    return result
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
