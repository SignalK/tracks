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
 * from: without it the next query would fill a deleted span back in. A
 * history point stands for a bucket starting at its timestamp, and the fix it
 * carries can lie anywhere in that bucket, so a bucket that overlaps a span at
 * all is dropped; the store's own points answer for the rest of it.
 */
export function outsideSpans(points: TimedPosition[], spans: readonly DeletedSpan[]): TimedPosition[] {
  if (spans.length === 0) {
    return points
  }
  return points.filter(({ timestamp, span = 0 }) => !spans.some((deleted) => overlaps(timestamp, span, deleted)))
}

/** Whether `[start, start + width)`, or the instant `start` when `width` is 0, meets `[from, to]`. */
function overlaps(start: number, width: number, { from, to }: DeletedSpan): boolean {
  if (start > to) {
    return false
  }
  if (from === undefined) {
    return true
  }
  return width > 0 ? start + width > from : start >= from
}
