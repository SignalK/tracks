import { firstValueFrom } from 'rxjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tracks, TrackAccumulator } from './tracks.js'
import type { Debug, LatLngTuple } from './types.js'

const debug = Object.assign(() => undefined, { enabled: false }) as Debug

const CONTEXT = 'vessels.urn:mrn:imo:mmsi:123456789'
const RESOLUTION = 1000

const accumulator = (pointsToKeep = 10) => new TrackAccumulator({ resolution: RESOLUTION, pointsToKeep })

// Mirrors how Tracks.get() reads the stream in production.
const currentTrack = (acc: TrackAccumulator): Promise<LatLngTuple[]> => firstValueFrom(acc.track)

// throttleTime emits on the leading edge and then suppresses everything until
// the window elapses, so positions must be spaced past `resolution` to land.
const feed = (acc: TrackAccumulator, positions: LatLngTuple[]) => {
  positions.forEach((p, i) => {
    if (i > 0) {
      vi.advanceTimersByTime(RESOLUTION + 1)
    }
    acc.nextLatLngTuple(p)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('TrackAccumulator', () => {
  it('accumulates positions', async () => {
    const acc = accumulator()
    feed(acc, [
      [1, 2],
      [3, 4],
    ])
    expect(await currentTrack(acc)).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('keeps only the most recent pointsToKeep positions', async () => {
    const acc = accumulator(2)
    feed(acc, [
      [1, 1],
      [2, 2],
      [3, 3],
    ])
    expect(await currentTrack(acc)).toEqual([
      [2, 2],
      [3, 3],
    ])
  })

  // Thinning to the configured resolution is the point of the accumulator:
  // a burst of positions inside one window contributes a single point.
  it('throttles positions arriving faster than the resolution', async () => {
    const acc = accumulator()
    acc.nextLatLngTuple([1, 1])
    acc.nextLatLngTuple([2, 2])
    acc.nextLatLngTuple([3, 3])
    expect(await currentTrack(acc)).toEqual([[1, 1]])
  })

  it('prepends the initial track', async () => {
    const acc = accumulator()
    acc.setInitialTrack([[9, 9]])
    acc.nextLatLngTuple([1, 1])
    expect(await currentTrack(acc)).toEqual([
      [9, 9],
      [1, 1],
    ])
  })

  // rxjs 7's connectable() resets its connector on disconnect by default, which
  // would drop the buffer once a subscriber unsubscribed. Reading twice in a row
  // pins the replay behaviour publishReplay(1) provided.
  it('replays the accumulated track to a later subscriber', async () => {
    const acc = accumulator()
    acc.nextLatLngTuple([1, 1])
    expect(await currentTrack(acc)).toEqual([[1, 1]])
    expect(await currentTrack(acc)).toEqual([[1, 1]])
  })
})

describe('Tracks', () => {
  it('rejects get() for a context with no accumulator', async () => {
    const tracks = new Tracks({ resolution: 0, pointsToKeep: 10 }, debug)
    await expect(tracks.get(CONTEXT)).rejects.toThrow()
  })

  it('ignores contexts that are not vessels or aircraft', () => {
    const tracks = new Tracks({ resolution: 0, pointsToKeep: 10 }, debug)
    expect(tracks.getAccumulator('atons.urn:mrn:imo:mmsi:99')).toBeUndefined()
  })

  it('prunes tracks older than maxAge', () => {
    const tracks = new Tracks({ resolution: 0, pointsToKeep: 10 }, debug)
    tracks.newPosition(CONTEXT, [1, 1])
    expect(tracks.getAccumulator(CONTEXT, false)).toBeDefined()
    tracks.prune(-1) // cutoff in the future: everything is stale
    expect(tracks.getAccumulator(CONTEXT, false)).toBeUndefined()
  })
})
