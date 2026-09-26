import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AsyncTrackStore } from './asyncTrackStore.js'
import { SqliteTrackStore } from './sqliteStore.js'
import type { Debug, LatLngTuple } from './types.js'

const debug: Debug = Object.assign(() => undefined, { enabled: false })
let dir: string
const open: AsyncTrackStore[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracks-worker-'))
})
afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((store) => store.close()))
  rmSync(dir, { recursive: true, force: true })
})
const create = (onError: (error: Error) => void = () => {}, limits = {}) => {
  const store = new AsyncTrackStore({ file: join(dir, 'tracks.db'), resolution: 0 }, debug, onError, limits)
  open.push(store)
  return store
}

describe('worker-owned SQLite', () => {
  it('preserves FIFO, copies coordinates, captures arrival time and drains on close', async () => {
    const store = create()
    const position: LatLngTuple = [60, 24]
    const before = Date.now()
    store.newPosition('self', position)
    position[0] = 0
    store.recordName('self', ' Vessel ', 100)
    store.recordName('self', 'Older', 50)
    const points = await store.getTimed('self')
    expect(points[0]?.position).toEqual([60, 24])
    expect(points[0]?.timestamp).toBeGreaterThanOrEqual(before)
    expect(points[0]?.timestamp).toBeLessThanOrEqual(Date.now())
    store.newPosition('self', [61, 25], Date.now() + 1)
    await store.close()
    const reopened = create()
    await reopened.ready
    expect(reopened.nameFor('self')).toBe('Vessel')
    expect(await reopened.get('self')).toEqual([
      [60, 24],
      [61, 25],
    ])
  })

  it('matches existing query, window and spatial semantics', async () => {
    const original = new SqliteTrackStore({ file: join(dir, 'baseline.db'), resolution: 0 }, debug)
    const worker = create()
    try {
      for (const store of [original, worker]) {
        store.initialTrack(
          'self',
          [
            [60, 24],
            [60.1, 24.1],
            [60.2, 24.2],
          ],
          [100, 200, 300],
        )
        store.newPosition('other', [10, 20], 200)
        store.initialTrack('replaced', [[1, 2]], [100])
        store.initialTrack('replaced', [[3, 4]], [200])
      }
      expect(await worker.getAllTracks()).toEqual(await original.getAllTracks())
      expect(await worker.getTimed('self', { from: 100, to: 300 })).toEqual(
        await original.getTimed('self', { from: 100, to: 300 }),
      )
      for (const intersects of [true, false]) {
        const params = {
          bbox: { sw: [60.05, 24.05] as LatLngTuple, ne: [60.15, 24.15] as LatLngTuple },
          radius: null,
          intersects,
        }
        expect(await worker.getFilteredTimedTracks(params)).toEqual(await original.getFilteredTimedTracks(params))
      }
      await expect(worker.get('unknown')).rejects.toThrow('No track')
      expect(await worker.get('replaced')).toEqual([[3, 4]])
    } finally {
      original.close()
    }
  })

  it('keeps HTTP responsive while the writer waits for a database lock', async () => {
    const store = create()
    await store.ready
    const lock = new DatabaseSync(join(dir, 'tracks.db'))
    const server = createServer((_request, response) => response.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    lock.exec('BEGIN IMMEDIATE')
    let released = false
    const release = () => {
      if (!released) {
        released = true
        lock.exec('ROLLBACK')
      }
    }
    const timer = setTimeout(release, 1500)
    try {
      const started = performance.now()
      store.newPosition('self', [60, 24], 100)
      const read = store.get('self')
      const response = await fetch(`http://127.0.0.1:${address.port}`)
      expect(await response.text()).toBe('ok')
      expect(performance.now() - started).toBeLessThan(1000)
      expect(released).toBe(false)
      release()
      expect(await read).toEqual([[60, 24]])
    } finally {
      clearTimeout(timer)
      release()
      lock.close()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it('bounds overload, reports it once and drains already accepted positions', async () => {
    const errors: Error[] = []
    const store = create((error) => errors.push(error), { maxItems: 2 })
    store.newPosition('self', [60, 24], 100)
    store.newPosition('self', [61, 25], 200)
    store.newPosition('self', [62, 26], 300)
    store.newPosition('self', [63, 27], 400)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/capacity/)
    await store.close()
    expect(await create().get('self')).toEqual([
      [60, 24],
      [61, 25],
    ])
  })

  it('bounds serialized payloads as well as operation count', async () => {
    const errors: Error[] = []
    const store = create((error) => errors.push(error), { maxBytes: 128 })
    store.initialTrack(
      'self',
      Array.from({ length: 100 }, () => [60, 24] as LatLngTuple),
    )
    expect(errors).toHaveLength(1)
    await store.close()
    await expect(create().get('self')).rejects.toThrow('No track')
  })

  it('rolls back a failed write batch and rejects queued reads', async () => {
    const errors: Error[] = []
    const store = create((error) => errors.push(error))
    store.newPosition('self', [60, 24], 100)
    store.newPosition('self', [NaN, 24], 200)
    await expect(store.get('self')).rejects.toThrow()
    await expect(store.close()).rejects.toThrow()
    expect(errors).toHaveLength(1)
    await expect(create().get('self')).rejects.toThrow('No track')
  })

  it('rejects startup failures without an unhandled ready rejection', async () => {
    const errors: Error[] = []
    const store = new AsyncTrackStore({ file: join(dir, 'missing', 'tracks.db') }, debug, (error) => errors.push(error))
    open.push(store)
    await expect(store.ready).rejects.toThrow()
    await expect(store.get('self')).rejects.toThrow()
    await expect(store.close()).rejects.toThrow()
    expect(errors).toHaveLength(1)
  })

  it('fails pending calls if the worker exits unexpectedly', async () => {
    const store = create()
    await store.ready
    // Deliberate worker failure injection, not a production control API.
    const worker = (store as unknown as { worker: Worker }).worker
    const terminated = worker.terminate()
    const read = expect(store.get('self')).rejects.toThrow()
    await terminated
    await read
    await expect(store.close()).rejects.toThrow()
  })

  it('reconciles cached names in commit order when a pruned context returns', async () => {
    const store = create()
    store.newPosition('old', [60, 24], 100)
    store.recordName('old', 'Old name', 1000)
    store.prune(-1)
    store.recordName('old', 'New name', 200)
    store.newPosition('old', [61, 25], 200)
    await store.get('old')
    expect(store.nameFor('old')).toBe('New name')
    await store.close()
    const reopened = create()
    await reopened.ready
    expect(reopened.nameFor('old')).toBe('New name')
  })
})
