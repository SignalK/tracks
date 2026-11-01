import type { LatLngTuple, TimedPosition } from './types.js'

/**
 * Positions as columns of numbers, for the trip from the track worker to the
 * server's thread. Structured clone copies an object and an array per
 * position, which for a read of 250,000 points cost about as much time as the
 * read and doubled the memory it held; these arrays' buffers are transferred
 * instead, and only the receiving side builds the objects.
 *
 * `pauseBefore` and `span` hold `NaN` where a point has none, and each of the
 * optional columns is left out when no point has a value for it.
 */
export interface PackedTrack {
  /** Latitude and longitude of each point in turn. */
  coordinates: Float64Array
}

export interface PackedTimedTrack extends PackedTrack {
  timestamps: Float64Array
  pauseBefore?: Float64Array
  span?: Float64Array
  breakBefore?: Uint8Array
}

function column(
  points: TimedPosition[],
  value: (point: TimedPosition) => number | undefined,
  transfer: ArrayBuffer[],
): Float64Array | undefined {
  if (!points.some((point) => value(point) !== undefined)) return undefined
  const values = new Float64Array(points.length)
  for (let i = 0; i < points.length; i++) values[i] = value(points[i]!) ?? NaN
  transfer.push(values.buffer)
  return values
}

function packCoordinates(positions: LatLngTuple[], transfer: ArrayBuffer[]): Float64Array {
  const coordinates = new Float64Array(positions.length * 2)
  for (let i = 0; i < positions.length; i++) {
    const [lat, lon] = positions[i]!
    coordinates[2 * i] = lat
    coordinates[2 * i + 1] = lon
  }
  transfer.push(coordinates.buffer)
  return coordinates
}

/** Packs `positions`, adding the buffers to transfer to `transfer`. */
export function packPositions(positions: LatLngTuple[], transfer: ArrayBuffer[]): PackedTrack {
  return { coordinates: packCoordinates(positions, transfer) }
}

export function unpackPositions({ coordinates }: PackedTrack): LatLngTuple[] {
  const positions = new Array<LatLngTuple>(coordinates.length / 2)
  for (let i = 0; i < positions.length; i++) positions[i] = [coordinates[2 * i]!, coordinates[2 * i + 1]!]
  return positions
}

/** Packs `points`, adding the buffers to transfer to `transfer`. */
export function packTimed(points: TimedPosition[], transfer: ArrayBuffer[]): PackedTimedTrack {
  const timestamps = new Float64Array(points.length)
  for (let i = 0; i < points.length; i++) timestamps[i] = points[i]!.timestamp
  transfer.push(timestamps.buffer)
  const packed: PackedTimedTrack = {
    coordinates: packCoordinates(
      points.map(({ position }) => position),
      transfer,
    ),
    timestamps,
  }
  const pauseBefore = column(points, (point) => point.pauseBefore, transfer)
  if (pauseBefore) packed.pauseBefore = pauseBefore
  const span = column(points, (point) => point.span, transfer)
  if (span) packed.span = span
  if (points.some((point) => point.breakBefore)) {
    const breakBefore = new Uint8Array(points.length)
    for (let i = 0; i < points.length; i++) if (points[i]!.breakBefore) breakBefore[i] = 1
    transfer.push(breakBefore.buffer)
    packed.breakBefore = breakBefore
  }
  return packed
}

export function unpackTimed({
  coordinates,
  timestamps,
  pauseBefore,
  span,
  breakBefore,
}: PackedTimedTrack): TimedPosition[] {
  const points = new Array<TimedPosition>(timestamps.length)
  for (let i = 0; i < points.length; i++) {
    const point: TimedPosition = { position: [coordinates[2 * i]!, coordinates[2 * i + 1]!], timestamp: timestamps[i]! }
    const pause = pauseBefore?.[i]
    if (pause !== undefined && !Number.isNaN(pause)) point.pauseBefore = pause
    const stretch = span?.[i]
    if (stretch !== undefined && !Number.isNaN(stretch)) point.span = stretch
    if (breakBefore?.[i]) point.breakBefore = true
    points[i] = point
  }
  return points
}
