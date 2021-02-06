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
import Tracks from './tracks'
import { Config, Context, Position, VesselCollection, QueryParameters } from './types'
import { validateParameters} from './utils'

export interface ContextPosition {
  context: Context
  value: Position
}

interface VesselTrack {
  type: string,
  coordinates: Array<Array<[number,number]>>
}


interface App {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any) => void
  streambundle: {
    getBus: (
      path: string,
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onValue: (cb: (x: any) => void) => () => void
    }
  }
  getSelfPath: (path: string) => void
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

export default function (app: App): Plugin {
  let onStop: (() => void)[] = []
  let tracks: Tracks | undefined = undefined

  function getVesselPosition():Position {
    let p:any= app.getSelfPath('navigation.position');
    return (p && p.value) ? p.value : null;
  }

  return {
    start: function (configuration: Config) {
      tracks = new Tracks(configuration, app.debug)
      onStop.push(
        app.streambundle
          .getBus('navigation.position')
          .onValue((update: ContextPosition): void => tracks?.newPosition(update.context, update.value)),
      )
      const pruneInterval = setInterval(tracks.prune.bind(tracks, 5 * 60 * 1000), 60 * 1000)
      onStop.push(() => {
        clearInterval(pruneInterval)
      })
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
        tracks
          ?.get(`vessels.${req.params.vesselId}`)
          .then((d: Position[]) => {
            res.json({
              type: 'MultiLineString',
              coordinates: [d.map((p: Position) => [p.longitude, p.latitude])],
            })
          })
          .catch(() => {
            res.status(404)
            res.json({ message: `No track available for vessels.${req.params.vesselId}` })
          })
      }
      router.get('/vessels/:vesselId/track', trackHandler.bind(this))

      // return all vessels and their track
      router.get('/tracks/*', (req: Request, res: Response)=> {
        let params: QueryParameters= validateParameters(req.query)
        app.debug('** params **', params)
        tracks
          ?.getAll(params, getVesselPosition())
          .then((d: VesselCollection) => {
            let trks:{[key: string] : VesselTrack}= {}
            Object.entries(d).forEach( (i:[Context, Position[]])=> {
              trks[i[0]]= {
                type: 'MultiLineString',
                coordinates: [i[1].map((p: Position) => [p.longitude, p.latitude])]
              }
            })
            res.json(trks)
          })
          .catch(() => {
            res.status(404)
            res.json({ message: `No track available for vessels.`})
          })
        }).bind(this)

      return router
    },

    id: 'tracks',
    name: 'Tracks',
    description: 'Accumulate tracks in memory for the track API implementation',
    schema: {
      type: 'object',
      properties: {
        resolution: {
          type: 'number',
          title: 'Track resolution (milliseconds)',
          default: 60000,
        },
        pointsToKeep: {
          type: 'number',
          title: 'Points to keep',
          description: 'How many trackpoints to keep for each track',
          default: 60,
        },
        maxAge: {
          type: 'number',
          title: 'Maximum idle time (seconds)',
          description: 'Tracks with no updates longer than this are removed',
          default: 600,
        },
      },
    }
  }
}
