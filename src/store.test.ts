import { describe, expect, it } from 'vitest'
import { Tracks } from './tracks.js'
import { SqliteTrackStore } from './sqliteStore.js'
import type { TrackStore } from './store.js'
import type { Context } from './types.js'

const debug = Object.assign(() => {}, { enabled: false })
const ctx = 'vessels.urn:mrn:signalk:uuid:test' as Context

/**
 * Contract tests for TrackStore, written against the interface rather than the
 * class, and run against every implementation. Divergence between the two
 * stores is the failure mode this suite exists to catch: a user switching
 * `source` should not see their tracks answer differently.
 */
const implementations: [string, () => TrackStore][] = [
  ['Tracks (in-memory)', () => new Tracks({ resolution: 0, pointsToKeep: 100 }, debug)],
  ['SqliteTrackStore (:memory:)', () => new SqliteTrackStore({ file: ':memory:' }, debug)],
]

describe.each(implementations)('TrackStore contract: %s', (_name, newStore) => {
  it('reads back a recorded position', async () => {
    const store = newStore()
    store.newPosition(ctx, [60, 25], 1000)
    await expect(store.get(ctx)).resolves.toEqual([[60, 25]])
  })

  it('keeps timestamps alongside positions', async () => {
    const store = newStore()
    store.newPosition(ctx, [60, 25], 1000)
    await expect(store.getTimed(ctx)).resolves.toEqual([{ position: [60, 25], timestamp: 1000 }])
  })

  it('rejects for an unknown context rather than resolving empty', async () => {
    // A known-but-stationary vessel resolves with points; an unknown one must be
    // distinguishable so the route can answer 404.
    await expect(newStore().get('vessels.nope' as Context)).rejects.toThrow()
  })

  it('narrows to a half-open time window', async () => {
    const store = newStore()
    store.initialTrack(
      ctx,
      [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      [1000, 2000, 3000],
    )
    // [1000, 3000) excludes the point exactly at `to`.
    await expect(store.get(ctx, { from: 1000, to: 3000 })).resolves.toEqual([
      [1, 1],
      [2, 2],
    ])
  })

  it('closes a half-open window when inclusiveEnd is set', async () => {
    const store = newStore()
    store.initialTrack(
      ctx,
      [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      [1000, 2000, 3000],
    )
    await expect(store.get(ctx, { from: 1000, to: 3000, inclusiveEnd: true })).resolves.toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })

  it('lists every known context in getAllTracks', async () => {
    const store = newStore()
    store.newPosition(ctx, [60, 25], 1000)
    store.newPosition('vessels.other' as Context, [61, 26], 1000)
    const all = await store.getAllTracks()
    expect(all.map(({ context }) => context).sort()).toEqual(['vessels.other', ctx].sort())
  })

  it('filters on the last position, not any position', async () => {
    const store = newStore()
    // Passes through the bbox but ends far outside it.
    store.initialTrack(
      ctx,
      [
        [60, 25],
        [10, 10],
      ],
      [1000, 2000],
    )
    const filtered = await store.getFilteredTracks({
      bbox: { sw: [59, 24], ne: [61, 26] },
      radius: null,
    })
    expect(filtered[ctx]).toBeUndefined()
  })

  it('prunes contexts older than maxAge and keeps fresh ones', async () => {
    const store = newStore()
    store.newPosition(ctx, [60, 25], Date.now())
    store.newPosition('vessels.stale' as Context, [1, 1], Date.now() - 10_000)
    store.prune(5_000)
    const remaining = await store.getAllTracks()
    expect(remaining.map(({ context }) => context)).toEqual([ctx])
  })

  it('returns timed tracks carrying each point timestamp', async () => {
    const store = newStore()
    // initialTrack, not newPosition: the in-memory accumulator throttles on the
    // wall clock, so a synchronous burst of positions yields a single point.
    store.initialTrack(
      ctx,
      [
        [60, 25],
        [60.1, 25.1],
      ],
      [1000, 2000],
    )
    const timed = await store.getFilteredTimedTracks({ bbox: null, radius: null })
    expect(timed[ctx]).toEqual([
      { position: [60, 25], timestamp: 1000 },
      { position: [60.1, 25.1], timestamp: 2000 },
    ])
  })

  it('selects the same contexts timed and untimed', async () => {
    // Both forms share one filter; if they diverge, a client asking for times
    // silently gets a different set of vessels.
    const store = newStore()
    store.newPosition(ctx, [60, 25], 1000)
    store.newPosition('vessels.far' as Context, [10, 10], 1000)
    const params = { bbox: { sw: [59, 24] as [number, number], ne: [61, 26] as [number, number] }, radius: null }

    const plain = await store.getFilteredTracks(params)
    const timed = await store.getFilteredTimedTracks(params)

    expect(Object.keys(timed).sort()).toEqual(Object.keys(plain).sort())
    expect(Object.keys(plain)).toEqual([ctx])
  })

  it('narrows a timed track to the requested window', async () => {
    const store = newStore()
    store.initialTrack(
      ctx,
      [
        [60, 25],
        [60.1, 25.1],
      ],
      [1000, 5000],
    )
    const timed = await store.getFilteredTimedTracks({ bbox: null, radius: null }, undefined, undefined, {
      window: { from: 4000, to: 6000, inclusiveEnd: true },
    })
    expect(timed[ctx]).toEqual([{ position: [60.1, 25.1], timestamp: 5000 }])
  })
})
