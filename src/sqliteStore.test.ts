import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'

/** A position as the store keeps it: to the 1e-7 degree, half away from zero. */
const rounded = ([lat, lon]: LatLngTuple): LatLngTuple =>
  [lat, lon].map((degrees) => (Math.sign(degrees) * Math.round(Math.abs(degrees) * 1e7)) / 1e7) as LatLngTuple

// Ways into a rewrite for an older database: between its last read of the
// old file and its check that nothing wrote to it since, where the fsync of
// the new file comes in, at each try to rename the new file over it, and at
// each open of a file.
const rewriting = vi.hoisted(() => ({
  beforeFsync: undefined as (() => void) | undefined,
  beforeRename: undefined as (() => void) | undefined,
  beforeOpen: undefined as ((path: unknown) => void) | undefined,
}))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      rewriting.beforeFsync?.()
      fs.fsyncSync(fd)
    },
    renameSync: (from: string, to: string) => {
      rewriting.beforeRename?.()
      fs.renameSync(from, to)
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      rewriting.beforeOpen?.(args[0])
      return fs.openSync(...args)
    },
  }
})
import { s2 } from 's2js'
import { SqliteTrackStore, TransactionStateError } from './sqliteStore.js'
import { simplify } from './simplify.js'
import { segment, thin } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import {
  clipToBounds,
  createInBounds,
  createReachesBounds,
  fillGaps,
  longitudeSpan,
  MIN_FILLED_GAP_MS,
  splitAtAntimeridian,
  UnknownContextError,
} from './utils.js'
import type {
  Context,
  GeoBounds,
  GpxUploadState,
  ImportedTrack,
  LatLngTuple,
  OnOverlap,
  TimedPosition,
  TimeWindow,
} from './types.js'

const debug = Object.assign(() => {}, { enabled: false })
const ctx = 'vessels.urn:mrn:signalk:uuid:test' as Context
const other = 'vessels.urn:mrn:signalk:uuid:other' as Context

const newStore = (): SqliteTrackStore => new SqliteTrackStore({ file: ':memory:' }, debug)

/** A GPX upload just begun, as `newUpload` makes one. */
const uploading = (onOverlap: OnOverlap = 'keep'): GpxUploadState => ({
  id: 'upload',
  filename: 'export.gpx',
  size: 1,
  context: ctx,
  tracks: [''],
  onOverlap,
  keepEmpty: false,
  state: 'receiving',
  checkpoint: { offset: 0, open: [], segments: 0 },
  imported: 0,
  overlapping: 0,
  untimed: 0,
  startedAt: 0,
  updatedAt: 0,
})

/** Save `slices` of one upload in turn, each a list of `[segment, points]`. */
const saveSlices = (
  store: SqliteTrackStore,
  state: GpxUploadState,
  slices: [segment: number, points: TimedPosition[]][][],
): GpxUploadState => {
  for (const slice of slices) {
    const parts = slice.map(([segment, points]) => ({ segment, points, continues: segment === state.lastSegment }))
    const lastSegment = slice.at(-1)?.[0] ?? state.lastSegment
    state = { ...store.saveGpxUpload(state, parts), ...(lastSegment === undefined ? {} : { lastSegment }) }
  }
  return state
}

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

describe('a window read at a resolution', () => {
  const MINUTE = 60_000
  // Uneven spacing and recording pauses, so thinning has choices to make.
  const seeded = (): SqliteTrackStore => {
    const store = newStore()
    let t = 0
    for (let i = 0; i < 2000; i++) {
      t += i % 97 === 0 ? 15 * MINUTE : 1000 + (i % 7) * 300
      store.newPosition(ctx, [60 + i * 1e-5, 24 + i * 1e-5], t)
    }
    return store
  }

  it('keeps what thinning the whole window keeps', async () => {
    const store = seeded()
    const window: TimeWindow = { from: 0, to: 40 * 60 * MINUTE }
    for (const resolution of [5000, MINUTE]) {
      const thinned = await store.getTimed(ctx, window, resolution)
      expect(thinned.length).toBeLessThan((await store.getTimed(ctx, window)).length)
      expect(thinned).toEqual(thin(await store.getTimed(ctx, window), resolution))
    }
    store.close()
  })

  it('serves a filtered query the same points', async () => {
    const store = seeded()
    const params = { bbox: null, radius: null, contexts: [ctx] }
    const tracks = await store.getFilteredTimedTracks(params, undefined, undefined, { resolution: MINUTE })
    expect(tracks[ctx]).toEqual(thin(await store.getTimed(ctx), MINUTE))
    store.close()
  })

  // Four days from late on the first, with a pause longer than a day, so a
  // read crosses midnight, skips a whole day, and ends inside a day it read.
  it('reads every position of windows that span several days', async () => {
    const HOUR = 60 * MINUTE
    const store = newStore()
    const times: number[] = []
    let t = 22 * HOUR
    for (let i = 0; i < 3000; i++) {
      t += i === 1500 ? 30 * HOUR : MINUTE + (i % 5) * 7000
      times.push(t)
      store.newPosition(ctx, [60 + i * 1e-5, 24 + i * 1e-5], t)
    }
    const windows: (TimeWindow | undefined)[] = [
      undefined,
      { from: 0, to: times[2600]! },
      { from: times[100]!, to: times[2600]!, inclusiveEnd: true },
    ]
    for (const window of windows) {
      const all = await store.getTimed(ctx, window)
      const inside = (time: number) =>
        !window || (time >= window.from && (window.inclusiveEnd ? time <= window.to : time < window.to))
      expect(all.map(({ timestamp }) => timestamp)).toEqual(times.filter(inside))
      for (const resolution of [5 * MINUTE, HOUR]) {
        expect(shaped(await store.getTimed(ctx, window, resolution))).toEqual(shaped(thin(all, resolution)))
      }
    }
    store.close()
  })
})

/**
 * A thinned track as it is drawn: its points, split where `segment()` splits
 * them at the store's gap. A resolution read by seeking bounds a pause shorter
 * than the gap rather than measuring it, which nothing past `segment()` sees.
 */
const shaped = (points: TimedPosition[], gap = 5 * 60_000) =>
  segment(points, gap).map((stretch) => stretch.map(({ position, timestamp }) => ({ position, timestamp })))

describe('a resolution much wider than the recording spacing', () => {
  const SECOND = 1000
  const MINUTE = 60 * SECOND
  const HOUR = 60 * MINUTE
  // A fix a second, every third sharing the time of the one before and stored
  // out of the index's order, with pauses shorter than the gap and longer.
  const recording = (): { track: LatLngTuple[]; times: number[] } => {
    const track: LatLngTuple[] = []
    const times: number[] = []
    let t = 0
    for (let i = 0; i < 20_000; i++) {
      if (i % 4000 === 3999) {
        t += 3 * HOUR
      } else if (i % 1000 === 999) {
        t += 4 * MINUTE
      } else if (i % 3 !== 0) {
        t += SECOND
      }
      times.push(t)
      track.push([60 + ((i * 7919) % 20_000) * 1e-6, 24 + i * 1e-6])
    }
    // The last time shared too, so the last position is not the one kept there.
    for (let i = 0; i < 2; i++) {
      times.push(t)
      track.push([61 - i * 1e-3, 25])
    }
    return { track, times }
  }
  const seeded = (gap?: number): { store: SqliteTrackStore; times: number[] } => {
    const store = new SqliteTrackStore({ file: ':memory:', ...(gap === undefined ? {} : { segmentGap: gap }) }, debug)
    const { track, times } = recording()
    store.initialTrack(ctx, track, times)
    return { store, times }
  }

  it('keeps the positions thinning keeps, split where the recording paused', async () => {
    const { store, times } = seeded()
    const windows: (TimeWindow | undefined)[] = [
      undefined,
      { from: times[500]!, to: times[15_002]! },
      { from: times[500]!, to: times[15_002]!, inclusiveEnd: true },
    ]
    for (const window of windows) {
      const all = await store.getTimed(ctx, window)
      for (const resolution of [10 * SECOND, 10 * MINUTE, 2 * HOUR]) {
        expect(shaped(await store.getTimed(ctx, window, resolution))).toEqual(shaped(thin(all, resolution)))
      }
    }
    // The pauses of three hours split it; those of four minutes do not.
    expect(segment(await store.getTimed(ctx, undefined, 10 * MINUTE), 5 * MINUTE)).toHaveLength(6)
    store.close()
  })

  it('keeps every new time at a resolution below a millisecond', async () => {
    const store = newStore()
    const track: LatLngTuple[] = []
    const times: number[] = []
    // All at one time, so a spacing that rounds away finds the same time again.
    for (let i = 0; i < 40; i++) {
      times.push(1000)
      track.push([60 + ((i * 7) % 40) * 1e-4, 24])
    }
    store.initialTrack(ctx, track, times)
    const all = await store.getTimed(ctx)
    for (const resolution of [0.5, 1e-20]) {
      expect(shaped(await store.getTimed(ctx, undefined, resolution))).toEqual(shaped(thin(all, resolution)))
    }
    store.close()
  })

  it('keeps the same positions where tracks are not split at pauses', async () => {
    const { store } = seeded(0)
    const all = await store.getTimed(ctx)
    const read = await store.getTimed(ctx, undefined, 10 * MINUTE)
    expect(shaped(read, 0)).toEqual(shaped(thin(all, 10 * MINUTE), 0))
    store.close()
  })
})

