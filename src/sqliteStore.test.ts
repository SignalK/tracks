import { describe, expect, it } from 'vitest'
import { s2 } from 's2js'
import { SqliteTrackStore } from './sqliteStore.js'
import { splitAtAntimeridian } from './utils.js'
import type { Context, GeoBounds, LatLngTuple } from './types.js'

const debug = Object.assign(() => {}, { enabled: false })
const ctx = 'vessels.urn:mrn:signalk:uuid:test' as Context
const other = 'vessels.urn:mrn:signalk:uuid:other' as Context

const newStore = (): SqliteTrackStore => new SqliteTrackStore({ file: ':memory:' }, debug)

describe('S2 cell ids', () => {
  it('round-trips an id above INT64_MAX exactly', () => {
    // S2 ids are unsigned 64-bit and SQLite integers are signed, so ids in the
    // top half of the range cannot be bound directly — node:sqlite throws
    // "BigInt value is too large to bind". Storing the same bits as signed and
    // reinterpreting on read is lossless; Number() is not.
    const store = newStore()
    // Face 5 sits above INT64_MAX, so this exercises the wrap.
    const position: LatLngTuple = [-89, 100]
    const expected = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(position[0], position[1]))
    expect(expected).toBeGreaterThan(2n ** 63n - 1n)

    store.newPosition(ctx, position, 1000)
    expect(store.cellIdsFor(ctx)).toEqual([expected])
    store.close()
  })

  it('keeps full precision, which Number() would lose', () => {
    const id = 9926595695615246335n
    expect(BigInt(Number(id))).not.toBe(id)
    expect(BigInt.asUintN(64, BigInt.asIntN(64, id))).toBe(id)
  })
})

describe('bbox queries', () => {
  const helsinki: LatLngTuple = [60.16, 24.94]
  const stockholm: LatLngTuple = [59.33, 18.07]

  it('excludes a vessel outside the box', async () => {
    const store = newStore()
    store.newPosition(ctx, helsinki, 1000)
    store.newPosition(other, stockholm, 1000)
    const bounds: GeoBounds = { sw: [60, 24], ne: [61, 26] }

    const tracks = await store.getFilteredTracks({ bbox: bounds, radius: null })
    expect(Object.keys(tracks)).toEqual([ctx])
    store.close()
  })

  it('does not return a position the cell covering lets through', async () => {
    // The covering is a superset of the box by construction, so a position can
    // share a cell range with the box while sitting outside it, and the SQL
    // query does hand that row back. Something after the index has to reject
    // it.
    //
    // This position is chosen, not guessed: it is inside the covering of the
    // bounds below but outside the bounds themselves. A point merely "somewhat
    // outside" the box proves nothing here, because the covering already
    // excludes it and no row is returned to filter.
    const store = newStore()
    const bounds: GeoBounds = { sw: [60.0, 24.0], ne: [60.1, 24.1] }
    const insideCoveringOutsideBounds: LatLngTuple = [59.972, 24.024]
    store.newPosition(ctx, insideCoveringOutsideBounds, 1000)

    const tracks = await store.getFilteredTracks({ bbox: bounds, radius: null })
    expect(tracks[ctx]).toBeUndefined()
    store.close()
  })

  it('finds a vessel across the antimeridian', async () => {
    // A bounds written 179 -> -179 covers to zero S2 cells unless it is split,
    // which silently returns no vessels rather than erroring.
    const store = newStore()
    const nearDateline: LatLngTuple = [-17.5, 179.5]
    store.newPosition(ctx, nearDateline, 1000)

    const tracks = await store.getFilteredTracks({ bbox: { sw: [-18, 179], ne: [-17, -179] }, radius: null })
    expect(Object.keys(tracks)).toEqual([ctx])
    store.close()
  })
})

describe('splitAtAntimeridian', () => {
  it('leaves an ordinary bounds alone', () => {
    const bounds: GeoBounds = { sw: [60, 24], ne: [61, 26] }
    expect(splitAtAntimeridian(bounds)).toEqual([bounds])
  })

  it('splits a wrapping bounds at 180', () => {
    expect(splitAtAntimeridian({ sw: [-18, 179], ne: [-17, -179] })).toEqual([
      { sw: [-18, 179], ne: [-17, 180] },
      { sw: [-18, -180], ne: [-17, -179] },
    ])
  })
})

