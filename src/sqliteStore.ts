import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { s2, geojson } from 's2js'
import { thin } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import type { TrackStore } from './store.js'
import { createInBounds, createMatcher, longitudeSpan, splitAtAntimeridian } from './utils.js'
import type {
  Context,
  Debug,
  GeoBounds,
  ImportedPoint,
  ImportedTrack,
  ImportFilter,
  LatLngTuple,
  TimedPosition,
  TimedTrackCollection,
  TimeWindow,
  TrackCollection,
  TrackParams,
} from './types.js'

export class TransactionStateError extends Error {}

const toTimed = ({ lat, lon, timestamp }: PositionRow): TimedPosition => ({
  position: [lat, lon],
  timestamp,
})

/** Sorted times grouped into `[first, last]` stretches, split where two lie more than `gap` apart. */
const stretchesOf = (times: number[], gap: number): [number, number][] => {
  const stretches: [number, number][] = []
  for (const time of times) {
    const current = stretches[stretches.length - 1]
    if (current && time - current[1] <= gap) {
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
}

interface ImportedRow {
  id: string
  context: string | null
  name: string | null
  metadata: string
  west: number
  east: number
}

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
  /** Cells per bounding box covering. */
  maxCells?: number
  /** A gap longer than this ms starts a new track segment. */
  segmentGap?: number
}

const DEFAULT_MAX_CELLS = 8
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
  private readonly segmentGap: number
  private readonly retention: number
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

  constructor(config: SqliteStoreConfig, debug: Debug) {
    this.maxCells = config.maxCells ?? DEFAULT_MAX_CELLS
    this.segmentGap = config.segmentGap ?? DEFAULT_SEGMENT_GAP
    this.retention = config.retention ?? 0
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
      CREATE INDEX IF NOT EXISTS idx_context_timestamp ON positions(context, timestamp);
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
      CREATE TABLE IF NOT EXISTS imported_points (
        track_id  TEXT    NOT NULL,
        seq       INTEGER NOT NULL,
        segment   INTEGER NOT NULL,
        timestamp INTEGER,
        lat       REAL    NOT NULL,
        lon       REAL    NOT NULL,
        PRIMARY KEY (track_id, seq)
      ) WITHOUT ROWID;
    `)
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

  newPosition(context: Context, position: LatLngTuple, timestamp: number = Date.now()): void {
    // Leading-edge throttle per context, matching the in-memory accumulator's
    // throttleTime: the first position in a resolution window is stored and the
    // rest are dropped, not averaged. A vessel emitting at 8 Hz would otherwise
    // write hundreds of thousands of rows a day at the default 60s resolution.
    if (this.resolution > 0) {
      const previous = this.lastStored.get(context)
      // `<` not `<=`: two positions sharing a timestamp are the same instant,
      // and a stored point must not block one that is genuinely later.
      if (previous !== undefined && timestamp - previous < this.resolution) {
        return
      }
      this.lastStored.set(context, timestamp)
    }
    this.store(context, position, timestamp)
  }

  private store(context: Context, position: LatLngTuple, timestamp: number): void {
    this.insert.run(context, timestamp, position[0], position[1], toSigned(cellIdFor(position)))
  }

  initialTrack(context: Context, track: LatLngTuple[], timestamps?: number[]): void {
    // Replaces the context's history, matching the in-memory store: a caller
    // installing a known track is authoritative for the window it covers.
    this.db.prepare('DELETE FROM positions WHERE context = ?').run(context)
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
    return this.db
      .prepare(`SELECT context, timestamp, lat, lon FROM positions WHERE ${clauses.join(' AND ')} ORDER BY timestamp`)
      .all(...params) as unknown as PositionRow[]
  }

  private knows(context: Context): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM positions WHERE context = ? LIMIT 1').get(context)
    return row !== undefined
  }

  get(context: Context, window?: TimeWindow): Promise<LatLngTuple[]> {
    return this.getTimed(context, window).then((points) => points.map(({ position }) => position))
  }

  getTimed(context: Context, window?: TimeWindow): Promise<TimedPosition[]> {
    // An unknown context rejects; a known but stationary one resolves with
    // points. Resolving [] for both would make the two indistinguishable and
    // the route could not answer 404.
    if (!this.knows(context)) {
      return Promise.reject(new Error(`No track for ${context}`))
    }
    return Promise.resolve(
      this.rowsFor(context, window).map(({ lat, lon, timestamp }) => ({
        position: [lat, lon] as LatLngTuple,
        timestamp,
      })),
    )
  }

  private contexts(): Context[] {
    const rows = this.db.prepare('SELECT DISTINCT context FROM positions').all() as unknown as { context: Context }[]
    return rows.map(({ context }) => context)
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
   *   near the box. It is a cheap prefilter that keeps the query off every row
   *   in the table, and it decides nothing on its own.
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
    // A clipped query needs only the stretches near the box, so it reads those
    // instead of every position each candidate has in the window.
    const near = params.bbox && params.clip ? this.rowsNearBounds(params.bbox, query?.window) : undefined
    const candidates = near ? new Set(near.keys()) : params.bbox ? this.contextsInBounds(params.bbox) : undefined
    const matcher = createMatcher(params, selfPosition, debug)
    const requested = params.contexts ? new Set(params.contexts) : undefined

    // Narrowed before reading: rows of a context that cannot be returned are
    // not worth fetching.
    const contexts = this.contexts().filter(
      (context) => (!candidates || candidates.has(context)) && (!requested || requested.has(context)),
    )
    const tracks = await Promise.all(
      contexts.map((context) => {
        const rows = near?.get(context)
        const read = rows ? Promise.resolve(rows.map(toTimed)) : this.getTimed(context, query?.window)
        return read.then((points) => ({ context, points: thin(points, query?.resolution) }))
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
   */
  private rowsNearBounds(bounds: GeoBounds, window?: TimeWindow): Map<Context, PositionRow[]> {
    const near = new Map<Context, PositionRow[]>()
    const clause = this.coveringClause(bounds)
    if (!clause) {
      return near
    }
    const timeClauses = window ? ['timestamp >= ?', window.inclusiveEnd ? 'timestamp <= ?' : 'timestamp < ?'] : []
    const timeParams = window ? [window.from, window.to] : []
    const inWindow = timeClauses.map((c) => ` AND ${c}`).join('')

    const inside = this.db
      .prepare(
        `SELECT context, timestamp, lat, lon FROM positions WHERE (${clause.where})${inWindow} ORDER BY context, timestamp`,
      )
      .all(...clause.params, ...timeParams) as unknown as PositionRow[]
    const inBounds = createInBounds(bounds)
    const times = new Map<Context, number[]>()
    for (const { context, timestamp, lat, lon } of inside) {
      if (inBounds([lat, lon])) {
        const list = times.get(context)
        if (list) {
          list.push(timestamp)
        } else {
          times.set(context, [timestamp])
        }
      }
    }

    const columns = 'SELECT rowid AS id, context, timestamp, lat, lon FROM positions WHERE context = ?'
    const between = this.db.prepare(`${columns} AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp, rowid`)
    const before = this.db.prepare(
      `${columns} AND timestamp < ?${inWindow} ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
    )
    const after = this.db.prepare(`${columns} AND timestamp > ?${inWindow} ORDER BY timestamp, rowid LIMIT 1`)
    for (const [context, list] of times) {
      const rows = new Map<number, NumberedRow>()
      for (const [start, end] of stretchesOf(list, this.stretchGap)) {
        const read = [
          ...(before.all(context, start, ...timeParams) as unknown as NumberedRow[]),
          ...(between.all(context, start, end) as unknown as NumberedRow[]),
          ...(after.all(context, end, ...timeParams) as unknown as NumberedRow[]),
        ]
        // Keyed by row: where nothing was recorded between two stretches, one's
        // neighbour is the other's first or last row.
        for (const row of read) {
          rows.set(row.id, row)
        }
      }
      near.set(
        context,
        [...rows.values()].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
      )
    }
    if (this.debug.enabled) {
      this.debug(`clip covering ${clause.cells} cells -> ${inside.length} rows -> ${near.size} contexts`)
    }
    return near
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

  prune(maxAge: number, keep?: Context, now = Date.now()): void {
    const cutoff = now - maxAge
    // Drop whole contexts that have gone quiet, then apply the row-level
    // retention if one is configured. `keep` — the own vessel — is excluded:
    // its track has to survive a winter on a mooring.
    const dropped = this.db
      .prepare('SELECT context FROM positions GROUP BY context HAVING MAX(timestamp) < ? AND context IS NOT ?')
      .all(cutoff, keep ?? null) as { context: string }[]
    this.db
      .prepare(
        'DELETE FROM positions WHERE context IN (SELECT context FROM positions GROUP BY context HAVING MAX(timestamp) < ?) AND context IS NOT ?',
      )
      .run(cutoff, keep ?? null)
    // A vessel that has aged out takes its name with it, or this table grows
    // for every target a harbour ever put past the receiver. The remembered
    // copy goes too, or a vessel returning under the same name would be taken
    // as already stored and never written again.
    for (const { context } of dropped) {
      this.db.prepare('DELETE FROM names WHERE context = ?').run(context)
      this.lastName.delete(context)
    }
    // The write-throttle map is keyed by context and nothing else clears it, so
    // without this every vessel that ever passed leaves an entry behind — an
    // unbounded map on a server watching a busy harbour.
    for (const { context } of dropped) {
      this.lastStored.delete(context)
    }
    // Scoped to `keep` when there is one: this retention is configured as "days
    // of the own vessel's track to keep", and applying it to every context
    // would truncate an AIS vessel's track on a setting that does not name it.
    // Unscoped without a `keep`, which is how a standalone store behaves.
    if (this.retention > 0) {
      const oldest = now - this.retention
      if (keep === undefined) {
        this.db.prepare('DELETE FROM positions WHERE timestamp < ?').run(oldest)
      } else {
        this.db.prepare('DELETE FROM positions WHERE timestamp < ? AND context IS ?').run(oldest, keep)
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

  /** Delete an imported track, resolving whether there was one. */
  deleteImport(id: string): boolean {
    this.db.prepare('DELETE FROM imported_points WHERE track_id = ?').run(id)
    return Number(this.db.prepare('DELETE FROM imported_tracks WHERE id = ?').run(id).changes) > 0
  }

  getImport(id: string): ImportedTrack | undefined {
    const row = this.db.prepare('SELECT * FROM imported_tracks WHERE id = ?').get(id) as ImportedRow | undefined
    return row ? this.importFrom(row) : undefined
  }

  /** Imported tracks the filter lets through, in the order they were stored. */
  findImports(filter: ImportFilter = {}): ImportedTrack[] {
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
      .prepare(`SELECT * FROM imported_tracks ${where} ORDER BY rowid`)
      .all(...params) as unknown as ImportedRow[]
    // Longitude in JS rather than SQL: either box may cross the antimeridian.
    const box = filter.bbox
    if (box) {
      rows = rows.filter((row) => longitudesOverlap([row.west, row.east], [box.sw[1], box.ne[1]]))
    }
    return rows.map((row) => this.importFrom(row))
  }

  private importFrom(row: ImportedRow): ImportedTrack {
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
      throw error
    }
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
      this.db.exec('COMMIT')
    } finally {
      this.db.close()
    }
  }

  /** Unsigned round-trip check, used by the tests. */
  cellIdsFor(context: Context): bigint[] {
    const stmt = this.db.prepare('SELECT s2cell FROM positions WHERE context = ? ORDER BY timestamp')
    stmt.setReadBigInts(true)
    const rows = stmt.all(context) as unknown as { s2cell: bigint }[]
    return rows.map(({ s2cell }) => toUnsigned(s2cell))
  }
}
