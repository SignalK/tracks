import { describe, expect, it } from 'vitest'
import { SqliteTrackStore } from './sqliteStore.js'
import type { Context, ImportedTrack } from './types.js'

const debug = Object.assign(() => {}, { enabled: false })
const self = 'vessels.urn:mrn:signalk:uuid:self' as Context
const other = 'vessels.urn:mrn:imo:mmsi:987654321' as Context
const DAY = 24 * 60 * 60 * 1000
const t0 = Date.UTC(2026, 5, 1)

const newStore = (binRetention = 0) => new SqliteTrackStore({ file: ':memory:', binRetention }, debug)

const record = (store: SqliteTrackStore, context: Context, times: number[]) => {
  for (const [i, t] of times.entries()) {
    store.newPosition(context, [60 + i / 100, 24], t)
  }
}

const timesOf = async (store: SqliteTrackStore, context: Context) =>
  (await store.getTimed(context).catch(() => [])).map(({ timestamp }) => timestamp)

const passage = (): ImportedTrack => ({
  id: 'imported:a',
  context: other,
  name: 'Race day',
  metadata: { colour: 'red' },
  segments: [
    [
      { position: [60, 24], timestamp: t0 },
      { position: [60.1, 24.1], timestamp: t0 + 1000 },
    ],
    [
      { position: [60.2, 24.2], timestamp: t0 + 2000 },
      { position: [60.3, 24.3], timestamp: t0 + 3000 },
    ],
  ],
})

describe('recycle bin: recorded tracks', () => {
  it('moves a span out of the track and restores it', async () => {
    const store = newStore()
    record(store, self, [t0, t0 + 1000, t0 + 2000, t0 + 3000])
    const id = store.binRecorded(self, t0 + 1000, t0 + 2000, t0 + DAY, false).id!
    expect(await timesOf(store, self)).toEqual([t0, t0 + 3000])
    expect(store.binEntries()).toEqual([
      { id, context: self, whole: false, from: t0 + 1000, to: t0 + 2000, deletedAt: t0 + DAY, pointCount: 2 },
    ])
    expect(store.restoreFromBin(id)).toBe('restored')
    expect(await timesOf(store, self)).toEqual([t0, t0 + 1000, t0 + 2000, t0 + 3000])
    expect(store.binEntries()).toEqual([])
    expect(store.deletedSpans()).toEqual([])
    store.close()
  })

  it('reaches back to the start of the track without a from', async () => {
    const store = newStore()
    record(store, self, [t0, t0 + 1000, t0 + 2000])
    store.binRecorded(self, undefined, t0 + 1000, t0 + DAY, false)
    expect(await timesOf(store, self)).toEqual([t0 + 2000])
    expect(store.deletedSpans()).toEqual([{ context: self, to: t0 + 1000 }])
    store.close()
  })

  it('touches no other vessel', async () => {
    const store = newStore()
    record(store, self, [t0])
    record(store, other, [t0])
    store.binRecorded(other, undefined, t0, t0 + DAY, false)
    expect(await timesOf(store, self)).toEqual([t0])
    store.close()
  })

  // A span with nothing stored in it may still hide what a history provider
  // holds, so only the caller can say whether it is worth an entry.
  it('keeps an empty delete only when asked to', () => {
    const store = newStore()
    record(store, self, [t0])
    expect(store.binRecorded(self, t0 + 5000, t0 + 6000, t0 + DAY, false)).toEqual({ known: true })
    expect(store.binEntries()).toEqual([])
    const id = store.binRecorded(self, t0 + 5000, t0 + 6000, t0 + DAY, true).id!
    expect(store.binEntries().map((entry) => [entry.id, entry.pointCount])).toEqual([[id, 0]])
    expect(store.binRecorded(other, undefined, t0, t0 + DAY, false)).toEqual({ known: false })
    store.close()
  })

  it('purges after the retention but keeps the span, so history stays hidden', async () => {
    const store = newStore(180 * DAY)
    record(store, self, [t0, t0 + 1000])
    const id = store.binRecorded(self, undefined, t0, t0 + DAY, false).id!
    store.prune(Infinity, self, t0 + 100 * DAY)
    expect(store.binEntries().map((entry) => entry.id)).toEqual([id])
    store.prune(Infinity, self, t0 + 182 * DAY)
    expect(store.binEntries()).toEqual([])
    expect(store.restoreFromBin(id)).toBe('missing')
    expect(store.deletedSpans()).toEqual([{ context: self, to: t0 }])
    expect(await timesOf(store, self)).toEqual([t0 + 1000])
    store.close()
  })

  it('never purges with no retention set', () => {
    const store = newStore(0)
    record(store, self, [t0])
    store.binRecorded(self, undefined, t0, t0, false)
    store.prune(Infinity, self, t0 + 1000 * DAY)
    expect(store.binEntries()).toHaveLength(1)
    store.close()
  })

  it('purges one entry on request', () => {
    const store = newStore()
    record(store, self, [t0])
    const id = store.binRecorded(self, undefined, t0, t0, false).id!
    expect(store.purgeFromBin(id)).toBe(true)
    expect(store.purgeFromBin(id)).toBe(false)
    expect(store.binEntries()).toEqual([])
    expect(store.deletedSpans()).toHaveLength(1)
    store.close()
  })
})

