import { parentPort, workerData } from 'node:worker_threads'
import { SelfPositionUnavailableError, UnknownContextError } from './utils.js'
import { SqliteTrackStore, TransactionStateError } from './sqliteStore.js'
import type { SqliteStoreConfig } from './sqliteStore.js'
import type { Debug } from './types.js'
import type { Operation, PackedReads, WorkerMessage } from './trackStoreProtocol.js'
import { packPositions, packTimed } from './packedTrack.js'

if (!parentPort) throw new Error('Track store must run in a worker')
const port = parentPort
const config = workerData as { config: SqliteStoreConfig; debugEnabled: boolean }
const send = (message: WorkerMessage, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer)
const debug: Debug = Object.assign(
  (...args: unknown[]) => {
    if (config.debugEnabled) send({ kind: 'debug', text: args.map(String).join(' ') })
  },
  { enabled: config.debugEnabled },
)
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
let store: SqliteTrackStore | undefined
let processing = false
let writeFailure: string | undefined
function fatal(error: unknown): void {
  try {
    store?.close()
  } catch {
    /* Preserve the failure that stopped recording. */
  }
  send({ kind: 'fatal', error: errorText(error) })
  port.close()
}
function mutate(operation: Operation, target: SqliteTrackStore): boolean {
  switch (operation.method) {
    case 'newPosition':
      target.newPosition(...operation.args)
      return true
    case 'recordName':
      target.recordName(...operation.args)
      return true
    case 'initialTrack':
      target.initialTrack(...operation.args)
      return true
    case 'prune':
      target.prune(...operation.args)
      return true
    default:
      return false
  }
}
/** Writes whose caller waits for their own commit: imports and the recycle bin. */
const ACKNOWLEDGED = new Set<Operation['method']>([
  'storeImport',
  'binRecorded',
  'recordTrack',
  'fillTrack',
  'binImport',
  'restoreFromBin',
  'purgeFromBin',
  'saveHistoryImport',
  'saveGpxUpload',
])
function acknowledge(operation: Operation, target: SqliteTrackStore): unknown {
  switch (operation.method) {
    case 'storeImport':
      return target.storeImport(...operation.args)
    case 'binRecorded':
      return target.binRecorded(...operation.args)
    case 'recordTrack':
      return target.recordTrack(...operation.args)
    case 'fillTrack':
      return target.fillTrack(...operation.args)
    case 'binImport':
      return target.binImport(...operation.args)
    case 'restoreFromBin':
      return target.restoreFromBin(...operation.args)
    case 'purgeFromBin':
      return target.purgeFromBin(...operation.args)
    case 'saveHistoryImport':
      return target.saveHistoryImport(...operation.args)
    case 'saveGpxUpload':
      return target.saveGpxUpload(...operation.args)
    default:
      throw new Error('Unknown track operation')
  }
}
const isWrite = (operation: Operation): boolean =>
  ['newPosition', 'recordName', 'initialTrack', 'prune'].includes(operation.method)
