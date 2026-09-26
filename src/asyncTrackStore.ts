import { SelfPositionUnavailableError } from './utils.js'
import { Worker } from 'node:worker_threads'
import type { TrackStore } from './store.js'
import type { SqliteTrackStore, SqliteStoreConfig } from './sqliteStore.js'
import type { Debug, Context, LatLngTuple, TimeWindow, TrackParams } from './types.js'
import type { TrackQuery } from './timeWindow.js'
import type { Operation, StoreMethod, WorkerMessage } from './trackStoreProtocol.js'
interface Pending {
  operation: Operation
  bytes: number
  resolve?: (value: unknown) => void
  reject?: (error: Error) => void
}
interface Limits {
  maxItems?: number
  maxBytes?: number
}

/** One database owner; the server never waits synchronously for storage. */
export class AsyncTrackStore implements TrackStore {
  private queue: Pending[]
  private active: Pending[]
  private names: Map<string, string>
  private sequence: number
  private pendingBytes: number
  private maxItems: number
  private maxBytes: number
  private onError: (error: Error) => void
  private debug: Debug
  private initialized: boolean
  private closing: boolean
  private failed: boolean
  private statusError: string | undefined
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private worker: Worker
  private exited: Promise<void>
  private closeAcknowledged = false
  private scheduled = false
  private closePromise: Promise<void> | undefined

  constructor(
    config: SqliteStoreConfig,
    debug: Debug,
    onError: (error: Error) => void = () => {},
    limits: Limits = {},
  ) {
    this.queue = []
    this.active = []
    this.names = new Map()
    this.sequence = 0
    this.pendingBytes = 0
    this.maxItems = limits.maxItems ?? 10000
    this.maxBytes = limits.maxBytes ?? 8 * 1024 * 1024
    this.onError = onError
    this.debug = debug
    this.initialized = false
    this.closing = false
    this.failed = false
    this.statusError = undefined
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // A startup failure must be reported even if nobody is awaiting a query.
    this.ready.catch(() => {})
    // Tests run the same built worker that the published package ships.
    const workerUrl = new URL(/* @vite-ignore */ '../dist/trackStoreWorker.js', import.meta.url)
    this.worker = new Worker(workerUrl, {
      workerData: { config, debugEnabled: Boolean(debug?.enabled) },
    })
    this.worker.on('message', (message: WorkerMessage) => this.receive(message))
    this.worker.on('error', (error: Error) => this.fail(error))
    this.exited = new Promise((resolve) =>
      this.worker.on('exit', (code) => {
        if (!this.closeAcknowledged && !this.failed)
          this.fail(new Error('Track worker exited before draining (code ' + code + ')'))
        resolve()
      }),
    )
  }

  private report(error: Error): void {
    if (!this.statusError) {
      this.statusError = 'Track storage error: ' + error.message
      this.onError(error)
    }
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = true
    this.report(error)
    this.rejectReady(error)
    for (const item of [...this.active, ...this.queue]) item.reject?.(error)
    this.active = []
    this.queue = []
    this.pendingBytes = 0
  }

  private enqueue<K extends StoreMethod>(
    method: K,
    args: Parameters<SqliteTrackStore[K]>,
    write = false,
  ): Promise<Awaited<ReturnType<SqliteTrackStore[K]>>> {
    if (this.failed || (this.closing && method !== 'close') || (write && this.statusError)) {
      const error = new Error(this.statusError ?? 'Track store is closing')
      return write ? Promise.resolve(undefined as Awaited<ReturnType<SqliteTrackStore[K]>>) : Promise.reject(error)
    }
    // Copy at admission: a caller must not mutate an accepted position later.
    let copy: Parameters<SqliteTrackStore[K]>, bytes: number
    try {
      copy = structuredClone(args)
      bytes = Buffer.byteLength(JSON.stringify(copy))
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (write) {
        this.report(failure)
        return Promise.resolve(undefined as Awaited<ReturnType<SqliteTrackStore[K]>>)
      }
      return Promise.reject(failure)
    }
    if (
      method !== 'close' &&
      (this.queue.length + this.active.length >= this.maxItems || this.pendingBytes + bytes > this.maxBytes)
    ) {
      const error = new Error(
        'Track queue capacity exceeded; recording paused. Accepted writes will drain; restart the plugin after storage recovers.',
      )
      if (write) this.report(error)
      return write ? Promise.resolve(undefined as Awaited<ReturnType<SqliteTrackStore[K]>>) : Promise.reject(error)
    }
    const item: Pending = { operation: { id: ++this.sequence, method, args: copy } as Operation, bytes }
    this.pendingBytes += bytes
    const result = write
      ? Promise.resolve(undefined)
      : new Promise<unknown>((resolve, reject) => Object.assign(item, { resolve, reject }))
    this.queue.push(item)
    this.schedule()
    return result as Promise<Awaited<ReturnType<SqliteTrackStore[K]>>>
  }