describe('significance levels', () => {
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const day0 = Date.UTC(2026, 5, 1)
  // A finished day: ended more than a day before.
  const later = day0 + 3 * DAY
  // Deterministic noise, so a failing track can be rebuilt.
  const noise = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1

  /** An hour of wandering at one fix a second, from `start`. */
  const seedHour = (store: SqliteTrackStore, start: number, context: Context = ctx): void => {
    for (let i = 0; i < 3600; i++) {
      const lat = 60 + Math.sin(i / 400) * 0.002 + noise(i) * 0.00002
      const lon = 24 + i * 0.000005 + noise(i + 1) * 0.00002
      store.newPosition(context, [lat, lon], start + i * 1000)
    }
  }
  /** The hours `level_visits` holds of a span. */
  const visitHours = (store: SqliteTrackStore, from: number, to: number) =>
    (
      store['db']
        .prepare(
          'SELECT count(*) AS n FROM level_visits WHERE context_id = (SELECT id FROM contexts WHERE context = ?) AND hour >= ? AND hour < ?',
        )
        .get(ctx, from / (60 * MINUTE), to / (60 * MINUTE)) as { n: number }
    ).n
  /** The levels `significant` holds the positions of a span at: none for one not refined. */
  const levels = (store: SqliteTrackStore, from: number, to: number, context: Context = ctx) =>
    (
      store['db']
        .prepare(
          'SELECT DISTINCT level FROM significant WHERE context_id = (SELECT id FROM contexts WHERE context = ?) AND timestamp >= ? AND timestamp < ? ORDER BY level',
        )
        .all(context, from, to) as { level: number }[]
    ).map(({ level }) => level)
  /**
   * The contexts a refineLevels() call goes over the days of to refine and to
   * simplify them: none where the last passes still hold.
   */
  const goesOver = (store: SqliteTrackStore, now: number): { refining: Context[]; simplifying: Context[] } => {
    const inner = store as unknown as Record<'refineContext' | 'simplifiedDay', (context: Context) => number>
    const refining = vi.spyOn(inner, 'refineContext')
    const simplifying = vi.spyOn(inner, 'simplifiedDay')
    try {
      store.refineLevels(now)
      return {
        refining: refining.mock.calls.map(([context]) => context),
        simplifying: simplifying.mock.calls.map(([context]) => context),
      }
    } finally {
      refining.mockRestore()
      simplifying.mockRestore()
    }
  }
  /** Positions split where the recording stopped for more than 10 minutes, as the store refines them. */
  const pieces = (points: TimedPosition[]): TimedPosition[][] => {
    const result: TimedPosition[][] = []
    for (const point of points) {
      const piece = result.at(-1)
      if (piece && point.timestamp - piece.at(-1)!.timestamp <= 10 * MINUTE) {
        piece.push(point)
      } else {
        result.push([point])
      }
    }
    return result
  }
  // Exact piece by piece: each is refined on its own, so across a pause the
  // store keeps what simplifying each side keeps. The pieces are the full
  // track's; what a level leaves is too sparse to find its pauses in.
  const readsAsSimplified = async (store: SqliteTrackStore, window: TimeWindow) => {
    const all = pieces(await store.getTimed(ctx, window))
    for (const tolerance of [5, 20, 100]) {
      const read = await store.getTimed(ctx, window, undefined, tolerance)
      const readPieces = all.map((piece) =>
        read.filter(({ timestamp }) => timestamp >= piece[0]!.timestamp && timestamp <= piece.at(-1)!.timestamp),
      )
      expect(readPieces.map((piece) => simplify(piece, tolerance))).toEqual(
        all.map((piece) => simplify(piece, tolerance)),
      )
    }
  }

  /** The track of `ctx` clipped to a box around the start of each seeded hour, at a tolerance or without. */
  const boxRead = async (store: SqliteTrackStore, window: TimeWindow, tolerance?: number) =>
    (
      await store.getFilteredTimedTracks(
        {
          bbox: { sw: [59.99, 23.99], ne: [60.01, 24.01] },
          radius: null,
          intersects: true,
          clip: true,
          contexts: [ctx],
        },
        undefined,
        undefined,
        tolerance === undefined ? { window } : { window, tolerance },
      )
    )[ctx]!

  it('reads a refined day at a tolerance as simplifying all of it does, from fewer positions', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(later)
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    const all = await store.getTimed(ctx, window)
    for (const tolerance of [5, 20, 100]) {
      const read = await store.getTimed(ctx, window, undefined, tolerance)
      expect(read.length).toBeLessThan(all.length / 2)
      expect(simplify(read, tolerance)).toEqual(simplify(all, tolerance))
    }
    // Below 4 m nearly every position qualifies, so the read reads them all.
    expect(await store.getTimed(ctx, window, undefined, 2)).toEqual(all)
    store.close()
  })

  it('copies each position it keeps as positions holds it', () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(later)
    const db = store['db']
    expect((db.prepare('SELECT count(*) AS n FROM significant').get() as { n: number }).n).toBeGreaterThan(0)
    expect(
      db
        .prepare(
          `SELECT count(*) AS n FROM significant s LEFT JOIN positions p ON p.rowid = s.position
           WHERE p.rowid IS NULL OR s.context_id IS NOT p.context_id OR s.timestamp IS NOT p.timestamp
             OR s.lat_e7 IS NOT p.lat_e7 OR s.lon_e7 IS NOT p.lon_e7`,
        )
        .get(),
    ).toEqual({ n: 0 })
    store.close()
  })

  it('reads the days after its frontier from positions, and the days before from what it keeps', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    seedHour(store, day0 + DAY + 60 * MINUTE)
    // The first day has finished, the second not yet.
    store.refineLevels(day0 + 2 * DAY + 1)
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    expect(levels(store, day0 + DAY, day0 + 2 * DAY)).toEqual([])
    const window: TimeWindow = { from: day0, to: day0 + 2 * DAY }
    await readsAsSimplified(store, window)
    const read = await store.getTimed(ctx, window, undefined, 20)
    const second = await store.getTimed(ctx, { from: day0 + DAY, to: day0 + 2 * DAY })
    expect(read.filter(({ timestamp }) => timestamp >= day0 + DAY)).toEqual(second)
    expect(read.length).toBeLessThan(second.length * 1.5)
    store.close()
  })

  it('refines a finished day recorded after the pass went past it', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(later)
    // The next day had nothing when the pass went over it, and has finished since.
    store.recordTrack(
      ctx,
      [
        Array.from({ length: 600 }, (_, i) => ({
          position: [60.01, 24 + i * 0.0001],
          timestamp: day0 + DAY + i * 1000,
        })),
      ],
      later,
      false,
    )
    store.refineLevels(later)
    expect(levels(store, day0 + DAY, day0 + 2 * DAY).length).toBeGreaterThan(0)
    store.close()
  })

  it('refines a run of equal times longer than a read as one piece', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 100 }, debug)
    // Untimed, so every position is at time 0: no cut fits in, and the read
    // that stops at the budget ends inside the one piece there is.
    const track = Array.from({ length: 7000 }, (_, i): LatLngTuple => [60 + Math.sin(i / 300) * 0.01, 24 + i * 0.0001])
    store.initialTrack(ctx, track)
    store.refineLevels(later)
    const read = await store.getTimed(ctx, undefined, undefined, 20)
    expect(read.length).toBeGreaterThan(2)
    expect(read.length).toBeLessThan(track.length / 10)
    expect(read[0]!.position).toEqual(rounded(track[0]!))
    expect(read.at(-1)!.position).toEqual(rounded(track.at(-1)!))
    store.close()
  })

  it('refines a day only once it ended more than a day ago, without a storage tolerance', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(day0 + DAY + 60 * MINUTE)
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    store.refineLevels(day0 + 2 * DAY + 1)
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    store.close()
  })

  // With a storage tolerance nothing thins detail, and simplifying deletes
  // only what lies below every level, so a read at a tolerance reads
  // yesterday by level as well.
  it('refines a day once it ended, with a storage tolerance', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5 }, debug)
    seedHour(store, day0 + 60 * MINUTE)
    store.newPosition(ctx, [60.01, 24.02], day0 + DAY + 61 * MINUTE)
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    store.refineLevels(day0 + DAY + 30 * MINUTE)
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    await expect(store.getTimed(ctx, window, undefined, 20)).resolves.toHaveLength(3600)
    store.refineLevels(day0 + DAY + 70 * MINUTE)
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    expect((await store.getTimed(ctx, window, undefined, 20)).length).toBeLessThan(360)
    await readsAsSimplified(store, window)
    store.close()
  })

  // A source whose clock runs behind the server's dates its fixes into the
  // day for a while after it ended. Refined meanwhile, the day would be sent
  // back by every one of them.
  it('waits to refine a day until the vessel recorded past it, or until it ended a day ago', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5 }, debug)
    seedHour(store, day0 + 22 * 60 * MINUTE)
    seedHour(store, day0 + 120 * MINUTE, other)
    const now = day0 + DAY + 3 * 60 * MINUTE
    store.refineLevels(now)
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    // Dated hours behind the server's clock, into the day and then just past
    // it, within the margin of its end: neither wakes it.
    store.newPosition(ctx, [60.01, 24.02], day0 + 23 * 60 * MINUTE + 30 * MINUTE)
    store.newPosition(ctx, [60.01, 24.03], day0 + DAY + 30 * MINUTE)
    expect(goesOver(store, now + 1)).toEqual({ refining: [], simplifying: [] })
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    // Past it, and it alone is refined, with nothing to simplify yet.
    store.newPosition(ctx, [60.01, 24.04], day0 + DAY + 61 * MINUTE)
    expect(goesOver(store, now + 2)).toEqual({ refining: [ctx], simplifying: [] })
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    // The other vessel recorded nothing since, and waits for the day to end a day ago.
    expect(levels(store, day0, day0 + DAY, other)).toEqual([])
    store.refineLevels(day0 + 2 * DAY + 1)
    expect(levels(store, day0, day0 + DAY, other).length).toBeGreaterThan(1)
    store.close()
  })

  it('refines a day a fix comes in for after the pass found nothing of it', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(day0 + 2 * DAY + 1)
    // A live fix leaves the pass alone.
    store.newPosition(ctx, [60.01, 24.02], day0 + 2 * DAY + 1)
    expect(goesOver(store, day0 + 2 * DAY + 1).refining).toEqual([])
    seedHour(store, day0 + 120 * MINUTE, other)
    expect(goesOver(store, day0 + 2 * DAY + 2).refining).toEqual([other])
    expect(levels(store, day0, day0 + DAY, other).length).toBeGreaterThan(1)
    store.close()
  })

  it('wakes a vessel for a late fix into a day the pass going on went past it in', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5, refineBudget: 500 }, debug)
    const first = 'vessels.a' as Context
    const second = 'vessels.b' as Context
    // A pass the day before finds nothing to do.
    store.refineLevels(day0 + 3 * 60 * MINUTE)
    store.newPosition(first, [60.01, 24.02], day0 + DAY + 2 * 60 * MINUTE)
    seedHour(store, day0 + 60 * MINUTE, second)
    store.newPosition(second, [60.01, 24.02], day0 + DAY + 2 * 60 * MINUTE)
    const now = day0 + DAY + 3 * 60 * MINUTE
    // The next goes past the first, with nothing of the day, and runs out of budget on the second.
    expect(store.refineLevels(now)).toBe(true)
    seedHour(store, day0 + 10 * 60 * MINUTE, first)
    for (let i = 0; i < 100 && store.refineLevels(now); i++) {
      // until it has nothing left
    }
    expect(levels(store, day0, day0 + DAY, first).length).toBeGreaterThan(1)
    store.close()
  })

  it('goes over the vessels again after a change the pass going on may have gone past', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5, refineBudget: 500 }, debug)
    const first = 'vessels.a' as Context
    const second = 'vessels.b' as Context
    store.newPosition(first, [60.01, 24.02], day0 + DAY + 2 * 60 * MINUTE)
    seedHour(store, day0 + 60 * MINUTE, second)
    store.newPosition(second, [60.01, 24.02], day0 + DAY + 2 * 60 * MINUTE)
    const now = day0 + DAY + 3 * 60 * MINUTE
    expect(store.refineLevels(now)).toBe(true)
    store.fillTrack(first, [
      Array.from({ length: 3600 }, (_, i) => ({
        position: [60 + Math.sin(i / 400) * 0.002 + noise(i) * 0.00002, 24 + i * 0.000005] as LatLngTuple,
        timestamp: day0 + 10 * 60 * MINUTE + i * 1000,
      })),
    ])
    for (let i = 0; i < 100 && store.refineLevels(now); i++) {
      // until it has nothing left
    }
    expect(levels(store, day0, day0 + DAY, first).length).toBeGreaterThan(1)
    store.close()
  })

  it('goes over the vessels again after a vessel the pass went past was replaced', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5, refineBudget: 500 }, debug)
    const first = 'vessels.a' as Context
    const second = 'vessels.b' as Context
    store.newPosition(first, [60.01, 24.02], day0 + DAY + 2 * 60 * MINUTE)
    seedHour(store, day0 + 60 * MINUTE, second)
    store.newPosition(second, [60.01, 24.02], day0 + DAY + 2 * 60 * MINUTE)
    const now = day0 + DAY + 3 * 60 * MINUTE
    expect(store.refineLevels(now)).toBe(true)
    const hour = Array.from({ length: 3600 }, (_, i) => i)
    store.initialTrack(
      first,
      [
        ...hour.map((i): LatLngTuple => [60 + Math.sin(i / 400) * 0.002 + noise(i) * 0.00002, 24 + i * 0.000005]),
        [60.01, 24.02],
      ],
      [...hour.map((i) => day0 + 10 * 60 * MINUTE + i * 1000), day0 + DAY + 2 * 60 * MINUTE],
    )
    for (let i = 0; i < 100 && store.refineLevels(now); i++) {
      // until it has nothing left
    }
    expect(levels(store, day0, day0 + DAY, first).length).toBeGreaterThan(1)
    store.close()
  })

  // Out of time order, as with a resolution of 0, a fix can come in for a
  // day before the one a vessel waits on, which the pass found nothing of.
  it('wakes a waiting vessel for a fix dated into a day before the one it waits on', () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5 }, debug)
    seedHour(store, day0 + 22 * 60 * MINUTE)
    const now = day0 + DAY + 3 * 60 * MINUTE
    store.refineLevels(now)
    expect(store['refineWaiting'].has(ctx)).toBe(true)
    seedHour(store, day0 - DAY + 60 * MINUTE)
    expect(goesOver(store, now + 1).refining).toEqual([ctx])
    expect(levels(store, day0 - DAY, day0).length).toBeGreaterThan(1)
    // And waits on its day again.
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    expect(store['refineWaiting'].has(ctx)).toBe(true)
    store.close()
  })

  it('lets a vessel stop waiting once the recycle bin holds every position of it', () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5 }, debug)
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(day0 + DAY + 3 * 60 * MINUTE)
    expect(store['refineWaiting'].has(ctx)).toBe(true)
    store.binRecorded(ctx, undefined, day0 + DAY, day0 + DAY, false)
    expect(store['refineWaiting'].has(ctx)).toBe(false)
    store.close()
  })

  it('goes over the vessels again when a cutoff moved while the pass went on', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5, refineBudget: 500 }, debug)
    const first = 'vessels.a' as Context
    const second = 'vessels.b' as Context
    seedHour(store, day0 + 60 * MINUTE, first)
    store.newPosition(first, [60.01, 24.02], day0 + DAY + 61 * MINUTE)
    seedHour(store, day0 - DAY + 60 * MINUTE, second)
    // Within the margin of the day's end, the pass refines the second's day
    // before and runs out of budget; an hour later it goes on.
    expect(store.refineLevels(day0 + DAY + 30 * MINUTE)).toBe(true)
    for (let i = 0; i < 100 && store.refineLevels(day0 + DAY + 3 * 60 * MINUTE); i++) {
      // until it has nothing left
    }
    expect(levels(store, day0, day0 + DAY, first).length).toBeGreaterThan(1)
    store.close()
  })

  it('refines a vessel a fix woke after the pass going on went past it', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', storageTolerance: 0.5, refineBudget: 500 }, debug)
    const first = 'vessels.a' as Context
    const second = 'vessels.b' as Context
    seedHour(store, day0 + 60 * MINUTE, first)
    seedHour(store, day0 + 60 * MINUTE, second)
    store.newPosition(second, [60.01, 24.02], day0 + DAY + 61 * MINUTE)
    const now = day0 + DAY + 3 * 60 * MINUTE
    // The pass goes past the first, which waits, and runs out of budget on the second.
    expect(store.refineLevels(now)).toBe(true)
    store.newPosition(first, [60.01, 24.02], day0 + DAY + 61 * MINUTE)
    for (let i = 0; i < 100 && store.refineLevels(now); i++) {
      // until it has nothing left
    }
    expect(levels(store, day0, day0 + DAY, first).length).toBeGreaterThan(1)
    expect(levels(store, day0, day0 + DAY, second).length).toBeGreaterThan(1)
    store.close()
  })

  // A receiver's AIS traffic is thousands of vessels with a fix or two a
  // day; counted by positions alone, one call would take on all their days.
  it('charges each day a cost of its own, so many small days take several calls', () => {
    const store = newStore()
    for (let c = 0; c < 300; c++) {
      store.newPosition(`vessels.urn:mrn:imo:mmsi:${200000000 + c}` as Context, [60, 24 + c * 1e-4], day0)
    }
    const refined = () => (store['db'].prepare('SELECT count(*) AS n FROM level_frontier').get() as { n: number }).n
    store.refineLevels(later)
    expect(refined()).toBeGreaterThan(0)
    expect(refined()).toBeLessThan(300)
    for (let i = 0; i < 10 && refined() < 300; i++) {
      store.refineLevels(later)
    }
    expect(refined()).toBe(300)
    store.close()
  })

  it('stops after its budget and goes on where it stopped', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 1000 }, debug)
    for (let d = 0; d < 3; d++) {
      seedHour(store, day0 + d * DAY)
    }
    const refined = () => [0, 1, 2].map((d) => levels(store, day0 + d * DAY, day0 + (d + 1) * DAY).length > 1)
    store.refineLevels(day0 + 5 * DAY)
    expect(refined()).toEqual([true, false, false])
    store.refineLevels(day0 + 5 * DAY)
    expect(refined()).toEqual([true, true, false])
    store.refineLevels(day0 + 5 * DAY)
    expect(refined()).toEqual([true, true, true])
    store.close()
  })

  it('says whether it left work for another call', () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 1000 }, debug)
    for (let d = 0; d < 3; d++) {
      seedHour(store, day0 + d * DAY)
    }
    const refined = () => [0, 1, 2].every((d) => levels(store, day0 + d * DAY, day0 + (d + 1) * DAY).length > 1)
    const answers: boolean[] = []
    for (let i = 0; i < 10 && answers.at(-1) !== false; i++) {
      answers.push(store.refineLevels(day0 + 5 * DAY))
    }
    expect(answers.slice(0, 3)).toEqual([true, true, true])
    expect(answers.at(-1)).toBe(false)
    expect(refined()).toBe(true)
    expect(store.refineLevels(day0 + 5 * DAY)).toBe(false)
    store.close()
  })

  // Each change takes positions out from under the levels of the day it
  // touches, or adds some: that day's significant positions go, the day is
  // read from positions until the next refinement measures it again.
  const changes: [string, (store: SqliteTrackStore) => void][] = [
    [
      'a span moved to the recycle bin',
      (store) => store.binRecorded(ctx, day0 + 80 * MINUTE, day0 + 90 * MINUTE, later, false),
    ],
    [
      'a span restored from the recycle bin',
      (store) => {
        const { id } = store.binRecorded(ctx, day0 + 80 * MINUTE, day0 + 90 * MINUTE, later, false)
        store.refineLevels(later)
        store.restoreFromBin(id!)
      },
    ],
    [
      'a track recorded over part of it',
      (store) =>
        store.recordTrack(
          ctx,
          [
            Array.from({ length: 60 }, (_, i) => ({
              position: [60.01, 24 + i * 0.0001],
              timestamp: day0 + 80 * MINUTE + i * 1000,
            })),
          ],
          later,
          false,
        ),
    ],
    ['a fix dated into it', (store) => store.newPosition(ctx, [60.05, 24.05], day0 + 75 * MINUTE + 500)],
    ['its first half aged out', (store) => store.prune(later - (day0 + 90 * MINUTE), undefined, later)],
  ]
  it.each(changes)('measures a day again after %s', async (_, change) => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(later)
    expect(visitHours(store, day0, day0 + DAY)).toBeGreaterThan(0)
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    change(store)
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    expect(visitHours(store, day0, day0 + DAY)).toBe(0)
    await readsAsSimplified(store, window)
    expect(await boxRead(store, window, 20)).toEqual(await boxRead(store, window))
    store.refineLevels(later)
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    await readsAsSimplified(store, window)
    expect((await boxRead(store, window, 20)).length).toBeLessThan((await boxRead(store, window)).length)
    store.close()
  })

  // 15,000 positions a second apart, no pause: cut into pieces of 6,000, one
  // per call at a budget of 6,000.
  const seedDense = (store: SqliteTrackStore) => {
    for (let i = 0; i < 15_000; i++) {
      store.newPosition(ctx, [60 + Math.sin(i / 700) * 0.003 + noise(i) * 0.00002, 24 + i * 0.000005], day0 + i * 1000)
    }
  }
  const refinedCount = (store: SqliteTrackStore) =>
    (
      store['db']
        .prepare(
          'SELECT count(*) AS n FROM significant WHERE context_id = (SELECT id FROM contexts WHERE context = ?) AND level < 31',
        )
        .get(ctx) as {
        n: number
      }
    ).n

  it('refines a long day over several calls, going on where each stopped', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 6000 }, debug)
    seedDense(store)
    const counts: number[] = []
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    const all = await store.getTimed(ctx, window)
    for (let call = 0; call < 3; call++) {
      store.refineLevels(later)
      counts.push(refinedCount(store))
      // Until the day is done, a read takes it from positions.
      if (call < 2) {
        expect(await store.getTimed(ctx, window, undefined, 20)).toEqual(all)
        expect(await boxRead(store, window, 20)).toEqual(await boxRead(store, window))
      }
    }
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[0]).toBeLessThan(counts[1]!)
    expect(counts[1]).toBeLessThan(counts[2]!)
    expect(store['db'].prepare('SELECT through FROM level_frontier WHERE context = ?').get(ctx)).toEqual({
      through: Math.floor(day0 / DAY),
    })
    const read = await store.getTimed(ctx, window, undefined, 20)
    expect(read.length).toBeLessThan(all.length / 2)
    const times = new Set(all.map(({ timestamp }) => timestamp))
    expect(read.every(({ timestamp }) => times.has(timestamp))).toBe(true)
    store.close()
  })

  it('refines a day again once a history import fills part of it', async () => {
    const store = newStore()
    seedHour(store, day0)
    store.refineLevels(later)
    const filled = Array.from({ length: 60 }, (_, i) => ({
      position: [60.01, 24.01 + i * 1e-5] as LatLngTuple,
      timestamp: day0 + 120 * MINUTE + i * 1000,
    }))
    store.saveHistoryImport({ context: ctx, startedAt: later, filled: 60 }, [filled])
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    const all = await store.getTimed(ctx, window)
    expect(all.filter(({ timestamp }) => timestamp >= filled[0]!.timestamp)).toEqual(
      filled.map(({ position, timestamp }) => ({ position: rounded(position), timestamp })),
    )
    // Until refined again, a read at a tolerance reads every position, the filled ones too.
    expect(await store.getTimed(ctx, window, undefined, 20)).toEqual(all)
    store.refineLevels(later)
    expect((await store.getTimed(ctx, window, undefined, 20)).length).toBeLessThan(all.length / 2)
    await readsAsSimplified(store, window)
    store.close()
  })

  it('starts a day refined in part over when a change reaches it', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 6000 }, debug)
    seedDense(store)
    store.refineLevels(later)
    expect(refinedCount(store)).toBeGreaterThan(0)
    store.binRecorded(ctx, day0 + 100_000, day0 + 110_000, later, false)
    expect(refinedCount(store)).toBe(0)
    for (let call = 0; call < 3; call++) {
      store.refineLevels(later)
    }
    expect(store['db'].prepare('SELECT through FROM level_frontier WHERE context = ?').get(ctx)).toEqual({
      through: Math.floor(day0 / DAY),
    })
    store.close()
  })

  it('starts over a day it was refining when the store closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-levels-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file, refineBudget: 6000 }, debug)
      // One commit: written to a file one by one, 15,000 positions take a Windows runner most of a minute.
      first.transaction(() => seedDense(first))
      first.refineLevels(later)
      expect(refinedCount(first)).toBeGreaterThan(0)
      first.close()
      const store = new SqliteTrackStore({ file, refineBudget: 6000 }, debug)
      for (let call = 0; call < 3; call++) {
        store.refineLevels(later)
      }
      const fresh = new SqliteTrackStore({ file: ':memory:', refineBudget: 6000 }, debug)
      seedDense(fresh)
      for (let call = 0; call < 3; call++) {
        fresh.refineLevels(later)
      }
      const kept = (s: SqliteTrackStore) =>
        s['db'].prepare('SELECT timestamp, level FROM significant ORDER BY timestamp, level').all()
      expect(kept(store)).toEqual(kept(fresh))
      fresh.close()
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts and ends a read at a tolerance at the first and last position of its window', async () => {
    const store = newStore()
    // Straight, so the level keeps only the ends of the hour.
    for (let i = 0; i < 3600; i++) {
      store.newPosition(ctx, [60, 24 + i * 0.00001], day0 + 60 * MINUTE + i * 1000)
    }
    store.refineLevels(later)
    const window: TimeWindow = { from: day0 + 80 * MINUTE + 500, to: day0 + 100 * MINUTE + 500 }
    const all = await store.getTimed(ctx, window)
    const read = await store.getTimed(ctx, window, undefined, 20)
    expect(read).toEqual([all[0], all.at(-1)])
    store.close()
  })

  it('refines a day filled in before the one it is in the middle of', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 6000 }, debug)
    for (let i = 0; i < 15_000; i++) {
      store.newPosition(
        ctx,
        [60 + Math.sin(i / 700) * 0.003 + noise(i) * 0.00002, 24 + i * 0.000005],
        day0 + DAY + i * 1000,
      )
    }
    store.refineLevels(later)
    // Dated into the day before, which had nothing when the pass went past it.
    seedHour(store, day0 + 60 * MINUTE)
    for (let call = 0; call < 4; call++) {
      store.refineLevels(later)
    }
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    await readsAsSimplified(store, { from: day0, to: day0 + DAY })
    store.close()
  })

  it('leaves nothing of a day a restart stopped inside and that was emptied since', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-levels-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file, refineBudget: 6000 }, debug)
      // One commit: written to a file one by one, 15,000 positions take a Windows runner most of a minute.
      first.transaction(() => seedDense(first))
      first.refineLevels(later)
      expect(refinedCount(first)).toBeGreaterThan(0)
      first.close()
      const store = new SqliteTrackStore({ file, refineBudget: 6000 }, debug)
      store.binRecorded(ctx, day0, day0 + DAY - 1, later, false)
      seedHour(store, day0 + DAY + 60 * MINUTE)
      store.refineLevels(later)
      expect(levels(store, day0 + DAY, day0 + 2 * DAY).length).toBeGreaterThan(1)
      expect(levels(store, day0, day0 + DAY)).toEqual([])
      expect(visitHours(store, day0, day0 + DAY)).toBe(0)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes back what a refinement rolled back did to its state', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    const all = await store.getTimed(ctx, window)
    expect(() =>
      store.transaction(() => {
        store.refineLevels(later)
        throw new Error('stop')
      }),
    ).toThrow('stop')
    expect(await store.getTimed(ctx, window, undefined, 20)).toEqual(all)
    store.refineLevels(later)
    expect((await store.getTimed(ctx, window, undefined, 20)).length).toBeLessThan(all.length / 2)
    store.close()
  })

  it('reads a day a change sent back from positions while it is refined again', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 6000 }, debug)
    seedDense(store)
    for (let call = 0; call < 3; call++) {
      store.refineLevels(later)
    }
    store.binRecorded(ctx, day0 + 100_000, day0 + 110_000, later, false)
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    const all = await store.getTimed(ctx, window)
    const box = await boxRead(store, window)
    for (let call = 0; call < 2; call++) {
      store.refineLevels(later)
      expect(refinedCount(store)).toBeGreaterThan(0)
      expect(await store.getTimed(ctx, window, undefined, 20)).toEqual(all)
      expect(await boxRead(store, window, 20)).toEqual(box)
    }
    store.refineLevels(later)
    expect((await store.getTimed(ctx, window, undefined, 20)).length).toBeLessThan(all.length / 2)
    expect((await boxRead(store, window, 20)).length).toBeLessThan(box.length / 2)
    store.close()
  })

  it('measures a day again after its first half passes the retention', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', retention: later - (day0 + 90 * MINUTE) }, debug)
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(later)
    store.prune(Infinity, ctx, later)
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    store.refineLevels(later)
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    await readsAsSimplified(store, { from: day0, to: day0 + DAY })
    store.close()
  })

  it('measures both days again after a span over midnight goes to the recycle bin', async () => {
    const store = newStore()
    seedHour(store, day0 + 23 * 60 * MINUTE)
    seedHour(store, day0 + DAY)
    store.refineLevels(later)
    store.binRecorded(ctx, day0 + 23 * 60 * MINUTE + 30 * MINUTE, day0 + DAY + 30 * MINUTE, later, false)
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    expect(levels(store, day0 + DAY, day0 + 2 * DAY)).toEqual([])
    store.close()
  })

  it('measures a vessel again from scratch once its track is replaced', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    store.refineLevels(later)
    store.initialTrack(
      ctx,
      [
        [60, 24],
        [60.1, 24.1],
        [60, 24.2],
      ],
      [day0 + MINUTE, day0 + 2 * MINUTE, day0 + 3 * MINUTE],
    )
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    expect(visitHours(store, day0, day0 + DAY)).toBe(0)
    store.refineLevels(later)
    // Three positions: the two ends no tolerance drops, the middle one by its distance.
    expect(levels(store, day0, day0 + DAY)).toHaveLength(2)
    expect(store['db'].prepare('SELECT through FROM level_frontier WHERE context = ?').get(ctx)).toEqual({
      through: Math.floor(day0 / DAY),
    })
    store.close()
  })

  it('measures a stay at anchor again when its older part is thinned anew, not for each hour that ages', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    const start = day0 + 22 * 60 * MINUTE
    const record = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        const position: LatLngTuple = [60 + Math.sin(i / 600) * 0.0003, 24 + Math.cos(i / 600) * 0.0003]
        store.newPosition(ctx, position, start + i * 1000, 1000)
      }
    }
    // 30 hours at 1 s with a 60 s resolution: a stay still going on, whose
    // older part each prune thins, to 2 s.
    record(0, 30 * 3600)
    const first = day0 + 60 * 60 * MINUTE
    store.prune(Infinity, ctx, first)
    store.refineLevels(first)
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    // An hour on, at the same spacing, only that hour is thinned.
    store.prune(Infinity, ctx, first + 60 * MINUTE)
    expect(levels(store, day0, day0 + DAY).length).toBeGreaterThan(1)
    // Twenty hours more widen the spacing to 3 s, which thins all of the stay again.
    record(30 * 3600, 50 * 3600)
    store.prune(Infinity, ctx, first + 2 * 60 * MINUTE)
    expect(levels(store, day0, day0 + DAY)).toEqual([])
    store.close()
  })

  it('reads a box for a named vessel at a tolerance as what the level keeps in the hours it was there, and the next kept either side', async () => {
    const store = newStore()
    // Three hours east, the box over part of the second.
    for (let i = 0; i < 3 * 3600; i++) {
      const lat = 60 + Math.sin(i / 400) * 0.002 + noise(i) * 0.00002
      store.newPosition(ctx, [lat, 24 + i * 0.000005], day0 + 60 * MINUTE + i * 1000)
    }
    store.newPosition(other, [60.001, 24.025], day0 + 70 * MINUTE)
    // 10,800 positions, two calls' worth.
    store.refineLevels(later)
    store.refineLevels(later)
    const box: GeoBounds = { sw: [59.99, 24.022], ne: [60.01, 24.028] }
    const params = { bbox: box, radius: null, intersects: true, clip: true, contexts: [ctx] }
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    const all = (await store.getFilteredTimedTracks(params, undefined, undefined, { window }))[ctx]!
    const read = (await store.getFilteredTimedTracks(params, undefined, undefined, { window, tolerance: 20 }))[ctx]!
    expect(read.length).toBeLessThan(all.length / 2)
    const kept = await store.getTimed(ctx, window, undefined, 20)
    const second = ({ timestamp }: TimedPosition) =>
      timestamp >= day0 + 120 * MINUTE && timestamp <= day0 + 180 * MINUTE
    const first = kept.findIndex(second)
    const last = kept.findLastIndex(second)
    expect(first).toBeGreaterThan(0)
    expect(last).toBeLessThan(kept.length - 1)
    expect(read).toEqual(kept.slice(first - 1, last + 2))
    store.close()
  })

  it('reads a box a straight leg crosses with nothing kept inside it', async () => {
    const store = newStore()
    // Straight, so the level keeps only the ends of the hour, either side of the box.
    for (let i = 0; i < 3600; i++) {
      store.newPosition(ctx, [60, 24 + i * 0.00001], day0 + 60 * MINUTE + i * 1000)
    }
    store.refineLevels(later)
    const box: GeoBounds = { sw: [59.99, 24.01], ne: [60.01, 24.02] }
    const params = { bbox: box, radius: null, intersects: true, clip: true, contexts: [ctx] }
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    for (const from of [day0, day0 + 60 * MINUTE + 500_000]) {
      // From inside the leg too, where the line starts at the window's first position.
      const read = (
        await store.getFilteredTimedTracks(params, undefined, undefined, { window: { ...window, from }, tolerance: 20 })
      )[ctx]
      expect(read).toHaveLength(2)
      expect(read![0]!.timestamp).toBeGreaterThanOrEqual(from)
      expect(read!.some(({ position }) => createInBounds(box)(position))).toBe(false)
      expect(createReachesBounds(box)(read!)).toBe(true)
    }
    store.close()
  })

  it('marks a stretch read by level apart from the one before, so no line is drawn between them across the box', async () => {
    const store = newStore()
    // Five-minute fixes: an hour east through the box and out, the rest of
    // the day still to the east of it, a day round the north, and half a
    // day still to the west before going back in. The positions either
    // side of the two stretches are then the ends of the days to the east
    // and west, with the day round the north kept between them.
    const east: LatLngTuple = [60.5, 25.5]
    const west: LatLngTuple = [60.5, 23.5]
    const positions: LatLngTuple[] = [
      ...Array.from({ length: 12 }, (_, i): LatLngTuple => [60.5, 24.2 + i * 0.05]),
      ...Array.from({ length: 276 }, (): LatLngTuple => east),
      ...Array.from({ length: 96 }, (_, i): LatLngTuple => [60.5 + i * 0.016, 25.5]),
      ...Array.from({ length: 96 }, (_, i): LatLngTuple => [62, 25.5 - i * 0.021]),
      ...Array.from({ length: 96 }, (_, i): LatLngTuple => [62 - i * 0.016, 23.5]),
      ...Array.from({ length: 144 }, (): LatLngTuple => west),
      ...Array.from({ length: 12 }, (_, i): LatLngTuple => [60.5, 24.1 + i * 0.05]),
    ]
    const step = 5 * MINUTE
    positions.forEach((position, i) => store.newPosition(ctx, position, day0 + i * step))
    store.refineLevels(day0 + 6 * DAY)
    store.refineLevels(day0 + 6 * DAY)
    const box: GeoBounds = { sw: [60, 24], ne: [61, 25] }
    const window: TimeWindow = { from: day0, to: day0 + 5 * DAY }
    const params = { bbox: box, radius: null, intersects: true, clip: true, contexts: [ctx] }
    const read = (await store.getFilteredTimedTracks(params, undefined, undefined, { window, tolerance: 20 }))[ctx]!
    const kept = await store.getTimed(ctx, window, undefined, 20)
    expect(read.length).toBeLessThan(kept.length)
    expect(clipToBounds(read, box)).toEqual(clipToBounds(kept, box))
    store.close()
  })

  it('takes two positions kept at the same time for the line they are, between two stretches read by level', async () => {
    const store = newStore()
    // Out to the east and, at the same time, to the west: the line between
    // the two runs through the box, and nothing is kept between them.
    const positions: LatLngTuple[] = [
      [60.5, 24.5],
      [60.5, 25.5],
      [60.5, 23.5],
      [60.5, 24.4],
    ]
    // A day from the hours inside, so each is the next kept beside a stretch.
    const times = [day0, day0 + DAY, day0 + DAY, day0 + 2 * DAY]
    positions.forEach((position, i) => store.newPosition(ctx, position, times[i]!))
    store.refineLevels(day0 + 6 * DAY)
    store.refineLevels(day0 + 6 * DAY)
    const box: GeoBounds = { sw: [60, 24], ne: [61, 25] }
    const window: TimeWindow = { from: day0, to: day0 + 5 * DAY }
    const params = { bbox: box, radius: null, intersects: true, clip: true, contexts: [ctx] }
    const read = (await store.getFilteredTimedTracks(params, undefined, undefined, { window, tolerance: 20 }))[ctx]!
    const kept = await store.getTimed(ctx, window, undefined, 20)
    expect(levels(store, day0, day0 + 3 * DAY)).not.toEqual([])
    expect(read).toHaveLength(4)
    expect(clipToBounds(read, box)).toEqual(clipToBounds(kept, box))
    store.close()
  })

  it('reads a box for a named vessel at a tolerance from both, where only some days are refined', async () => {
    const store = newStore()
    seedHour(store, day0 + 60 * MINUTE)
    seedHour(store, day0 + DAY + 60 * MINUTE)
    store.refineLevels(day0 + 2 * DAY + 1)
    const box: GeoBounds = { sw: [59.99, 23.99], ne: [60.01, 24.01] }
    const params = { bbox: box, radius: null, intersects: true, clip: true, contexts: [ctx] }
    const window: TimeWindow = { from: day0, to: day0 + 2 * DAY }
    const all = (await store.getFilteredTimedTracks(params, undefined, undefined, { window }))[ctx]!
    const read = (await store.getFilteredTimedTracks(params, undefined, undefined, { window, tolerance: 20 }))[ctx]!
    const second = ({ timestamp }: TimedPosition) => timestamp >= day0 + DAY
    // The day not refined yet comes whole, the refined one by level.
    expect(read.filter(second)).toEqual(all.filter(second))
    expect(read.filter((p) => !second(p)).length).toBeLessThan(all.filter((p) => !second(p)).length / 2)
    store.close()
  })
})

