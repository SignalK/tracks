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

import { Temporal } from '@js-temporal/polyfill'
import type { Request, RequestHandler, Response, Router } from 'express'
import { join } from 'node:path'
import { Tracks as Tracks_ } from './tracks.js'
import { SqliteTrackStore } from './sqliteStore.js'
import type { TrackStore } from './store.js'
import { SourceWatch } from './sourceWatch.js'
import { parseTrackQuery, segment, thin, TimeWindowError } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import type { Context, Debug, LatLngTuple, LngLatTuple, Position, TrackCollection } from './types.js'
import { resolveContext, toIsoTimes, validateParameters } from './utils.js'

export interface ContextPosition {
  context: Context
  value: Position
  /** ISO-8601 time the value was recorded, as carried by the Signal K delta. */
  timestamp?: string
  /**
   * Which source produced the value. The bus carries every source's values,
   * not just the one source priority selects, so this is how a multi-receiver
   * setup is detected.
   */
  $source?: string
}

interface AllTracksResult {
  [context: string]: {
    type: 'MultiLineString'
    coordinates: LngLatTuple[][]
    /**
     * Whether this is the own vessel's track.
     *
     * Stated rather than left to the client: telling own vessel from an AIS
     * target otherwise means string-matching the context against the server's
     * self identity, which a client can only do if it has fetched that
     * separately and knows the `vessels.self` alias resolves to a `urn:mrn:`
     * context. Getting it wrong draws someone else's track as your own.
     */
    isSelf: boolean
  }
}

// Minimal History API types (from @signalk/server-api)
// Defined locally to avoid a hard dependency on a specific server-api version
interface HistoryValuesQuery {
  context: string
  from: Temporal.Instant
  to: Temporal.Instant
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
  /** Shown against the plugin in the server's dashboard. Absent on older servers. */
  setPluginStatus?: (msg: string) => void
  /** Plugin-private directory for persistent data; absent on older servers. */
  getDataDirPath?: () => string
  /** Resolves the named provider, or the configured default when omitted. */
  getHistoryApi?: (providerId?: string) => Promise<HistoryApi>
  config?: {
    settings?: {
      historyApi?: { defaultProvider?: string }
    }
  }
}

interface Plugin {
  start: (c: TracksPluginConfig) => void
  stop: () => void
  signalKApiRoutes: (r: Router) => Router
  id: string
  name: string
  description: string
  schema: Record<string, unknown>
  /**
   * The live accumulator, or undefined before `start()`.
   *
   * Exposed so a track can be installed or inspected without going through the
   * position bus, which throttles against the wall clock. The Signal K server
   * does not use this.
   */
  getTracks: () => TrackStore | undefined
}

/**
 * Where tracks come from when the server starts.
 *
 * - `memory`: start empty, accumulate from the position bus only.
 * - `history`: refill from a History provider at startup, then accumulate.
 * - `sqlite`: persist to disk, so a restart resumes from what was recorded.
 *
 * One setting rather than a boolean per source: they are alternatives, and as
 * independent booleans a user could enable two and have the same positions
 * loaded twice.
 */
export type TrackSource = 'memory' | 'history' | 'sqlite'

interface TracksPluginConfig {
  resolution?: number
  pointsToKeep?: number
  maxAge?: number
  maxRadius?: number
  source?: TrackSource
  /** @deprecated superseded by `source`; still honoured for existing configs. */
  bootstrapFromHistory?: boolean
  /** Days of history to keep when `source` is `sqlite`. 0 keeps everything. */
  retentionDays?: number
  /** Minutes without a fix that start a new track segment. 0 disables. */
  segmentGapMinutes?: number
}

/**
 * Resolve the effective source, honouring the setting this replaced.
 *
 * `bootstrapFromHistory` shipped as a boolean defaulting to true, so an
 * installed plugin has it saved in its config either way. Reading `source`
 * first and only then falling back keeps those installs working: an explicit
 * `false` still means "do not touch the History API", and everything else
 * lands on the old default of `history`.
 */
export const resolveSource = (config: TracksPluginConfig): TrackSource => {
  if (config.source) {
    return config.source
  }
  return config.bootstrapFromHistory === false ? 'memory' : 'history'
}

