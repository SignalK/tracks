import type { TimedPosition } from './types.js'

/**
 * GPX 1.1 serialisation and parsing for recorded tracks.
 *
 * Hand-written rather than through a library: the vocabulary is `gpx`, `trk`,
 * `name`, `extensions`, `trkseg`, `trkpt` and `time` — seven element types —
 * and a dependency for that would be more surface than the code it replaces.
 * What matters is getting the details right, and those are documented below.
 */

const LAT = 0
const LNG = 1

/** Identity of the vessel a track belongs to, as far as it is known. */
export interface GpxTrackIdentity {
  /** Display label, e.g. `Own Ship` or `AIS Ariadne`. Becomes `<name>`. */
  name: string
  /** Fully qualified Signal K context, when there is one. */
  context?: string
}

export interface GpxTrack extends GpxTrackIdentity {
  /** Segments as `segment()` produces them: a recording gap starts a new one. */
  segments: TimedPosition[][]
}

/**
 * Serialise tracks as a GPX 1.1 document.
 *
 * Several tracks go in one file, each as its own `<trk>`. GPX allows it, and
 * it is what makes "select three trips, export" produce one file rather than
 * three — TimeZero writes one file per vessel, which is a choice rather than a
 * constraint of the format.
 *
 * The Signal K context travels in `<extensions>`. TimeZero puts an opaque
 * GUID there and drops the MMSI entirely, so its exports cannot round-trip an
 * identity; carrying the context means ours can, while staying readable by
 * anything else, since `<extensions>` is ignorable by specification.
 */
export function toGpx(tracks: GpxTrack[], now: Date = new Date()): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="@signalk/tracks-plugin" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <time>${iso(now.getTime())}</time>`,
    '  </metadata>',
  ]
  for (const track of tracks) {
    lines.push('  <trk>')
    lines.push(`    <name>${escapeXml(track.name)}</name>`)
    if (track.context !== undefined) {
      lines.push('    <extensions>')
      lines.push(`      <signalk:context xmlns:signalk="${NAMESPACE}">${escapeXml(track.context)}</signalk:context>`)
      lines.push('    </extensions>')
    }
    // A segment with no points would produce an empty <trkseg>, which is legal
    // but describes nothing; skipped so a file never carries one.
    for (const points of track.segments.filter((s) => s.length > 0)) {
      lines.push('    <trkseg>')
      for (const { position, timestamp } of points) {
        lines.push(`      <trkpt lat="${coordinate(position[LAT])}" lon="${coordinate(position[LNG])}">`)
        // <time> is the only child, and GPX 1.1 fixes the order of trkpt's
        // children — a schema-validating reader rejects them out of sequence.
        lines.push(`        <time>${iso(timestamp)}</time>`)
        lines.push('      </trkpt>')
      }
      lines.push('    </trkseg>')
    }
    lines.push('  </trk>')
  }
  lines.push('</gpx>')
  return lines.join('\n') + '\n'
}

/** Namespace for the one extension element this plugin writes. */
const NAMESPACE = 'https://signalk.org/specification/1.7.0/'

/**
 * Parse a GPX document into tracks.
 *
 * Deliberately forgiving about structure and strict about values: a file may
 * come from any plotter, so anything unrecognised is ignored rather than
 * rejected, but a coordinate that is not a finite number is dropped — one NaN
 * reaching the store stretches every bounding box that track appears in.
 *
 * **Points are sorted by time.** TimeZero paginates its export in blocks of
 * 150 and the block seams overlap: the last point of a block can be a few
 * milliseconds newer than the first point of the next. Out of 5,550 points in
 * a real export, 16 pairs are out of order, every one on a 150-point boundary.
 * Anything downstream that assumes ordering — time-window queries, the history
 * reconciliation — would quietly misbehave on such a file.
 */
export function fromGpx(xml: string): GpxTrack[] {
  const tracks: GpxTrack[] = []
  for (const match of matchAll(xml, /<trk>([\s\S]*?)<\/trk>/g)) {
    const body = match[1] ?? ''
    const name = decodeXml(/<name>([\s\S]*?)<\/name>/.exec(body)?.[1] ?? '') || 'Track'
    // `\b[^>]*` rather than a bare `>`: the element carries its namespace
    // declaration as an attribute, so requiring the tag to end straight after
    // the name silently fails to match the very files this plugin writes.
    const context = decodeXml(/<(?:\w+:)?context\b[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/.exec(body)?.[1] ?? '')
    const segments: TimedPosition[][] = []
    for (const segmentMatch of matchAll(body, /<trkseg>([\s\S]*?)<\/trkseg>/g)) {
      const points = parsePoints(segmentMatch[1] ?? '')
      if (points.length > 0) {
        segments.push(points)
      }
    }
    if (segments.length > 0) {
      tracks.push({ name, segments, ...(context === '' ? {} : { context }) })
    }
  }
  return tracks
}

function parsePoints(segmentBody: string): TimedPosition[] {
  const points: TimedPosition[] = []
  // One pattern for the whole element, self-closing or not, so a `<trkpt/>`
  // with no time is read rather than silently skipped. The attributes are
  // pulled out separately because their order is not fixed and a single
  // alternation would put the coordinates in different groups per branch.
  for (const match of matchAll(segmentBody, /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    const latitude = Number(/\blat="([^"]*)"/.exec(attributes)?.[1])
    const longitude = Number(/\blon="([^"]*)"/.exec(attributes)?.[1])
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue
    }
    const raw = /<time>([\s\S]*?)<\/time>/.exec(body)?.[1]
    const timestamp = raw === undefined ? Number.NaN : Date.parse(raw.trim())
    points.push({
      position: [latitude, longitude],
      // A point with no usable time is dated to the start of time rather than
      // dropped: its position is still real, and a window query treats it as
      // older than anything live.
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    })
  }
  // Stable by construction: equal timestamps keep their file order, so a block
  // seam does not reshuffle points that were already correct.
  return points.sort((a, b) => a.timestamp - b.timestamp)
}

function* matchAll(text: string, pattern: RegExp): Generator<RegExpExecArray> {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    // A zero-length match would loop forever on the same index.
    if (match[0] === '') {
      regex.lastIndex += 1
      continue
    }
    yield match
  }
}

/**
 * Coordinates at seven decimal places: ~11 mm, finer than any GPS fix and
 * short enough that a long track does not carry pointless digits.
 */
function coordinate(value: number): string {
  return value.toFixed(7).replace(/\.?0+$/, '')
}

/** ISO-8601 UTC, because a track outlives the timezone it was recorded in. */
function iso(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function decodeXml(value: string): string {
  return (
    value
      .trim()
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      // Ampersand last, so an escaped entity is not decoded twice: &amp;lt;
      // means the literal "&lt;", not "<".
      .replace(/&amp;/g, '&')
  )
}
