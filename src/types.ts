export type Context = string

export type LatLngTuple = [number, number]
export type LngLatTuple = [number, number]

/**
 * A track point with the time it was recorded, in epoch milliseconds.
 *
 * Positions are stored as bare `LatLngTuple`s on the wire and in the public
 * `track` observable; timestamps are kept alongside so time-window queries
 * (`from`/`to`/`duration`) can slice a track without changing that shape.
 */
export interface TimedPosition {
  position: LatLngTuple
  timestamp: number
  /**
   * The longest pause in the recording between the point before this one and
   * this one, set where thinning dropped the points in between. Without it,
   * the time between the two is itself the recorded step.
   */
  pauseBefore?: number
  /**
   * The stretch of time this point stands for, when it is a history
   * provider's bucket rather than a fix. The fixes it summarises can lie
   * anywhere in that stretch.
   */
  span?: number
  /**
   * Starts a new line here whatever the time since the point before: the
   * track left a clipping box between the two and came back.
   */
  breakBefore?: boolean
}

/**
 * A point of an imported track. `timestamp` is absent when the import carried
 * no times: a GPX without `<time>` is a shape someone sailed, not a recording.
 */
export interface ImportedPoint {
  position: LatLngTuple
  timestamp?: number
}

/**
 * A track a client supplied, kept apart from recorded positions.
 *
 * It belongs to whoever imported it rather than to the recording: it is never
 * merged into a vessel's recorded track or aged out by retention, and it
 * stays until it is deleted by its id.
 */
export interface ImportedTrack {
  id: string
  /** The vessel it belongs to, when the import named one. */
  context?: Context
  /** The track's own name, such as a GPX `<trk><name>`. */
  name?: string
  /** The client's other properties, returned as they were posted. */
  metadata: Record<string, unknown>
  /** Segments as posted; a point is either timed throughout or not at all. */
  segments: ImportedPoint[][]
}

/** An imported track as a store gives it back. */
export interface StoredImport extends ImportedTrack {
  /** When the store kept it, in ms since the epoch. */
  importedAt: number
}

/** Which imported tracks a query can see. Every field narrows; none means all. */
export interface ImportFilter {
  /** Only imports naming one of these contexts; contextless ones drop out. */
  contexts?: Context[]
  /**
   * Only timed imports whose time span overlaps the window; untimed ones drop
   * out. Like `bbox`, a match on the extent rather than on the points.
   */
  window?: TimeWindow
  /**
   * Only imports whose extent overlaps the box. A coarse match on the extent:
   * an import can overlap without a point inside, so callers that need a
   * point inside test the points themselves.
   */
  bbox?: GeoBounds
}

/**
 * The positions recorded or imported between two instants, both inclusive. An
 * absent `from` reaches back to the start of the track.
 */
export interface DeletedSpan {
  from?: number
  to: number
}

/** How far the import of a vessel's track from a history provider got; see historyImport.ts. */
export interface HistoryImportState {
  context: Context
  /** When the import was started: history is read up to here, and live recording covers the rest. */
  startedAt: number
  /** Start of the first day history holds, once found. */
  firstDay?: number
  /** Where the next day to read starts. */
  nextDay?: number
  /** Positions written into the recording. */
  filled: number
  /** Whether `nextDay` starts inside a stretch the day before was filling. */
  inGap?: boolean
  finishedAt?: number
  /** Why the import stopped before it finished; asked again, it goes on from `nextDay`. */
  error?: string
}

/**
 * What an import does where the vessel's recording already holds positions.
 * `keep` leaves them alone and fills only the stretches with nothing; `replace`
 * puts the import in their place, sending them to the recycle bin.
 */
export type OnOverlap = 'keep' | 'replace'

/** A start tag as the file wrote it: its qualified name and attributes, namespace declarations included. */
export interface OpenTag {
  name: string
  attributes: [string, string][]
}

/**
 * Where reading an uploaded GPX file can start again: a byte between two
 * elements of GPX's own structure, and what is open there.
 */
export interface UploadCheckpoint {
  /** Byte of the file to read on from. */
  offset: number
  /** The `<gpx>`, `<trk>` and `<trkseg>` open there, outermost first. */
  open: OpenTag[]
  /** Inside a `<trk>`, its name, or null while it has none yet. */
  track?: string | null
  /** How many `<trkseg>` the file opened before the offset. */
  segments: number
}

/**
 * A GPX file uploaded in slices into the own vessel's recording; see
 * gpxUpload.ts. Saved with each slice's points, so a restart goes on from
 * `checkpoint`.
 */
/** From and to, both included, in milliseconds. */
export type Span = [from: number, to: number]

