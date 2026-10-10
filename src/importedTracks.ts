import { randomUUID } from 'node:crypto'
import { TrackRejectedError } from './trackApi.js'
import type { TrackImport } from './trackApi.js'
import type { GeoBounds, ImportedPoint, ImportedTrack, TimedPosition, TimeWindow } from './types.js'
import { clipToBounds } from './utils.js'

/**
 * Prefix of every imported track's id. It keeps imported and recorded tracks
 * in separate id spaces, so no import can ever address a recorded track.
 */
export const IMPORTED_PREFIX = 'imported:'

export const isImportedId = (id: string): boolean => id.startsWith(IMPORTED_PREFIX)

/**
 * The track the server handed over, as this plugin stores it.
 *
 * Times are sorted within each segment, the way `fromGpx` reads a file: the
 * thinning and window code assume time order, and a segment boundary is a gap
 * in recording, so segments are never merged or reordered.
 *
 * Refuses a track with neither times nor a vessel. Such a track answers no
 * time window, and the server refuses a query across all vessels without one,
 * so it could only ever be found again by an id the client would have to keep.
 */
export function toImportedTrack(track: TrackImport, id = `${IMPORTED_PREFIX}${randomUUID()}`): ImportedTrack {
  const { coordTimes, name, context, ...metadata } = track.properties
  if (coordTimes === undefined && context === undefined) {
    throw new TrackRejectedError(
      'A track with neither coordTimes nor a context could not be listed again; send one of them',
    )
  }
  const segments = track.geometry.coordinates.map((segment, i): ImportedPoint[] => {
    const points = segment.map(([lon, lat], j): ImportedPoint => {
      const time = coordTimes?.[i]?.[j]
      return time === undefined ? { position: [lat, lon] } : { position: [lat, lon], timestamp: Date.parse(time) }
    })
    return coordTimes === undefined ? points : points.sort((a, b) => a.timestamp! - b.timestamp!)
  })
  return {
    id,
    ...(context === undefined ? {} : { context }),
    ...(name === undefined ? {} : { name }),
    metadata,
    segments,
  }
}

/** Whether the track's points carry times; an import is timed throughout or not at all. */
export const isTimed = (track: ImportedTrack): boolean => track.segments[0]?.[0]?.timestamp !== undefined

/**
 * The track as one list of points for the shared pipeline, each posted segment
 * after the first starting a new line.
 *
 * Narrowed to the window and clipped per segment, so a line never joins two
 * segments: not where the window empties the start of one, nor through the
 * point just outside the box that a clipped stretch keeps, which must come
 * from its own segment. An untimed point gets timestamp 0, which only the
 * time-free paths of the pipeline ever see.
 */
export function positionsOf(track: ImportedTrack, clipTo: GeoBounds | null, window?: TimeWindow): TimedPosition[] {
  const result: TimedPosition[] = []
  for (const segment of track.segments) {
    let points = segment.map(({ position, timestamp }) => ({ position, timestamp: timestamp ?? 0 }))
    if (window) {
      points = points.filter(({ timestamp }) =>
        window.inclusiveEnd
          ? timestamp >= window.from && timestamp <= window.to
          : timestamp >= window.from && timestamp < window.to,
      )
    }
    const kept = clipTo ? clipToBounds(points, clipTo) : points
    for (const [i, point] of kept.entries()) {
      result.push(i === 0 && result.length > 0 ? { ...point, breakBefore: true } : point)
    }
  }
  return result
}

/**
 * At most `maxPoints` evenly chosen points of a track without times, keeping
 * the first and the last. A point that starts a new line passes that on to
 * the next point kept, so dropping it does not join two segments.
 */
export function decimate(points: TimedPosition[], maxPoints: number): TimedPosition[] {
  if (points.length <= maxPoints) {
    return points
  }
  if (maxPoints < 2) {
    return points.slice(0, Math.max(0, maxPoints))
  }
  const step = (points.length - 1) / (maxPoints - 1)
  const result: TimedPosition[] = []
  let previous = -1
  for (let k = 0; k < maxPoints; k++) {
    const index = Math.round(k * step)
    const breaks = points.slice(previous + 1, index + 1).some(({ breakBefore }) => breakBefore)
    const point = points[index]!
    result.push(breaks && result.length > 0 ? { ...point, breakBefore: true } : point)
    previous = index
  }
  return result
}
