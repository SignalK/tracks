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
import { Tracks as Tracks_, TrackAccumulator as TrackAccumulator_, TracksConfig } from './tracks'
import { Context, Debug, LatLngTuple, LngLatTuple, Position, TrackCollection } from './types'
import { validateParameters } from './utils'
import * as openApi from './openApi.json'

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

// Minimal History API types (from @signalk/server-api)
// Defined locally to avoid a hard dependency on a specific server-api version
interface HistoryApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getValues(query: any): Promise<HistoryValuesResponse>
}

interface HistoryValuesResponse {
  context: string
  range: { from: string; to: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: any[]
  // Each element: [timestamp_string, [lon, lat]]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[]
}

interface App {
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
  }
  getSelfPath: (path: string) => void
  selfContext: string
  getHistoryApi?: () => Promise<HistoryApi>
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
  schema: any,
  openApiPaths: () => object
}

interface TracksPluginConfig {
  resolution?: number
  pointsToKeep?: number
  maxAge?: number
  maxRadius?: number
  bootstrapFromHistory?: boolean
}

const toLngLat = ([lat, lng]: number[]): LngLatTuple => [lng, lat]

const DEFAULT_RESOLUTION = 60000
const DEFAULT_POINTS_TO_KEEP = 60 * 2 // 2 hours with default resolution
const DEFAULT_MAX_AGE = 60 * 10 // ten minutes
const DEFAULT_MAX_RADIUS = 50 * 1000 //50 kilometers

// Bootstrap retry configuration:
// First attempt after 5s (sufficient for warm restarts where InfluxDB is already running).
// Subsequent attempts every 15s, up to 18 total (~260s window), covering cold boot scenarios
// where InfluxDB may take 2+ minutes to accept connections after systemd reports it active.
const BOOTSTRAP_INITIAL_DELAY = 5000
const BOOTSTRAP_RETRY_DELAY = 15000
const BOOTSTRAP_MAX_ATTEMPTS = 18

// If getHistoryApi() reports "no provider configured" this many times consecutively,
// assume no history provider plugin is installed and stop retrying.
const BOOTSTRAP_MAX_NO_PROVIDER = 3

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNumeric = (x: any) => x - parseInt(x) + 1 >= 0

const notAvailable = (res: Response) => {
  res.status(404)
  res.json({ message: 'Tracks API not available because tracks plugin is not enabled' })
}

