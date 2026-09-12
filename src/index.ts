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
import { createTrackProvider } from './trackProvider.js'
import type { TrackApi } from './trackApi.js'
import { SqliteTrackStore } from './sqliteStore.js'
import type { TrackStore } from './store.js'
import { DEFAULT_MAX_SPEED_KNOTS, GlitchFilter } from './glitchFilter.js'
import { reconcile } from './reconcile.js'
import { SourceWatch } from './sourceWatch.js'
import { DEFAULT_PAUSE_STATES, PAUSABLE_STATES, StateGate } from './stateGate.js'
import { toGpx } from './gpx.js'
import { parseTrackQuery, segment, thin, TimeWindowError } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import type {
  Context,
  Debug,
  LatLngTuple,
  LngLatTuple,
  Position,
  TimedPosition,
  TimeWindow,
  TimedTrackCollection,
  TrackCollection,
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
  /**
   * Contexts the provider holds data for, within a time range.
   *
   * Optional here though the upstream interface requires it: a provider
   * registered against an older server-api may not implement it, and a missing
   * method must degrade rather than throw.
   */
  getContexts?(query: HistoryContextsQuery): Promise<unknown[]>
}

/** `ContextsRequest` upstream: a time range, with Instants rather than strings. */
interface HistoryContextsQuery {
  from: Temporal.Instant
  to: Temporal.Instant
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
  start: (c: TracksPluginConfig) => void
  /** Enable on install, without waiting for a visit to the plugin config page. */
  enabledByDefault: boolean
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

interface TracksPluginConfig {
  resolution?: number
  /** Days of the own vessel's track to keep. 0 keeps everything. */
  retentionDays?: number
  /** Days another vessel is kept after its last fix. 0 keeps every vessel. */
  aisRetentionDays?: number
  /** Minutes without a fix that start a new track segment. 0 disables. */
  segmentGapMinutes?: number
  /** Speed above which a position is treated as a glitch. 0 disables. */
  maxSpeedKnots?: number
  /** navigation.state values that pause recording of the own vessel. */
  pauseWhenState?: string[]
}

const toLngLat = ([lat, lng]: LatLngTuple): LngLatTuple => [lng, lat]

const DEFAULT_RESOLUTION = 60000
// How long a vessel other than the own one is kept after its last fix. The own
// vessel is never dropped — see TrackStore.prune. A month is long enough that a
// passage last week is still there to compare against, and short enough that a
// season in a busy harbour does not accumulate every target that ever passed.
const DEFAULT_AIS_RETENTION_DAYS = 30

// A vessel that has aged out is not urgent, so this need not be frequent.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
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
 * How long a history provider gets to answer a query before the store answers
 * alone.
 *
 * The provider is an enrichment, not a dependency: a track is still correct
 * without it, just coarser. Long enough for a database that has to warm up,
 * short enough that a wedged provider does not hold a request open.
 */
const HISTORY_QUERY_TIMEOUT_MS = 5000

/**
 * How far back a query with no window of its own reaches when the store is
 * empty.
 *
 * There is nothing else to derive a span from, and asking a provider for all
 * of time would be expensive on a large one. A day covers the usual reason for
 * a windowless request — draw the recent trail — and an explicit `from`,
 * `duration` or `timespan` reaches further.
 */
const WINDOWLESS_HISTORY_SPAN_MS = 24 * 60 * 60 * 1000

/**
 * The earliest instant the existence probe asks about.
 *
 * The probe has to name a bound: the History API's time range has no
 * unbounded form, every branch of `TimeRangeParams` carries one. A provider
 * filters its context list by the range it is given — questdb builds a SQL
 * `WHERE` from it — so any bound later than the provider's oldest row can
 * still miss a vessel and 404 it, which is the case the probe exists to catch.
 *
 * The Unix epoch is the bound rather than some span of years: it predates
 * satellite navigation, so no position fix can lie before it, and unlike a
 * fixed "wide enough" window it cannot be outlived. The cost lands only on the
 * branch that was already about to 404, and the answer is cached.
 */
const EXISTENCE_PROBE_FROM_MS = 0

/**
 * How long a provider's context list is reused before asking again.
 *
 * The probe runs only for a vessel about to 404, which is precisely the
 * request a client can repeat without limit — the routes are open, so
 * enumerating vessel ids would otherwise drive one epoch-wide `getContexts`
 * per request, each able to block for the timeout.
 *
 * The whole list is cached rather than a per-context answer, or enumeration
 * would simply fill the cache with distinct keys and query just as often. The
 * cost is that a vessel a provider learns about becomes visible up to this
 * long after the fact, which is not a delay anyone can perceive in a track
 * that is already minutes old.
 */
const KNOWN_CONTEXTS_TTL_MS = 30_000

/**
 * How long a *failed* context query is remembered.
 *
 * Short, so a provider that recovers is noticed quickly, but not zero: with
 * the entry simply dropped, a provider that hangs is asked again by every
 * subsequent miss while the earlier calls are still pending — reinstating per
 * request exactly the cost the cache exists to prevent.
 */
const KNOWN_CONTEXTS_FAILURE_TTL_MS = 1_000

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

/**
 * The history provider could not answer, and nothing else could either.
 *
 * Distinct from a missing track: a 404 asserts that no source knows the
 * vessel, which a failed provider read cannot support. Reporting the failure
 * as an empty track would present an outage as "this vessel has no positions
 * here" — the one answer that is certainly wrong.
 */
class HistoryUnavailableError extends Error {}

const errorDetail = (err: unknown): string => (err instanceof Error && err.stack ? err.stack : String(err))

/**
 * A window covering everything the store holds, up to now.
 *
 * Used when a query names no window of its own, so a history provider can
 * still be asked something concrete. Undefined when the store is empty, since
 * there is then no span to ask about.
 */
function windowSpanning(stored: TimedPosition[], fallbackMs: number): TimeWindow {
  const to = Date.now()
  if (stored.length === 0) {
    // Nothing stored says nothing about what a provider holds: a vessel
    // recorded only by the provider — before this plugin was installed, say —
    // would otherwise never be asked about and 404.
    return { from: to - fallbackMs, to, inclusiveEnd: true }
  }
  let from = stored[0]!.timestamp
  for (const point of stored) {
    if (point.timestamp < from) from = point.timestamp
  }
  return { from, to, inclusiveEnd: true }
}

/**
 * Reject once `ms` has passed.
 *
 * Written out rather than `Promise.race` so the timer is cleared when the
 * promise wins. A race leaves it armed, holding the event loop open for the
 * remainder of the timeout on every call that succeeds.
 */
/**
 * A bound expired. Distinct from the error a provider itself raises, because
 * "did not answer in time" and "is not installed" are different answers and
 * only one of them is an outage.
 */
class HistoryTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HistoryTimeoutError(`timed out after ${ms}ms`)), ms)
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

