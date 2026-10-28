import {
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { s2, geojson } from 's2js'
import { knotsBetween } from './glitchFilter.js'
import type { Fix } from './glitchFilter.js'
import { outsideSpans } from './recycleBin.js'
import { significance } from './simplify.js'
import { keeps, thin, Thinner } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import type { TrackStore } from './store.js'
import {
  createInBounds,
  createMatcher,
  fillGaps,
  longitudeSpan,
  longitudeSpanOf,
  mergeSpan,
  MIN_FILLED_GAP_MS,
  splitAtAntimeridian,
  subtractSpans,
  UnknownContextError,
  withinSpans,
} from './utils.js'
import type { LongitudeExtremes } from './utils.js'
import type {
  BinEntry,
  Context,
  Debug,
  GeoBounds,
  GpxUploadState,
  HistoryImportState,
  ImportedPoint,
  ImportedTrack,
  StoredImport,
  ImportFilter,
  LatLngTuple,
  RecordedSpan,
  RestoreResult,
  Span,
  TimedPosition,
  TimedTrackCollection,
  TimeExtent,
  TimeWindow,
  TrackCollection,
  TrackParams,
  TrackSummary,
  UploadPart,
} from './types.js'

export class TransactionStateError extends Error {}

const toTimed = ({ lat, lon, timestamp }: PositionRow): TimedPosition => ({
  position: [lat, lon],
  timestamp,
})

/**
 * Sorted times grouped into `[first, last]` stretches, split where two lie
 * more than `gap` apart, or the gap it gives for the two.
 */
const stretchesOf = (times: number[], gap: number | ((last: number, time: number) => number)): [number, number][] => {
  const stretches: [number, number][] = []
  for (const time of times) {
    const current = stretches[stretches.length - 1]
    if (current && time - current[1] <= (typeof gap === 'number' ? gap : gap(current[1], time))) {
      current[1] = time
    } else {
      stretches.push([time, time])
    }
  }
  return stretches
}

/**
 * S2 cell ids are unsigned 64-bit; SQLite's INTEGER is signed 64-bit, and
 * node:sqlite refuses to bind a bigint above INT64_MAX outright:
 *
 *   TypeError: BigInt value is too large to bind
 *
 * Reinterpreting the same bits as signed is lossless in both directions, which
 * casting to Number is not — a real cell id is far above Number's 2^53 exact
 * range and comes back off by one.
 */
const toSigned = (id: bigint): bigint => BigInt.asIntN(64, id)
const toUnsigned = (id: bigint): bigint => BigInt.asUintN(64, id)

/** Inclusive id range covering every cell contained by `cellId`. */
const cellRange = (cellId: bigint): { start: bigint; end: bigint } => {
  if (cellId === 0n) {
    return { start: 0n, end: 2n }
  }
  let lsb = 0n
  let temp = cellId
  while ((temp & 1n) === 0n) {
    temp >>= 1n
    lsb++
  }
  return {
    start: cellId & (cellId - 1n),
    end: cellId | (1n << (lsb + 1n)) | ((1n << lsb) - 1n),
  }
}

const cellIdFor = ([lat, lng]: LatLngTuple): bigint => s2.cellid.fromLatLng(s2.LatLng.fromDegrees(lat, lng))

/**
 * Cover a bounds with S2 cells, splitting it at the antimeridian first.
 *
 * maxCells is a deliberate trade: a coarse covering is a superset of the box,
 * so every query post-filters by exact bounds anyway. Asking for more cells
 * buys a tighter prefilter at the cost of a longer WHERE clause.
 */
const coveringFor = (bounds: GeoBounds, maxCells: number): bigint[] => {
  const coverer = new geojson.RegionCoverer({ maxLevel: 30, maxCells })
  return splitAtAntimeridian(bounds).flatMap(({ sw, ne }) => {
    const [south, west] = sw
    const [north, east] = ne
    return coverer.covering({
      type: 'Polygon',
      coordinates: [
        [
          [west, south],
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      ],
    })
  })
}

interface PositionRow {
  timestamp: number
  lat: number
  lon: number
}

/** A row read for more than one context, with the id of its own. */
interface ContextRow extends PositionRow {
  context_id: number
}

/** A row with its rowid, which tells apart two fixes sharing a timestamp. */
interface NumberedRow extends PositionRow {
  id: number
  /** Read apart from the row before it, with what lay between left out. */
  breakBefore?: boolean
}

interface BinRow {
  id: number
  context: string | null
  import_id: string | null
  name: string | null
  whole: number
  span_from: number | null
  span_to: number | null
  deleted_at: number
  purged: number
}

interface ImportedRow {
  id: string
  context: string | null
  name: string | null
  metadata: string
  imported_at: number
  west: number
  east: number
}

const SELECT_IMPORTS = 'SELECT * FROM imported_tracks JOIN import_times USING (id)'

/** Longitude intervals as `[west, east]`, either of which may cross the antimeridian. */
const longitudesOverlap = (a: [number, number], b: [number, number]): boolean => {
  const pieces = ([west, east]: [number, number]): [number, number][] =>
    west <= east
      ? [[west, east]]
      : [
          [west, 180],
          [-180, east],
        ]
  return pieces(a).some(([aWest, aEast]) => pieces(b).some(([bWest, bEast]) => aWest <= bEast && bWest <= aEast))
}

export interface SqliteStoreConfig {
  /** Absolute path to the database file, or ':memory:'. */
  file: string
  /**
   * Minimum spacing between stored positions, in ms. 0 stores every one.
   *
   * The same `resolution` the in-memory accumulator applies with
   * `throttleTime`, enforced here on write instead. Without it a boat emitting
   * position at 8 Hz writes ~700k rows a day rather than the ~1.4k a 60s
   * resolution implies — a difference that lands on an SD card.
   */
  resolution?: number
  /** Drop positions older than this many ms. 0 keeps everything. */
  retention?: number
  /** Purge a recycle bin entry this many ms after its delete. 0 never purges. */
  binRetention?: number
  /** Cells per bounding box covering. */
  maxCells?: number
  /**
   * The most rows a clipped read counts, in the box and in the window, to
   * choose between reading a named vessel by cell and by time.
   */
  readProbeLimit?: number
  /**
   * Positions one `refineLevels()` call refines, rounded up to the piece it is
   * in. Tests lower it.
   */
  refineBudget?: number
  /**
   * Metres within which a position of a refined day may lie of the line its
   * neighbours draw and still be deleted: what a track simplified to this
   * tolerance leaves out; see `simplifyStored()`. 0 deletes none, and detail
   * finer than the resolution is thinned by time instead (`thinOldDetail`).
   */
  storageTolerance?: number
  /**
   * Knots above which a fix dated inside the stored track is dropped, measured
   * to the stored positions either side of it; see `newPosition()`. 0 checks
   * none.
   */
  maxSpeedKnots?: number
  /** A gap longer than this ms starts a new track segment. */
  segmentGap?: number
}

const DEFAULT_MAX_CELLS = 8
/** See SqliteStoreConfig.readProbeLimit: counting this many index entries takes about 10 ms on a Pi 5. */
const DEFAULT_READ_PROBE_LIMIT = 50_000

/**
 * Significance levels, kept by `refineLevels()`. A position's level is
 * floor(log2(significance / LEVEL_BASE_M)), its `significance()` in quarter
 * metres as a power of two, so a read at a tolerance t needs only the levels
 * from floor(log2(t / LEVEL_BASE_M)) up: every position simplifying to t
 * keeps is further off than t. KEEP_LEVEL is a position no tolerance leaves
 * out, an end of a piece.
 */
const LEVEL_BASE_M = 0.25
const KEEP_LEVEL = 31
/**
 * The lowest level `significant` holds, and so the lowest a read filters on.
 * Below a 4 m tolerance nearly every position qualifies: the table would copy
 * most of positions for reads that save little.
 */
const MIN_READ_LEVEL = 4
/**
 * The levels from `lowest` up, for a query to name one by one: each is then a
 * seek on (context_id, level, timestamp), where a range of levels would walk them.
 */
const levelsUp = (lowest: number): number[] => Array.from({ length: KEEP_LEVEL - lowest + 1 }, (_, i) => lowest + i)
const SIGNIFICANT_LEVELS = levelsUp(MIN_READ_LEVEL).join(', ')
/**
 * The days levels are refined in, one never mixing with the next, and the
 * span one read in `getTimed` holds at a time: at most 86,400 rows at one
 * per second.
 */
const LEVEL_DAY_MS = 24 * 60 * 60 * 1000
/**
 * The default for SqliteStoreConfig.refineBudget: tens of milliseconds of a
 * Pi between two reads, which keeps up with a fix a second and is short
 * enough that a read waiting behind it goes unnoticed.
 */
const DEFAULT_REFINE_BUDGET = 6000
/**
 * What refining one day costs beyond its positions, counted against the
 * budget as positions: the statements each day runs. A receiver records
 * thousands of AIS vessels with a fix or two a day, and without this one call
 * would take on thousands of days, with every read waiting behind it.
 */
const REFINE_DAY_COST = 50
/**
 * The most positions refined as one piece. Longer stretches, a day at one
 * fix a second say, are cut here, where the time moves on, so a call never
 * has to finish more than this many to stop. Each cut keeps the two
 * positions at it at KEEP_LEVEL, a handful a day.
 */
const LEVEL_PIECE_MAX = 6000

const dayOf = (timestamp: number): number => Math.floor(timestamp / LEVEL_DAY_MS)
const levelOf = (significance: number): number =>
  significance === Infinity
    ? KEEP_LEVEL
    : significance > 0
      ? Math.max(0, Math.min(KEEP_LEVEL - 1, Math.floor(Math.log2(significance / LEVEL_BASE_M))))
      : 0

/**
 * The cells and hours `level_visits` keeps of each refined day: a hundredth
 * of a degree, about a kilometre, and an hour.
 */
const VISIT_CELL_DEG = 0.01
const VISIT_HOUR_MS = 60 * 60 * 1000
const visitCell = (degrees: number): number => Math.floor(degrees / VISIT_CELL_DEG)

/** A span of time a read covers, `from` included unless it says otherwise. */
interface TimeRange {
  from: number
  to: number
  inclusiveEnd: boolean
  exclusiveStart?: boolean
}
const isEmpty = ({ from, to, inclusiveEnd, exclusiveStart }: TimeRange): boolean =>
  from > to || (from === to && (!inclusiveEnd || exclusiveStart === true))
/** The time condition for a range, one bound per side, binding `from` and then `to`. */
const inRange = (range: TimeRange): string =>
  ` AND ${range.exclusiveStart ? 'timestamp > ?' : 'timestamp >= ?'} AND ${range.inclusiveEnd ? 'timestamp <= ?' : 'timestamp < ?'}`

/** The days of a context `significant` holds: through its frontier, but for those a change sent back. */
interface RefinedDays {
  through: number
  stale: Set<number>
}
const isRefined = (refined: RefinedDays | undefined, day: number): boolean =>
  refined !== undefined && day <= refined.through && !refined.stale.has(day)
/** The part of `range` up to the end of the frontier day, which `significant` holds but for stale days. */
const refinedIn = (refined: RefinedDays | undefined, range: TimeRange): TimeRange | undefined => {
  if (!refined) {
    return undefined
  }
  const end = (refined.through + 1) * LEVEL_DAY_MS
  const part = end <= range.to ? { ...range, to: end, inclusiveEnd: false } : range
  return isEmpty(part) ? undefined : part
}
/** The parts of `range` `significant` does not hold, in order: the stale days and all after the frontier. */
const unrefinedIn = (refined: RefinedDays | undefined, range: TimeRange): TimeRange[] => {
  if (!refined) {
    return isEmpty(range) ? [] : [range]
  }
  const parts: TimeRange[] = []
  for (const day of [...[...refined.stale].sort((a, b) => a - b), refined.through + 1]) {
    const start = day * LEVEL_DAY_MS
    const end = day > refined.through ? Number.POSITIVE_INFINITY : start + LEVEL_DAY_MS
    const part: TimeRange = {
      from: Math.max(range.from, start),
      to: Math.min(range.to, end),
      inclusiveEnd: range.to < end && range.inclusiveEnd,
      exclusiveStart: range.from >= start && range.exclusiveStart === true,
    }
    if (!isEmpty(part)) {
      parts.push(part)
    }
  }
  return parts
}

/**
 * How long a stretch recorded finer than the store's resolution keeps all of
 * that detail. The swing around an anchor matters while the boat lies there
 * and for a while after, not for the rest of the season.
 */
const DETAIL_KEEP = 24 * 60 * 60 * 1000
/**
 * The most time the stored positions are simplified to leave between two
 * kept ones, where the recording had a position between them: a straight leg
 * then never reads as a pause, to `segment()` at a gap of a minute or more,
 * or to `fillGaps` and the imports that fill what it finds.
 */
const STORED_GAP_MAX = 60 * 1000
/**
 * How many points a stretch still being recorded keeps over its whole length,
 * as an anchor alarm reads it: from the drop, at one point per this many
 * seconds of the stay, so a day per second.
 */
const DETAIL_STAY_POINTS = 24 * 60 * 60
/** Fixes further apart than this start a new detail span. */
const DETAIL_JOIN_GAP = 10 * 60 * 1000
const DETAIL_SAVE_INTERVAL = 60 * 1000
const DEFAULT_SEGMENT_GAP = 5 * 60 * 1000
/**
 * How far apart two fixes inside a clipping box may be and still be read as
 * one stretch. A vessel cannot get far between fixes this close, so reading
 * what lies between them costs less than the two extra queries a separate
 * stretch takes. Any value gives the same clipped track.
 */
const CLIP_STRETCH_GAP = 10 * 60 * 1000

/**
 * The longest piece of an import `fillTrack` judges on one read: a day
 * recorded at one fix a second is some 86,000 timestamps.
 */
const FILL_PIECE_MS = 24 * 60 * 60 * 1000

/**
 * A run sorted by time, cut into the pieces `fillTrack` reads one at a time:
 * none longer than `FILL_PIECE_MS`, and a new one wherever two points lie
 * further apart than the windows around them reach, so the time between is
 * not read at all.
 */
function* fillPieces(run: TimedPosition[]): Generator<TimedPosition[]> {
  let piece: TimedPosition[] = []
  for (const point of run) {
    const first = piece[0]
    const last = piece.at(-1)
    if (
      first !== undefined &&
      last !== undefined &&
      (point.timestamp - first.timestamp > FILL_PIECE_MS || point.timestamp - last.timestamp > 2 * MIN_FILLED_GAP_MS)
    ) {
      yield piece
      piece = []
    }
    piece.push(point)
  }
  if (piece.length > 0) yield piece
}

/**
 * Which positions of a piece simplifying the store to `tolerance` keeps: the
 * ones `simplify()` keeps at it, its ends, and enough of the rest that no two
 * kept ones lie further apart than STORED_GAP_MAX where the piece had a
 * position between them.
 */
function storedKeep(piece: { timestamp: number }[], values: Float64Array, tolerance: number): boolean[] {
  const keep = Array.from(values, (value) => value > tolerance)
  let last = 0
  for (let i = 1; i < piece.length - 1; i++) {
    if (!keep[i] && piece[i + 1]!.timestamp - piece[last]!.timestamp > STORED_GAP_MAX) {
      keep[i] = true
    }
    if (keep[i]) {
      last = i
    }
  }
  return keep
}

/** Index of the first of `items` whose key is `time` or later, the items sorted by that key. */
function lowerBound<T>(items: readonly T[], time: number, key: (item: T) => number): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (key(items[mid]!) < time) low = mid + 1
    else high = mid
  }
  return low
}

const startOf = (run: TimedPosition[]): number => run[0]!.timestamp

/**
 * The runs `fillTrack` kept so far, sorted by their first point, each sorted
 * by time and, coming from one of `fillPieces`, no longer than
 * FILL_PIECE_MS: a lookup then reads only the runs that start within that of
 * its window, however many runs an upload brings.
 */
class KeptRuns {
  private readonly runs: TimedPosition[][] = []

  add(run: TimedPosition[]): void {
    if (run.length > 0) this.runs.splice(lowerBound(this.runs, startOf(run) + 1, startOf), 0, run)
  }

  /** The points from `from` until `to`, both included. */
  within(from: number, to: number): TimedPosition[] {
    const within: TimedPosition[] = []
    for (let r = lowerBound(this.runs, from - FILL_PIECE_MS, startOf); r < this.runs.length; r++) {
      const run = this.runs[r]!
      if (startOf(run) > to) break
      for (let i = lowerBound(run, from, (point) => point.timestamp); i < run.length && run[i]!.timestamp <= to; i++) {
        within.push(run[i]!)
      }
    }
    return within
  }
}

/**
 * The schema version `PRAGMA user_version` holds; 0 is a database written
 * before contexts had ids, which `migrate()` rewrites.
 */
const SCHEMA_VERSION = 1

/** An id no context has: bound for one the store does not know, it matches no row, as its name did. */
const NO_CONTEXT = -1

