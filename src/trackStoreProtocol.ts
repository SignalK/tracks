import type { PackedTimedTrack, PackedTrack } from './packedTrack.js'
import type { SqliteTrackStore } from './sqliteStore.js'

export type StoreMethod =
  | 'newPosition'
  | 'recordName'
  | 'initialTrack'
  | 'prune'
  | 'refineLevels'
  | 'get'
  | 'getTimed'
  | 'getAllTracks'
  | 'getFilteredTracks'
  | 'getFilteredTimedTracks'
  | 'summarize'
  | 'timeExtent'
  | 'countTimed'
  | 'storeImport'
  | 'getImport'
  | 'findImports'
  | 'binRecorded'
  | 'recordTrack'
  | 'fillTrack'
  | 'binImport'
  | 'restoreFromBin'
  | 'purgeFromBin'
  | 'binEntries'
  | 'deletedSpans'
  | 'historyImport'
  | 'saveHistoryImport'
  | 'gpxUpload'
  | 'saveGpxUpload'
  | 'close'
export type Operation = {
  [K in StoreMethod]: { id: number; method: K; args: Parameters<SqliteTrackStore[K]> }
}[StoreMethod]
/** What the worker answers the reads that return positions with, in place of the store's answer. */
export interface PackedReads {
  get: PackedTrack
  getTimed: PackedTimedTrack
  getAllTracks: { context: string; track: PackedTrack }[]
  getFilteredTracks: Record<string, PackedTrack>
  getFilteredTimedTracks: Record<string, PackedTimedTrack>
}
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
        writeFailed?: boolean
        selfPositionUnavailable?: boolean
        unknownContext?: boolean
        name?: { context: string; value: string | undefined }
        names?: string[]
      }[]
    }
