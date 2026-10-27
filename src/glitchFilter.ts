import { createDistanceTo } from './utils.js'
import type { Context, LatLngTuple } from './types.js'

/**
 * Drops positions that imply an impossible speed since the last accepted one.
 *
 * A GPS occasionally emits a fix hundreds of miles away — a bad almanac, a
 * multipath reflection, a receiver resetting. On a live map it flickers past.
 * In a stored track it is permanent: one spike stretches the bounding box
 * across an ocean, inflates the distance travelled, and drags the line across
 * the chart every time the track is drawn.
 *
 * Speed, not distance, is the test. A vessel can legitimately jump a long way
 * between two fixes if the gap between them is long enough — after a passage
 * with the plugin stopped, or when a slow-reporting AIS target reappears. What
 * cannot happen is covering that distance faster than a vessel moves.
 *
 * Requested in https://github.com/SignalK/tracks/issues/48
 */

/**
 * Default ceiling in knots.
 *
 * Above any displacement vessel and most planing craft, and well above the
 * ~50kn an AIS Class A target reports at the top of its scale, so a real fix is
 * never dropped. Glitches are typically wrong by whole degrees of latitude, so
 * they miss this by orders of magnitude rather than by a little.
 */
export const DEFAULT_MAX_SPEED_KNOTS = 100

const METRES_PER_NAUTICAL_MILE = 1852

export interface Fix {
  position: LatLngTuple
  timestamp: number
}

/**
 * The speed in knots that going from one fix to a later one implies.
 *
 * Undefined for fixes at the same instant or out of order: dividing by a zero
 * or negative interval says nothing about whether the jump is real.
 */
export function knotsBetween(from: Fix, to: Fix): number | undefined {
  const seconds = (to.timestamp - from.timestamp) / 1000
  if (seconds <= 0) {
    return undefined
  }
  return createDistanceTo(from.position)(to.position) / seconds / (METRES_PER_NAUTICAL_MILE / 3600)
}

/**
 * How soon a fix must agree with the reference to confirm it.
 *
 * Longer than the three minutes an AIS target at anchor reports at, so a
 * vessel reporting as it should keeps a confirmed reference. After a longer
 * silence the ceiling lets a fix move so far that its agreeing confirms
 * little.
 */
const CONFIRM_WITHIN_MS = 10 * 60 * 1000

interface Reference extends Fix {
  /** Whether a fix soon after it agreed with it; see accept(). */
  confirmed: boolean
}

export interface GlitchFilterConfig {
  /** Ceiling in knots. 0 or below disables the filter. */
  maxSpeedKnots: number
}

export class GlitchFilter {
  private readonly last = new Map<Context, Reference>()
  /** Per context, the last fix rejected against a reference not yet confirmed. */
  private readonly challengers = new Map<Context, Fix>()
  private readonly maxSpeedKnots: number
  /** Rejections per context, for the plugin status line. */
  private readonly rejected = new Map<Context, number>()

  constructor(config: GlitchFilterConfig) {
    this.maxSpeedKnots = config.maxSpeedKnots
  }

  /**
   * Whether to keep this position.
   *
   * Accepting updates the reference point, so a sustained move — a genuinely
   * fast vessel, or a track resuming after a gap — is not fought after the
   * first fix.
   *
   * The first fix, and one after a silence of more than CONFIRM_WITHIN_MS, is
   * a reference only provisionally: nothing has checked it. Were it a glitch,
   * every real fix after it would look like a jump away from it, and be
   * rejected for as long as the ceiling takes to cover the distance — hours,
   * for a glitch whole degrees off. So a fix that contradicts a provisional
   * reference is kept as a challenger, and the next fix that agrees with the
   * challenger rather than the reference replaces the reference: one real fix
   * is lost, not hours of them. A reference a fix soon after agreed with is
   * confirmed, and a glitch, or a run of them, is rejected against it.
   */
  accept(context: Context, position: LatLngTuple, timestamp: number): boolean {
    if (this.maxSpeedKnots <= 0) {
      return true
    }
    const fix: Fix = { position, timestamp }
    const previous = this.last.get(context)
    if (previous === undefined) {
      this.last.set(context, { ...fix, confirmed: false })
      return true
    }

    // A fix dated at or before the reference carries no usable speed against
    // it. The sqlite store judges one dated inside its stored track against the
    // positions either side of it instead (SqliteTrackStore.newPosition).
    const knots = knotsBetween(previous, fix)
    if (knots === undefined) {
      return true
    }
    if (knots <= this.maxSpeedKnots) {
      this.last.set(context, { ...fix, confirmed: timestamp - previous.timestamp <= CONFIRM_WITHIN_MS })
      this.challengers.delete(context)
      return true
    }
    if (!previous.confirmed) {
      const challenger = this.challengers.get(context)
      if (challenger !== undefined && this.agrees(challenger, fix)) {
        this.last.set(context, { ...fix, confirmed: true })
        this.challengers.delete(context)
        return true
      }
      this.challengers.set(context, fix)
    }
    this.rejected.set(context, (this.rejected.get(context) ?? 0) + 1)
    return false
  }

  /** Whether a fix follows another soon enough, and within the ceiling. */
  private agrees(from: Fix, to: Fix): boolean {
    const knots = knotsBetween(from, to)
    return knots !== undefined && knots <= this.maxSpeedKnots && to.timestamp - from.timestamp <= CONFIRM_WITHIN_MS
  }

  /** How many positions have been rejected for a context. */
  rejectedCount(context: Context): number {
    return this.rejected.get(context) ?? 0
  }

  /** Total rejections across every context. */
  totalRejected(): number {
    let total = 0
    for (const count of this.rejected.values()) {
      total += count
    }
    return total
  }

  /** Forget every reference point; used when the plugin restarts. */
  clear(): void {
    this.last.clear()
    this.challengers.clear()
    this.rejected.clear()
  }
}
