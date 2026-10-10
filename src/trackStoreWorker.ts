import { parentPort, workerData } from 'node:worker_threads'
import { SelfPositionUnavailableError } from './utils.js'
import { SqliteTrackStore, TransactionStateError } from './sqliteStore.js'
import type { SqliteStoreConfig } from './sqliteStore.js'
import type { Debug } from './types.js'
import type { Operation, WorkerMessage } from './trackStoreProtocol.js'

if (!parentPort) throw new Error('Track store must run in a worker')
const port = parentPort
const config = workerData as { config: SqliteStoreConfig; debugEnabled: boolean }
const send = (message: WorkerMessage): void => port.postMessage(message)
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
  'binImport',
  'restoreFromBin',
  'purgeFromBin',
])
function acknowledge(operation: Operation, target: SqliteTrackStore): unknown {
  switch (operation.method) {
    case 'storeImport':
      return target.storeImport(...operation.args)
    case 'binRecorded':
      return target.binRecorded(...operation.args)
    case 'binImport':
      return target.binImport(...operation.args)
    case 'restoreFromBin':
      return target.restoreFromBin(...operation.args)
    case 'purgeFromBin':
      return target.purgeFromBin(...operation.args)
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
                value = await target.get(...operation.args)
                break
              case 'getTimed':
                value = await target.getTimed(...operation.args)
                break
              case 'getAllTracks':
                value = await target.getAllTracks(...operation.args)
                break
              case 'getFilteredTracks':
                value = await target.getFilteredTracks(operation.args[0], operation.args[1], debug, operation.args[3])
                break
              case 'getFilteredTimedTracks':
                value = await target.getFilteredTimedTracks(
                  operation.args[0],
                  operation.args[1],
                  debug,
                  operation.args[3],
                )
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
              default:
                throw new Error('Unknown track operation')
            }
            results.push({ id: operation.id, value })
          } catch (error) {
            results.push({
              id: operation.id,
              error: errorText(error),
              selfPositionUnavailable: error instanceof SelfPositionUnavailableError,
            })
          }
        }
      }
      send({ kind: 'result', results })
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
