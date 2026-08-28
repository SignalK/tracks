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

interface LastAccepted {
  position: LatLngTuple
  timestamp: number
}

export interface GlitchFilterConfig {
  /** Ceiling in knots. 0 or below disables the filter. */
  maxSpeedKnots: number
}

export class GlitchFilter {
  private readonly last = new Map<Context, LastAccepted>()
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
   */
  accept(context: Context, position: LatLngTuple, timestamp: number): boolean {
    if (this.maxSpeedKnots <= 0) {
      return true
    }
    const previous = this.last.get(context)
    if (previous === undefined) {
      this.last.set(context, { position, timestamp })
      return true
    }

    // Out-of-order or same-instant fixes carry no usable speed: dividing by a
    // zero or negative interval says nothing about whether the jump is real.
    // Bootstrapped history arrives back-dated, so this is not hypothetical.
    const seconds = (timestamp - previous.timestamp) / 1000
    if (seconds <= 0) {
      return true
    }

    const metres = createDistanceTo(previous.position)(position)
    const knots = metres / seconds / (METRES_PER_NAUTICAL_MILE / 3600)
    if (knots > this.maxSpeedKnots) {
      this.rejected.set(context, (this.rejected.get(context) ?? 0) + 1)
      return false
    }

    this.last.set(context, { position, timestamp })
    return true
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
    this.rejected.clear()
  }
}