/** Every table, and the indexes of the small ones; see INDEXES for the rest. */
const TABLES = `
  -- The tables with a row per position name its context by an id here: the
  -- context is some 40 bytes of text, which positions, its indexes and
  -- significant held nearly half the file in. Never reused, since a deleted
  -- context's id could otherwise come back for another vessel.
  CREATE TABLE IF NOT EXISTS contexts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    context   TEXT    NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS positions (
    context_id INTEGER NOT NULL,
    timestamp  INTEGER NOT NULL,
    lat        REAL    NOT NULL,
    lon        REAL    NOT NULL,
    s2cell     INTEGER NOT NULL
  );
  -- A separate table rather than a column on positions: short of rewriting
  -- the whole file (see migrate()), a new table appears harmlessly on a
  -- database written by an older version, where an ALTER TABLE would not.
  CREATE TABLE IF NOT EXISTS names (
    context   TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  -- Imported tracks, apart from positions: they are never merged into a
  -- recording or pruned with one. The extent is kept per track so a query
  -- can skip an import without reading its points.
  CREATE TABLE IF NOT EXISTS imported_tracks (
    id          TEXT PRIMARY KEY,
    context     TEXT,
    name        TEXT,
    metadata    TEXT    NOT NULL,
    first_time  INTEGER,
    last_time   INTEGER,
    west        REAL    NOT NULL,
    south       REAL    NOT NULL,
    east        REAL    NOT NULL,
    north       REAL    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_imported_context ON imported_tracks(context);
  -- When each import was kept. Its own table, like names, so a database
  -- written before it existed opens unchanged; it stays while the import
  -- is in the recycle bin, for a restore, and goes when that is purged.
  CREATE TABLE IF NOT EXISTS import_times (
    id          TEXT PRIMARY KEY,
    imported_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS imported_points (
    track_id  TEXT    NOT NULL,
    seq       INTEGER NOT NULL,
    segment   INTEGER NOT NULL,
    timestamp INTEGER,
    lat       REAL    NOT NULL,
    lon       REAL    NOT NULL,
    PRIMARY KEY (track_id, seq)
  ) WITHOUT ROWID;
  -- The recycle bin. A delete moves rows here rather than removing them,
  -- so the tables every read uses stay as they are and a restore moves
  -- them back. A purged recorded span keeps its row: the history import
  -- would otherwise fill the deleted window back in.
  CREATE TABLE IF NOT EXISTS recycle_bin (
    id          INTEGER PRIMARY KEY,
    context     TEXT,
    import_id   TEXT,
    name        TEXT,
    whole       INTEGER NOT NULL,
    span_from   INTEGER,
    span_to     INTEGER,
    deleted_at  INTEGER NOT NULL,
    purged      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS binned_positions (
    bin_id     INTEGER NOT NULL,
    context_id INTEGER NOT NULL,
    timestamp  INTEGER NOT NULL,
    lat        REAL    NOT NULL,
    lon        REAL    NOT NULL,
    s2cell     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_binned_positions ON binned_positions(bin_id);
  -- Whether the bin holds a context, which forgetContexts() asks of every one.
  CREATE INDEX IF NOT EXISTS idx_binned_context ON binned_positions(context_id);
  CREATE TABLE IF NOT EXISTS binned_imported_tracks (
    bin_id      INTEGER PRIMARY KEY,
    id          TEXT    NOT NULL,
    context     TEXT,
    name        TEXT,
    metadata    TEXT    NOT NULL,
    first_time  INTEGER,
    last_time   INTEGER,
    west        REAL    NOT NULL,
    south       REAL    NOT NULL,
    east        REAL    NOT NULL,
    north       REAL    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS binned_imported_points (
    bin_id    INTEGER NOT NULL,
    track_id  TEXT    NOT NULL,
    seq       INTEGER NOT NULL,
    segment   INTEGER NOT NULL,
    timestamp INTEGER,
    lat       REAL    NOT NULL,
    lon       REAL    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_binned_imported_points ON binned_imported_points(bin_id);
  -- Stretches recorded finer than the store's resolution, thinned back to
  -- it once they are old; see noteDetail and prune.
  CREATE TABLE IF NOT EXISTS detail_spans (
    id          INTEGER PRIMARY KEY,
    context     TEXT    NOT NULL,
    span_start  INTEGER NOT NULL,
    span_end    INTEGER NOT NULL
  );
  -- The positions of refined days from MIN_READ_LEVEL up, copied with
  -- their level: what a read at a tolerance reads instead of positions.
  -- A table of its own rather than a column, so refining writes only the
  -- few positions that carry a track's shape and never a row of
  -- positions or its indexes. position is the row in positions, which
  -- orders positions recorded at the same time.
  CREATE TABLE IF NOT EXISTS significant (
    position    INTEGER NOT NULL,
    context_id  INTEGER NOT NULL,
    timestamp   INTEGER NOT NULL,
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    level       INTEGER NOT NULL
  );
  -- The hours of refined days each context had a position in each cell
  -- of VISIT_CELL_DEG: where a box read at a tolerance finds a vessel,
  -- since the positions a level keeps in the box can be none at all.
  CREATE TABLE IF NOT EXISTS level_visits (
    context_id  INTEGER NOT NULL,
    lat_cell    INTEGER NOT NULL,
    lon_cell    INTEGER NOT NULL,
    hour        INTEGER NOT NULL,
    PRIMARY KEY (context_id, lat_cell, lon_cell, hour)
  ) WITHOUT ROWID;
  -- Per context, the last day refineLevels() has refined, and the refined
  -- days a change has since sent back to it.
  CREATE TABLE IF NOT EXISTS level_frontier (
    context     TEXT    PRIMARY KEY,
    through     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS level_stale (
    context     TEXT    NOT NULL,
    day         INTEGER NOT NULL,
    PRIMARY KEY (context, day)
  ) WITHOUT ROWID;
  -- Per context, the last refined day simplifyStored() has gone
  -- through and the tolerance it did so at, and the days a change has
  -- since sent back to it.
  CREATE TABLE IF NOT EXISTS simplify_frontier (
    context     TEXT    PRIMARY KEY,
    through     INTEGER NOT NULL,
    tolerance   REAL    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS simplify_pending (
    context     TEXT    NOT NULL,
    day         INTEGER NOT NULL,
    PRIMARY KEY (context, day)
  ) WITHOUT ROWID;
  -- Days an import wrote simplified already (see simplifyUnrecorded()),
  -- with the tolerance and how many positions they held then, which
  -- simplifyStored() passes over rather than simplifies again.
  CREATE TABLE IF NOT EXISTS simplified_days (
    context     TEXT    NOT NULL,
    day         INTEGER NOT NULL,
    tolerance   REAL    NOT NULL,
    positions   INTEGER NOT NULL,
    PRIMARY KEY (context, day)
  ) WITHOUT ROWID;
  -- How far the import of a vessel's track from a history provider got,
  -- so a restart goes on from there; see historyImport.ts.
  CREATE TABLE IF NOT EXISTS history_imports (
    context     TEXT PRIMARY KEY,
    started_at  INTEGER NOT NULL,
    first_day   INTEGER,
    next_day    INTEGER,
    filled      INTEGER NOT NULL,
    in_gap      INTEGER,
    finished_at INTEGER,
    error       TEXT
  );
  -- The last GPX file uploaded in slices, so a restart goes on with it;
  -- see gpxUpload.ts. A new upload replaces the row.
  CREATE TABLE IF NOT EXISTS gpx_uploads (
    id    TEXT PRIMARY KEY,
    state TEXT NOT NULL
  );
`

/**
 * The indexes of the tables with a row per position, which `migrate()` builds
 * once their rows are in rather than row by row.
 */
const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_s2cell ON positions(s2cell);
  -- The position rides along with the vessel and time, so a read of a track
  -- is answered from the index alone, without a lookup in the table for
  -- every row.
  CREATE INDEX IF NOT EXISTS idx_context_time_position ON positions(context_id, timestamp, lat, lon);
  -- Reads a box for one vessel without its whole window: the cell index
  -- alone mixes every vessel near the box, and the index above finds the
  -- vessel but orders its rows by time.
  CREATE INDEX IF NOT EXISTS idx_context_s2cell ON positions(context_id, s2cell);
  CREATE INDEX IF NOT EXISTS idx_significant_time ON significant(context_id, level, timestamp);
  -- A refined day's visits are cleared by hour, which the key, led by the
  -- cells a box read asks for, cannot seek.
  CREATE INDEX IF NOT EXISTS idx_level_visits_hour ON level_visits(context_id, hour);