describe('recycle bin: imported tracks', () => {
  it('moves a whole import out and restores it as it was', () => {
    const store = newStore()
    store.storeImport(passage())
    const id = store.binImport('imported:a', undefined, t0 + DAY)!
    expect(store.getImport('imported:a')).toBeUndefined()
    expect(store.findImports()).toEqual([])
    expect(store.binEntries()).toEqual([
      {
        id,
        context: other,
        importId: 'imported:a',
        name: 'Race day',
        whole: true,
        deletedAt: t0 + DAY,
        pointCount: 4,
      },
    ])
    expect(store.restoreFromBin(id)).toBe('restored')
    expect(store.getImport('imported:a')).toEqual(passage())
    // An import is not a recording, so history has nothing to hide for it.
    expect(store.deletedSpans()).toEqual([])
    store.close()
  })

  it('answers undefined for an import that is not there', () => {
    const store = newStore()
    expect(store.binImport('imported:missing', undefined, t0)).toBeUndefined()
    expect(store.binEntries()).toEqual([])
    store.close()
  })

  it('leaves no entry for a span that holds none of its points', () => {
    const store = newStore()
    store.storeImport(passage())
    expect(store.binImport('imported:a', { from: t0 + 10_000 }, t0 + DAY)).toBeUndefined()
    expect(store.binEntries()).toEqual([])
    expect(store.getImport('imported:a')).toEqual(passage())
    store.close()
  })

  it('moves a span of an import and puts its points back in their segments', () => {
    const store = newStore()
    store.storeImport(passage())
    const id = store.binImport('imported:a', { from: t0 + 1000, to: t0 + 2000 }, t0 + DAY)!
    expect(store.getImport('imported:a')?.segments).toEqual([
      [{ position: [60, 24], timestamp: t0 }],
      [{ position: [60.3, 24.3], timestamp: t0 + 3000 }],
    ])
    expect(store.restoreFromBin(id)).toBe('restored')
    expect(store.getImport('imported:a')).toEqual(passage())
    store.close()
  })

  it('takes the whole import when a span leaves it no points', () => {
    const store = newStore()
    store.storeImport(passage())
    const id = store.binImport('imported:a', { from: t0 }, t0 + DAY)!
    expect(store.getImport('imported:a')).toBeUndefined()
    expect(store.binEntries()).toMatchObject([{ id, whole: true, pointCount: 4 }])
    expect(store.binEntries()[0]).not.toHaveProperty('from')
    expect(store.restoreFromBin(id)).toBe('restored')
    expect(store.getImport('imported:a')).toEqual(passage())
    store.close()
  })

  it('will not restore a span into an import that is itself in the bin', () => {
    const store = newStore()
    store.storeImport(passage())
    const span = store.binImport('imported:a', { from: t0 + 2000 }, t0 + DAY)!
    const whole = store.binImport('imported:a', undefined, t0 + DAY)!
    expect(store.restoreFromBin(span)).toBe('conflict')
    expect(store.restoreFromBin(whole)).toBe('restored')
    expect(store.restoreFromBin(span)).toBe('restored')
    expect(store.getImport('imported:a')).toEqual(passage())
    store.close()
  })

  it('purges a whole import with the spans deleted from it earlier', () => {
    const store = newStore(DAY)
    store.storeImport(passage())
    store.binImport('imported:a', { from: t0 + 2000 }, t0 + 10 * DAY)
    store.binImport('imported:a', undefined, t0)
    store.prune(Infinity, self, t0 + 2 * DAY)
    expect(store.binEntries()).toEqual([])
    // Reusing the id proves no point outlived its track.
    store.storeImport({ ...passage(), segments: [[{ position: [1, 1], timestamp: t0 }]] })
    expect(store.getImport('imported:a')?.segments).toEqual([[{ position: [1, 1], timestamp: t0 }]])
    store.close()
  })
})
