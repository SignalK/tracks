import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { Express } from 'express'
import ThePlugin from './index.js'
import type { ContextPosition } from './index.js'
import type { TrackApi } from './trackApi.js'
import type { Debug, LatLngTuple, Position } from './types.js'

/**
 * Test harness that stands the plugin up behind a real express app, mounted the
 * way the Signal K server mounts it (`app.use('/signalk/v1/api', …)`), so route
 * patterns and parameter parsing are exercised rather than mocked.
 *
 * Note the server runs express 4; `express` is pinned to ^4 in devDependencies
 * so the wildcard route syntax under test matches production.
 */

export const SELF_CONTEXT = 'vessels.urn:mrn:imo:mmsi:123456789'
export const OTHER_CONTEXT = 'vessels.urn:mrn:imo:mmsi:987654321'

type PositionListener = (update: ContextPosition) => void

export interface TestHarness {
  app: Express
  /**
   * Feed a position delta as the streambundle would. `timestamp` dates the
   * point, so time-window queries can be tested without faking the clock.
   *
   * Note `throttleTime` thins on the leading edge against the wall clock, so a
   * synchronous burst yields a single point regardless of the timestamps given.
   * Use `seedTrack` to install a back-dated track instead.
   */
  emit: (context: string, position: LatLngTuple, timestamp?: number, source?: string) => void
  /** Status messages the plugin has pushed to the server dashboard. */
  statuses: string[]
  /**
   * Install a track with explicit timestamps, bypassing the throttled bus. This
   * bypasses the throttle, which is what makes a back-dated track testable.
   */
  seedTrack: (context: string, positions: LatLngTuple[], timestamps: number[]) => void
  /** Self position as reported by `getSelfPath`, used for radius filtering. */
  setSelfPosition: (position: LatLngTuple | undefined) => void
  /** The own vessel's navigation.state, as reported by `getSelfPath`. */
  setSelfState: (state: string | undefined) => void
  stop: () => void
  /**
   * Start the same plugin instance again, with the config it was built with.
   *
   * A fresh harness would not do: what a restart has to show is the state the
   * instance drops on `stop()`, which a new instance never had.
   */
  restart: () => void
  /**
   * How many positions the plugin's bus subscription has accepted.
   *
   * Observable after stop(), when the store itself is closed and unreadable —
   * which is how a test can still tell that the subscription was torn down.
   */
  emitted: () => number
  errors: unknown[][]
  /**
   * The v2 Track API provider the plugin registered, or undefined when the
   * server offered no `registerTrackApiProvider`.
   */
  trackProvider: () => TrackApi | undefined
  /** How many times the plugin registered a provider. */
  registrations: () => number
}

export interface HarnessOptions {
  /** Plugin config overrides. Bootstrap is disabled by default so tests stay hermetic. */
  config?: Record<string, unknown>
  selfContext?: string
  selfPosition?: LatLngTuple
  /** Initial navigation.state for the own vessel. */
  selfState?: string
  /**
   * Data-model entries other vessels' paths resolve to, keyed by full path
   * (e.g. `vessels.urn:...:244813000.name`). Omit to stand in for an older
   * server with no `getPath`, where track naming falls back to the MMSI.
   */
  paths?: Record<string, unknown>
  /**
   * Stand in for a server without the v2 Track API, to check the plugin still
   * starts when `registerTrackApiProvider` is absent.
   */
  withoutTrackApi?: boolean
  /**
   * A history provider for the plugin to reconcile against.
   *
   * `contexts` is what `getContexts` lists, and `rows` what `getValues`
   * returns — separately, because the difference between them is the whole
   * point of the existence probe: a provider can know a vessel and still have
   * no rows inside the asked window.
   *
   * `contextsSince` back-dates those contexts: a real provider filters its
   * context list by the asked range (questdb builds a `WHERE` from it), so a
   * stub that answers regardless of range cannot show what the probe misses.
   * `getContextsRejects` and `getContextsHangs` cover the other two ways a
   * provider can fail to answer.
   */
  history?: {
    /** Read on every `getContexts` call, so a getter can count the probes. */
    contexts?: string[]
    contextsSince?: number
    rows?: unknown[]
    withoutGetContexts?: boolean
    getContextsRejects?: boolean
    getContextsHangs?: boolean
    /**
     * Hold every `getContexts` call open until the returned release is run.
     *
     * A provider that answers immediately cannot distinguish sharing an
     * in-flight query from reusing a cached result: the first caller would
     * have filled the cache before the rest arrived. Deferring the answer
     * parks every caller inside the probe at once, so only sharing can
     * collapse them.
     */
    deferContexts?: { release: () => void; wait: Promise<void> }
    /** Fail the windowed read, leaving the provider unable to answer at all. */
    getValuesRejects?: boolean
  }
}

/**
 * A promise held open until a test releases it.
 *
 * Lets a test observe that every request has reached the provider before any
 * answer exists, which a timed wait can only assume.
 */
