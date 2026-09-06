import { describe, expect, it } from 'vitest'
import { reconcile } from './reconcile.js'
import type { TimedPosition } from './types.js'

const MINUTE = 60_000
const at = (minutes: number, lat = 60): TimedPosition => ({
  position: [lat, 24.9],
  timestamp: minutes * MINUTE,
})
/** A history row: timestamps land on bucket boundaries. */
const bucket = (minutes: number, lat = 61): TimedPosition => at(minutes, lat)
/** A stored row: the actual time a fix arrived, offset within its bucket. */
const stored = (minutes: number, offsetMs = 1212, lat = 60): TimedPosition => ({
  position: [lat, 24.9],
  timestamp: minutes * MINUTE + offsetMs,
})

/**
 * Minute of each returned point, rounded down.
 *
 * Stored points sit a little way inside their minute — that offset is the
 * whole reason the two sources cannot be joined on equal timestamps — so the
 * fractional part is noise here.
 */
const times = (r: { positions: TimedPosition[] }) => r.positions.map((p) => Math.floor(p.timestamp / MINUTE))

describe('reconcile', () => {
  it('returns the store alone when there is no history', () => {
    const r = reconcile([], [stored(1), stored(2)], MINUTE)
    expect(r.fromHistory).toBe(0)
    expect(r.fromStore).toBe(2)
  })

  it('returns history alone when the store is empty', () => {
    const r = reconcile([bucket(1), bucket(2)], [], MINUTE)
    expect(r.fromHistory).toBe(2)
    expect(r.fromStore).toBe(0)
  })

  it('does not keep both when the two describe the same minute', () => {
    // The same physical fix: 19:00:00.000 from history, 19:00:01.212 from the
    // store. Joining on equal timestamps would keep both.
    const r = reconcile([bucket(1)], [stored(1)], MINUTE)
    expect(r.positions).toHaveLength(1)
    expect(r.positions[0]?.position[0]).toBe(61) // the history one
  })

  it('prefers history where it has data', () => {
    const r = reconcile([bucket(1), bucket(2)], [stored(1), stored(2)], MINUTE)
    expect(r.fromHistory).toBe(2)
    expect(r.fromStore).toBe(0)
  })

  // The four ways a provider's coverage can be incomplete. All resolve the
  // same way, without reading any configuration.
  it('fills what retention has dropped', () => {
    // History reaches back only to minute 3; the store has the older track.
    const r = reconcile([bucket(3), bucket(4)], [stored(1), stored(2), stored(3), stored(4)], MINUTE)
    expect(times(r)).toEqual([1, 2, 3, 4])
    expect(r.fromHistory).toBe(2)
    expect(r.fromStore).toBe(2)
  })

  it('fills the period before a provider was installed', () => {
    const r = reconcile([bucket(5)], [stored(1), stored(5)], MINUTE)
    expect(times(r)).toEqual([1, 5])
  })

  it('fills a week the provider was disabled', () => {
    // A hole in the middle of history's span, which an extent-based rule
    // would miss.
    const r = reconcile([bucket(1), bucket(5)], [stored(1), stored(2), stored(3), stored(4), stored(5)], MINUTE)
    expect(times(r)).toEqual([1, 2, 3, 4, 5])
    expect(r.fromHistory).toBe(2)
    expect(r.fromStore).toBe(3)
  })

  it('returns nothing when neither source recorded anything', () => {
    // A vessel ashore. Correctly empty rather than fabricated.
    expect(reconcile([], [], MINUTE).positions).toEqual([])
  })

  it('returns points in time order regardless of source', () => {
    const r = reconcile([bucket(4), bucket(2)], [stored(3), stored(1)], MINUTE)
    expect(times(r)).toEqual([1, 2, 3, 4])
  })

  it('treats a coarser history bucket as covering the minutes inside it', () => {
    // Hourly history against per-minute storage: the store must not add 59
    // extra points inside an hour history already answered.
    const HOUR = 60 * MINUTE
    const r = reconcile([bucket(0)], [stored(0), stored(1), stored(2)], HOUR)
    expect(r.positions).toHaveLength(1)
    expect(r.fromHistory).toBe(1)
  })

  describe('without a bucket width', () => {
    it('lets history cover its own span and the store the rest', () => {
      const r = reconcile([bucket(2), bucket(3)], [stored(1), stored(2), stored(4)], 0)
      expect(times(r)).toEqual([1, 2, 3, 4])
      expect(r.fromHistory).toBe(2)
      expect(r.fromStore).toBe(2)
    })

    it('uses the true span when history arrives out of order', () => {
      // Nothing guarantees a provider returns rows in time order. Taking the
      // first and last would judge a stored point inside history's span to be
      // outside it, and keep both.
      const r = reconcile([bucket(4), bucket(2)], [stored(3)], 0)
      expect(r.fromStore).toBe(0)
      expect(r.positions).toHaveLength(2)
    })

    it('falls back to the store entirely when history is empty', () => {
      const r = reconcile([], [stored(1)], 0)
      expect(r.fromStore).toBe(1)
    })
  })
})