const sleep = (ms: number): Promise<void> => new Promise(function (resolve) { return setTimeout(resolve, ms) })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
var errorDetail = function (err: any): string {
  return err && err.stack ? err.stack : String(err)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
var isNoProviderError = function (err: any): boolean {
  return String(err).indexOf('No history') !== -1 && String(err).indexOf('provider') !== -1
}

async function bootstrapSelfTrack(
  app: App,
  tracks: Tracks_,
  config: TracksPluginConfig,
): Promise<void> {
  var debug = app.debug

  if (!app.getHistoryApi) {
    debug('getHistoryApi not available on server, skipping track bootstrap')
    return
  }

  if (!app.selfContext) {
    debug('selfContext not available, skipping track bootstrap')
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var resolution = isNumeric(config.resolution) ? parseFloat(config.resolution as any) : DEFAULT_RESOLUTION
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var pointsToKeep = isNumeric(config.pointsToKeep) ? parseFloat(config.pointsToKeep as any) : DEFAULT_POINTS_TO_KEEP
  var timespanMs = resolution * pointsToKeep
  var resolutionSecs = Math.max(1, Math.round(resolution / 1000))

  debug(
    'Track bootstrap: requesting ' + Math.round(timespanMs / 1000 / 60) +
    ' minutes of history at ' + resolutionSecs + 's resolution' +
    ' (max ' + BOOTSTRAP_MAX_ATTEMPTS + ' attempts)',
  )

  var noProviderCount = 0

  for (var attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
    var delay = attempt === 1 ? BOOTSTRAP_INITIAL_DELAY : BOOTSTRAP_RETRY_DELAY
    debug(
      'Track bootstrap attempt ' + attempt + '/' + BOOTSTRAP_MAX_ATTEMPTS +
      ', waiting ' + (delay / 1000) + 's...',
    )
    await sleep(delay)

    try {
      var historyApi = await app.getHistoryApi!()
      noProviderCount = 0 // provider resolved — reset counter

      var to = new Date()
      var from = new Date(to.getTime() - timespanMs)

      var response: HistoryValuesResponse = await historyApi.getValues({
        context: app.selfContext,
        from: from.toISOString(),
        to: to.toISOString(),
        pathSpecs: [{ path: 'navigation.position', aggregate: 'first' }],
        resolution: resolutionSecs,
      })

      if (response && response.data && response.data.length > 0) {
        // History API returns [timestamp, [lon, lat]]
        // Convert to [lat, lng] for LatLngTuple
        var positions: LatLngTuple[] = response.data
          .filter(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            function (d: any) {
              return (
                Array.isArray(d) &&
                d.length >= 2 &&
                Array.isArray(d[1]) &&
                d[1].length === 2 &&
                typeof d[1][0] === 'number' &&
                typeof d[1][1] === 'number'
              )
            },
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map(function (d: any) { return [d[1][1], d[1][0]] as LatLngTuple })

        if (positions.length > 0) {
          tracks.initialTrack(app.selfContext, positions)
          debug(
            'Track bootstrap complete: loaded ' + positions.length +
            ' positions for self (' + Math.round(timespanMs / 1000 / 60) +
            ' min window) on attempt ' + attempt,
          )
          return
        }
      }

      debug('History API returned no position data for bootstrap')
      return // API responded successfully but no data — do not retry
    } catch (err) {
      if (isNoProviderError(err)) {
        noProviderCount++
        debug(
          'Track bootstrap attempt ' + attempt + '/' + BOOTSTRAP_MAX_ATTEMPTS +
          ': no history provider registered yet (' + noProviderCount + '/' + BOOTSTRAP_MAX_NO_PROVIDER + ')',
        )
        if (noProviderCount >= BOOTSTRAP_MAX_NO_PROVIDER) {
          debug(
            'No history provider registered after ' + BOOTSTRAP_MAX_NO_PROVIDER +
            ' consecutive checks — no provider plugin appears to be installed. Giving up.',
          )
          return
        }
      } else {
        noProviderCount = 0 // different error — provider exists but not ready
        debug(
          'Track bootstrap attempt ' + attempt + '/' + BOOTSTRAP_MAX_ATTEMPTS +
          ' failed: ' + errorDetail(err),
        )
      }

      if (attempt === BOOTSTRAP_MAX_ATTEMPTS) {
        app.error(
          'Track bootstrap from History API failed after ' + BOOTSTRAP_MAX_ATTEMPTS +
          ' attempts. Tracks will start empty and accumulate from live data.',
        )
      }
    }
  }
}

export default function ThePlugin(app: App): Plugin {
  let onStop: (() => void)[] = []
  let tracks: Tracks_ | undefined = undefined
  let defaultMaxRadius: number | undefined = undefined

  function getVesselPosition(): LatLngTuple | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = app.getSelfPath('navigation.position')
    return p && p.value ? [p.value.latitude, p.value.longitude] : undefined
  }

  return {
    start: function (config: TracksPluginConfig) {
      const { resolution, pointsToKeep, maxAge, maxRadius } = config
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defaultMaxRadius = maxRadius ? parseFloat(maxRadius as any) : undefined
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const theMaxAge = isNumeric(maxAge) ? parseFloat(maxAge as any) : DEFAULT_MAX_AGE

      const pruneInterval = setInterval(tracks.prune.bind(tracks, theMaxAge * 1000), (theMaxAge * 1000) / 2)
      onStop.push(() => {
        clearInterval(pruneInterval)
      })

      // Bootstrap self track from History API (async, non-blocking)
      if (config.bootstrapFromHistory !== false) {
        bootstrapSelfTrack(app, tracks, config).catch(function (err) {
          app.error('Unexpected error in track bootstrap: ' + err)
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
        if (!tracks) {
          notAvailable(res)
          return
        }
        tracks
          ?.get(`vessels.${req.params.vesselId}`)
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
        if (!tracks) {
          notAvailable(res)
          return
        }
        tracks
          ?.getFilteredTracks(validateParameters(req.query, defaultMaxRadius), getVesselPosition(), app.debug)
          .then((tc: TrackCollection) => {
            const trks = Object.entries(tc).reduce<AllTracksResult>((acc, [context, track]) => {
              acc[context] = {
                type: 'MultiLineString',
                coordinates: [track.map(toLngLat)],
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

      return router
    },

    openApiPaths: () => openApi.paths,


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
        bootstrapFromHistory: {
          type: 'boolean',
          title: 'Load historical tracks on startup',
          description:
            'On startup, load historical position data from the History API (requires a history provider such as signalk-to-influxdb2). Tracks will be available immediately after restart instead of starting empty.',
          default: true,
        },
      },
    },
  }
}

export class Tracks extends Tracks_ {}
export class TrackAccumulator extends TrackAccumulator_ {}
