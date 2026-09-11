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
 */
export function fromGpx(xml: string): GpxTrack[] {
  const tracks: GpxTrack[] = []
  for (const match of matchAll(xml, /<trk(?=[\s>])[^>]*>([\s\S]*?)<\/trk\s*>/g)) {
    const body = match[1] ?? ''
    // `decodeXml` trims, so surrounding whitespace in a <name> is dropped: it
    // is layout from the writer rather than part of the vessel's name. A name
    // that is empty or only whitespace falls back to `Track`, because a track
    // list with a blank row in it is worse than one with a generic label.
    const name = decodeXml(/<name(?=[\s>])[^>]*>([\s\S]*?)<\/name\s*>/.exec(body)?.[1] ?? '') || 'Track'
    const context = signalKContext(extensionsOf(body))
    const segments: TimedPosition[][] = []
    for (const segmentMatch of matchAll(body, /<trkseg(?=[\s>])[^>]*>([\s\S]*?)<\/trkseg\s*>/g)) {
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

/**
 * The `<extensions>` blocks of a track, concatenated.
 *
 * The context is only meaningful inside one: GPX puts vendor data there, and
 * an element elsewhere in the track body -- however correctly namespaced --
 * is not this plugin's identity declaration. Reading one would let any
 * `<context>` in the document assign the track to a vessel.
 */
function extensionsOf(body: string): string {
  // Trackpoints carry their own <extensions>, which GPX permits and which
  // belong to that point rather than the track. Stripping them first stops a
  // context inside one from claiming every point in the file.
  const trackLevel = body.replace(/<trkpt(?=[\s/>])[\s\S]*?(?:\/>|<\/trkpt\s*>)/g, '')
  let found = ''
  for (const match of matchAll(trackLevel, /<extensions(?=[\s/>])[^>]*>([\s\S]*?)<\/extensions\s*>/g)) {
    found += match[1] ?? ''
  }
  return found
}

/**
 * The Signal K context from a track's extensions, or '' when there is none.
 *
 * Matched on its namespace rather than its local name. GPX extensions are an
 * open field that any vendor may write into, and a foreign `<context>` -- or
 * one under somebody else's prefix -- would otherwise be read as this
 * plugin's, attributing an imported track to a vessel it does not belong to.
 * The element carries its namespace declaration as an attribute, so the tag
 * cannot be required to end straight after the name.
 */
function signalKContext(body: string): string {
  // An XML prefix is an NCName: hyphens and dots are legal in it, so `\w+`
  // would drop the identity from a file that used one.
  for (const match of matchAll(body, /<([\w.-]+:)?context(?=[\s/>])([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?context\s*>/g)) {
    const prefix = match[1]?.slice(0, -1)
    const attributes = match[2] ?? ''
    // Declared on the element itself, as this plugin writes it; an inherited
    // declaration would need a real XML parser to resolve, and a file whose
    // context is not self-describing is not one to trust with an identity.
    const declared = prefix === undefined ? attribute(attributes, 'xmlns') : attribute(attributes, `xmlns:${prefix}`)
    if (declared === NAMESPACE) {
      return decodeXml(match[3] ?? '')
    }
  }
  return ''
}

function parsePoints(segmentBody: string): TimedPosition[] {
  const points: TimedPosition[] = []
  // One pattern for the whole element, self-closing or not, so a `<trkpt/>`
  // with no time is read rather than silently skipped. The attributes are
  // pulled out separately because their order is not fixed and a single
  // alternation would put the coordinates in different groups per branch.
  // `(?=[\s/>])` rather than `\b`: a word boundary also sits before a hyphen,
  // so `<trkpt-extra lat="9" lon="9"/>` -- a legal element this parser knows
  // nothing about -- was read as a position the file never declared.
  for (const match of matchAll(segmentBody, /<trkpt(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt\s*>)/g)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    // `decimal` yields NaN for anything that is not an xsd:decimal, blanks
    // included, so `inRange` below rejects them all. Calling `Number('')`
    // directly would instead yield 0 and land the point at null island --
    // which is why the parsing lives in the helper rather than here.
    const latitude = decimal(attribute(attributes, 'lat'))
    const longitude = decimal(attribute(attributes, 'lon'))
    if (!inRange(latitude, longitude)) {
      continue
    }
    const raw = /<time(?=[\s>])[^>]*>([\s\S]*?)<\/time\s*>/.exec(body)?.[1]
    const timestamp = raw === undefined ? Number.NaN : dateTime(raw.trim())
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
 * An attribute's value, in either quote style, or undefined when it is absent
 * or blank.
 *
 * XML permits single quotes and plotters do use them; matching only double
 * quotes drops every point of such a file without a word.
 */
function attribute(attributes: string, name: string): string | undefined {
  // `(^|\\s)` rather than `\\b`: a word boundary also matches after a hyphen,
  // so `data-lat="5"` would be read as this element's latitude.
  // The name is escaped because it is not always a literal: a namespace prefix
  // may contain a dot, and an unescaped `xmlns:sig.k` would also match
  // `xmlns:sigXk` -- letting a near-miss declaration claim another namespace.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes)
  const value = (match?.[1] ?? match?.[2])?.trim()
  return value === undefined || value === '' ? undefined : value
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

function decodeXml(value: string): string {
  // One pass over the input, so nothing this produces is decoded again.
  // Replacing entities in sequence turns `&#38;amp;` into `&` -- the numeric
  // reference yields an ampersand, and a later pass reads the `amp;` after it
  // as part of a second entity. XML says that input is the literal `&amp;`.
  return value
    .trim()
    .replace(
      /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
      (whole, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
        if (hex !== undefined) {
          return codePoint(Number.parseInt(hex, 16), whole)
        }
        if (decimal !== undefined) {
          return codePoint(Number(decimal), whole)
        }
        switch (named?.toLowerCase()) {
          case 'amp':
            return '&'
          case 'lt':
            return '<'
          case 'gt':
            return '>'
          case 'quot':
            return '"'
          default:
            return "'"
        }
      },
    )
}

/**
 * A character reference's character, or the reference itself when it names no
 * character.
 *
 * `String.fromCodePoint` throws on anything outside the Unicode range, and a
 * file is not ours to trust: one `&#999999999;` in a vessel name would
 * otherwise abort the whole import with a RangeError rather than importing
 * every other track in the file.
 */
function codePoint(value: number, original: string): string {
  return isXmlChar(value) ? String.fromCodePoint(value) : original
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
