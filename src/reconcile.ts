import type { TimedPosition } from './types.js'

/**
 * Combines positions from a history provider with the plugin's own store.
 *
 * The two sources record the same vessel differently. The plugin's store keeps
 * one position a minute forever, which is what a track from three years ago is
 * made of. A history provider keeps whatever resolution it was configured for
 * — often every couple of seconds — but only for as long as its retention
 * allows, and only for as long as it has actually been running.
 *
 * So neither is simply better. History is finer where it reaches; the store is
 * what remains everywhere else.
 *
 * ## The rule
 *
 * Trust history for any bucket where it returns a usable position. Use the
 * store for every other bucket.
 *
 * That one rule covers every way a provider's coverage can be incomplete,
 * without reading any configuration:
 *
 * - retention has dropped the old data — history returns nothing there
 * - the provider was installed after the boat started recording — likewise
 * - the provider was disabled, or its database was down, for a week — likewise
 * - the vessel was ashore and nothing was recorded — history returns nothing
 *   and so does the store, which is the correct answer
 *
 * Coverage is therefore discovered per query rather than configured, and
 * nothing breaks when it changes underneath.
 *
 * ## Why the sources cannot double up
 *
 * A history provider aggregates into resolution buckets and timestamps each
 * one on its boundary — 19:00:00.000, 19:01:00.000. The store keeps the actual
 * time a fix arrived, 19:00:01.212. The same physical position therefore has
 * two different timestamps, so joining on equality would silently keep both.
 *
 * Bucketing avoids the problem rather than solving it: each bucket is filled
 * from exactly one source, so no comparison between individual points is ever
 * needed.
 */

/** A bucket index for a timestamp, so both sources land on the same grid. */
const bucketOf = (timestamp: number, resolution: number): number => Math.floor(timestamp / resolution)

export interface ReconcileResult {
  positions: TimedPosition[]
  /** Buckets served from the history provider. */
  fromHistory: number
  /** Buckets served from the plugin's own store. */
  fromStore: number
}

/**
 * Merge history and store positions into one track.
 *
 * `resolution` is the bucket width in milliseconds; it should be the
 * resolution the history provider was asked for, so its rows land one per
 * bucket.
 */
export function reconcile(history: TimedPosition[], stored: TimedPosition[], resolution: number): ReconcileResult {
  if (resolution <= 0) {
    // Without a bucket width there is no grid to reconcile on. History is
    // still the finer source, so it wins outright and the store fills only
    // what lies outside its extent.
    return reconcileByExtent(history, stored)
  }

  const covered = new Set<number>()
  const positions: TimedPosition[] = []
  for (const point of history) {
    covered.add(bucketOf(point.timestamp, resolution))
    positions.push(point)
  }
  const fromHistory = positions.length

  for (const point of stored) {
    if (!covered.has(bucketOf(point.timestamp, resolution))) {
      positions.push(point)
    }
  }

  positions.sort((a, b) => a.timestamp - b.timestamp)
  return {
    positions,
    fromHistory,
    fromStore: positions.length - fromHistory,
  }
}

/**
 * Fallback when no bucket width is known: history covers its own time span,
 * and the store supplies whatever falls outside it.
 *
 * Less precise than bucketing — a gap inside history's span is not filled —
 * but it cannot produce duplicates, which matters more.
 */
function reconcileByExtent(history: TimedPosition[], stored: TimedPosition[]): ReconcileResult {
  if (history.length === 0) {
    return { positions: [...stored], fromHistory: 0, fromStore: stored.length }
  }
  // Min and max rather than first and last: nothing guarantees a provider
  // returns rows in time order, and assuming it does would judge a stored
  // point inside history's span to be outside it, keeping both.
  let first = history[0]!.timestamp
  let last = first
  for (const point of history) {
    if (point.timestamp < first) first = point.timestamp
    if (point.timestamp > last) last = point.timestamp
  }
  const outside = stored.filter((p) => p.timestamp < first || p.timestamp > last)
  const positions = [...history, ...outside].sort((a, b) => a.timestamp - b.timestamp)
  return {
    positions,
    fromHistory: history.length,
    fromStore: outside.length,
  }
}