  private schedule(): void {
    if (this.scheduled || !this.initialized || this.active.length || this.failed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private pump(): void {
    if (this.failed || this.active.length || !this.queue.length) return
    this.active = this.queue.splice(0, 128)
    try {
      this.worker.postMessage({ operations: this.active.map(({ operation }) => operation) })
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      void this.worker.terminate()
    }
  }

  private receive(message: WorkerMessage): void {
    if (message.kind === 'debug') {
      this.debug?.(message.text)
      return
    }
    if (message.kind === 'fatal') {
      this.fail(new Error(message.error))
      return
    }
    if (message.kind === 'ready') {
      for (const { context, name } of message.names) this.names.set(context, name)
      this.initialized = true
      this.resolveReady()
      this.schedule()
      return
    }
    if (message.kind !== 'result' || this.failed) return
    const items = this.active
    if (
      message.results.length !== items.length ||
      items.some((item, index) => message.results[index]?.id !== item.operation.id)
    ) {
      this.fail(new Error('Invalid track worker response'))
      void this.worker.terminate()
      return
    }
    this.active = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!,
        result = message.results[i]
      this.pendingBytes -= item.bytes
      if (!result) continue
      if (result.error)
        item.reject?.(
          result.selfPositionUnavailable ? new SelfPositionUnavailableError(result.error) : new Error(result.error),
        )
      else {
        if (item.operation.method === 'prune') {
          const remaining = new Set(result.names ?? [])
          for (const context of this.names.keys()) if (!remaining.has(context)) this.names.delete(context)
        }
        if (result.name) {
          if (result.name.value === undefined) this.names.delete(result.name.context)
          else this.names.set(result.name.context, result.name.value)
        }
        if (item.operation.method === 'close') this.closeAcknowledged = true
        item.resolve?.(result.value)
      }
    }
    this.schedule()
  }

  newPosition(context: Context, position: LatLngTuple, timestamp = Date.now()): void {
    void this.enqueue('newPosition', [context, position, timestamp], true)
  }
  recordName(context: Context, name: string, timestamp = Date.now()): void {
    void this.enqueue('recordName', [context, name, timestamp], true)
  }
  nameFor(context: Context): string | undefined {
    return this.names.get(context)
  }
  initialTrack(context: Context, track: LatLngTuple[], timestamps?: number[]): void {
    void this.enqueue('initialTrack', [context, track, timestamps], true)
  }
  prune(maxAge: number, keep?: Context): void {
    void this.enqueue('prune', [maxAge, keep], true)
  }
  get(context: Context, window?: TimeWindow) {
    return this.enqueue('get', [context, window])
  }
  getTimed(context: Context, window?: TimeWindow) {
    return this.enqueue('getTimed', [context, window])
  }
  getAllTracks(query?: TrackQuery) {
    return this.enqueue('getAllTracks', [query])
  }
  getFilteredTracks(params: TrackParams, selfPosition?: LatLngTuple, _debug?: Debug, query?: TrackQuery) {
    return this.enqueue('getFilteredTracks', [params, selfPosition, undefined, query])
  }
  getFilteredTimedTracks(params: TrackParams, selfPosition?: LatLngTuple, _debug?: Debug, query?: TrackQuery) {
    return this.enqueue('getFilteredTimedTracks', [params, selfPosition, undefined, query])
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true
      this.closePromise = this.enqueue('close', []).then(
        () => this.exited,
        async (error: unknown) => {
          await this.exited
          throw error
        },
      )
      this.closePromise.catch(() => {})
    }
    return this.closePromise
  }
}
