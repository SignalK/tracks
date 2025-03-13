/*
 * Copyright 2021 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Request, RequestHandler, Response, Router } from 'express'
import { Tracks as Tracks_, TrackAccumulator as TrackAccumulator_, TracksDB } from './tracks'
import { Debug, LatLngTuple, LngLatTuple, Position, TrackCollection } from './types'
import { Context } from '@signalk/server-api'
import { validateParameters } from './utils'
import { SqliteTrackDb } from './SqliteTrackDb'
export { SqliteTrackDb } from './SqliteTrackDb'

export interface ContextPosition {
  context: Context
  value: Position
}

interface AllTracksResult {
  [context: string]: {
    type: 'MultiLineString'
    coordinates: LngLatTuple[][]
  }
}

interface Bus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onValue: (cb: (x: any) => void) => () => void
  debounceImmediate: (ms: number) => Bus
}

interface App {
  getDataDirPath(): string
  debug: Debug
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any) => void
  streambundle: {
    getBus: (
      path: string,
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onValue: (cb: (x: any) => void) => () => void
    }
    getSelfBus: (path: string) => Bus
  }
  getSelfPath: (path: string) => void
  selfId: string
}

interface Plugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  start: (c: any) => void
  stop: () => void
  signalKApiRoutes: (r: Router) => Router
  id: string
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any
}

interface TracksPluginConfig {
  resolution?: number
  pointsToKeep?: number
  maxAge?: number
  maxRadius?: number
  useDb?: boolean
}

const toLngLat = ([lat, lng]: number[]): LngLatTuple => [lng, lat]

const DEFAULT_RESOLUTION = 60000
const DEFAULT_POINTS_TO_KEEP = 60 * 2 // 2 hours with default resolution
const DEFAULT_MAX_AGE = 60 * 10 // ten minutes
const DEFAULT_MAX_RADIUS = 50 * 1000 //50 kilometers

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNumeric = (x: any) => x - parseInt(x) + 1 >= 0

const notAvailable = (res: Response) => {
  res.status(404)
  res.json({ message: `Tracks API not available because tracks plugin is not enabled` })
}

export default function ThePlugin(app: App): Plugin {
  let onStop: (() => void)[] = []
  let tracks: Tracks_ | undefined = undefined
  let tracksDb: TracksDB | undefined = undefined
  let defaultMaxRadius: number | undefined = undefined

  function getVesselPosition(): LatLngTuple | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = app.getSelfPath('navigation.position')
    return p && p.value ? [p.value.latitude, p.value.longitude] : undefined
  }

  return {
    start: function (config: TracksPluginConfig) {
      const { resolution, pointsToKeep, maxAge, maxRadius, useDb } = config
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defaultMaxRadius = maxRadius ? parseFloat(maxRadius as any) : undefined
      if (!useDb) {
        tracks = new Tracks_(
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            resolution: isNumeric(resolution) ? parseFloat(resolution as any) : DEFAULT_RESOLUTION,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pointsToKeep: isNumeric(pointsToKeep) ? parseFloat(pointsToKeep as any) : DEFAULT_POINTS_TO_KEEP,
          },
          app.debug,
        )
        onStop.push(
          app.streambundle
            .getBus('navigation.position')
            .onValue((update: ContextPosition): void =>
              tracks?.newPosition(update.context, [update.value.latitude, update.value.longitude]),
            ),
        )
      } else {
        app.debug('Using database for tracks')
        tracksDb = new SqliteTrackDb(app.selfId, app.getDataDirPath())
        onStop.push(
          app.streambundle
            .getSelfBus('navigation.position')
            .debounceImmediate(resolution || 60 * 1000)
            .onValue(({ context, value }) => {
              tracksDb?.newPosition(context, [value.latitude, value.longitude])
            }),
        )
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const theMaxAge = isNumeric(maxAge) ? parseFloat(maxAge as any) : DEFAULT_MAX_AGE

      if (useDb && tracks) {
        const pruneInterval = setInterval(tracks.prune.bind(tracks, theMaxAge * 1000), (theMaxAge * 1000) / 2)
        onStop.push(() => {
          clearInterval(pruneInterval)
        })
      }
    },

    stop: function () {
      onStop.forEach((f) => {
        try {
          f()
        } catch (err) {
          app.error(err)
        }
      })
      onStop = []
    },

    signalKApiRoutes: function (router: Router) {
      const trackHandler: RequestHandler = (req: Request, res: Response) => {
        const _tracks = tracksDb ?? tracks
        if (!_tracks) {
          notAvailable(res)
          return
        }
        _tracks
          ?.get(`vessels.${req.params.vesselId}` as Context)
          .then((coordinates: LatLngTuple[]) => {
            res.json({
              type: 'MultiLineString',
              coordinates: [coordinates.map(toLngLat)],
            })
          })
          .catch(() => {
            res.status(404)
            res.json({ message: `No track available for vessels.${req.params.vesselId}` })
          })
      }
      router.get('/vessels/:vesselId/track', trackHandler.bind(this))

      // return all / filtered vessel tracks
      const allTracksHandler: RequestHandler = (req: Request, res: Response) => {
        app.debug(req.query)
        const _tracks = tracksDb ?? tracks
        if (!_tracks) {
          notAvailable(res)
          return
        }
        _tracks
          ?.getFilteredTracks(validateParameters(req.query, defaultMaxRadius), getVesselPosition(), app.debug)
          .then((tc: TrackCollection) => {
            const trks = Object.entries(tc).reduce<AllTracksResult>((acc, [context, _tracks]) => {
              const tracks = _tracks as LatLngTuple[][]
              acc[context] = {
                type: 'MultiLineString',
                coordinates: tracks.map((track) => track.map(toLngLat)),
              }
              return acc
            }, {})
            res.json(trks)
          })
          .catch(() => {
            res.status(404)
            res.json({ message: `No track available for vessels.` })
          })
      }
      router.get('/tracks', allTracksHandler.bind(this))
      router.get('/tracks/*', allTracksHandler.bind(this))
      router.get('/self/track', allTracksHandler.bind(this))

      return router
    },

    id: 'tracks',
    name: 'Tracks',
    description: 'Accumulate tracks in memory for the track API implementation',
    schema: {
      type: 'object',
      properties: {
        resolution: {
          type: 'integer',
          title: 'Track resolution (milliseconds)',
          default: DEFAULT_RESOLUTION,
        },
        pointsToKeep: {
          type: 'integer',
          title: 'Points to keep',
          description: 'How many trackpoints to keep for each track',
          default: DEFAULT_POINTS_TO_KEEP,
        },
        maxAge: {
          type: 'integer',
          title: 'Maximum idle time (seconds)',
          description: 'Tracks with no updates longer than this are removed',
          default: DEFAULT_MAX_AGE,
        },
        maxRadius: {
          type: 'integer',
          title: 'Maximum Radius (meters) ',
          description: 'Include only vessels with position within this range. 0= all vessels',
          default: DEFAULT_MAX_RADIUS,
        },
        useDb: {
          type: 'boolean',
          title: 'Use database',
          description: 'Store self track permanently in database (Points to keep, max age and max radius are ignored)',
          default: false,
        },
      },
    },
  }
}

export class Tracks extends Tracks_ { }
export class TrackAccumulator extends TrackAccumulator_ { }
