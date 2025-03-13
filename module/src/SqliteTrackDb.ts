import Database, { Database as BetterSqlite3Database, Statement } from 'better-sqlite3'
import { s2, geojson } from 's2js'
import path from 'path'
import { getSqDist, simplify } from './simplify'
import { TracksDB } from './tracks'
import { Debug, GeoBounds, LatLngTuple, TrackCollection, TrackParams } from './types'
import { Context } from '@signalk/server-api'
const RegionCoverer = geojson.RegionCoverer
import { Polygon } from 'geojson'

interface DbRow {
  timestamp: number
  lat: number
  lon: number
  s2cell: number
}

export class SqliteTrackDb implements TracksDB {
  db: BetterSqlite3Database
  insertStmt: Statement
  selfContext: Context
  constructor(selfId: string, dataDir: string) {
    this.selfContext = `vessels.${selfId}` as Context
    this.db = new Database(path.join(dataDir, 'tracks.db'))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
          timestamp INTEGER,
          lat REAL,
          lon REAL,
          s2cell INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_s2cell ON positions(s2cell);`)
    this.insertStmt = this.db.prepare('INSERT INTO positions (timestamp, lat, lon, s2cell) VALUES (?, ?, ?, ?)')
  }
  get(context: Context): Promise<LatLngTuple[]> {
    console.log(context)
    if (context !== this.selfContext && context !== 'vessels.self' && context !== 'self') {
      return Promise.resolve([])
    }
    //fetch rows that are not older than 1 hour
    const rows = this.db.prepare('select lat, lon from positions where timestamp > ?').all(Date.now() - 3600000) as {
      lat: number
      lon: number
    }[]
    return Promise.resolve(rows.map((row) => [row.lat, row.lon]))
  }

  newPosition(context: Context, position: LatLngTuple, timestamp: number = Date.now()): void {
    const cellId = Number(s2.Cell.fromLatLng(s2.LatLng.fromDegrees(position[0], position[1])).id)
    this.insertStmt.run(timestamp, position[0], position[1], cellId)
  }

  getFilteredTracks(params: TrackParams, selfPosition?: LatLngTuple, debug?: Debug): Promise<TrackCollection> {
    debug && debug(params)
    if (!params.bbox && !selfPosition) {
      return Promise.reject()
    }

    const bbox = params.bbox ?? boundingBoxFromGeoLocation(selfPosition || [0, 0], params.radius || 1000)
    debug && debug(JSON.stringify(bbox))

    if (!selfPosition) {
      return Promise.reject()
    }
    const selfCell = Number(s2.Cell.fromLatLng(s2.LatLng.fromDegrees(selfPosition[0], selfPosition[1])).id)
    console.log(selfCell, 'S', selfCell.toString(2))
    let positions: DbRow[] = []
    if (bbox !== null) {
      const query = getBBoxQuery(bbox, debug)
      debug?.(`Query: ${query}`)
      positions = this.db.prepare(query).all() as DbRow[]
    }
    debug?.(`Found ${positions.length} positions`)

    // Group tracks into segments with 5 min (300000ms) threshold
    const segments: DbRow[][] = []
    let currentSegment: DbRow[] = []

    positions.forEach((track, index) => {
      if (index === 0) {
        currentSegment.push(track)
        return
      }

      const timeDiff = track.timestamp - positions[index - 1].timestamp
      if (timeDiff > 300000) {
        // 5 minutes in milliseconds
        if (currentSegment.length > 0) {
          segments.push(currentSegment)
        }
        currentSegment = [track]
      } else {
        currentSegment.push(track)
      }
    })

    if (currentSegment.length > 0) {
      segments.push(currentSegment)
    }

    const threshold = bbox !== null ? getSqDist([bbox.sw[0], bbox.sw[1]], [bbox.ne[0], bbox.ne[1]]) / 1000 : 0.001
    const tracks = segments.reduce<LatLngTuple[][]>((acc, segment) => {
      acc.push(
        simplify(
          segment.map((row) => [row.lat, row.lon]),
          threshold,
        ),
      )
      return acc
    }, [])

    const result = {} as { [key: Context]: LatLngTuple[][] }
    result[this.selfContext] = tracks
    return Promise.resolve(result)
  }
}

const getBBoxQuery = ({ sw, ne }: GeoBounds, debug?: Debug): string => {
  const [s, w] = sw
  const [n, e] = ne
  const coverer = new RegionCoverer({ maxLevel: 30, maxCells: 8 })
  const linestring = {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [w, n],
        [e, n],
        [e, s],
        [w, s],
      ],
    ],
  } as Polygon
  debug && debug(JSON.stringify(linestring))
  const covering = coverer.covering(linestring)

  // Convert covering to range queries
  const rangeQueries = covering.map((cellId) => {
    const start = lowerBoundForContainedCellIds(cellId)
    const end = upperBoundForContainedCellIds(cellId)
    return `(s2cell >= ${start} AND s2cell <= ${end})`
  })

  const whereClause = rangeQueries.join('\n OR \n')
  const query = `SELECT * FROM positions WHERE ${whereClause} ORDER BY timestamp`

  debug?.(`Query: ${query}`)
  return query
}

const earthRadiusM = 6371 * 1000

function boundingBoxFromGeoLocation(position: LatLngTuple, radius: number): GeoBounds {
  const [lat, lon] = position
  const latRad = (lat * Math.PI) / 180
  const lonRad = (lon * Math.PI) / 180

  const angularRadius = radius / earthRadiusM

  const minLat = latRad - angularRadius
  const maxLat = latRad + angularRadius

  const deltaLon = Math.asin(Math.sin(angularRadius) / Math.cos(latRad))

  //Handle edge cases where lats are near poles
  if (minLat > Math.PI / 2 || maxLat < -Math.PI / 2) {
    return {
      sw: [-90, -180],
      ne: [90, 180],
    }
  }

  let minLon = lonRad - deltaLon
  let maxLon = lonRad + deltaLon

  //Handle edge cases where lons wrap around the earth
  if (minLon < -Math.PI) {
    minLon += 2 * Math.PI
  }
  if (maxLon > Math.PI) {
    maxLon -= 2 * Math.PI
  }

  const minLatDeg = (minLat * 180) / Math.PI
  const maxLatDeg = (maxLat * 180) / Math.PI
  const minLonDeg = (minLon * 180) / Math.PI
  const maxLonDeg = (maxLon * 180) / Math.PI

  return {
    sw: [minLatDeg, minLonDeg],
    ne: [maxLatDeg, maxLonDeg],
  }
}

const upperBoundForContainedCellIds = (cellId: bigint) => {
  let temp = cellId
  let mask = 1n

  // flip trailing zeroes
  while ((temp & 1n) === 0n) {
    cellId |= mask
    mask <<= 1n
    temp >>= 1n
  }

  // move mask one more time, over the trailing marker bit
  // of the original cellId to the actual least significant
  // bit of the cell id and flip also that
  mask <<= 1n
  cellId |= mask
  return cellId
}

const lowerBoundForContainedCellIds = (cellId: bigint) => {
  if (typeof cellId !== 'bigint') {
    throw new TypeError('Input must be a bigint.')
  }

  if (cellId === 0n) {
    return 2n // If input is 0, set the 2nd bit to 1.
  }

  let temp = cellId
  let leastSignificantOneIndex = -1
  let index = 0

  while (temp > 0n) {
    if ((temp & 1n) === 1n) {
      leastSignificantOneIndex = index
      break
    }
    temp >>= 1n
    index++
  }

  if (leastSignificantOneIndex === -1) {
    return 2n // If no 1 bit found, same as input 0
  }

  // Flip the least significant 1 to 0
  const flipped = cellId & ~(1n << BigInt(leastSignificantOneIndex))

  // Set the next most significant bit to 1
  const nextBitSet = flipped | (1n << BigInt(leastSignificantOneIndex + 1))

  return nextBitSet
}