/**
 * A cache entry holding the promise rather than its value, so callers that
 * arrive while a query is still running join it instead of starting another.
 */
interface KnownContexts {
  at: number
  contexts: Promise<ReadonlySet<string>>
}

/**
 * Whether a history provider holds anything at all for a context.
 *
 * Asked only when a track is about to 404: `getValues` narrowed to a window
 * cannot tell "this vessel is unknown" from "this vessel has nothing *here*",
 * and 404ing on the second is wrong — the contract is that a 404 means neither
 * source knows the vessel. A vessel whose history lies wholly outside the
 * asked window is known, and deserves an empty track.
 *
 * Best-effort, like every other provider call here: a provider that lacks the
 * method, errors, or hangs leaves the 404 standing rather than holding the
 * request open.
 */
async function historyKnowsContext(
  app: App,
  context: Context,
  debug: Debug,
  cache: { current: KnownContexts | undefined },
): Promise<boolean> {
  const getHistoryApi = app.getHistoryApi
  if (!getHistoryApi) {
    return false
  }
  try {
    const now = Date.now()
    // Reused while fresh, and shared while in flight: a burst of misses is one
    // question to the provider, not one each. The promise is cached rather than
    // its result so concurrent callers join the same query instead of starting
    // their own.
    //
    // Resolving the provider is inside the cached promise, not before it: a
    // slow or failing `getHistoryApi` would otherwise be paid per request, and
    // could time out into a 404 for a vessel the cached list already knows.
    const cached = cache.current
    if (cached === undefined || now - cached.at >= KNOWN_CONTEXTS_TTL_MS) {
      const contexts = withTimeout(
        getHistoryApi(app.config?.settings?.historyApi?.defaultProvider)
          .then((historyApi) =>
            historyApi.getContexts
              ? historyApi.getContexts({
                  from: Temporal.Instant.from(new Date(EXISTENCE_PROBE_FROM_MS).toISOString()),
                  to: Temporal.Instant.from(new Date(now).toISOString()),
                })
              : // A provider built against an older server-api has no such
                // method. Nothing is known, and that is a cacheable answer.
                [],
          )
          // Indexed once per fetch rather than scanned per request: the branch
          // that consults this is the one an open route lets a client repeat
          // without limit, and a provider on a busy install lists thousands of
          // vessels. The `vessels.self` spelling at least one provider returns
          // is resolved here, while `app.selfContext` is a single fixed value,
          // so the lookup itself is a plain membership test.
          .then(
            (listed) =>
              new Set(
                (listed ?? [])
                  .filter((c): c is string => typeof c === 'string')
                  .map((c) => (c === 'vessels.self' ? app.selfContext : c)),
              ) as ReadonlySet<string>,
          ),
        HISTORY_QUERY_TIMEOUT_MS,
      )
      // Dropped on failure so the next miss retries rather than inheriting a
      // rejection for the rest of the window. The catch is attached here, not
      // awaited, so a rejection never escapes as an unhandled one.
      const entry: KnownContexts = { at: now, contexts }
      contexts.catch(() => {
        if (cache.current === entry) {
          // Back-dated rather than dropped: the next miss after the failure
          // window retries, while a burst inside it does not re-ask.
          cache.current = { at: now - KNOWN_CONTEXTS_TTL_MS + KNOWN_CONTEXTS_FAILURE_TTL_MS, contexts }
        }
      })
      cache.current = entry
    }
    return (await cache.current!.contexts).has(context)
  } catch (err) {
    debug(`History contexts unavailable for ${context}: ${errorDetail(err)}`)
    return false
  }
}

