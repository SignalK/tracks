/**
 * What the routes the page reads answer, as JSON. Types only: nothing here
 * reaches the built page.
 *
 * The page checks the shape of every answer it uses, since a proxy or an
 * older server can answer something else; these say what a well-formed one
 * holds.
 */
import type { TrackProperties } from '../../src/trackApi.js'

export type { GpxUploadStatus } from '../../src/types.js'

/** A listed track: the Track API's properties, with the provider the server names it by. */
export interface ListedTrack extends TrackProperties {
  providerId?: string | undefined
}

/** What a track's label is made of; see `trackLabel()` on the server. */
export type Labelled = Pick<TrackProperties, 'context' | 'contextName' | 'isSelf'>

/** A recycle bin entry, as `GET /plugins/tracks/recycle-bin` lists it. */
export interface BinEntryJson extends Labelled {
  id: number
  trackId: string
  kind: 'recorded' | 'imported'
  name?: string
  whole: boolean
  from?: string
  to?: string
  deletedAt: string
  purgeAt: string
  pointCount: number
}

/** The history import's state, as `GET /plugins/tracks/history-import` answers it. */
export interface HistoryImportJson {
  running: boolean
  startedAt: string
  firstDay?: string
  nextDay?: string
  filled: number
  finishedAt?: string
  error?: string
}

/** `GET /plugins/tracks/history-import`: whether a history provider is installed, and the import's state. */
export interface HistoryImportAnswer {
  provider?: boolean
  state?: HistoryImportJson
}

/** What `POST /plugins/tracks/imports` stored. */
export interface ImportAnswer {
  ids: string[]
  skippedPoints: number
  overlappingPoints?: number
  expiredPoints?: number
}

/** `GET /plugins/tracks/settings`. */
export interface SettingsAnswer {
  aisRetentionDays?: number
  recordOtherVessels?: boolean
}

/** What a refusing route says, under either name the routes use. */
export interface Refusal {
  message?: string
  error?: string
}
