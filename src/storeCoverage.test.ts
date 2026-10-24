import { describe, expect, it } from 'vitest'
import { storeCoversWindow } from './reconcile.js'
import type { TimedPosition } from './types.js'

const at = (timestamp: number): TimedPosition => ({
  position: [0, 0],
  timestamp,
})

describe('storeCoversWindow', () => {
  it('covers a window the store spans at the asked spacing', () => {
    const stored = [0, 60_000, 120_000, 180_000].map((t) => at(t))
    expect(storeCoversWindow(stored, { from: 0, to: 180_000 }, 60_000)).toBe(true)
  })

  it('covers a coarse request from a finer store', () => {
    const stored = [0, 1_000, 2_000, 3_000].map((t) => at(t))
    expect(storeCoversWindow(stored, { from: 0, to: 3_000 }, 60_000)).toBe(true)
  })

  it('does not cover a window the store starts after', () => {
    const stored = [120_000, 180_000, 240_000].map((t) => at(t))
    expect(storeCoversWindow(stored, { from: 0, to: 240_000 }, 60_000)).toBe(false)
  })

  it('does not cover a window the store ends before', () => {
    const stored = [0, 60_000, 120_000].map((t) => at(t))
    expect(storeCoversWindow(stored, { from: 0, to: 300_000 }, 60_000)).toBe(false)
  })

  it('does not cover when the store has a gap wider than the asked spacing', () => {
    const stored = [0, 60_000, 300_000, 360_000].map((t) => at(t))
    expect(storeCoversWindow(stored, { from: 0, to: 360_000 }, 60_000)).toBe(false)
  })

  it('needs at least two points', () => {
    expect(storeCoversWindow([at(0)], { from: 0, to: 60_000 }, 60_000)).toBe(false)
    expect(storeCoversWindow([], { from: 0, to: 60_000 }, 60_000)).toBe(false)
  })
})
