import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { s2, geojson } from 's2js'
import { thin } from './timeWindow.js'
import type { TrackQuery } from './timeWindow.js'
import type { TrackStore } from './store.js'
import { createInBounds, createMatcher, splitAtAntimeridian } from './utils.js'
import type {
  Context,
  Debug,
  GeoBounds,
  LatLngTuple,
  TimedPosition,
  TimeWindow,
  TrackCollection,
  TrackParams,
} from './types.js'

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
  private readonly maxCells: number
  private readonly segmentGap: number
  private readonly retention: number
  private readonly resolution: number
  private readonly debug: Debug
  /** Timestamp of the last position stored per context, for throttling. */
  private readonly lastStored = new Map<string, number>()

  constructor(config: SqliteStoreConfig, debug: Debug) {
    this.maxCells = config.maxCells ?? DEFAULT_MAX_CELLS
    this.segmentGap = config.segmentGap ?? DEFAULT_SEGMENT_GAP
    this.retention = config.retention ?? 0
    this.resolution = config.resolution ?? 0
    this.debug = debug

    this.db = new DatabaseSync(config.file)
    // WAL keeps a reader from blocking the writer, which matters because
    // positions arrive continuously while a query is being served.
    this.db.exec('PRAGMA journal_mode = WAL')
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
    `)
    this.insert = this.db.prepare('INSERT INTO positions (context, timestamp, lat, lon, s2cell) VALUES (?, ?, ?, ?, ?)')
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
    // Replaces the context's history, matching the in-memory store: the
    // bootstrap is authoritative for the window it covers.
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
   * Tracks whose last position matches the spatial predicate.
   *
   * Two filters run, and they are not redundant despite both testing bounds:
   *
   * - `contextsInBounds` asks the cell index which contexts have *any* position
   *   near the box. It is a cheap prefilter that keeps the query off every row
   *   in the table, and it decides nothing on its own.
   * - `matcher` — the same predicate the in-memory store uses — then tests each
   *   track's *last* position, which is what the endpoint actually means by
   *   "in this box". That test is authoritative.
   *
   * Because `matcher` has the final say, dropping the exact-bounds check inside
   * `contextsInBounds` does not change any result; it only widens the candidate
   * set. It is kept because a prefilter that returns half the table is not
   * worth running, not because correctness depends on it.
   */
  getFilteredTracks(
    params: TrackParams,
    selfPosition?: LatLngTuple,
    debug?: Debug,
    query?: TrackQuery,
  ): Promise<TrackCollection> {
    const candidates = params.bbox ? this.contextsInBounds(params.bbox) : undefined
    const matcher = createMatcher(params, selfPosition, debug)

    return this.getAllTracks(query).then((tracks) =>
      tracks.reduce<TrackCollection>((acc, { context, track }) => {
        if ((!candidates || candidates.has(context)) && matcher(track)) {
          acc[context] = track
        }
        return acc
      }, {}),
    )
  }

  /** Contexts with at least one position inside `bounds`, via the cell index. */
  private contextsInBounds(bounds: GeoBounds): Set<string> {
    const covering = coveringFor(bounds, this.maxCells)
    const found = new Set<string>()
    if (covering.length === 0) {
      return found
    }

    // Bound parameters, never interpolation: `BETWEEN ${start} <= s2cell AND
    // ${end}` parses as `s2cell BETWEEN (start <= s2cell) AND end`, collapsing
    // the lower bound to 0 or 1 so the range starts at zero and out-of-range
    // rows leak in.
    const ranges = covering.map(cellRange)
    const where = ranges.map(() => '(s2cell BETWEEN ? AND ?)').join(' OR ')
    const params = ranges.flatMap(({ start, end }) => [toSigned(start), toSigned(end)])

    const stmt = this.db.prepare(`SELECT DISTINCT context, lat, lon FROM positions WHERE ${where}`)
    const rows = stmt.all(...params) as unknown as { context: string; lat: number; lon: number }[]

    const inBounds = createInBounds(bounds)
    for (const { context, lat, lon } of rows) {
      if (inBounds([lat, lon])) {
        found.add(context)
      }
    }
    if (this.debug.enabled) {
      this.debug(`bbox covering ${covering.length} cells -> ${rows.length} rows -> ${found.size} contexts`)
    }
    return found
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

  prune(maxAge: number): void {
    const cutoff = Date.now() - maxAge
    // Drop whole contexts that have gone quiet, matching the in-memory store,
    // then apply the row-level retention if one is configured.
    this.db
      .prepare(
        'DELETE FROM positions WHERE context IN (SELECT context FROM positions GROUP BY context HAVING MAX(timestamp) < ?)',
      )
      .run(cutoff)
    if (this.retention > 0) {
      this.db.prepare('DELETE FROM positions WHERE timestamp < ?').run(Date.now() - this.retention)
    }
  }

  close(): void {
    this.db.close()
  }

  /** Unsigned round-trip check, used by the tests. */
  cellIdsFor(context: Context): bigint[] {
    const stmt = this.db.prepare('SELECT s2cell FROM positions WHERE context = ? ORDER BY timestamp')
    stmt.setReadBigInts(true)
    const rows = stmt.all(context) as unknown as { s2cell: bigint }[]
    return rows.map(({ s2cell }) => toUnsigned(s2cell))
  }
}
