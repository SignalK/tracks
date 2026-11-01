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
import { lstatSync, realpathSync, rmSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createTrackProvider } from './trackProvider.js'
import type { TrackProvider } from './trackProvider.js'
import { recordedId } from './recycleBin.js'
import type { TrackApi } from './trackApi.js'
import { AsyncTrackStore } from './asyncTrackStore.js'
import type { TrackStore } from './store.js'
import { DEFAULT_MAX_SPEED_KNOTS, GlitchFilter } from './glitchFilter.js'
import { importStatus, runHistoryImport } from './historyImport.js'
import { SourceWatch } from './sourceWatch.js'
import { DEFAULT_PAUSE_STATES, PAUSABLE_STATES, StateGate } from './stateGate.js'
import { fromGpx, GpxTrackWriter, toGpx } from './gpx.js'
import { fromGpxTrack, isImportedId } from './importedTracks.js'
import { readSlice, readText, UploadTooLargeError, UploadTypeError } from './upload.js'
import {
  GpxUpload,
  MAX_SLICE_BYTES,
  newUpload,
  parseUploadStart,
  UploadConflictError,
  UploadFormatError,
} from './gpxUpload.js'
import type { SliceReservation } from './gpxUpload.js'
import { timedTracksJson } from './timedTracksJson.js'
import { DEFAULT_WINDOW_MS, parseTrackQuery, TimeWindowError, TrackStream } from './timeWindow.js'
import type { StreamedPoint, TrackQuery } from './timeWindow.js'
import type {
  BinEntry,
  Context,
  Debug,
  DeletedSpan,
  GpxUploadState,
  HistoryImportState,
  LatLngTuple,
  LngLatTuple,
  Position,
  StoredImport,
  TimedPosition,
  TimedTrackCollection,
  TimeExtent,
  TrackCollection,
  TrackParams,
} from './types.js'
import {
  historyRowPosition,
  resolveContext,
  toIsoTimes,
  validateParameters,
  trackLabel,
  contextName,
  gpxFilename,
  asciiFilename,
  rfc8187,
  unwrapString,
  QueryParameterError,
  SelfPositionUnavailableError,
  unknownAs,
  withPoints,
} from './utils.js'

export interface ContextPosition {
  context: Context
  value: Position
  /** ISO-8601 time the value was recorded, as carried by the Signal K delta. */
  timestamp?: string
  /**
   * Which source produced the value.
   *
   * The bus is priority-filtered, so normally this is the one source the
   * server selected. Seeing several for one context means no priority rule is
   * matching the path — which is what `SourceWatch` reports on.
   */
  $source?: string
}