const toLngLat = ([lat, lng]: LatLngTuple): LngLatTuple => [lng, lat]

const DEFAULT_RESOLUTION = 60000
const DEFAULT_POINTS_TO_KEEP = 60 * 2 // 2 hours with default resolution
const DEFAULT_MAX_AGE = 60 * 10 // ten minutes
const DEFAULT_MAX_RADIUS = 50 * 1000 //50 kilometers
// Off by default. Segmenting changes the shape of every response, and measured
// against real AIS traffic a 5-minute rule split 61 of 879 gaps that were just
// a slow-updating target rather than a stop. Opt in, and pick a threshold that
// suits the fleet being watched.
const DEFAULT_SEGMENT_GAP_MINUTES = 0

// Bootstrap retry configuration:
// First attempt after 5s (sufficient for warm restarts where InfluxDB is already running).
// Subsequent attempts every 15s, up to 18 total (~260s window), covering cold boot scenarios
// where InfluxDB may take 2+ minutes to accept connections after systemd reports it active.
// Long enough that a boat with one GPS never pays for the check in practice,
// short enough that the warning appears while the user is still looking at the
// plugin page after enabling it.
const SOURCE_STATUS_INTERVAL_MS = 30000

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

/**
 * A history row is `[timestamp, position]`. Providers disagree on how the
 * position is encoded: signalk-questdb returns `{latitude, longitude}`, while
 * a `[lon, lat]` pair is the shape the History API's own docs describe. Accept
 * both — rejecting either silently bootstraps an empty track.
 */
const historyRowPosition = (row: unknown): LatLngTuple | undefined => {
  if (!Array.isArray(row) || row.length < 2) {
    return undefined
  }
  const value: unknown = row[1]
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    // [lon, lat] -> [lat, lng]
    return [value[1], value[0]]
  }
  if (value && typeof value === 'object' && 'latitude' in value && 'longitude' in value) {
    const { latitude, longitude } = value as Partial<Position>
    if (typeof latitude === 'number' && typeof longitude === 'number') {
      return [latitude, longitude]
    }
  }
  return undefined
}

