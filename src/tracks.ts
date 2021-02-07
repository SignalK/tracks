import { ConnectableObservable, Observable, Subject } from 'rxjs'
import { max, publishReplay, scan, shareReplay, take, throttleTime } from 'rxjs/operators'
import { Config, Context, Position, QueryParameters, VesselCollection } from './types'
import { distanceTo, inBounds } from './utils'

interface tracksMap {
  [context: string]: TrackAccumulator
}




export default class Tracks {
  tracks: tracksMap = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: any
  config: Config
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(config: Config, debug: any) {
    this.config = config
    this.debug = debug
  }

  newPosition(context: Context, position: Position): void {
    this.getAccumulator(context)?.nextPosition(position)
  }

  getAccumulator(context: Context, createIfMissing = true): TrackAccumulator | undefined {
    return (
      this.tracks[context] ||
      (createIfMissing &&
        (this.tracks[context] = new TrackAccumulator(this.config.resolution, this.config.pointsToKeep)))
    )
  }

  // Return all / filtered vessels and their tracks
  async getAll(params?: QueryParameters, position?: Position): Promise<VesselCollection> {
    const res: VesselCollection= {}
    let keys= Object.keys(this.tracks)
    for( let k of keys) {
      await this.get(k).then( (t:Position[])=> {
        // filter results based on supplied params
        if(this.filterVessels(t, params, position)) { res[k]= t }
      })
      .catch ( (err)=> { console.log(err) })
    }
    return Promise.resolve(res)
  }

  // returns true if last track point passes filter tests
  filterVessels(t:Position[], params?: QueryParameters, position?: Position): boolean {
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
      if((this.config.maxRadius || params.radius) && position) { 
        let radius= (params.radius) ? params.radius : this.config.maxRadius
        if(lastPoint && distanceTo(lastPoint, position)<= radius) {
          result= result && true
        }
        else { result= false }
      }
    }
    return result
  }

  get(context: Context): Promise<Position[]> {
    const accumulator = this.getAccumulator(context, false)
    if (accumulator) {
      return accumulator.track.pipe(take(1)).toPromise()
    } else {
      return Promise.reject()
    }
  }

  prune(maxAge: number): void {
    const cutoff = Date.now() - maxAge
    const deleted: string[] = []
    Object.entries(this.tracks).forEach(([key, value]) => {
      if (value.latestPosition < cutoff) {
        delete this.tracks[key]
        deleted.push(key)
      }
    })
    if (this.debug.enabled) {
      this.debug(`deleted tracks for ${deleted}`)
    }
  }
}

class TrackAccumulator {
  input: Subject<Position> = new Subject()
  latestPosition = 0
  track: Observable<Position[]>

  constructor(resolution: number, pointsToKeep: number) {
    this.track = this.input.pipe(
      throttleTime(resolution),
      scan<Position, Position[]>((acc, position) => {
        acc.push(position)
        return acc.slice(Math.max(0, acc.length - pointsToKeep))
      }, []),
      publishReplay(1),
    )
    const connectable = this.track as ConnectableObservable<Position[]>
    connectable.connect()
  }

  nextPosition(position: Position) {
    this.input.next(position)
    this.latestPosition = Date.now()
  }
}
