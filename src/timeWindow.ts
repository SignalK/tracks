import { Type } from 'typebox'
import { Value } from 'typebox/value'
import type { TimedPosition, TimeWindow } from './types.js'

/**
 * Time-window and resolution query parameters.
 *
 * Two vocabularies are accepted:
 *
 * - `from` / `to` / `duration` mirror the Signal K History API and are the
 *   shape proposed for the track API in SignalK/signalk-server#2504.
 * - `timespan` / `timespanOffset` are what Freeboard-SK sends today. They are
 *   compatibility only, not part of any spec, and are expected to be dropped
 *   once Freeboard moves to the parameters above.
 *
 * `resolution` is shared by both and expresses the minimum spacing between
 * returned points, thinning the track for wide time ranges.
 */
const QuerySchema = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  duration: Type.Optional(Type.String()),
  timespan: Type.Optional(Type.String()),
  timespanOffset: Type.Optional(Type.String()),
  resolution: Type.Optional(Type.String()),
})

export class TimeWindowError extends Error {}

/** `30`, `30s`, `5m`, `2h`, `7d` — seconds unless suffixed. Returns milliseconds. */
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*([smhd])?$/

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
}

export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim())
  const amount = match?.[1]
  if (!amount) {
    throw new TimeWindowError(`Invalid duration '${value}', expected a number optionally suffixed with s, m, h or d`)
  }
  const unit = match[2] ?? 's'
  const scale = UNIT_MS[unit]
  if (scale === undefined) {
    throw new TimeWindowError(`Invalid duration unit '${unit}'`)
  }
  return Number(amount) * scale
}

function parseInstant(value: string, name: string): number {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new TimeWindowError(`Invalid ${name} '${value}', expected an ISO-8601 timestamp`)
  }
  return ms
}

/** Express repeats a query key into an array; take the first usable string. */
function firstString(value: unknown): string | undefined {
  const scalar: unknown = Array.isArray(value) ? (value as unknown[])[0] : value
  return typeof scalar === 'string' && scalar.trim() !== '' ? scalar : undefined
}

export interface TrackQuery {
  window?: TimeWindow
  /** Minimum spacing between returned points, in milliseconds. */
  resolution?: number
}

/**
 * Resolve the time-window parameters into an absolute `[from, to)` window.
 *
 * Precedence: explicit `from`/`to` win; then `duration`; then the Freeboard
 * `timespan`/`timespanOffset` pair. Absent all of them, no window is applied
 * and the whole retained track is returned, as before.
 */
export function parseTrackQuery(query: Record<string, unknown>, now: number = Date.now()): TrackQuery {
  const raw = {
    from: firstString(query.from),
    to: firstString(query.to),
    duration: firstString(query.duration),
    timespan: firstString(query.timespan),
    timespanOffset: firstString(query.timespanOffset),
    resolution: firstString(query.resolution),
  }

  if (!Value.Check(QuerySchema, raw)) {
    throw new TimeWindowError('Invalid track query parameters')
  }

  const result: TrackQuery = {}

  if (raw.resolution !== undefined) {
    const resolution = parseDuration(raw.resolution)
    if (resolution > 0) {
      result.resolution = resolution
    }
  }

  // A window ending at `now` includes its final point, so the newest fix is not
  // dropped. A window ending earlier stays half-open so consecutive bands tile
  // without repeating the point they share.
  if (raw.from !== undefined || raw.to !== undefined) {
    const from = raw.from !== undefined ? parseInstant(raw.from, 'from') : Number.NEGATIVE_INFINITY
    const to = raw.to !== undefined ? parseInstant(raw.to, 'to') : now
    if (from >= to) {
      throw new TimeWindowError(`'from' must be before 'to'`)
    }
    return { ...result, window: { from, to, inclusiveEnd: raw.to === undefined } }
  }

  if (raw.duration !== undefined) {
    const duration = parseDuration(raw.duration)
    return { ...result, window: { from: now - duration, to: now, inclusiveEnd: true } }
  }

  if (raw.timespan !== undefined) {
    // Freeboard sends timespan with an optional offset back from now, so
    // `timespan=23h&timespanOffset=1` means "23 hours ending an hour ago".
    const span = parseDuration(raw.timespan)
    const offset = raw.timespanOffset !== undefined ? parseDuration(`${raw.timespanOffset}h`) : 0
    const to = now - offset
    return { ...result, window: { from: to - span, to, inclusiveEnd: offset === 0 } }
  }

  return result
}

/**
 * Drop points closer together than `resolution` milliseconds, always keeping
 * the first and last so the track keeps its extent.
 */
export function thin(points: TimedPosition[], resolution: number | undefined): TimedPosition[] {
  if (!resolution || points.length <= 2) {
    return points
  }
  const result: TimedPosition[] = []
  let lastKept = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.timestamp - lastKept >= resolution) {
      result.push(point)
      lastKept = point.timestamp
    }
  }
  const last = points[points.length - 1]
  if (last && result[result.length - 1] !== last) {
    result.push(last)
  }
  return result
}

/**
 * Split points into segments wherever recording stopped for longer than `gap`.
 *
 * A track is not one continuous line: a vessel that stops for the night, or
 * sails out of AIS range and back, leaves a hole. Joining across it draws a
 * straight line through places the vessel never went — across a headland, or
 * over an anchorage it actually sat still in.
 *
 * Operates on timestamped points rather than inside a store, so both the
 * in-memory and sqlite stores segment identically, and so it composes with
 * `thin()` — thinning first, then segmenting, keeps a thinned-away gap from
 * being invented as a join.
 *
 * `gap` of 0 or undefined returns a single segment, preserving the old shape.
 * An empty input returns no segments rather than one empty one, so a caller can
 * distinguish "no track" from "a track with no points".
 */
export function segment(points: TimedPosition[], gap: number | undefined): TimedPosition[][] {
  if (points.length === 0) {
    return []
  }
  if (!gap || gap <= 0) {
    return [points]
  }
  const segments: TimedPosition[][] = []
  let current: TimedPosition[] = []
  let previous: number | undefined
  for (const point of points) {
    if (previous !== undefined && point.timestamp - previous > gap) {
      segments.push(current)
      current = []
    }
    current.push(point)
    previous = point.timestamp
  }
  if (current.length > 0) {
    segments.push(current)
  }
  return segments
}
