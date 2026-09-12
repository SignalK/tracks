import { DOMParser } from '@xmldom/xmldom'
import type { Document, Element } from '@xmldom/xmldom'
import type { TimedPosition } from './types.js'

/**
 * GPX 1.1 serialisation and parsing for recorded tracks.
 *
 * Hand-written rather than through a library: the vocabulary is `gpx`,
 * `metadata`, `trk`, `name`, `extensions`, `signalk:context`, `trkseg`,
 * `trkpt` and `time` — nine element types — and a dependency for that would be
 * more surface than the code it replaces.
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
    const segments = track.segments
      .map((points) => points.filter((p) => inRange(p.position[LAT], p.position[LNG])))
      .filter((points) => points.length > 0)
    // A <trk> with no <trkseg> is a name and nothing else: fromGpx ignores it,
    // so writing one loses the track and its identity on a round-trip.
    if (segments.length === 0) {
      continue
    }
    lines.push('  <trk>')
    lines.push(`    <name>${escapeXml(track.name)}</name>`)
    if (track.context !== undefined) {
      lines.push('    <extensions>')
      lines.push(`      <signalk:context xmlns:signalk="${NAMESPACE}">${escapeXml(track.context)}</signalk:context>`)
      lines.push('    </extensions>')
    }
    for (const points of segments) {
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

/** GPX's own namespace, which structural elements must be in. */
const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1'

/** Namespace for the one extension element this plugin writes. */
const NAMESPACE = 'https://signalk.org/specification/1.7.0/'

/**
 * Parse a GPX document into tracks.
 *
 * Structure follows GPX's own hierarchy: the root is `<gpx>`, tracks are its
 * children, segments are a track's, points are a segment's. Anything else —
 * a `<trkseg>` inside an `<extensions>` payload, a `<trk>` below the root — is
 * not track data, and a namespace check alone cannot tell the difference,
 * since a payload declaring no namespace inherits GPX's own.
 *
 * Deliberately forgiving about structure and strict about values: elements it
 * does not recognise are ignored rather than rejected, but a coordinate that is
 * not an `xsd:decimal` in range, or a time that is not an `xsd:dateTime`, is
 * refused. One NaN reaching the store stretches every bounding box that track
 * appears in.
 *
 * **Points are sorted by time within each segment.** TimeZero paginates its
 * export in blocks of 150 and the block seams overlap: the last point of a
 * block can be a few milliseconds newer than the first point of the next. Out
 * of 5,550 points in a real export, 16 pairs are out of order, every one on a
 * 150-point boundary. Anything downstream that assumes ordering — time-window
 * queries, the history reconciliation — would quietly misbehave on such a file.
 *
 * Sorting stops at the segment boundary, deliberately: a segment is a stretch
 * of continuous recording, and reordering points across a gap would merge two
 * passages into one line. So `segments.flat()` is not globally sorted for a
 * file whose segments interleave in time, and a caller that needs that must
 * sort for itself.
 *
 * A document the parser rejects yields no tracks rather than throwing: this
 * reads files the plugin did not write, and an import that fails should say so
 * by returning nothing rather than by taking the caller down.
 */
export function fromGpx(xml: string): GpxTrack[] {
  let document: Document
  try {
    // onError swallows the warnings xmldom would otherwise print; a fatal
    // error still throws, which the catch below turns into an empty result.
    document = new DOMParser({
      onError: (level) => {
        // A "warning" is xmldom telling us about something it handled; an
        // "error" is a syntax fault it recovered from by guessing. The
        // contract is that a document which is not well-formed yields no
        // tracks, so a guess is refused rather than imported.
        if (level !== 'warning') {
          throw new Error('malformed XML')
        }
      },
    }).parseFromString(xml, 'text/xml')
  } catch {
    return []
  }

  // The root must be GPX's own: a <trk> nested in an <extensions> payload
  // inherits the namespace and would otherwise import as a real track, and a
  // document rooted at something else entirely is not GPX at all.
  const root = document.documentElement
  if (root === null || root.localName !== 'gpx' || !isGpxNamespace(root)) {
    return []
  }

  const tracks: GpxTrack[] = []
  for (const trk of gpxChildren(root, 'trk')) {
    const segments: TimedPosition[][] = []
    for (const trkseg of gpxChildren(trk, 'trkseg')) {
      const points = readPoints(trkseg)
      if (points.length > 0) {
        segments.push(points)
      }
    }
    if (segments.length === 0) {
      continue
    }
    // Trimmed because surrounding whitespace is the writer's layout rather
    // than part of the name, and defaulted because a track list with a blank
    // row in it is worse than one with a generic label.
    const name = childText(trk, 'name').trim() || 'Track'
    const context = signalKContext(trk)
    tracks.push({ name, segments, ...(context === undefined ? {} : { context }) })
  }
  return tracks
}

/**
 * The text of a direct GPX child with this local name.
 *
 * Direct rather than `getElementsByTagName`, which would reach a `<name>`
 * inside an `<extensions>` payload and label the track with a vendor's string.
 */
function childText(trk: Element, local: string): string {
  for (const child of Array.from(trk.childNodes)) {
    if (isElement(child) && child.localName === local && isGpxNamespace(child)) {
      return child.textContent ?? ''
    }
  }
  return ''
}

/**
 * The Signal K context declared in a track's own `<extensions>`.
 *
 * Matched on namespace URI, which is what the prefix actually means: GPX
 * extensions are an open field any vendor may write into, so a foreign
 * `<context>` — or one under a different prefix bound elsewhere — must not
 * claim the track's identity. Read only from the track's direct
 * `<extensions>` children, because a trackpoint carries its own and those
 * belong to that point.
 */