describe('resolution', () => {
  it('stores every position when resolution is 0', async () => {
    const store = newStore()
    for (let i = 0; i < 5; i++) {
      store.newPosition(ctx, [60 + i / 1000, 24], 1000 + i * 10)
    }
    await expect(store.get(ctx)).resolves.toHaveLength(5)
    store.close()
  })

  it('drops positions inside a resolution window', async () => {
    // A vessel emitting at 8 Hz would otherwise write hundreds of thousands of
    // rows a day at the default 60s resolution.
    const store = new SqliteTrackStore({ file: ':memory:', resolution: 60_000 }, debug)
    store.newPosition(ctx, [60.0, 24], 0)
    store.newPosition(ctx, [60.1, 24], 10_000)
    store.newPosition(ctx, [60.2, 24], 30_000)
    store.newPosition(ctx, [60.3, 24], 60_000)
    store.newPosition(ctx, [60.4, 24], 90_000)
    store.newPosition(ctx, [60.5, 24], 120_000)

    // Leading edge: the first of each window survives, the rest are dropped.
    await expect(store.get(ctx)).resolves.toEqual([
      [60.0, 24],
      [60.3, 24],
      [60.5, 24],
    ])
    store.close()
  })

  it('throttles each context independently', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: 60_000 }, debug)
    store.newPosition(ctx, [60, 24], 0)
    // A different vessel's first position must not be dropped because this one
    // just recorded.
    store.newPosition(other, [61, 25], 1000)

    await expect(store.get(ctx)).resolves.toHaveLength(1)
    await expect(store.get(other)).resolves.toHaveLength(1)
    store.close()
  })

  it('does not throttle a bootstrapped track', async () => {
    // Bootstrap points are back-dated and already at the provider's own
    // resolution; throttling them against the newest-seen timestamp would drop
    // almost all of them.
    const store = new SqliteTrackStore({ file: ':memory:', resolution: 60_000 }, debug)
    store.initialTrack(
      ctx,
      [
        [60.0, 24],
        [60.1, 24],
        [60.2, 24],
      ],
      [1000, 2000, 3000],
    )
    await expect(store.get(ctx)).resolves.toHaveLength(3)
    store.close()
  })

  it('accepts a live position after a bootstrap', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: 60_000 }, debug)
    store.initialTrack(ctx, [[60.0, 24]], [1000])
    store.newPosition(ctx, [60.1, 24], 2000)
    await expect(store.get(ctx)).resolves.toHaveLength(2)
    store.close()
  })
})

describe('segments', () => {
  it('breaks a track where recording stopped', () => {
    const store = newStore()
    const gap = 5 * 60 * 1000
    store.newPosition(ctx, [60.0, 24.0], 0)
    store.newPosition(ctx, [60.1, 24.1], 1000)
    store.newPosition(ctx, [60.2, 24.2], 1000 + gap + 1)

    const segments = store.segments(ctx)
    expect(segments).toEqual([
      [
        [60.0, 24.0],
        [60.1, 24.1],
      ],
      [[60.2, 24.2]],
    ])
    store.close()
  })
})

describe('persistence', () => {
  it('keeps positions across a reopen', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'tracks-test-'))
    const file = join(dir, 'tracks.db')
    try {
      const first = new SqliteTrackStore({ file }, debug)
      first.newPosition(ctx, [60, 25], 1000)
      first.close()

      const second = new SqliteTrackStore({ file }, debug)
      await expect(second.get(ctx)).resolves.toEqual([[60, 25]])
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('retention', () => {
  it('drops rows older than the retention window', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', retention: 1000 }, debug)
    const now = Date.now()
    store.newPosition(ctx, [60, 25], now - 5000)
    store.newPosition(ctx, [61, 26], now)
    store.prune(60_000)
    await expect(store.get(ctx)).resolves.toEqual([[61, 26]])
    store.close()
  })
})