export interface GpxUploadState {
  id: string
  filename: string
  /** The file's size in bytes, as the client announced it. */
  size: number
  context: Context
  /** Names of the file's tracks to import, `''` for one without a name. */
  tracks: string[]
  onOverlap: OnOverlap
  /** Tells the file from another of the same name and size, as the client reckons it; see public/upload.js. */
  fingerprint?: string
  /** Whether a replaced span keeps its recycle bin entry where nothing was recorded; see `keepTrack`. */
  keepEmpty: boolean
  state: 'receiving' | 'finished' | 'aborted' | 'failed'
  error?: string
  checkpoint: UploadCheckpoint
  /** The number of the last `<trkseg>` points were written from. */
  lastSegment?: number
  /**
   * With `keep`, the spans of what that segment filled so far: the slices
   * after judge it against the recording without them, as a whole upload
   * judges a segment without its own points.
   */
  filled?: Span[]
  /**
   * With `replace`, the spans already replaced, merged: binning only outside
   * them keeps a segment from binning what another segment of the upload wrote.
   */
  replaced?: Span[]
  /** With `replace`, that segment's span so far, and its recycle bin entry when one was made. */
  binned?: { id?: number; from: number; to: number }
  /**
   * The days the last slice wrote simplified (see `simplifyUnrecorded`), with
   * how many positions the upload has written of each: a day the next slice
   * goes on with is simplified as well while it holds no others.
   */
  simplifiedDays?: [day: number, positions: number][]
  /** Points written into the recording. */
  imported: number
  /** Points left out because the recording already had positions there. */
  overlapping: number
  /** Points of the chosen tracks without a usable time, which a recording cannot place. */
  untimed: number
  startedAt: number
  updatedAt: number
}

/**
 * The points of one `<trkseg>` that a slice brought, sorted by time.
 * `continues` says the segment's points began in an earlier slice.
 */
export interface UploadPart {
  segment: number
  points: TimedPosition[]
  continues: boolean
}

/** A recorded vessel's deleted span, which the history import leaves out as well. */
export interface RecordedSpan extends DeletedSpan {
  context: Context
}

/**
 * One delete waiting in the recycle bin: a span of a vessel's recording, a
 * span of an imported track, or a whole imported track (`whole`, no span).
 */
export interface BinEntry {
  id: number
  /** The recorded vessel, or the vessel an import names. */
  context?: Context
  importId?: string
  /** An import's own name. */
  name?: string
  whole: boolean
  from?: number
  to?: number
  deletedAt: number
  /** Points held in the bin for this entry. */
  pointCount: number
}

/** What restoring a recycle bin entry came to. */
export type RestoreResult = 'restored' | 'missing' | 'conflict'

/**
 * A time window in epoch milliseconds, half-open as `[from, to)`.
 *
 * Half-open so the bands a client requests to cover a long trail tile exactly:
 * `[now-24h, now-1h)` and `[now-1h, now]` share the boundary point without
 * returning it twice. `inclusiveEnd` closes the final band so the newest fix is
 * not dropped from a "last hour" query.
 */
export interface TimeWindow {
  from: number
  to: number
  inclusiveEnd?: boolean
}

/**
 * A recorded track in a window as a listing describes it: how many points,
 * when it starts and ends, and where it lies, without the points themselves.
 */
/** The times of a track's first and last position, in ms. */
export interface TimeExtent {
  first: number
  last: number
}

export interface TrackSummary {
  context: Context
  pointCount: number
  first: number
  last: number
  /** `[west, south, east, north]`, as `longitudeSpan()` sets it across the antimeridian. */
  bbox: [number, number, number, number]
}

export interface Position {
  latitude: number
  longitude: number
}

export interface TrackCollection {
  [key: string]: LatLngTuple[]
}

/** As `TrackCollection`, but each point keeps the time it was recorded. */
export interface TimedTrackCollection {
  [key: string]: TimedPosition[]
}

export interface GeoBounds {
  ne: LatLngTuple
  sw: LatLngTuple
}

/**
 * Express `req.query` shape: a value may be absent, a single string, or repeated
 * into an array when the same key appears more than once in the query string.
 */
export type QueryParameters = Record<string, unknown>

export interface TrackParams {
  bbox: GeoBounds | null
  radius: number | null
  /**
   * Match a track on *any* position rather than its last.
   *
   * The v1 routes answer "vessels near here now", so they match the last
   * position — a vessel that has left is no longer near. The v2 Track API asks
   * a different question, "tracks that passed through this box within the
   * window", and its contract says a vessel that crossed an hour ago and has
   * since left still matches. Same filter, two questions.
   */
  intersects?: boolean
  /**
   * Only these contexts, fully qualified; absent for every context. A store
   * reads nothing for the others, so asking for one vessel does not cost a
   * read of every track it holds.
   */
  contexts?: Context[]
  /**
   * The caller clips each track to `bbox`, so a store need read only the
   * stretches near the box rather than every position in the window. A read
   * narrowing, not a filter: a store may ignore it and return whole tracks.
   */
  clip?: boolean
}

export interface Debug {
  (...args: unknown[]): void
  enabled: boolean
}