function signalKContext(trk: Element): string | undefined {
  for (const child of Array.from(trk.childNodes)) {
    if (!isElement(child) || child.localName !== 'extensions' || !isGpxNamespace(child)) {
      continue
    }
    for (const candidate of Array.from(child.getElementsByTagNameNS(NAMESPACE, 'context'))) {
      const value = (candidate.textContent ?? '').trim()
      if (value !== '') {
        return value
      }
    }
  }
  return undefined
}

/** The points of one `<trkseg>`, oldest first. */
function readPoints(trkseg: Element): TimedPosition[] {
  const points: TimedPosition[] = []
  for (const trkpt of gpxChildren(trkseg, 'trkpt')) {
    const latitude = decimal(trkpt.getAttribute('lat') ?? undefined)
    const longitude = decimal(trkpt.getAttribute('lon') ?? undefined)
    if (!inRange(latitude, longitude)) {
      continue
    }
    const raw = childText(trkpt, 'time').trim()
    const timestamp = raw === '' ? Number.NaN : dateTime(raw)
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

/**
 * Direct GPX children of `root` with this local name.
 *
 * Direct, because GPX fixes the hierarchy: a `<trkseg>` is a child of `<trk>`
 * and a `<trkpt>` a child of `<trkseg>`. Scanning descendants instead lets an
 * `<extensions>` payload contribute track data — and a payload that declares
 * no namespace of its own inherits GPX's, so a namespace check cannot catch
 * it. A vendor's `<trkseg>` inside `<extensions>` became a phantom segment.
 */
function gpxChildren(root: Element, local: string): Element[] {
  return Array.from(root.childNodes).filter(
    (node): node is Element => isElement(node) && node.localName === local && isGpxNamespace(node),
  )
}

/**
 * Whether an element is GPX's own.
 *
 * A null namespace counts: a great many files in the wild omit the xmlns
 * declaration entirely, and refusing those would reject most of what users
 * actually have.
 */
function isGpxNamespace(element: Element): boolean {
  return element.namespaceURI === null || element.namespaceURI === GPX_NAMESPACE
}

/** Narrow a DOM node to an element without relying on a global Node. */
function isElement(node: { nodeType: number }): node is Element {
  return node.nodeType === 1
}

/**
 * Coordinates at seven decimal places: ~11 mm, finer than any GPS fix and
 * short enough that a long track does not carry pointless digits.
 */
function coordinate(value: number): string {
  const fixed = value.toFixed(7).replace(/\.?0+$/, '')
  // A tiny negative rounds to "-0.0000000" and strips to "-0", which is a
  // number no position ever is. Zero is zero.
  return fixed === '-0' ? '0' : fixed
}

/**
 * A GPX `<time>` as epoch milliseconds, or NaN when it is not one.
 *
 * GPX types the element as `xsd:dateTime`, and `Date.parse` is far looser: it
 * reads a bare `2024` and `Jan 1 2024` as instants, and silently rolls
 * `2024-02-30` forward to March. A date that never existed should reach the
 * caller's fallback rather than arrive as a real -- and wrong -- position in
 * time.
 */
function dateTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) {
    return Number.NaN
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return Number.NaN
  }
  // Date.parse normalises an impossible day rather than rejecting it, so the
  // calendar fields are compared against what they round-tripped to.
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
    ? parsed
    : Number.NaN
}

/**
 * ISO-8601 UTC, because a track outlives the timezone it was recorded in.
 *
 * A timestamp outside the Date range throws out of `toISOString`, and one bad
 * point would abort the export of every track in the file. It is dated to the
 * start of time instead, which is what `fromGpx` does with a time it cannot
 * read -- losing one point's time beats losing the document.
 */
function iso(timestamp: number): string {
  const at = new Date(timestamp)
  return Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString()
}

/**
 * XML-escape a value for element content.
 *
 * Characters XML cannot express are dropped rather than escaped, because they
 * have no entity form: emitting one produces a document no conformant reader
 * will load, and losing the character beats losing the file.
 */
function escapeXml(value: string): string {
  return (
    [...value]
      // Dropped rather than escaped: a NUL or a lone surrogate has no entity
      // form, so emitting one produces a document no conformant reader will
      // load -- losing the character beats losing the file.
      .filter((character) => isXmlChar(character.codePointAt(0) ?? -1))
      .join('')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  )
}

/**
 * Whether a code point is one XML 1.0 permits in content.
 *
 * The range has holes: NUL, most C0 controls and the surrogate block are all
 * excluded. Decoding `&#0;` or `&#xD800;` puts a character into a track name
 * that cannot be written back out as well-formed XML, so the reference is
 * kept verbatim instead -- the same treatment as one that names no character
 * at all.
 */
function isXmlChar(value: number): boolean {
  if (!Number.isInteger(value)) {
    return false
  }
  return (
    value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  )
}

/**
 * An attribute value as an XSD decimal, or NaN when it is not one.
 *
 * GPX types lat and lon as `xsd:decimal`, which is digits with an optional
 * sign and point -- no exponent, no hexadecimal. `Number()` is far more
 * generous: it reads `0x10` as 16 and `1e1` as 10, so a file using either
 * imported a position it never expressed.
 */
function decimal(value: string | undefined): number {
  return value !== undefined && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : Number.NaN
}

/**
 * Whether a position is one GPX can express.
 *
 * Latitude beyond ±90 or longitude beyond ±180 is not a place. Such a value
 * reaching the store stretches every bounding box the track appears in, and
 * writing one produces a document a validating reader rejects — so it is
 * refused in both directions rather than trusted from a file or passed on.
 */
function inRange(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  )
}
