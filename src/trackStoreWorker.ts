import { parentPort, workerData } from 'node:worker_threads'
import { SelfPositionUnavailableError } from './utils.js'
import { SqliteTrackStore } from './sqliteStore.js'
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
        if (isWrite(operation)) {
          // Commit adjacent waiting writes together, without delaying admission or thinning samples.
          target.transaction(() => {
            while (i < operations.length && isWrite(operations[i]!)) {
              const next = operations[i++]!
              mutate(next, target)
              results.push({
                id: next.id,
                ...(next.method === 'recordName'
                  ? { name: { context: next.args[0], value: target.nameFor(next.args[0]) } }
                  : {}),
                ...(next.method === 'prune' ? { names: target.storedNames().map((row) => row.context) } : {}),
              })
            }
          })
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