export function deferred(): { release: () => void; wait: Promise<void> } {
  let release = () => undefined as void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, wait }
}

export function createHarness(options: HarnessOptions = {}): TestHarness {
  // SQLite is the only store, so the harness needs somewhere to put the file.
  // A fresh directory per harness keeps tests from sharing state.
  const dataDir = mkdtempSync(join(tmpdir(), 'sk-tracks-test-'))
  const listeners: PositionListener[] = []
  let emitted = 0
  const errors: unknown[][] = []
  const statuses: string[] = []
  let selfPosition: LatLngTuple | undefined = options.selfPosition
  let selfState: string | undefined = options.selfState
  const selfContext = options.selfContext ?? SELF_CONTEXT
  let trackProvider: TrackApi | undefined
  let registrations = 0

  const debug: Debug = Object.assign(() => undefined, { enabled: false })

  const app = {
    debug,
    error: (...args: unknown[]) => errors.push(args),
    setPluginStatus: (msg: string) => statuses.push(msg),
    selfContext,
    getDataDirPath: () => dataDir,
    ...(options.paths === undefined ? {} : { getPath: (path: string): unknown => options.paths?.[path] }),
    ...(options.history === undefined
      ? {}
      : {
          getHistoryApi: () =>
            Promise.resolve({
              getValues: () =>
                options.history?.getValuesRejects === true
                  ? Promise.reject(new Error('history provider unavailable'))
                  : Promise.resolve({
                      context: selfContext,
                      range: { from: '', to: '' },
                      values: [],
                      data: options.history?.rows ?? [],
                    }),
              ...(options.history?.withoutGetContexts === true
                ? {}
                : {
                    getContexts: (query: { from: { toString: () => string }; to: { toString: () => string } }) => {
                      if (options.history?.getContextsRejects === true) {
                        return Promise.reject(new Error('provider unavailable'))
                      }
                      if (options.history?.getContextsHangs === true) {
                        return new Promise<string[]>(() => undefined)
                      }
                      const contexts = options.history?.contexts ?? []
                      const since = options.history?.contextsSince
                      // Mirror a range-filtering provider: a context whose data
                      // predates the asked window is simply not listed.
                      const answer = since !== undefined && since < Date.parse(query.from.toString()) ? [] : contexts
                      const deferred = options.history?.deferContexts
                      return deferred ? deferred.wait.then(() => answer) : Promise.resolve(answer)
                    },
                  }),
            }),
        }),
    ...(options.withoutTrackApi
      ? {}
      : {
          registerTrackApiProvider: (provider: TrackApi) => {
            trackProvider = provider
            registrations += 1
          },
        }),
    // Path-aware: the plugin reads navigation.state as well as position, and a
    // stub that answered every path with a position would let a broken state
    // lookup pass unnoticed.
    getSelfPath: (path: string): unknown => {
      if (path === 'navigation.state') {
        return selfState === undefined ? undefined : { value: selfState }
      }
      return selfPosition
        ? { value: { latitude: selfPosition[0], longitude: selfPosition[1] } satisfies Position }
        : undefined
    },
    streambundle: {
      getBus: () => ({
        onValue: (cb: PositionListener) => {
          listeners.push(cb)
          return () => {
            const i = listeners.indexOf(cb)
            if (i >= 0) listeners.splice(i, 1)
          }
        },
      }),
    },
  }

  const plugin = ThePlugin(app)
  const startConfig = {
    // No minimum spacing, so a synchronous burst of fed positions is all kept.
    // The sqlite store enforces resolution on write rather than through rxjs
    // throttling, so 0 genuinely means every position lands.
    resolution: 0,
    ...options.config,
  }
  plugin.start(startConfig)

  const expressApp = express()
  expressApp.use('/signalk/v1/api', plugin.signalKApiRoutes(express.Router()))

  return {
    app: expressApp,
    emit: (context, position, timestamp, source) => {
      for (const cb of listeners) {
        emitted++
        cb({
          context,
          value: { latitude: position[0], longitude: position[1] },
          ...(timestamp === undefined ? {} : { timestamp: new Date(timestamp).toISOString() }),
          ...(source === undefined ? {} : { $source: source }),
        })
      }
    },
    seedTrack: (context, positions, timestamps) => {
      plugin.getTracks()?.initialTrack(context, positions, timestamps)
    },
    setSelfPosition: (position) => {
      selfPosition = position
    },
    setSelfState: (state) => {
      selfState = state
    },
    // Only the plugin is stopped. The data directory stays: stop() leaves the
    // routes mounted and keeps serving what was accumulated, which routes.test
    // pins, and a test that queries after stopping needs the file to still be
    // there. The directory is a mkdtemp under the OS temp dir, so leaving it is
    // harmless.
    stop: () => plugin.stop(),
    restart: () => plugin.start(startConfig),
    emitted: () => emitted,
    errors,
    statuses,
    trackProvider: () => trackProvider,
    registrations: () => registrations,
  }
}
