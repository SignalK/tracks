import express from 'express'
import type { Express } from 'express'
import ThePlugin from './index.js'
import type { ContextPosition } from './index.js'
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
   * is the entry point the History API bootstrap uses.
   */
  seedTrack: (context: string, positions: LatLngTuple[], timestamps: number[]) => void
  /** Self position as reported by `getSelfPath`, used for radius filtering. */
  setSelfPosition: (position: LatLngTuple | undefined) => void
  /** The own vessel's navigation.state, as reported by `getSelfPath`. */
  setSelfState: (state: string | undefined) => void
  stop: () => void
  errors: unknown[][]
}

export interface HarnessOptions {
  /** Plugin config overrides. Bootstrap is disabled by default so tests stay hermetic. */
  config?: Record<string, unknown>
  selfContext?: string
  selfPosition?: LatLngTuple
  /** Initial navigation.state for the own vessel. */
  selfState?: string
}

export function createHarness(options: HarnessOptions = {}): TestHarness {
  const listeners: PositionListener[] = []
  const errors: unknown[][] = []
  const statuses: string[] = []
  let selfPosition: LatLngTuple | undefined = options.selfPosition
  let selfState: string | undefined = options.selfState
  const selfContext = options.selfContext ?? SELF_CONTEXT

  const debug: Debug = Object.assign(() => undefined, { enabled: false })

  const app = {
    debug,
    error: (...args: unknown[]) => errors.push(args),
    setPluginStatus: (msg: string) => statuses.push(msg),
    selfContext,
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
  plugin.start({
    // resolution 0 so every fed position is accepted without waiting on throttleTime
    resolution: 0,
    pointsToKeep: 1000,
    maxAge: 600,
    bootstrapFromHistory: false,
    ...options.config,
  })

  const expressApp = express()
  expressApp.use('/signalk/v1/api', plugin.signalKApiRoutes(express.Router()))

  return {
    app: expressApp,
    emit: (context, position, timestamp, source) => {
      for (const cb of listeners) {
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
    stop: () => plugin.stop(),
    errors,
    statuses,
  }
}
