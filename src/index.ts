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

import type { Request, RequestHandler, Response, Router } from 'express'
import { Tracks as Tracks_ } from './tracks.js'
import type { Context, Debug, LatLngTuple, LngLatTuple, Position, TrackCollection } from './types.js'
import { resolveContext, validateParameters } from './utils.js'

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
interface HistoryValuesQuery {
  context: string
  from: string
  to: string
  pathSpecs: { path: string; aggregate: string }[]
  resolution: number
}

interface HistoryApi {
  getValues(query: HistoryValuesQuery): Promise<HistoryValuesResponse>
}

interface HistoryValuesResponse {
  context: string
  range: { from: string; to: string }
  values: unknown[]
  /** Each element: [timestamp_string, [lon, lat]] */
  data: unknown[]
}

interface App {
  debug: Debug
  error: (...args: unknown[]) => void
  streambundle: {
    getBus: (path: string) => {
      onValue: (cb: (x: ContextPosition) => void) => () => void
    }
  }
  getSelfPath: (path: string) => unknown
  selfContext: string
  getHistoryApi?: () => Promise<HistoryApi>
}

interface Plugin {
  start: (c: TracksPluginConfig) => void
  stop: () => void
  signalKApiRoutes: (r: Router) => Router
  id: string
  name: string
  description: string
  schema: Record<string, unknown>
}

interface TracksPluginConfig {
  resolution?: number
  pointsToKeep?: number
  maxAge?: number
  maxRadius?: number
  bootstrapFromHistory?: boolean
}

const toLngLat = ([lat, lng]: LatLngTuple): LngLatTuple => [lng, lat]

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

/**
 * Config values arrive from the plugin UI as numbers, but a hand-edited
 * settings file can supply strings. Accept both, reject anything non-finite so
 * a bad value falls back to the default instead of poisoning arithmetic with NaN.
 */
