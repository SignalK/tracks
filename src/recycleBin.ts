import type { DeletedSpan, TimedPosition } from './types.js'

/**
 * Prefix of a recorded track's id. The rest is the vessel's context: a vessel
 * has one recording, so its context is all an id needs, and a provider may
 * derive the id from it, as the server's Track API foresees.
 */
export const RECORDED_PREFIX = 'recorded:'

export const recordedId = (context: string): string => `${RECORDED_PREFIX}${context}`

/** The context a recorded track's id names, or undefined for any other id. */
export const recordedContext = (id: string): string | undefined =>
  id.startsWith(RECORDED_PREFIX) && id.length > RECORDED_PREFIX.length ? id.slice(RECORDED_PREFIX.length) : undefined

/**
 * The points outside every deleted span.
 *
 * Applied to what a history provider returns, which this plugin cannot delete
 * from: without it the next query would fill a deleted span back in.
 */
export function outsideSpans(points: TimedPosition[], spans: readonly DeletedSpan[]): TimedPosition[] {
  if (spans.length === 0) {
    return points
  }
  return points.filter(
    ({ timestamp }) => !spans.some(({ from, to }) => (from === undefined || timestamp >= from) && timestamp <= to),
  )
}