describe('requested contexts', () => {
  const third = 'vessels.urn:mrn:imo:mmsi:230000001' as Context
  const helsinki: LatLngTuple = [60.16, 24.94]
  const stockholm: LatLngTuple = [59.33, 18.07]

  const seeded = (): SqliteTrackStore => {
    const store = newStore()
    store.newPosition(ctx, helsinki, 1000)
    store.newPosition(other, helsinki, 1000)
    store.newPosition(third, stockholm, 1000)
    return store
  }

  it('returns every requested context and reads no other', async () => {
    const store = seeded()
    const getTimed = vi.spyOn(store, 'getTimed')

    const tracks = await store.getFilteredTimedTracks({ bbox: null, radius: null, contexts: [ctx, third] })
    expect(Object.keys(tracks).sort()).toEqual([ctx, third].sort())
    expect(getTimed.mock.calls.map(([context]) => context).sort()).toEqual([ctx, third].sort())
    store.close()
  })

  it('returns only the requested contexts the box lets through', async () => {
    const store = seeded()
    const bounds: GeoBounds = { sw: [60, 24], ne: [61, 26] }

    const tracks = await store.getFilteredTimedTracks({
      bbox: bounds,
      radius: null,
      intersects: true,
      contexts: [ctx, third],
    })
    expect(Object.keys(tracks)).toEqual([ctx])
    store.close()
  })

  // A chart view over a busy harbour holds every AIS position ever recorded
  // there, and an own-vessel trail asked for that view must not read them.
  // That is a cost with no visible effect on the answer, so the spy on the
  // cell prefilter is what pins it.
  it('answers requested contexts without the cell prefilter', async () => {
    const store = seeded()
    const prefilter = vi.spyOn(store as unknown as { contextsInBounds: () => Set<string> }, 'contextsInBounds')
    const bounds: GeoBounds = { sw: [60, 24], ne: [61, 26] }
    const unknown = 'vessels.urn:mrn:imo:mmsi:230000099' as Context

    const tracks = await store.getFilteredTimedTracks({
      bbox: bounds,
      radius: null,
      intersects: true,
      contexts: [ctx, unknown],
    })
    expect(Object.keys(tracks)).toEqual([ctx])
    expect(prefilter).not.toHaveBeenCalled()
    await store.getFilteredTimedTracks({ bbox: bounds, radius: null, intersects: true })
    expect(prefilter).toHaveBeenCalledOnce()
    store.close()
  })

  it('reads every context when none is requested', async () => {
    const store = seeded()

    const tracks = await store.getFilteredTimedTracks({ bbox: null, radius: null })
    expect(Object.keys(tracks).sort()).toEqual([ctx, other, third].sort())
    store.close()
  })
})

describe('summaries', () => {
  const MINUTE = 60_000
  const third = 'vessels.urn:mrn:imo:mmsi:230000001' as Context

  const seeded = (): SqliteTrackStore => {
    const store = newStore()
    for (const [i, position] of (
      [
        [60.1, 24.9],
        [60.3, 25.2],
        [60.2, 25.0],
      ] as LatLngTuple[]
    ).entries()) {
      store.newPosition(ctx, position, i * MINUTE)
    }
    // across the antimeridian
    for (const [i, position] of (
      [
        [-17.8, 179.5],
        [-17.7, -179.6],
        [-17.6, 179.9],
      ] as LatLngTuple[]
    ).entries()) {
      store.newPosition(other, position, i * MINUTE)
    }
    store.newPosition(third, [59.33, 18.07], 5 * MINUTE)
    return store
  }

  /** What the points themselves say, which a summary must match. */
  const fromPoints = async (store: SqliteTrackStore, context: Context, window?: TimeWindow) => {
    const points = await store.getTimed(context, window)
    const [west, east] = longitudeSpan(points.map(({ position }) => position[1]))
    const lats = points.map(({ position }) => position[0])
    return {
      context,
      pointCount: points.length,
      first: points[0]!.timestamp,
      last: points[points.length - 1]!.timestamp,
      bbox: [west, Math.min(...lats), east, Math.max(...lats)],
    }
  }

  it('says what the points of every context say', async () => {
    const store = seeded()

    const summaries = store.summarize(undefined)
    expect(summaries.map(({ context }) => context).sort()).toEqual([ctx, other, third].sort())
    for (const summary of summaries) {
      expect(summary).toEqual(await fromPoints(store, summary.context))
    }
    expect(summaries.find(({ context }) => context === other)!.bbox).toEqual([179.5, -17.8, -179.6, -17.6])
    store.close()
  })

  it('keeps to the window, half-open unless its end is inclusive', async () => {
    const store = seeded()

    for (const window of [
      { from: MINUTE, to: 2 * MINUTE },
      { from: MINUTE, to: 2 * MINUTE, inclusiveEnd: true },
    ]) {
      const summaries = store.summarize([ctx, third], window)
      expect(summaries).toEqual([await fromPoints(store, ctx, window)])
    }
    store.close()
  })

  it('reads every longitude of a track wider than half the globe', async () => {
    const store = newStore()
    // Its widest gap, between -150 and -30, holds neither meridian, so no two
    // extremes bound it.
    for (const [i, lon] of [-150, -30, 20, 120].entries()) {
      store.newPosition(ctx, [10, lon], i * MINUTE)
    }

    const [summary] = store.summarize(undefined)
    expect(summary).toEqual(await fromPoints(store, ctx))
    expect(summary!.bbox).toEqual([-30, 10, -150, 10])
    store.close()
  })

  it('reads only the longitudes in the window of a track wider than half the globe', async () => {
    const store = newStore()
    for (const [i, lon] of [-150, -30, 20, 120].entries()) {
      store.newPosition(ctx, [10, lon], i * MINUTE)
    }
    // Read too, it would move the widest gap to between 20 and 120.
    store.newPosition(ctx, [10, -90], 10 * MINUTE)
    const window = { from: 0, to: 5 * MINUTE }

    const [summary] = store.summarize(undefined, window)
    expect(summary).toEqual(await fromPoints(store, ctx, window))
    expect(summary!.bbox).toEqual([-30, 10, -150, 10])
    store.close()
  })

  it('leaves out a requested context the store has not recorded', () => {
    const store = seeded()

    const unknown = 'vessels.urn:mrn:imo:mmsi:230000099' as Context
    expect(store.summarize([ctx, unknown]).map(({ context }) => context)).toEqual([ctx])
    store.close()
  })
})

describe('clip reads', () => {
  const MINUTE = 60_000
  const box: GeoBounds = { sw: [60, 24], ne: [61, 25] }
  const inside: LatLngTuple = [60.5, 24.5]
  const outside: LatLngTuple = [59, 20]

  /** A day outside, an hour inside, a day outside, an hour inside, an hour outside; one fix a minute. */
  const seeded = (store = newStore()): { store: SqliteTrackStore; all: TimedPosition[] } => {
    const legs: [LatLngTuple, number][] = [
      [outside, 24 * 60],
      [inside, 60],
      [outside, 24 * 60],
      [inside, 60],
      [outside, 60],
    ]
    const all: TimedPosition[] = []
    for (const [position, minutes] of legs) {
      for (let i = 0; i < minutes; i++) {
        all.push({ position, timestamp: all.length * MINUTE })
      }
    }
    store.initialTrack(
      ctx,
      all.map(({ position }) => position),
      all.map(({ timestamp }) => timestamp),
    )
    store.newPosition(other, outside, 0)
    return { store, all }
  }

  it('reads only the stretches inside the box and the point either side of each', async () => {
    const { store, all } = seeded()
    const getTimed = vi.spyOn(store, 'getTimed')

    const tracks = await store.getFilteredTimedTracks({ bbox: box, radius: null, intersects: true, clip: true })
    expect(Object.keys(tracks)).toEqual([ctx])
    expect(getTimed).not.toHaveBeenCalled()
    expect(tracks[ctx]).toHaveLength(2 * (60 + 2))
    // Narrowing the read changes nothing the clip keeps.
    expect(clipToBounds(tracks[ctx]!, box)).toEqual(clipToBounds(all, box))
    store.close()
  })

  // An own-vessel trail asked for a view over a busy anchorage must not read
  // the AIS traffic recorded there. That is a cost with no visible effect on
  // the answer, so the spy on the clip read is what pins it.
  it('marks a stretch read apart from the one before, so no line is drawn between them across the box', async () => {
    const store = newStore()
    // In, out to the east, half an hour round the north, back in from the west.
    const positions: LatLngTuple[] = [
      [60.5, 24.5],
      [60.5, 25.5],
      ...Array.from({ length: 28 }, (_, i): LatLngTuple => [62, 25.5 - i * 0.1]),
      [60.5, 23.5],
      [60.5, 24.4],
    ]
    const all = positions.map((position, i) => ({ position, timestamp: i * MINUTE }))
    store.initialTrack(
      ctx,
      positions,
      all.map(({ timestamp }) => timestamp),
    )
    const tracks = await store.getFilteredTimedTracks({
      bbox: box,
      radius: null,
      intersects: true,
      clip: true,
      contexts: [ctx],
    })
    expect(tracks[ctx]).toHaveLength(4)
    expect(clipToBounds(tracks[ctx]!, box)).toEqual(clipToBounds(all, box))
    store.close()
  })

  it('takes two positions recorded at the same time for the line they are, between two stretches', async () => {
    const store = newStore()
    // Out to the east and, at the same time, to the west: the line between
    // the two runs through the box, and nothing lies between them.
    const positions: LatLngTuple[] = [
      [60.5, 24.5],
      [60.5, 25.5],
      [60.5, 23.5],
      [60.5, 24.4],
    ]
    const times = [0, MINUTE, MINUTE, 21 * MINUTE]
    const all = positions.map((position, i) => ({ position, timestamp: times[i]! }))
    store.initialTrack(ctx, positions, times)
    const tracks = await store.getFilteredTimedTracks({
      bbox: box,
      radius: null,
      intersects: true,
      clip: true,
      contexts: [ctx],
    })
    expect(tracks[ctx]).toHaveLength(4)
    expect(clipToBounds(tracks[ctx]!, box)).toEqual(clipToBounds(all, box))
    store.close()
  })

  it('reads near the box only the requested contexts', async () => {
    const { store, all } = seeded()
    store.newPosition(other, inside, MINUTE)
    const near = vi.spyOn(store as unknown as { rowsNearBounds: () => Map<Context, unknown[]> }, 'rowsNearBounds')

    const tracks = await store.getFilteredTimedTracks({
      bbox: box,
      radius: null,
      intersects: true,
      clip: true,
      contexts: [ctx],
    })
    expect(Object.keys(tracks)).toEqual([ctx])
    expect(clipToBounds(tracks[ctx]!, box)).toEqual(clipToBounds(all, box))
    expect([...near.mock.results[0]!.value.keys()]).toEqual([ctx])
    await store.getFilteredTimedTracks({ bbox: box, radius: null, intersects: true, clip: true })
    expect([...near.mock.results[1]!.value.keys()].sort()).toEqual([ctx, other].sort())
    store.close()
  })

  // A named vessel is read one cell range at a time, so its times arrive in
  // cell order. The middle visit lies in another corner of the box than the
  // first and the last, so cell order and time order differ.
  it('reads the visits of a named vessel in time order whatever cells they lie in', async () => {
    // Counting one row of box and window: never fewer in the window, so read by cell.
    const store = new SqliteTrackStore({ file: ':memory:', readProbeLimit: 1 }, debug)
    const legs: [LatLngTuple, number][] = [
      [outside, 60],
      [[60.9, 24.9], 30],
      [outside, 60],
      [[60.1, 24.1], 30],
      [outside, 60],
      [[60.9, 24.9], 30],
      [outside, 60],
    ]
    const all: TimedPosition[] = []
    for (const [position, minutes] of legs) {
      for (let i = 0; i < minutes; i++) {
        all.push({ position, timestamp: all.length * MINUTE })
      }
    }
    store.initialTrack(
      ctx,
      all.map(({ position }) => position),
      all.map(({ timestamp }) => timestamp),
    )

    const clipped = { bbox: box, radius: null, intersects: true, clip: true }
    const named = await store.getFilteredTimedTracks({ ...clipped, contexts: [ctx] })
    const unnamed = await store.getFilteredTimedTracks(clipped)
    expect(named[ctx]).toEqual(unnamed[ctx])
    expect(clipToBounds(named[ctx]!, box)).toEqual(clipToBounds(all, box))
    store.close()
  })

  // The box holds two hours of the vessel's three days. A window of forty
  // minutes holds fewer rows than the box, the whole track more, and either
  // read must give what the read without named vessels gives. With a limit
  // of 10 both first counts reach it, and the second, to 80, tells them apart.
  it.each([1000, 10])(
    'reads a named vessel by time for a short window and by cell for a long one, counting to %i',
    async (readProbeLimit) => {
      const { store } = seeded(new SqliteTrackStore({ file: ':memory:', readProbeLimit }, debug))
      const db = store['db']
      const prepare = db.prepare.bind(db)
      const prepared: string[] = []
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        prepared.push(sql)
        return prepare(sql)
      })
      const clipped = { bbox: box, radius: null, intersects: true, clip: true }
      const enter = 24 * 60 * MINUTE
      // The statements that read positions, as opposed to the counts before them.
      const reads = [
        [
          { from: enter - 10 * MINUTE, to: enter + 30 * MINUTE },
          'lon FROM positions INDEXED BY idx_context_time_position',
        ],
        [{ from: 0, to: 3 * 24 * 60 * MINUTE }, 'lon FROM positions INDEXED BY idx_context_s2cell'],
      ] as const
      for (const [window, read] of reads) {
        prepared.length = 0
        const named = await store.getFilteredTimedTracks({ ...clipped, contexts: [ctx] }, undefined, undefined, {
          window,
        })
        for (const [, other] of reads) {
          expect(prepared.some((sql) => sql.includes(other))).toBe(other === read)
        }
        const unnamed = await store.getFilteredTimedTracks(clipped, undefined, undefined, { window })
        expect(named[ctx]).toEqual(unnamed[ctx])
      }
      store.close()
    },
  )

  it('keeps the edge points inside the time window', async () => {
    const { store } = seeded()
    const enter = 24 * 60 * MINUTE

    const tracks = await store.getFilteredTimedTracks(
      { bbox: box, radius: null, intersects: true, clip: true },
      undefined,
      undefined,
      { window: { from: enter, to: enter + 30 * MINUTE } },
    )
    expect(tracks[ctx]!.map(({ timestamp }) => timestamp)).toEqual(
      Array.from({ length: 30 }, (_, i) => enter + i * MINUTE),
    )
    store.close()
  })
})

