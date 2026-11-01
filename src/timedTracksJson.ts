import { segment } from './timeWindow.js'
import type { TimedTrackCollection } from './types.js'
import { toIsoTimes, withPoints } from './utils.js'

/**
 * Each vessel's segmented coordinates and times as the UTF-8 JSON members
 * `"coordinates":…,"times":…`, for the v1 list's `times` answer.
 *
 * Built where the track was read, in the store's worker: a vessel's answer is
 * an array and an ISO string per point, and making those on the server's
 * thread stalled it for as long as the store had taken to read them. Bytes
 * cross back by transfer, and the server's thread only frames each vessel
 * with the members it alone knows (its name, whether it is the own vessel).
 *
 * A vessel with no points in the window is left out, as the list leaves it
 * out.
 */
export function timedTracksJson(tracks: TimedTrackCollection, segmentGap: number): Record<string, Uint8Array> {
  const encoder = new TextEncoder()
  const fragments: Record<string, Uint8Array> = {}
  for (const [context, points] of withPoints(tracks)) {
    const segments = segment(points, segmentGap)
    const members = JSON.stringify({
      coordinates: segments.map((s) => s.map(({ position: [lat, lng] }) => [lng, lat])),
      times: segments.map(toIsoTimes),
    })
    fragments[context] = encoder.encode(members.slice(1, -1))
  }
  return fragments
}