/**
 * Positions a history provider holds for a window, or none.
 *
 * Best-effort by design: a provider that is absent, slow, or failing must not
 * fail the query, because the plugin's own store can always answer it. The
 * provider is the finer source where it reaches, not a required one.
 */
async function historyPositions(
  app: App,
  context: Context,
  window: TimeWindow,
  resolutionMs: number,
  debug: Debug,
): Promise<{ points: TimedPosition[]; resolutionMs: number; failed: boolean }> {
  // The API takes whole seconds, so the width the provider actually bucketed
  // by is not necessarily the one asked for. Reconciling on the requested
  // width would leave a stored point in a bucket history already covered, and
  // keep both.
  const providerSeconds = Math.max(1, Math.round(resolutionMs / 1000))
  const applied = providerSeconds * 1000
  const getHistoryApi = app.getHistoryApi
  if (!getHistoryApi) {
    // Not a failure: no provider installed is the documented normal case, and
    // the store answers alone. Only a provider that was asked and could not
    // answer counts as one.
    return { points: [], resolutionMs: applied, failed: false }
  }
  // Resolved in its own step, because failing to reach a provider and failing
  // to read one are different answers. The server rejects this call outright
  // when no provider is registered — the default install — and a service that
  // is not installed cannot be having an outage. Only a read that fails after
  // a provider was obtained is one.
  let historyApi: HistoryApi
  try {
    // Bounded because both awaits reach third-party code. Without this a
    // provider that never settles holds the request open, and the store
    // fallback below is never reached — which would make the "best-effort"
    // this function promises untrue.
    historyApi = await withTimeout(
      getHistoryApi(app.config?.settings?.historyApi?.defaultProvider),
      HISTORY_QUERY_TIMEOUT_MS,
    )
  } catch (err) {
    // A provider that was registered but did not answer in time is an outage;
    // only the server's own rejection means there is nothing installed to ask.
    const timedOut = err instanceof HistoryTimeoutError
    if (debug.enabled) {
      debug(`${timedOut ? 'History provider timed out' : 'No history provider'} for ${context}: ${errorDetail(err)}`)
    }
    return { points: [], resolutionMs: applied, failed: timedOut }
  }
  try {
    const response = await withTimeout(
      historyApi.getValues({
        context,
        // Instants, not ISO strings: providers call Instant methods on these.
        from: Temporal.Instant.from(new Date(window.from).toISOString()),
        to: Temporal.Instant.from(new Date(window.to).toISOString()),
        pathSpecs: [{ path: 'navigation.position', aggregate: 'first' }],
        resolution: providerSeconds,
      }),
      HISTORY_QUERY_TIMEOUT_MS,
    )
    const points: TimedPosition[] = []
    for (const row of response?.data ?? []) {
      const position = historyRowPosition(row)
      // A row with no position means the provider had none for that bucket,
      // which is what lets the store fill it.
      if (position) {
        const timestamp = historyRowTimestamp(row)
        // Clipped to the window rather than trusted: a provider that returns a
        // wider range would otherwise widen the answer beyond what was asked.
        // Matching the stores, which treat a window without `inclusiveEnd`
        // as half-open so consecutive bands tile without repeating the point
        // they share. Clipping inclusively here would reintroduce exactly
        // that duplicate from the provider side.
        const withinEnd = window.inclusiveEnd ? timestamp <= window.to : timestamp < window.to
        if (timestamp >= window.from && withinEnd) {
          points.push({ position, timestamp })
        }
      }
    }
    if (debug.enabled) {
      debug(`History supplied ${points.length} position(s) for ${context}`)
    }
    return { points, resolutionMs: applied, failed: false }
  } catch (err) {
    if (debug.enabled) {
      debug(`History unavailable for ${context}: ${errorDetail(err)}`)
    }
    // Reported rather than swallowed. The store still answers where it can —
    // a provider is an enrichment, not a dependency — but a caller with
    // nothing else to serve has to be able to tell "no positions" from "could
    // not ask".
    return { points: [], resolutionMs: applied, failed: true }
  }
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

export default function ThePlugin(app: App): Plugin {
  let onStop: (() => void)[] = []
  let tracks: TrackStore | undefined = undefined
  let segmentGap = 0
  /**
   * How often the store keeps a position, in ms.
   *
   * Used as the bucket width when reconciling with a history provider, so the
   * two sources land on the same grid when a query names no resolution of its
   * own.
   */
  let storeResolution = DEFAULT_RESOLUTION
  const sourceWatch = new SourceWatch()
  let glitchFilter = new GlitchFilter({ maxSpeedKnots: DEFAULT_MAX_SPEED_KNOTS })
  let stateGate = new StateGate(app.selfContext, DEFAULT_PAUSE_STATES)
  /**
   * The history provider's context list, cached between existence probes.
   *
   * Per plugin instance rather than module-global: two instances would
   * otherwise answer from each other's provider.
   */
  const knownContexts: { current: KnownContexts | undefined } = { current: undefined }

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

  return {
    start: function (config: TracksPluginConfig) {
      const { resolution } = config
      storeResolution = toNumber(config.resolution) ?? DEFAULT_RESOLUTION
      const segmentGapMinutes = toNumber(config.segmentGapMinutes) ?? DEFAULT_SEGMENT_GAP_MINUTES
      segmentGap = segmentGapMinutes > 0 ? segmentGapMinutes * 60 * 1000 : 0

      // Rebuilt on every start so a changed ceiling takes effect, and so the
      // reference positions do not survive a restart the user made precisely
      // because the track looked wrong.
      glitchFilter = new GlitchFilter({
        maxSpeedKnots: toNumber(config.maxSpeedKnots) ?? DEFAULT_MAX_SPEED_KNOTS,
      })
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
      try {
        tracks = new SqliteTrackStore(
          {
            file: join(dataDir, 'tracks.db'),
            resolution: toNumber(resolution) ?? DEFAULT_RESOLUTION,
            retention: (toNumber(config.retentionDays) ?? 0) * 24 * 60 * 60 * 1000,
            segmentGap,
          },
          app.debug,
        )
      } catch (err) {
        app.error(`Could not open the track database in ${dataDir}: ${errorDetail(err)}`)
        return
      }
      onStop.push(
        app.streambundle.getBus('navigation.position').onValue((update: ContextPosition): void => {
          if (!update.value || update.value.latitude == null || update.value.longitude == null) return
          sourceWatch.add(update.context, update.$source)
          // Prefer the delta's own timestamp so a replayed or delayed update is
          // filed at the time it was recorded, not the time it arrived.
          const recorded = update.timestamp === undefined ? undefined : Date.parse(update.timestamp)
          const timestamp = recorded !== undefined && !Number.isNaN(recorded) ? recorded : undefined
          const position: LatLngTuple = [update.value.latitude, update.value.longitude]
          // Read per delta rather than subscribed to: navigation.state changes
          // rarely, and the current value is what matters at the moment a
          // position arrives.
          if (!stateGate.accept(update.context, getVesselState())) {
            return
          }
          // Filtered here rather than in each store: both would otherwise need
          // the same check, and a rejected fix should reach neither.
          if (!glitchFilter.accept(update.context, position, timestamp ?? Date.now())) {
            return
          }
          tracks?.newPosition(update.context, position, timestamp)
        }),
      )
      // Days rather than the seconds the old maxAge used: this is about how long
      // a passing vessel stays interesting, not about clearing a live display.
      // 0 keeps every vessel forever.
      const aisRetentionMs = (toNumber(config.aisRetentionDays) ?? DEFAULT_AIS_RETENTION_DAYS) * 24 * 60 * 60 * 1000
      // prune() does two things: drop whole contexts that have gone quiet, and
      // apply the own vessel's row-level retention. They are configured
      // separately, so it runs whenever either is set — gating the call on the
      // AIS setting alone meant `aisRetentionDays: 0` silently disabled the
      // own vessel's retention too. A maxAge of Infinity ages nothing out.
      const pruneInterval = setInterval(() => {
        tracks?.prune(aisRetentionMs > 0 ? aisRetentionMs : Infinity, app.selfContext)
      }, PRUNE_INTERVAL_MS)
      onStop.push(() => {
        clearInterval(pruneInterval)
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
        const status = stateGate.status() ?? sourceWatch.warning(app.selfContext) ?? 'Recording tracks'
        if (status !== lastStatus) {
          lastStatus = status
          app.setPluginStatus?.(status)
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
      app.registerTrackApiProvider?.(
        createTrackProvider({
          store: () => tracks,
          selfContext: () => app.selfContext,
          segmentGap: () => segmentGap,
          contextName: (context: string) => contextName(context, (path: string) => app.getPath?.(path)),
          // The same reconciliation the v1 routes have done since #73. Without
          // it the plugin answers differently depending on which route a client
          // uses: the store alone through v2, the store enriched by a history
          // provider through v1.
          reconcileWithHistory: async (context, stored, window, resolutionMs) => {
            const effective = resolutionMs ?? storeResolution
            // A query with no window still gets history, for the same reason
            // the v1 route does: a context recorded only by the provider —
            // before this plugin was installed — would otherwise never be asked
            // about.
            const asked = window ?? windowSpanning(stored, WINDOWLESS_HISTORY_SPAN_MS)
            const history = await historyPositions(app, context, asked, effective, app.debug)
            // `failed` is deliberately not escalated here: the v2 contract has
            // no per-context error and no 404, so a provider outage degrades to
            // the store's own points rather than failing a multi-context query
            // for every other vessel in it.
            return history.points.length ? reconcile(history.points, stored, history.resolutionMs).positions : stored
          },
        }),
      )
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
      glitchFilter.clear()
      stateGate.clear()
      // A restart often follows a provider change; keeping the old list would
      // answer from a provider that is no longer the one installed.
      knownContexts.current = undefined
      // Release the file handle a sqlite store holds, so a plugin restart does
      // not leak it and the WAL gets checkpointed.
      //
      // A stopped plugin serves nothing: closing the database releases the file
      // handle and checkpoints the WAL, so the routes answer 404 until the next
      // start() builds a fresh store. They stay mounted and degrade rather than
      // throw, because the server calls stop() on a config save.
      try {
        tracks?.close?.()
      } catch (err) {
        app.error(err)
      } finally {
        // Cleared even when close() throws: a closed store is worse than none.
        // The next start() can fail — an unusable data directory, say — and
        // without this getTracks() and the registered provider keep handing out
        // a handle that rejects every query with "database is closed".
        tracks = undefined
      }
    },

    signalKApiRoutes: function (router: Router) {
      // Resolved per request rather than cached: an AIS target's static report
      // can arrive long after its first position, so a track named from the
      // MMSI early on picks up the real name as soon as the server has it.
      const nameOf = (context: string) => trackLabel(context, app.selfContext, (path: string) => app.getPath?.(path))

      /**
       * The points of one context, reconciled with history and segmented.
       *
       * Shared by the JSON and GPX routes so the two cannot answer the same
       * question differently: the history reconciliation, the windowless
       * fallback and the 404-only-for-an-unknown-vessel rule are subtle enough
       * that a second copy would drift.
       *
       * Rejects with `undefined` when neither source knows the vessel at all.
       */
      const readSegments = async (context: string, query: TrackQuery): Promise<TimedPosition[][] | undefined> => {
        const effectiveResolution = query.resolution ?? storeResolution
        const { points: stored, known } = await tracks!
          // Resolving instead of rejecting for an unknown context: a vessel
          // the store has never seen may still be in a history provider —
          // recorded before this plugin was installed, say — and 404ing
          // before asking would hide data that exists.
          .getTimed(context, query.window)
          .then((points) => ({ points, known: true }))
          .catch(() => ({ points: [] as TimedPosition[], known: false }))
        // A history provider is the finer source for as long as its retention
        // reaches; the store is what remains of everything older, and of any
        // period the provider missed. A query with no window still gets
        // history: `/self/track` with no parameters is the common case, and
        // skipping the provider there would quietly serve store-only data.
        const window = query.window ?? windowSpanning(stored, WINDOWLESS_HISTORY_SPAN_MS)
        const history = await historyPositions(app, context, window, effectiveResolution, app.debug)
        const points = history.points.length
          ? reconcile(history.points, stored, history.resolutionMs).positions
          : stored
        // 404 only for a vessel neither source knows at all. A known vessel
        // with nothing inside the window is an empty track, not a missing one.
        //
        // The provider is asked a second time here, and only here: `getValues`
        // narrowed to a window cannot distinguish an unknown vessel from one
        // whose history lies outside it. That second question is deliberately
        // not scoped to the window, for the same reason.
        if (points.length === 0) {
          // Either source knowing the vessel is enough: the store may hold it
          // with nothing inside the asked window, which is an empty track
          // rather than a missing one.
          const vesselKnown = known || (await historyKnowsContext(app, context, app.debug, knownContexts))
          if (!vesselKnown) {
            return undefined
          }
          // Known, but there is nothing to serve and the one source that might
          // have had something could not be read. Answering 200 here would
          // report an outage as an empty history.
          if (history.failed) {
            throw new HistoryUnavailableError(`History provider could not be read for ${context}`)
          }
        }
        return segment(thin(points, query.resolution), segmentGap)
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
            query = parseTrackQuery(req.query)
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
              // A provider outage is not a missing vessel. Reporting it as 404
              // told clients the track does not exist, which is the one thing
              // a failed read cannot establish.
              if (err instanceof HistoryUnavailableError) {
                app.error(`${err.message}`)
                res.status(503)
                res.json({ message: `Track history is temporarily unavailable for ${context}` })
                return
              }
              res.status(404)
              res.json({ message: `No track available for ${context}` })
            })
        }

      /**
       * One vessel's track as a GPX file.
       *
       * Serialised by `toGpx` rather than assembled here, so the export a user
       * downloads is the same document the module produces everywhere else.
       * The webapp cannot reach that module — it ships as static files with no
       * bundler — which is why the conversion lives behind a route instead of
       * being duplicated in the page.
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
          readSegments(context, query)
            .then((segments) => {
              if (segments === undefined) {
                res.status(404)
                res.json({ message: `No track available for ${context}` })
                return
              }
              const label = nameOf(context)
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
              res.send(toGpx([{ name: label, context, segments }]))
            })
            .catch((err: unknown) => {
              // Not a 404: `readSegments` already reported an unknown vessel by
              // resolving undefined, so anything reaching here is this route
              // failing -- serialisation, a header, a write. Reporting that as
              // "no track available" is what disguised an ERR_INVALID_CHAR
              // from a non-Latin-1 filename as a missing track.
              if (err instanceof HistoryUnavailableError) {
                app.error(`${err.message}`)
                if (!res.headersSent) {
                  res.status(503)
                  res.json({ message: `Track history is temporarily unavailable for ${context}` })
                }
                return
              }
              app.error(`Could not export GPX for ${context}: ${errorDetail(err)}`)
              if (!res.headersSent) {
                res.status(500)
                res.json({ message: `Could not export the track for ${context}` })
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
        const params = validateParameters(req.query, undefined)
        const selfPosition = getVesselPosition()

        // Two paths on purpose. Without `times` the response keeps its
        // long-standing shape exactly — one un-segmented line per vessel — so
        // existing clients are unaffected. With `times` the track is segmented
        // like the single-vessel route, because a times array can only line up
        // with coordinates if both are split the same way.
        const result = query.times
          ? tracks.getFilteredTimedTracks(params, selfPosition, app.debug, query).then((tc: TimedTrackCollection) =>
              Object.entries(tc).reduce<AllTracksResult>((acc, [context, points]) => {
                const segments = segment(points, segmentGap)
                acc[context] = {
                  type: 'MultiLineString',
                  coordinates: segments.map((s) => s.map(({ position }) => toLngLat(position))),
                  times: segments.map(toIsoTimes),
                  isSelf: context === app.selfContext,
                  name: nameOf(context),
                }
                return acc
              }, {}),
            )
          : tracks.getFilteredTracks(params, selfPosition, app.debug, query).then((tc: TrackCollection) =>
              Object.entries(tc).reduce<AllTracksResult>((acc, [context, track]) => {
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
    // On by default: a track recorder that records nothing until someone finds
    // and enables it loses exactly the passage the user wanted kept.
    enabledByDefault: true,
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
        retentionDays: {
          type: 'integer',
          minimum: 0,
          title: "Days of the own vessel's track to keep",
          description:
            'Positions older than this are deleted. 0, the default, keeps everything — a track is worth more the longer it goes back, and a year of one vessel at the default resolution is a few megabytes.',
          default: 0,
        },
        aisRetentionDays: {
          type: 'integer',
          minimum: 0,
          title: 'Days to keep another vessel after its last fix',
          description:
            'The own vessel is never removed. Other vessels are: a busy harbour puts hundreds of AIS targets past the receiver in a day, and keeping all of them forever is rarely what anyone wants. 0 keeps every vessel indefinitely.',
          default: DEFAULT_AIS_RETENTION_DAYS,
        },
        segmentGapMinutes: {
          type: 'integer',
          title: 'Split a track after this many minutes without a fix',
          description:
            'A gap longer than this starts a new track segment, so a stop overnight or a spell out of AIS range does not draw a straight line across it. 0 (the default) returns the track as a single line, as before. Note that slow-updating AIS targets can legitimately go many minutes between fixes, so a low value will fragment their tracks.',
          default: DEFAULT_SEGMENT_GAP_MINUTES,
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
            "Stops recording the own vessel while it is not going anywhere, so a winter on a mooring costs no rows. Needs navigation.state to be set, by signalk-autostate or by hand. Leave empty (the default) to always record. Note that 'anchored' is offered but rarely wanted: an anchor alarm watches exactly the track a vessel makes while swinging on its rode. AIS targets are never gated, since their status comes from the transponder and is often stale.",
          items: {
            type: 'string',
            enum: [...PAUSABLE_STATES],
          },
          uniqueItems: true,
          default: DEFAULT_PAUSE_STATES,
        },
      },
    },
  }
}

export { fromGpx, toGpx } from './gpx.js'
export type { GpxTrack, GpxTrackIdentity } from './gpx.js'
export { Tracks, TrackAccumulator } from './tracks.js'
export type { TracksConfig } from './tracks.js'
export type { TrackStore } from './store.js'
export type * from './types.js'