`

/** The tables that name a position's context by its id, which a database before SCHEMA_VERSION named in full. */
const BY_CONTEXT_ID = ['positions', 'binned_positions', 'significant', 'level_visits']

/** SQLITE_BUSY and SQLITE_LOCKED, which node:sqlite reports as extended codes: another connection holds the database. */
const HELD = new Set([5, 6])
/** What Windows answers a rename with while a scanner or an indexer has a file open, and what retrying it waits out. */
const RENAME_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** How often, and how long apart, migrate() tries to take a database out of WAL mode, or to rename the new one over it. */
const LEAVE_WAL_TRIES = 10
const LEAVE_WAL_WAIT_MS = 500

/**
 * Rewrite a database an older version wrote, if it is one, to SCHEMA_VERSION,
 * and refuse one a newer version wrote, which this one cannot read.
 *
 * Built as a new file next to it and then renamed over it, rather than in
 * place: changed in place, the file would keep its size until a VACUUM,
 * which writes a copy of the whole database to the temporary directory,
 * memory on many a Raspberry Pi. The old database is first taken out of WAL
 * mode, which writes back and removes its log, so no log is ever left beside
 * the new file to be replayed into it. That cannot be done while another
 * connection holds it, which a few tries wait out; the store then does not
 * open. A crash anywhere leaves either database whole, and a new file left
 * half built is built again.
 */
function migrate(path: string, debug: Debug): void {
  if (!existsSync(path)) {
    return
  }
  // Through a link, the file it points to, which the new one must replace
  // rather than the link.
  const file = realpathSync(path)
  const started = performance.now()
  // The file's change counter as the lock found it, to tell a write that
  // came in while the rewrite read it.
  let changes: number | undefined
  const old = new DatabaseSync(file)
  try {
    old.exec('PRAGMA busy_timeout = 5000')
    const { user_version: version } = old.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version > SCHEMA_VERSION) {
      throw new Error(`${file} was written by a newer version of this plugin, which this one cannot read`)
    }
    // By its columns rather than its version: a new database set up only in
    // part, before its version was written, has the new ones.
    const named = (old.prepare('PRAGMA table_info(positions)').all() as { name: string }[]).some(
      ({ name }) => name === 'context',
    )
    if (!named) {
      return
    }
    // Waited out by the tries below, not by every statement in them.
    old.exec('PRAGMA busy_timeout = 0')
    for (let attempt = 1; ; attempt++) {
      try {
        const { journal_mode: mode } = old.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode: string }
        // Out of WAL mode already, after a rewrite that failed say, the
        // switch takes no lock: the lock is asked for on its own.
        if (mode === 'delete') {
          // Opened before the lock and closed after it: on Linux and macOS,
          // closing any descriptor of a file drops the process's locks on it.
          const header = openSync(file, 'r')
          try {
            old.exec('BEGIN EXCLUSIVE')
            changes = changeCounter(header)
            old.exec('COMMIT')
          } finally {
            closeSync(header)
          }
          break
        }
      } catch (error) {
        if (!HELD.has(((error as { errcode?: number }).errcode ?? 0) & 0xff)) {
          throw error
        }
      }
      if (attempt === LEAVE_WAL_TRIES) {
        throw new Error(`${file} needs rewriting for this version, but another connection holds it open`)
      }
      pause(LEAVE_WAL_WAIT_MS)
    }
  } finally {
    old.close()
  }
  const next = `${file}.migrating`
  rmSync(next, { force: true })
  try {
    rewrite(file, next)
    const { mode, uid, gid } = statSync(file)
    const fd = openSync(next, 'r+')
    try {
      // Readable and owned as the old one was, for whoever else reads it, a
      // backup say. Only root can give it to another user; anyone may try
      // to keep the group. The mode first, while the file is still this
      // process's own, and neither is worth failing the rewrite for.
      try {
        fchmodSync(fd, mode & 0o777)
      } catch {
        // kept as created
      }
      try {
        fchownSync(fd, process.getuid?.() === 0 ? uid : -1, gid)
      } catch {
        // kept as created
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // A write by another program while this one read the file, which the
    // rename would lose, or whose log SQLite would replay into the new file.
    const header = openSync(file, 'r')
    let moved: boolean
    try {
      moved = changeCounter(header) !== changes
    } finally {
      closeSync(header)
    }
    if (moved || hotLog(`${file}-journal`) || hotLog(`${file}-wal`)) {
      throw new Error(`${file} was written to while it was rewritten for this version`)
    }
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(next, file)
        break
      } catch (error) {
        const busy = process.platform === 'win32' && RENAME_BUSY.has((error as { code?: string }).code ?? '')
        if (attempt === LEAVE_WAL_TRIES || !busy) {
          throw error
        }
        pause(LEAVE_WAL_WAIT_MS)
      }
    }
  } catch (error) {
    // Up to half the old file, which on a full disk would keep it full.
    try {
      rmSync(next, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // left for the next start, which removes it first
    }
    throw error
  }
  // The rename itself, where the directory can be synced; Windows cannot open one.
  try {
    const dir = openSync(dirname(file), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } catch {
    // nothing to sync it with
  }
  debug(`rewrote ${file} for schema ${SCHEMA_VERSION} in ${Math.round(performance.now() - started)} ms`)
}

/** The file change counter in the header of the database open at `fd`, which every write moves on. */
function changeCounter(fd: number): number {
  const header = Buffer.alloc(4)
  readSync(fd, header, 0, 4, 24)
  return header.readUInt32BE(0)
}

/**
 * Whether a database's log beside it holds something SQLite would replay or
 * roll back into it, as SQLite judges a journal: there, and its first byte
 * set. One left empty or zeroed stays there harmlessly.
 */
function hotLog(log: string): boolean {
  if (!existsSync(log)) {
    return false
  }
  const fd = openSync(log, 'r')
  try {
    const first = Buffer.alloc(1)
    return readSync(fd, first, 0, 1, 0) === 1 && first[0] !== 0
  } finally {
    closeSync(fd)
  }
}

/** Block this thread for `ms`: migrate() runs before the store answers anything. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** migrate()'s new file `next`, built from the database at `file`. */
function rewrite(file: string, next: string): void {
  const db = new DatabaseSync(next)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    // A file nothing reads until it is renamed, so nothing is journaled or
    // synced until it is whole.
    db.exec('PRAGMA journal_mode = OFF')
    db.exec('PRAGMA synchronous = OFF')
    db.exec(TABLES)
    db.prepare('ATTACH DATABASE ? AS old').run(file)
    const columns = (schema: string, table: string) =>
      (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map(({ name }) => name)
    const held = new Set(
      (db.prepare("SELECT name FROM old.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        ({ name }) => name,
      ),
    )
    const byId = BY_CONTEXT_ID.filter((table) => held.has(table))
    db.exec('BEGIN')
    // Each table's own, which its index by context gives without sorting
    // every row in the temporary directory.
    db.exec(
      `INSERT INTO contexts (context) ${byId.map((table) => `SELECT DISTINCT context FROM old.${table}`).join(' UNION ')} ORDER BY 1`,
    )
    for (const table of byId) {
      const rest = columns('main', table).filter((column) => column !== 'context_id')
      // A position keeps its rowid, which significant refers to it by.
      const rowid = table === 'positions' ? ['rowid'] : []
      db.exec(
        `INSERT INTO main.${table} (${[...rowid, 'context_id', ...rest].join(', ')})
         SELECT ${[...rowid.map((r) => `t.${r}`), 'c.id', ...rest.map((column) => `t.${column}`)].join(', ')}
         FROM old.${table} AS t JOIN contexts AS c ON c.context = t.context${rowid.length > 0 ? ' ORDER BY t.rowid' : ''}`,
      )
    }
    const others = (
      db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string
      }[]
    )
      .map(({ name }) => name)
      .filter((table) => table !== 'contexts' && !BY_CONTEXT_ID.includes(table) && held.has(table))
    for (const table of others) {
      const kept = new Set(columns('old', table))
      const shared = columns('main', table).filter((column) => kept.has(column))
      db.exec(`INSERT INTO main.${table} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM old.${table}`)
    }
    db.exec(INDEXES)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
    db.exec('DETACH DATABASE old')
  } finally {
    db.close()
  }
}

/**
 * A position store backed by SQLite, so tracks survive a restart.
 *
 * Uses node:sqlite rather than better-sqlite3: it is built into Node >= 22, so
 * installing the plugin on a Raspberry Pi needs no native compilation.
 *
 * The spatial index is Teppo Kurki's design from SignalK/tracks#11 — an S2 cell
 * id per position, queried as id ranges — as is segmenting a track on a time
 * gap. Both are reimplemented here rather than rebased; see that PR for the
 * original.
 */
export class SqliteTrackStore implements TrackStore {
  private readonly db: DatabaseSync
  private readonly insert: StatementSync
  private readonly insertName: StatementSync
  private readonly selectName: StatementSync
  private readonly selectImportedPoints: StatementSync
  private readonly maxCells: number
  private readonly readProbeLimit: number
  private readonly refineBudget: number
  private readonly segmentGap: number
  private readonly retention: number
  private readonly binRetention: number
  private readonly resolution: number
  /** See CLIP_STRETCH_GAP; widened so a coarse write resolution does not split every fix. */
  private readonly stretchGap: number
  private readonly debug: Debug
  /** Timestamp of the last position stored per context, for throttling. */
  private readonly lastStored = new Map<string, number>()
  private readonly maxSpeedKnots: number
  /** See contradictsStored(). */
  private neighbourStatements: Record<'before' | 'after', StatementSync> | undefined
  /**
   * The stored name per context, dated by its newest report. A name arrives
   * with every position, so a repeat is answered here instead of committing a
   * row that has not changed.
   */
  private readonly lastName = new Map<string, { name: string; timestamp: number }>()
  /**
   * Per detail span still open, the spacing and cutoff `thinOldDetail` last
   * thinned it at.
   */
  private readonly lastThin = new Map<number, { spacing: number; cutoff: number }>()
  /** The detail span each context is in, if any; see `noteDetail`. */
  private readonly detail = new Map<string, { id: number; end: number; saved: number }>()
  /** Each context's id, which the tables in BY_CONTEXT_ID name it by; a copy of contexts. */
  private readonly contextIds = new Map<Context, number>()
  /** The context of each id; see contextIds. */
  private readonly contextNames = new Map<number, Context>()
  /** Per context, the last day refineLevels() has refined; a copy of level_frontier. */
  private readonly levelFrontier = new Map<string, number>()
  /** The last refinable day as of the newest pass over every context. */
  private refinedThrough: number | undefined
  /** Where the pass over the contexts goes on after running out of budget. */
  private refineResume: string | undefined
  /**
   * A day refineLevels() stopped inside, to go on from `next`: a stale one, or
   * one of the pass past its context's frontier.
   */
  private refinePartial: { context: Context; day: number; next: number; stale: boolean } | undefined
  private readonly storageTolerance: number
  /**
   * Per context, the last refined day simplifyStored() has gone through and
   * the tolerance it did so at; a copy of simplify_frontier.
   */
  private readonly simplifyFrontier = new Map<string, { through: number; tolerance: number }>()
  /** The last refinable day as of the newest simplifying pass over every context. */
  private simplifiedThrough: number | undefined
  /** Where the simplifying pass over the contexts goes on after running out of budget. */
  private simplifyResume: string | undefined
  /** A day simplifyStored() stopped inside, to go on from `next`: a pending one, or one of the pass. */
  private simplifyPartial: { context: Context; day: number; next: number; pending: boolean } | undefined
  /** See simplifying(). */
  private simplifyStatements:
    | Record<
        | 'select'
        | 'held'
        | 'remove'
        | 'written'
        | 'unwritten'
        | 'count'
        | 'mark'
        | 'unwrite'
        | 'recorded'
        | 'done'
        | 'frontier',
        StatementSync
      >
    | undefined
  /** See refining(). */
  private refineStatements:
    | Record<'select' | 'copy' | 'visit' | 'unstale' | 'frontier' | 'deleteSignificant' | 'deleteVisits', StatementSync>
    | undefined

  constructor(config: SqliteStoreConfig, debug: Debug) {
    this.maxCells = config.maxCells ?? DEFAULT_MAX_CELLS
    this.readProbeLimit = config.readProbeLimit ?? DEFAULT_READ_PROBE_LIMIT
    this.refineBudget = config.refineBudget ?? DEFAULT_REFINE_BUDGET
    this.storageTolerance = config.storageTolerance ?? 0
    this.maxSpeedKnots = config.maxSpeedKnots ?? 0
    this.segmentGap = config.segmentGap ?? DEFAULT_SEGMENT_GAP
    this.retention = config.retention ?? 0
    this.binRetention = config.binRetention ?? 0
    this.resolution = config.resolution ?? 0
    this.stretchGap = Math.max(CLIP_STRETCH_GAP, 2 * this.resolution)
    this.debug = debug

    if (config.file !== ':memory:') {
      migrate(config.file, debug)
    }
    this.db = new DatabaseSync(config.file)
    // WAL keeps a reader from blocking the writer, which matters because
    // positions arrive continuously while a query is being served.
    this.db.exec('PRAGMA journal_mode = WAL')
    // node:sqlite defaults to FULL, an fsync on every commit, and on an SD
    // card each one can take seconds. NORMAL syncs only at checkpoints. A
    // power cut can then lose the most recent commits but never corrupts the
    // database, and a process crash loses nothing. It is a per-connection
    // setting, so it is set on every open.
    this.db.exec('PRAGMA synchronous = NORMAL')
    // A lock held by another connection, a backup or an sqlite3 shell say, is
    // waited out rather than failing the write at once.
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(TABLES)
    this.db.exec(INDEXES)
    if ((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version === 0) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    this.loadContexts()
    this.loadLevels()
    // Imports kept before their time was: dated to the first start that knew to.
    const now = Date.now()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO import_times (id, imported_at)
         SELECT id, ? FROM imported_tracks UNION SELECT id, ? FROM binned_imported_tracks`,
      )
      .run(now, now)
    this.insert = this.db.prepare(
      'INSERT INTO positions (context_id, timestamp, lat, lon, s2cell) VALUES (?, ?, ?, ?, ?)',
    )
    // Newer wins: a corrected or changed name replaces what is stored, while
    // an older observation arriving late leaves it alone.
    this.insertName = this.db.prepare(
      `INSERT INTO names (context, name, timestamp) VALUES (?, ?, ?)
       ON CONFLICT(context) DO UPDATE SET name = excluded.name, timestamp = excluded.timestamp
       WHERE excluded.timestamp >= names.timestamp`,
    )
    this.selectName = this.db.prepare('SELECT name FROM names WHERE context = ?')
    this.selectImportedPoints = this.db.prepare(
      'SELECT segment, timestamp, lat, lon FROM imported_points WHERE track_id = ? ORDER BY seq',
    )
  }

  newPosition(context: Context, position: LatLngTuple, timestamp: number = Date.now(), resolution?: number): void {
    // The glitch filter measures a fix from the one before it, and cannot judge
    // one dated before that, or the first fix after a restart. That one can come
    // from a clock not yet set, dated back into the stored track at a position
    // the vessel only reached since: a line out and back across the chart.
    if (this.contradictsStored(context, position, timestamp)) {
      this.debug(
        `Dropped a fix of ${context} dated ${new Date(timestamp).toISOString()}: too far from the stored track`,
      )
      return
    }
    // Leading-edge throttle per context, matching the in-memory accumulator's
    // throttleTime: the first position in a resolution window is stored and the
    // rest are dropped, not averaged. A vessel emitting at 8 Hz would otherwise
    // write hundreds of thousands of rows a day at the default 60s resolution.
    if (this.resolution > 0) {
      const spacing = resolution ?? this.resolution
      const previous = this.lastStored.get(context)
      // `<` not `<=`: two positions sharing a timestamp are the same instant,
      // and a stored point must not block one that is genuinely later.
      if (previous !== undefined && timestamp - previous < spacing) {
        return
      }
      if (previous !== undefined && timestamp - previous < this.resolution) {
        this.noteDetail(context, previous, timestamp)
      }
      this.lastStored.set(context, timestamp)
    }
    this.store(context, position, timestamp)
    // A fix dated into a day refined already, as one from a clock that jumped
    // back is, or into the day being refined or one before it.
    const through = this.levelFrontier.get(context)
    const day = dayOf(timestamp)
    const partial = this.refinePartial
    if ((through !== undefined && day <= through) || (partial?.context === context && day <= partial.day)) {
      this.invalidateLevels(context, timestamp, timestamp)
    }
  }

  /**
   * Whether a fix dated inside the stored track implies more than
   * `maxSpeedKnots` from the stored position before it or to the one after it.
   * A fix dated after every stored position, as nearly every live one is,
   * takes one index seek and is the glitch filter's to judge, so one stored
   * glitch cannot hold up the recording that follows it.
   */
  private contradictsStored(context: Context, position: LatLngTuple, timestamp: number): boolean {
    if (!(this.maxSpeedKnots > 0)) {
      return false
    }
    const statements = (this.neighbourStatements ??= {
      before: this.db.prepare(
        'SELECT timestamp, lat, lon FROM positions WHERE context_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1',
      ),
      after: this.db.prepare(
        'SELECT timestamp, lat, lon FROM positions WHERE context_id = ? AND timestamp >= ? ORDER BY timestamp LIMIT 1',
      ),
    })
    const id = this.idOf(context)
    const after = statements.after.get(id, timestamp) as PositionRow | undefined
    if (after === undefined) {
      return false
    }
    const before = statements.before.get(id, timestamp) as PositionRow | undefined
    const fix: Fix = { position, timestamp }
    const stored = (row: PositionRow): Fix => ({ position: [row.lat, row.lon], timestamp: row.timestamp })
    // One stored at the same instant, from a second receiver say, is measured
    // as a second away: a few metres from it is no glitch, a mile is.
    const next = after.timestamp === timestamp ? { ...stored(after), timestamp: timestamp + 1000 } : stored(after)
    const speeds = [knotsBetween(fix, next), before && knotsBetween(stored(before), fix)]
    return speeds.some((knots) => knots !== undefined && knots > this.maxSpeedKnots)
  }

  /**
   * Remember that a context was recorded finer than the store's resolution from
   * `previous` to `timestamp`, so `prune()` can thin that stretch once it is old.
   *
   * Kept as spans rather than inferred from row spacing: an own-vessel
   * passage imported into the recording can be just as dense, and it is not
   * this store's to thin. The span's end is written at most once a minute,
   * since at anchor this runs every second; a restart loses at most that
   * minute, which then simply stays at full detail.
   */
  private noteDetail(context: Context, previous: number, timestamp: number): void {
    const open = this.detail.get(context)
    if (open && timestamp - open.end <= DETAIL_JOIN_GAP) {
      open.end = timestamp
      if (timestamp - open.saved >= DETAIL_SAVE_INTERVAL) {
        this.db.prepare('UPDATE detail_spans SET span_end = ? WHERE id = ?').run(timestamp, open.id)
        open.saved = timestamp
      }
      return
    }
    if (open) {
      this.db.prepare('UPDATE detail_spans SET span_end = ? WHERE id = ?').run(open.end, open.id)
    }
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO detail_spans (context, span_start, span_end) VALUES (?, ?, ?)')
      .run(context, previous, timestamp)
    this.detail.set(context, { id: Number(lastInsertRowid), end: timestamp, saved: timestamp })
  }

  private store(context: Context, position: LatLngTuple, timestamp: number): void {
    this.insert.run(this.idFor(context), timestamp, position[0], position[1], toSigned(cellIdFor(position)))
  }

  initialTrack(context: Context, track: LatLngTuple[], timestamps?: number[]): void {
    // Replaces the context's history, matching the in-memory store: a caller
    // installing a known track is authoritative for the window it covers.
    this.db.prepare('DELETE FROM positions WHERE context_id = ?').run(this.idOf(context))
    this.clearLevels(context)
    // Bypasses the throttle: these points are already at whatever resolution
    // the caller recorded them at, and they are back-dated, so throttling
    // against the newest-seen timestamp would drop most of them.
    for (const [i, position] of track.entries()) {
      this.store(context, position, timestamps?.[i] ?? 0)
    }
    this.lastStored.delete(context)
  }

  private rowsFor(context: Context, window?: TimeWindow): PositionRow[] {
    const clauses = ['context_id = ?']
    const params: number[] = [this.idOf(context)]
    if (window) {
      clauses.push('timestamp >= ?', window.inclusiveEnd ? 'timestamp <= ?' : 'timestamp < ?')
      params.push(window.from, window.to)
    }
    // rowid keeps equal times in the order they were stored: an untimed
    // track is stored at timestamp 0 throughout, and the index alone would
    // order those by position.
    return this.db
      .prepare(`SELECT timestamp, lat, lon FROM positions WHERE ${clauses.join(' AND ')} ORDER BY timestamp, rowid`)
      .all(...params) as unknown as PositionRow[]
  }

  private knows(context: Context): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM positions WHERE context_id = ? LIMIT 1').get(this.idOf(context))
    return row !== undefined
  }

  get(context: Context, window?: TimeWindow): Promise<LatLngTuple[]> {
    return this.getTimed(context, window).then((points) => points.map(({ position }) => position))
  }

  /**
   * A context's positions in a window, thinned to `resolution` when one is
   * given. At a `tolerance`, only those simplifying to it can keep, where
   * `significant` holds the day; see `levelsFrom`.
   *
   * Read a day at a time and thinned as each day arrives, so the points are
   * the ones `thin()` keeps without every row of the window being held first:
   * years of track at a fine resolution would otherwise be copied out whole
   * before most of it is dropped, which is enough to exhaust a small board's
   * memory. A day per query rather than a row per step, because node:sqlite
   * builds rows in bulk at about twice the speed it hands them out one by one.
   */
  getTimed(context: Context, window?: TimeWindow, resolution?: number, tolerance?: number): Promise<TimedPosition[]> {
    // An unknown context rejects; a known but stationary one resolves with
    // points. Resolving [] for both would make the two indistinguishable and
    // the route could not answer 404.
    if (!this.knows(context)) {
      return Promise.reject(new UnknownContextError(`No track for ${context}`))
    }
    const range: TimeRange = {
      from: window?.from ?? Number.NEGATIVE_INFINITY,
      to: window?.to ?? Number.POSITIVE_INFINITY,
      inclusiveEnd: !window || window.inclusiveEnd === true,
    }
    const thinner = resolution ? new Thinner(resolution) : undefined
    const points: TimedPosition[] = []
    for (const row of this.daysOf(context, range, this.levelsFrom(tolerance))) {
      if (thinner) {
        thinner.push(toTimed(row))
      } else {
        points.push(toTimed(row))
      }
    }
    return Promise.resolve(thinner ? thinner.finish() : points)
  }

  timeExtent(context: Context, window?: TimeWindow): Promise<TimeExtent | undefined> {
    if (!this.knows(context)) {
      return Promise.reject(new UnknownContextError(`No track for ${context}`))
    }
    // The end as getTimed() reads it, so the two agree on what lies inside.
    const end = !window || window.inclusiveEnd === true ? '<=' : '<'
    // Two seeks on the (context_id, timestamp) index, rather than MIN and MAX in
    // one statement, which reads the whole window.
    const at = (order: 'ASC' | 'DESC') =>
      this.db
        .prepare(
          `SELECT timestamp FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp ${end} ?
           ORDER BY timestamp ${order} LIMIT 1`,
        )
        .get(this.idOf(context), window?.from ?? Number.NEGATIVE_INFINITY, window?.to ?? Number.POSITIVE_INFINITY) as
        { timestamp: number } | undefined
    const first = at('ASC')
    const last = at('DESC')
    return Promise.resolve(first && last ? { first: first.timestamp, last: last.timestamp } : undefined)
  }

  /**
   * How many positions getTimed() returns for each context at the query's
   * window, tolerance and resolution, each counted up to `limit`: those of
   * `contexts` the store holds, or every one. Without a resolution they are
   * counted from the indexes, reading none of them: days as daysOf() reads
   * them, at the levels the tolerance reads where `significant` holds the
   * day and whole elsewhere, the window's first and last positions included.
   * With one, thinning needs the times of the positions, so the rows are
   * read, a day at a time, until the count reaches the limit.
   */
  countTimed(contexts: Context[] | undefined, query: TrackQuery, limit: number): Record<Context, number> {
    const { window, tolerance, resolution } = query
    const range: TimeRange = {
      from: window?.from ?? Number.NEGATIVE_INFINITY,
      to: window?.to ?? Number.POSITIVE_INFINITY,
      inclusiveEnd: !window || window.inclusiveEnd === true,
    }
    const levels = this.levelsFrom(tolerance)
    const counts: Record<Context, number> = {}
    for (const context of contexts ? this.stored(contexts) : this.contexts()) {
      counts[context] = resolution
        ? this.countThinned(context, range, levels, limit, resolution)
        : this.countDays(context, range, levels, limit)
    }
    return counts
  }

  /** daysOf() counted rather than read, up to `limit`. */
  private countDays(context: Context, range: TimeRange, levels: number[] | undefined, limit: number): number {
    const contextId = this.idOf(context)
    const counted = (statement: StatementSync, ...params: number[]) =>
      (statement.get(contextId, ...params) as { n: number }).n
    const positions = (where: string) =>
      this.db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM positions WHERE context_id = ?${where} LIMIT ?)`)
    const refined = levels ? this.refinedDays(context) : undefined
    if (!levels || !refined) {
      return counted(positions(inRange(range)), range.from, range.to, limit)
    }
    const next = this.db.prepare(
      `SELECT timestamp FROM positions WHERE context_id = ?${inRange(range)} ORDER BY timestamp LIMIT 1`,
    )
    const day = ' AND timestamp >= ? AND timestamp < ?'
    const whole = { day: positions(day), last: positions(inRange(range)) }
    const significant = (where: string) =>
      this.db.prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM significant INDEXED BY idx_significant_time WHERE context_id = ? AND level IN (${levels.join(', ')})${where} LIMIT ?)`,
      )
    const byLevel = { day: significant(day), last: significant(inRange(range)) }
    // The window's first and last position, which getTimed() adds to a
    // refined day where the levels leave them out.
    const kept = this.db.prepare(
      `SELECT 1 AS found FROM significant INDEXED BY idx_significant_time WHERE context_id = ? AND level IN (${levels.join(', ')}) AND timestamp = ? AND position = ?`,
    )
    const edge = (order: string) =>
      this.db
        .prepare(
          `SELECT rowid AS id, timestamp FROM positions WHERE context_id = ?${inRange(range)} ORDER BY timestamp ${order}, rowid ${order} LIMIT 1`,
        )
        .get(contextId, range.from, range.to) as unknown as { id: number; timestamp: number } | undefined
    const edges = [edge('ASC'), edge('DESC')].filter(
      (found, i, both): found is { id: number; timestamp: number } =>
        found !== undefined && (i === 0 || found.id !== both[0]?.id),
    )
    let n = 0
    for (let from = range.from; n < limit;) {
      const row = next.get(contextId, from, range.to) as { timestamp: number } | undefined
      if (!row) {
        break
      }
      const start = row.timestamp
      const end = (dayOf(start) + 1) * LEVEL_DAY_MS
      const last = end > range.to
      const left = limit - n
      if (isRefined(refined, dayOf(start))) {
        n += last ? counted(byLevel.last, start, range.to, left) : counted(byLevel.day, start, end, left)
        for (const { id, timestamp } of edges) {
          if (dayOf(timestamp) === dayOf(start) && kept.get(contextId, timestamp, id) === undefined) {
            n++
          }
        }
      } else {
        n += last ? counted(whole.last, start, range.to, left) : counted(whole.day, start, end, left)
      }
      if (last) {
        break
      }
      from = end
    }
    return Math.min(n, limit)
  }

  /**
   * daysOf() thinned to `resolution` as getTimed() thins it, counted rather
   * than kept, up to `limit`: a day of rows at a time is read, and none is
   * held past it.
   */
  private countThinned(
    context: Context,
    range: TimeRange,
    levels: number[] | undefined,
    limit: number,
    resolution: number,
  ): number {
    let seen = 0
    let kept = 0
    let lastKept = Number.NEGATIVE_INFINITY
    let keptLast = false
    for (const { timestamp } of this.daysOf(context, range, levels)) {
      seen++
      keptLast = keeps(lastKept, timestamp, resolution)
      if (keptLast) {
        lastKept = timestamp
        if (++kept >= limit) {
          return limit
        }
      }
    }
    // As Thinner.finish(): two positions or fewer as they are, and the last
    // one kept whether or not its spacing allowed it.
    return seen <= 2 ? seen : Math.min(kept + (keptLast ? 0 : 1), limit)
  }

  /**
   * A context's positions in `range`, a day at a time and in the order
   * rowsFor() keeps. With `levels`, the days `significant` holds come from
   * it, only the positions at those levels; every other day is read whole.
   */
  private *daysOf(context: Context, range: TimeRange, levels: number[] | undefined): Generator<PositionRow> {
    const id = this.idOf(context)
    const refined = levels ? this.refinedDays(context) : undefined
    // One bound per side in every statement: given a second lower bound on
    // timestamp, SQLite enters the index at the first and filters on the other,
    // so each seek would scan from the start of the window again.
    //
    // Each read starts at the next recorded time, so a window spanning years
    // of gaps costs one seek per day that has positions, not one per day.
    const next = this.db.prepare(
      `SELECT timestamp FROM positions WHERE context_id = ?${inRange(range)} ORDER BY timestamp LIMIT 1`,
    )
    const day = ' AND timestamp >= ? AND timestamp < ?'
    // Ordered as rowsFor() orders them, so equal times keep the order they were stored in.
    const positions = 'SELECT timestamp, lat, lon FROM positions WHERE context_id = ?'
    const whole = {
      day: this.db.prepare(`${positions}${day} ORDER BY timestamp, rowid`),
      last: this.db.prepare(`${positions}${inRange(range)} ORDER BY timestamp, rowid`),
    }
    // Sorted below: read level by level, they come in level order.
    const significant =
      levels &&
      `SELECT position AS id, timestamp, lat, lon FROM significant INDEXED BY idx_significant_time WHERE context_id = ? AND level IN (${levels.join(', ')})`
    const byLevel =
      significant && refined
        ? { day: this.db.prepare(`${significant}${day}`), last: this.db.prepare(`${significant}${inRange(range)}`) }
        : undefined
    // The first and last position of the range, which a track read whole
    // starts and ends at. A range starting or ending inside a refined day
    // would otherwise start at the next position the level keeps, which on a
    // straight leg can be hours on.
    const edge = (order: string) =>
      this.db
        .prepare(
          `SELECT rowid AS id, timestamp, lat, lon FROM positions WHERE context_id = ?${inRange(range)} ORDER BY timestamp ${order}, rowid ${order} LIMIT 1`,
        )
        .get(id, range.from, range.to) as unknown as (PositionRow & { id: number }) | undefined
    const edges = byLevel ? [edge('ASC'), edge('DESC')] : []
    for (let from = range.from; ;) {
      const row = next.get(id, from, range.to) as { timestamp: number } | undefined
      if (!row) {
        return
      }
      const start = row.timestamp
      const end = (dayOf(start) + 1) * LEVEL_DAY_MS
      // The last day is the one the range ends in. One ending just as the
      // range does is read as any other: a position at its end is the next
      // day's.
      const last = end > range.to
      if (byLevel && isRefined(refined, dayOf(start))) {
        const rows = (last
          ? byLevel.last.all(id, start, range.to)
          : byLevel.day.all(id, start, end)) as unknown as (PositionRow & { id: number })[]
        for (const edge of edges) {
          if (edge && dayOf(edge.timestamp) === dayOf(start) && !rows.some(({ id }) => id === edge.id)) {
            rows.push(edge)
          }
        }
        yield* rows.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
      } else {
        yield* (last ? whole.last.all(id, start, range.to) : whole.day.all(id, start, end)) as unknown as PositionRow[]
      }
      if (last) {
        return
      }
      from = end
    }
  }

  /** The contexts the store holds positions for, in the order of their names. */
  private contexts(): Context[] {
    const rows = this.db
      .prepare(
        'SELECT context FROM contexts AS c WHERE EXISTS (SELECT 1 FROM positions WHERE context_id = c.id) ORDER BY context',
      )
      .all() as unknown as { context: Context }[]
    return rows.map(({ context }) => context)
  }

  /**
   * For a pass over the contexts in the order of their ids: the first one
   * after an id that the store holds positions for, as a seek per context.
   */
  private contextsAfter(): (id: number) => Context | undefined {
    const after = this.db.prepare('SELECT context_id FROM positions WHERE context_id > ? ORDER BY context_id LIMIT 1')
    return (id) => {
      const row = after.get(id) as { context_id: number } | undefined
      return row && this.nameOf(row.context_id)
    }
  }

  /** Those of `contexts` the store holds positions for, each found by an index seek. */
  private stored(contexts: Iterable<Context>): Context[] {
    const held = this.db.prepare('SELECT 1 AS found FROM positions WHERE context_id = ? LIMIT 1')
    return [...contexts].filter((context) => held.get(this.idOf(context)) !== undefined)
  }

  /**
   * Each context's track in a window as a listing describes it, without its
   * points: a list of every vessel over weeks would otherwise build every
   * position only to count them, then copy them all to the main thread.
   */
  summarize(contexts: Context[] | undefined, window?: TimeWindow): TrackSummary[] {
    const inWindow = window ? ['timestamp >= ?', window.inclusiveEnd ? 'timestamp <= ?' : 'timestamp < ?'] : []
    const windowParams = window ? [window.from, window.to] : []
    const clauses = [...(contexts ? [`context_id IN (${contexts.map(() => '?').join(', ')})`] : []), ...inWindow]
    const params = [...(contexts ?? []).map((context) => this.idOf(context)), ...windowParams]
    // A list of every vessel reads every row of the window from the index, in
    // vessel order and without touching the table: 0.6 s over 1.17 M rows,
    // against 1.5 s for one pass over the table.
    const rows = `FROM positions${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''}`
    // A track across the antimeridian spans the narrower way round, which
    // four longitudes settle for any track narrower than half the globe
    // (`longitudeSpanOf`). Grouping by every distinct longitude instead, to
    // find the widest gap, took 4.2 s over the same rows: one group per
    // position, nearly.
    const groups = this.db
      .prepare(
        `SELECT context_id, COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last,
                MIN(lat) AS south, MAX(lat) AS north, MIN(lon) AS lowest, MAX(lon) AS highest,
                MIN(lon) FILTER (WHERE lon >= 0) AS lowestEast, MAX(lon) FILTER (WHERE lon < 0) AS highestWest
         ${rows} GROUP BY context_id`,
      )
      .all(...params) as unknown as ({
      context_id: number
      count: number
      first: number
      last: number
      south: number
      north: number
    } & LongitudeExtremes)[]
    // A wider track needs every longitude, read for that vessel alone. This
    // worker's connection makes every write and this runs without yielding,
    // so the two statements read the same rows.
    const longitudes = this.db.prepare(
      `SELECT DISTINCT lon FROM positions WHERE ${['context_id = ?', ...inWindow].join(' AND ')}`,
    )
    // In the order of their names, as grouped by name they came.
    const summaries = groups.map(({ context_id: id, count, first, last, south, north, ...extremes }): TrackSummary => {
      const [west, east] =
        longitudeSpanOf(extremes) ??
        longitudeSpan((longitudes.all(id, ...windowParams) as unknown as { lon: number }[]).map(({ lon }) => lon))
      return { context: this.nameOf(id), pointCount: count, first, last, bbox: [west, south, east, north] }
    })
    return summaries.sort((a, b) => (a.context < b.context ? -1 : a.context > b.context ? 1 : 0))
  }

  getAllTracks(query?: TrackQuery): Promise<{ context: string; track: LatLngTuple[] }[]> {
    return Promise.all(
      this.contexts().map((context) =>
        this.getTimed(context, query?.window).then((points) => ({
          context,
          track: thin(points, query?.resolution).map(({ position }) => position),
        })),
      ),
    )
  }

  /**
   * Tracks matching the spatial predicate, which depends on who is asking.
   *
   * `intersects: false` — the v1 routes — matches a track's *last* position:
   * "which vessels are near me now". `intersects: true` — the v2 Track API —
   * matches a track that passed through the box at any point in the window,
   * including one that has since left.
   *
   * Two filters run, and they are not redundant despite both testing bounds:
   *
   * - `contextsInBounds` asks the cell index which contexts have *any* position
   *   near the box. It is a prefilter that keeps the query off every row in
   *   the table, and it decides nothing on its own. It runs only when no
   *   contexts are named, since their tracks are read anyway.
   * - `matcher` — the same predicate the in-memory store uses — then applies
   *   whichever rule the caller asked for. That test is authoritative.
   *
   * Because `matcher` has the final say, dropping the exact-bounds check inside
   * `contextsInBounds` does not change any result; it only widens the candidate
   * set. It is kept because a prefilter that returns half the table is not
   * worth running, not because correctness depends on it.
   */
  async getFilteredTracks(
    params: TrackParams,
    selfPosition?: LatLngTuple,
    debug?: Debug,
    query?: TrackQuery,
  ): Promise<TrackCollection> {
    const timed = await this.getFilteredTimedTracks(params, selfPosition, debug, query)
    return Object.fromEntries(
      Object.entries(timed).map(([context, points]) => [context, points.map(({ position }) => position)]),
    )
  }

  /**
   * The same filtering as `getFilteredTracks`, keeping each point's timestamp.
   *
   * The untimed form is derived from this one so the two cannot disagree about
   * which tracks match — both the cell prefilter and the authoritative
   * last-position test run once, here.
   */
  async getFilteredTimedTracks(
    params: TrackParams,
    selfPosition?: LatLngTuple,
    debug?: Debug,
    query?: TrackQuery,
  ): Promise<TimedTrackCollection> {
    const requested = params.contexts ? new Set(params.contexts) : undefined
    // A clipped query needs only the stretches near the box, so it reads those
    // instead of every position each candidate has in the window.
    const near =
      params.bbox && params.clip
        ? this.rowsNearBounds(params.bbox, query?.window, requested, query?.tolerance)
        : undefined
    // The cell prefilter reads every row of every vessel near the box, at any
    // time, so for named contexts, which are read anyway, it only adds cost: a
    // view over a busy harbour would turn one own-vessel query into a scan of
    // all its AIS traffic.
    const candidates = near
      ? new Set(near.keys())
      : params.bbox && !requested
        ? this.contextsInBounds(params.bbox)
        : undefined
    const matcher = createMatcher(params, selfPosition, debug)

    // Narrowed before reading: rows of a context that cannot be returned are
    // not worth fetching.
    const contexts = (requested ? this.stored(requested) : this.contexts()).filter(
      (context) => !candidates || candidates.has(context),
    )
    const tracks = await Promise.all(
      contexts.map((context) => {
        const rows = near?.get(context)
        const read = rows
          ? Promise.resolve(
              thin(
                rows.map((row) => (row.breakBefore ? { ...toTimed(row), breakBefore: true } : toTimed(row))),
                query?.resolution,
              ),
            )
          : this.getTimed(context, query?.window, query?.resolution, query?.tolerance)
        return read.then((points) => ({ context, points }))
      }),
    )
    return tracks.reduce<TimedTrackCollection>((acc, { context, points }) => {
      if (matcher(points.map(({ position }) => position))) {
        acc[context] = points
      }
      return acc
    }, {})
  }

  /** The cell index condition for rows near `bounds`, or none for an empty covering. */
  private coveringClause(bounds: GeoBounds): { where: string; params: bigint[]; cells: number } | undefined {
    const covering = coveringFor(bounds, this.maxCells)
    if (covering.length === 0) {
      return undefined
    }
    // Bound parameters, never interpolation: `BETWEEN ${start} <= s2cell AND
    // ${end}` parses as `s2cell BETWEEN (start <= s2cell) AND end`, collapsing
    // the lower bound to 0 or 1 so the range starts at zero and out-of-range
    // rows leak in.
    const ranges = covering.map(cellRange)
    return {
      where: ranges.map(() => '(s2cell BETWEEN ? AND ?)').join(' OR '),
      params: ranges.flatMap(({ start, end }) => [toSigned(start), toSigned(end)]),
      cells: covering.length,
    }
  }

  /** Contexts with at least one position inside `bounds`, via the cell index. */
  private contextsInBounds(bounds: GeoBounds): Set<string> {
    const found = new Set<string>()
    const clause = this.coveringClause(bounds)
    if (!clause) {
      return found
    }
    const { where, params, cells } = clause

    const stmt = this.db.prepare(`SELECT DISTINCT context_id, lat, lon FROM positions WHERE ${where}`)
    const rows = stmt.all(...params) as unknown as { context_id: number; lat: number; lon: number }[]

    const inBounds = createInBounds(bounds)
    for (const { context_id: id, lat, lon } of rows) {
      if (inBounds([lat, lon])) {
        found.add(this.nameOf(id))
      }
    }
    if (this.debug.enabled) {
      this.debug(`bbox covering ${cells} cells -> ${rows.length} rows -> ${found.size} contexts`)
    }
    return found
  }

  /**
   * The positions of named contexts within a cell covering, each read by
   * time or by cell, whichever reads fewer rows.
   *
   * Asked for the context and every range at once, SQLite chose the (context,
   * timestamp) index and walked each vessel's whole window, testing every row
   * against the covering: a view over a harbour visited once read years of
   * the own track. Read by cell, each range is one seek over the vessel's
   * rows inside it, at any time: the cost is the rows the box holds, the cost
   * by time the rows the window holds. So both are counted from an index
   * alone, the window only up to the box's count, and the window is read by
   * time only where it holds fewer: a short window over a box the vessel has
   * long been in. Each count stops at `readProbeLimit`; where both reach it,
   * both are counted once more to eight times that, so a day at one fix a
   * second, 86,400 rows, is told from a box of months.
   */
  private *namedNearBounds(
    contexts: Context[],
    clause: { where: string; params: bigint[] },
    inWindow: string,
    timeParams: number[],
  ): Generator<ContextRow> {
    const boxCount = this.db.prepare(
      'SELECT count(*) AS n FROM (SELECT 1 FROM positions INDEXED BY idx_context_s2cell WHERE context_id = ? AND s2cell BETWEEN ? AND ? LIMIT ?)',
    )
    const windowCount = this.db.prepare(
      `SELECT count(*) AS n FROM (SELECT 1 FROM positions INDEXED BY idx_context_time_position WHERE context_id = ?${inWindow} LIMIT ?)`,
    )
    let byTime: StatementSync | undefined
    let byCell: StatementSync | undefined
    for (const context of contexts) {
      const id = this.idOf(context)
      let boxRows = 0
      let windowRows = 0
      for (const limit of [this.readProbeLimit, 8 * this.readProbeLimit]) {
        boxRows = 0
        for (let i = 0; i < clause.params.length && boxRows < limit; i += 2) {
          const left = limit - boxRows
          boxRows += (boxCount.get(id, clause.params[i]!, clause.params[i + 1]!, left) as { n: number }).n
        }
        windowRows = boxRows > 0 ? (windowCount.get(id, ...timeParams, boxRows) as { n: number }).n : 0
        if (boxRows < limit || windowRows < boxRows) {
          break
        }
      }
      if (windowRows < boxRows) {
        byTime ??= this.db.prepare(
          `SELECT context_id, timestamp, lat, lon FROM positions INDEXED BY idx_context_time_position WHERE context_id = ? AND (${clause.where})${inWindow}`,
        )
        yield* byTime.all(id, ...clause.params, ...timeParams) as unknown as ContextRow[]
        continue
      }
      byCell ??= this.db.prepare(
        `SELECT context_id, timestamp, lat, lon FROM positions INDEXED BY idx_context_s2cell WHERE context_id = ? AND s2cell BETWEEN ? AND ?${inWindow}`,
      )
      for (let i = 0; i < clause.params.length; i += 2) {
        yield* byCell.all(id, clause.params[i]!, clause.params[i + 1]!, ...timeParams) as unknown as ContextRow[]
      }
    }
  }

  /**
   * Per context, the positions a track clipped to `bounds` is made of, and
   * only those: every position inside the box within the window, plus the one
   * either side of each stretch inside, which carries the line to the edge.
   *
   * The cell index finds the times a context was inside the box. Times closer
   * together than `stretchGap` are read as one stretch, including any
   * excursion outside it, since the clip that follows cuts those anyway;
   * further apart they are read separately and the time between is skipped.
   * Nothing between two stretches is inside the box, so skipping it loses
   * nothing the clip would keep: how they are grouped decides only how many
   * rows are read, never the result.
   *
   * With `contexts` given, only those are read. Every other vessel near the
   * box would be dropped afterwards, and over a busy anchorage reading them
   * costs seconds: the box holds all the AIS traffic ever recorded there, and
   * SQLite answers the unnarrowed read by walking the whole (context,
   * timestamp) index.
   */
  private rowsNearBounds(
    bounds: GeoBounds,
    window?: TimeWindow,
    contexts?: ReadonlySet<Context>,
    tolerance?: number,
  ): Map<Context, NumberedRow[]> {
    const near = new Map<Context, NumberedRow[]>()
    const clause = this.coveringClause(bounds)
    if (!clause) {
      return near
    }
    // Only named vessels are read by level: without them the cell index
    // serves every vessel near the box, and `significant` has none.
    const levels = contexts ? this.levelsFrom(tolerance) : undefined
    if (contexts && levels) {
      return this.nearBoundsByLevel(bounds, clause, window, [...contexts], levels)
    }
    const timeClauses = window ? ['timestamp >= ?', window.inclusiveEnd ? 'timestamp <= ?' : 'timestamp < ?'] : []
    const timeParams = window ? [window.from, window.to] : []
    const inWindow = timeClauses.map((c) => ` AND ${c}`).join('')
    const named = contexts ? [...contexts] : []

    const inside: Iterable<ContextRow> = contexts
      ? this.namedNearBounds(named, clause, inWindow, timeParams)
      : (this.db
          .prepare(
            `SELECT context_id, timestamp, lat, lon FROM positions WHERE (${clause.where})${inWindow} ORDER BY context_id, timestamp`,
          )
          .all(...clause.params, ...timeParams) as unknown as ContextRow[])
    const inBounds = createInBounds(bounds)
    const times = new Map<number, number[]>()
    let insideRows = 0
    for (const { context_id: id, timestamp, lat, lon } of inside) {
      insideRows++
      if (inBounds([lat, lon])) {
        const list = times.get(id)
        if (list) {
          list.push(timestamp)
        } else {
          times.set(id, [timestamp])
        }
      }
    }
    // Read range by range, the named contexts' times can come in cell order.
    if (contexts) {
      for (const list of times.values()) {
        list.sort((a, b) => a - b)
      }
    }

    const columns = 'SELECT rowid AS id, timestamp, lat, lon FROM positions WHERE context_id = ?'
    const between = this.db.prepare(`${columns} AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp, rowid`)
    const before = this.db.prepare(
      `${columns} AND timestamp < ?${inWindow} ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
    )
    const after = this.db.prepare(`${columns} AND timestamp > ?${inWindow} ORDER BY timestamp, rowid LIMIT 1`)
    // The row after one in the order rows are kept: by time, then by row
    // among those recorded at the same time.
    const sameTime = this.db.prepare(`${columns} AND timestamp = ? AND rowid > ? ORDER BY rowid LIMIT 1`)
    const nextAfter = (id: number, row: NumberedRow) =>
      (sameTime.get(id, row.timestamp, row.id) ?? after.get(id, row.timestamp, ...timeParams)) as unknown as
        NumberedRow | undefined
    for (const [id, list] of times) {
      const rows = new Map<number, NumberedRow>()
      let last: NumberedRow | undefined
      for (const [start, end] of stretchesOf(list, this.stretchGap)) {
        const read = [
          ...(before.all(id, start, ...timeParams) as unknown as NumberedRow[]),
          ...(between.all(id, start, end) as unknown as NumberedRow[]),
          ...(after.all(id, end, ...timeParams) as unknown as NumberedRow[]),
        ]
        // A stretch read apart from the one before leaves out what was
        // recorded between them. Marked, so the clip draws no line from one
        // to the other: across the box, it would be one never sailed.
        const first = read[0]
        if (last && first && !rows.has(first.id) && nextAfter(id, last)?.id !== first.id) {
          first.breakBefore = true
        }
        // Keyed by row: where nothing was recorded between two stretches, one's
        // neighbour is the other's first or last row.
        for (const row of read) {
          rows.set(row.id, row)
        }
        last = read.at(-1)
      }
      near.set(
        this.nameOf(id),
        [...rows.values()].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
      )
    }
    if (this.debug.enabled) {
      this.debug(`clip covering ${clause.cells} cells -> ${insideRows} rows -> ${near.size} contexts`)
    }
    return near
  }

  /** The levels a read at `tolerance` metres needs, or undefined to read every position. */
  private levelsFrom(tolerance: number | undefined): number[] | undefined {
    if (tolerance === undefined || !(tolerance > 0)) {
      return undefined
    }
    const lowest = Math.min(Math.floor(Math.log2(tolerance / LEVEL_BASE_M)), KEEP_LEVEL)
    if (!(lowest >= MIN_READ_LEVEL)) {
      return undefined
    }
    return levelsUp(lowest)
  }

  /** The days of a context `significant` holds, or undefined while it holds none. */
  private refinedDays(context: Context): RefinedDays | undefined {
    const through = this.levelFrontier.get(context)
    if (through === undefined) {
      return undefined
    }
    const stale = this.db.prepare('SELECT day FROM level_stale WHERE context = ?').all(context) as unknown as {
      day: number
    }[]
    return { through, stale: new Set(stale.map(({ day }) => day)) }
  }

  /**
   * rowsNearBounds() for named contexts at a tolerance: what the track
   * simplified to it is made of near `bounds`. Where `significant` holds the
   * day, the times the vessel was in the box are the hours `level_visits`
   * has it in a cell the box overlaps: the positions a level keeps there can
   * be none at all, only a line across it, which the clip then draws. Each
   * stretch around those times is read from `significant` at `levels`, with
   * the nearest position kept either side. The rest of the window is read
   * from positions as without a tolerance, so a track reads the same before
   * its days are refined as after, but for the positions the tolerance
   * leaves out. The window's first and last positions count as kept, as in
   * `getTimed`.
   *
   * What `significant` holds of a day not refined, one a change sent back
   * while it was being refined again, is in positions too: read from there
   * for that day, those rows only repeat, and are never nearer as a
   * neighbour.
   */
  private nearBoundsByLevel(
    bounds: GeoBounds,
    clause: { where: string; params: bigint[]; cells: number },
    window: TimeWindow | undefined,
    contexts: Context[],
    levels: number[],
  ): Map<Context, NumberedRow[]> {
    const near = new Map<Context, NumberedRow[]>()
    const range: TimeRange = window
      ? { from: window.from, to: window.to, inclusiveEnd: window.inclusiveEnd === true }
      : { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY, inclusiveEnd: true }
    const inBounds = createInBounds(bounds)
    // Each shape of range is a statement of its own; most repeat per stretch.
    const statements = new Map<string, StatementSync>()
    const query = (sql: string): StatementSync => {
      let statement = statements.get(sql)
      if (!statement) {
        statement = this.db.prepare(sql)
        statements.set(sql, statement)
      }
      return statement
    }
    const fromSignificant = `SELECT position AS id, timestamp, lat, lon FROM significant INDEXED BY idx_significant_time WHERE context_id = ?`
    const fromPositions = 'SELECT rowid AS id, timestamp, lat, lon FROM positions WHERE context_id = ?'
    const visited = this.db.prepare(
      `SELECT DISTINCT hour FROM level_visits
       WHERE context_id = ? AND lat_cell BETWEEN ? AND ? AND lon_cell BETWEEN ? AND ? AND hour >= ? AND hour <= ?`,
    )
    const cells = splitAtAntimeridian(bounds).map(({ sw, ne }) => [
      visitCell(sw[0]),
      visitCell(ne[0]),
      visitCell(sw[1]),
      visitCell(ne[1]),
    ])
    const later = (a: NumberedRow, b: NumberedRow) =>
      a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.id > b.id)
    let insideRows = 0
    for (const context of contexts) {
      const id = this.idOf(context)
      const refined = this.refinedDays(context)

      const times: number[] = []
      for (const part of unrefinedIn(refined, range)) {
        for (const { timestamp, lat, lon } of this.namedNearBounds([context], clause, inRange(part), [
          part.from,
          part.to,
        ])) {
          insideRows++
          if (inBounds([lat, lon])) {
            times.push(timestamp)
          }
        }
      }
      const held = refinedIn(refined, range)
      if (held) {
        const first = Math.floor(held.from / VISIT_HOUR_MS)
        const last = Math.floor(held.to / VISIT_HOUR_MS)
        for (const [south, north, west, east] of cells) {
          for (const { hour } of visited.all(id, south!, north!, west!, east!, first, last) as unknown as {
            hour: number
          }[]) {
            insideRows++
            const start = hour * VISIT_HOUR_MS
            if (isRefined(refined, dayOf(start))) {
              times.push(Math.max(start, held.from), Math.min(start + VISIT_HOUR_MS, held.to))
            }
          }
        }
      }
      if (times.length === 0) {
        continue
      }
      times.sort((a, b) => a - b)

      const edge = (order: string) =>
        query(`${fromPositions}${inRange(range)} ORDER BY timestamp ${order}, rowid ${order} LIMIT 1`).get(
          id,
          range.from,
          range.to,
        ) as unknown as NumberedRow | undefined
      const edges = [edge('ASC'), edge('DESC')].filter((row) => row !== undefined)

      // The position next to a stretch that the read keeps, the nearest of a
      // seek per level into the days `significant` holds, one into each part
      // of the window it does not, and the window's ends.
      const neighbour = (time: number, before: boolean): NumberedRow | undefined => {
        const side: TimeRange = before
          ? { from: range.from, to: time, inclusiveEnd: false }
          : { from: time, to: range.to, inclusiveEnd: range.inclusiveEnd, exclusiveStart: true }
        const order = before ? 'DESC' : 'ASC'
        const nearer = (a: NumberedRow, b: NumberedRow | undefined) => !b || (before ? later(a, b) : later(b, a))
        let found: NumberedRow | undefined
        const parts = unrefinedIn(refined, side)
        for (const part of before ? parts.reverse() : parts) {
          found = query(`${fromPositions}${inRange(part)} ORDER BY timestamp ${order}, rowid ${order} LIMIT 1`).get(
            id,
            part.from,
            part.to,
          ) as unknown as NumberedRow | undefined
          if (found) {
            break
          }
        }
        const held = refinedIn(refined, side)
        if (held) {
          const seek = query(
            `${fromSignificant} AND level = ?${inRange(held)} ORDER BY timestamp ${order}, rowid ${order} LIMIT 1`,
          )
          for (const level of levels) {
            const row = seek.get(id, level, held.from, held.to) as unknown as NumberedRow | undefined
            if (row && nearer(row, found)) {
              found = row
            }
          }
        }
        for (const row of edges) {
          if ((before ? row.timestamp < time : row.timestamp > time) && nearer(row, found)) {
            found = row
          }
        }
        return found
      }

      // Read by level, the times inside the box are hours and the few
      // positions that carry its shape, often hours apart. Grouped at the
      // usual gap they make a stretch each, and three reads apiece.
      const longGap = Math.max(this.stretchGap, LEVEL_DAY_MS)
      const rows = new Map<number, NumberedRow>()
      const stretches = stretchesOf(times, (last, time) =>
        isRefined(refined, dayOf(last)) && isRefined(refined, dayOf(time)) ? longGap : this.stretchGap,
      )
      let last: NumberedRow | undefined
      for (const [start, end] of stretches) {
        const earlier = rows.size
        // An hour can end where the window does, which may leave its end out.
        const stretch: TimeRange = { from: start, to: end, inclusiveEnd: end < range.to || range.inclusiveEnd }
        const held = refinedIn(refined, stretch)
        if (held) {
          const read = query(`${fromSignificant} AND level IN (${levels.join(', ')})${inRange(held)}`).all(
            id,
            held.from,
            held.to,
          ) as unknown as NumberedRow[]
          for (const row of read) {
            rows.set(row.id, row)
          }
        }
        for (const part of unrefinedIn(refined, stretch)) {
          for (const row of query(`${fromPositions}${inRange(part)}`).all(
            id,
            part.from,
            part.to,
          ) as unknown as NumberedRow[]) {
            rows.set(row.id, row)
          }
        }
        for (const row of edges) {
          if (row.timestamp >= start && row.timestamp <= end) {
            rows.set(row.id, row)
          }
        }
        // Keyed by row: where nothing was kept between two stretches, one's
        // neighbour is the other's first or last row.
        const entry = neighbour(start, true)
        const exit = neighbour(end, false)
        for (const row of [entry, exit]) {
          if (row) {
            rows.set(row.id, row)
          }
        }
        // A stretch read apart from the one before leaves out what the
        // level keeps between them, as rowsNearBounds() marks it.
        const first =
          entry ?? [...rows.values()].slice(earlier).sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)[0]
        // Recorded at the same time as the last, it follows it: the seek
        // past that time would step over it.
        if (last && first && first.timestamp > last.timestamp && neighbour(last.timestamp, false)?.id !== first.id) {
          first.breakBefore = true
        }
        last = exit ?? last
      }
      near.set(
        context,
        [...rows.values()].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
      )
    }
    if (this.debug.enabled) {
      this.debug(
        `clip covering ${clause.cells} cells at levels ${levels[0]}+ -> ${insideRows} rows and hours -> ${near.size} contexts`,
      )
    }
    return near
  }

  /**
   * Give finished days their significant positions, refining about
   * `refineBudget` positions per call.
   *
   * A day is finished once it ended more than DETAIL_KEEP ago: by then
   * `prune()` has thinned its detail, which would otherwise take positions
   * out from under their levels. Each day is refined in pieces, split where
   * the recording stopped for longer than CLIP_STRETCH_GAP and cut at
   * LEVEL_PIECE_MAX, each simplified on its own, so a day's levels never
   * depend on another day's positions and a new day never changes an old
   * one's. A call that runs out of budget inside a day goes on from there
   * next time. Days a change sent back come first; then each context's days
   * after its frontier, the pass picking up where the last call stopped. Once
   * a pass finds nothing left to do, calls cost nothing until another day
   * finishes.
   *
   * Returns whether the call stopped with work left, so the caller can come
   * back sooner while there is a backlog.
   */
  refineLevels(now = Date.now()): boolean {
    const lastDay = dayOf(now - DETAIL_KEEP) - 1
    let budget = this.refineBudget
    const partial = this.refinePartial
    if (partial) {
      this.refinePartial = undefined
      budget = this.refineDay(partial.context, partial.day, partial.next, budget, partial.stale)
      if (this.refinePartial || budget <= 0) {
        return true
      }
    }
    const stale = this.db.prepare('SELECT context, day FROM level_stale LIMIT 64')
    for (
      let batch = stale.all() as { context: string; day: number }[];
      batch.length > 0;
      batch = stale.all() as { context: string; day: number }[]
    ) {
      for (const { context, day } of batch) {
        budget = this.refineDay(context, day, Number.NEGATIVE_INFINITY, budget, true)
        if (this.refinePartial || budget <= 0) {
          return true
        }
      }
    }
    if (this.refinedThrough === lastDay) {
      return this.simplifyStored(lastDay, budget)
    }
    const contextAfter = this.contextsAfter()
    const firstAt = this.db.prepare(
      'SELECT timestamp FROM positions WHERE context_id = ? AND timestamp >= ? ORDER BY timestamp LIMIT 1',
    )
    let context = this.refineResume ?? contextAfter(0)
    this.refineResume = undefined
    while (context !== undefined) {
      for (;;) {
        const through = this.levelFrontier.get(context)
        const row = firstAt.get(
          this.idOf(context),
          through === undefined ? Number.NEGATIVE_INFINITY : (through + 1) * LEVEL_DAY_MS,
        ) as { timestamp: number } | undefined
        if (!row || dayOf(row.timestamp) > lastDay) {
          break
        }
        budget = this.refineDay(context, dayOf(row.timestamp), Number.NEGATIVE_INFINITY, budget, false)
        if (this.refinePartial || budget <= 0) {
          this.refineResume = context
          return true
        }
      }
      context = contextAfter(this.idOf(context))
    }
    this.refinedThrough = lastDay
    return this.simplifyStored(lastDay, budget)
  }

  /**
   * Refine a context's day from `from` on, piece by piece while the budget
   * lasts, resolving to the budget left. Stopping inside the day leaves it in
   * refinePartial; finishing it takes it off level_stale, or moves the
   * context's frontier to it.
   *
   * Only what the budget can take is read, and a piece the read stops inside
   * is left for the next call: a day at one fix a second is 86,400 rows, and
   * reading all that is left of it on every call would cost as much as the
   * refining.
   */
  private refineDay(context: Context, day: number, from: number, budget: number, stale: boolean): number {
    budget -= REFINE_DAY_COST
    const statements = this.refining()
    const dayStart = day * LEVEL_DAY_MS
    const dayEnd = dayStart + LEVEL_DAY_MS
    if (from === Number.NEGATIVE_INFINITY) {
      // A day a restart stopped inside, its place in it lost, starts over.
      // The pass clears back to the frontier: a day it stopped inside may
      // have been emptied since, and it is about to go past that day.
      const through = this.levelFrontier.get(context)
      const clearFrom = stale
        ? dayStart
        : through === undefined
          ? Number.NEGATIVE_INFINITY
          : (through + 1) * LEVEL_DAY_MS
      this.deleteSignificant(context, clearFrom, dayEnd)
    }
    const id = this.idOf(context)
    const read = (limit: number) =>
      statements.select.all(id, Math.max(from, dayStart), dayEnd, limit) as unknown as (PositionRow & {
        id: number
      })[]
    const limit = budget + LEVEL_PIECE_MAX
    let rows = read(limit)
    let cuts = this.piecesOf(rows)
    if (rows.length === limit) {
      // The read stopped inside its last piece, which waits for the next call.
      cuts.pop()
      // No piece ends inside the read, which takes a run of equal times as
      // long as an untimed track: read the rest of the day.
      if (cuts.length < 2) {
        rows = read(-1)
        cuts = this.piecesOf(rows)
      }
    }
    const visits = new Set<string>()
    let stopped = false
    for (let p = 1; p < cuts.length; p++) {
      const piece = rows.slice(cuts[p - 1], cuts[p])
      const values = significance(piece.map(toTimed))
      for (const [i, row] of piece.entries()) {
        const level = levelOf(values[i]!)
        if (level >= MIN_READ_LEVEL) {
          statements.copy.run(level, row.id)
        }
        visits.add(`${visitCell(row.lat)} ${visitCell(row.lon)} ${Math.floor(row.timestamp / VISIT_HOUR_MS)}`)
      }
      budget -= piece.length
      const next = rows[cuts[p]!]
      if (next && (budget <= 0 || p === cuts.length - 1)) {
        this.refinePartial = { context, day, next: next.timestamp, stale }
        stopped = true
        break
      }
    }
    for (const key of visits) {
      statements.visit.run(id, ...key.split(' ').map(Number))
    }
    if (stopped) {
      return budget
    }
    if (stale) {
      statements.unstale.run(context, day)
    } else {
      statements.frontier.run(context, day)
      this.levelFrontier.set(context, day)
      // A day refined is one more to simplify.
      this.simplifiedThrough = undefined
    }
    return budget
  }

  /** refineDay()'s statements, prepared once: it runs for every day of every vessel. */
  private refining() {
    return (this.refineStatements ??= {
      select: this.db.prepare(
        'SELECT rowid AS id, timestamp, lat, lon FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?',
      ),
      copy: this.db.prepare(
        `INSERT INTO significant (position, context_id, timestamp, lat, lon, level)
         SELECT rowid, context_id, timestamp, lat, lon, ? FROM positions WHERE rowid = ?`,
      ),
      visit: this.db.prepare(
        'INSERT OR IGNORE INTO level_visits (context_id, lat_cell, lon_cell, hour) VALUES (?, ?, ?, ?)',
      ),
      unstale: this.db.prepare('DELETE FROM level_stale WHERE context = ? AND day = ?'),
      frontier: this.db.prepare(
        'INSERT INTO level_frontier (context, through) VALUES (?, ?) ON CONFLICT(context) DO UPDATE SET through = excluded.through',
      ),
      // Every level named, so each is a seek on the time index, not a walk over the context's rows.
      deleteSignificant: this.db.prepare(
        `DELETE FROM significant WHERE context_id = ? AND level IN (${SIGNIFICANT_LEVELS}) AND timestamp >= ? AND timestamp < ?`,
      ),
      deleteVisits: this.db.prepare('DELETE FROM level_visits WHERE context_id = ? AND hour >= ? AND hour < ?'),
    })
  }

  /**
   * Delete the positions of refined days that simplifying to
   * `storageTolerance` leaves out, keeping one at least every STORED_GAP_MAX
   * where the recording had one (`storedKeep`), and every position
   * `significant` holds. About `refineBudget` positions per call, each one
   * deleted counting once more, once refineLevels() has nothing left, so no
   * day is stale: days a change sent back first, then each context's refined
   * days after its frontier. Returns whether it stopped with work left.
   *
   * A frontier reached at a smaller tolerance counts for none, so raising
   * the tolerance goes over every day again. Lowering it brings nothing
   * back: what is deleted is gone.
   *
   * It leaves the levels as they are, with no invalidateLevels(): what it
   * deletes is below every level, and simplifying what remains to any
   * tolerance from this one up gives what simplifying every position did.
   */
  private simplifyStored(lastDay: number, budget: number): boolean {
    if (!(this.storageTolerance > 0)) {
      return false
    }
    if (budget <= 0) {
      return true
    }
    const partial = this.simplifyPartial
    if (partial) {
      this.simplifyPartial = undefined
      budget = this.simplifyDay(partial.context, partial.day, partial.next, budget, partial.pending)
      if (this.simplifyPartial || budget <= 0) {
        return true
      }
    }
    const pending = this.db.prepare('SELECT context, day FROM simplify_pending LIMIT 64')
    for (
      let batch = pending.all() as { context: string; day: number }[];
      batch.length > 0;
      batch = pending.all() as { context: string; day: number }[]
    ) {
      for (const { context, day } of batch) {
        budget = this.simplifyDay(context, day, Number.NEGATIVE_INFINITY, budget, true)
        if (this.simplifyPartial || budget <= 0) {
          return true
        }
      }
    }
    if (this.simplifiedThrough === lastDay) {
      return false
    }
    const contextAfter = this.contextsAfter()
    const firstAt = this.db.prepare(
      'SELECT timestamp FROM positions WHERE context_id = ? AND timestamp >= ? ORDER BY timestamp LIMIT 1',
    )
    let context = this.simplifyResume ?? contextAfter(0)
    this.simplifyResume = undefined
    while (context !== undefined) {
      const refined = this.levelFrontier.get(context)
      for (;;) {
        const through = this.simplifiedDay(context)
        const row = firstAt.get(
          this.idOf(context),
          through === undefined ? Number.NEGATIVE_INFINITY : (through + 1) * LEVEL_DAY_MS,
        ) as { timestamp: number } | undefined
        if (!row || refined === undefined || dayOf(row.timestamp) > refined) {
          break
        }
        budget = this.simplifyDay(context, dayOf(row.timestamp), Number.NEGATIVE_INFINITY, budget, false)
        if (this.simplifyPartial || budget <= 0) {
          this.simplifyResume = context
          return true
        }
      }
      context = contextAfter(this.idOf(context))
    }
    this.simplifiedThrough = lastDay
    return false
  }

  /** The last day simplifyStored() has gone through for a context at the store's tolerance or a larger one. */
  private simplifiedDay(context: Context): number | undefined {
    const frontier = this.simplifyFrontier.get(context)
    return frontier && frontier.tolerance >= this.storageTolerance ? frontier.through : undefined
  }

  /**
   * Simplify a context's refined day from `from` on, piece by piece as
   * refineDay() refines it, while the budget lasts, resolving to the budget
   * left. Stopping inside the day leaves it in simplifyPartial; finishing it
   * takes it off simplify_pending, or moves the frontier to it.
   */
  private simplifyDay(context: Context, day: number, from: number, budget: number, pending: boolean): number {
    budget -= REFINE_DAY_COST
    const statements = this.simplifying()
    const dayStart = day * LEVEL_DAY_MS
    const dayEnd = dayStart + LEVEL_DAY_MS
    const id = this.idOf(context)
    if (from === Number.NEGATIVE_INFINITY) {
      const written = statements.written.get(context, day) as { tolerance: number; positions: number } | undefined
      if (written) {
        statements.unwritten.run(context, day)
        // Simplifying it again would not give what simplifying every position
        // did: its pieces are cut where the import's were, not where what is
        // left would cut them. Unless a fix came in since without
        // invalidateLevels(), as a live one dated into a day not refined yet
        // does.
        if (
          written.tolerance >= this.storageTolerance &&
          (statements.count.get(id, dayStart, dayEnd) as { n: number }).n === written.positions
        ) {
          this.simplifiedDayDone(context, day, pending)
          return budget
        }
      }
    }
    const read = (limit: number) =>
      statements.select.all(id, Math.max(from, dayStart), dayEnd, limit) as unknown as (PositionRow & {
        id: number
      })[]
    const limit = budget + LEVEL_PIECE_MAX
    let rows = read(limit)
    let cuts = this.piecesOf(rows)
    if (rows.length === limit) {
      cuts.pop()
      if (cuts.length < 2) {
        rows = read(-1)
        cuts = this.piecesOf(rows)
      }
    }
    const held = new Set(
      (statements.held.all(id, dayStart, dayEnd) as unknown as { position: number }[]).map(({ position }) => position),
    )
    let stopped = false
    for (let p = 1; p < cuts.length; p++) {
      const piece = rows.slice(cuts[p - 1], cuts[p])
      const keep = storedKeep(piece, significance(piece.map(toTimed)), this.storageTolerance)
      let deleted = 0
      for (const [i, row] of piece.entries()) {
        if (!keep[i] && !held.has(row.id)) {
          statements.remove.run(row.id)
          deleted++
        }
      }
      budget -= piece.length + deleted
      const next = rows[cuts[p]!]
      if (next && (budget <= 0 || p === cuts.length - 1)) {
        this.simplifyPartial = { context, day, next: next.timestamp, pending }
        stopped = true
        break
      }
    }
    if (!stopped) {
      this.simplifiedDayDone(context, day, pending)
    }
    return budget
  }

  /** Take a day simplifyDay() finished off simplify_pending, or move the frontier to it. */
  private simplifiedDayDone(context: Context, day: number, pending: boolean): void {
    const statements = this.simplifying()
    if (pending) {
      statements.done.run(context, day)
    } else {
      statements.frontier.run(context, day, this.storageTolerance)
      this.simplifyFrontier.set(context, { through: day, tolerance: this.storageTolerance })
    }
  }

  /** simplifyDay()'s statements, prepared once. */
  private simplifying() {
    return (this.simplifyStatements ??= {
      select: this.db.prepare(
        'SELECT rowid AS id, timestamp, lat, lon FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?',
      ),
      held: this.db.prepare(
        `SELECT position FROM significant WHERE context_id = ? AND level IN (${SIGNIFICANT_LEVELS}) AND timestamp >= ? AND timestamp < ?`,
      ),
      remove: this.db.prepare('DELETE FROM positions WHERE rowid = ?'),
      written: this.db.prepare('SELECT tolerance, positions FROM simplified_days WHERE context = ? AND day = ?'),
      unwritten: this.db.prepare('DELETE FROM simplified_days WHERE context = ? AND day = ?'),
      count: this.db.prepare(
        'SELECT count(*) AS n FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp < ?',
      ),
      mark: this.db.prepare(
        `INSERT INTO simplified_days (context, day, tolerance, positions) VALUES (?, ?, ?, ?)
         ON CONFLICT(context, day) DO UPDATE SET tolerance = excluded.tolerance, positions = excluded.positions`,
      ),
      // Only a day whose count the change moved: a change is a write or a
      // delete, never both, and its span can reach over days it left alone.
      unwrite: this.db.prepare(
        `DELETE FROM simplified_days WHERE context = ? AND day >= ? AND day <= ? AND positions !=
           (SELECT count(*) FROM positions p
              WHERE p.context_id = (SELECT id FROM contexts WHERE context = simplified_days.context)
              AND p.timestamp >= simplified_days.day * ${LEVEL_DAY_MS}
              AND p.timestamp < (simplified_days.day + 1) * ${LEVEL_DAY_MS})`,
      ),
      recorded: this.db.prepare(
        'SELECT 1 AS found FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp < ? LIMIT 1',
      ),
      done: this.db.prepare('DELETE FROM simplify_pending WHERE context = ? AND day = ?'),
      frontier: this.db.prepare(
        `INSERT INTO simplify_frontier (context, through, tolerance) VALUES (?, ?, ?)
         ON CONFLICT(context) DO UPDATE SET through = excluded.through, tolerance = excluded.tolerance`,
      ),
    })
  }

  /**
   * Where rows, in time order, split into the pieces refineDay() simplifies
   * one by one: indexes of the first row of each, and the end of the rows.
   * Cut only where the time moves on, so going on from a time never takes in
   * a position refined already.
   */
  private piecesOf(rows: { timestamp: number }[]): number[] {
    const cuts = [0]
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]!.timestamp - rows[i - 1]!.timestamp
      if (gap > CLIP_STRETCH_GAP || (i - cuts.at(-1)! >= LEVEL_PIECE_MAX && gap > 0)) {
        cuts.push(i)
      }
    }
    if (rows.length > 0) {
      cuts.push(rows.length)
    }
    return cuts
  }

  /**
   * Send the refined days a change to positions touched back to be refined
   * again, and take their significant positions out until then. They were
   * measured against positions that have since gone or come: a read could
   * otherwise draw a position that is gone, or leave out one the change made
   * significant.
   *
   * Called by every write that changes the positions of a day: a fix dated
   * into a refined day, `initialTrack` (through `clearLevels`), `recordTrack`,
   * `fillTrack`, `saveHistoryImport`, `binRecorded`, `restoreFromBin`, both
   * retentions and detail thinning. A stay still going on, thinned at the
   * spacing of the last prune, sends back only what aged since then, so its
   * days are not refined again every hour. simplifyStored() alone deletes
   * without it; see there.
   */
  private invalidateLevels(context: Context, from: number, to: number): void {
    // A day an import wrote simplified is so no longer once it changes.
    this.simplifying().unwrite.run(context, dayOf(from), dayOf(to))
    const through = this.levelFrontier.get(context)
    // A day refined in part starts over when the change reaches it. One the
    // pass is in does too when the change reaches any day between it and the
    // frontier: finishing it would move the frontier past that day, which
    // would then count as refined with nothing in `significant`.
    const partial = this.refinePartial
    const reached = partial?.stale ? partial.day <= dayOf(to) : dayOf(to) > (through ?? Number.NEGATIVE_INFINITY)
    if (partial?.context === context && dayOf(from) <= partial.day && reached) {
      this.deleteSignificant(context, partial.day * LEVEL_DAY_MS, (partial.day + 1) * LEVEL_DAY_MS)
      this.refinePartial = undefined
      this.refinedThrough = undefined
    }
    if (through === undefined || dayOf(to) > through) {
      // The pass that last found nothing left to do may have been past these
      // days before the change came.
      this.refinedThrough = undefined
    }
    if (through === undefined) {
      return
    }
    const first = dayOf(from)
    const last = Math.min(dayOf(to), through)
    if (first > last) {
      return
    }
    const end = (last + 1) * LEVEL_DAY_MS
    this.deleteSignificant(context, first * LEVEL_DAY_MS, end)
    // Queued only where positions are left: a day emptied has nothing to refine.
    const next = this.db.prepare(
      'SELECT timestamp FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp LIMIT 1',
    )
    const queue = this.db.prepare('INSERT OR IGNORE INTO level_stale (context, day) VALUES (?, ?)')
    // A day simplified already is simplified again once refined again, for
    // what the change brought in.
    const simplified = this.simplifiedDay(context)
    const resimplify = this.db.prepare('INSERT OR IGNORE INTO simplify_pending (context, day) VALUES (?, ?)')
    for (let day = first; day <= last;) {
      const row = next.get(this.idOf(context), day * LEVEL_DAY_MS, end) as { timestamp: number } | undefined
      if (!row) {
        break
      }
      day = dayOf(row.timestamp)
      queue.run(context, day)
      if (simplified !== undefined && day <= simplified) {
        resimplify.run(context, day)
      }
      day++
    }
    // A day simplified in part starts over: its rows changed under it.
    const simplifying = this.simplifyPartial
    if (simplifying?.context === context && first <= simplifying.day && simplifying.day <= last) {
      this.simplifyPartial = undefined
    }
    this.simplifiedThrough = undefined
  }

  /** Take a context's significant positions, and its visits, from `from` until `to` out. */
  private deleteSignificant(context: Context, from: number, to: number): void {
    const statements = this.refining()
    const id = this.idOf(context)
    statements.deleteSignificant.run(id, from, to)
    statements.deleteVisits.run(id, Math.floor(from / VISIT_HOUR_MS), Math.ceil(to / VISIT_HOUR_MS))
  }

  /** Forget a context's levels, for one whose positions are all gone or replaced. */
  private clearLevels(context: Context): void {
    this.db.prepare('DELETE FROM significant WHERE context_id = ?').run(this.idOf(context))
    this.db.prepare('DELETE FROM level_visits WHERE context_id = ?').run(this.idOf(context))
    this.db.prepare('DELETE FROM level_frontier WHERE context = ?').run(context)
    this.db.prepare('DELETE FROM level_stale WHERE context = ?').run(context)
    this.db.prepare('DELETE FROM simplify_frontier WHERE context = ?').run(context)
    this.db.prepare('DELETE FROM simplify_pending WHERE context = ?').run(context)
    this.db.prepare('DELETE FROM simplified_days WHERE context = ?').run(context)
    this.levelFrontier.delete(context)
    this.simplifyFrontier.delete(context)
    this.refinedThrough = undefined
    this.simplifiedThrough = undefined
    if (this.refinePartial?.context === context) {
      this.refinePartial = undefined
    }
    if (this.simplifyPartial?.context === context) {
      this.simplifyPartial = undefined
    }
  }

  /**
   * Split a context's positions into segments, breaking where the recording
   * stopped for longer than `segmentGap` — an overnight stop should not draw a
   * straight line across the anchorage.
   */
  segments(context: Context, window?: TimeWindow): LatLngTuple[][] {
    const rows = this.rowsFor(context, window)
    const result: LatLngTuple[][] = []
    let current: LatLngTuple[] = []
    let previous: number | undefined
    for (const { lat, lon, timestamp } of rows) {
      if (previous !== undefined && timestamp - previous > this.segmentGap) {
        result.push(current)
        current = []
      }
      current.push([lat, lon])
      previous = timestamp
    }
    if (current.length > 0) {
      result.push(current)
    }
    return result
  }

  recordName(context: Context, name: string, timestamp: number = Date.now()): void {
    const trimmed = name.trim()
    if (trimmed === '') {
      return
    }
    const seen = this.lastName.get(context)
    if (seen && seen.timestamp > timestamp) {
      return
    }
    if (seen?.name === trimmed) {
      seen.timestamp = timestamp
      return
    }
    if (Number(this.insertName.run(context, trimmed, timestamp).changes) > 0) {
      this.lastName.set(context, { name: trimmed, timestamp })
    }
  }

  nameFor(context: Context): string | undefined {
    const row = this.selectName.get(context) as { name?: string } | undefined
    return row?.name
  }

  /**
   * Age out other vessels position by position, as `TrackStore.prune`
   * describes: a vessel that stays in range would otherwise keep every row.
   */
  prune(maxAge: number, keep?: Context, now = Date.now()): void {
    const cutoff = now - maxAge
    // Per context through the (context_id, timestamp) index rather than one
    // DELETE over the table: that index cannot seek on a timestamp alone, so a
    // single statement would scan every row each hour even with nothing to
    // drop. The grouping below reads only the index.
    const spans = (
      this.db
        .prepare(
          'SELECT context_id, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM positions GROUP BY context_id',
        )
        .all() as { context_id: number; oldest: number; newest: number }[]
    ).map(({ context_id: id, oldest, newest }) => ({ id, context: this.nameOf(id), oldest, newest }))
    const aged = spans.filter(({ context, oldest }) => context !== keep && oldest < cutoff)
    const trim = this.db.prepare('DELETE FROM positions WHERE context_id = ? AND timestamp < ?')
    for (const { id, context } of aged) {
      trim.run(id, cutoff)
      this.invalidateLevels(context, Number.NEGATIVE_INFINITY, cutoff)
    }
    const dropped = aged.filter(({ newest }) => newest < cutoff)
    // A vessel that has aged out takes its name with it, or this table grows
    // for every target a harbour ever put past the receiver. The remembered
    // copy goes too, or a vessel returning under the same name would be taken
    // as already stored and never written again.
    for (const { context } of dropped) {
      this.db.prepare('DELETE FROM names WHERE context = ?').run(context)
      this.lastName.delete(context)
      this.db.prepare('DELETE FROM detail_spans WHERE context = ?').run(context)
      this.detail.delete(context)
      this.clearLevels(context)
    }
    // The write-throttle map is keyed by context and nothing else clears it, so
    // without this every vessel that ever passed leaves an entry behind — an
    // unbounded map on a server watching a busy harbour.
    for (const { context } of dropped) {
      this.lastStored.delete(context)
    }
    if (this.binRetention > 0) {
      const expired = this.db
        .prepare('SELECT * FROM recycle_bin WHERE purged = 0 AND deleted_at < ? ORDER BY whole DESC')
        .all(now - this.binRetention) as unknown as BinRow[]
      for (const entry of expired) {
        // A whole import purged first takes its spans with it.
        if (this.liveEntry(entry.id)) {
          this.purge(entry)
        }
      }
    }
    // Scoped to `keep` when there is one: other vessels age out by `maxAge`
    // above, so `retention` is the kept vessel's alone. Unscoped without a
    // `keep`, which is how a standalone store behaves.
    if (this.retention > 0) {
      const oldest = now - this.retention
      if (keep === undefined) {
        this.db.prepare('DELETE FROM positions WHERE timestamp < ?').run(oldest)
      } else {
        this.db.prepare('DELETE FROM positions WHERE timestamp < ? AND context_id = ?').run(oldest, this.idOf(keep))
      }
      for (const { context, oldest: first } of spans) {
        if (first < oldest && (keep === undefined || context === keep)) {
          this.invalidateLevels(context, Number.NEGATIVE_INFINITY, oldest)
        }
      }
    }
    this.thinOldDetail(now)
    this.forgetContexts()
  }

  /**
   * Take the contexts no table holds a row of any more out of `contexts`, or
   * it would keep every vessel that ever passed: a seek per table each.
   */
  private forgetContexts(): void {
    const gone = this.db
      .prepare(
        `DELETE FROM contexts
         WHERE NOT EXISTS (SELECT 1 FROM positions WHERE context_id = contexts.id)
           AND NOT EXISTS (SELECT 1 FROM significant WHERE context_id = contexts.id)
           AND NOT EXISTS (SELECT 1 FROM level_visits WHERE context_id = contexts.id)
           AND NOT EXISTS (SELECT 1 FROM binned_positions WHERE context_id = contexts.id)
         RETURNING id, context`,
      )
      .all() as unknown as { id: number; context: Context }[]
    for (const { id, context } of gone) {
      this.contextIds.delete(context)
      this.contextNames.delete(id)
      // A pass to go on at it would go on from the first id instead.
      if (this.refineResume === context) {
        this.refineResume = undefined
      }
      if (this.simplifyResume === context) {
        this.simplifyResume = undefined
      }
    }
  }

  /**
   * Thin what each detail span holds older than `DETAIL_KEEP`, keeping the
   * first position of every bucket. A span that ended before that goes back to
   * the store's resolution, so a season at anchor costs what the recording
   * would have without it. A span that has not, a stay at anchor that is
   * still going on, keeps its older part at the spacing an anchor alarm reads
   * the whole stay at, about `DETAIL_STAY_POINTS` points, until that spacing
   * reaches the store's resolution, which it never goes coarser than.
   *
   * Only without a `storageTolerance`: with one, simplifyStored() thins the
   * detail of a refined day along with everything else.
   */
  private thinOldDetail(now: number): void {
    if (this.resolution <= 0) {
      return
    }
    const extend = this.db.prepare('UPDATE detail_spans SET span_end = ? WHERE id = ?')
    for (const open of this.detail.values()) {
      extend.run(open.end, open.id)
      open.saved = open.end
    }
    // Simplifying the stored positions keeps the shape of the detail, at
    // anchor the swing, where thinning by time keeps one fix in each step.
    if (this.storageTolerance > 0) {
      return
    }
    // On a bucket edge, so the hourly prune of a span still being recorded
    // never splits a bucket between two runs and keeps two rows of it.
    const cutoff = Math.floor((now - DETAIL_KEEP) / this.resolution) * this.resolution
    const spans = this.db
      .prepare('SELECT id, context, span_start AS start, span_end AS end FROM detail_spans WHERE span_start < ?')
      .all(cutoff) as unknown as { id: number; context: string; start: number; end: number }[]
    // A bare column next to a single min() comes from the row holding the
    // minimum, so this keeps the first row of each bucket. Bound as an
    // integer, or SQLite divides as REAL and every row is its own bucket.
    const thin = this.db.prepare(
      `DELETE FROM positions WHERE context_id = ?1 AND timestamp >= ?2 AND timestamp <= ?3 AND rowid NOT IN (
         SELECT id FROM (
           SELECT rowid AS id, min(timestamp) FROM positions
           WHERE context_id = ?1 AND timestamp >= ?2 AND timestamp <= ?3
           GROUP BY timestamp / CAST(?4 AS INTEGER)
         )
       )`,
    )
    const done = this.db.prepare('DELETE FROM detail_spans WHERE id = ?')
    for (const { id, context, start, end } of spans) {
      if (end < cutoff) {
        if (thin.run(this.idOf(context), start, end, this.resolution).changes) {
          this.invalidateLevels(context, start, end)
        }
        done.run(id)
        this.lastThin.delete(id)
        if (this.detail.get(context)?.id === id) {
          this.detail.delete(context)
        }
      } else {
        // The span keeps its start, which is where the stay's spacing is
        // measured from on the next prune.
        const spacing = Math.min(this.resolution, Math.ceil((end - start) / DETAIL_STAY_POINTS / 1000) * 1000)
        // At the spacing of the last prune, only what has aged since then
        // can lose rows: the refined days of a long stay are left alone
        // until the spacing next widens, about once a day.
        const last = this.lastThin.get(id)
        if (thin.run(this.idOf(context), start, cutoff - 1, spacing).changes) {
          this.invalidateLevels(context, last?.spacing === spacing ? last.cutoff : start, cutoff - 1)
        }
        this.lastThin.set(id, { spacing, cutoff })
      }
    }
  }

  /**
   * Keep an imported track. The caller mints the id; a second track under the
   * same id fails rather than replacing the first.
   */
  storeImport(track: ImportedTrack): void {
    const points = track.segments.flat()
    if (points.length === 0) {
      throw new Error('An imported track needs at least one point')
    }
    // Checked before the first write: an id whose import is in the recycle
    // bin has no imported_tracks row to collide with, only its kept time.
    if (this.db.prepare('SELECT 1 AS found FROM import_times WHERE id = ?').get(track.id)) {
      throw new Error(`An import with id ${track.id} already exists`)
    }
    let south = points[0]!.position[0]
    let north = south
    let firstTime: number | undefined
    let lastTime: number | undefined
    for (const { position, timestamp } of points) {
      south = Math.min(south, position[0])
      north = Math.max(north, position[0])
      if (timestamp !== undefined) {
        firstTime = firstTime === undefined ? timestamp : Math.min(firstTime, timestamp)
        lastTime = lastTime === undefined ? timestamp : Math.max(lastTime, timestamp)
      }
    }
    const [west, east] = longitudeSpan(points.map(({ position }) => position[1]))
    this.db
      .prepare(
        `INSERT INTO imported_tracks (id, context, name, metadata, first_time, last_time, west, south, east, north)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        track.id,
        track.context ?? null,
        track.name ?? null,
        JSON.stringify(track.metadata),
        firstTime ?? null,
        lastTime ?? null,
        west,
        south,
        east,
        north,
      )
    this.db.prepare('INSERT INTO import_times (id, imported_at) VALUES (?, ?)').run(track.id, Date.now())
    const insert = this.db.prepare(
      'INSERT INTO imported_points (track_id, seq, segment, timestamp, lat, lon) VALUES (?, ?, ?, ?, ?, ?)',
    )
    let seq = 0
    for (const [segment, segmentPoints] of track.segments.entries()) {
      for (const { position, timestamp } of segmentPoints) {
        insert.run(track.id, seq++, segment, timestamp ?? null, position[0], position[1])
      }
    }
  }

  /**
   * Write a track imported for a vessel into its recording, in place of what
   * was recorded over the same time. The positions within each segment's
   * span go to the recycle bin first, one entry per segment, so a restore
   * brings them back beside the import. Every span is binned before any point
   * is written, so segments that overlap in time cannot bin each other.
   * Resolves to the bin entries made.
   */
  recordTrack(context: Context, segments: TimedPosition[][], deletedAt: number, keepEmpty: boolean): number[] {
    const binned: number[] = []
    for (const points of segments) {
      const first = points[0]
      const last = points.at(-1)
      if (first === undefined || last === undefined) continue
      const { id } = this.binRecorded(context, first.timestamp, last.timestamp, deletedAt, keepEmpty)
      if (id !== undefined) binned.push(id)
    }
    this.fill(context, segments)
    return binned
  }

  /**
   * Write a track imported for a vessel into its recording where it has
   * nothing (`fillGaps`), and return how many points were left out. Nothing
   * is binned. The runs are judged here, inside the write, so what another
   * upload or a restore wrote stays. Each run is sorted by time, as an
   * import's segments are, and is judged against what the runs before it
   * kept as well, so two runs that overlap are not both written. They are
   * written together, so a day several reach is simplified as one
   * (`simplifyUnrecorded`).
   *
   * A run is read a piece at a time (`fillPieces`): an import spread thinly
   * over weeks recorded at one fix a second would otherwise read the weeks at
   * once, more than the worker's heap holds. Whether a point fills depends
   * only on what was recorded within `MIN_FILLED_GAP_MS` of it, so judging
   * each piece on its own window decides every point as one read would.
   */
  fillTrack(context: Context, runs: TimedPosition[][]): number {
    const { kept, overlapping } = this.judgeFill(context, runs)
    this.fill(context, kept.flat())
    return overlapping
  }

  /**
   * What of each run `fillTrack` writes, and how many points it leaves out.
   * The recorded positions within `own`, which a sliced upload's segment
   * wrote in the slices before, do not count against the first run: they are
   * that segment's own.
   */
  private judgeFill(
    context: Context,
    runs: TimedPosition[][],
    own: readonly Span[] = [],
  ): { kept: TimedPosition[][][]; overlapping: number } {
    const recorded = this.db.prepare(
      'SELECT timestamp FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp <= ?',
    )
    const kept: TimedPosition[][][] = []
    const index = new KeptRuns()
    let overlapping = 0
    for (const [r, run] of runs.entries()) {
      // Added once the whole run is judged, so it never counts against itself.
      const judged: TimedPosition[][] = []
      for (const piece of fillPieces(run)) {
        const first = piece[0]
        const last = piece.at(-1)
        if (first === undefined || last === undefined) continue
        const from = first.timestamp - MIN_FILLED_GAP_MS
        const to = last.timestamp + MIN_FILLED_GAP_MS
        let stored = recorded.all(this.idOf(context), from, to) as { timestamp: number }[]
        if (r === 0 && own.length > 0) {
          stored = stored.filter(({ timestamp }) => !withinSpans(own, timestamp))
        }
        const filled = fillGaps([piece], [...stored, ...index.within(from, to)], MIN_FILLED_GAP_MS)
        judged.push(...filled.runs)
        overlapping += filled.overlapping
      }
      kept.push(judged)
      for (const run of judged) index.add(run)
    }
    return { kept, overlapping }
  }

  /**
   * Write positions into a vessel's recording past the throttle, and keep
   * them as imported rather than thin them as detail. What
   * simplifyUnrecorded() leaves out of them is not written.
   */
  private fill(
    context: Context,
    segments: TimedPosition[][],
    mine: ReadonlyMap<number, number> = new Map(),
  ): Map<number, number> {
    for (const points of segments) {
      const first = points[0]
      const last = points.at(-1)
      if (first === undefined || last === undefined) continue
      this.excludeFromDetail(context, first.timestamp, last.timestamp)
    }
    // The next live fix would otherwise open a detail span from the last one
    // recorded before the import, reaching over the imported points.
    this.lastStored.delete(context)
    const { written, days } = this.simplifyUnrecorded(context, segments, mine)
    for (const [s, points] of segments.entries()) {
      for (const { position, timestamp } of written[s]!) {
        this.store(context, position, timestamp)
      }
      const first = points[0]
      const last = points.at(-1)
      if (first !== undefined && last !== undefined) {
        this.invalidateLevels(context, first.timestamp, last.timestamp)
      }
    }
    // After invalidateLevels(), which takes a day changed off simplified_days.
    for (const [day, positions] of days) {
      this.simplifying().mark.run(context, day, this.storageTolerance, positions)
    }
    return days
  }

  /**
   * The points of an import to write, segment by segment: on each day that
   * simplifyStored() will go over and the recording holds nothing of, only
   * what simplifyStored() would leave of it. Writing every position and deleting
   * most of them a day later costs an SD card twice the writes, and deleting
   * is the dearer half: the location indexes put each deleted row on a page
   * of its own. Resolves the days written so, too, with how many positions
   * each keeps.
   *
   * A day the recording has positions of is written in full: simplifying the
   * import's stretches alone keeps their ends, and judges a point by the
   * chord its stretch draws rather than the one the whole day does. An
   * earlier import's positions count as the recording's, except on the days
   * in `mine`: a sliced upload wrote that many positions of each simplified,
   * and goes on with it while the day holds no others. Each day comes back
   * with every position written of it so.
   */
  private simplifyUnrecorded(
    context: Context,
    segments: TimedPosition[][],
    mine: ReadonlyMap<number, number> = new Map(),
    now = Date.now(),
  ): { written: TimedPosition[][]; days: Map<number, number> } {
    const days = new Map<number, number>()
    if (!(this.storageTolerance > 0)) {
      return { written: segments, days }
    }
    // As refineLevels() reckons the last day it refines.
    const lastDay = dayOf(now - DETAIL_KEEP) - 1
    const byDay = new Map<number, { segment: number; index: number; point: TimedPosition }[]>()
    for (const [segment, points] of segments.entries()) {
      for (const [index, point] of points.entries()) {
        const day = dayOf(point.timestamp)
        if (day > lastDay) continue
        let entries = byDay.get(day)
        if (!entries) byDay.set(day, (entries = []))
        entries.push({ segment, index, point })
      }
    }
    const { recorded, count } = this.simplifying()
    const id = this.idOf(context)
    const dropped = segments.map(() => new Set<number>())
    for (const [day, entries] of byDay) {
      const own = mine.get(day)
      const others =
        own === undefined
          ? recorded.get(id, day * LEVEL_DAY_MS, (day + 1) * LEVEL_DAY_MS) !== undefined
          : (count.get(id, day * LEVEL_DAY_MS, (day + 1) * LEVEL_DAY_MS) as { n: number }).n !== own
      if (others) continue
      // In the order refineDay() reads them: by time, and as written, which is the rowid's order.
      entries.sort((a, b) => a.point.timestamp - b.point.timestamp)
      const points = entries.map(({ point }) => point)
      const cuts = this.piecesOf(points)
      let kept = 0
      for (let p = 1; p < cuts.length; p++) {
        const piece = points.slice(cuts[p - 1], cuts[p])
        const values = significance(piece)
        const keep = storedKeep(piece, values, this.storageTolerance)
        for (const [i, value] of values.entries()) {
          // What a level holds simplifyStored() keeps as well.
          if (keep[i] || levelOf(value) >= MIN_READ_LEVEL) {
            kept++
          } else {
            const { segment, index } = entries[cuts[p - 1]! + i]!
            dropped[segment]!.add(index)
          }
        }
      }
      days.set(day, (own ?? 0) + kept)
    }
    const written = segments.map((points, s) =>
      dropped[s]!.size === 0 ? points : points.filter((_, i) => !dropped[s]!.has(i)),
    )
    return { written, days }
  }

  /** The last GPX file uploaded in slices, as its last write left it. */
  gpxUpload(): GpxUploadState | undefined {
    const row = this.db.prepare('SELECT state FROM gpx_uploads').get() as { state: string } | undefined
    return row && (JSON.parse(row.state) as GpxUploadState)
  }

  /**
   * Write the points a slice of an uploaded GPX file brought into the
   * recording, together with the upload's state, so a restart never finds
   * the one without the other; resolves to the state with what was written
   * counted in.
   *
   * Each slice is written as a whole upload of the same points would be, by
   * `fillTrack` or `recordTrack`, judged against the recording as it was
   * before the upload: a segment that goes on from the slice before is not
   * judged against what it wrote there, and a replaced span is binned only
   * where no segment of the upload wrote already, into the entry its segment
   * began. A day it wrote simplified, it goes on simplifying.
   */
  saveGpxUpload(state: GpxUploadState, parts: UploadPart[]): GpxUploadState {
    const { context } = state
    const runs = parts.map(({ points }) => points)
    const count = runs.reduce((sum, points) => sum + points.length, 0)
    const continues = parts[0]?.continues === true
    const mine = new Map(state.simplifiedDays)
    let { imported, overlapping } = state
    let days: Map<number, number>
    let next: Partial<GpxUploadState>
    if (state.onOverlap === 'keep') {
      const judged = this.judgeFill(context, runs, continues ? state.filled : [])
      overlapping += judged.overlapping
      imported += count - judged.overlapping
      days = this.fill(context, judged.kept.flat(), mine)
      let filled: Span[] = parts.length === 1 && continues ? (state.filled ?? []) : []
      for (const run of judged.kept.at(-1) ?? []) {
        filled = mergeSpan(filled, [run[0]!.timestamp, run.at(-1)!.timestamp])
      }
      next = { filled }
    } else {
      const now = Date.now()
      let replaced = state.replaced ?? []
      let binned = continues ? state.binned : undefined
      for (const [p, { points }] of parts.entries()) {
        const first = points[0]?.timestamp
        const last = points.at(-1)?.timestamp
        if (first === undefined || last === undefined) continue
        if (p > 0) binned = undefined
        // A segment's span takes in the time between its slices as well.
        const span: Span = [Math.min(first, binned?.from ?? first), Math.max(last, binned?.to ?? last)]
        let entry = binned?.id === undefined ? undefined : { id: binned.id, deletedAt: binned.deletedAt ?? now }
        for (const [from, to] of subtractSpans(span, replaced)) {
          const { id } = this.binRecorded(context, from, to, now, state.keepEmpty, entry)
          if (id !== undefined && id !== entry?.id) entry = { id, deletedAt: now }
        }
        binned = { ...(entry === undefined ? {} : entry), from: span[0], to: span[1] }
        replaced = mergeSpan(replaced, span)
      }
      days = this.fill(context, runs, mine)
      imported += count
      next = { replaced, ...(binned === undefined ? {} : { binned }) }
    }
    const saved: GpxUploadState = { ...state, imported, overlapping }
    // A slice without a whole point leaves the segment and its days open.
    if (parts.length > 0) {
      delete saved.filled
      delete saved.replaced
      delete saved.binned
      delete saved.simplifiedDays
      Object.assign(saved, next, days.size === 0 ? {} : { simplifiedDays: [...days] })
    }
    this.db.prepare('DELETE FROM gpx_uploads WHERE id <> ?').run(saved.id)
    this.db
      .prepare('INSERT INTO gpx_uploads (id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(saved.id, JSON.stringify(saved))
    return saved
  }

  /** How far the import of a vessel's track from a history provider got, or undefined before one started. */
  historyImport(context: Context): HistoryImportState | undefined {
    const row = this.db.prepare('SELECT * FROM history_imports WHERE context = ?').get(context) as
      | {
          started_at: number
          first_day: number | null
          next_day: number | null
          filled: number
          in_gap: number | null
          finished_at: number | null
          error: string | null
        }
      | undefined
    if (!row) {
      return undefined
    }
    return {
      context,
      startedAt: row.started_at,
      ...(row.first_day === null ? {} : { firstDay: row.first_day }),
      ...(row.next_day === null ? {} : { nextDay: row.next_day }),
      filled: row.filled,
      ...(row.in_gap === 1 ? { inGap: true } : {}),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.error === null ? {} : { error: row.error }),
    }
  }

  /**
   * Write the runs a day of history filled into the recording, together with
   * the state of the import they bring it to, so a restart never finds the
   * one without the other, and return how many positions the import has
   * filled. Nothing is binned: an import from history only fills where the
   * recording has nothing. The runs are judged again here, in the same
   * transaction, against the recording and the deleted spans as they are
   * now: a GPX import, a restore or a delete can land while the provider is
   * read, and what it took is then left out, and not counted as filled.
   * Positions before `since` do not count against the runs: the import wrote
   * them, the day before, in the stretch it goes on filling.
   */
  saveHistoryImport(state: HistoryImportState, runs: TimedPosition[][], since = -Infinity): number {
    const deleted = this.deletedSpans().filter(({ context }) => context === state.context)
    const recorded = this.db.prepare(
      'SELECT timestamp FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp <= ?',
    )
    const kept: TimedPosition[][] = []
    let dropped = 0
    for (const run of runs) {
      const visible = outsideSpans(run, deleted)
      const first = visible[0]
      const last = visible.at(-1)
      if (first !== undefined && last !== undefined) {
        const around = recorded.all(
          this.idOf(state.context),
          Math.max(since, first.timestamp - MIN_FILLED_GAP_MS),
          last.timestamp + MIN_FILLED_GAP_MS,
        ) as { timestamp: number }[]
        kept.push(...fillGaps([visible], around, MIN_FILLED_GAP_MS).runs)
      }
      dropped += run.length
    }
    for (const run of kept) {
      dropped -= run.length
    }
    this.fill(state.context, kept)
    const filled = state.filled - dropped
    this.db
      .prepare(
        `INSERT INTO history_imports (context, started_at, first_day, next_day, filled, in_gap, finished_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(context) DO UPDATE SET started_at = excluded.started_at, first_day = excluded.first_day,
           next_day = excluded.next_day, filled = excluded.filled, in_gap = excluded.in_gap,
           finished_at = excluded.finished_at, error = excluded.error`,
      )
      .run(
        state.context,
        state.startedAt,
        state.firstDay ?? null,
        state.nextDay ?? null,
        filled,
        state.inGap ? 1 : null,
        state.finishedAt ?? null,
        state.error ?? null,
      )
    return filled
  }

  /**
   * Take `[from, to]` out of a context's detail spans: an import written into
   * the recording there is kept as imported, never thinned as detail.
   */
  private excludeFromDetail(context: Context, from: number, to: number): void {
    const open = this.detail.get(context)
    if (open) {
      this.db.prepare('UPDATE detail_spans SET span_end = ? WHERE id = ?').run(open.end, open.id)
    }
    const spans = this.db
      .prepare(
        'SELECT id, span_start AS start, span_end AS end FROM detail_spans WHERE context = ? AND span_start <= ? AND span_end >= ?',
      )
      .all(context, to, from) as unknown as { id: number; start: number; end: number }[]
    const remove = this.db.prepare('DELETE FROM detail_spans WHERE id = ?')
    const insert = this.db.prepare('INSERT INTO detail_spans (context, span_start, span_end) VALUES (?, ?, ?)')
    for (const { id, start, end } of spans) {
      remove.run(id)
      if (start < from) {
        insert.run(context, start, from - 1)
      }
      const tail = end > to ? Number(insert.run(context, to + 1, end).lastInsertRowid) : undefined
      if (open?.id === id) {
        if (tail === undefined) {
          this.detail.delete(context)
        } else {
          this.detail.set(context, { id: tail, end: open.end, saved: open.end })
        }
      }
    }
  }

  /**
   * Move a vessel's positions recorded within `[from, to]` into the recycle
   * bin, resolving to the entry's id and whether the store held the vessel at
   * all.
   *
   * An entry is made even when the store holds nothing there if `keepEmpty`
   * says the history import could bring the span in: it still has to keep
   * the import out. Without one, an empty delete leaves no entry behind.
   *
   * `into` names an entry of the same vessel to add the positions to instead,
   * its span widened to take in this one: a sliced upload replaces one
   * segment over several writes, and makes one entry of it as a whole upload
   * does. It names the entry by its time of deletion as well as its id, since
   * a restore frees the id for the next entry, of any vessel. When the entry
   * is gone, the positions start one of their own.
   */
  binRecorded(
    context: Context,
    from: number | undefined,
    to: number,
    deletedAt: number,
    keepEmpty: boolean,
    entry?: { id: number; deletedAt: number },
  ): { id?: number; known: boolean } {
    const known = this.knows(context)
    const lower = from ?? Number.MIN_SAFE_INTEGER
    const into =
      entry &&
      this.db
        .prepare('SELECT 1 AS found FROM recycle_bin WHERE id = ? AND context = ? AND deleted_at = ? AND purged = 0')
        .get(entry.id, context, entry.deletedAt)
        ? entry.id
        : undefined
    const id = into ?? this.newBinEntry({ context, ...(from === undefined ? {} : { from }), to, deletedAt })
    if (into !== undefined) {
      this.db
        .prepare('UPDATE recycle_bin SET span_from = MIN(span_from, ?), span_to = MAX(span_to, ?) WHERE id = ?')
        .run(lower, to, into)
    }
    const moved = Number(
      this.db
        .prepare(
          `INSERT INTO binned_positions (bin_id, context_id, timestamp, lat, lon, s2cell)
           SELECT ?, context_id, timestamp, lat, lon, s2cell FROM positions
           WHERE context_id = ? AND timestamp >= ? AND timestamp <= ?`,
        )
        .run(id, this.idOf(context), lower, to).changes,
    )
    if (moved === 0 && !keepEmpty && into === undefined) {
      this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(id)
      return { known }
    }
    this.db
      .prepare('DELETE FROM positions WHERE context_id = ? AND timestamp >= ? AND timestamp <= ?')
      .run(this.idOf(context), lower, to)
    // Only the days at either end keep positions to refine again; those in
    // between are empty now, and their significant positions go with them.
    if (moved > 0) {
      this.invalidateLevels(context, lower, to)
    }
    return { id, known }
  }

  /**
   * Move an imported track into the recycle bin, or with a span only its
   * points within it, resolving to the entry's id; undefined when there is no
   * such import, or the span holds none of its points.
   */
  binImport(importId: string, span: { from?: number; to?: number } | undefined, deletedAt: number): number | undefined {
    const track = this.db.prepare('SELECT context, name FROM imported_tracks WHERE id = ?').get(importId) as
      { context: string | null; name: string | null } | undefined
    if (!track) {
      return undefined
    }
    const id = this.newBinEntry({
      ...(track.context === null ? {} : { context: track.context }),
      importId,
      ...(track.name === null ? {} : { name: track.name }),
      ...(span ?? {}),
      deletedAt,
    })
    const where = span ? 'track_id = ? AND timestamp >= ? AND timestamp <= ?' : 'track_id = ?'
    const params = span
      ? [importId, span.from ?? Number.MIN_SAFE_INTEGER, span.to ?? Number.MAX_SAFE_INTEGER]
      : [importId]
    const moved = Number(
      this.db
        .prepare(
          `INSERT INTO binned_imported_points (bin_id, track_id, seq, segment, timestamp, lat, lon)
           SELECT ?, track_id, seq, segment, timestamp, lat, lon FROM imported_points WHERE ${where}`,
        )
        .run(id, ...params).changes,
    )
    // An empty span leaves the track as it was, and so leaves nothing to restore.
    if (span && moved === 0) {
      this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(id)
      return undefined
    }
    this.db.prepare(`DELETE FROM imported_points WHERE ${where}`).run(...params)
    // A span that took every point would leave a track no query lists, so it
    // takes the track too, and restoring the entry brings back both.
    const emptied = span && !this.db.prepare('SELECT 1 AS found FROM imported_points WHERE track_id = ?').get(importId)
    if (emptied) {
      this.db.prepare('UPDATE recycle_bin SET whole = 1, span_from = NULL, span_to = NULL WHERE id = ?').run(id)
    }
    if (!span || emptied) {
      this.db
        .prepare(
          `INSERT INTO binned_imported_tracks
           SELECT ?, id, context, name, metadata, first_time, last_time, west, south, east, north
           FROM imported_tracks WHERE id = ?`,
        )
        .run(id, importId)
      this.db.prepare('DELETE FROM imported_tracks WHERE id = ?').run(importId)
    }
    return id
  }

  private newBinEntry(entry: Omit<BinEntry, 'id' | 'whole' | 'pointCount'>): number {
    const whole = entry.importId !== undefined && entry.from === undefined && entry.to === undefined
    return Number(
      this.db
        .prepare(
          `INSERT INTO recycle_bin (context, import_id, name, whole, span_from, span_to, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.context ?? null,
          entry.importId ?? null,
          entry.name ?? null,
          whole ? 1 : 0,
          entry.from ?? null,
          entry.to ?? null,
          entry.deletedAt,
        ).lastInsertRowid,
    )
  }

  /**
   * Put a recycle bin entry's rows back where they were deleted from.
   *
   * A span of an import whose whole track has since gone to the bin as well
   * is a conflict: its points have no track to return to until that is
   * restored first.
   */
  restoreFromBin(id: number): RestoreResult {
    const entry = this.liveEntry(id)
    if (!entry) {
      return 'missing'
    }
    if (entry.import_id === null) {
      const spans = this.db
        .prepare(
          'SELECT context_id, min(timestamp) AS first, max(timestamp) AS last FROM binned_positions WHERE bin_id = ? GROUP BY context_id',
        )
        .all(id) as unknown as { context_id: number; first: number; last: number }[]
      this.db
        .prepare(
          `INSERT INTO positions (context_id, timestamp, lat, lon, s2cell)
           SELECT context_id, timestamp, lat, lon, s2cell FROM binned_positions WHERE bin_id = ?`,
        )
        .run(id)
      for (const { context_id: contextId, first, last } of spans) {
        this.invalidateLevels(this.nameOf(contextId), first, last)
      }
      this.db.prepare('DELETE FROM binned_positions WHERE bin_id = ?').run(id)
    } else {
      if (entry.whole === 1) {
        this.db
          .prepare(
            `INSERT INTO imported_tracks (id, context, name, metadata, first_time, last_time, west, south, east, north)
             SELECT id, context, name, metadata, first_time, last_time, west, south, east, north
             FROM binned_imported_tracks WHERE bin_id = ?`,
          )
          .run(id)
        this.db.prepare('DELETE FROM binned_imported_tracks WHERE bin_id = ?').run(id)
      } else if (!this.db.prepare('SELECT 1 AS found FROM imported_tracks WHERE id = ?').get(entry.import_id)) {
        return 'conflict'
      }
      this.db
        .prepare(
          `INSERT INTO imported_points (track_id, seq, segment, timestamp, lat, lon)
           SELECT track_id, seq, segment, timestamp, lat, lon FROM binned_imported_points WHERE bin_id = ?`,
        )
        .run(id)
      this.db.prepare('DELETE FROM binned_imported_points WHERE bin_id = ?').run(id)
    }
    this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(id)
    return 'restored'
  }

  /** Purge one recycle bin entry now, resolving whether it was in the bin. */
  purgeFromBin(id: number): boolean {
    const entry = this.liveEntry(id)
    if (!entry) {
      return false
    }
    this.purge(entry)
    return true
  }

  /** Entries still in the recycle bin, newest delete first. */
  binEntries(): BinEntry[] {
    const rows = this.db
      .prepare(
        `SELECT bin.*,
           (SELECT COUNT(*) FROM binned_positions WHERE bin_id = bin.id)
           + (SELECT COUNT(*) FROM binned_imported_points WHERE bin_id = bin.id) AS point_count
         FROM recycle_bin AS bin WHERE purged = 0 ORDER BY deleted_at DESC, id DESC`,
      )
      .all() as unknown as (BinRow & { point_count: number })[]
    return rows.map((row) => ({
      id: row.id,
      ...(row.context === null ? {} : { context: row.context }),
      ...(row.import_id === null ? {} : { importId: row.import_id }),
      ...(row.name === null ? {} : { name: row.name }),
      whole: row.whole === 1,
      ...(row.span_from === null ? {} : { from: row.span_from }),
      ...(row.span_to === null ? {} : { to: row.span_to }),
      deletedAt: row.deleted_at,
      pointCount: row.point_count,
    }))
  }

  /** Every deleted span of a recorded track, purged or not: what history must not show. */
  deletedSpans(): RecordedSpan[] {
    const rows = this.db
      .prepare('SELECT context, span_from, span_to FROM recycle_bin WHERE import_id IS NULL')
      .all() as unknown as { context: string; span_from: number | null; span_to: number }[]
    return rows.map(({ context, span_from, span_to }) => ({
      context,
      ...(span_from === null ? {} : { from: span_from }),
      to: span_to,
    }))
  }

  private liveEntry(id: number): BinRow | undefined {
    return this.db.prepare('SELECT * FROM recycle_bin WHERE id = ? AND purged = 0').get(id) as BinRow | undefined
  }

  /**
   * Remove an entry's rows for good. A recorded span stays as a tombstone, so
   * history cannot refill it; a whole import takes the spans deleted from it
   * earlier with it, since they have no track left to be restored into.
   */
  private purge(entry: BinRow): void {
    const ids =
      entry.whole === 1
        ? (
            this.db.prepare('SELECT id FROM recycle_bin WHERE import_id = ? AND purged = 0').all(entry.import_id) as {
              id: number
            }[]
          ).map(({ id }) => id)
        : [entry.id]
    for (const id of ids) {
      this.db.prepare('DELETE FROM binned_positions WHERE bin_id = ?').run(id)
      this.db.prepare('DELETE FROM binned_imported_points WHERE bin_id = ?').run(id)
      this.db.prepare('DELETE FROM binned_imported_tracks WHERE bin_id = ?').run(id)
      if (entry.import_id === null) {
        this.db.prepare('UPDATE recycle_bin SET purged = 1 WHERE id = ?').run(id)
      } else {
        this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(id)
      }
    }
    if (entry.whole === 1 && entry.import_id !== null) {
      this.db.prepare('DELETE FROM import_times WHERE id = ?').run(entry.import_id)
    }
  }

  getImport(id: string): StoredImport | undefined {
    const row = this.db.prepare(`${SELECT_IMPORTS} WHERE id = ?`).get(id) as ImportedRow | undefined
    return row ? this.importFrom(row) : undefined
  }

  /** Imported tracks the filter lets through, in the order they were stored. */
  findImports(filter: ImportFilter = {}): StoredImport[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.contexts) {
      if (filter.contexts.length === 0) {
        return []
      }
      clauses.push(`context IN (${filter.contexts.map(() => '?').join(', ')})`)
      params.push(...filter.contexts)
    }
    if (filter.window) {
      // The same end rule as a recorded track's window, applied to the span.
      clauses.push(
        'first_time IS NOT NULL',
        filter.window.inclusiveEnd ? 'first_time <= ?' : 'first_time < ?',
        'last_time >= ?',
      )
      params.push(filter.window.to, filter.window.from)
    }
    if (filter.bbox) {
      clauses.push('south <= ?', 'north >= ?')
      params.push(filter.bbox.ne[0], filter.bbox.sw[0])
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    let rows = this.db
      .prepare(`${SELECT_IMPORTS} ${where} ORDER BY imported_tracks.rowid`)
      .all(...params) as unknown as ImportedRow[]
    // Longitude in JS rather than SQL: either box may cross the antimeridian.
    const box = filter.bbox
    if (box) {
      rows = rows.filter((row) => longitudesOverlap([row.west, row.east], [box.sw[1], box.ne[1]]))
    }
    return rows.map((row) => this.importFrom(row))
  }

  private importFrom(row: ImportedRow): StoredImport {
    const points = this.selectImportedPoints.all(row.id) as unknown as {
      segment: number
      timestamp: number | null
      lat: number
      lon: number
    }[]
    const segments: ImportedPoint[][] = []
    let current: ImportedPoint[] | undefined
    let currentIndex: number | undefined
    for (const { segment, timestamp, lat, lon } of points) {
      if (segment !== currentIndex) {
        current = []
        segments.push(current)
        currentIndex = segment
      }
      current!.push(timestamp === null ? { position: [lat, lon] } : { position: [lat, lon], timestamp })
    }
    return {
      id: row.id,
      ...(row.context === null ? {} : { context: row.context }),
      ...(row.name === null ? {} : { name: row.name }),
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      segments,
      importedAt: row.imported_at,
    }
  }

  /** Worker startup snapshot; queries and name lookups must not open a second database. */
  storedNames(): { context: string; name: string; timestamp: number }[] {
    return this.db.prepare('SELECT context, name, timestamp FROM names').all() as unknown as {
      context: string
      name: string
      timestamp: number
    }[]
  }

  /** A failed batch stops writes in its worker; reads remain available. */
  transaction(write: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      write()
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch (rollbackError) {
        // SQLITE_FULL/IOERR may already have rolled back automatically.
        if (!(rollbackError instanceof Error) || !rollbackError.message.includes('no transaction is active')) {
          // Only the message crosses the worker boundary, so it carries both.
          const text = (e: unknown) => (e instanceof Error ? e.message : String(e))
          throw new TransactionStateError(
            `Track transaction rollback failed (${text(rollbackError)}) after: ${text(error)}`,
            { cause: error },
          )
        }
      }
      // What the write did to the state in memory went with it.
      this.loadContexts()
      this.loadLevels()
      throw error
    }
  }

  /** The contexts' ids as the database holds them. */
  private loadContexts(): void {
    this.contextIds.clear()
    this.contextNames.clear()
    for (const { id, context } of this.db.prepare('SELECT id, context FROM contexts').all() as unknown as {
      id: number
      context: Context
    }[]) {
      this.contextIds.set(context, id)
      this.contextNames.set(id, context)
    }
  }

  /** A context's id, or NO_CONTEXT for one the store holds no row of, or never did. */
  private idOf(context: Context): number {
    return this.contextIds.get(context) ?? NO_CONTEXT
  }

  /** A context's id, given it one if it has none: for a write of its positions. */
  private idFor(context: Context): number {
    let id = this.contextIds.get(context)
    if (id === undefined) {
      id = (this.db.prepare('INSERT INTO contexts (context) VALUES (?) RETURNING id').get(context) as { id: number }).id
      this.contextIds.set(context, id)
      this.contextNames.set(id, context)
    }
    return id
  }

  /** The context an id stands for. */
  private nameOf(id: number): Context {
    const context = this.contextNames.get(id)
    if (context === undefined) {
      throw new Error(`No context has id ${id}`)
    }
    return context
  }

  /** The level state as the database holds it, with nothing in progress. */
  private loadLevels(): void {
    this.levelFrontier.clear()
    for (const { context, through } of this.db
      .prepare('SELECT context, through FROM level_frontier')
      .all() as unknown as { context: string; through: number }[]) {
      this.levelFrontier.set(context, through)
    }
    this.refinedThrough = undefined
    this.refineResume = undefined
    this.refinePartial = undefined
    this.simplifyFrontier.clear()
    for (const { context, through, tolerance } of this.db
      .prepare('SELECT context, through, tolerance FROM simplify_frontier')
      .all() as unknown as { context: string; through: number; tolerance: number }[]) {
      this.simplifyFrontier.set(context, { through, tolerance })
    }
    this.simplifiedThrough = undefined
    this.simplifyResume = undefined
    this.simplifyPartial = undefined
  }

  close(): void {
    // Repeats of a stored name are dated in memory only. Writing the newest
    // dates back here, in one transaction, lets a reopened store rank a late
    // report against the newest one rather than against the first.
    try {
      const redate = this.db.prepare('UPDATE names SET timestamp = ? WHERE context = ? AND name = ? AND timestamp < ?')
      this.db.exec('BEGIN')
      for (const [context, { name, timestamp }] of this.lastName) {
        redate.run(timestamp, context, name, timestamp)
      }
      const extend = this.db.prepare('UPDATE detail_spans SET span_end = ? WHERE id = ?')
      for (const { id, end } of this.detail.values()) {
        extend.run(end, id)
      }
      this.db.exec('COMMIT')
    } finally {
      this.db.close()
    }
  }

  /** Unsigned round-trip check, used by the tests. */
  cellIdsFor(context: Context): bigint[] {
    const stmt = this.db.prepare('SELECT s2cell FROM positions WHERE context_id = ? ORDER BY timestamp, rowid')
    stmt.setReadBigInts(true)
    const rows = stmt.all(this.idOf(context)) as unknown as { s2cell: bigint }[]
    return rows.map(({ s2cell }) => toUnsigned(s2cell))
  }
}