describe('detail at anchor', () => {
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const self = 'vessels.self' as Context

  /** Ten minutes of one fix a second, recorded finer than the store's minute. */
  const anchored = (store: SqliteTrackStore, from: number) => {
    for (let i = 0; i < 600; i++) {
      store.newPosition(self, [60 + i * 1e-6, 24], from + i * 1000, 1000)
    }
  }

  it('keeps the detail while it is recent', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      anchored(store, now - DAY / 2)
      store.prune(Infinity, self, now)
      await expect(store.getTimed(self)).resolves.toHaveLength(600)
    } finally {
      store.close()
    }
  })

  it('thins it back to the store resolution once it is old, and nothing else', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      const from = now - 30 * DAY
      anchored(store, from)
      // Just as dense, but imported rather than recorded at anchor.
      const imported = Array.from({ length: 600 }, (_, i) => from - DAY + i * 1000)
      store.recordTrack(
        self,
        [imported.map((timestamp) => ({ position: [59, 23] as LatLngTuple, timestamp }))],
        now,
        false,
      )
      store.prune(Infinity, self, now)
      const points = await store.getTimed(self)
      // One a minute, give or take where the minutes fall.
      expect(points.filter(({ timestamp }) => timestamp >= from).length).toBeGreaterThanOrEqual(10)
      expect(points.filter(({ timestamp }) => timestamp >= from).length).toBeLessThanOrEqual(12)
      expect(points.filter(({ timestamp }) => timestamp < from)).toHaveLength(600)
    } finally {
      store.close()
    }
  })

  it('thins the old part of a stay at anchor that has not ended', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      // Every second until a span's join gap would split it, from long ago
      // up to now.
      // Each pair sits inside one minute, so thinning to a minute keeps one of it.
      for (let t = Math.floor((now - 2 * DAY) / MINUTE) * MINUTE + 10_000; t <= now; t += 5 * MINUTE) {
        store.newPosition(self, [60, 24], t, 1000)
        store.newPosition(self, [60, 24], t + 1000, 1000)
      }
      store.prune(Infinity, self, now)
      const points = await store.getTimed(self)
      // Detail is kept from the bucket edge at or before a day ago.
      const kept = Math.floor((now - DAY) / MINUTE) * MINUTE
      const old = points.filter(({ timestamp }) => timestamp < kept)
      const recent = points.filter(({ timestamp }) => timestamp >= kept)
      expect(old.every(({ timestamp }, i) => i === 0 || timestamp - old[i - 1]!.timestamp > 1000)).toBe(true)
      expect(recent.some(({ timestamp }, i) => i > 0 && timestamp - recent[i - 1]!.timestamp === 1000)).toBe(true)
    } finally {
      store.close()
    }
  })

  it('keeps a stay still going on at the spacing an anchor alarm reads it', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      // Three and a half days at anchor, up to now: a burst of five fixes a
      // second apart every five minutes, close enough together to stay one span.
      const first = Math.floor((now - 3.5 * DAY) / MINUTE) * MINUTE
      for (let t = first; t <= now - 5000; t += 5 * MINUTE) {
        for (let i = 0; i < 5; i++) {
          store.newPosition(self, [60, 24], t + i * 1000, 1000)
        }
      }
      store.prune(Infinity, self, now)
      const points = await store.getTimed(self)
      // The stay is read at one point every four seconds, so a burst older
      // than a day keeps two of its five, where the track resolution would
      // keep one.
      // Two days back falls on a burst start, so no burst is cut in half.
      const before = first + Math.floor((now - 2 * DAY - first) / (5 * MINUTE)) * 5 * MINUTE
      const expected: number[] = []
      for (let t = first; t < before; t += 5 * MINUTE) {
        expected.push(t, t + 4000)
      }
      expect(points.map(({ timestamp }) => timestamp).filter((timestamp) => timestamp < before)).toEqual(expected)
    } finally {
      store.close()
    }
  })

  it('thins the end of a stay that another stay followed', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      const from = now - 30 * DAY
      // The first stay ends 30 s after its span end was last saved.
      for (let i = 0; i <= 90; i++) {
        store.newPosition(self, [60, 24], from + i * 1000, 1000)
      }
      anchored(store, from + 30 * MINUTE)
      store.prune(Infinity, self, now)
      const first = (await store.getTimed(self)).filter(({ timestamp }) => timestamp < from + 30 * MINUTE)
      expect(first.length).toBeLessThanOrEqual(3)
    } finally {
      store.close()
    }
  })

  it('leaves an import written over a stay at anchor unthinned', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      const from = now - 30 * DAY
      anchored(store, from)
      // The middle of the stay replaced by an import, just as dense.
      const imported = Array.from({ length: 120 }, (_, i) => ({
        position: [61, 25 + i * 1e-6] as [number, number],
        timestamp: from + 4 * MINUTE + i * 1000,
      }))
      store.recordTrack(self, [imported], now, false)
      store.prune(Infinity, self, now)
      const points = await store.getTimed(self)
      expect(points.filter(({ position }) => position[0] === 61)).toHaveLength(120)
      const recorded = points.filter(({ position }) => position[0] !== 61)
      expect(recorded.length).toBeGreaterThan(0)
      expect(recorded.length).toBeLessThan(20)
    } finally {
      store.close()
    }
  })

  it('leaves an import that ends a stay at anchor unthinned when the stay goes on', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      const from = now - 30 * DAY
      anchored(store, from)
      // Replaces the end of the stay and reaches past the last live fix.
      const imported = Array.from({ length: 320 }, (_, i) => ({
        position: [61, 25 + i * 1e-6] as [number, number],
        timestamp: from + 5 * MINUTE + i * 1000,
      }))
      store.recordTrack(self, [imported], now, false)
      store.newPosition(self, [60, 24], from + 625_000, 1000)
      store.newPosition(self, [60, 24], from + 626_000, 1000)
      store.prune(Infinity, self, now)
      const points = await store.getTimed(self)
      expect(points.filter(({ position }) => position[0] === 61)).toHaveLength(320)
    } finally {
      store.close()
    }
  })

  it('leaves what a history import fills over a stay at anchor unthinned', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE }, debug)
    try {
      const now = Date.now()
      const from = now - 30 * DAY
      // One stay: ten minutes at anchor, six without a fix, ten more.
      anchored(store, from)
      anchored(store, from + 16 * MINUTE)
      const filled = Array.from({ length: 120 }, (_, i) => ({
        position: [61, 25 + i * 1e-6] as [number, number],
        timestamp: from + 12 * MINUTE + i * 1000,
      }))
      store.saveHistoryImport({ context: self, startedAt: now, filled: 120 }, [filled])
      store.prune(Infinity, self, now)
      const points = await store.getTimed(self)
      expect(points.filter(({ position }) => position[0] === 61)).toHaveLength(120)
    } finally {
      store.close()
    }
  })

  it('thins detail recorded before a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-detail-'))
    const file = join(dir, 'tracks.db')
    try {
      const now = Date.now()
      const first = new SqliteTrackStore({ file, resolution: MINUTE }, debug)
      anchored(first, now - 30 * DAY)
      first.close()
      const second = new SqliteTrackStore({ file, resolution: MINUTE }, debug)
      second.prune(Infinity, self, now)
      expect((await second.getTimed(self)).length).toBeLessThanOrEqual(12)
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('storage simplification', () => {
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const day0 = Date.UTC(2026, 5, 1)
  // day0 ended more than a day before: refined, and then simplified.
  const later = day0 + 3 * DAY
  const noise = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1
  /** An hour at one fix a second from `start`, a few metres either side of a slow curve. */
  const wander = (store: SqliteTrackStore, start: number): void => {
    for (let i = 0; i < 3600; i++) {
      const lat = 60 + Math.sin(i / 400) * 0.002 + noise(i) * 0.00002
      const lon = 24 + i * 0.000005 + noise(i + 1) * 0.00002
      store.newPosition(ctx, [lat, lon], start + i * 1000)
    }
  }
  /** An hour at one fix a second on a straight line from `start`. */
  const straight = (store: SqliteTrackStore, start: number, context: Context = ctx): void => {
    for (let i = 0; i < 3600; i++) {
      store.newPosition(context, [60 + i * 1e-5, 24], start + i * 1000)
    }
  }
  /**
   * refineLevels() until it has nothing left, returning its answers. Each call
   * in a transaction of its own, as the worker runs it: on a file, deleting
   * row by row in autocommit takes most of a minute on a Windows runner.
   */
  const settle = (store: SqliteTrackStore, now = later): boolean[] => {
    const answers: boolean[] = []
    for (let i = 0; i < 1000 && answers.at(-1) !== false; i++) {
      store.transaction(() => answers.push(store.refineLevels(now)))
    }
    return answers
  }
  const tolerant = (storageTolerance: number, refineBudget?: number) =>
    new SqliteTrackStore({ file: ':memory:', storageTolerance, ...(refineBudget ? { refineBudget } : {}) }, debug)
  const gaps = (points: TimedPosition[]) => points.slice(1).map((point, i) => point.timestamp - points[i]!.timestamp)

  it('deletes what simplifying to the tolerance leaves out, keeping one a minute', async () => {
    const store = tolerant(0.5)
    straight(store, day0)
    settle(store)
    const points = await store.getTimed(ctx)
    // The ends, and one a minute between them.
    expect(points).toHaveLength(61)
    expect(Math.max(...gaps(points))).toBeLessThanOrEqual(MINUTE)
    store.close()
  })

  // What it deletes no simplification from its tolerance up keeps, so the
  // tracks drawn from what is left are the same.
  it('leaves what simplifies, from its tolerance up, as every position did', async () => {
    const every = tolerant(0)
    const store = tolerant(0.5)
    for (const each of [every, store]) {
      wander(each, day0)
      settle(each)
    }
    const all = await every.getTimed(ctx)
    const left = await store.getTimed(ctx)
    expect(all).toHaveLength(3600)
    expect(left.length).toBeLessThan(all.length)
    for (const epsilon of [0.5, 1, 4, 20]) {
      expect(simplify(left, epsilon)).toEqual(simplify(all, epsilon))
    }
    every.close()
    store.close()
  })

  // Refined once it ended, a day keeps its detail for an anchor alarm until
  // it ended more than a day ago.
  it('leaves a refined day alone until it ended a day ago', async () => {
    const store = tolerant(0.5)
    straight(store, day0)
    store.newPosition(ctx, [61, 24], day0 + DAY + 2 * 60 * MINUTE)
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    settle(store, day0 + 2 * DAY - MINUTE)
    expect(store['db'].prepare('SELECT count(*) AS n FROM significant').get()).not.toEqual({ n: 0 })
    await expect(store.getTimed(ctx, window)).resolves.toHaveLength(3600)
    settle(store, day0 + 2 * DAY + MINUTE)
    await expect(store.getTimed(ctx, window)).resolves.toHaveLength(61)
    store.close()
  })

  // Between refining a day and simplifying it, a fix can send it back.
  it('simplifies a day a fix sent back after refining it as refined again', async () => {
    const store = tolerant(0.5)
    straight(store, day0)
    store.newPosition(ctx, [61, 24], day0 + DAY + 2 * 60 * MINUTE)
    const window: TimeWindow = { from: day0, to: day0 + DAY }
    settle(store, day0 + DAY + 3 * 60 * MINUTE)
    // Between two fixes half an hour in, about 20 m off the line.
    const late = day0 + 1_800_500
    store.newPosition(ctx, [60 + 1800.5e-5, 24.00036], late)
    settle(store, day0 + DAY + 3 * 60 * MINUTE + 1)
    const held = store['db'].prepare('SELECT count(*) AS n FROM significant WHERE timestamp = ?')
    expect(held.get(late)).toEqual({ n: 1 })
    const byLevel = await store.getTimed(ctx, window, undefined, 5)
    expect(byLevel.map(({ timestamp }) => timestamp)).toContain(late)
    expect(byLevel.length).toBeLessThan(10)
    await expect(store.getTimed(ctx, window)).resolves.toHaveLength(3601)
    settle(store)
    const left = await store.getTimed(ctx, window)
    expect(left.map(({ timestamp }) => timestamp)).toContain(late)
    expect(left.length).toBeLessThan(70)
    expect(Math.max(...gaps(left))).toBeLessThanOrEqual(MINUTE)
    store.close()
  })

  // Above the lowest level, a level holds positions simplifying to the
  // tolerance leaves out; reads at a tolerance draw them.
  it('never deletes a position a level holds', () => {
    const store = tolerant(8)
    wander(store, day0)
    settle(store)
    const db = store['db']
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    expect(count('SELECT count(*) AS n FROM significant WHERE level = 4')).toBeGreaterThan(0)
    expect(
      count(
        'SELECT count(*) AS n FROM significant s WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.rowid = s.position)',
      ),
    ).toBe(0)
    store.close()
  })

  /** Three hours at one fix a second from `start`, as `wander` draws them: more than one piece of refining. */
  const wandering = (start: number): TimedPosition[] =>
    Array.from({ length: 3 * 3600 }, (_, i) => ({
      position: [60 + Math.sin(i / 400) * 0.002 + noise(i) * 0.00002, 24 + i * 0.000005 + noise(i + 1) * 0.00002],
      timestamp: start + i * 1000,
    }))
  const rows = (store: SqliteTrackStore, context: Context = ctx) =>
    store['db']
      .prepare(
        'SELECT timestamp, lat_e7 / 10000000.0 AS lat, lon_e7 / 10000000.0 AS lon FROM positions WHERE context_id = (SELECT id FROM contexts WHERE context = ?) ORDER BY timestamp, rowid',
      )
      .all(context)
  const count = (store: SqliteTrackStore, from: number, to: number) =>
    (
      store['db']
        .prepare(
          'SELECT count(*) AS n FROM positions WHERE context_id = (SELECT id FROM contexts WHERE context = ?) AND timestamp >= ? AND timestamp < ?',
        )
        .get(ctx, from, to) as { n: number }
    ).n
  const recordedAndSettled = (...runs: TimedPosition[][]) => {
    const store = tolerant(0.5)
    for (const { position, timestamp } of runs.flat()) {
      store.newPosition(ctx, position, timestamp)
    }
    settle(store)
    return store
  }

  describe('an import into a day the recording has none of', () => {
    const writers: [string, (store: SqliteTrackStore, points: TimedPosition[]) => void][] = [
      ['fillTrack', (store, points) => store.fillTrack(ctx, [points])],
      ['recordTrack', (store, points) => store.recordTrack(ctx, [points], later, false)],
      [
        'saveHistoryImport',
        (store, points) => store.saveHistoryImport({ context: ctx, startedAt: later, filled: points.length }, [points]),
      ],
    ]
    it.each(writers)('is written by %s as simplifying the day leaves it, and left so', (_, write) => {
      const points = wandering(day0)
      const recorded = recordedAndSettled(points)
      const store = tolerant(0.5)
      write(store, points)
      const written = rows(store)
      expect(written).toEqual(rows(recorded))
      expect(written.length).toBeLessThan(points.length)
      // Simplifying it again would cut its pieces elsewhere and drop their ends.
      settle(store)
      expect(rows(store)).toEqual(written)
      recorded.close()
      store.close()
    })

    it('counts every position it filled, written or not', () => {
      const points = wandering(day0)
      const store = tolerant(0.5)
      expect(store.saveHistoryImport({ context: ctx, startedAt: later, filled: points.length }, [points])).toBe(
        points.length,
      )
      store.close()
    })

    it('is simplified again once the tolerance is raised', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-simplify-'))
      const file = join(dir, 'tracks.db')
      const settled = (storageTolerance: number) => {
        const store = new SqliteTrackStore({ file, storageTolerance }, debug)
        settle(store)
        const n = count(store, day0, day0 + DAY)
        store.close()
        return n
      }
      try {
        const first = new SqliteTrackStore({ file, storageTolerance: 0.5 }, debug)
        first.transaction(() => first.fillTrack(ctx, [wandering(day0)]))
        const atHalf = count(first, day0, day0 + DAY)
        first.close()
        expect(atHalf).toBeLessThan(3 * 3600)
        // Raised before the day was gone over, so it is still noted as written.
        expect(settled(2)).toBeLessThan(atHalf)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('is simplified again once a fix comes into the day', () => {
      const store = tolerant(0.5)
      store.fillTrack(ctx, [wandering(day0)])
      // Into a day not refined yet, which does not send it back.
      straight(store, day0 + 4 * 60 * MINUTE)
      settle(store)
      expect(count(store, day0 + 4 * 60 * MINUTE, day0 + 5 * 60 * MINUTE)).toBe(61)
      store.close()
    })

    // The restore's span reaches over the day, but none of its positions
    // lie in it.
    it('is left so by a change to the days either side of it', () => {
      const store = tolerant(0.5)
      straight(store, day0)
      straight(store, day0 + 2 * DAY)
      const { id } = store.binRecorded(ctx, day0, day0 + 3 * DAY, later, false)
      store.fillTrack(ctx, [wandering(day0 + DAY)])
      const written = count(store, day0 + DAY, day0 + 2 * DAY)
      store.restoreFromBin(id!)
      settle(store)
      expect(count(store, day0 + DAY, day0 + 2 * DAY)).toBe(written)
      store.close()
    })

    it('is written in full while the store keeps every position', () => {
      const points = wandering(day0)
      const store = tolerant(0)
      store.fillTrack(ctx, [points])
      expect(rows(store)).toHaveLength(points.length)
      store.close()
    })
  })

  it('writes a day a sliced upload spreads over several slices as simplified, and leaves it so', () => {
    const points = wandering(day0)
    const store = tolerant(0.5)
    const cuts = [0, 3000, 7000, points.length]
    saveSlices(
      store,
      uploading(),
      cuts.slice(1).map((end, i) => [[1, points.slice(cuts[i], end)]]),
    )
    const written = rows(store)
    const whole = tolerant(0.5)
    whole.fillTrack(ctx, [points])
    // Each slice keeps the ends it was cut at, and nothing else beyond what one write keeps.
    expect(written.length).toBeLessThanOrEqual(rows(whole).length + 2 * (cuts.length - 2))
    whole.close()
    // Simplifying it again would cut its pieces elsewhere and drop their ends.
    settle(store)
    expect(rows(store)).toEqual(written)
    store.close()
  })

  it('writes an import in full into a day the recording has positions of', () => {
    const store = tolerant(0.5)
    straight(store, day0)
    const points = wandering(day0 + 2 * 60 * MINUTE)
    store.fillTrack(ctx, [points])
    expect(rows(store)).toHaveLength(3600 + points.length)
    store.close()
  })

  it('writes an import in full into a day that ended less than a day ago', () => {
    const store = tolerant(0.5)
    const points = wandering(Date.now() - 4 * 60 * MINUTE)
    store.fillTrack(ctx, [points])
    expect(rows(store)).toHaveLength(points.length)
    store.close()
  })

  it('writes two runs of an import into one day as simplifying the day leaves them', () => {
    const first = wandering(day0)
    const second = wandering(day0 + 6 * 60 * MINUTE)
    const recorded = recordedAndSettled(first, second)
    const store = tolerant(0.5)
    store.fillTrack(ctx, [first, second])
    const written = rows(store)
    expect(written).toEqual(rows(recorded))
    settle(store)
    expect(rows(store)).toEqual(written)
    recorded.close()
    store.close()
  })

  it('writes an import in full into a day an earlier import wrote', () => {
    const store = tolerant(0.5)
    store.fillTrack(ctx, [wandering(day0)])
    const before = rows(store).length
    const second = wandering(day0 + 6 * 60 * MINUTE)
    store.fillTrack(ctx, [second])
    expect(rows(store)).toHaveLength(before + second.length)
    store.close()
  })

  it('simplifies a day again once a change brings positions into it', async () => {
    const store = tolerant(0.5)
    straight(store, day0)
    settle(store)
    // A second hour into the simplified day, as an import would bring it.
    straight(store, day0 + 2 * 60 * MINUTE)
    await expect(store.getTimed(ctx)).resolves.toHaveLength(61 + 3600)
    settle(store)
    await expect(store.getTimed(ctx)).resolves.toHaveLength(2 * 61)
    store.close()
  })

  // An import into a day a vessel had none of moves its frontier on with no
  // other day finishing.
  it("simplifies a vessel's day refined after every other one was done", async () => {
    const store = tolerant(0.5)
    straight(store, day0)
    settle(store)
    const hour = Array.from({ length: 3600 }, (_, i) => ({
      position: [61 + i * 1e-5, 25] as LatLngTuple,
      timestamp: day0 + i * 1000,
    }))
    store.recordTrack(other, [hour], later, false)
    settle(store)
    await expect(store.getTimed(other)).resolves.toHaveLength(61)
    store.close()
  })

  it('goes over every day again when the tolerance is raised, and brings nothing back when it is lowered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-simplify-'))
    const file = join(dir, 'tracks.db')
    const left = async (storageTolerance: number) => {
      const store = new SqliteTrackStore({ file, storageTolerance }, debug)
      settle(store)
      const { length } = await store.getTimed(ctx)
      store.close()
      return length
    }
    try {
      const first = new SqliteTrackStore({ file, storageTolerance: 0.5 }, debug)
      first.transaction(() => wander(first, day0))
      first.close()
      const atHalf = await left(0.5)
      expect(atHalf).toBeLessThan(3600)
      expect(await left(0.25)).toBe(atHalf)
      expect(await left(2)).toBeLessThan(atHalf)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says it has work left until every refined day is simplified', async () => {
    const store = tolerant(0.5, 1000)
    for (let d = 0; d < 3; d++) {
      straight(store, day0 + d * DAY)
    }
    const answers = settle(store, day0 + 5 * DAY)
    expect(answers.length).toBeGreaterThan(3)
    expect(answers.slice(0, -1).every(Boolean)).toBe(true)
    expect(answers.at(-1)).toBe(false)
    await expect(store.getTimed(ctx)).resolves.toHaveLength(3 * 61)
    expect(store.refineLevels(day0 + 5 * DAY)).toBe(false)
    store.close()
  })

  // Thinned by time, an hour at anchor is one fix a minute; simplified, it
  // keeps the swing around the anchor.
  it('keeps the swing of old detail at anchor, which thinning by time would not', async () => {
    const self = 'vessels.self' as Context
    const swing = (store: SqliteTrackStore, from: number) => {
      // Twenty metres around the anchor, once a minute round.
      for (let i = 0; i < 600; i++) {
        const angle = (i / 60) * 2 * Math.PI
        store.newPosition(self, [60 + Math.sin(angle) * 0.00018, 24 + Math.cos(angle) * 0.00036], from + i * 1000, 1000)
      }
    }
    const now = Date.now()
    const kept = async (storageTolerance: number) => {
      const store = new SqliteTrackStore({ file: ':memory:', resolution: MINUTE, storageTolerance }, debug)
      swing(store, now - 30 * DAY)
      store.prune(Infinity, self, now)
      settle(store, now)
      const { length } = await store.getTimed(self)
      store.close()
      return length
    }
    expect(await kept(0)).toBeLessThanOrEqual(12)
    const simplified = await kept(0.5)
    expect(simplified).toBeGreaterThan(100)
    expect(simplified).toBeLessThan(600)
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

// A track too large to answer is told by counting it first, so the count has
// to be what the read returns: at a tolerance, a refined day holds only the
// positions its levels keep, and every other day all of them.
describe('countTimed', () => {
  /** The query a read without a box makes: what is given of window, tolerance and resolution. */
  const query = (window: TimeWindow | undefined, tolerance?: number, resolution?: number): TrackQuery => ({
    ...(window ? { window } : {}),
    ...(tolerance === undefined ? {} : { tolerance }),
    ...(resolution === undefined ? {} : { resolution }),
  })
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const day0 = Date.UTC(2026, 5, 1)
  const noise = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1
  const seedHour = (store: SqliteTrackStore, start: number, context: Context = ctx): void => {
    for (let i = 0; i < 3600; i++) {
      store.newPosition(
        context,
        [60 + Math.sin(i / 400) * 0.002 + noise(i) * 0.00002, 24 + i * 0.000005 + noise(i + 1) * 0.00002],
        start + i * 1000,
      )
    }
  }
  /** Two refined days, one sent back to be refined again, and a day not refined yet. */
  const seeded = () => {
    const store = newStore()
    for (const day of [0, 1, 2]) {
      seedHour(store, day0 + day * DAY + 9 * 60 * MINUTE)
    }
    while (store.refineLevels(day0 + 4 * DAY)) {
      // until every finished day is refined
    }
    seedHour(store, day0 + 3 * DAY + 9 * 60 * MINUTE)
    store['invalidateLevels'](ctx, day0 + DAY, day0 + 2 * DAY - 1)
    return store
  }

  it('counts what a read at each tolerance returns, window edges included', async () => {
    const store = seeded()
    const windows: (TimeWindow | undefined)[] = [
      undefined,
      // Starting and ending inside refined days, where the read adds the
      // window's first and last position to what the levels keep.
      { from: day0 + 9 * 60 * MINUTE + 1234_000, to: day0 + 2 * DAY + 9 * 60 * MINUTE + 777_000 },
      { from: day0 + 9 * 60 * MINUTE + 1234_000, to: day0 + 2 * DAY + 9 * 60 * MINUTE + 777_000, inclusiveEnd: true },
      { from: day0 + 3 * DAY, to: day0 + 4 * DAY },
    ]
    for (const window of windows) {
      for (const tolerance of [undefined, 4, 5, 20, 100]) {
        const read = await store.getTimed(ctx, window, undefined, tolerance)
        expect(store.countTimed([ctx], query(window, tolerance), 1_000_000)).toEqual({ [ctx]: read.length })
      }
    }
    // The levels leave most of a refined day out, and none of the others.
    const refinedDay = { from: day0, to: day0 + DAY }
    expect(store.countTimed([ctx], query(refinedDay, 20), 1_000_000)[ctx]).toBeLessThan(100)
    expect(store.countTimed([ctx], query({ from: day0 + DAY, to: day0 + 2 * DAY }, 20), 1_000_000)).toEqual({
      [ctx]: 3600,
    })
    expect(store.countTimed([ctx], query({ from: day0 + 3 * DAY, to: day0 + 4 * DAY }, 20), 1_000_000)).toEqual({
      [ctx]: 3600,
    })
    store.close()
  })

  it('counts what a read thinned to a resolution returns', async () => {
    const store = seeded()
    // Two trips on a day as well: a spacing measured across the hours
    // between them would count positions the read never keeps.
    for (let i = 0; i < 1800; i++) {
      store.newPosition(ctx, [61 + i * 0.00001, 24], day0 + 3 * DAY + 19 * 60 * MINUTE + i * 1000)
    }
    for (const window of [
      undefined,
      { from: day0 + 9 * 60 * MINUTE + 1234_000, to: day0 + 3 * DAY + 10 * 60 * MINUTE },
      { from: day0 + 9 * 60 * MINUTE + 1234_000, to: day0 + 9 * 60 * MINUTE + 1236_000 },
    ]) {
      for (const tolerance of [undefined, 20]) {
        for (const resolution of [1000, 60_000, 600_000, DAY]) {
          const read = await store.getTimed(ctx, window, resolution, tolerance)
          expect(store.countTimed([ctx], query(window, tolerance, resolution), 1_000_000)).toEqual({
            [ctx]: read.length,
          })
        }
      }
    }
    expect(store.countTimed([ctx], { resolution: 60_000 }, 10)).toEqual({ [ctx]: 10 })
    store.close()
  })

  it('stops counting at the limit', async () => {
    const store = seeded()

    expect(store.countTimed([ctx], {}, 100)).toEqual({ [ctx]: 100 })
    expect(store.countTimed([ctx], { tolerance: 20 }, 100)).toEqual({ [ctx]: 100 })
    // Inside a refined day, the window's own ends come on top of what the
    // levels keep, and still stop at the limit.
    const inside = { from: day0 + 9 * 60 * MINUTE + 1234_000, to: day0 + 9 * 60 * MINUTE + 2500_000 }
    const all = store.countTimed([ctx], { window: inside, tolerance: 20 }, 1_000_000)[ctx]!
    expect(all).toBe((await store.getTimed(ctx, inside, undefined, 20)).length)
    expect(store.countTimed([ctx], { window: inside, tolerance: 20 }, all - 1)).toEqual({ [ctx]: all - 1 })
    store.close()
  })

  it('counts every context the store holds, or those of the ones asked for it holds', () => {
    const store = newStore()
    store.newPosition(ctx, [60, 24], 1000)
    store.newPosition(ctx, [60.1, 24], 2000)
    store.newPosition(other, [61, 25], 1000)

    expect(store.countTimed(undefined, {}, 10)).toEqual({ [ctx]: 2, [other]: 1 })
    expect(store.countTimed([other, 'vessels.unknown' as Context], {}, 10)).toEqual({ [other]: 1 })
    expect(store.countTimed([ctx], { window: { from: 1500, to: 3000 } }, 10)).toEqual({ [ctx]: 1 })
    store.close()
  })
})

describe('timeExtent', () => {
  it('gives the first and last time in a window, read as getTimed() reads it', async () => {
    const store = newStore()
    for (const t of [1000, 2000, 3000]) store.newPosition(ctx, [60, 24], t)

    await expect(store.timeExtent(ctx)).resolves.toEqual({ first: 1000, last: 3000 })
    await expect(store.timeExtent(ctx, { from: 1500, to: 3000 })).resolves.toEqual({ first: 2000, last: 2000 })
    await expect(store.timeExtent(ctx, { from: 1500, to: 3000, inclusiveEnd: true })).resolves.toEqual({
      first: 2000,
      last: 3000,
    })
    await expect(store.timeExtent(ctx, { from: 4000, to: 5000 })).resolves.toBeUndefined()
    store.close()
  })

  // What a route answers with 404, and only that: any other rejection is a
  // read that failed.
  it('rejects a context the store does not know, as getTimed() does, with UnknownContextError', async () => {
    const store = newStore()
    store.newPosition(ctx, [60, 24], 1000)

    await expect(store.timeExtent(other)).rejects.toBeInstanceOf(UnknownContextError)
    await expect(store.getTimed(other)).rejects.toBeInstanceOf(UnknownContextError)
    await expect(store.getTimed(ctx, { from: 4000, to: 5000 })).resolves.toEqual([])
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

// The glitch filter measures a fix from the one before it, and has none for
// the first fix after a restart. That fix can come from a clock not yet set:
// dated back into the stored track at a position the vessel reached later.
describe('fixes dated inside the stored track', () => {
  const minute = 60_000
  const t0 = 1_000_000
  // A minute apart, a few metres each: a boat leaving an anchorage.
  const leaving: [LatLngTuple, number][] = [
    [[60, 24], t0],
    [[60, 24.0005], t0 + minute],
    [[60, 24.001], t0 + 2 * minute],
  ]
  // About 7 km east.
  const later: LatLngTuple = [60, 24.13]

  const withTrack = (run: (file: string) => Promise<void>) => async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-dated-'))
    const file = join(dir, 'tracks.db')
    try {
      const first = new SqliteTrackStore({ file }, debug)
      for (const [position, timestamp] of leaving) first.newPosition(ctx, position, timestamp)
      first.close()
      await run(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it(
    'drops the first fix after a reopen dated into the stored track far from it, until the clock is set',
    withTrack(async (file) => {
      const store = new SqliteTrackStore({ file, maxSpeedKnots: 100 }, debug)
      try {
        store.newPosition(ctx, later, t0 + 90_000)
        store.newPosition(ctx, later, t0 + 91_000)
        await expect(store.get(ctx)).resolves.toEqual(leaving.map(([position]) => position))

        store.newPosition(ctx, later, t0 + 47 * minute)
        await expect(store.get(ctx)).resolves.toEqual([...leaving.map(([position]) => position), later])
      } finally {
        store.close()
      }
    }),
  )

  it(
    'measures from the stored position before the fix, and to the one after it',
    withTrack(async (file) => {
      const store = new SqliteTrackStore({ file, maxSpeedKnots: 100 }, debug)
      try {
        // A passage after a gap of five hours. Each fix below agrees with the
        // stored position on one side of it and is ruled out by the other.
        store.newPosition(ctx, later, t0 + 5 * 60 * minute)
        store.newPosition(ctx, later, t0 + 2 * minute + 30_000)
        store.newPosition(ctx, [60, 24.001], t0 + 5 * 60 * minute - 30_000)
        await expect(store.get(ctx)).resolves.toEqual([...leaving.map(([position]) => position), later])
      } finally {
        store.close()
      }
    }),
  )

  it(
    'keeps a fix dated into the stored track that agrees with the positions either side',
    withTrack(async (file) => {
      const store = new SqliteTrackStore({ file, maxSpeedKnots: 100 }, debug)
      try {
        store.newPosition(ctx, [60, 24.00025], t0 + 30_000)
        await expect(store.getTimed(ctx)).resolves.toHaveLength(4)
      } finally {
        store.close()
      }
    }),
  )

  it(
    'goes on checking after the first fix of a restart is stored',
    withTrack(async (file) => {
      const store = new SqliteTrackStore({ file, maxSpeedKnots: 100 }, debug)
      try {
        store.newPosition(ctx, [60, 24.00025], t0 + 30_000)
        store.newPosition(ctx, later, t0 + 90_000)
        await expect(store.getTimed(ctx)).resolves.toHaveLength(4)
        await expect(store.get(ctx)).resolves.not.toContainEqual(later)
      } finally {
        store.close()
      }
    }),
  )

  it(
    'measures a fix at the time of a stored position as a second away from it',
    withTrack(async (file) => {
      const store = new SqliteTrackStore({ file, maxSpeedKnots: 100 }, debug)
      try {
        store.newPosition(ctx, later, t0 + 2 * minute)
        // Ten metres from the stored one: a second receiver.
        store.newPosition(ctx, [60, 24.00118], t0 + 2 * minute)
        await expect(store.get(ctx)).resolves.toEqual([...leaving.map(([position]) => position), [60, 24.00118]])
      } finally {
        store.close()
      }
    }),
  )

  it(
    'leaves a fix dated after the stored track to the glitch filter',
    withTrack(async (file) => {
      const store = new SqliteTrackStore({ file, maxSpeedKnots: 100 }, debug)
      try {
        store.newPosition(ctx, later, t0 + 2 * minute + 1000)
        await expect(store.getTimed(ctx)).resolves.toHaveLength(4)
      } finally {
        store.close()
      }
    }),
  )

  it(
    'checks nothing with no ceiling',
    withTrack(async (file) => {
      const store = new SqliteTrackStore({ file }, debug)
      try {
        store.newPosition(ctx, later, t0 + 90_000)
        await expect(store.getTimed(ctx)).resolves.toHaveLength(4)
      } finally {
        store.close()
      }
    }),
  )

  it('drops a fix dated back past one stored in the same run', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', maxSpeedKnots: 100 }, debug)
    try {
      for (const [position, timestamp] of leaving) store.newPosition(ctx, position, timestamp)
      store.newPosition(ctx, later, t0 + 90_000)
      await expect(store.get(ctx)).resolves.toEqual(leaving.map(([position]) => position))
    } finally {
      store.close()
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

// A neighbour in a marina or a vessel at a fixed berth never goes quiet, so
// a rule that drops only quiet vessels would keep its track growing forever.
describe('other vessels age out position by position', () => {
  const self = 'vessels.self' as Context
  const neighbour = 'vessels.neighbour' as Context
  const DAY = 24 * 60 * 60 * 1000

  it('trims a vessel still in range and keeps its recent positions', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: 0 }, debug)
    try {
      const now = Date.now()
      store.newPosition(neighbour, [60, 24], now - 40 * DAY)
      store.newPosition(neighbour, [60.1, 24.1], now - DAY)
      store.newPosition(self, [61, 25], now - 40 * DAY)
      store.prune(30 * DAY, self, now)
      await expect(store.get(neighbour)).resolves.toEqual([[60.1, 24.1]])
      await expect(store.get(self)).resolves.toEqual([[61, 25]])
    } finally {
      store.close()
    }
  })

  it('drops a vessel with no position left, and its name', async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: 0 }, debug)
    try {
      const now = Date.now()
      store.newPosition(neighbour, [60, 24], now - 40 * DAY)
      store.recordName(neighbour, 'Ariadne', now - 40 * DAY)
      store.prune(30 * DAY, self, now)
      await expect(store.getTimed(neighbour)).rejects.toThrow()
      expect(store.nameFor(neighbour)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  // Gone on there, the pass would skip the vessels between its old id and a new one it comes back under.
  it('goes over every vessel again after the one a pass was to go on at was forgotten', () => {
    const store = new SqliteTrackStore({ file: ':memory:', refineBudget: 500 }, debug)
    const first = 'vessels.a' as Context
    const gone = 'vessels.b' as Context
    const last = 'vessels.c' as Context
    const hour = (context: Context, start: number) => {
      for (let i = 0; i < 3600; i++) {
        store.newPosition(context, [60 + Math.sin(i / 400) * 0.002, 24 + i * 0.000005], start + i * 1000)
      }
    }
    const refined = (context: Context) =>
      (
        store['db']
          .prepare(
            'SELECT count(*) AS n FROM significant WHERE context_id = (SELECT id FROM contexts WHERE context = ?)',
          )
          .get(context) as { n: number }
      ).n
    try {
      const day0 = Date.UTC(2026, 5, 1)
      const now = day0 + 2 * DAY + 1
      hour(first, day0)
      hour(gone, day0 - 10 * DAY)
      hour(last, day0)
      // The pass refines the first and, on the next call, stops at the one going.
      store.refineLevels(now)
      store.refineLevels(now)
      expect(store['refineResume']).toBe(gone)
      store.prune(5 * DAY, undefined, now)
      store.newPosition(gone, [60, 24], now)
      for (let i = 0; i < 100 && store.refineLevels(now); i++) {
        // until it has nothing left
      }
      expect(refined(last)).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  // Or the table of contexts would keep every vessel that ever passed.
  it("forgets a vessel's id once nothing holds a row of it, and never gives it out again", async () => {
    const store = new SqliteTrackStore({ file: ':memory:', resolution: 0 }, debug)
    const passing = 'vessels.passing' as Context
    const ids = () => store['db'].prepare('SELECT id, context FROM contexts ORDER BY id').all()
    try {
      const now = Date.now()
      store.newPosition(neighbour, [60, 24], now - 40 * DAY)
      store.newPosition(passing, [60, 24], now - 40 * DAY)
      store.newPosition(passing, [60.1, 24], now - 39 * DAY)
      store.newPosition(self, [61, 25], now - 40 * DAY)
      // Its positions in the recycle bin, the passing vessel keeps its id.
      store.binRecorded(passing, undefined, now, now, false)
      expect(ids()).toEqual([
        { id: 1, context: neighbour },
        { id: 2, context: passing },
        { id: 3, context: self },
      ])
      store.prune(30 * DAY, self, now)
      expect(ids()).toEqual([
        { id: 2, context: passing },
        { id: 3, context: self },
      ])
      store.newPosition(neighbour, [60.2, 24.2], now)
      expect(ids()).toEqual([
        { id: 2, context: passing },
        { id: 3, context: self },
        { id: 4, context: neighbour },
      ])
      await expect(store.get(neighbour)).resolves.toEqual([[60.2, 24.2]])
    } finally {
      store.close()
    }
  })
})

// The store's `retention` trims the kept context's own rows. The plugin no
// longer sets it — the own vessel's track is never aged out — but the store
// option remains, and it must not reach into another vessel's rows.
describe('retention scope', () => {
  it('trims only the kept context, not every vessel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-ret-'))
    const store = new SqliteTrackStore({ file: join(dir, 'tracks.db'), resolution: 0, retention: 10_000 }, debug)
    try {
      const self = 'vessels.self' as Context
      const ais = 'vessels.ais' as Context
      const old = Date.now() - 60_000
      store.newPosition(self, [60, 24], old)
      store.newPosition(self, [60.1, 24.1], Date.now())
      store.newPosition(ais, [61, 25], old)
      store.newPosition(ais, [61.1, 25.1], Date.now())

      // Infinity: nothing is idle enough to drop, so only the retention runs.
      store.prune(Infinity, self)

      await expect(store.getTimed(self)).resolves.toHaveLength(1)
      await expect(store.getTimed(ais)).resolves.toHaveLength(2)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps every context when asked to age nothing out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-inf-'))
    const store = new SqliteTrackStore({ file: join(dir, 'tracks.db'), resolution: 0, retention: 0 }, debug)
    try {
      const ais = 'vessels.ais' as Context
      store.newPosition(ais, [61, 25], Date.now() - 999_999_999)

      store.prune(Infinity, 'vessels.self' as Context)

      await expect(store.getTimed(ais)).resolves.toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The write-throttle map is keyed by context and nothing else clears it, so a
// pruned vessel would leave an entry behind for the life of the process.
describe('prune and the write throttle', () => {
  it('forgets a pruned context, so a later fix is stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-prune-'))
    const store = new SqliteTrackStore({ file: join(dir, 'tracks.db'), resolution: 60_000 }, debug)
    try {
      const ctx = 'vessels.gone' as Context
      store.newPosition(ctx, [60, 24], 1000)
      store.prune(1, 'vessels.self' as Context)

      // Same context, a timestamp inside the throttle window of the pruned one.
      // If prune left the map entry behind, this write is throttled away and
      // the vessel silently never reappears.
      store.newPosition(ctx, [61, 25], 2000)

      await expect(store.getTimed(ctx)).resolves.toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('remembered names', () => {
  it('survives a restart', () => {
    // The whole point: the server's data model is empty after a restart, so a
    // track recorded for months would show a bare MMSI until the vessel next
    // transmits -- and never again for one that has left. Needs a real file;
    // an in-memory database cannot outlive its own close.
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-name-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file }, debug)
      first.recordName(ctx, 'Ariadne')
      first.close()

      const reopened = new SqliteTrackStore({ file }, debug)
      expect(reopened.nameFor(ctx)).toBe('Ariadne')
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets a later report replace an earlier one', () => {
    const store = newStore()

    store.recordName(ctx, 'Old Name', 1000)
    store.recordName(ctx, 'New Name', 2000)

    expect(store.nameFor(ctx)).toBe('New Name')
    store.close()
  })

  it('ignores an older observation arriving late', () => {
    // Deltas can be replayed or delayed; a stale one must not undo a
    // correction.
    const store = newStore()

    store.recordName(ctx, 'Current', 2000)
    store.recordName(ctx, 'Stale', 1000)

    expect(store.nameFor(ctx)).toBe('Current')
    store.close()
  })

  it('commits nothing when a vessel repeats its stored name', () => {
    // The name arrives with every position, and each commit is an fsync.
    // data_version on a second connection changes whenever another connection
    // commits, so it sees exactly what reached the database.
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-name-'))
    const file = join(dir, 'tracks.db')
    const store = new SqliteTrackStore({ file }, debug)
    const observer = new DatabaseSync(file)
    const dataVersion = (): unknown => observer.prepare('PRAGMA data_version').get()?.data_version
    try {
      store.recordName(ctx, 'Ariadne', 1000)
      const before = dataVersion()

      for (let t = 2000; t <= 60_000; t += 1000) {
        store.recordName(ctx, 'Ariadne', t)
      }
      expect(dataVersion()).toBe(before)

      // A change still commits, which also shows the observer can see one.
      store.recordName(ctx, 'Ariadne II', 61_000)
      expect(dataVersion()).not.toBe(before)
    } finally {
      observer.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dates a repeated name by its newest report', () => {
    // A repeat is not written, but it still outranks an older observation of
    // a different name arriving late.
    const store = newStore()

    store.recordName(ctx, 'Current', 1000)
    store.recordName(ctx, 'Current', 3000)
    store.recordName(ctx, 'Stale', 2000)

    expect(store.nameFor(ctx)).toBe('Current')
    store.close()
  })

  it('keeps that newest date across a restart', () => {
    // The plugin closes and reopens the store on every settings save.
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-name-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file }, debug)
      first.recordName(ctx, 'Current', 1000)
      first.recordName(ctx, 'Current', 3000)
      first.close()

      const reopened = new SqliteTrackStore({ file }, debug)
      reopened.recordName(ctx, 'Stale', 2000)
      expect(reopened.nameFor(ctx)).toBe('Current')
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forgets the name of a vessel that ages out', () => {
    // Otherwise this table grows for every target a harbour puts past the
    // receiver, long after the positions themselves are gone.
    const store = newStore()

    store.newPosition(other, [60, 24], Date.now() - 10 * 24 * 60 * 60 * 1000)
    store.recordName(other, 'Departed')
    expect(store.nameFor(other)).toBe('Departed')

    store.prune(24 * 60 * 60 * 1000, ctx)

    expect(store.nameFor(other)).toBeUndefined()
    store.close()
  })

  it('stores the name again for a vessel that returns after aging out', () => {
    const store = newStore()

    store.newPosition(other, [60, 24], Date.now() - 10 * 24 * 60 * 60 * 1000)
    store.recordName(other, 'Returning')
    store.prune(24 * 60 * 60 * 1000, ctx)
    store.recordName(other, 'Returning')

    expect(store.nameFor(other)).toBe('Returning')
    store.close()
  })

  it('keeps nothing for a blank name', () => {
    const store = newStore()

    store.recordName(ctx, '   ')

    expect(store.nameFor(ctx)).toBeUndefined()
    store.close()
  })
})

describe('the connection', () => {
  it('syncs at checkpoints rather than on every commit', () => {
    // A per-connection setting that node:sqlite opens at FULL, so this reads
    // the store's own connection rather than opening another.
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-sync-'))
    const store = new SqliteTrackStore({ file: join(dir, 'tracks.db') }, debug)
    try {
      // 1 is NORMAL; FULL would be 2.
      expect(store['db'].prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 })
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the position index', () => {
  const t0 = Date.parse('2026-06-01T00:00:00Z')
  const plan = (store: SqliteTrackStore, sql: string, ...args: (string | number)[]) =>
    (store['db'].prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
      .map(({ detail }) => detail)
      .join(' | ')

  it('answers a track read and a listing from the index alone', () => {
    const store = newStore()
    store.newPosition(ctx, [60.1, 24.9], t0)

    expect(
      plan(
        store,
        'SELECT timestamp, lat_e7 / 10000000.0 AS lat, lon_e7 / 10000000.0 AS lon FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp',
        1,
        t0,
        t0 + 1,
      ),
    ).toContain('COVERING INDEX idx_context_time_position')
    expect(
      plan(
        store,
        'SELECT context_id, COUNT(*), MIN(lat_e7), MAX(lon_e7) FROM positions WHERE timestamp >= ? GROUP BY context_id',
        t0,
      ),
    ).toContain('COVERING INDEX idx_context_time_position')
    store.close()
  })

  // How a database before contexts had ids named each position's context.
  const OLD_POSITIONS =
    'CREATE TABLE positions (context TEXT NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, s2cell INTEGER NOT NULL);'
  const indexesOf = (store: SqliteTrackStore) =>
    (
      store['db']
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'positions' ORDER BY name")
        .all() as { name: string }[]
    ).map(({ name }) => name)

  it.each([
    ['the narrower index', 'CREATE INDEX idx_context_timestamp ON positions(context, timestamp);'],
    ['no index by vessel and time', ''],
  ])('rewrites a database an older version wrote with %s', async (_, index) => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(`
        PRAGMA journal_mode = WAL;
        ${OLD_POSITIONS}
        CREATE INDEX idx_s2cell ON positions(s2cell);
        ${index}
      `)
      const insert = older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)')
      older.exec('BEGIN')
      for (let i = 0; i < 5000; i++) {
        insert.run(ctx, t0 + i * 1000, 60.1, 24.9)
      }
      older.exec('COMMIT')
      older.close()

      const store = new SqliteTrackStore({ file }, debug)
      const db = store['db']
      expect(indexesOf(store)).toEqual(['idx_context_s2cell', 'idx_context_time_position', 'idx_s2cell'])
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      expect(db.prepare('SELECT context FROM contexts').all()).toEqual([{ context: ctx }])
      // A new file, built whole: nothing left over, and nothing beside it.
      expect(db.prepare('PRAGMA freelist_count').get()).toEqual({ freelist_count: 0 })
      expect(existsSync(`${file}.migrating`)).toBe(false)
      const track = await store.getTimed(ctx)
      expect(track).toHaveLength(5000)
      expect(track[0]).toEqual({ position: [60.1, 24.9], timestamp: t0 })
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Rewrite a store's file as a version before contexts had ids wrote it. */
  const asOlder = (file: string): void => {
    const db = new DatabaseSync(file)
    db.exec(`
      BEGIN;
      CREATE TABLE named_positions (context TEXT NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, s2cell INTEGER NOT NULL);
      INSERT INTO named_positions (rowid, context, timestamp, lat, lon, s2cell)
        SELECT p.rowid, c.context, p.timestamp, p.lat_e7 / 10000000.0, p.lon_e7 / 10000000.0, p.s2cell FROM positions p JOIN contexts c ON c.id = p.context_id;
      DROP TABLE positions;
      ALTER TABLE named_positions RENAME TO positions;
      CREATE INDEX idx_s2cell ON positions(s2cell);
      CREATE INDEX idx_context_time_position ON positions(context, timestamp, lat, lon);
      CREATE INDEX idx_context_s2cell ON positions(context, s2cell);
      CREATE TABLE named_significant (position INTEGER NOT NULL, context TEXT NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, level INTEGER NOT NULL);
      INSERT INTO named_significant SELECT s.position, c.context, s.timestamp, s.lat_e7 / 10000000.0, s.lon_e7 / 10000000.0, s.level FROM significant s JOIN contexts c ON c.id = s.context_id;
      DROP TABLE significant;
      ALTER TABLE named_significant RENAME TO significant;
      CREATE INDEX idx_significant_time ON significant(context, level, timestamp);
      CREATE TABLE named_visits (context TEXT NOT NULL, lat_cell INTEGER NOT NULL, lon_cell INTEGER NOT NULL, hour INTEGER NOT NULL, PRIMARY KEY (context, lat_cell, lon_cell, hour)) WITHOUT ROWID;
      INSERT INTO named_visits SELECT c.context, v.lat_cell, v.lon_cell, v.hour FROM level_visits v JOIN contexts c ON c.id = v.context_id;
      DROP TABLE level_visits;
      ALTER TABLE named_visits RENAME TO level_visits;
      CREATE INDEX idx_level_visits_hour ON level_visits(context, hour);
      CREATE TABLE named_binned (bin_id INTEGER NOT NULL, context TEXT NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, s2cell INTEGER NOT NULL);
      INSERT INTO named_binned SELECT b.bin_id, c.context, b.timestamp, b.lat_e7 / 10000000.0, b.lon_e7 / 10000000.0, b.s2cell FROM binned_positions b JOIN contexts c ON c.id = b.context_id;
      DROP TABLE binned_positions;
      ALTER TABLE named_binned RENAME TO binned_positions;
      CREATE INDEX idx_binned_positions ON binned_positions(bin_id);
      DROP TABLE contexts;
      PRAGMA user_version = 0;
      COMMIT;
      VACUUM;
    `)
    db.close()
  }

  /** Rewrite a store's file as a version before coordinates were integers wrote it. */
  const asReal = (file: string): void => {
    const db = new DatabaseSync(file)
    db.exec(`
      BEGIN;
      CREATE TABLE real_positions (context_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, s2cell INTEGER NOT NULL);
      INSERT INTO real_positions (rowid, context_id, timestamp, lat, lon, s2cell)
        SELECT rowid, context_id, timestamp, lat_e7 / 10000000.0, lon_e7 / 10000000.0, s2cell FROM positions;
      DROP TABLE positions;
      ALTER TABLE real_positions RENAME TO positions;
      CREATE INDEX idx_s2cell ON positions(s2cell);
      CREATE INDEX idx_context_time_position ON positions(context_id, timestamp, lat, lon);
      CREATE INDEX idx_context_s2cell ON positions(context_id, s2cell);
      CREATE TABLE real_significant (position INTEGER NOT NULL, context_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, level INTEGER NOT NULL);
      INSERT INTO real_significant SELECT position, context_id, timestamp, lat_e7 / 10000000.0, lon_e7 / 10000000.0, level FROM significant;
      DROP TABLE significant;
      ALTER TABLE real_significant RENAME TO significant;
      CREATE INDEX idx_significant_time ON significant(context_id, level, timestamp);
      CREATE TABLE real_binned (bin_id INTEGER NOT NULL, context_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, s2cell INTEGER NOT NULL);
      INSERT INTO real_binned SELECT bin_id, context_id, timestamp, lat_e7 / 10000000.0, lon_e7 / 10000000.0, s2cell FROM binned_positions;
      DROP TABLE binned_positions;
      ALTER TABLE real_binned RENAME TO binned_positions;
      CREATE INDEX idx_binned_positions ON binned_positions(bin_id);
      CREATE INDEX idx_binned_context ON binned_positions(context_id);
      PRAGMA user_version = 1;
      COMMIT;
      VACUUM;
    `)
    db.close()
  }

  it.each([
    ['before contexts had ids', asOlder],
    ['before coordinates were integers', asReal],
  ])('carries every table of a database an older version wrote %s over, and reads it as before', async (_, older) => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const MINUTE = 60_000
      const DAY_MS = 24 * 60 * MINUTE
      const day0 = Date.UTC(2026, 5, 1)
      const box: GeoBounds = { sw: [59.99, 23.99], ne: [60.01, 24.03] }
      const reads = async (store: SqliteTrackStore) => ({
        whole: await store.getTimed(ctx),
        byLevel: await store.getTimed(ctx, undefined, undefined, 20),
        boxByLevel: await store.getFilteredTimedTracks(
          { bbox: box, radius: null, intersects: true, contexts: [ctx], clip: true },
          undefined,
          undefined,
          { tolerance: 20 },
        ),
        every: await store.getFilteredTimedTracks({ bbox: box, radius: null, intersects: true, clip: true }),
        summaries: store.summarize(undefined),
        bin: store.binEntries(),
        name: store.nameFor(other),
        imported: store.getImport('imported:a'),
        history: store.historyImport(ctx),
        // State with nothing to read it by but the tables themselves.
        detail: store['db'].prepare('SELECT context, span_start, span_end FROM detail_spans ORDER BY id').all(),
        simplified: store['db'].prepare('SELECT context, through, tolerance FROM simplify_frontier').all(),
      })
      const binned = 'vessels.urn:mrn:signalk:uuid:binned' as Context
      const config = { file, resolution: 60_000, storageTolerance: 0.5 }
      const first = new SqliteTrackStore(config, debug)
      // One commit: written to a file one by one, this many positions take a Windows runner most of a minute.
      first.transaction(() => {
        // At anchor, finer than the store's resolution.
        for (let i = 0; i < 3 * 3600; i++) {
          first.newPosition(ctx, [60 + Math.sin(i / 400) * 0.002, 24 + i * 0.000002], day0 + i * 1000, 1000)
        }
        for (let i = 0; i < 600; i++) {
          first.newPosition(other, [60.005, 24.01 + i * 0.00001], day0 + i * 1000)
        }
        for (let i = 0; i < 30; i++) {
          first.newPosition(binned, [59.9, 24.1 + i * 0.001], day0 + i * MINUTE)
        }
        first.recordName(other, 'Ariadne', day0)
        first.storeImport({
          id: 'imported:a',
          context: other,
          name: 'Passage',
          metadata: { colour: 'red' },
          segments: [[{ position: [60, 24], timestamp: day0 }]],
        })
        first.saveHistoryImport({ context: ctx, startedAt: day0 + DAY_MS, filled: 60 }, [
          Array.from({ length: 60 }, (_, i) => ({
            position: [59.9, 24 + i * 0.0001],
            timestamp: day0 - DAY_MS + i * MINUTE,
          })),
        ])
      })
      const otherWhole = await first.getTimed(other)
      const binnedWhole = await first.getTimed(binned)
      first.transaction(() => {
        first.binRecorded(other, day0 + 300_000, day0 + 599_000, day0 + DAY_MS, false)
        // Every position of it, so the bin alone holds the vessel.
        first.binRecorded(binned, undefined, day0 + DAY_MS, day0 + DAY_MS, false)
      })
      for (let more = true; more;) {
        first.transaction(() => {
          more = first.refineLevels(day0 + 3 * DAY_MS)
        })
      }
      const before = await reads(first)
      // Each read holds something for the rewrite to keep.
      expect(before.byLevel.length).toBeLessThan(before.whole.length / 10)
      expect(before.boxByLevel[ctx]?.length).toBeGreaterThan(0)
      expect(Object.keys(before.every).sort()).toEqual([ctx, other].sort())
      expect(before.bin).toHaveLength(2)
      expect(before.name).toBe('Ariadne')
      expect(before.imported?.name).toBe('Passage')
      expect(before.history?.filled).toBe(60)
      expect(before.detail.length).toBeGreaterThan(0)
      expect(before.simplified.length).toBeGreaterThan(0)
      first.close()
      older(file)
      const size = statSync(file).size

      const store = new SqliteTrackStore(config, debug)
      expect(await reads(store)).toEqual(before)
      expect(store['db'].prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      // A level refers to its position by row, which the rewrite keeps.
      expect(
        store['db']
          .prepare(
            `SELECT count(*) AS n FROM significant s LEFT JOIN positions p ON p.rowid = s.position
             WHERE p.rowid IS NULL OR s.context_id IS NOT p.context_id OR s.timestamp IS NOT p.timestamp`,
          )
          .get(),
      ).toEqual({ n: 0 })
      for (const { id } of before.bin) {
        expect(store.restoreFromBin(id)).toBe('restored')
      }
      expect(await store.getTimed(other)).toEqual(otherWhole)
      expect(await store.getTimed(binned)).toEqual(binnedWhole)
      store.close()
      expect(statSync(file).size).toBeLessThan(size)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Integers of 1e-7 degrees, as GPX export writes them, rounded half away
  // from zero as SQLite's round() rounds an older file's on the rewrite.
  it('keeps a position to the 1e-7 degree', async () => {
    const store = newStore()
    store.newPosition(ctx, [60.123456789, -24.12345675], t0)
    store.newPosition(ctx, [-0.00000005, 0.00000004], t0 + 60_000)

    expect((await store.getTimed(ctx)).map(({ position }) => position)).toEqual([
      [60.1234568, -24.1234568],
      [-0.0000001, 0],
    ])
    store.close()
  })

  it('rounds an older database’s coordinates to the 1e-7 degree as it rewrites them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(OLD_POSITIONS)
      older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.123456789, -24.12345675)
      older.close()

      const store = new SqliteTrackStore({ file }, debug)

      expect(await store.getTimed(ctx)).toEqual([{ position: [60.1234568, -24.1234568], timestamp: t0 }])
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Every table that holds a position, rounded alike, so a level still names
  // its position and a binned one comes back as it was kept.
  it('rounds the coordinates of every table of a database before coordinates were integers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const DAY_MS = 24 * 60 * 60_000
      const day0 = Date.UTC(2026, 5, 1)
      const first = new SqliteTrackStore({ file }, debug)
      first.transaction(() => {
        for (let i = 0; i < 600; i++) {
          first.newPosition(ctx, [60 + Math.sin(i / 50) * 0.01, 24 + i * 0.0001], day0 + i * 60_000)
        }
        for (let i = 0; i < 30; i++) first.newPosition(other, [59.9, 24.1 + i * 0.001], day0 + i * 60_000)
      })
      first.transaction(() => {
        first.binRecorded(other, undefined, day0 + 30 * 60_000, day0 + 3 * DAY_MS, false)
      })
      for (let more = true; more;) {
        first.transaction(() => {
          more = first.refineLevels(day0 + 3 * DAY_MS)
        })
      }
      first.close()
      asReal(file)
      // As an older version wrote them: not on the 1e-7 degree.
      const nudge = 0.000000033
      const real = new DatabaseSync(file)
      for (const table of ['positions', 'binned_positions', 'significant']) {
        real.exec(`UPDATE ${table} SET lat = lat + ${nudge}, lon = lon - ${nudge}`)
      }
      const before = real
        .prepare(
          'SELECT timestamp, lat, lon FROM positions WHERE context_id = (SELECT id FROM contexts WHERE context = ?) ORDER BY timestamp',
        )
        .all(ctx) as { timestamp: number; lat: number; lon: number }[]
      const binnedBefore = real.prepare('SELECT lat, lon FROM binned_positions ORDER BY timestamp').all() as {
        lat: number
        lon: number
      }[]
      real.close()

      const store = new SqliteTrackStore({ file }, debug)
      const db = store['db']
      expect(await store.getTimed(ctx)).toEqual(
        before.map(({ timestamp, lat, lon }) => ({ position: rounded([lat, lon]), timestamp })),
      )
      expect((db.prepare('SELECT count(*) AS n FROM significant').get() as { n: number }).n).toBeGreaterThan(0)
      expect(
        db
          .prepare(
            `SELECT count(*) AS n FROM significant s JOIN positions p ON p.rowid = s.position
             WHERE s.lat_e7 IS NOT p.lat_e7 OR s.lon_e7 IS NOT p.lon_e7`,
          )
          .get(),
      ).toEqual({ n: 0 })
      expect(binnedBefore).toHaveLength(30)
      for (const { id } of store.binEntries()) expect(store.restoreFromBin(id)).toBe('restored')
      expect((await store.getTimed(other)).map(({ position }) => position)).toEqual(
        binnedBefore.map(({ lat, lon }) => rounded([lat, lon])),
      )
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // An id is never given to another vessel, a forgotten one's included.
  it('keeps the ids of a database before coordinates were integers, and how far they got', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file }, debug)
      first.newPosition(ctx, [60.1, 24.9], t0)
      first.newPosition(other, [60.2, 24.8], t0)
      const ids = first['db'].prepare('SELECT id, context FROM contexts ORDER BY id').all()
      first.close()
      asReal(file)
      const real = new DatabaseSync(file)
      real.exec("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'contexts'")
      real.close()

      const store = new SqliteTrackStore({ file }, debug)
      const db = store['db']
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      expect(db.prepare('SELECT id, context FROM contexts ORDER BY id').all()).toEqual(ids)
      store.newPosition('vessels.urn:mrn:signalk:uuid:new' as Context, [60.3, 24.7], t0)
      expect(db.prepare("SELECT id FROM contexts WHERE context = 'vessels.urn:mrn:signalk:uuid:new'").get()).toEqual({
        id: 101,
      })
      expect(await store.getTimed(ctx)).toEqual([{ position: [60.1, 24.9], timestamp: t0 }])
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // What a crash leaves: rows committed to the log, not yet written back.
  it('rewrites the rows an older database still holds in its write-ahead log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const crashed = join(dir, 'crashed.db')
      const older = new DatabaseSync(file)
      older.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${OLD_POSITIONS}`)
      const insert = older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)')
      for (let i = 0; i < 100; i++) {
        insert.run(ctx, t0 + i * 1000, 60.1, 24.9)
      }
      // Copied while still open, as a power cut would leave them.
      for (const suffix of ['', '-wal']) {
        writeFileSync(`${crashed}${suffix}`, readFileSync(`${file}${suffix}`))
      }
      older.close()
      expect(statSync(`${crashed}-wal`).size).toBeGreaterThan(0)

      const store = new SqliteTrackStore({ file: crashed }, debug)
      expect(await store.getTimed(ctx)).toHaveLength(100)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * An older database at `target`, linked from `file`, left as a crash leaves
   * it with a log beside the link: one position written back to the file, a
   * hundred more only in the log. On Windows, SQLite keeps the log of a
   * database opened through a link beside the link.
   */
  function crashedBehindLink(dir: string) {
    const target = join(dir, 'elsewhere.db')
    const file = join(dir, 'tracks.db')
    const open = join(dir, 'open.db')
    const older = new DatabaseSync(open)
    older.exec(OLD_POSITIONS)
    older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
    older.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
    const insert = older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)')
    for (let i = 1; i <= 100; i++) {
      insert.run(ctx, t0 + i * 1000, 60.1, 24.9)
    }
    // Copied while still open, as a power cut would leave them.
    writeFileSync(target, readFileSync(open))
    writeFileSync(`${file}-wal`, readFileSync(`${open}-wal`))
    older.close()
    symlinkSync(target, file)
    return { target, file }
  }

  // Where SQLite follows the link, the log beside it is not one it reads, so
  // the rewrite cannot write it back: it stops instead.
  it.skipIf(process.platform === 'win32')(
    'leaves an older database as it is with Windows faked when a log is left beside the link to it',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      try {
        const { target, file } = crashedBehindLink(dir)
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
        try {
          expect(() => new SqliteTrackStore({ file }, debug)).toThrow(/was written to while it was rewritten/)
        } finally {
          if (platform) Object.defineProperty(process, 'platform', platform)
        }
        expect(existsSync(`${target}.migrating`)).toBe(false)
        const kept = new DatabaseSync(target)
        expect(kept.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
        kept.close()
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform)
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'win32')(
    'rewrites the rows an older database holds in a log beside the link to it',
    async (context) => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
      try {
        let file: string
        try {
          ;({ file } = crashedBehindLink(dir))
        } catch (error) {
          // Making a link needs extra rights on Windows. Skip for that alone:
          // an EPERM from copying the files would hide what the test is for.
          const { code, syscall } = error as { code?: string; syscall?: string }
          if (code === 'EPERM' && syscall === 'symlink') {
            context.skip()
          }
          throw error
        }
        const store = new SqliteTrackStore({ file }, debug)
        expect(await store.getTimed(ctx)).toHaveLength(101)
        store.close()
        expect(existsSync(`${file}-wal`)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // Out of WAL mode already, as a rewrite that failed leaves it, the file takes no lock to switch.
  it('leaves an older database out of WAL mode as it is while another connection reads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const reader = new DatabaseSync(file)
      reader.exec(OLD_POSITIONS)
      reader.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      reader.exec('BEGIN')
      reader.prepare('SELECT COUNT(*) FROM positions').get()

      expect(() => new SqliteTrackStore({ file }, debug)).toThrow(/another connection holds it open/)
      expect(existsSync(`${file}.migrating`)).toBe(false)
      reader.exec('COMMIT')
      reader.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  // Left empty by another tool's TRUNCATE or PERSIST journal, or a crash, it
  // is no write: SQLite leaves it there and passes over it.
  it('rewrites an older database beside a journal left empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(OLD_POSITIONS)
      older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      older.close()
      writeFileSync(`${file}-journal`, '')

      const store = new SqliteTrackStore({ file }, debug)
      expect(await store.getTimed(ctx)).toHaveLength(1)
      expect(store['db'].prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('gives the rewritten file the mode the old one had', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(OLD_POSITIONS)
      older.close()
      // A mode no umask gives a new file.
      chmodSync(file, 0o604)

      new SqliteTrackStore({ file }, debug).close()
      expect(statSync(file).mode & 0o777).toBe(0o604)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A link to a file elsewhere, on a disk of its own say, which must stay a link.
  it.skipIf(process.platform === 'win32')('rewrites the file a link to an older database points to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const target = join(dir, 'elsewhere.db')
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(target)
      older.exec(OLD_POSITIONS)
      older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      older.close()
      symlinkSync(target, file)

      const store = new SqliteTrackStore({ file }, debug)
      expect(await store.getTimed(ctx)).toHaveLength(1)
      store.close()
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
      const rewritten = new DatabaseSync(target)
      expect(rewritten.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      rewritten.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The system follows `d` before it takes the `..`, as SQLite does. Taken
  // the other way round, the path names a file in `data`, which is not
  // there, and the store would not open.
  it.skipIf(process.platform === 'win32')(
    'rewrites the older database a link reaches past a linked directory and `..`',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
      try {
        mkdirSync(join(dir, 'disk', 'x', 'y'), { recursive: true })
        mkdirSync(join(dir, 'data'))
        symlinkSync(join(dir, 'disk', 'x', 'y'), join(dir, 'data', 'd'))
        const target = join(dir, 'disk', 'x', 'tracks.db')
        const older = new DatabaseSync(target)
        older.exec(OLD_POSITIONS)
        older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
        older.close()
        const file = join(dir, 'tracks.db')
        // Not `join`, which would take the `..` away.
        symlinkSync(`${join(dir, 'data', 'd')}/../tracks.db`, file)

        const store = new SqliteTrackStore({ file }, debug)
        expect(await store.getTimed(ctx)).toHaveLength(1)
        store.close()
        expect(existsSync(join(dir, 'data', 'tracks.db'))).toBe(false)
        const rewritten = new DatabaseSync(target)
        expect(rewritten.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
        rewritten.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // As on some RAM disks on Windows, where the system's realpath fails.
  it.skipIf(process.platform === 'win32')(
    "rewrites the file a link points to where the system's realpath fails",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
      const native = vi.spyOn(realpathSync, 'native').mockImplementation(() => {
        throw Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), { code: 'EISDIR' })
      })
      try {
        const target = join(dir, 'elsewhere.db')
        const file = join(dir, 'tracks.db')
        const older = new DatabaseSync(target)
        older.exec(OLD_POSITIONS)
        older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
        older.close()
        symlinkSync(target, file)

        const store = new SqliteTrackStore({ file }, debug)
        expect(native).toHaveBeenCalled()
        expect(await store.getTimed(ctx)).toHaveLength(1)
        store.close()
        expect(lstatSync(file).isSymbolicLink()).toBe(true)
        const rewritten = new DatabaseSync(target)
        expect(rewritten.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
        rewritten.close()
      } finally {
        native.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // A new database set up only in part before a crash, its version not yet written.
  it('opens a database of this version whose version was never written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file }, debug)
      first.newPosition(ctx, [60.1, 24.9], t0)
      first['db'].exec('PRAGMA user_version = 0')
      first.close()

      const said: string[] = []
      const store = new SqliteTrackStore(
        { file },
        Object.assign((...m: unknown[]) => said.push(String(m[0])), { enabled: true }),
      )
      expect(await store.getTimed(ctx)).toHaveLength(1)
      expect(store['db'].prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      expect(said.filter((m) => m.startsWith('rewrote'))).toEqual([])
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a database of this version as it is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file }, debug)
      first.newPosition(ctx, [60.1, 24.9], t0)
      first.close()
      const { ino } = statSync(file, { bigint: true })

      const said: string[] = []
      const store = new SqliteTrackStore(
        { file },
        Object.assign((...m: unknown[]) => said.push(String(m[0])), { enabled: true }),
      )
      store.close()

      expect(said.filter((m) => m.startsWith('rewrote'))).toEqual([])
      expect(statSync(file, { bigint: true }).ino).toBe(ino)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a database a newer version wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const newer = new DatabaseSync(file)
      newer.exec('PRAGMA user_version = 3')
      newer.close()

      expect(() => new SqliteTrackStore({ file }, debug)).toThrow(/written by a newer version/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves an older database as it is when something writes to it while it is rewritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(OLD_POSITIONS)
      older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      older.close()
      rewriting.beforeFsync = () => {
        rewriting.beforeFsync = undefined
        const writer = new DatabaseSync(file)
        writer.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0 + 1000, 60.2, 24.8)
        writer.close()
      }
      try {
        expect(() => new SqliteTrackStore({ file }, debug)).toThrow(/was written to while it was rewritten/)
      } finally {
        rewriting.beforeFsync = undefined
      }
      expect(existsSync(`${file}.migrating`)).toBe(false)
      const kept = new DatabaseSync(file)
      expect(kept.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      expect(kept.prepare('SELECT count(*) AS n FROM positions').get()).toEqual({ n: 2 })
      kept.close()

      // Rewritten at the next start, the write included.
      const store = new SqliteTrackStore({ file }, debug)
      expect(await store.getTimed(ctx)).toHaveLength(2)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Begun during the rewrite and waiting for its lock, the write shows in
  // neither the change counter nor a hot journal yet: renamed over, it would
  // land in the replaced file, and its program be told it was made.
  it.skipIf(process.platform === 'win32')(
    'leaves an older database as it is while a write begun during the rewrite waits for it',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
      const held: { writer?: DatabaseSync } = {}
      try {
        const file = join(dir, 'tracks.db')
        const older = new DatabaseSync(file)
        older.exec(OLD_POSITIONS)
        older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
        older.close()
        rewriting.beforeFsync = () => {
          rewriting.beforeFsync = undefined
          held.writer = new DatabaseSync(file)
          held.writer.exec('BEGIN IMMEDIATE')
          held.writer.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0 + 1000, 60.2, 24.8)
        }
        try {
          expect(() => new SqliteTrackStore({ file }, debug)).toThrow(/another connection holds it open/)
        } finally {
          rewriting.beforeFsync = undefined
        }
        expect(existsSync(`${file}.migrating`)).toBe(false)

        // The write goes through to the file, which the next start rewrites.
        held.writer?.exec('COMMIT')
        held.writer?.close()
        delete held.writer
        const store = new SqliteTrackStore({ file }, debug)
        expect(await store.getTimed(ctx)).toHaveLength(2)
        store.close()
      } finally {
        held.writer?.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    'holds the lock on an older database while it renames the rewrite over it',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
      try {
        const file = join(dir, 'tracks.db')
        const older = new DatabaseSync(file)
        older.exec(OLD_POSITIONS)
        older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
        older.close()
        // Asked for by another process: one in this process is answered
        // from SQLite's own record of its locks, which closing a descriptor
        // of the file would leave as it was while dropping the lock itself.
        const tryWrite = `
          const { DatabaseSync } = require('node:sqlite')
          const writer = new DatabaseSync(process.argv[1])
          writer.exec('PRAGMA busy_timeout = 0')
          try {
            writer.exec('BEGIN IMMEDIATE')
            writer.exec('ROLLBACK')
            console.log(0)
          } catch (error) {
            console.log(error.errcode & 0xff)
          }
          writer.close()
        `
        const refused: number[] = []
        rewriting.beforeRename = () => {
          rewriting.beforeRename = undefined
          refused.push(
            Number(execFileSync(process.execPath, ['--no-warnings', '-e', tryWrite, file], { encoding: 'utf8' })),
          )
        }
        try {
          const store = new SqliteTrackStore({ file }, debug)
          store.close()
        } finally {
          rewriting.beforeRename = undefined
        }

        expect(refused).toEqual([5])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // As on Windows, which takes no lock and tries the rename again while a
  // scanner holds a file: a write between two tries stops the rewrite.
  it('leaves an older database as it is when something writes to it while a rename is tried again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(OLD_POSITIONS)
      older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      older.close()
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      rewriting.beforeRename = () => {
        rewriting.beforeRename = undefined
        const writer = new DatabaseSync(file)
        writer.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0 + 1000, 60.2, 24.8)
        writer.close()
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      try {
        expect(() => new SqliteTrackStore({ file }, debug)).toThrow(/was written to while it was rewritten/)
      } finally {
        rewriting.beforeRename = undefined
        if (platform) Object.defineProperty(process, 'platform', platform)
      }
      expect(existsSync(`${file}.migrating`)).toBe(false)
      const kept = new DatabaseSync(file)
      expect(kept.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      expect(kept.prepare('SELECT count(*) AS n FROM positions').get()).toEqual({ n: 2 })
      kept.close()

      // Rewritten at the next start, the write included.
      const store = new SqliteTrackStore({ file }, debug)
      expect(await store.getTimed(ctx)).toHaveLength(2)
      store.close()
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // As on Windows, where a scanner can hold the old file as well as the new
  // one: an open of it refused between two tries at the rename is waited out
  // as the rename is.
  it('tries the rename again when the old database is held as it is checked again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const busy = (what: string) =>
      Object.assign(new Error(`EBUSY: resource busy or locked, ${what}`), { code: 'EBUSY' })
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(OLD_POSITIONS)
      older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      older.close()
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      // The file as the rewrite names it, with the system's realpath: on
      // Windows, Node's own keeps the short names in the temporary directory.
      const opened = realpathSync.native(file)
      let refused = false
      rewriting.beforeRename = () => {
        rewriting.beforeRename = undefined
        rewriting.beforeOpen = (path) => {
          if (path !== opened) return
          rewriting.beforeOpen = undefined
          refused = true
          throw busy('open')
        }
        throw busy('rename')
      }
      let store: SqliteTrackStore
      try {
        store = new SqliteTrackStore({ file }, debug)
      } finally {
        rewriting.beforeRename = undefined
        rewriting.beforeOpen = undefined
        if (platform) Object.defineProperty(process, 'platform', platform)
      }
      expect(refused).toBe(true)
      expect(await store.getTimed(ctx)).toHaveLength(1)
      store.close()
      const rewritten = new DatabaseSync(file)
      expect(rewritten.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      rewritten.close()
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds the rewrite again where a crash left it half built', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(OLD_POSITIONS)
      older.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      older.close()
      writeFileSync(`${file}.migrating`, 'not a database')

      const store = new SqliteTrackStore({ file }, debug)
      expect(await store.getTimed(ctx)).toEqual([{ position: [60.1, 24.9], timestamp: t0 }])
      expect(existsSync(`${file}.migrating`)).toBe(false)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads an untimed track back in the order it was given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      // In neither latitude nor longitude order, which the index would
      // sort equal times by.
      const track: LatLngTuple[] = [
        [60.3, 24.1],
        [60.1, 24.9],
        [60.2, 24.5],
      ]
      const first = new SqliteTrackStore({ file }, debug)
      first.initialTrack(ctx, track)
      first.close()

      const store = new SqliteTrackStore({ file }, debug)
      expect((await store.getTimed(ctx)).map(({ position }) => position)).toEqual(track)
      expect(store.segments(ctx)).toEqual([track])
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Waits out the tries to take it out of WAL mode, about 5 s, before giving up.
  it('leaves a database an older version wrote as it is while another connection holds it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-index-'))
    try {
      const file = join(dir, 'tracks.db')
      const reader = new DatabaseSync(file)
      reader.exec(`PRAGMA journal_mode = WAL; ${OLD_POSITIONS}`)
      reader.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, 0)').run(ctx, t0, 60.1, 24.9)
      // A read in progress, as a backup or an sqlite3 shell can hold one.
      reader.exec('BEGIN')
      reader.prepare('SELECT COUNT(*) FROM positions').get()

      expect(() => new SqliteTrackStore({ file }, debug)).toThrow(/another connection holds it open/)
      expect(existsSync(`${file}.migrating`)).toBe(false)
      reader.exec('COMMIT')
      expect(reader.prepare('SELECT context FROM positions').all()).toEqual([{ context: ctx }])
      reader.close()

      // Rewritten once it is free.
      const store = new SqliteTrackStore({ file }, debug)
      expect(await store.getTimed(ctx)).toHaveLength(1)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('a transaction whose rollback fails', () => {
  it('reports the write error, not only that the rollback failed', () => {
    const store = newStore()
    let thrown: unknown
    try {
      store.transaction(() => {
        // Closing the connection mid-transaction makes the ROLLBACK fail too.
        store['db'].close()
        throw new Error('disk I/O error')
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TransactionStateError)
    expect(thrown).toMatchObject({ message: expect.stringContaining('disk I/O error') })
  })
})

describe('imported tracks', () => {
  const t0 = Date.parse('2026-06-01T00:00:00Z')
  const imported = (overrides: Partial<ImportedTrack> = {}): ImportedTrack => ({
    id: 'imported:a',
    context: other,
    name: 'Passage',
    metadata: { colour: 'red', tags: ['race'] },
    segments: [
      [
        { position: [60, 24], timestamp: t0 },
        { position: [60.1, 24.1], timestamp: t0 + 60_000 },
      ],
      [{ position: [60.2, 24.2], timestamp: t0 + 3_600_000 }],
    ],
    ...overrides,
  })
  const stored = (track: ImportedTrack) => ({ ...track, importedAt: expect.any(Number) as number })

  it('returns a stored track as it was stored', () => {
    const store = newStore()
    store.storeImport(imported())
    expect(store.getImport('imported:a')).toEqual(stored(imported()))
    store.close()
  })

  it('keeps a track with no times, and no context or name', () => {
    const store = newStore()
    const untimed = imported({ segments: [[{ position: [60, 24] }, { position: [61, 25] }]] })
    delete untimed.context
    delete untimed.name
    store.storeImport(untimed)
    expect(store.getImport('imported:a')).toEqual(stored(untimed))
    store.close()
  })

  it('refuses a second track under an id already taken', () => {
    const store = newStore()
    store.storeImport(imported())
    expect(() => store.storeImport(imported({ name: 'Other' }))).toThrow()
    expect(store.getImport('imported:a')?.name).toBe('Passage')
    store.close()
  })

  it('narrows by context, leaving out imports that name none', () => {
    const store = newStore()
    store.storeImport(imported())
    const contextless = imported({ id: 'imported:b' })
    delete contextless.context
    store.storeImport(contextless)
    expect(store.findImports().map(({ id }) => id)).toEqual(['imported:a', 'imported:b'])
    expect(store.findImports({ contexts: [other] }).map(({ id }) => id)).toEqual(['imported:a'])
    expect(store.findImports({ contexts: [ctx] })).toEqual([])
    store.close()
  })

  it('matches a window on the time span, with the same end rule as recorded tracks', () => {
    const store = newStore()
    store.storeImport(imported())
    store.storeImport(imported({ id: 'imported:untimed', segments: [[{ position: [60, 24] }]] }))
    const ids = (window: TimeWindow) => store.findImports({ window }).map(({ id }) => id)
    const end = t0 + 3_600_000
    // Between the two segments: the span still overlaps.
    expect(ids({ from: t0 + 120_000, to: t0 + 180_000 })).toEqual(['imported:a'])
    expect(ids({ from: end + 1, to: end + 2 })).toEqual([])
    expect(ids({ from: t0 - 2, to: t0 })).toEqual([])
    expect(ids({ from: t0 - 2, to: t0, inclusiveEnd: true })).toEqual(['imported:a'])
    expect(ids({ from: Number.NEGATIVE_INFINITY, to: end })).toEqual(['imported:a'])
    store.close()
  })

  it('matches a box on the extent, including across the antimeridian', () => {
    const store = newStore()
    store.storeImport(imported())
    store.storeImport(
      imported({
        id: 'imported:fiji',
        segments: [
          [
            { position: [-17, 179.5], timestamp: t0 },
            { position: [-17.1, -179.5], timestamp: t0 + 60_000 },
          ],
        ],
      }),
    )
    const ids = (bbox: GeoBounds) => store.findImports({ bbox }).map(({ id }) => id)
    expect(ids({ sw: [59, 23], ne: [61, 25] })).toEqual(['imported:a'])
    expect(ids({ sw: [-18, 179.8], ne: [-16, -179.8] })).toEqual(['imported:fiji'])
    expect(ids({ sw: [-18, -179.9], ne: [-16, -179] })).toEqual(['imported:fiji'])
    expect(ids({ sw: [-18, 170], ne: [-16, 175] })).toEqual([])
    expect(ids({ sw: [61, 23], ne: [62, 25] })).toEqual([])
    store.close()
  })

  it('leaves imports alone when recorded tracks are pruned', () => {
    const store = new SqliteTrackStore({ file: ':memory:', retention: 1 }, debug)
    store.storeImport(imported())
    store.newPosition(other, [60, 24], 1000)
    store.prune(-1)
    expect(store.getImport('imported:a')).toEqual(stored(imported()))
    store.close()
  })

  it('refuses the id of an import in the recycle bin, and writes nothing', () => {
    const store = newStore()
    store.storeImport(imported())
    store.binImport('imported:a', undefined, t0)
    expect(() => store.storeImport(imported({ name: 'Other' }))).toThrow()
    expect(store.getImport('imported:a')).toBeUndefined()
    const [entry] = store.binEntries()
    expect(store.restoreFromBin(entry!.id)).toBe('restored')
    expect(store.getImport('imported:a')?.name).toBe('Passage')
    store.close()
  })

  it('keeps when each track was stored', () => {
    const store = newStore()
    const before = Date.now()
    store.storeImport(imported())
    const importedAt = store.getImport('imported:a')!.importedAt
    expect(importedAt).toBeGreaterThanOrEqual(before)
    expect(importedAt).toBeLessThanOrEqual(Date.now())
    expect(store.findImports().map((track) => track.importedAt)).toEqual([importedAt])
    store.close()
  })

  it('dates imports an older version stored to the first start that keeps the time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracks-imports-'))
    try {
      const file = join(dir, 'tracks.db')
      const first = new SqliteTrackStore({ file }, debug)
      first.storeImport(imported())
      first.storeImport(imported({ id: 'imported:b' }))
      first.binImport('imported:b', undefined, t0)
      first.close()
      const older = new DatabaseSync(file)
      older.exec('DROP TABLE import_times')
      older.close()

      const before = Date.now()
      const store = new SqliteTrackStore({ file }, debug)
      expect(store.getImport('imported:a')?.importedAt).toBeGreaterThanOrEqual(before)
      const [entry] = store.binEntries()
      expect(store.restoreFromBin(entry!.id)).toBe('restored')
      expect(store.getImport('imported:b')?.importedAt).toBeGreaterThanOrEqual(before)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds its tables to a database an older version wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracks-imports-'))
    try {
      const file = join(dir, 'tracks.db')
      const older = new DatabaseSync(file)
      older.exec(
        'CREATE TABLE positions (context TEXT NOT NULL, timestamp INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, s2cell INTEGER NOT NULL)',
      )
      older.close()
      const store = new SqliteTrackStore({ file }, debug)
      store.storeImport(imported())
      expect(store.getImport('imported:a')).toEqual(stored(imported()))
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('an import filling the gaps in a recording', () => {
  const t0 = Date.parse('2026-06-01T00:00:00Z')
  const MINUTE = 60_000
  const run = (lat: number, from: number, count: number, step: number): TimedPosition[] =>
    Array.from({ length: count }, (_, i) => ({ position: [lat, 24], timestamp: from + i * step }))

  it('leaves out what was written into the gap since it was judged, and bins nothing', async () => {
    const store = newStore()
    try {
      // Another upload, written after this one read the store.
      const earlier = run(61, t0, 121, 10_000)
      expect(store.fillTrack(ctx, [earlier])).toBe(0)
      const late = run(62, t0, 31, MINUTE)
      expect(store.fillTrack(ctx, [late])).toBe(21)
      const points = await store.getTimed(ctx)
      expect(points.filter(({ position }) => position[0] === 61)).toHaveLength(121)
      expect(points.filter(({ position }) => position[0] === 62).map(({ timestamp }) => timestamp)).toEqual(
        late.slice(21).map(({ timestamp }) => timestamp),
      )
      expect(store.binEntries()).toEqual([])
    } finally {
      store.close()
    }
  })

  // A day apart, and with many runs between, so the lookup has to find the
  // earlier run by time rather than by its place in the upload.
  it('judges a run against an earlier one that started a day before it', async () => {
    const store = newStore()
    try {
      const long = run(61, t0, 8641, 10_000)
      const between = Array.from({ length: 50 }, (_, i) =>
        run(63, t0 + 3 * 24 * 60 * MINUTE + i * 60 * MINUTE, 2, 1000),
      )
      const late = run(62, t0 + 24 * 60 * MINUTE - 5 * MINUTE, 10, 10_000)
      expect(store.fillTrack(ctx, [long, ...between, late])).toBe(10)
      const points = await store.getTimed(ctx)
      expect(points.filter(({ position }) => position[0] === 62)).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('judges each run against the ones before it in the same call', async () => {
    const store = newStore()
    try {
      const first = run(61, t0, 121, 10_000)
      const second = run(62, t0 + 5 * MINUTE, 121, 10_000)
      expect(store.fillTrack(ctx, [first, second])).toBe(91)
      const points = await store.getTimed(ctx)
      expect(points.filter(({ position }) => position[0] === 61)).toHaveLength(121)
      expect(points.filter(({ position }) => position[0] === 62).map(({ timestamp }) => timestamp)).toEqual(
        second.slice(91).map(({ timestamp }) => timestamp),
      )
    } finally {
      store.close()
    }
  })

  it('judges a run longer than a day, and points far apart, as one read of the whole recording would', async () => {
    const store = newStore()
    try {
      const DAY = 24 * 60 * MINUTE
      // Four minutes past where the day cuts the run, and two minutes either
      // side of a point far from the rest.
      store.fillTrack(ctx, [
        run(61, t0 + DAY + 4 * MINUTE, 1, 0),
        run(61, t0 + 3 * DAY - 2 * MINUTE, 1, 0),
        run(61, t0 + 3 * DAY + 2 * MINUTE, 1, 0),
      ])
      const recorded = await store.getTimed(ctx)
      const long = [...run(62, t0, 25 * 60 + 1, MINUTE), ...run(62, t0 + 3 * DAY, 1, 0), ...run(62, t0 + 4 * DAY, 1, 0)]
      const expected = fillGaps([long], recorded, MIN_FILLED_GAP_MS)
      expect(expected.overlapping).toBe(2)
      expect(store.fillTrack(ctx, [long])).toBe(expected.overlapping)
      const written = (await store.getTimed(ctx)).filter(({ position }) => position[0] === 62)
      expect(written.map(({ timestamp }) => timestamp)).toEqual(expected.runs.flat().map(({ timestamp }) => timestamp))
    } finally {
      store.close()
    }
  })

  it('leaves out a run that writes since, just outside it, left too short a gap for', async () => {
    const store = newStore()
    try {
      store.fillTrack(ctx, [run(61, t0 + 9.5 * MINUTE, 1, 0), run(61, t0 + 14.4 * MINUTE, 1, 0)])
      expect(store.fillTrack(ctx, [run(62, t0 + 10 * MINUTE, 5, MINUTE)])).toBe(5)
      expect((await store.getTimed(ctx)).filter(({ position }) => position[0] === 62)).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe('a GPX file saved in slices', () => {
  const t0 = Date.parse('2026-06-01T00:00:00Z')
  const SECOND = 1000
  const run = (lat: number, from: number, count: number, step = SECOND, offset = 0): TimedPosition[] =>
    Array.from({ length: count }, (_, i) => ({ position: [lat, 24], timestamp: from + i * step + offset }))
  const times = async (store: SqliteTrackStore) => (await store.getTimed(ctx)).map(({ timestamp }) => timestamp)

  it('fills a gap in the recording as one upload would, wherever a slice ends in it', async () => {
    // Recorded for a minute either side of a seven-minute gap.
    const recorded = [...run(60, t0, 61), ...run(60, t0 + 480 * SECOND, 61)]
    const points = run(61, t0, 541)
    const whole = newStore()
    const sliced = newStore()
    try {
      whole.fillTrack(ctx, [recorded])
      sliced.fillTrack(ctx, [recorded])
      const left = whole.fillTrack(ctx, [points])
      const state = saveSlices(sliced, uploading(), [[[1, points.slice(0, 200)]], [[1, points.slice(200)]]])
      expect(state).toMatchObject({ imported: points.length - left, overlapping: left })
      expect(await times(sliced)).toEqual(await times(whole))
    } finally {
      whole.close()
      sliced.close()
    }
  })

  it('replaces the recording without binning what an earlier slice wrote', async () => {
    const recorded = run(60, t0, 121, SECOND, 500)
    const first = run(61, t0, 61)
    const second = run(62, t0 + 30 * SECOND, 61)
    const whole = newStore()
    const sliced = newStore()
    try {
      whole.fillTrack(ctx, [recorded])
      sliced.fillTrack(ctx, [recorded])
      whole.recordTrack(ctx, [first, second], t0, false)
      saveSlices(sliced, uploading('replace'), [
        [[1, first.slice(0, 40)]],
        [
          [1, first.slice(40)],
          [2, second],
        ],
      ])
      expect(await times(sliced)).toEqual(await times(whole))
      expect(sliced.binEntries().map(({ pointCount }) => pointCount)).toEqual(expect.arrayContaining([60, 30]))
      expect(sliced.binEntries()).toHaveLength(2)
    } finally {
      whole.close()
      sliced.close()
    }
  })

  it.each([
    ['restored', (store: SqliteTrackStore, id: number) => store.restoreFromBin(id)],
    ['purged', (store: SqliteTrackStore, id: number) => store.purgeFromBin(id)],
  ])('starts a recycle bin entry of its own when the one a segment began was %s', (_, end) => {
    const store = newStore()
    try {
      store.fillTrack(ctx, [run(60, t0, 121, SECOND, 500)])
      const points = run(61, t0, 121)
      const state = saveSlices(store, uploading('replace'), [[[1, points.slice(0, 60)]]])
      end(store, state.binned!.id!)
      saveSlices(store, state, [[[1, points.slice(60)]]])
      expect(store.binEntries()).toEqual([expect.objectContaining({ pointCount: 61 })])
    } finally {
      store.close()
    }
  })

  it('leaves alone an entry made later under the id a restore freed', () => {
    const store = newStore()
    const other = 'vessels.urn:mrn:signalk:uuid:other' as Context
    try {
      store.fillTrack(ctx, [run(60, t0, 121, SECOND, 500)])
      store.fillTrack(other, [run(50, t0, 10)])
      const points = run(61, t0, 121)
      const state = saveSlices(store, uploading('replace'), [[[1, points.slice(0, 60)]]])
      store.restoreFromBin(state.binned!.id!)
      const { id } = store.binRecorded(other, t0, t0 + 9 * SECOND, t0 + 1, false)
      expect(id).toBe(state.binned!.id)
      saveSlices(store, state, [[[1, points.slice(60)]]])
      expect(store.binEntries().map(({ context, pointCount }) => [context, pointCount])).toEqual(
        expect.arrayContaining([
          [other, 10],
          [ctx, 61],
        ]),
      )
    } finally {
      store.close()
    }
  })
})

describe('history import', () => {
  const MINUTE = 60_000
  const DAY_MS = 24 * 60 * MINUTE

  it('keeps how far an import got, and what it filled, across a reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-history-import-'))
    const file = join(dir, 'tracks.db')
    try {
      const first = new SqliteTrackStore({ file }, debug)
      expect(first.historyImport(ctx)).toBeUndefined()
      const state = { context: ctx, startedAt: 5000, firstDay: 0, nextDay: 4000, filled: 2, inGap: true }
      first.saveHistoryImport(state, [
        [
          { position: [60, 24], timestamp: 1000 },
          { position: [60, 24.001], timestamp: 2000 },
        ],
      ])
      first.close()
      const second = new SqliteTrackStore({ file }, debug)
      expect(second.historyImport(ctx)).toEqual(state)
      expect((await second.getTimed(ctx)).map(({ timestamp }) => timestamp)).toEqual([1000, 2000])
      const failed = { ...state, error: 'provider unavailable' }
      second.saveHistoryImport(failed, [])
      expect(second.historyImport(ctx)).toEqual(failed)
      const finished = { context: ctx, startedAt: 5000, firstDay: 0, nextDay: 5000, filled: 2, finishedAt: 6000 }
      second.saveHistoryImport(finished, [])
      expect(second.historyImport(ctx)).toEqual(finished)
      expect(second.historyImport(other)).toBeUndefined()
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bins nothing where it fills', async () => {
    const store = newStore()
    store.newPosition(ctx, [59, 23], 10 * MINUTE)
    store.saveHistoryImport({ context: ctx, startedAt: 20 * MINUTE, filled: 2 }, [
      [
        { position: [60, 24], timestamp: 1000 },
        { position: [60, 24.001], timestamp: 2000 },
      ],
    ])
    expect((await store.getTimed(ctx)).map(({ timestamp }) => timestamp)).toEqual([1000, 2000, 10 * MINUTE])
    expect(store.binEntries()).toEqual([])
    store.close()
  })

  /** History at one fix a second over `[from, to)`, in buckets a second wide. */
  const seconds = (from: number, to: number): TimedPosition[] =>
    Array.from({ length: (to - from) / 1000 }, (_, i) => ({
      position: [60, 24 + i * 1e-5] as LatLngTuple,
      timestamp: from + i * 1000,
      span: 1000,
    }))

  it('leaves out, and does not count, what a write into the gap took while the provider was read', async () => {
    const store = newStore()
    const start = 10 * 60 * MINUTE
    store.newPosition(ctx, [60, 24], start)
    store.newPosition(ctx, [60, 24.01], start + 10 * MINUTE)
    const run = seconds(start + 1000, start + 10 * MINUTE)
    // A GPX import keeps a fix four and a half minutes in: the stretch before
    // it is too short to fill now, the one after is still long enough.
    const gpx = start + 4.5 * MINUTE
    store.recordTrack(ctx, [[{ position: [60.001, 24.005], timestamp: gpx }]], 9000, false)
    const state = { context: ctx, startedAt: start + DAY_MS, filled: 1000 + run.length }
    const kept = run.filter(({ timestamp }) => timestamp > gpx)
    expect(store.saveHistoryImport(state, [run])).toBe(1000 + kept.length)
    expect(store.historyImport(ctx)?.filled).toBe(1000 + kept.length)
    expect((await store.getTimed(ctx)).map(({ timestamp }) => timestamp)).toEqual([
      start,
      gpx,
      ...kept.map(({ timestamp }) => timestamp),
      start + 10 * MINUTE,
    ])
    store.close()
  })

  it('does not count what the import wrote before since against what it goes on filling', async () => {
    const midnight = DAY_MS
    for (const since of [midnight, undefined]) {
      const store = newStore()
      store.saveHistoryImport({ context: ctx, startedAt: 2 * DAY_MS, filled: 300 }, [
        seconds(midnight - 5 * MINUTE, midnight),
      ])
      store.newPosition(ctx, [60, 24.01], midnight + 3 * MINUTE)
      const run = seconds(midnight, midnight + 3 * MINUTE)
      const filled = store.saveHistoryImport(
        { context: ctx, startedAt: 2 * DAY_MS, filled: 300 + run.length },
        [run],
        since,
      )
      // Counted against it, the stretch after midnight is three minutes long.
      expect(filled).toBe(since === undefined ? 300 : 300 + run.length)
      store.close()
    }
  })

  it('leaves out a bucket that reaches into a span deleted while the provider was read', async () => {
    const store = newStore()
    const run = seconds(0, 60_000)
    store.binRecorded(ctx, 10_500, 20_000, 9000, true)
    store.saveHistoryImport({ context: ctx, startedAt: DAY_MS, filled: run.length }, [run])
    const times = (await store.getTimed(ctx)).map(({ timestamp }) => timestamp)
    expect(times).not.toContain(10_000)
    expect(times).toContain(9000)
    expect(times).toContain(21_000)
    store.close()
  })

  it('leaves out what lies in a span deleted from the recording', async () => {
    const store = newStore()
    store.binRecorded(ctx, 1500, 2500, 9000, true)
    store.saveHistoryImport({ context: ctx, startedAt: 5000, filled: 3 }, [
      [1000, 2000, 3000].map((timestamp) => ({ position: [60, 24] as LatLngTuple, timestamp })),
    ])
    expect((await store.getTimed(ctx)).map(({ timestamp }) => timestamp)).toEqual([1000, 3000])
    store.close()
  })
})
