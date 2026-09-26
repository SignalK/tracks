import type { SqliteTrackStore } from './sqliteStore.js'

export type StoreMethod =
  | 'newPosition'
  | 'recordName'
  | 'initialTrack'
  | 'prune'
  | 'get'
  | 'getTimed'
  | 'getAllTracks'
  | 'getFilteredTracks'
  | 'getFilteredTimedTracks'
  | 'close'
export type Operation = {
  [K in StoreMethod]: { id: number; method: K; args: Parameters<SqliteTrackStore[K]> }
}[StoreMethod]
export interface StoredName {
  context: string
  name: string
  timestamp: number
}
export type WorkerMessage =
  | { kind: 'ready'; names: StoredName[] }
  | { kind: 'debug'; text: string }
  | { kind: 'fatal'; error: string }
  | {
      kind: 'result'
      results: {
        id: number
        value?: unknown
        error?: string
        selfPositionUnavailable?: boolean
        name?: { context: string; value: string | undefined }
        names?: string[]
      }[]
    }
