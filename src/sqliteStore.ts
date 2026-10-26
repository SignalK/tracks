import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { s2, geojson } from 's2js'
import { significance } from './simplify.js'
import { thin, Thinner } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import type { TrackStore } from './store.js'
import {
  createInBounds,
  createMatcher,
  fillGaps,
  longitudeSpan,
  longitudeSpanOf,
  MIN_FILLED_GAP_MS,
  splitAtAntimeridian,
} from './utils.js'
import type { LongitudeExtremes } from './utils.js'
import type {
  BinEntry,
  Context,
  Debug,
  GeoBounds,
  ImportedPoint,
  ImportedTrack,
  StoredImport,
  ImportFilter,
  LatLngTuple,
  RecordedSpan,
  RestoreResult,
  TimedPosition,
  TimedTrackCollection,
  TimeWindow,
  TrackCollection,
  TrackParams,
  TrackSummary,
} from './types.js'

export class TransactionStateError extends Error {}

const toTimed = ({ lat, lon, timestamp }: Omit<PositionRow, 'context'>): TimedPosition => ({
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
  context: string
  timestamp: number
  lat: number
  lon: number
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
 * seek on (context, level, timestamp), where a range of levels would walk them.
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
  /** See refining(). */
  private refineStatements:
    | Record<'select' | 'copy' | 'visit' | 'unstale' | 'frontier' | 'deleteSignificant' | 'deleteVisits', StatementSync>
    | undefined

  constructor(config: SqliteStoreConfig, debug: Debug) {
    this.maxCells = config.maxCells ?? DEFAULT_MAX_CELLS
    this.readProbeLimit = config.readProbeLimit ?? DEFAULT_READ_PROBE_LIMIT
    this.refineBudget = config.refineBudget ?? DEFAULT_REFINE_BUDGET
    this.segmentGap = config.segmentGap ?? DEFAULT_SEGMENT_GAP
    this.retention = config.retention ?? 0
    this.binRetention = config.binRetention ?? 0
    this.resolution = config.resolution ?? 0
    this.stretchGap = Math.max(CLIP_STRETCH_GAP, 2 * this.resolution)
    this.debug = debug

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        context   TEXT    NOT NULL,
        timestamp INTEGER NOT NULL,
        lat       REAL    NOT NULL,
        lon       REAL    NOT NULL,
        s2cell    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_s2cell ON positions(s2cell);
      -- A separate table rather than a column on positions: this store has no
      -- migration mechanism, so a new table appears harmlessly on a database
      -- written by an older version, where an ALTER TABLE would not.
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
      -- them back. A purged recorded span keeps its row: a history provider
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
        bin_id    INTEGER NOT NULL,
        context   TEXT    NOT NULL,
        timestamp INTEGER NOT NULL,
        lat       REAL    NOT NULL,
        lon       REAL    NOT NULL,
        s2cell    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_binned_positions ON binned_positions(bin_id);
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
        context     TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        lat         REAL    NOT NULL,
        lon         REAL    NOT NULL,
        level       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_significant_time ON significant(context, level, timestamp);
      -- The hours of refined days each context had a position in each cell
      -- of VISIT_CELL_DEG: where a box read at a tolerance finds a vessel,
      -- since the positions a level keeps in the box can be none at all.
      CREATE TABLE IF NOT EXISTS level_visits (
        context     TEXT    NOT NULL,
        lat_cell    INTEGER NOT NULL,
        lon_cell    INTEGER NOT NULL,
        hour        INTEGER NOT NULL,
        PRIMARY KEY (context, lat_cell, lon_cell, hour)
      ) WITHOUT ROWID;
      -- A refined day's visits are cleared by hour, which the key, led by the
      -- cells a box read asks for, cannot seek.
      CREATE INDEX IF NOT EXISTS idx_level_visits_hour ON level_visits(context, hour);
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
    `)
    this.loadLevels()
    // The position rides along with the vessel and time, so a read of a track
    // is answered from the index alone, without a lookup in the table for
    // every row. It replaces the (context, timestamp) index of older
    // versions, which it serves for every query. That one is dropped first
    // and in the same transaction, so the new one reuses its pages rather
    // than growing the file by both, and a build that fails leaves it as it
    // was.
    //
    // (context, s2cell) reads a box for one vessel without its whole window:
    // the cell index alone mixes every vessel near the box, and the index
    // above finds the vessel but orders its rows by time.
    const building = ['idx_context_time_position', 'idx_context_s2cell'].some(
      (name) => !this.db.prepare('SELECT 1 AS found FROM sqlite_master WHERE name = ?').get(name),
    )
    this.transaction(() =>
      this.db.exec(`
        DROP INDEX IF EXISTS idx_context_timestamp;
        CREATE INDEX IF NOT EXISTS idx_context_time_position ON positions(context, timestamp, lat, lon);
        CREATE INDEX IF NOT EXISTS idx_context_s2cell ON positions(context, s2cell);
      `),
    )
    if (building) {
      // The build went through the write-ahead log, which keeps its size,
      // that of the whole index, until a checkpoint truncates it. A reader
      // on another connection can hold that off past the busy timeout; the
      // log then stays until the last connection closes and SQLite removes
      // it.
      const { busy } = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
      if (busy) {
        this.debug('position indexes built; another connection kept the write-ahead log from being truncated')
      }
    }
    // Imports kept before their time was: dated to the first start that knew to.
    const now = Date.now()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO import_times (id, imported_at)
         SELECT id, ? FROM imported_tracks UNION SELECT id, ? FROM binned_imported_tracks`,
      )
      .run(now, now)
    this.insert = this.db.prepare('INSERT INTO positions (context, timestamp, lat, lon, s2cell) VALUES (?, ?, ?, ?, ?)')
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
    this.insert.run(context, timestamp, position[0], position[1], toSigned(cellIdFor(position)))
  }

  initialTrack(context: Context, track: LatLngTuple[], timestamps?: number[]): void {
    // Replaces the context's history, matching the in-memory store: a caller
    // installing a known track is authoritative for the window it covers.
    this.db.prepare('DELETE FROM positions WHERE context = ?').run(context)
    this.clearLevels(context)
    // Bypasses the throttle: these points are already at whatever resolution
    // the history provider returned, and they are back-dated, so throttling
    // against the newest-seen timestamp would drop most of them.
    for (const [i, position] of track.entries()) {
      this.store(context, position, timestamps?.[i] ?? 0)
    }
    this.lastStored.delete(context)
  }

  private rowsFor(context: Context, window?: TimeWindow): PositionRow[] {
    const clauses = ['context = ?']
    const params: (string | number)[] = [context]
    if (window) {
      clauses.push('timestamp >= ?', window.inclusiveEnd ? 'timestamp <= ?' : 'timestamp < ?')
      params.push(window.from, window.to)
    }
    // rowid keeps equal times in the order they were stored: an untimed
    // track is stored at timestamp 0 throughout, and the index alone would
    // order those by position.
    return this.db
      .prepare(
        `SELECT context, timestamp, lat, lon FROM positions WHERE ${clauses.join(' AND ')} ORDER BY timestamp, rowid`,
      )
      .all(...params) as unknown as PositionRow[]
  }

  private knows(context: Context): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM positions WHERE context = ? LIMIT 1').get(context)
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
      return Promise.reject(new Error(`No track for ${context}`))
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

  /**
   * A context's positions in `range`, a day at a time and in the order
   * rowsFor() keeps. With `levels`, the days `significant` holds come from
   * it, only the positions at those levels; every other day is read whole.
   */
  private *daysOf(
    context: Context,
    range: TimeRange,
    levels: number[] | undefined,
  ): Generator<Omit<PositionRow, 'context'>> {
    const refined = levels ? this.refinedDays(context) : undefined
    // One bound per side in every statement: given a second lower bound on
    // timestamp, SQLite enters the index at the first and filters on the other,
    // so each seek would scan from the start of the window again.
    //
    // Each read starts at the next recorded time, so a window spanning years
    // of gaps costs one seek per day that has positions, not one per day.
    const next = this.db.prepare(
      `SELECT timestamp FROM positions WHERE context = ?${inRange(range)} ORDER BY timestamp LIMIT 1`,
    )
    const day = ' AND timestamp >= ? AND timestamp < ?'
    // Ordered as rowsFor() orders them, so equal times keep the order they were stored in.
    const positions = 'SELECT timestamp, lat, lon FROM positions WHERE context = ?'
    const whole = {
      day: this.db.prepare(`${positions}${day} ORDER BY timestamp, rowid`),
      last: this.db.prepare(`${positions}${inRange(range)} ORDER BY timestamp, rowid`),
    }
    // Sorted below: read level by level, they come in level order.
    const significant =
      levels &&
      `SELECT position AS id, timestamp, lat, lon FROM significant INDEXED BY idx_significant_time WHERE context = ? AND level IN (${levels.join(', ')})`
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
          `SELECT rowid AS id, timestamp, lat, lon FROM positions WHERE context = ?${inRange(range)} ORDER BY timestamp ${order}, rowid ${order} LIMIT 1`,
        )
        .get(context, range.from, range.to) as unknown as (Omit<PositionRow, 'context'> & { id: number }) | undefined
    const edges = byLevel ? [edge('ASC'), edge('DESC')] : []
    for (let from = range.from; ;) {
      const row = next.get(context, from, range.to) as { timestamp: number } | undefined
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
          ? byLevel.last.all(context, start, range.to)
          : byLevel.day.all(context, start, end)) as unknown as (Omit<PositionRow, 'context'> & { id: number })[]
        for (const edge of edges) {
          if (edge && dayOf(edge.timestamp) === dayOf(start) && !rows.some(({ id }) => id === edge.id)) {
            rows.push(edge)
          }
        }
        yield* rows.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
      } else {
        yield* (last
          ? whole.last.all(context, start, range.to)
          : whole.day.all(context, start, end)) as unknown as Omit<PositionRow, 'context'>[]
      }
      if (last) {
        return
      }
      from = end
    }
  }

  private contexts(): Context[] {
    const rows = this.db.prepare('SELECT DISTINCT context FROM positions').all() as unknown as { context: Context }[]
    return rows.map(({ context }) => context)
  }

  /** Those of `contexts` the store holds positions for, each found by an index seek. */
  private stored(contexts: Iterable<Context>): Context[] {
    const held = this.db.prepare('SELECT 1 AS found FROM positions WHERE context = ? LIMIT 1')
    return [...contexts].filter((context) => held.get(context) !== undefined)
  }

  /**
   * Each context's track in a window as a listing describes it, without its
   * points: a list of every vessel over weeks would otherwise build every
   * position only to count them, then copy them all to the main thread.
   */
  summarize(contexts: Context[] | undefined, window?: TimeWindow): TrackSummary[] {
    const inWindow = window ? ['timestamp >= ?', window.inclusiveEnd ? 'timestamp <= ?' : 'timestamp < ?'] : []
    const windowParams = window ? [window.from, window.to] : []
    const clauses = [...(contexts ? [`context IN (${contexts.map(() => '?').join(', ')})`] : []), ...inWindow]
    const params = [...(contexts ?? []), ...windowParams]
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
        `SELECT context, COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last,
                MIN(lat) AS south, MAX(lat) AS north, MIN(lon) AS lowest, MAX(lon) AS highest,
                MIN(lon) FILTER (WHERE lon >= 0) AS lowestEast, MAX(lon) FILTER (WHERE lon < 0) AS highestWest
         ${rows} GROUP BY context`,
      )
      .all(...params) as unknown as ({
      context: Context
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
      `SELECT DISTINCT lon FROM positions WHERE ${['context = ?', ...inWindow].join(' AND ')}`,
    )
    return groups.map(({ context, count, first, last, south, north, ...extremes }) => {
      const [west, east] =
        longitudeSpanOf(extremes) ??
        longitudeSpan((longitudes.all(context, ...windowParams) as unknown as { lon: number }[]).map(({ lon }) => lon))
      return { context, pointCount: count, first, last, bbox: [west, south, east, north] }
    })
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

    const stmt = this.db.prepare(`SELECT DISTINCT context, lat, lon FROM positions WHERE ${where}`)
    const rows = stmt.all(...params) as unknown as { context: string; lat: number; lon: number }[]

    const inBounds = createInBounds(bounds)
    for (const { context, lat, lon } of rows) {
      if (inBounds([lat, lon])) {
        found.add(context)
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
  ): Generator<PositionRow> {
    const boxCount = this.db.prepare(
      'SELECT count(*) AS n FROM (SELECT 1 FROM positions INDEXED BY idx_context_s2cell WHERE context = ? AND s2cell BETWEEN ? AND ? LIMIT ?)',
    )
    const windowCount = this.db.prepare(
      `SELECT count(*) AS n FROM (SELECT 1 FROM positions INDEXED BY idx_context_time_position WHERE context = ?${inWindow} LIMIT ?)`,
    )
    let byTime: StatementSync | undefined
    let byCell: StatementSync | undefined
    for (const context of contexts) {
      let boxRows = 0
      let windowRows = 0
      for (const limit of [this.readProbeLimit, 8 * this.readProbeLimit]) {
        boxRows = 0
        for (let i = 0; i < clause.params.length && boxRows < limit; i += 2) {
          const left = limit - boxRows
          boxRows += (boxCount.get(context, clause.params[i]!, clause.params[i + 1]!, left) as { n: number }).n
        }
        windowRows = boxRows > 0 ? (windowCount.get(context, ...timeParams, boxRows) as { n: number }).n : 0
        if (boxRows < limit || windowRows < boxRows) {
          break
        }
      }
      if (windowRows < boxRows) {
        byTime ??= this.db.prepare(
          `SELECT context, timestamp, lat, lon FROM positions INDEXED BY idx_context_time_position WHERE context = ? AND (${clause.where})${inWindow}`,
        )
        yield* byTime.all(context, ...clause.params, ...timeParams) as unknown as PositionRow[]
        continue
      }
      byCell ??= this.db.prepare(
        `SELECT context, timestamp, lat, lon FROM positions INDEXED BY idx_context_s2cell WHERE context = ? AND s2cell BETWEEN ? AND ?${inWindow}`,
      )
      for (let i = 0; i < clause.params.length; i += 2) {
        yield* byCell.all(context, clause.params[i]!, clause.params[i + 1]!, ...timeParams) as unknown as PositionRow[]
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

    const inside: Iterable<PositionRow> = contexts
      ? this.namedNearBounds(named, clause, inWindow, timeParams)
      : (this.db
          .prepare(
            `SELECT context, timestamp, lat, lon FROM positions WHERE (${clause.where})${inWindow} ORDER BY context, timestamp`,
          )
          .all(...clause.params, ...timeParams) as unknown as PositionRow[])
    const inBounds = createInBounds(bounds)
    const times = new Map<Context, number[]>()
    let insideRows = 0
    for (const { context, timestamp, lat, lon } of inside) {
      insideRows++
      if (inBounds([lat, lon])) {
        const list = times.get(context)
        if (list) {
          list.push(timestamp)
        } else {
          times.set(context, [timestamp])
        }
      }
    }
    // Read range by range, the named contexts' times can come in cell order.
    if (contexts) {
      for (const list of times.values()) {
        list.sort((a, b) => a - b)
      }
    }

    const columns = 'SELECT rowid AS id, context, timestamp, lat, lon FROM positions WHERE context = ?'
    const between = this.db.prepare(`${columns} AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp, rowid`)
    const before = this.db.prepare(
      `${columns} AND timestamp < ?${inWindow} ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
    )
    const after = this.db.prepare(`${columns} AND timestamp > ?${inWindow} ORDER BY timestamp, rowid LIMIT 1`)
    // The row after one in the order rows are kept: by time, then by row
    // among those recorded at the same time.
    const sameTime = this.db.prepare(`${columns} AND timestamp = ? AND rowid > ? ORDER BY rowid LIMIT 1`)
    const nextAfter = (row: NumberedRow) =>
      (sameTime.get(row.context, row.timestamp, row.id) ??
        after.get(row.context, row.timestamp, ...timeParams)) as unknown as NumberedRow | undefined
    for (const [context, list] of times) {
      const rows = new Map<number, NumberedRow>()
      let last: NumberedRow | undefined
      for (const [start, end] of stretchesOf(list, this.stretchGap)) {
        const read = [
          ...(before.all(context, start, ...timeParams) as unknown as NumberedRow[]),
          ...(between.all(context, start, end) as unknown as NumberedRow[]),
          ...(after.all(context, end, ...timeParams) as unknown as NumberedRow[]),
        ]
        // A stretch read apart from the one before leaves out what was
        // recorded between them. Marked, so the clip draws no line from one
        // to the other: across the box, it would be one never sailed.
        const first = read[0]
        if (last && first && !rows.has(first.id) && nextAfter(last)?.id !== first.id) {
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
        context,
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
    const fromSignificant = `SELECT position AS id, context, timestamp, lat, lon FROM significant INDEXED BY idx_significant_time WHERE context = ?`
    const fromPositions = 'SELECT rowid AS id, context, timestamp, lat, lon FROM positions WHERE context = ?'
    const visited = this.db.prepare(
      `SELECT DISTINCT hour FROM level_visits
       WHERE context = ? AND lat_cell BETWEEN ? AND ? AND lon_cell BETWEEN ? AND ? AND hour >= ? AND hour <= ?`,
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
          for (const { hour } of visited.all(context, south!, north!, west!, east!, first, last) as unknown as {
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
          context,
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
            context,
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
            const row = seek.get(context, level, held.from, held.to) as unknown as NumberedRow | undefined
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
            context,
            held.from,
            held.to,
          ) as unknown as NumberedRow[]
          for (const row of read) {
            rows.set(row.id, row)
          }
        }
        for (const part of unrefinedIn(refined, stretch)) {
          for (const row of query(`${fromPositions}${inRange(part)}`).all(
            context,
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
   */
  refineLevels(now = Date.now()): void {
    const lastDay = dayOf(now - DETAIL_KEEP) - 1
    let budget = this.refineBudget
    const partial = this.refinePartial
    if (partial) {
      this.refinePartial = undefined
      budget = this.refineDay(partial.context, partial.day, partial.next, budget, partial.stale)
      if (this.refinePartial || budget <= 0) {
        return
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
          return
        }
      }
    }
    if (this.refinedThrough === lastDay) {
      return
    }
    const nextContext = this.db.prepare('SELECT context FROM positions WHERE context > ? ORDER BY context LIMIT 1')
    const firstAt = this.db.prepare(
      'SELECT timestamp FROM positions WHERE context = ? AND timestamp >= ? ORDER BY timestamp LIMIT 1',
    )
    let context: string | undefined = this.refineResume
    if (context === undefined) {
      context = (nextContext.get('') as { context: string } | undefined)?.context
    }
    this.refineResume = undefined
    while (context !== undefined) {
      for (;;) {
        const through = this.levelFrontier.get(context)
        const row = firstAt.get(
          context,
          through === undefined ? Number.NEGATIVE_INFINITY : (through + 1) * LEVEL_DAY_MS,
        ) as { timestamp: number } | undefined
        if (!row || dayOf(row.timestamp) > lastDay) {
          break
        }
        budget = this.refineDay(context, dayOf(row.timestamp), Number.NEGATIVE_INFINITY, budget, false)
        if (this.refinePartial || budget <= 0) {
          this.refineResume = context
          return
        }
      }
      context = (nextContext.get(context) as { context: string } | undefined)?.context
    }
    this.refinedThrough = lastDay
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
    const read = (limit: number) =>
      statements.select.all(context, Math.max(from, dayStart), dayEnd, limit) as unknown as (Omit<
        PositionRow,
        'context'
      > & {
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
      statements.visit.run(context, ...key.split(' ').map(Number))
    }
    if (stopped) {
      return budget
    }
    if (stale) {
      statements.unstale.run(context, day)
    } else {
      statements.frontier.run(context, day)
      this.levelFrontier.set(context, day)
    }
    return budget
  }

  /** refineDay()'s statements, prepared once: it runs for every day of every vessel. */
  private refining() {
    return (this.refineStatements ??= {
      select: this.db.prepare(
        'SELECT rowid AS id, timestamp, lat, lon FROM positions WHERE context = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?',
      ),
      copy: this.db.prepare(
        `INSERT INTO significant (position, context, timestamp, lat, lon, level)
         SELECT rowid, context, timestamp, lat, lon, ? FROM positions WHERE rowid = ?`,
      ),
      visit: this.db.prepare(
        'INSERT OR IGNORE INTO level_visits (context, lat_cell, lon_cell, hour) VALUES (?, ?, ?, ?)',
      ),
      unstale: this.db.prepare('DELETE FROM level_stale WHERE context = ? AND day = ?'),
      frontier: this.db.prepare(
        'INSERT INTO level_frontier (context, through) VALUES (?, ?) ON CONFLICT(context) DO UPDATE SET through = excluded.through',
      ),
      // Every level named, so each is a seek on the time index, not a walk over the context's rows.
      deleteSignificant: this.db.prepare(
        `DELETE FROM significant WHERE context = ? AND level IN (${SIGNIFICANT_LEVELS}) AND timestamp >= ? AND timestamp < ?`,
      ),
      deleteVisits: this.db.prepare('DELETE FROM level_visits WHERE context = ? AND hour >= ? AND hour < ?'),
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
   * `fillTrack`, `binRecorded`, `restoreFromBin`, both retentions and detail
   * thinning. A stay still going on, thinned at the spacing of the last
   * prune, sends back only what aged since then, so its days are not refined
   * again every hour.
   */
  private invalidateLevels(context: Context, from: number, to: number): void {
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
      'SELECT timestamp FROM positions WHERE context = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp LIMIT 1',
    )
    const queue = this.db.prepare('INSERT OR IGNORE INTO level_stale (context, day) VALUES (?, ?)')
    for (let day = first; day <= last;) {
      const row = next.get(context, day * LEVEL_DAY_MS, end) as { timestamp: number } | undefined
      if (!row) {
        break
      }
      day = dayOf(row.timestamp)
      queue.run(context, day)
      day++
    }
  }

  /** Take a context's significant positions, and its visits, from `from` until `to` out. */
  private deleteSignificant(context: Context, from: number, to: number): void {
    const statements = this.refining()
    statements.deleteSignificant.run(context, from, to)
    statements.deleteVisits.run(context, Math.floor(from / VISIT_HOUR_MS), Math.ceil(to / VISIT_HOUR_MS))
  }

  /** Forget a context's levels, for one whose positions are all gone or replaced. */
  private clearLevels(context: Context): void {
    this.db.prepare('DELETE FROM significant WHERE context = ?').run(context)
    this.db.prepare('DELETE FROM level_visits WHERE context = ?').run(context)
    this.db.prepare('DELETE FROM level_frontier WHERE context = ?').run(context)
    this.db.prepare('DELETE FROM level_stale WHERE context = ?').run(context)
    this.levelFrontier.delete(context)
    this.refinedThrough = undefined
    if (this.refinePartial?.context === context) {
      this.refinePartial = undefined
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
    // Per context through the (context, timestamp) index rather than one
    // DELETE over the table: that index cannot seek on a timestamp alone, so a
    // single statement would scan every row each hour even with nothing to
    // drop. The grouping below reads only the index.
    const spans = this.db
      .prepare('SELECT context, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM positions GROUP BY context')
      .all() as { context: string; oldest: number; newest: number }[]
    const aged = spans.filter(({ context, oldest }) => context !== keep && oldest < cutoff)
    const trim = this.db.prepare('DELETE FROM positions WHERE context = ? AND timestamp < ?')
    for (const { context } of aged) {
      trim.run(context, cutoff)
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
        this.db.prepare('DELETE FROM positions WHERE timestamp < ? AND context IS ?').run(oldest, keep)
      }
      for (const { context, oldest: first } of spans) {
        if (first < oldest && (keep === undefined || context === keep)) {
          this.invalidateLevels(context, Number.NEGATIVE_INFINITY, oldest)
        }
      }
    }
    this.thinOldDetail(now)
  }

  /**
   * Thin what each detail span holds older than `DETAIL_KEEP`, keeping the
   * first position of every bucket. A span that ended before that goes back to
   * the store's resolution, so a season at anchor costs what the recording
   * would have without it. A span that has not, a stay at anchor that is
   * still going on, keeps its older part at the spacing an anchor alarm reads
   * the whole stay at, about `DETAIL_STAY_POINTS` points, until that spacing
   * reaches the store's resolution, which it never goes coarser than.
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
      `DELETE FROM positions WHERE context = ?1 AND timestamp >= ?2 AND timestamp <= ?3 AND rowid NOT IN (
         SELECT id FROM (
           SELECT rowid AS id, min(timestamp) FROM positions
           WHERE context = ?1 AND timestamp >= ?2 AND timestamp <= ?3
           GROUP BY timestamp / CAST(?4 AS INTEGER)
         )
       )`,
    )
    const done = this.db.prepare('DELETE FROM detail_spans WHERE id = ?')
    for (const { id, context, start, end } of spans) {
      if (end < cutoff) {
        if (thin.run(context, start, end, this.resolution).changes) {
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
        if (thin.run(context, start, cutoff - 1, spacing).changes) {
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
   * Write the runs a track imported for a vessel fills into its recording,
   * where it has nothing, and return how many points were left out. Nothing
   * is binned. The runs are judged again here, in the same transaction,
   * against the recording as it is now: another upload or a restore can
   * write into a gap while history is read for it, and what it wrote stays.
   */
  fillTrack(context: Context, runs: TimedPosition[][]): number {
    const recorded = this.db.prepare(
      'SELECT timestamp FROM positions WHERE context = ? AND timestamp >= ? AND timestamp <= ?',
    )
    const kept: TimedPosition[][] = []
    let overlapping = 0
    for (const run of runs) {
      const first = run[0]
      const last = run.at(-1)
      if (first === undefined || last === undefined) continue
      const around = recorded.all(context, first.timestamp - MIN_FILLED_GAP_MS, last.timestamp + MIN_FILLED_GAP_MS) as {
        timestamp: number
      }[]
      const judged = fillGaps([run], around, MIN_FILLED_GAP_MS)
      kept.push(...judged.runs)
      overlapping += judged.overlapping
    }
    this.fill(context, kept)
    return overlapping
  }

  /**
   * Write positions into a vessel's recording as they come, past the
   * throttle, and keep them as imported rather than thin them as detail.
   */
  private fill(context: Context, segments: TimedPosition[][]): void {
    for (const points of segments) {
      const first = points[0]
      const last = points.at(-1)
      if (first === undefined || last === undefined) continue
      this.excludeFromDetail(context, first.timestamp, last.timestamp)
    }
    // The next live fix would otherwise open a detail span from the last one
    // recorded before the import, reaching over the imported points.
    this.lastStored.delete(context)
    for (const points of segments) {
      for (const { position, timestamp } of points) {
        this.store(context, position, timestamp)
      }
      const first = points[0]
      const last = points.at(-1)
      if (first !== undefined && last !== undefined) {
        this.invalidateLevels(context, first.timestamp, last.timestamp)
      }
    }
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
   * says another source does: the span still has to hide what a history
   * provider holds. Without one, an empty delete leaves no entry behind.
   */
  binRecorded(
    context: Context,
    from: number | undefined,
    to: number,
    deletedAt: number,
    keepEmpty: boolean,
  ): { id?: number; known: boolean } {
    const known = this.knows(context)
    const lower = from ?? Number.MIN_SAFE_INTEGER
    const id = this.newBinEntry({ context, ...(from === undefined ? {} : { from }), to, deletedAt })
    const moved = Number(
      this.db
        .prepare(
          `INSERT INTO binned_positions (bin_id, context, timestamp, lat, lon, s2cell)
           SELECT ?, context, timestamp, lat, lon, s2cell FROM positions
           WHERE context = ? AND timestamp >= ? AND timestamp <= ?`,
        )
        .run(id, context, lower, to).changes,
    )
    if (moved === 0 && !keepEmpty) {
      this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(id)
      return { known }
    }
    this.db
      .prepare('DELETE FROM positions WHERE context = ? AND timestamp >= ? AND timestamp <= ?')
      .run(context, lower, to)
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
          'SELECT context, min(timestamp) AS first, max(timestamp) AS last FROM binned_positions WHERE bin_id = ? GROUP BY context',
        )
        .all(id) as unknown as { context: string; first: number; last: number }[]
      this.db
        .prepare(
          `INSERT INTO positions (context, timestamp, lat, lon, s2cell)
           SELECT context, timestamp, lat, lon, s2cell FROM binned_positions WHERE bin_id = ?`,
        )
        .run(id)
      for (const { context, first, last } of spans) {
        this.invalidateLevels(context, first, last)
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
      // What the write did to the level state in memory went with it.
      this.loadLevels()
      throw error
    }
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
    const stmt = this.db.prepare('SELECT s2cell FROM positions WHERE context = ? ORDER BY timestamp, rowid')
    stmt.setReadBigInts(true)
    const rows = stmt.all(context) as unknown as { s2cell: bigint }[]
    return rows.map(({ s2cell }) => toUnsigned(s2cell))
  }
}
