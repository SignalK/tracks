/**
 * Pauses recording of the own vessel's track while it is not going anywhere.
 *
 * A boat on a mooring for the winter emits a position every second and travels
 * nowhere, so the track gains nothing but rows. Gating on `navigation.state`
 * lets those months cost nothing, which matters once tracks are kept
 * indefinitely.
 *
 * Requested in https://github.com/SignalK/tracks/issues/1, where the
 * suggestion is `signalk-autostate` as the source of the state.
 *
 * Two limits are deliberate.
 *
 * **`anchored` is not a pause state, and is not offered as a default.** An
 * anchor alarm needs exactly the track a vessel makes while anchored — swinging
 * on the rode is the signal it watches. Gating there would break a real
 * consumer, so a user has to choose it explicitly if they ever want it.
 *
 * **Own vessel only.** `navigation.state` for an AIS target is the
 * navigational status its operator set on the transponder, and it is often
 * stale: vessels under way still reporting `moored` are ordinary. Gating those
 * would drop targets from the track while they are visibly moving.
 */
import type { Context } from './types.js'

/**
 * Off unless a user opts in, per the request and because the states worth
 * pausing on depend on how a boat is used.
 */
export const DEFAULT_PAUSE_STATES: string[] = []

/**
 * The states a boat is plausibly parked in, offered in the plugin UI.
 *
 * A subset of the `navigation.state` enum in `@signalk/signalk-schema` rather
 * than the whole of it: most of that list is AIS navigational status, and
 * offering `trawling-hauling` as a reason to stop recording would be noise.
 */
export const PAUSABLE_STATES = ['moored', 'not-under-way', 'anchored', 'aground'] as const

export class StateGate {
  private readonly pauseStates: ReadonlySet<string>
  private readonly selfContext: string
  /** Last state seen, for the plugin status line. */
  private lastState: string | undefined
  private pausedCount = 0

  constructor(selfContext: string, pauseStates: readonly string[]) {
    this.selfContext = selfContext
    this.pauseStates = new Set(pauseStates)
  }

  /** Whether the gate can ever pause anything. */
  get enabled(): boolean {
    return this.pauseStates.size > 0
  }

  /**
   * Whether to record this position.
   *
   * `state` is whatever `navigation.state` currently reads, or undefined when
   * the vessel does not report it. Undefined records: a boat with no state at
   * all must not silently stop being tracked.
   */
  accept(context: Context, state: string | undefined): boolean {
    if (!this.enabled || context !== this.selfContext) {
      return true
    }
    this.lastState = state
    if (state !== undefined && this.pauseStates.has(state)) {
      this.pausedCount++
      return false
    }
    return true
  }

  /** The state last seen for the own vessel, or undefined if none yet. */
  get state(): string | undefined {
    return this.lastState
  }

  /** How many positions have been skipped. */
  get skipped(): number {
    return this.pausedCount
  }

  /** A status line while paused, or undefined when recording. */
  status(): string | undefined {
    if (!this.enabled || this.lastState === undefined) {
      return undefined
    }
    if (!this.pauseStates.has(this.lastState)) {
      return undefined
    }
    return `Not recording: navigation.state is '${this.lastState}'. ${this.pausedCount} position(s) skipped.`
  }

  /** Forget what was seen; used when the plugin restarts. */
  clear(): void {
    this.lastState = undefined
    this.pausedCount = 0
  }
}