try {
  store = new SqliteTrackStore(config.config, debug)
  send({ kind: 'ready', names: store.storedNames() })
} catch (error) {
  fatal(error)
}
if (store) {
  const target = store
  const process = async ({ operations }: { operations: Operation[] }): Promise<void> => {
    if (processing) {
      fatal(new Error('Overlapping track worker batch'))
      return
    }
    processing = true
    const results: Extract<WorkerMessage, { kind: 'result' }>['results'] = []
    const transfer: ArrayBuffer[] = []
    try {
      for (let i = 0; i < operations.length;) {
        const operation = operations[i]!
        if (ACKNOWLEDGED.has(operation.method)) {
          i++
          // Each in a transaction of its own, so a failure answers this caller
          // alone: a track that cannot be kept must not stop the recording.
          if (writeFailure) {
            results.push({ id: operation.id, error: writeFailure })
            continue
          }
          try {
            let value: unknown
            target.transaction(() => {
              value = acknowledge(operation, target)
            })
            results.push({ id: operation.id, value })
          } catch (error) {
            if (error instanceof TransactionStateError) throw error
            results.push({ id: operation.id, error: errorText(error) })
          }
          continue
        }
        if (operation.method === 'refineLevels') {
          i++
          // Housekeeping, in a transaction of its own: a failure takes back
          // what it refined and nothing else, and never stops the recording.
          let more = false
          if (!writeFailure) {
            try {
              target.transaction(() => {
                more = target.refineLevels(...operation.args)
              })
            } catch (error) {
              if (error instanceof TransactionStateError) throw error
              debug(`Refining levels failed: ${errorText(error)}`)
              // Rolled back: the next try waits for the ordinary tick.
              more = false
            }
          }
          results.push({ id: operation.id, value: more })
          continue
        }
        if (isWrite(operation)) {
          const first = i
          while (i < operations.length && isWrite(operations[i]!)) i++
          const writes = operations.slice(first, i)
          const acknowledgements: typeof results = []
          try {
            if (writeFailure) throw new Error(writeFailure)
            target.transaction(() => {
              for (const next of writes) {
                mutate(next, target)
                acknowledgements.push({
                  id: next.id,
                  ...(next.method === 'recordName'
                    ? { name: { context: next.args[0], value: target.nameFor(next.args[0]) } }
                    : {}),
                  ...(next.method === 'prune' ? { names: target.storedNames().map((row) => row.context) } : {}),
                })
              }
            })
            results.push(...acknowledgements)
          } catch (error) {
            if (error instanceof TransactionStateError) throw error
            // Never retry uncertain writes. Keep the database open for reads,
            // which can still succeed on e.g. a full filesystem.
            writeFailure = errorText(error)
            for (const next of writes) results.push({ id: next.id, error: writeFailure, writeFailed: true })
          }
        } else {
          i++
          if (operation.method === 'close') {
            target.close()
            results.push({ id: operation.id })
            send({ kind: 'result', results })
            port.close()
            return
          }
          try {
            let value: unknown
            switch (operation.method) {
              case 'get':
                value = packPositions(await target.get(...operation.args), transfer) satisfies PackedReads['get']
                break
              case 'getTimed':
                value = packTimed(await target.getTimed(...operation.args), transfer) satisfies PackedReads['getTimed']
                break
              case 'getAllTracks':
                value = (await target.getAllTracks(...operation.args)).map(({ context, track }) => ({
                  context,
                  track: packPositions(track, transfer),
                })) satisfies PackedReads['getAllTracks']
                break
              case 'getFilteredTracks': {
                const tracks = await target.getFilteredTracks(
                  operation.args[0],
                  operation.args[1],
                  debug,
                  operation.args[3],
                )
                const packed: PackedReads['getFilteredTracks'] = {}
                for (const [context, track] of Object.entries(tracks)) packed[context] = packPositions(track, transfer)
                value = packed
                break
              }
              case 'getFilteredTimedTracks': {
                const tracks = await target.getFilteredTimedTracks(
                  operation.args[0],
                  operation.args[1],
                  debug,
                  operation.args[3],
                )
                const packed: PackedReads['getFilteredTimedTracks'] = {}
                for (const [context, points] of Object.entries(tracks)) packed[context] = packTimed(points, transfer)
                value = packed
                break
              }
              case 'getFilteredTimedTracksJson': {
                const fragments = await target.getFilteredTimedTracksJson(
                  operation.args[0],
                  operation.args[1],
                  debug,
                  operation.args[3],
                  operation.args[4],
                )
                for (const fragment of Object.values(fragments)) transfer.push(fragment.buffer as ArrayBuffer)
                value = fragments
                break
              }
              case 'summarize':
                value = target.summarize(...operation.args)
                break
              case 'timeExtent':
                value = await target.timeExtent(...operation.args)
                break
              case 'countTimed':
                value = target.countTimed(...operation.args)
                break
              case 'getImport':
                value = target.getImport(...operation.args)
                break
              case 'findImports':
                value = target.findImports(...operation.args)
                break
              case 'binEntries':
                value = target.binEntries()
                break
              case 'deletedSpans':
                value = target.deletedSpans()
                break
              case 'historyImport':
                value = target.historyImport(...operation.args)
                break
              case 'gpxUpload':
                value = target.gpxUpload()
                break
              default:
                throw new Error('Unknown track operation')
            }
            results.push({ id: operation.id, value })
          } catch (error) {
            results.push({
              id: operation.id,
              error: errorText(error),
              selfPositionUnavailable: error instanceof SelfPositionUnavailableError,
              unknownContext: error instanceof UnknownContextError,
            })
          }
        }
      }
      send({ kind: 'result', results }, transfer)
    } catch (error) {
      fatal(error)
    } finally {
      processing = false
    }
  }
  port.on('message', (message: { operations: Operation[] }) => {
    void process(message).catch(fatal)
  })
}