const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const notAvailable = (res: Response) => {
  res.status(404)
  res.json({ message: 'Tracks API not available because tracks plugin is not enabled' })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const errorDetail = (err: unknown): string => (err instanceof Error && err.stack ? err.stack : String(err))

const isNoProviderError = (err: unknown): boolean => {
  const text = String(err)
  return text.includes('No history') && text.includes('provider')
}

/** History API rows are [timestamp, [lon, lat]]; keep only well-formed ones. */
const isHistoryPositionRow = (row: unknown): row is [string, [number, number]] =>
  Array.isArray(row) &&
  row.length >= 2 &&
  Array.isArray(row[1]) &&
  row[1].length === 2 &&
  typeof row[1][0] === 'number' &&
  typeof row[1][1] === 'number'

async function bootstrapSelfTrack(app: App, tracks: Tracks_, config: TracksPluginConfig): Promise<void> {
  const { debug } = app
  const getHistoryApi = app.getHistoryApi

  if (!getHistoryApi) {
    debug('getHistoryApi not available on server, skipping track bootstrap')
    return
  }

  if (!app.selfContext) {
    debug('selfContext not available, skipping track bootstrap')
    return
  }

  const resolution = toNumber(config.resolution) ?? DEFAULT_RESOLUTION
  const pointsToKeep = toNumber(config.pointsToKeep) ?? DEFAULT_POINTS_TO_KEEP
  const timespanMs = resolution * pointsToKeep
  const resolutionSecs = Math.max(1, Math.round(resolution / 1000))
  const timespanMinutes = Math.round(timespanMs / 1000 / 60)

  debug(
    `Track bootstrap: requesting ${timespanMinutes} minutes of history at ${resolutionSecs}s resolution ` +
      `(max ${BOOTSTRAP_MAX_ATTEMPTS} attempts)`,
  )

  let noProviderCount = 0

  for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
    const delay = attempt === 1 ? BOOTSTRAP_INITIAL_DELAY : BOOTSTRAP_RETRY_DELAY
    debug(`Track bootstrap attempt ${attempt}/${BOOTSTRAP_MAX_ATTEMPTS}, waiting ${delay / 1000}s...`)
    await sleep(delay)

    try {
      const historyApi = await getHistoryApi()
      noProviderCount = 0 // provider resolved — reset counter

      const to = new Date()
      const from = new Date(to.getTime() - timespanMs)

      const response = await historyApi.getValues({
        context: app.selfContext,
        from: from.toISOString(),
        to: to.toISOString(),
        pathSpecs: [{ path: 'navigation.position', aggregate: 'first' }],
        resolution: resolutionSecs,
      })

      if (response?.data && response.data.length > 0) {
        // History API returns [timestamp, [lon, lat]]; flip to [lat, lng] for LatLngTuple.
        const positions: LatLngTuple[] = response.data
          .filter(isHistoryPositionRow)
          .map(([, [lon, lat]]): LatLngTuple => [lat, lon])

        if (positions.length > 0) {
          tracks.initialTrack(app.selfContext, positions)
          debug(
            `Track bootstrap complete: loaded ${positions.length} positions for self ` +
              `(${timespanMinutes} min window) on attempt ${attempt}`,
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
          `Track bootstrap attempt ${attempt}/${BOOTSTRAP_MAX_ATTEMPTS}: no history provider registered yet ` +
            `(${noProviderCount}/${BOOTSTRAP_MAX_NO_PROVIDER})`,
        )
        if (noProviderCount >= BOOTSTRAP_MAX_NO_PROVIDER) {
          debug(
            `No history provider registered after ${BOOTSTRAP_MAX_NO_PROVIDER} consecutive checks — ` +
              'no provider plugin appears to be installed. Giving up.',
          )
          return
        }
      } else {
        noProviderCount = 0 // different error — provider exists but not ready
        debug(`Track bootstrap attempt ${attempt}/${BOOTSTRAP_MAX_ATTEMPTS} failed: ${errorDetail(err)}`)
      }

      if (attempt === BOOTSTRAP_MAX_ATTEMPTS) {
        app.error(
          `Track bootstrap from History API failed after ${BOOTSTRAP_MAX_ATTEMPTS} attempts. ` +
            'Tracks will start empty and accumulate from live data.',
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
    const p = app.getSelfPath('navigation.position')
    if (p && typeof p === 'object' && 'value' in p) {
      const { value } = p as { value?: Partial<Position> }
      if (typeof value?.latitude === 'number' && typeof value.longitude === 'number') {
        return [value.latitude, value.longitude]
      }
    }
    return undefined
  }

  return {
    start: function (config: TracksPluginConfig) {
      const { resolution, pointsToKeep, maxAge, maxRadius } = config
      defaultMaxRadius = toNumber(maxRadius)
      tracks = new Tracks_(
        {
          resolution: toNumber(resolution) ?? DEFAULT_RESOLUTION,
          pointsToKeep: toNumber(pointsToKeep) ?? DEFAULT_POINTS_TO_KEEP,
        },
        app.debug,
      )
      onStop.push(
        app.streambundle.getBus('navigation.position').onValue((update: ContextPosition): void => {
          if (!update.value || update.value.latitude == null || update.value.longitude == null) return
          tracks?.newPosition(update.context, [update.value.latitude, update.value.longitude])
        }),
      )
      const theMaxAge = toNumber(maxAge) ?? DEFAULT_MAX_AGE

      const pruneInterval = setInterval(() => tracks?.prune(theMaxAge * 1000), (theMaxAge * 1000) / 2)
      onStop.push(() => {
        clearInterval(pruneInterval)
      })

      // Bootstrap self track from History API (async, non-blocking)
      if (config.bootstrapFromHistory !== false) {
        bootstrapSelfTrack(app, tracks, config).catch((err: unknown) => {
          app.error(`Unexpected error in track bootstrap: ${errorDetail(err)}`)
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
        const context = resolveContext(String(req.params.vesselId), app.selfContext)
        tracks
          .get(context)
          .then((coordinates: LatLngTuple[]) => {
            res.json({
              type: 'MultiLineString',
              coordinates: [coordinates.map(toLngLat)],
            })
          })
          .catch(() => {
            res.status(404)
            res.json({ message: `No track available for ${context}` })
          })
      }
      router.get('/vessels/:vesselId/track', trackHandler)

      // return all / filtered vessel tracks
      const allTracksHandler: RequestHandler = (req: Request, res: Response) => {
        app.debug(req.query)
        if (!tracks) {
          notAvailable(res)
          return
        }
        tracks
          .getFilteredTracks(validateParameters(req.query, defaultMaxRadius), getVesselPosition(), app.debug)
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
      router.get('/tracks', allTracksHandler)
      // Express 4 path syntax: the Signal K server mounts plugin routers on
      // express 4, where a bare `*` is the wildcard (express 5 renamed it).
      router.get('/tracks/*', allTracksHandler)

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

export { Tracks, TrackAccumulator } from './tracks.js'
export type { TracksConfig } from './tracks.js'
export type * from './types.js'