interface AllTracksResult {
  [context: string]: {
    type: 'MultiLineString'
    coordinates: LngLatTuple[][]
    /** Present only when `?times` was asked for; aligned with `coordinates`. */
    times?: string[][]
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
    /**
     * A human label for the track, as a chart plotter would show it.
     *
     * `Own Ship` or `AIS <shipname>`, falling back to the MMSI. A client
     * listing tracks otherwise has to render a `urn:mrn:` context, and no
     * user recognises their own boat that way.
     */
    name: string
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
  /**
   * Read any path in the full data model, including other vessels'.
   *
   * `getSelfPath` only reaches the own vessel, so naming an AIS track needs
   * this. Optional: absent on older servers, where tracks fall back to the
   * MMSI parsed out of the context.
   */
  getPath?: (path: string) => unknown
  selfContext: string
  /** Shown against the plugin in the server's dashboard. Absent on older servers. */
  setPluginStatus?: (msg: string) => void
  /** Plugin-private directory for persistent data; absent on older servers. */
  getDataDirPath?: () => string
  /** Resolves the named provider, or the configured default when omitted. */
  getHistoryApi?: (providerId?: string) => Promise<HistoryApi>
  /**
   * Offer this plugin's tracks to the v2 Track API. Absent on servers older
   * than SignalK/signalk-server#2995.
   *
   * The server unregisters the provider itself when the plugin stops, so
   * `stop()` here must not do it a second time.
   */
  registerTrackApiProvider?: (provider: TrackApi) => void
  config?: {
    settings?: {
      historyApi?: { defaultProvider?: string }
    }
  }
}

interface Plugin {
  start: (c: TracksPluginConfig) => void | Promise<void>
  stop: () => Promise<void>
  signalKApiRoutes: (r: Router) => Router
  registerWithRouter: (r: Router) => Router
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
 * The router the server hands `registerWithRouter`. Servers that let a plugin
 * open a route to non-admin users add `access`; on older ones it is absent and
 * every route stays admin-only.
 */
interface AccessRouter extends Router {
  access?: (level: 'readwrite' | 'readonly') => Pick<Router, 'get' | 'post' | 'put' | 'delete'>
}

/** The plugin's id, which the server also uses as its Track API provider id. */
const PLUGIN_ID = 'tracks'

interface TracksPluginConfig {
  resolution?: number
  /** Whether vessels other than the own one are recorded; they are unless false. */
  recordOtherVessels?: boolean
  /** Days another vessel's positions are kept. 0 keeps them indefinitely. */
  aisRetentionDays?: number
  /** Days a deleted track waits in the recycle bin before it is purged. */
  recycleBinDays?: number
  /** Minutes without a fix that start a new track segment. 0 disables. */
  segmentGapMinutes?: number
  /** Speed above which a position is treated as a glitch. 0 disables. */
  maxSpeedKnots?: number
  /** navigation.state values that pause recording of the own vessel. */
  pauseWhenState?: string[]
  /** Milliseconds between recorded fixes of the own vessel per navigation.state. */
  stateResolutions?: { state?: unknown; resolution?: unknown }[]
  /** Milliseconds between recorded fixes of other vessels; `resolution` when unset. */
  otherVesselsResolution?: number
  /** Metres a stored position older than a day may lie off its track and be deleted. 0 deletes none. */
  storageTolerance?: number
  /** Settings that delete what cannot be brought back, apart from the rest. */
  dangerZone?: {
    /** Days the own vessel's positions are kept. 0 keeps them indefinitely. */
    ownRetentionDays?: number
  }
}

const toLngLat = ([lat, lng]: LatLngTuple): LngLatTuple => [lng, lat]

const DEFAULT_RESOLUTION = 10000
// At anchor every second: fine enough to draw the swing around the anchor,
// which the normal resolution misses. Once a day old it is simplified with the
// rest of the track to storageTolerance, or, with that at 0, thinned back to the
// normal resolution.
const DEFAULT_STATE_RESOLUTIONS = [{ state: 'anchored', resolution: 1000 }]
// How long the positions of a vessel other than the own one are kept. The own
// vessel is never dropped — see TrackStore.prune. A week keeps a ferry's
// passages to follow and more than any chart draws of other vessels, while 30
// days of a boat's AIS took 1.25 M rows, about 280 MB.
const DEFAULT_AIS_RETENTION_DAYS = 7
// Long enough to notice a track deleted by mistake after a season ashore.
const DEFAULT_RECYCLE_BIN_DAYS = 180
// Below a GPS's own noise, so what simplifying to it deletes is where the
// receiver put the boat rather than where it went. On a boat's store it left
// 3 to 5% of a day recorded every second.
const DEFAULT_STORAGE_TOLERANCE = 0.5
const DAY_MS = 24 * 60 * 60 * 1000

// A vessel that has aged out is not urgent, so this need not be frequent.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
/**
 * How often the store refines levels. A call with nothing to do returns at
 * once, and one with a backlog holds the worker about 50 ms on a Pi 5.
 */
const REFINE_INTERVAL_MS = 10 * 1000
/**
 * The pace while a call leaves work. A day waiting for its levels, after an
 * import or a restore, is read from every position: on a Pi 5, with 30 such
 * days of a fix a second, a trail took 4 s to read rather than 76 ms. At this
 * pace they took 7 minutes, at about 5% of the worker's time, rather than an
 * hour, and a read waits behind at most one call.
 */
const REFINE_BACKLOG_INTERVAL_MS = 1000
// Off by default. Segmenting changes the shape of every response, and measured
// against real AIS traffic a 5-minute rule split 61 of 879 gaps that were just
// a slow-updating target rather than a stop. Opt in, and pick a threshold that
// suits the fleet being watched.
const DEFAULT_SEGMENT_GAP_MINUTES = 0

// Long enough that a boat with one GPS never pays for the check in practice,
// short enough that the warning appears while the user is still looking at the
// plugin page after enabling it.
const SOURCE_STATUS_INTERVAL_MS = 30000

/**
 * How long a history provider gets to say it is there, for the history import
 * and for a delete that keeps its span from it: long enough for one that has
 * to warm up, short enough that a wedged one does not hold a request open.
 */
const HISTORY_QUERY_TIMEOUT_MS = 5000

/**
 * How long one read of the history import may take. Far longer than a
 * query's: a day at a second is 86,400 buckets, and nobody waits on it but
 * the import.
 */
const IMPORT_READ_TIMEOUT_MS = 5 * 60_000

/**
 * How long after a start an unfinished history import goes on. A history
 * provider is a plugin too, and the server may start it after this one.
 */
const IMPORT_RESUME_DELAY_MS = 60_000

/**
 * A base station or an aid to navigation reports the same position for as
 * long as it is in range, so recording it would store a growing pile of
 * identical points and no track.
 */
const FIXED_STATION_PREFIXES = ['shore.', 'atons.']

function isFixedStation(context: string): boolean {
  return FIXED_STATION_PREFIXES.some((prefix) => context.startsWith(prefix))
}

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

const errorDetail = (err: unknown): string => (err instanceof Error && err.stack ? err.stack : String(err))

/**
 * The file `file` is once links are followed, or would be when nothing is
 * there, so that the two compare equal. Throws for one that cannot be
 * reached, such as a link into a disk not mounted, or past a directory the
 * server's user may not enter.
 *
 * With the system's own realpath, which follows links as SQLite's open
 * does, and spells the file as the asynchronous one does. Node's
 * `realpathSync` takes a `..` in a link's target before the links it
 * passes, and so can name another file, and on Windows it keeps the short
 * names the system's expands.
 */
const followLinks = (file: string): string => {
  try {
    return realpathSync.native(file)
  } catch (err) {
    if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) throw err
    return join(realpathSync.native(dirname(file)), basename(file))
  }
}

/**
 * {@link followLinks} off the event loop, so that a disk that stops
 * answering holds the caller rather than the server.
 */
const followLinksAsync = async (file: string): Promise<string> => {
  try {
    return await realpath(file)
  } catch (err) {
    const there = await lstat(file).then(
      () => true,
      (missing: NodeJS.ErrnoException) => {
        if (missing.code === 'ENOENT') return false
        throw missing
      },
    )
    if (there) throw err
    return join(await realpath(dirname(file)), basename(file))
  }
}

/**
 * Reject once `ms` has passed.
 *
 * Written out rather than `Promise.race` so the timer is cleared when the
 * promise wins. A race leaves it armed, holding the event loop open for the
 * remainder of the timeout on every call that succeeds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
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

/** A read of a vessel's positions over `[from, to]`, in buckets of `seconds`. */
const positionQuery = (context: Context, from: number, to: number, seconds: number): HistoryValuesQuery => ({
  context,
  // Instants, not ISO strings: providers call Instant methods on these.
  from: Temporal.Instant.from(new Date(from).toISOString()),
  to: Temporal.Instant.from(new Date(to).toISOString()),
  pathSpecs: [{ path: 'navigation.position', aggregate: 'first' }],
  resolution: seconds,
})

/** The positions in a provider's answer, each standing for a bucket of `seconds`. */
const historyRows = (response: HistoryValuesResponse | undefined, seconds: number): TimedPosition[] => {
  const parsed: TimedPosition[] = []
  for (const row of response?.data ?? []) {
    const position = historyRowPosition(row)
    const timestamp = historyRowTimestamp(row)
    // A row with no position means the provider had none for that bucket,
    // which is what lets the store fill it. One without a usable time cannot
    // be placed, and dated to the epoch it would start an import there.
    if (position && timestamp > 0) {
      // A bucket, not a fix: its width keeps segment() from reading the
      // spacing between buckets as a stop in the recording.
      parsed.push({ position, timestamp, span: seconds * 1000 })
    }
  }
  return parsed
}

/**
 * What a history provider holds for a vessel over `[from, to)`, for the
 * history import, rejecting when there is no provider or it cannot be read:
 * an outage must not read as a day with nothing.
 */
async function importedHistory(
  app: App,
  context: Context,
  from: number,
  to: number,
  seconds: number,
): Promise<TimedPosition[]> {
  if (!app.getHistoryApi) {
    throw new Error('This server has no History API')
  }
  const historyApi = await withTimeout(
    app.getHistoryApi(app.config?.settings?.historyApi?.defaultProvider),
    HISTORY_QUERY_TIMEOUT_MS,
  )
  const response = await withTimeout(
    historyApi.getValues(positionQuery(context, from, to, seconds)),
    IMPORT_READ_TIMEOUT_MS,
  )
  // Not clipped to the range: a provider that stamps a bucket on its end puts
  // the last one past it, and the import keeps only what falls in the
  // stretches it asked about anyway.
  return historyRows(response, seconds)
}

/** Whether a history provider is installed and answers: one the import can read, and a delete keep its span from. */
async function historyProviderAvailable(app: App): Promise<boolean> {
  if (!app.getHistoryApi) {
    return false
  }
  try {
    await withTimeout(app.getHistoryApi(app.config?.settings?.historyApi?.defaultProvider), HISTORY_QUERY_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

/** The history import's state as the routes answer it, with ISO times. */
const historyImportJson = (state: HistoryImportState, running: boolean) => {
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    running,
    startedAt: iso(state.startedAt),
    ...(state.firstDay === undefined ? {} : { firstDay: iso(state.firstDay) }),
    ...(state.nextDay === undefined ? {} : { nextDay: iso(state.nextDay) }),
    filled: state.filled,
    ...(state.finishedAt === undefined ? {} : { finishedAt: iso(state.finishedAt) }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

export default function ThePlugin(app: App): Plugin {
  /**
   * The server's own lookup, falling back to what the store remembers.
   *
   * Live wins whenever the data model has an answer, which keeps the rule the
   * resolvers were written for: an AIS static report arriving late must be
   * able to correct or replace what was known. The stored value only covers
   * the window where the model knows nothing -- after a restart, or for a
   * vessel that has since sailed out of range.
   */
  const remembering =
    (store: () => TrackStore | undefined) =>
    (path: string): unknown => {
      const live = app.getPath?.(path)
      if (live !== undefined) {
        return live
      }
      const match = /^(.*)\.name$/.exec(path)
      return match ? store()?.nameFor(match[1] as Context) : undefined
    }

  let onStop: (() => void)[] = []
  let tracks: TrackStore | undefined = undefined
  /** Also what the plugin's own import route keeps tracks through. */
  let trackProvider: TrackProvider | undefined = undefined
  let segmentGap = 0
  let storageError: string | undefined
  let binRetentionMs = DEFAULT_RECYCLE_BIN_DAYS * DAY_MS
  /** How long other vessels' positions are kept, as set; 0 keeps them. */
  let aisRetentionDays = DEFAULT_AIS_RETENTION_DAYS
  /** How long the own vessel's positions are kept, in milliseconds; 0 keeps them. */
  let ownRetentionMs = 0
  /**
   * The oldest time an import into the own vessel's recording writes: what
   * lies before it, the next prune would delete again.
   */
  const keepFrom = (): number => (ownRetentionMs > 0 ? Date.now() - ownRetentionMs : Number.NEGATIVE_INFINITY)
  let recordOtherVessels = true
  /** The configuration the plugin runs with, while it runs. */
  let startedWith: TracksPluginConfig | undefined
  let resetting = false
  /**
   * Counts start() and stop() calls. A delete of the whole database stops the
   * plugin itself, and the server can stop or restart it meanwhile, on a
   * configuration save or a disable; the count tells the delete it happened.
   */
  let lifecycle = 0
  /**
   * Every store close a stop() has begun. A stop() waits for all of them, so
   * a start() the server makes once its stop() is done does not open the file
   * beside a store still draining into it.
   */
  let closed: Promise<void> = Promise.resolve()
  /**
   * The deleted spans of recorded tracks by context, loaded once and dropped
   * whenever a delete, restore or purge changes them. Read for each day of a
   * history import, which would otherwise ask the store each time.
   */
  let deletedSpans: Promise<Map<string, DeletedSpan[]>> | undefined

  /** A vessel's deleted spans, purged ones included. */
  async function deletedSpansOf(context: string): Promise<DeletedSpan[]> {
    const store = tracks
    if (!store?.deletedSpans) {
      return []
    }
    const loading = (deletedSpans ??= Promise.resolve(store.deletedSpans()).then((spans) => {
      const byContext = new Map<string, DeletedSpan[]>()
      for (const { context: owner, ...span } of spans) {
        byContext.set(owner, [...(byContext.get(owner) ?? []), span])
      }
      return byContext
    }))
    try {
      return (await loading).get(context) ?? []
    } catch (err) {
      if (deletedSpans === loading) deletedSpans = undefined
      throw err
    }
  }

  const sourceWatch = new SourceWatch()
  let glitchFilter = new GlitchFilter({ maxSpeedKnots: DEFAULT_MAX_SPEED_KNOTS })
  let stateGate = new StateGate(app.selfContext, DEFAULT_PAUSE_STATES)
  /** The own vessel's recording spacing per navigation.state, in ms. */
  let stateResolutions = new Map<string, number>()
  let otherVesselsResolution: number | undefined
  /**
   * The history import while it runs, or as it last stopped; see
   * historyImport.ts. `stop` asks it to stop before its next day.
   */
  let historyImport: { state: HistoryImportState; running: boolean; stop: boolean } | undefined
  /** Set while a request to start the import is on its way, so two cannot both start one. */
  let historyImportStarting = false
  /**
   * The GPX file being uploaded in slices, or the last one, loaded from the
   * store on the first request after a start; see gpxUpload.ts. One at a
   * time: two would write into the one recording side by side.
   */
  let gpxUpload: Promise<GpxUpload | undefined> | undefined
  /** Set while a request to start an upload is on its way, so two cannot both start one. */
  let gpxUploadStarting = false

  /**
   * Whether the history import could bring a vessel's track back; see
   * TrackProviderDeps. An import started already counts even while its
   * provider is away, restarting say: it goes on once the provider is back.
   */
  const importable = async (context: string): Promise<boolean> =>
    context === app.selfContext &&
    ((await tracks?.historyImport?.(context)) !== undefined || (await historyProviderAvailable(app)))

  type UploadStore = TrackStore & Required<Pick<TrackStore, 'gpxUpload' | 'saveGpxUpload'>>

  const uploadOf = (store: UploadStore, state: GpxUploadState) =>
    new GpxUpload(state, {
      save: async (next, parts) => store.saveGpxUpload(next, parts),
      replaced: () => {
        deletedSpans = undefined
      },
      keepFrom,
    })

  /** The upload the store holds, if any. */
  function currentUpload(store: UploadStore): Promise<GpxUpload | undefined> {
    const loading = (gpxUpload ??= Promise.resolve(store.gpxUpload()).then((state) => state && uploadOf(store, state)))
    loading.catch(() => {
      if (gpxUpload === loading) gpxUpload = undefined
    })
    return loading
  }

  /** Go on with the history import from `state`, unless it is running. */
  function startHistoryImport(state: HistoryImportState): void {
    const store = tracks
    if (!store?.saveHistoryImport || historyImport?.running) {
      return
    }
    // Without the error it stopped on, which this run tries again.
    const begun = { ...state }
    delete begun.error
    const run = { state: begun, running: true, stop: false }
    historyImport = run
    void runHistoryImport(state, {
      history: (from, to, seconds) => importedHistory(app, state.context, from, to, seconds),
      stored: async (from, to) =>
        // Through the filtered read: a vessel the store has never recorded is
        // left out rather than rejected.
        (
          await store.getFilteredTimedTracks(
            { bbox: null, radius: null, intersects: true, contexts: [state.context] },
            undefined,
            undefined,
            { window: { from, to, inclusiveEnd: true } },
          )
        )[state.context] ?? [],
      deleted: () => deletedSpansOf(state.context),
      save: async (next, runs, since) => store.saveHistoryImport!(next, runs, since),
      keepFrom,
      // A restart replaces the store, and the new one goes on by itself.
      stopped: () => run.stop || tracks !== store,
      progress: (next) => {
        run.state = next
      },
    }).then((final) => {
      run.state = final
      run.running = false
      if (final.error !== undefined && !run.stop && tracks === store) {
        app.error(`History import stopped: ${final.error}`)
      }
    })
  }

  /** The history import's part of the plugin status. */
  function historyImportStatus(): string | undefined {
    return historyImport && importStatus(historyImport.state, historyImport.running)
  }

  /** The own vessel's navigation.state, or undefined when it reports none. */
  function getVesselState(): string | undefined {
    const s = app.getSelfPath('navigation.state')
    if (s && typeof s === 'object' && 'value' in s) {
      const { value } = s as { value?: unknown }
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  }

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

  const plugin: Plugin = {
    start: function (config: TracksPluginConfig) {
      lifecycle++
      startedWith = config
      storageError = undefined
      historyImport = undefined
      gpxUpload = undefined
      const { resolution } = config
      const segmentGapMinutes = toNumber(config.segmentGapMinutes) ?? DEFAULT_SEGMENT_GAP_MINUTES
      segmentGap = segmentGapMinutes > 0 ? segmentGapMinutes * 60 * 1000 : 0
      binRetentionMs = Math.max(1, toNumber(config.recycleBinDays) ?? DEFAULT_RECYCLE_BIN_DAYS) * DAY_MS
      ownRetentionMs = Math.max(0, toNumber(config.dangerZone?.ownRetentionDays) ?? 0) * DAY_MS
      deletedSpans = undefined

      // Rebuilt on every start so a changed ceiling takes effect, and so the
      // reference positions do not survive a restart the user made precisely
      // because the track looked wrong.
      const maxSpeedKnots = toNumber(config.maxSpeedKnots) ?? DEFAULT_MAX_SPEED_KNOTS
      glitchFilter = new GlitchFilter({ maxSpeedKnots })
      stateResolutions = new Map()
      for (const entry of Array.isArray(config.stateResolutions)
        ? config.stateResolutions
        : DEFAULT_STATE_RESOLUTIONS) {
        const spacing = toNumber(entry.resolution)
        if (typeof entry.state === 'string' && spacing !== undefined && spacing >= 0) {
          stateResolutions.set(entry.state, spacing)
        }
      }
      otherVesselsResolution = toNumber(config.otherVesselsResolution)
      recordOtherVessels = config.recordOtherVessels !== false
      stateGate = new StateGate(
        app.selfContext,
        Array.isArray(config.pauseWhenState) ? config.pauseWhenState : DEFAULT_PAUSE_STATES,
      )

      // getDataDirPath is what makes the file the server's to manage: backed up
      // and removed with the plugin. Every server that can load this plugin
      // provides it, so there is no in-memory fallback — a track recorder that
      // forgets everything on restart is not what anyone installs.
      const dataDir = app.getDataDirPath?.()
      if (!dataDir) {
        app.error('This server provides no plugin data directory, so tracks cannot be recorded.')
        return
      }

      // Always a fresh store: stop() has closed the previous handle, and a
      // restart must not keep one built with a resolution since changed.
      //
      // Guarded because opening a database touches the filesystem: a read-only
      // or full data directory throws here, and an uncaught throw out of
      // start() takes down more than this plugin.
      let starting: AsyncTrackStore
      try {
        starting = new AsyncTrackStore(
          {
            file: join(dataDir, 'tracks.db'),
            resolution: toNumber(resolution) ?? DEFAULT_RESOLUTION,
            // The own vessel's track is kept indefinitely unless the danger
            // zone says otherwise: it is the one worth keeping, and a thousand
            // hours under way at the default resolution take about 80 MB.
            // Other vessels are pruned by aisRetentionDays.
            retention: ownRetentionMs,
            binRetention: binRetentionMs,
            storageTolerance: Math.max(0, toNumber(config.storageTolerance) ?? DEFAULT_STORAGE_TOLERANCE),
            maxSpeedKnots,
            segmentGap,
          },
          app.debug,
          (error) => {
            if (tracks !== starting) return
            storageError = `Could not use track database: ${errorDetail(error)}`
            app.error(storageError)
            app.setPluginStatus?.(storageError)
          },
          {},
          (message) => {
            if (tracks !== starting) return
            storageError = undefined
            app.error(message) // Keep a visible record of the recording gap.
            app.setPluginStatus?.(stateGate.status() ?? sourceWatch.warning(app.selfContext) ?? 'Recording tracks')
          },
        )
        tracks = starting
      } catch (err) {
        app.error(`Could not open the track database in ${dataDir}: ${errorDetail(err)}`)
        return
      }
      onStop.push(
        app.streambundle.getBus('navigation.position').onValue((update: ContextPosition): void => {
          if (!update.value || update.value.latitude == null || update.value.longitude == null) return
          if (isFixedStation(update.context)) return
          // Before anything is kept of it, its name and its sources included.
          if (!recordOtherVessels && update.context !== app.selfContext) return
          sourceWatch.add(update.context, update.$source)
          // Captured here rather than by subscribing to `name`: the data model
          // already holds it by the time a position arrives, and a vessel with
          // no positions is not a track worth naming.
          //
          // Deliberately reads the model directly instead of going through
          // contextName, which now falls back to this very store -- routing
          // capture through it would re-date a months-old stored name as a
          // fresh observation on every position, defeating the ordering.
          //
          // Unwrapped the same way the resolvers read this field: the model
          // carries a bare string for some sources and the `{value}` wrapper
          // for others. Accepting only one shape here would let a name render
          // live and then vanish on restart, having never been captured.
          const live = unwrapString(app.getPath?.(`${update.context}.name`))
          if (live !== undefined) {
            tracks?.recordName(update.context, live)
          }
          // Prefer the delta's own timestamp so a replayed or delayed update is
          // filed at the time it was recorded, not the time it arrived.
          const recorded = update.timestamp === undefined ? undefined : Date.parse(update.timestamp)
          const timestamp = recorded !== undefined && !Number.isNaN(recorded) ? recorded : undefined
          const position: LatLngTuple = [update.value.latitude, update.value.longitude]
          // Read per delta rather than subscribed to: navigation.state changes
          // rarely, and the current value is what matters at the moment a
          // position arrives.
          const state = getVesselState()
          if (!stateGate.accept(update.context, state)) {
            return
          }
          // Filtered here rather than in each store: both would otherwise need
          // the same check, and a rejected fix should reach neither. A fix dated
          // before the one the filter measures from, it cannot judge; the sqlite
          // store measures that one from its stored positions either side.
          if (!glitchFilter.accept(update.context, position, timestamp ?? Date.now())) {
            return
          }
          // navigation.state for another vessel is whatever its transponder
          // was last set to, often stale, so only the own vessel follows it.
          const spacing =
            update.context === app.selfContext
              ? state === undefined
                ? undefined
                : stateResolutions.get(state)
              : otherVesselsResolution
          tracks?.newPosition(update.context, position, timestamp, spacing)
        }),
      )
      // Set in days, since it is about how long another vessel's track stays
      // interesting, and passed to prune() in milliseconds. 0 keeps every
      // position indefinitely.
      aisRetentionDays = Math.max(0, toNumber(config.aisRetentionDays) ?? DEFAULT_AIS_RETENTION_DAYS)
      const aisRetentionMs = aisRetentionDays * DAY_MS
      // Runs even with `aisRetentionDays: 0`, since prune() also purges the
      // recycle bin. A maxAge of Infinity ages nothing out.
      const pruneInterval = setInterval(() => {
        tracks?.prune(aisRetentionMs > 0 ? aisRetentionMs : Infinity, app.selfContext)
      }, PRUNE_INTERVAL_MS)
      onStop.push(() => {
        clearInterval(pruneInterval)
      })
      // Each call waits for the answer to the one before, so calls never
      // pile up behind a long read, and one that left work comes back sooner.
      let refining = true
      let refineTimer: ReturnType<typeof setTimeout> | undefined
      const refine = (): void => {
        void Promise.resolve()
          .then(() => tracks?.refineLevels?.() ?? false)
          .catch(() => false)
          .then((more) => {
            if (refining) refineTimer = setTimeout(refine, more ? REFINE_BACKLOG_INTERVAL_MS : REFINE_INTERVAL_MS)
          })
      }
      refineTimer = setTimeout(refine, REFINE_INTERVAL_MS)
      onStop.push(() => {
        refining = false
        clearTimeout(refineTimer)
      })

      // Report on a timer rather than per delta: at 10Hz across several
      // vessels that would rewrite the status thousands of times a minute, and
      // the first fix from a second source is not yet evidence of a problem —
      // a source that appears once and stops is not worth a warning.
      // Reported rather than left to go stale: without the else branch the last
      // "not recording" message stayed on the dashboard after the vessel got
      // under way, which is worse than saying nothing at all.
      let lastStatus: string | undefined
      const statusInterval = setInterval(() => {
        // Being paused is the more useful thing to report: a user who has
        // opted in wants to see it is working, and one who has not wonders why
        // nothing is recording.
        const recording = stateGate.status() ?? sourceWatch.warning(app.selfContext) ?? 'Recording tracks'
        const importing = historyImportStatus()
        // The paused and source messages end their sentence, 'Recording tracks' does not.
        const status = importing === undefined ? recording : `${recording.replace(/\.$/, '')}. ${importing}`
        if (status !== lastStatus) {
          lastStatus = status
          app.setPluginStatus?.(storageError ?? status)
        }
      }, SOURCE_STATUS_INTERVAL_MS)
      onStop.push(() => {
        clearInterval(statusInterval)
      })

      // Offer the accumulated tracks to the v2 Track API.
      //
      // The provider reads `tracks` through a getter rather than capturing it,
      // because start() replaces the store wholesale and a captured reference
      // would keep serving the store a restart was meant to discard.
      //
      // Deliberately not unregistered in stop(): the server pushes its own
      // unregister onto the plugin's stop handlers when this is called, so
      // doing it here as well would unregister twice.
      trackProvider = createTrackProvider({
        store: () => tracks,
        selfContext: () => app.selfContext,
        segmentGap: () => segmentGap,
        contextName: (context: string) =>
          contextName(
            context,
            remembering(() => tracks),
          ),
        importable,
        deleted: () => {
          deletedSpans = undefined
        },
        keepFrom,
      })
      app.registerTrackApiProvider?.(trackProvider)
      // A history import a stop or a restart broke off goes on by itself.
      void starting.ready
        .then(() => starting.historyImport(app.selfContext))
        .then((state) => {
          if (!state || state.finishedAt !== undefined || tracks !== starting) {
            return
          }
          const waiting = { state, running: false, stop: false }
          historyImport = waiting
          // Not once an import started by hand meanwhile has replaced it, and
          // not while one is being started: that start read the progress
          // already, and would save it back over what this run did.
          let resume: ReturnType<typeof setTimeout>
          const goOn = () => {
            if (tracks !== starting || historyImport !== waiting) {
              return
            }
            if (historyImportStarting) {
              resume = setTimeout(goOn, IMPORT_RESUME_DELAY_MS)
              return
            }
            startHistoryImport(state)
          }
          resume = setTimeout(goOn, IMPORT_RESUME_DELAY_MS)
          onStop.push(() => clearTimeout(resume))
        })
        .catch(() => {})
      return starting.ready.catch(async () => {
        // A failed start must release the worker before callers remove the data directory.
        await starting.close().catch(() => {})
        if (tracks === starting) tracks = undefined
      })
    },

    stop: async function () {
      lifecycle++
      startedWith = undefined
      onStop.forEach((f) => {
        try {
          f()
        } catch (err) {
          app.error(err)
        }
      })
      onStop = []
      if (historyImport) historyImport.stop = true
      gpxUpload = undefined
      // Forget which sources were seen: the point of a restart is often to
      // apply a source priority change, and carrying the old observations over
      // would keep warning about a setup that has just been fixed.
      sourceWatch.clear()
      glitchFilter.clear()
      stateGate.clear()
      // Release the file handle a sqlite store holds, so a plugin restart does
      // not leak it and the WAL gets checkpointed.
      //
      // A stopped plugin serves nothing: closing the database releases the file
      // handle and checkpoints the WAL, so the routes answer 404 until the next
      // start() builds a fresh store. They stay mounted and degrade rather than
      // throw, because the server calls stop() on a config save.
      const closing = tracks
      tracks = undefined
      if (closing) {
        const closingNow = (async () => {
          try {
            await closing.close?.()
          } catch (err) {
            app.error(err)
          }
        })()
        closed = Promise.all([closed, closingNow]).then(() => {})
      }
      await closed
    },

    signalKApiRoutes: function (router: Router) {
      // Resolved per request rather than cached: an AIS target's static report
      // can arrive long after its first position, so a track named from the
      // MMSI early on picks up the real name as soon as the server has it.
      const nameOf = (context: string) =>
        trackLabel(
          context,
          app.selfContext,
          remembering(() => tracks),
        )

      /**
       * A track as both single-track routes answer it: read, thinned to the
       * query's resolution and split into segments, all through one
       * TrackStream, so the same window cannot be answered two ways. `whole`
       * reads the window in one piece; otherwise it is read a day at a time,
       * stepping over the days with nothing, and each day is handed to
       * `onPoints` once thinning has settled it, so a recording of years is
       * never held whole, until `cancelled` says the answer is no longer
       * wanted. Resolves false for a vessel the store does not know, and
       * rejects when the store fails to read one it does.
       */
      const readTrack = async (
        context: string,
        query: TrackQuery,
        pieces: 'whole' | 'days',
        onPoints: (points: StreamedPoint[]) => void | Promise<void>,
        cancelled: () => boolean = () => false,
      ): Promise<boolean> => {
        const store = tracks!
        const stream = new TrackStream(query.resolution, segmentGap)
        if (pieces === 'whole' || !store.timeExtent) {
          const points = await store.getTimed(context, query.window).catch(unknownAs(undefined))
          if (points === undefined) return false
          await onPoints(stream.push(points))
        } else {
          let extent: TimeExtent | undefined | null = await store
            .timeExtent(context, query.window)
            .catch(unknownAs(null))
          if (extent === null) return false
          const last = extent?.last
          while (extent !== undefined && last !== undefined && !cancelled()) {
            const dayEnd: number = (Math.floor(extent.first / DAY_MS) + 1) * DAY_MS
            const lastDay = dayEnd > last
            await onPoints(
              stream.push(
                await store.getTimed(
                  context,
                  lastDay
                    ? { from: extent.first, to: last, inclusiveEnd: true }
                    : { from: extent.first, to: dayEnd, inclusiveEnd: false },
                ),
              ),
            )
            extent = lastDay
              ? undefined
              : await store.timeExtent(context, { from: dayEnd, to: last, inclusiveEnd: true })
          }
        }
        if (cancelled()) return true
        await onPoints(stream.finish())
        return true
      }

      /**
       * The JSON route's track, thinned and segmented. Resolves `undefined`
       * for a vessel the store does not know at all; a known vessel with
       * nothing inside the window is an empty track.
       */
      const readSegments = async (context: string, query: TrackQuery): Promise<TimedPosition[][] | undefined> => {
        const segments: TimedPosition[][] = []
        const known = await readTrack(context, query, 'whole', (points) => {
          for (const { point, starts } of points) {
            if (starts) segments.push([])
            segments.at(-1)!.push(point)
          }
        })
        return known ? segments : undefined
      }

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
            query = parseTrackQuery(req.query, Date.now(), [], DEFAULT_WINDOW_MS)
          } catch (err) {
            res.status(400)
            res.json({ message: err instanceof TimeWindowError ? err.message : 'Invalid query parameters' })
            return
          }
          readSegments(context, query)
            .then((segments) => {
              if (segments === undefined) {
                res.status(404)
                res.json({ message: `No track available for ${context}` })
                return
              }
              res.json({
                type: 'MultiLineString',
                coordinates: segments.map((points) => points.map(({ position }) => toLngLat(position))),
                ...(query.times ? { times: segments.map(toIsoTimes) } : {}),
                context,
                isSelf: context === app.selfContext,
                name: nameOf(context),
              })
            })
            .catch((err: unknown) => {
              // Not a 404: `readSegments` reported an unknown vessel already,
              // so this is a read, or the answer, that failed, and a known
              // track must not read as missing.
              app.error(`Could not read the track for ${context}: ${errorDetail(err)}`)
              res.status(500)
              res.json({ message: `Could not read the track for ${context}` })
            })
        }

      /**
       * One vessel's track as a GPX file.
       *
       * Written a day at a time by `GpxTrackWriter`, which shares its lines with
       * `toGpx`, so the export a user downloads is the same document the module
       * produces everywhere else.
       * The webapp imports no server code from `src/` at run time, which is
       * why the conversion lives behind a route instead of being duplicated in
       * the page.
       */
      const gpxHandler =
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
          const label = nameOf(context)
          const writer = new GpxTrackWriter({ name: label, context })
          // Written a day at a time as it is read, so exporting a recording of
          // years holds a day of it rather than all of it, twice over, on the
          // server's own thread.
          let closed = false
          // One listener of each for the whole response, waking whichever
          // write is waiting. The server's compression middleware hands a
          // `drain` listener to its compression stream but leaves `off` on
          // the response, so a listener added per wait could never be taken
          // off again, and each would hold the day of text it waited to send.
          let waiting: (() => void) | undefined
          const wake = () => {
            const resume = waiting
            waiting = undefined
            resume?.()
          }
          res.on('close', () => {
            closed = true
            wake()
          })
          res.on('drain', wake)
          // A response already closed takes nothing and says so by no event.
          // Otherwise a write the response cannot take yet waits for the
          // client to take what was sent, or to go away.
          const send = (text: string): Promise<void> =>
            text === '' || closed || res.write(text)
              ? Promise.resolve()
              : new Promise((resolve) => {
                  waiting = resolve
                })
          const begin = async () => {
            if (res.headersSent) return
            const filename = gpxFilename(label)
            res.type('application/gpx+xml')
            // Two forms, per RFC 5987. A header carries bytes, not text, so
            // `setHeader` throws ERR_INVALID_CHAR on a name outside Latin-1
            // -- which this route's catch would have reported as a 404, and
            // a name inside it would arrive mojibaked instead. The quoted
            // form is ASCII for readers that understand nothing else; the
            // `filename*` form carries the real name.
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${rfc8187(filename)}`,
            )
            await send(writer.start())
          }
          readTrack(
            context,
            query,
            'days',
            async (points) => {
              if (closed) throw new Error('The client went away')
              await begin()
              await send(writer.write(points))
            },
            // No day more is read for a client that went away.
            () => closed,
          )
            .then(async (known) => {
              if (closed) return
              if (!known) {
                res.status(404)
                res.json({ message: `No track available for ${context}` })
                return
              }
              // A known vessel with nothing in the window is still a document.
              await begin()
              res.end(writer.end())
            })
            .catch((err: unknown) => {
              if (closed) return
              // Not a 404: `readTrack` already reported an unknown vessel by
              // resolving false, so anything reaching here is this route
              // failing -- a read, serialisation, a header, a write. Reporting
              // that as "no track available" is what disguised an
              // ERR_INVALID_CHAR from a non-Latin-1 filename as a missing track.
              app.error(`Could not export GPX for ${context}: ${errorDetail(err)}`)
              if (!res.headersSent) {
                res.status(500)
                res.json({ message: `Could not export the track for ${context}` })
              } else {
                // Part of the file is out: ending it would pass a cut-off
                // export as a whole one.
                res.destroy(err instanceof Error ? err : new Error(String(err)))
              }
            })
        }

      const trackHandler = singleTrackHandler((req) => resolveContext(String(req.params.vesselId), app.selfContext))
      router.get('/vessels/:vesselId/track', trackHandler)
      router.get(
        '/vessels/:vesselId/track.gpx',
        gpxHandler((req) => resolveContext(String(req.params.vesselId), app.selfContext)),
      )
      router.get(
        '/self/track.gpx',
        gpxHandler(() => app.selfContext),
      )

      // Freeboard-SK requests the own vessel's trail here rather than at
      // /vessels/self/track. Plugin routes are mounted before the v1 REST
      // interface, so this takes precedence over the data-tree walker.
      router.get(
        '/self/track',
        singleTrackHandler(() => app.selfContext),
      )

      // return all / filtered vessel tracks
      /** Only the collection route filters spatially; see AGENTS.md on v1 vs v2. */
      const SPATIAL_PARAMS = ['bbox', 'radius'] as const

      /**
       * The list's `times` answer from the store's per-vessel members, in the
       * shape `res.json` gives the rest: each vessel framed with its type,
       * whether it is the own vessel and its name, if it has one.
       */
      const frameTimedTracks = (fragments: Record<string, Uint8Array>): Buffer => {
        const parts: Uint8Array[] = []
        let separator = '{'
        for (const [context, members] of Object.entries(fragments)) {
          parts.push(Buffer.from(`${separator}${JSON.stringify(context)}:{"type":"MultiLineString",`), members)
          const name = nameOf(context)
          const named = name === undefined ? '' : `,"name":${JSON.stringify(name)}`
          parts.push(Buffer.from(`,"isSelf":${context === app.selfContext}${named}}`))
          separator = ','
        }
        parts.push(Buffer.from(separator === '{' ? '{}' : '}'))
        return Buffer.concat(parts)
      }

      const allTracksHandler: RequestHandler = (req: Request, res: Response) => {
        app.debug(req.query)
        if (!tracks) {
          notAvailable(res)
          return
        }
        let query: TrackQuery
        let params: TrackParams
        try {
          query = parseTrackQuery(req.query, Date.now(), SPATIAL_PARAMS, DEFAULT_WINDOW_MS)
          // Inside the try on purpose: a malformed bbox used to reach the
          // matcher, throw there, and be caught by the result handler's
          // `.catch()`, which answers 404 -- reporting a bad query as an empty
          // one. Validating here lets it surface as the 400 it is.
          params = validateParameters(req.query, undefined)
        } catch (err) {
          res.status(400)
          res.json({
            message:
              err instanceof TimeWindowError || err instanceof QueryParameterError
                ? err.message
                : 'Invalid query parameters',
          })
          return
        }
        const selfPosition = getVesselPosition()

        // Two paths on purpose. Without `times` the response keeps its
        // long-standing shape exactly — one un-segmented line per vessel — so
        // existing clients read it as before. With `times` the track is segmented
        // like the single-vessel route, because a times array can only line up
        // with coordinates if both are split the same way.
        //
        // A vessel with nothing in the window is left out. Without a window the
        // list reads the last day, and every vessel the store keeps would
        // otherwise come back, most of them as an empty line.
        const result: Promise<Buffer | AllTracksResult> = query.times
          ? (
              tracks.getFilteredTimedTracksJson?.(params, selfPosition, app.debug, query, segmentGap) ??
              tracks
                .getFilteredTimedTracks(params, selfPosition, app.debug, query)
                .then((tc: TimedTrackCollection) => timedTracksJson(tc, segmentGap))
            ).then((fragments) => frameTimedTracks(fragments))
          : tracks.getFilteredTracks(params, selfPosition, app.debug, query).then((tc: TrackCollection) =>
              withPoints(tc).reduce<AllTracksResult>((acc, [context, track]) => {
                acc[context] = {
                  type: 'MultiLineString',
                  coordinates: [track.map(toLngLat)],
                  isSelf: context === app.selfContext,
                  name: nameOf(context),
                }
                return acc
              }, {}),
            )

        result
          .then((trks) => {
            if (Buffer.isBuffer(trks)) {
              res.type('json')
              res.send(trks)
            } else {
              res.json(trks)
            }
          })
          .catch((err: unknown) => {
            // A radius query the server cannot measure is not a missing track.
            // Reporting it as 404 said no vessel matched, which is the one
            // thing an unanswerable query cannot establish.
            if (err instanceof SelfPositionUnavailableError) {
              res.status(503)
              res.json({ message: 'No position for the own vessel, so radius cannot be measured' })
              return
            }
            // Nor is a store that failed. A list that matches nothing is an
            // empty 200, so a 404 here only hid the failure.
            app.error(`Could not read the tracks: ${errorDetail(err)}`)
            res.status(500)
            res.json({ message: 'Could not read the tracks' })
          })
      }
      router.get('/tracks', allTracksHandler)
      // Express 4 path syntax: the Signal K server mounts plugin routers on
      // express 4, where a bare `*` is the wildcard (express 5 renamed it).
      router.get('/tracks/*', allTracksHandler)

      return router
    },

    // Mounted under /plugins/tracks, where the server keeps routes registered
    // directly on the router admin-only: the same authority the Track API
    // asks to delete, which restoring and purging are part of.
    registerWithRouter: function (router: Router) {
      /** An import as the webapp lists it, in the shape of a v2 track's properties. */
      const importSummary = (track: StoredImport) => {
        const name =
          track.context === undefined
            ? undefined
            : contextName(
                track.context,
                remembering(() => tracks),
              )
        // A loop rather than Math.min(...): a long passage has more points than
        // a call can take arguments.
        let pointCount = 0
        let from = Infinity
        let to = -Infinity
        for (const segment of track.segments) {
          for (const { timestamp } of segment) {
            pointCount++
            if (timestamp !== undefined) {
              from = Math.min(from, timestamp)
              to = Math.max(to, timestamp)
            }
          }
        }
        return {
          id: `${PLUGIN_ID}:${track.id}`,
          providerId: PLUGIN_ID,
          ...(track.name === undefined ? {} : { name: track.name }),
          ...(track.context === undefined ? {} : { context: track.context, isSelf: track.context === app.selfContext }),
          ...(name === undefined ? {} : { contextName: name }),
          ...(from > to ? {} : { from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
          imported: new Date(track.importedAt).toISOString(),
          pointCount,
        }
      }
      const binEntryJson = (entry: BinEntry) => {
        const name =
          entry.context === undefined
            ? undefined
            : contextName(
                entry.context,
                remembering(() => tracks),
              )
        const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
        return {
          id: entry.id,
          trackId: entry.importId ?? recordedId(entry.context!),
          kind: entry.importId === undefined ? 'recorded' : 'imported',
          ...(entry.context === undefined ? {} : { context: entry.context, isSelf: entry.context === app.selfContext }),
          ...(name === undefined ? {} : { contextName: name }),
          ...(entry.name === undefined ? {} : { name: entry.name }),
          whole: entry.whole,
          ...(entry.from === undefined ? {} : { from: iso(entry.from) }),
          ...(entry.to === undefined ? {} : { to: iso(entry.to) }),
          deletedAt: iso(entry.deletedAt),
          purgeAt: iso(entry.deletedAt + binRetentionMs),
          pointCount: entry.pointCount,
        }
      }
      /** The bin entry an `:id` names, or undefined after answering 400 or 404. */
      const binStore = (req: Request, res: Response): { store: TrackStore; id: number } | undefined => {
        const store = tracks
        if (!store?.binEntries || !store.restoreFromBin || !store.purgeFromBin) {
          notAvailable(res)
          return undefined
        }
        const id = Number(req.params.id)
        if (!Number.isSafeInteger(id) || id <= 0) {
          res.status(400).json({ message: `Recycle bin entry '${req.params.id}' is not an id` })
          return undefined
        }
        return { store, id }
      }
      const failed = (res: Response) => (err: unknown) => {
        app.error(`Recycle bin: ${errorDetail(err)}`)
        res.status(500).json({ message: 'Track storage failed' })
      }

      // Every import, whatever its time span: the webapp lists other vessels
      // over a window through the Track API, which an old passage or an
      // untimed track never matches, so without this an imported file could
      // not be found again.
      // Listing asks for read access, as reading the Track API does.
      const readable = (router as AccessRouter).access?.('readonly') ?? router
      readable.get('/imports', (_req: Request, res: Response) => {
        const store = tracks
        if (!store?.findImports) {
          notAvailable(res)
          return
        }
        Promise.resolve(store.findImports())
          .then((imports) => res.json(imports.map(importSummary)))
          .catch((err: unknown) => {
            app.error(`Listing imports: ${errorDetail(err)}`)
            res.status(500).json({ message: 'Track storage failed' })
          })
      })

      // Storing a track asks for write access, as the Track API's POST does.
      // A server without per-route access keeps the route admin-only.
      const writable = (router as AccessRouter).access?.('readwrite') ?? router
      writable.post('/imports', (req: Request, res: Response) => {
        const provider = trackProvider
        if (!provider || !tracks?.storeImport || !tracks.recordTrack || !tracks.fillTrack) {
          notAvailable(res)
          return
        }
        // `self` files the tracks under the own vessel, which writes a timed
        // one into the recording (see keepTrack), and `onOverlap` says what
        // happens where the recording already has positions.
        const context = req.query.self === 'true' ? app.selfContext : undefined
        const onOverlap = req.query.onOverlap ?? 'keep'
        if (onOverlap !== 'keep' && onOverlap !== 'replace') {
          res.status(400).json({ message: "onOverlap must be 'keep' or 'replace'" })
          return
        }
        void (async () => {
          let text: string
          try {
            text = await readText(req)
          } catch (err) {
            if (err instanceof UploadTooLargeError) {
              res.status(413).json({ message: err.message })
            } else if (err instanceof UploadTypeError) {
              res.status(415).json({ message: err.message })
            } else {
              res.status(400).json({ message: 'The file could not be read' })
            }
            return
          }
          const read = fromGpx(text)
          if (read.length === 0) {
            res.status(400).json({ message: 'No track found: the file is not GPX, or has no track with points' })
            return
          }
          const converted = read.map((gpx) => fromGpxTrack(gpx, context ?? gpx.context))
          const kept: { id?: string; overlapping: number; expired: number }[] = []
          try {
            for (const { track } of converted) {
              kept.push(await provider.importTrack(track, onOverlap))
            }
          } catch (err) {
            app.error(`GPX import: ${errorDetail(err)}`)
            res.status(500).json({ message: 'Track storage failed' })
            return
          }
          res.status(201).json({
            // As the Track API names them on a server with its write routes,
            // so a client can fetch or delete them there.
            ids: kept.flatMap(({ id }) => (id === undefined ? [] : [`${PLUGIN_ID}:${id}`])),
            skippedPoints: converted.reduce((sum, { skippedPoints }) => sum + skippedPoints, 0),
            overlappingPoints: kept.reduce((sum, { overlapping }) => sum + overlapping, 0),
            expiredPoints: kept.reduce((sum, { expired }) => sum + expired, 0),
          })
        })()
      })

      // A GPX file too large for one request, uploaded in slices into the own
      // vessel's recording; see gpxUpload.ts. Writing asks for write access,
      // as storing a track does, and so does reading how far it got, which
      // names the file.
      const uploadStore = (res: Response): UploadStore | undefined => {
        const store = tracks
        if (!store?.gpxUpload || !store.saveGpxUpload) {
          notAvailable(res)
          return undefined
        }
        return store as UploadStore
      }
      const uploadFailed = (res: Response, upload?: GpxUpload) => (err: unknown) => {
        const status = upload && { upload: upload.status }
        if (err instanceof UploadConflictError) {
          res.status(409).json({ message: err.message, ...status })
        } else if (err instanceof UploadFormatError) {
          res.status(422).json({ message: err.message, ...status })
        } else {
          app.error(`GPX upload: ${errorDetail(err)}`)
          res.status(500).json({ message: 'Track storage failed', ...status })
        }
      }
      /** The upload `:id` names, or undefined after answering. */
      const namedUpload = async (req: Request, res: Response): Promise<GpxUpload | undefined> => {
        const store = uploadStore(res)
        if (!store) return undefined
        const upload = await currentUpload(store)
        if (upload?.id !== req.params.id) {
          res.status(404).json({ message: `No upload '${String(req.params.id)}'` })
          return undefined
        }
        return upload
      }

      writable.get('/imports/upload', (_req: Request, res: Response) => {
        const store = uploadStore(res)
        if (!store) return
        currentUpload(store)
          .then((upload) => res.json({ upload: upload?.status ?? null }))
          .catch(uploadFailed(res))
      })

      writable.post('/imports/upload', (req: Request, res: Response) => {
        const store = uploadStore(res)
        if (!store) return
        const start = parseUploadStart(req.body)
        if (typeof start === 'string') {
          res.status(400).json({ message: start })
          return
        }
        if (gpxUploadStarting) {
          res.status(409).json({ message: 'Another file is being imported' })
          return
        }
        gpxUploadStarting = true
        void (async () => {
          const current = await currentUpload(store)
          // An upload nobody has sent to for a while gives way: its file may be gone.
          if (current?.active && !current.idle) {
            res.status(409).json({ message: 'Another file is being imported', upload: current.status })
            return
          }
          current?.supersede()
          let saved: GpxUploadState
          try {
            const keepEmpty = start.onOverlap === 'replace' && (await importable(app.selfContext))
            saved = await store.saveGpxUpload(newUpload({ ...start, context: app.selfContext, keepEmpty }), [])
          } catch (err) {
            current?.resume()
            throw err
          }
          const upload = uploadOf(store, saved)
          if (tracks === store) gpxUpload = Promise.resolve(upload)
          res.status(201).json({ upload: upload.status })
        })()
          .catch(uploadFailed(res))
          .finally(() => {
            gpxUploadStarting = false
          })
      })

      writable.put('/imports/upload/:id', (req: Request, res: Response) => {
        const offset = Number(req.query.offset)
        if (!Number.isSafeInteger(offset) || offset < 0) {
          res.status(400).json({ message: 'offset must be the byte the slice starts at' })
          return
        }
        void (async () => {
          const upload = await namedUpload(req, res)
          if (!upload) return
          // Before the body is read, so two requests cannot both hold a slice's worth of it.
          let slice: SliceReservation
          try {
            slice = upload.reserve(offset)
          } catch (err) {
            uploadFailed(res, upload)(err)
            return
          }
          let bytes: Buffer
          try {
            bytes = await readSlice(req, MAX_SLICE_BYTES)
          } catch (err) {
            slice.release()
            if (err instanceof UploadTooLargeError) {
              res.status(413).json({ message: err.message, upload: upload.status })
            } else if (err instanceof UploadTypeError) {
              res.status(415).json({ message: err.message, upload: upload.status })
            } else {
              res.status(400).json({ message: 'The slice could not be read', upload: upload.status })
            }
            return
          }
          if (bytes.length === 0) {
            slice.release()
            res.status(400).json({ message: 'The slice is empty', upload: upload.status })
            return
          }
          await slice.write(bytes).then(() => res.json({ upload: upload.status }), uploadFailed(res, upload))
        })().catch(uploadFailed(res))
      })

      writable.delete('/imports/upload/:id', (req: Request, res: Response) => {
        void (async () => {
          const upload = await namedUpload(req, res)
          if (!upload) return
          await upload.abort().then(() => res.json({ upload: upload.status }), uploadFailed(res, upload))
        })().catch(uploadFailed(res))
      })

      // Downloading a track asks for read access, as reading it through the
      // Track API does.
      readable.get('/imports/:id/track.gpx', (req: Request, res: Response) => {
        const store = tracks
        if (!store?.getImport) {
          notAvailable(res)
          return
        }
        const id = String(req.params.id)
        if (!isImportedId(id)) {
          res.status(404).json({ message: `No imported track '${id}'` })
          return
        }
        Promise.resolve(store.getImport(id))
          .then((track) => {
            if (!track) {
              res.status(404).json({ message: `No imported track '${id}'` })
              return
            }
            // A GPX file may carry an empty <name>; the vessel then names the track.
            const label =
              track.name?.trim() ||
              (track.context === undefined
                ? 'Imported track'
                : trackLabel(
                    track.context,
                    app.selfContext,
                    remembering(() => tracks),
                  ))
            const filename = gpxFilename(label)
            res.type('application/gpx+xml')
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${rfc8187(filename)}`,
            )
            res.send(
              toGpx([
                {
                  name: label,
                  ...(track.context === undefined ? {} : { context: track.context }),
                  segments: track.segments,
                },
              ]),
            )
          })
          .catch((err: unknown) => {
            app.error(`Could not export GPX for ${id}: ${errorDetail(err)}`)
            if (!res.headersSent) {
              res.status(500).json({ message: `Could not export the track ${id}` })
            }
          })
      })

      // What the webapp tells its reader about the lists it shows: other
      // vessels' tracks reach back as far as they are kept, and whether they
      // are recorded at all. Read access, as for the lists themselves.
      // `aisRetentionDays` and `recordOtherVessels` are the settings of those
      // names, the days with 0 for keeping them indefinitely.
      readable.get('/settings', (_req: Request, res: Response) => {
        res.json({ aisRetentionDays, recordOtherVessels })
      })

      // The webapp's danger zone: the whole database deleted, for a store gone
      // wrong past repair. Admin-only, as it is registered on the router
      // itself, and only with the word the webapp has the user type, so no
      // stray request can do it. The plugin stops, the file goes, and the
      // plugin starts again as it was set up, on an empty store.
      router.delete('/database', (req: Request, res: Response) => {
        if (req.query.confirm !== 'DELETE') {
          res.status(400).json({ message: 'Deleting the whole track database needs confirm=DELETE.' })
          return
        }
        // Before anything else: the delete's own stop() clears what the
        // checks below read, so a second request would otherwise be told the
        // plugin is not running.
        if (resetting) {
          res.status(409).json({ message: 'The track database is being deleted already.' })
          return
        }
        // A database that cannot be reached deletes nothing: one on a disk not
        // mounted would be left behind.
        const unreachable = (err: unknown) => {
          app.error(`Not deleting the track database, which cannot be reached: ${errorDetail(err)}`)
          res.status(409).json({
            message:
              'The track database, or the file a link to it points to, cannot be reached, so nothing was deleted. The server log says why.',
          })
        }
        const config = startedWith
        const asked = lifecycle
        // Not `tracks`: a store that will not open is the case this is for.
        if (!config) {
          notAvailable(res)
          return
        }
        let dataDir: string | undefined
        try {
          // The server makes the directory as it is asked for it, which
          // throws for one that is a link that points nowhere.
          dataDir = app.getDataDirPath?.()
        } catch (err) {
          unreachable(err)
          return
        }
        if (!dataDir) {
          notAvailable(res)
          return
        }
        // A link to the database stays, and the file it points to goes, so
        // that the empty database is created where the user put the old one.
        const file = join(dataDir, 'tracks.db')
        resetting = true
        void (async () => {
          let target: string
          try {
            target = await followLinksAsync(file)
          } catch (err) {
            unreachable(err)
            return
          }
          // As after the stop below, the server's restart or stop while the
          // link was followed wins.
          if (lifecycle !== asked) {
            res
              .status(409)
              .json({ message: 'The plugin was restarted or stopped while the delete waited; nothing was deleted.' })
            return
          }
          const stopping = plugin.stop()
          const stopped = lifecycle
          await stopping
          if (lifecycle !== stopped) {
            // The server's restart or stop wins: removing the file under a
            // store it opened, or starting a plugin it stopped, would leave
            // two instances or one it does not know about.
            res
              .status(409)
              .json({ message: 'The plugin was restarted or stopped while the delete waited; nothing was deleted.' })
            return
          }
          let restarted: number
          let moved: boolean
          try {
            // Followed again now that the plugin has stopped: a link changed
            // meanwhile deletes nothing, rather than a file it no longer
            // points to. Synchronous, as the delete is, so that neither the
            // server's restart nor its stop lands between them and the start
            // below. The follow before the stop, and the close of a store that
            // was open, reach the disk first and off the event loop: only a
            // disk that stops answering in the moment between holds the
            // server here.
            let now: string | undefined
            try {
              now = followLinks(file)
            } catch (err) {
              app.error(`Not deleting the track database, which can no longer be reached: ${errorDetail(err)}`)
            }
            moved = now !== target
            if (!moved) {
              // SQLite keeps the -wal and -shm beside the file a link points
              // to, and on Windows beside the link. They go first: refused
              // part way, the delete then leaves a database that opens, rather
              // than a stray -wal beside an empty one. And before them a
              // rewrite for a newer schema that a crash left half built, which
              // is built beside the file a link points to too.
              for (const base of new Set([target, file])) {
                for (const suffix of ['.migrating', '-wal', '-shm']) rmSync(`${base}${suffix}`, { force: true })
              }
              rmSync(target, { force: true })
            }
          } finally {
            // Started again whatever the delete did, so a file that would not
            // go leaves the plugin recording to it rather than stopped.
            const starting = plugin.start(config)
            restarted = lifecycle
            await starting
          }
          if (moved) {
            res.status(409).json({
              message:
                'The track database changed or could no longer be reached while the delete waited; nothing was deleted.',
            })
            return
          }
          // A store the server stopped or replaced meanwhile is not one that
          // failed to open.
          if (!tracks && lifecycle === restarted) {
            app.error('Deleted the track database, but the new one did not open')
            res.status(500).json({
              message: 'The track database was deleted, but the plugin could not start again. The server log says why.',
            })
            return
          }
          app.debug('Deleted the whole track database on request')
          res.json({ deleted: true })
        })()
          .catch((err: unknown) => {
            app.error(`Could not delete the track database: ${errorDetail(err)}`)
            if (!res.headersSent) res.status(500).json({ message: 'Could not delete the track database' })
          })
          .finally(() => {
            resetting = false
          })
      })

      router.get('/recycle-bin', (_req: Request, res: Response) => {
        const store = tracks
        if (!store?.binEntries) {
          notAvailable(res)
          return
        }
        Promise.resolve(store.binEntries())
          .then((entries) => res.json(entries.map(binEntryJson)))
          .catch(failed(res))
      })
      router.post('/recycle-bin/:id/restore', (req: Request, res: Response) => {
        const found = binStore(req, res)
        if (!found) return
        Promise.resolve(found.store.restoreFromBin!(found.id))
          .then((result) => {
            deletedSpans = undefined
            if (result === 'restored') {
              res.json({})
            } else if (result === 'missing') {
              res.status(404).json({ message: 'No such entry in the recycle bin' })
            } else {
              res.status(409).json({ message: 'The whole track is in the recycle bin too; restore it first' })
            }
          })
          .catch(failed(res))
      })
      router.delete('/recycle-bin/:id', (req: Request, res: Response) => {
        const found = binStore(req, res)
        if (!found) return
        Promise.resolve(found.store.purgeFromBin!(found.id))
          .then((purged) => {
            if (purged) {
              res.json({})
            } else {
              res.status(404).json({ message: 'No such entry in the recycle bin' })
            }
          })
          .catch(failed(res))
      })

      // The import of the own vessel's track from a history provider, and
      // how far it got. Admin-only, as the recycle bin is: it writes into the
      // recording.
      const importFailed = (res: Response) => (err: unknown) => {
        app.error(`History import: ${errorDetail(err)}`)
        if (!res.headersSent) {
          res.status(500).json({ message: 'Track storage failed' })
        }
      }
      router.get('/history-import', (_req: Request, res: Response) => {
        const store = tracks
        if (!store?.historyImport) {
          notAvailable(res)
          return
        }
        Promise.all([historyProviderAvailable(app), store.historyImport(app.selfContext)])
          .then(([provider, stored]) => {
            const run = historyImport
            // The run's own state is the newer one while it writes a day, and
            // the only one with the error when the store could not save it.
            const state = run ? run.state : stored
            res.json({ provider, ...(state ? { state: historyImportJson(state, run?.running === true) } : {}) })
          })
          .catch(importFailed(res))
      })
      router.post('/history-import', (_req: Request, res: Response) => {
        const store = tracks
        if (!store?.historyImport || !store.saveHistoryImport) {
          notAvailable(res)
          return
        }
        if (historyImport?.running || historyImportStarting) {
          res.status(409).json({ message: 'The history import is already running' })
          return
        }
        historyImportStarting = true
        void (async () => {
          if (!(await historyProviderAvailable(app))) {
            res.status(409).json({ message: 'No history provider is installed to import from' })
            return
          }
          const previous = await store.historyImport!(app.selfContext)
          // Unfinished, it goes on from the day it stopped at. Finished, it
          // starts over, and fills only what is still missing: what the last
          // one filled is the recording now.
          const state: HistoryImportState =
            previous && previous.finishedAt === undefined
              ? previous
              : { context: app.selfContext, startedAt: Date.now(), filled: 0 }
          await store.saveHistoryImport!(state, [])
          if (tracks !== store) {
            notAvailable(res)
            return
          }
          startHistoryImport(state)
          res.status(202).json({ state: historyImportJson(historyImport?.state ?? state, true) })
        })()
          .catch(importFailed(res))
          .finally(() => {
            historyImportStarting = false
          })
      })
      return router
    },

    getTracks: () => tracks,

    id: PLUGIN_ID,
    name: 'Tracks',
    description: 'Record vessel tracks to SQLite and serve them through the track API',
    schema: {
      type: 'object',
      properties: {
        resolution: {
          type: 'integer',
          minimum: 0,
          title: 'Track resolution (milliseconds)',
          default: DEFAULT_RESOLUTION,
        },
        recordOtherVessels: {
          type: 'boolean',
          title: 'Record other vessels (AIS)',
          description:
            "Records the tracks of AIS targets and every other vessel the server reports, beside the own vessel's. Turned off, only the own vessel is recorded: nothing more of another vessel is recorded, its name included, so a chart plotter that draws trails from this plugin, such as Freeboard, draws no new ones for them. What was recorded of them before stays until the days to keep them below run out, or for good with those at 0.",
          default: true,
        },
        aisRetentionDays: {
          type: 'integer',
          minimum: 0,
          title: "Days to keep other vessels' positions",
          description:
            "The own vessel is not affected: its track is kept unless the danger zone below says otherwise. Other vessels' positions are removed once older than this, and a vessel with none left is dropped: a busy harbour puts hundreds of AIS targets past the receiver in a day, and a neighbour that never leaves range would otherwise grow without bound. 0 keeps them indefinitely.",
          default: DEFAULT_AIS_RETENTION_DAYS,
        },
        segmentGapMinutes: {
          type: 'integer',
          title: 'Split a track after this many minutes without a fix',
          description:
            'A gap longer than this starts a new track segment, so a stop overnight or a spell out of AIS range does not draw a straight line across it. 0 (the default) returns the track as a single line, as before. Note that slow-updating AIS targets can legitimately go many minutes between fixes, so a low value will fragment their tracks.',
          default: DEFAULT_SEGMENT_GAP_MINUTES,
        },
        recycleBinDays: {
          type: 'integer',
          minimum: 1,
          title: 'Days to keep a deleted track in the recycle bin',
          description:
            'A deleted track, or part of one, can be restored from the recycle bin in the Tracks webapp until it is purged after this many days.',
          default: DEFAULT_RECYCLE_BIN_DAYS,
        },
        storageTolerance: {
          type: 'number',
          minimum: 0,
          title: 'Simplify stored tracks older than a day to this many metres',
          description:
            "Keeps reads fast on a small board. Once a day is a day old, a position that lies within this distance of the line its neighbours draw is deleted, as simplifying the track to it would leave it out, keeping at least one a minute. 0.5 m is below a GPS's own noise. What is deleted cannot be brought back: to keep every position, archive a copy elsewhere, a GPX export of the track or a history provider such as signalk-questdb. 0 turns it off, and detail recorded finer than the track resolution is thinned back to it after a day instead.",
          default: DEFAULT_STORAGE_TOLERANCE,
        },
        maxSpeedKnots: {
          type: 'integer',
          title: 'Discard positions implying a speed above this (knots)',
          description:
            'A receiver occasionally reports a position far from the vessel. On a live map it flickers past; in a stored track it is permanent, stretching the bounding box and drawing a line across the chart. A fix that would require travelling faster than this since the previous one is discarded. The default is well above any real vessel, and glitches miss it by orders of magnitude. 0 disables the check.',
          default: DEFAULT_MAX_SPEED_KNOTS,
        },
        pauseWhenState: {
          type: 'array',
          title: 'Pause recording while navigation.state is one of',
          description:
            "Stops recording the own vessel while it is not going anywhere, so a winter on a mooring costs no rows. Needs navigation.state to be set, by signalk-autostate or by hand. By default it pauses while moored, not-under-way or aground; clear the list to always record. Note that 'anchored' is offered but rarely wanted: an anchor alarm watches exactly the track a vessel makes while swinging on its rode. AIS targets are never gated, since their status comes from the transponder and is often stale.",
          items: {
            type: 'string',
            enum: [...PAUSABLE_STATES],
          },
          uniqueItems: true,
          default: DEFAULT_PAUSE_STATES,
        },
        stateResolutions: {
          type: 'array',
          title: 'Own vessel resolution by navigation.state',
          description:
            'Records the own vessel at a different spacing while navigation.state has the given value, finer or coarser than the track resolution. The default records every second at anchor, so an anchor alarm or a look back at the night sees the swing around the anchor. After a day it is simplified with the rest of the track, which keeps the swing, or, with that turned off, thinned back to the track resolution. Needs navigation.state to be set, by signalk-autostate or by hand.',
          items: {
            type: 'object',
            required: ['state', 'resolution'],
            properties: {
              state: { type: 'string', title: 'navigation.state', examples: ['anchored', 'moored', 'sailing'] },
              resolution: { type: 'integer', minimum: 0, title: 'Resolution (milliseconds)' },
            },
          },
          default: DEFAULT_STATE_RESOLUTIONS,
        },
        otherVesselsResolution: {
          type: 'integer',
          minimum: 0,
          title: 'Resolution for other vessels (milliseconds)',
          description:
            'Spacing of recorded fixes for AIS and other vessels. Leave empty to use the track resolution. Their navigation.state is not used: it is what the transponder was last set to, and often stale.',
        },
        dangerZone: {
          type: 'object',
          title: 'Danger zone',
          description:
            'Settings here delete data for good. Nothing deleted by them goes to the recycle bin, and nothing can bring it back.',
          properties: {
            ownRetentionDays: {
              type: 'integer',
              minimum: 0,
              title: "Days to keep the own vessel's track",
              description:
                "0 (the default) keeps the own vessel's track indefinitely. Any other number PERMANENTLY DELETES the own vessel's positions once they are older than that many days, every hour, with no recycle bin and no way to restore them. That includes what GPX imports and the history import wrote into the own vessel's track; both leave out anything older than this. Other boats' imported tracks are not affected. To keep the own track, archive it elsewhere first: a GPX export, a backup of tracks.db, or a history provider.",
              default: 0,
            },
          },
        },
      },
    },
  }
  return plugin
}

export { fromGpx, toGpx } from './gpx.js'
export type { GpxExportTrack, GpxPoint, GpxTrack, GpxTrackIdentity } from './gpx.js'
export { Tracks, TrackAccumulator } from './tracks.js'
export { UnknownContextError } from './utils.js'
export type { TracksConfig } from './tracks.js'
export type { TrackStore } from './store.js'
export type * from './types.js'