/** Epoch milliseconds for a history row, or 0 when the timestamp is unusable. */
const historyRowTimestamp = (row: unknown): number => {
  const raw: unknown = Array.isArray(row) ? row[0] : undefined
  if (typeof raw !== 'string') {
    return 0
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? 0 : parsed
}

async function bootstrapSelfTrack(app: App, tracks: TrackStore, config: TracksPluginConfig): Promise<void> {
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

  const configuredProvider = app.config?.settings?.historyApi?.defaultProvider

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
      // Ask for the configured provider by name. Without this the server hands
      // back whichever provider registered first until the configured one is
      // up, and an early bootstrap gets answered by a plugin that has no
      // positions — indistinguishable from "no history exists". Naming it makes
      // the not-yet-registered case a rejection, which the retry loop handles.
      const historyApi = await getHistoryApi(configuredProvider)
      noProviderCount = 0 // provider resolved — reset counter

      const to = new Date()
      const from = new Date(to.getTime() - timespanMs)

      // The History API hands providers Temporal.Instant values, not strings —
      // see parseTimeRangeParams in signalk-server. Providers call Instant
      // methods on them (signalk-questdb does `from.add(duration)`), so passing
      // ISO strings here yields a query that silently returns the wrong range.
      const response = await historyApi.getValues({
        context: app.selfContext,
        from: Temporal.Instant.from(from.toISOString()),
        to: Temporal.Instant.from(to.toISOString()),
        pathSpecs: [{ path: 'navigation.position', aggregate: 'first' }],
        resolution: resolutionSecs,
      })

      if (response?.data && response.data.length > 0) {
        const positions: LatLngTuple[] = []
        // Carry the recorded times through so bootstrapped points answer
        // time-window queries rather than looking infinitely old.
        const timestamps: number[] = []
        for (const row of response.data) {
          const position = historyRowPosition(row)
          if (position) {
            positions.push(position)
            timestamps.push(historyRowTimestamp(row))
          }
        }

        if (positions.length > 0) {
          tracks.initialTrack(app.selfContext, positions, timestamps)
          debug(
            `Track bootstrap complete: loaded ${positions.length} positions for self ` +
              `(${timespanMinutes} min window) on attempt ${attempt}`,
          )
          return
        }
      }

      // An empty response is not proof there is no history. The server's
      // default history provider falls back to whichever plugin registered
      // first until the configured one is up, so an early bootstrap can be
      // answered by the wrong provider — one that legitimately has no
      // positions. Retrying costs a few seconds and is the difference between
      // a restored track and an empty one.
      debug(
        `History API returned no position data on attempt ${attempt}/${BOOTSTRAP_MAX_ATTEMPTS}; ` +
          'the configured provider may not have registered yet',
      )
      if (attempt === BOOTSTRAP_MAX_ATTEMPTS) {
        debug('History API returned no position data for bootstrap')
        return
      }
      continue
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
  let tracks: TrackStore | undefined = undefined
  let segmentGap = 0
  let defaultMaxRadius: number | undefined = undefined
  const sourceWatch = new SourceWatch()

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
      const source = resolveSource(config)
      const segmentGapMinutes = toNumber(config.segmentGapMinutes) ?? DEFAULT_SEGMENT_GAP_MINUTES
      segmentGap = segmentGapMinutes > 0 ? segmentGapMinutes * 60 * 1000 : 0

      // getDataDirPath is what makes the file the server's to manage (backed up
      // and removed with the plugin). Without it there is nowhere safe to
      // write, so fall back to memory rather than guessing at a path.
      const dataDir = source === 'sqlite' ? app.getDataDirPath?.() : undefined
      if (source === 'sqlite' && !dataDir) {
        app.error('source is sqlite but this server provides no plugin data directory; using memory instead')
      }

      // Always a fresh store, as before this setting existed: a restart must
      // not keep an accumulator built with a resolution the user has since
      // changed, and for sqlite the previous handle has been closed by stop().
      tracks = dataDir
        ? new SqliteTrackStore(
            {
              file: join(dataDir, 'tracks.db'),
              resolution: toNumber(resolution) ?? DEFAULT_RESOLUTION,
              retention: (toNumber(config.retentionDays) ?? 0) * 24 * 60 * 60 * 1000,
              segmentGap,
            },
            app.debug,
          )
        : new Tracks_(
            {
              resolution: toNumber(resolution) ?? DEFAULT_RESOLUTION,
              pointsToKeep: toNumber(pointsToKeep) ?? DEFAULT_POINTS_TO_KEEP,
            },
            app.debug,
          )
      onStop.push(
        app.streambundle.getBus('navigation.position').onValue((update: ContextPosition): void => {
          if (!update.value || update.value.latitude == null || update.value.longitude == null) return
          sourceWatch.add(update.context, update.$source)
          // Prefer the delta's own timestamp so a replayed or delayed update is
          // filed at the time it was recorded, not the time it arrived.
          const recorded = update.timestamp === undefined ? undefined : Date.parse(update.timestamp)
          tracks?.newPosition(
            update.context,
            [update.value.latitude, update.value.longitude],
            recorded !== undefined && !Number.isNaN(recorded) ? recorded : undefined,
          )
        }),
      )
      const theMaxAge = toNumber(maxAge) ?? DEFAULT_MAX_AGE

      const pruneInterval = setInterval(() => tracks?.prune(theMaxAge * 1000), (theMaxAge * 1000) / 2)
      onStop.push(() => {
        clearInterval(pruneInterval)
      })

      // Report on a timer rather than per delta: at 10Hz across several
      // vessels that would rewrite the status thousands of times a minute, and
      // the first fix from a second source is not yet evidence of a problem —
      // a source that appears once and stops is not worth a warning.
      const statusInterval = setInterval(() => {
        const warning = sourceWatch.warning(app.selfContext)
        if (warning) {
          app.setPluginStatus?.(warning)
        }
      }, SOURCE_STATUS_INTERVAL_MS)
      onStop.push(() => {
        clearInterval(statusInterval)
      })

      // Bootstrap self track from History API (async, non-blocking).
      // Only for `history`: a sqlite store already holds what it recorded, and
      // refilling it from a provider would duplicate those positions.
      if (source === 'history') {
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
      // Forget which sources were seen: the point of a restart is often to
      // apply a source priority change, and carrying the old observations over
      // would keep warning about a setup that has just been fixed.
      sourceWatch.clear()
      // Release the file handle a sqlite store holds, so a plugin restart does
      // not leak it and the WAL gets checkpointed.
      //
      // The store itself stays in place: stop() leaves the routes mounted and
      // keeps serving what was already accumulated, which routes.test.ts pins.
      // Only a store that needs closing is affected, and it is replaced
      // wholesale on the next start().
      try {
        tracks?.close?.()
      } catch (err) {
        app.error(err)
      }
    },

    signalKApiRoutes: function (router: Router) {
      const singleTrackHandler =
        (contextOf: (req: Request) => string): RequestHandler =>
        (req: Request, res: Response) => {
          if (!tracks) {
            notAvailable(res)
            return
          }
          const context = contextOf(req)
          let query: TrackQuery
          try {
            query = parseTrackQuery(req.query)
          } catch (err) {
            res.status(400)
            res.json({ message: err instanceof TimeWindowError ? err.message : 'Invalid query parameters' })
            return
          }
          tracks
            .getTimed(context, query.window)
            .then((points) => {
              const segments = segment(thin(points, query.resolution), segmentGap)
              res.json({
                type: 'MultiLineString',
                coordinates: segments.map((points) => points.map(({ position }) => toLngLat(position))),
                ...(query.times ? { times: segments.map(toIsoTimes) } : {}),
                context,
                isSelf: context === app.selfContext,
              })
            })
            .catch(() => {
              res.status(404)
              res.json({ message: `No track available for ${context}` })
            })
        }

      const trackHandler = singleTrackHandler((req) => resolveContext(String(req.params.vesselId), app.selfContext))
      router.get('/vessels/:vesselId/track', trackHandler)

      // Freeboard-SK requests the own vessel's trail here rather than at
      // /vessels/self/track. Plugin routes are mounted before the v1 REST
      // interface, so this takes precedence over the data-tree walker.
      router.get(
        '/self/track',
        singleTrackHandler(() => app.selfContext),
      )

      // return all / filtered vessel tracks
      const allTracksHandler: RequestHandler = (req: Request, res: Response) => {
        app.debug(req.query)
        if (!tracks) {
          notAvailable(res)
          return
        }
        let query: TrackQuery
        try {
          query = parseTrackQuery(req.query)
        } catch (err) {
          res.status(400)
          res.json({ message: err instanceof TimeWindowError ? err.message : 'Invalid query parameters' })
          return
        }
        tracks
          .getFilteredTracks(validateParameters(req.query, defaultMaxRadius), getVesselPosition(), app.debug, query)
          .then((tc: TrackCollection) => {
            const trks = Object.entries(tc).reduce<AllTracksResult>((acc, [context, track]) => {
              acc[context] = {
                type: 'MultiLineString',
                coordinates: [track.map(toLngLat)],
                isSelf: context === app.selfContext,
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

    getTracks: () => tracks,

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
        source: {
          type: 'string',
          title: 'Where tracks come from after a restart',
          description:
            'In memory only: start empty and accumulate from live positions. History API: refill on startup from a history provider such as signalk-to-influxdb2 or signalk-questdb. SQLite: record positions to a database file so they survive a restart with no other plugin required.',
          enum: ['memory', 'history', 'sqlite'],
          enumNames: ['In memory only', 'Load from the History API on startup', 'Record to a SQLite database'],
          default: 'history',
        },
        retentionDays: {
          type: 'integer',
          title: 'Days of track history to keep (SQLite only)',
          description: 'Positions older than this are deleted. 0 keeps everything.',
          default: 0,
        },
        segmentGapMinutes: {
          type: 'integer',
          title: 'Split a track after this many minutes without a fix',
          description:
            'A gap longer than this starts a new track segment, so a stop overnight or a spell out of AIS range does not draw a straight line across it. 0 (the default) returns the track as a single line, as before. Note that slow-updating AIS targets can legitimately go many minutes between fixes, so a low value will fragment their tracks.',
          default: DEFAULT_SEGMENT_GAP_MINUTES,
        },
      },
    },
  }
}

export { Tracks, TrackAccumulator } from './tracks.js'
export type { TracksConfig } from './tracks.js'
export type { TrackStore } from './store.js'
export type * from './types.js'
