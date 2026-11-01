import { describe, expect, it } from 'vitest'
import { packPositions, packTimed, unpackPositions, unpackTimed } from './packedTrack.js'
import type { LatLngTuple, TimedPosition } from './types.js'

describe('packed tracks', () => {
  it('gives back every point of a timed track with exactly the fields it had', () => {
    const points: TimedPosition[] = [
      { position: [60.1234567, 24.7654321], timestamp: 1_700_000_000_123 },
      { position: [-33.8, 151.2], timestamp: 1_700_000_060_000, pauseBefore: 45_000 },
      { position: [0, -179.9999999], timestamp: 1_700_000_120_000, breakBefore: true },
      { position: [1, 2], timestamp: 1_700_000_180_000, span: 600_000, pauseBefore: 0 },
    ]
    const transfer: ArrayBuffer[] = []
    const unpacked = unpackTimed(packTimed(points, transfer))
    expect(unpacked).toStrictEqual(points)
    expect(transfer.length).toBe(5)
  })

  it('leaves out the columns no point fills', () => {
    const transfer: ArrayBuffer[] = []
    const packed = packTimed([{ position: [60, 24], timestamp: 100 }], transfer)
    expect(Object.keys(packed).sort()).toEqual(['coordinates', 'timestamps'])
    expect(transfer).toEqual([packed.timestamps.buffer, packed.coordinates.buffer])
    expect(unpackTimed(packed)).toStrictEqual([{ position: [60, 24], timestamp: 100 }])
  })

  it('drops an explicit breakBefore: false, which means what its absence does', () => {
    const points: TimedPosition[] = [
      { position: [60, 24], timestamp: 100, breakBefore: false },
      { position: [60.5, 24.5], timestamp: 200, breakBefore: true },
    ]
    const unpacked = unpackTimed(packTimed(points, []))
    expect(unpacked[0]).toStrictEqual({ position: [60, 24], timestamp: 100 })
    expect(unpacked[0]).not.toHaveProperty('breakBefore')
    expect(unpacked[1]?.breakBefore).toBe(true)
    expect(Object.keys(packTimed([points[0]!], []))).not.toContain('breakBefore')
  })

  it('gives back positions without times', () => {
    const positions: LatLngTuple[] = [
      [60, 24],
      [-45.5, 170.25],
    ]
    const transfer: ArrayBuffer[] = []
    expect(unpackPositions(packPositions(positions, transfer))).toStrictEqual(positions)
    expect(transfer.length).toBe(1)
  })

  it('packs an empty track', () => {
    expect(unpackTimed(packTimed([], []))).toEqual([])
    expect(unpackPositions(packPositions([], []))).toEqual([])
  })

  it('survives a transfer between threads', () => {
    const points: TimedPosition[] = [
      { position: [60, 24], timestamp: 100 },
      { position: [60.5, 24.5], timestamp: 200, pauseBefore: 80, breakBefore: true },
    ]
    const transfer: ArrayBuffer[] = []
    const packed = packTimed(points, transfer)
    const received = structuredClone(packed, { transfer })
    expect(packed.timestamps.byteLength).toBe(0)
    expect(unpackTimed(received)).toStrictEqual(points)
  })
})
