/**
 * A GPX file too large for one request: a look at its tracks before any of it
 * is sent, and the upload itself, slice by slice (see src/gpxUpload.ts for
 * the server side). Neither holds more of the file than one slice: a
 * chartplotter's export of several years runs past a gigabyte.
 */
import type { GpxUploadStatus, OnOverlap } from '../../src/types.js'

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
export const UPLOAD_URL = '../../plugins/tracks/imports/upload'

/** A track of the file, as the scan lists it to choose from (see `scanGpx`). */
export interface ScannedTrack {
  name: string
  points: number
  /** The times of its first and last point, as written; absent where it has none. */
  from?: string
  to?: string
  /** The name of the own vessel's track it was elsewhere than at the same time (see `markElsewhere`). */
  elsewhere?: string
  partly?: boolean
  foreign?: boolean
}

/** What `uploadGpx` sends, and where it reports to. */
export interface UploadOptions {
  /** The file, as much of a File as the upload reads. */
  file: Blob & { name: string; lastModified?: number }
  tracks: string[]
  onOverlap: OnOverlap
  onStatus: (status: GpxUploadStatus) => void
  signal?: AbortSignal | undefined
  request?: (url: string, init: RequestInit) => Promise<Response>
  sleep?: ((ms: number) => Promise<void>) | undefined
}

/** A point sampled from a track: `[time, lat, lon]`. */
type Sample = [time: number, lat: number, lon: number]

/** A `<trk>`'s samples, by stretch of SAMPLE_MS. */
interface Sampled {
  stretches: Map<number, Sample>
}

interface SampledTrack {
  group: ScannedTrack
  sampled: Sampled
}

/** A `<trk>` named like the own vessel's. */
interface OwnTrack {
  name: string
  stretches: Map<number, Sample>
}

/** Stretches two tracks lay far apart and near together in. */
interface Count {
  far: number
  near: number
}

/** The `<trkseg>` open: the scopes its points are read under, and whether they are read at all. */
interface Segment {
  scopes: Scope[]
  inGpx: boolean
  plain: boolean
}

/** The `<trk>` being read: its scope, its name once read, and the track it adds to from its first segment. */
interface OpenTrack {
  scope: Scope
  name?: string
  group?: ScannedTrack
}

/** What the `<gpx>` start tag says (see rootOf). */
interface Root {
  creator: string | null
  scope: Map<string, string> | null
}

/** Markup TAG does not read whole (see markupFrom). */
interface Markup {
  at: number
  end: number
  doctype: boolean
}

/** What the upload routes answer. */
interface UploadAnswer {
  upload?: GpxUploadStatus | null
  message?: string
}

type Call = (url: string, init?: RequestInit) => Promise<Response>

/** Bytes per request: well under the server's 8 MiB limit. */
export const SLICE_BYTES = 4 * 1024 * 1024

/** Bytes the scan reads at a time. */
const SCAN_BYTES = 8 * 1024 * 1024

// A boat's Wi-Fi drops for a moment now and then, a plugin restart takes the
// routes away for a few seconds, and a slice whose answer was lost can still
// be writing on a slow SD card. A slice that did not get through is sent
// again from wherever the server says it got to, waiting twice as long each
// time: about four minutes in all.
const RETRIES = 8
const RETRY_DELAY_MS = 2000
const RETRY_DELAY_MAX_MS = 60_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * XML's predefined and numeric character references, decoded: the server
 * chooses a track by its name as the parser reads it, so the name chosen
 * here must be spelled the same.
 */
function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (named !== undefined) return ENTITIES[named] ?? match
      const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    },
  )
}

/** Named as TimeZero names the AIS targets it followed: `AIS <name>`, or the bare MMSI. */
export function isOtherVessel(name: string): boolean {
  return /^AIS\b/.test(name) || /^\d{9}$/.test(name)
}

/** Named as TimeZero names the own vessel's track, in English as this plugin's export does too, and in German. */
export function isOwnVessel(name: string): boolean {
  return name === 'Own Ship' || name === 'Eigenes Schiff'
}

const MARKUP = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)/

// The line ends XML reads as line feeds: XML 1.1 adds U+0085 and U+2028 to 1.0's.
const LINE_END = /\r\n?/g
const LINE_END_11 = /\r[\n\u0085]?|[\u0085\u2028]/g

// An XML declaration as the server's parser takes one: a version 1.x, then
// an encoding and standalone, in that order, parted by XML 1.0's white space,
// since the version is not known before it is read.
const DECLARATION_SPACE = String.raw`[\t\n\r ]`
const WELL_FORMED_DECLARATION = new RegExp(
  String.raw`^<\?xml${DECLARATION_SPACE}+version${DECLARATION_SPACE}*=${DECLARATION_SPACE}*(["'])1\.[0-9]+\1` +
    String.raw`(?:${DECLARATION_SPACE}+encoding${DECLARATION_SPACE}*=${DECLARATION_SPACE}*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?` +
    String.raw`(?:${DECLARATION_SPACE}+standalone${DECLARATION_SPACE}*=${DECLARATION_SPACE}*(["'])(?:yes|no)\3)?${DECLARATION_SPACE}*\?>$`,
)
// Text other than white space, which the server refuses outside the root:
// XML 1.1 reads U+0085 and U+2028 as line ends there too.
const OUTSIDE_TEXT = /[^\t\n\r ]/
const OUTSIDE_TEXT_11 = /[^\t\n\r \u0085\u2028]/

// A processing instruction of the reserved target, in any case: the server takes one for a declaration.
const XML_TARGET = /^<\?xml(?=[\t\n\r ?])/i

/** Whether the document starting `text` declares itself XML 1.1, whose line ends the parser reads differently. */
function isXml11(text: string): boolean {
  return /^<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(["'])1\.1\1/.test(text)
}

/**
 * An element's text from its raw content, as the parser reads it:
 * line ends as line feeds, references decoded, a CDATA section's content as
 * it is and a comment or processing instruction left out.
 */
function textOf(raw: string, xml11: boolean): string {
  return raw
    .replace(xml11 ? LINE_END_11 : LINE_END, '\n')
    .split(MARKUP)
    .map((part) =>
      part.startsWith('<![CDATA[')
        ? part.slice(9, -3)
        : part.startsWith('<!--') || part.startsWith('<?')
          ? ''
          : decodeEntities(part),
    )
    .join('')
    .trim()
}

// XML's white space, with the line ends XML 1.1 adds, and a character of a
// name as XML allows it, beyond ASCII too, and of a name's part either side
// of a prefix's `:`. JavaScript's `\s` takes U+FEFF for white space, which
// XML takes for a name's.
const SPACE = String.raw`[\t\n\r \u0085\u2028]`
const NAME_CHAR = String.raw`[^\t\n\r \u0085\u2028"'<>/=]`
const PART_CHAR = String.raw`[^\t\n\r \u0085\u2028"'<>/=:!?]`

// A CDATA section, a comment or a processing instruction is matched whole,
// so that markup inside one is not taken for a tag.
// A tag ends at its own `>`, not at one in a quoted value, as the server's parser reads it.
// Its name is read whole: a run of name characters with no `>` after it is
// then given up at once, not tried again at every length. Its prefix is
// kept, for the namespace it is in.
const TAG = new RegExp(
  String.raw`<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)(?:(${PART_CHAR}+):)?(${PART_CHAR}+)(?!${PART_CHAR})(?:[^<>"']|"[^"<]*"|'[^'<]*')*?(\/?)>`,
  'g',
)

// A start tag's attributes, read with their quotes. The two must agree on
// names, or ATTRIBUTE would read one out of a value.
const START_TAG = new RegExp(
  String.raw`<${NAME_CHAR}+((?:${SPACE}+${NAME_CHAR}+${SPACE}*=${SPACE}*(?:"[^"]*"|'[^']*'))*)${SPACE}*\/?>`,
  'y',
)
const ATTRIBUTE = new RegExp(String.raw`(${NAME_CHAR}+)${SPACE}*=${SPACE}*(?:"([^"]*)"|'([^']*)')`, 'g')

/**
 * The longest start tag carried into the next chunk when it runs past this
 * one: as long as the server takes (MAX_PENDING_CHARS in src/gpxUpload.ts).
 */
const MAX_CARRIED_TAG = 1024 * 1024

/** The most elements open at once the scan follows: GPX nests a handful, so more is no GPX file. */
const MAX_OPEN_ELEMENTS = 4096

/**
 * TAG's next match in `text`, past any tag too long for it to read: one of
 * millions of attributes runs the expression out of stack. No GPX tag is
 * that long, and the server refuses one.
 */
function nextTag(text: string): RegExpExecArray | null {
  for (;;) {
    const from = TAG.lastIndex
    try {
      return TAG.exec(text)
    } catch {
      const next = text.indexOf('<', from + 1)
      if (next < 0) {
        TAG.lastIndex = 0
        return null
      }
      TAG.lastIndex = next
    }
  }
}

/** The attributes of the start tag at `at` in `text`, or undefined where it cannot be read whole. */
function attributesOf(text: string, at: number): Map<string, string> | undefined {
  START_TAG.lastIndex = at
  let tag: RegExpExecArray | null
  try {
    tag = START_TAG.exec(text)
  } catch {
    // A tag of a million attributes runs the expression out of stack.
    return undefined
  }
  if (!tag) return undefined
  const attributes = new Map<string, string>()
  for (const [, name, double, single] of (tag[1] ?? '').matchAll(ATTRIBUTE)) {
    if (name !== undefined) attributes.set(name, double ?? single ?? '')
  }
  return attributes
}

/** GPX's namespace, as `src/gpx.ts` has it: the server reads a point in it, or in none. */
const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1'

/**
 * The namespaces an element binds, by prefix, `''` for the default: undefined
 * where it binds none, and null where its tag cannot be read whole.
 */
type Scope = Map<string, string> | null | undefined

/** The namespaces these attributes bind, by prefix, `''` for the default. */
function bindings(attributes: Map<string, string>): Map<string, string> {
  const bound = new Map<string, string>()
  for (const [name, value] of attributes) {
    if (name === 'xmlns') bound.set('', decodeEntities(value))
    else if (name.startsWith('xmlns:')) bound.set(name.slice(6), decodeEntities(value))
  }
  return bound
}

/**
 * The namespaces the start tag `tag`, at `at` in `text`, binds: undefined
 * where it binds none, and null where it cannot be read whole.
 */
function scopeOf(text: string, at: number, tag: string): Scope {
  if (!tag.includes('xmlns')) return undefined
  const attributes = attributesOf(text, at)
  return attributes === undefined ? null : bindings(attributes)
}

/**
 * Whether an element of `prefix`, undefined for none, is in GPX's namespace
 * or in none, as the server reads one, its prefix looked up in `scopes`,
 * innermost first: those of its own tag and of the `<trkpt>`, `<trkseg>`,
 * `<trk>` and `<gpx>` it is in, the only ones the server reads it under. One
 * that could not be read whole counts against it, unless `unread` says
 * otherwise: an element the scan counts is not given up for it, only a point
 * it samples.
 */
function inGpx(prefix: string | undefined, scopes: readonly Scope[], unread = false): boolean {
  for (const scope of scopes) {
    if (scope === null) return unread
    const namespace = scope?.get(prefix ?? '')
    if (namespace !== undefined) return namespace === '' || namespace === GPX_NAMESPACE
  }
  return prefix === undefined
}

/**
 * What the `<gpx>` start tag at `at` in `text` says: who wrote the file, its
 * `creator`, null where it names none and `''` where the tag cannot be read
 * whole, which may hide one; and the namespaces it binds (see scopeOf).
 */
function rootOf(text: string, at: number): Root {
  const attributes = attributesOf(text, at)
  if (attributes === undefined) return { creator: '', scope: null }
  const creator = attributes.get('creator')
  return { creator: creator === undefined ? null : decodeEntities(creator), scope: bindings(attributes) }
}

/**
 * Whether a file whose `<gpx>` says it was written by `creator` names the
 * own vessel's track as TimeZero does: TimeZero's exports, which name no
 * creator (or name TimeZero), and this plugin's own (`gpx.ts`). In any other
 * program's file a track of that name was taken in from one of them.
 */
export function namesOwnTrack(creator: string | undefined): boolean {
  return creator === undefined || creator === '@signalk/tracks-plugin' || /^timezero\b/i.test(creator)
}

// A coordinate and a time as the server reads them (`decimal` and `dateTime`
// in src/gpx.ts), so that only points the import would write are sampled.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function coordinate(raw: string | undefined): number {
  const value = raw === undefined ? undefined : decodeEntities(raw)
  return value !== undefined && DECIMAL.test(value) ? Number(value) : Number.NaN
}

function inRange(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

function timeOf(value: string): number {
  const match = DATE_TIME.exec(value)
  if (!match) return Number.NaN
  const at = Date.parse(value)
  // Date.parse rolls an impossible day into the next month rather than refusing it.
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day ? at : Number.NaN
}

/** A track is sampled at its first point in each stretch of this long. */
const SAMPLE_MS = 10 * 60_000

/**
 * Two points of one vessel lie no further apart than this speed takes it in
 * the time between them (about 58 knots), and a fix gone astray by this much.
 */
const SAME_VESSEL_SPEED = 30
const SAME_VESSEL_SLACK_M = 1000

/**
 * The fewest stretches two tracks must lie apart in for one to be taken for
 * another vessel's, or together in to be taken for the same: where two
 * tracks of one vessel meet, at a rename say, they share a stretch or two,
 * and a track's first fix is the likeliest to be stale.
 */
const APART_STRETCHES = 3

const STRETCHES_PER_HOUR = 3_600_000 / SAMPLE_MS

/**
 * How many times the hours that the other tracks not named like an AIS
 * target cover together the undisputed `<trk>` of the own name must cover,
 * for a track apart from them to be left unticked rather than only noted.
 */
const OWN_DOMINANCE = 2

const EARTH_RADIUS_M = 6_371_008.8
const RAD = Math.PI / 180

function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const h =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Whether two samples, `[time, lat, lon]`, lie further apart than one vessel sails between them. */
function far(one: Sample, other: Sample): boolean {
  const reach = SAME_VESSEL_SLACK_M + (SAME_VESSEL_SPEED * Math.abs(one[0] - other[0])) / 1000
  return metresBetween(one[1], one[2], other[1], other[2]) > reach
}

/** Apart in at least APART_STRETCHES and most of the stretches two tracks share, or together in as many. */
const apartIn = ({ far, near }: Count) => far >= APART_STRETCHES && far > near
const togetherIn = ({ far, near }: Count) => near >= APART_STRETCHES && near > far

/** Where no `<trkseg>` of GPX's is open: no point is read there. */
const NO_SEGMENT: Segment = { scopes: [], inGpx: false, plain: false }

/** The most `<trk>` of the own name one stretch can hold before they are all doubted. */
const MAX_OWN_TOGETHER = 16

/** Counts of far and near stretches, kept per pair of keys. */
function tally<K>(counts: Map<K, Count>, key: K, isFar: boolean): void {
  const count = counts.get(key) ?? { far: 0, near: 0 }
  if (isFar) count.far++
  else count.near++
  counts.set(key, count)
}

/**
 * How a track, sampled as a map from stretch to `[time, lat, lon]`, lay
 * beside each `<trk>` named like the own vessel's, `own` holding them by
 * stretch: whether it was together with any, and those it was apart from.
 */
function compare(
  stretches: Map<number, Sample>,
  own: Map<number, OwnTrack[]>,
): { together: boolean; apartFrom: OwnTrack[] } {
  const counts = new Map<OwnTrack, Count>()
  for (const [stretch, sample] of stretches) {
    for (const ownTrack of own.get(stretch) ?? []) {
      const theirs = ownTrack.stretches.get(stretch)
      if (theirs !== undefined) tally(counts, ownTrack, far(sample, theirs))
    }
  }
  const counted = [...counts]
  return {
    together: counted.some(([, count]) => togetherIn(count)),
    apartFrom: counted.filter(([, count]) => apartIn(count)).map(([ownTrack]) => ownTrack),
  }
}

/**
 * The `<trk>` named like the own vessel's that were apart from another so
 * named while both have points, and those in a stretch with more than
 * MAX_OWN_TOGETHER of them: one of each pair is not the own vessel's, and
 * which is not plain, so none of them leaves a track unticked or counts
 * towards the own hours.
 */
function disputed(own: Map<number, OwnTrack[]>): Set<OwnTrack> {
  const pairs = new Map<OwnTrack, Map<OwnTrack, Count>>()
  const found = new Set<OwnTrack>()
  for (const [stretch, tracks] of own) {
    // So many in ten minutes is no plotter's own track, and each pair would be compared.
    if (tracks.length > MAX_OWN_TOGETHER) {
      for (const track of tracks) found.add(track)
      continue
    }
    tracks.forEach((one, i) => {
      const mine = one.stretches.get(stretch)
      for (const other of tracks.slice(i + 1)) {
        const counts = pairs.get(one) ?? new Map<OwnTrack, Count>()
        pairs.set(one, counts)
        const theirs = other.stretches.get(stretch)
        if (mine !== undefined && theirs !== undefined) tally(counts, other, far(mine, theirs))
      }
    })
  }
  for (const [one, counts] of pairs) {
    for (const [other, count] of counts) {
      if (apartIn(count)) found.add(one).add(other)
    }
  }
  return found
}

/**
 * The tracks that were elsewhere than one named like the own vessel's at
 * the same time: `elsewhere` names that one, `partly` says that only some
 * of the track's `<trk>` were, and `foreign` that it is plainly another
 * vessel's, such as a passage another boat shared, which a chartplotter's
 * export carries beside the own track under a name of its own.
 *
 * Only a track named as TimeZero names the own vessel's is taken for it.
 * Where and when two tracks were does not tell which of them is the own
 * one: a passage of days beside a plotter's tracks of a few hours each
 * covers more time, and so can a friend's track of a year beside a plotter
 * only just installed. In a file without such a name, nothing is marked.
 *
 * The name is no proof either: a friend's TimeZero export calls theirs
 * `Own Ship` too, and one name can hold the own vessel's `<trk>` and
 * another's. So every `<trk>` is compared on its own; a track with a `<trk>`
 * together with any named like the own vessel's is not marked at all; and
 * a track is `foreign` only where:
 * - the file comes from TimeZero or this plugin (`ownNames`), since in a
 *   file of any other program that name can only be a track taken in;
 * - every one of its `<trk>` was apart from one of the own name that is not
 *   `disputed`;
 * - those cover OWN_DOMINANCE times the hours of the other tracks together,
 *   as a plotter's track of years does beside a few passages.
 * Otherwise the note says what was seen, and the choice is left as it was.
 * One case these cannot tell: another boat's `<trk>` under the own name at
 * a time the own vessel's is in the file only under another name, which is
 * then left unticked; the note on it says what to look at.
 */
function markElsewhere(sampledTracks: readonly SampledTrack[], ownNames: boolean): void {
  const own = new Map<number, OwnTrack[]>()
  const others = new Map<ScannedTrack, Sampled[]>()
  for (const { group, sampled } of sampledTracks) {
    if (isOwnVessel(group.name)) {
      const ownTrack = { name: group.name, stretches: sampled.stretches }
      for (const stretch of sampled.stretches.keys()) {
        const tracks = own.get(stretch)
        if (tracks) tracks.push(ownTrack)
        else own.set(stretch, [ownTrack])
      }
    } else {
      const tracks = others.get(group)
      if (tracks) tracks.push(sampled)
      else others.set(group, [sampled])
    }
  }
  if (own.size === 0) return
  const doubted = disputed(own)
  const hours = new Set<number>()
  for (const [stretch, tracks] of own) {
    if (tracks.some((ownTrack) => !doubted.has(ownTrack))) hours.add(Math.floor(stretch / STRETCHES_PER_HOUR))
  }
  const otherHours = new Set<number>()
  for (const tracks of others.values()) {
    for (const { stretches } of tracks) {
      for (const stretch of stretches.keys()) otherHours.add(Math.floor(stretch / STRETCHES_PER_HOUR))
    }
  }
  const plain = ownNames && hours.size >= OWN_DOMINANCE * otherHours.size
  for (const [group, tracks] of others) {
    const seen = tracks.map(({ stretches }) => compare(stretches, own))
    if (seen.some(({ together }) => together)) continue
    const first = seen.find(({ apartFrom }) => apartFrom.length > 0)?.apartFrom[0]
    if (first === undefined) continue
    group.elsewhere = first.name
    if (seen.some(({ apartFrom }) => apartFrom.length === 0)) group.partly = true
    else if (plain && seen.every(({ apartFrom }) => apartFrom.some((ownTrack) => !doubted.has(ownTrack)))) {
      group.foreign = true
    }
  }
}

/** Where the DOCTYPE at `at` in `text` ends, or -1 where `text` does not close it. */
function doctypeEnd(text: string, at: number): number {
  let subset = false
  for (let i = at + 9; i < text.length; i++) {
    let open: string | undefined
    let close: string | undefined
    if (subset && text.startsWith('<!--', i)) [open, close] = ['<!--', '-->']
    else if (subset && text.startsWith('<?', i)) [open, close] = ['<?', '?>']
    else if (text[i] === '"' || text[i] === "'") open = close = text[i]
    if (open !== undefined && close !== undefined) {
      const found = text.indexOf(close, i + open.length)
      if (found < 0) return -1
      i = found + close.length - 1
    } else if (subset) {
      subset = text[i] !== ']'
    } else if (text[i] === '[') {
      subset = true
    } else if (text[i] === '>') {
      return i + 1
    }
  }
  return -1
}

const MARKUP_START = /<[!?]/g
const OPENERS: readonly (readonly [start: string, close: string])[] = [
  ['<![CDATA[', ']]>'],
  ['<!--', '-->'],
  ['<?', '?>'],
]

/**
 * The first CDATA section, comment, processing instruction or DOCTYPE at or
 * after `from` in `text`: where it starts, where it ends (-1 where `text`
 * does not close it), and whether it is the DOCTYPE, which TAG does not
 * match whole. Each is searched for its end once, so that markup inside an
 * unclosed one is not searched again and again.
 */
function markupFrom(text: string, from: number): Markup | undefined {
  MARKUP_START.lastIndex = from
  for (let found = MARKUP_START.exec(text); found; found = MARKUP_START.exec(text)) {
    const at = found.index
    const opener = OPENERS.find(([start]) => text.startsWith(start, at))
    if (opener === undefined) {
      if (text.startsWith('<!DOCTYPE', at)) return { at, end: doctypeEnd(text, at), doctype: true }
      continue
    }
    const [start, close] = opener
    const closed = text.indexOf(close, at + start.length)
    return { at, end: closed < 0 ? -1 : closed + close.length, doctype: false }
  }
  return undefined
}

/**
 * The tracks of a GPX file by name, `''` for one without, each with how many
 * points it has and the times of its first and last point as written, and
 * `elsewhere`, `partly` and `foreign` for one that was in another place than
 * the own vessel's at the same time (see `markElsewhere`).
 *
 * It picks out tags rather than parsing, which reads a gigabyte in seconds
 * where a parser would take minutes; the server parses the upload properly
 * and imports only the names chosen here, so a file odd enough to fool this
 * scan costs a track in the list, never a wrong position. It reads the
 * elements the server does: a `<trk>` under the root `<gpx>`, a `<trkseg>`
 * under it and a `<trkpt>` under that, each in GPX's namespace or none. A
 * track's name is the `<name>` it has before its first segment, its text
 * without that of elements inside it, as the server reads it.
 */
export async function scanGpx(
  file: Blob,
  onProgress: (share: number) => void = () => {},
  chunkBytes = SCAN_BYTES,
): Promise<ScannedTrack[]> {
  const tracks = new Map<string, ScannedTrack>()
  // Each <trk>'s first point in each stretch of SAMPLE_MS it has points in.
  const samples = new Map<OpenTrack, Sampled>()
  const sampledTracks: SampledTrack[] = []
  // What the first <gpx> says (see rootOf), undefined before it.
  let root: Root | undefined
  // Tracks named like an AIS target, which are never compared.
  const targets = new Set<ScannedTrack>()
  const decoder = new TextDecoder()
  let xml11 = false
  let begun = false
  // Whether the file starts with anything but markup, which puts any declaration out of place.
  let late = false
  let lateKnown = false
  let carry = ''
  let track: OpenTrack | undefined
  // Elements open in the document: GPX's are told by where they are, from the root down.
  let level = 0
  // The qualified names of the elements open, for an end tag that does not
  // match its start tag: the server refuses such a file, so none of it is listed.
  const opened: string[] = []
  let malformed = false
  // Ended early at a tag or markup longer than the server takes: what came before is listed.
  let stopped = false
  // Whether the root has started: XML has one, and the server refuses a second.
  let rooted = false
  let doctyped = false
  // The element whose text is read, 'name' or 'time', and how many elements are open outside it.
  let capture: 'name' | 'time' | undefined
  let captureLevel = 0
  let text = ''
  // Where the start tag of the point being read is, and that it is one the
  // server reads, for its position once its time is known: plain values, as
  // a gigabyte holds millions of points.
  let pointText = ''
  let pointAt = 0
  let inPoint = false
  // What that point's tag binds, undefined where it binds nothing.
  let pointScope: Scope
  // The prefix of that point's <time> and what it binds, and the <trkseg> it is in.
  let timePrefix: string | undefined
  let timeScope: Scope
  let segment = NO_SEGMENT
  const sampledOf = (key: OpenTrack, group: ScannedTrack) => {
    let sampled = samples.get(key)
    if (sampled === undefined) {
      sampled = { stretches: new Map() }
      samples.set(key, sampled)
      sampledTracks.push({ group, sampled })
    }
    return sampled
  }
  // A time in UTC shares its first 15 characters with every other in its
  // ten minutes, so most points need no parse.
  let lastPrefix: string | undefined
  let lastStretch = Number.NaN
  const stretchOf = (time: string) => {
    const utc = time.length >= 20 && time.endsWith('Z')
    if (utc && lastPrefix !== undefined && time.startsWith(lastPrefix)) return lastStretch
    const stretch = Math.floor(timeOf(time) / SAMPLE_MS)
    if (utc && !Number.isNaN(stretch)) {
      lastPrefix = time.slice(0, 15)
      lastStretch = stretch
    }
    return stretch
  }
  // The <trk> and stretch last found sampled: most points follow one in the same ten minutes.
  let doneKey: OpenTrack | undefined
  let doneStretch: number | undefined
  const sample = (key: OpenTrack, group: ScannedTrack, time: string) => {
    const stretch = stretchOf(time)
    if (stretch === doneStretch && key === doneKey) return
    if (Number.isNaN(stretch)) return
    if (samples.get(key)?.stretches.has(stretch)) {
      doneKey = key
      doneStretch = stretch
      return
    }
    const at = timeOf(time)
    if (!inPoint) return
    // Not read where its tag is not one XML allows, with a value unquoted say,
    // or is too long to read: the next point in the ten minutes stands in for it.
    const attributes = attributesOf(pointText, pointAt)
    if (attributes === undefined) return
    if (!inGpx(timePrefix, [timeScope, bindings(attributes), ...segment.scopes])) return
    const lat = coordinate(attributes.get('lat'))
    const lon = coordinate(attributes.get('lon'))
    if (Number.isNaN(at) || !inRange(lat, lon)) return
    sampledOf(key, group).stretches.set(stretch, [at, lat, lon])
    doneKey = key
    doneStretch = stretch
  }
  // An element in the current <trk> ends, `level` elements open outside it.
  const close = (open: OpenTrack, name: string) => {
    if (capture !== undefined && level === captureLevel) {
      if (capture === 'name') {
        open.name ??= textOf(text, xml11)
      } else if (open.group !== undefined) {
        // A <time> is captured only in a point, inside a segment that has its track's group.
        const time = textOf(text, xml11)
        open.group.from ??= time
        open.group.to = time
        if (!targets.has(open.group)) sample(open, open.group, time)
      }
      capture = undefined
    } else if (name === 'trkseg' && level === 2) {
      segment = NO_SEGMENT
      inPoint = false
    } else if (name === 'trkpt' && level === 3) {
      inPoint = false
    }
  }
  const group = (name: string) => {
    let found = tracks.get(name)
    if (!found) {
      tracks.set(name, (found = { name, points: 0 }))
      if (isOtherVessel(name)) targets.add(found)
    }
    return found
  }
  read: for (let at = 0; at < file.size; at += chunkBytes) {
    const chunk = carry + decoder.decode(await file.slice(at, at + chunkBytes).arrayBuffer(), { stream: true })
    // A first chunk can hold nothing but a byte order mark, which the decoder drops.
    if (!lateKnown && chunk.length > 0) {
      lateKnown = true
      late = !chunk.startsWith('<')
    }
    let end = 0
    // The chunk up to the first markup it does not close, which is read whole with the next chunk.
    let scanned = chunk
    // The next markup the tags have not reached, found once rather than at every tag.
    let markup: Markup | undefined
    const markupAfter = (from: number) => {
      markup = markupFrom(chunk, from)
      if (markup?.end === -1) scanned = chunk.slice(0, markup.at)
    }
    markupAfter(0)
    const outside = (from: number, to: number) =>
      level === 0 && (xml11 ? OUTSIDE_TEXT_11 : OUTSIDE_TEXT).test(chunk.slice(from, to))
    TAG.lastIndex = 0
    for (;;) {
      const match = nextTag(scanned)
      // The DOCTYPE, which the server reads past whole, whatever it holds.
      if (markup?.doctype && markup.end >= 0 && (match === null || markup.at < match.index + match[0].length)) {
        // It comes before the root, and once: the server refuses one anywhere else.
        if (rooted || doctyped || outside(end, markup.at)) {
          malformed = true
          break read
        }
        doctyped = true
        TAG.lastIndex = end = markup.end
        markupAfter(end)
        continue
      }
      if (match === null) break
      if (outside(end, match.index)) {
        malformed = true
        break read
      }
      if (capture && level === captureLevel + 1) text += chunk.slice(end, match.index)
      end = TAG.lastIndex
      if (markup !== undefined && markup.end >= 0 && markup.at < end) markupAfter(end)
      // The XML declaration, read whole however the chunks cut it, is the first markup or none is.
      // Anywhere else, the server refuses it.
      if (
        match[0][1] === '?' &&
        XML_TARGET.test(match[0]) &&
        (!WELL_FORMED_DECLARATION.test(match[0]) || begun || doctyped || late || match.index !== 0)
      ) {
        malformed = true
        break read
      }
      if (!begun) xml11 = match.index === 0 && isXml11(match[0])
      begun = true
      if (match[3] === undefined) {
        // A CDATA section is text, which the server refuses outside the root.
        if (level === 0 && match[0].startsWith('<![CDATA[')) {
          malformed = true
          break read
        }
        if (capture && level === captureLevel + 1) text += match[0]
        continue
      }
      const [, closing, prefix, name, empty] = match
      if (closing) {
        if (opened.pop() !== (prefix === undefined ? name : `${prefix}:${name}`)) {
          malformed = true
          break read
        }
        level--
        if (track && level === 1) track = undefined
        else if (track) close(track, name ?? '')
        continue
      }
      if (level === 0) {
        if (rooted) {
          malformed = true
          break read
        }
        rooted = true
      }
      if (level === 0 && name === 'gpx') {
        // The server refuses a file whose root is not GPX's: none of its tracks is read.
        const read = rootOf(chunk, match.index)
        // One whose bindings cannot be read is taken for GPX's only without a prefix.
        if (read.scope === null ? prefix === undefined : inGpx(prefix, [read.scope])) root ??= read
      } else if (level === 1 && name === 'trk' && root !== undefined) {
        const scope = scopeOf(chunk, match.index, match[0])
        track = inGpx(prefix, [scope, root.scope], true) && !empty ? { scope } : undefined
        capture = undefined
        inPoint = false
        segment = NO_SEGMENT
      } else if (track && level === 2 && name === 'trkseg') {
        const scope = scopeOf(chunk, match.index, match[0])
        const scopes = [scope, track.scope, root?.scope]
        if (inGpx(prefix, scopes, true)) {
          track.group ??= group(track.name ?? '')
          segment = { scopes, inGpx: !empty, plain: inGpx(undefined, scopes, true) }
        }
      } else if (track && level === 2 && name === 'name' && track.group === undefined && capture === undefined) {
        if (inGpx(prefix, [scopeOf(chunk, match.index, match[0]), track.scope, root?.scope], true)) {
          capture = 'name'
          captureLevel = level
          text = ''
        }
      } else if (track?.group && level === 3 && name === 'trkpt' && segment.inGpx) {
        // Most points bind no namespace and have no prefix: their segment's default says.
        const scope = prefix !== undefined || match[0].includes('xmlns') ? scopeOf(chunk, match.index, match[0]) : false
        if (scope === false ? segment.plain : inGpx(prefix, [scope, ...segment.scopes], true)) {
          track.group.points++
          if (!empty) {
            pointText = chunk
            pointAt = match.index
            pointScope = scope === false ? undefined : scope
            inPoint = true
          }
        }
      } else if (inPoint && level === 4 && name === 'time' && capture === undefined) {
        // A track's times are its points' own, as the server reads them.
        const scope = scopeOf(chunk, match.index, match[0])
        if (inGpx(prefix, [scope, pointScope, ...segment.scopes], true)) {
          capture = 'time'
          captureLevel = level
          text = ''
          timePrefix = prefix
          timeScope = scope
        }
      }
      if (!empty) {
        level++
        if (opened.length >= MAX_OPEN_ELEMENTS) {
          malformed = true
          break read
        }
        opened.push(prefix === undefined ? name : `${prefix}:${name}`)
      } else if (track) close(track, name)
    }
    // A tag cut by the end of the chunk is read whole with the next one, and
    // markup the chunk does not close is carried from its start, as long as
    // the server takes either: it refuses the file past that, so the scan ends
    // there, rather than carry a quote left open to the end of the file.
    const unclosed = scanned !== chunk
    const open = unclosed ? scanned.length : chunk.lastIndexOf('<')
    if (open >= end && chunk.length - open > MAX_CARRIED_TAG) {
      stopped = true
      break read
    }
    if (outside(end, open >= end ? open : chunk.length)) {
      malformed = true
      break read
    }
    carry = open >= end ? chunk.slice(open) : ''
    if (capture && level === captureLevel + 1) text += chunk.slice(end, open >= end ? open : chunk.length)
    onProgress(Math.min(file.size, at + chunkBytes) / file.size)
  }
  // A file that ends with elements or markup still open is refused by the server as well.
  if (malformed || (!stopped && (opened.length > 0 || carry !== ''))) return []
  markElsewhere(sampledTracks, namesOwnTrack(root?.creator ?? undefined))
  return [...tracks.values()]
}

/** Bytes at each end of the file its fingerprint reads. */
const FINGERPRINT_BYTES = 64 * 1024

/** cyrb53, a fast 53-bit string hash: enough to tell two files apart by chance, not against intent. */
function hash53(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 2654435761)
    h2 = Math.imul(h2 ^ byte, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * What tells `file` from another of its name and size, so that an upload
 * broken off goes on only with the file it began with: its time of change,
 * and a hash of its first and last bytes. Not a digest of the whole file,
 * which would mean reading a gigabyte before every resume; and not
 * SubtleCrypto, which a page served over plain http, as most boats serve
 * it, does not have.
 */
export async function fingerprintOf(file: Blob & { lastModified?: number }): Promise<string> {
  const head = new Uint8Array(await file.slice(0, FINGERPRINT_BYTES).arrayBuffer())
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - FINGERPRINT_BYTES)).arrayBuffer())
  return `${file.lastModified ?? 0}:${hash53(head)}:${hash53(tail)}`
}

/** The answer's body, or what it says in place of one. */
async function bodyOf(response: Response): Promise<UploadAnswer> {
  try {
    return (await response.json()) as UploadAnswer
  } catch {
    return { message: `The server answered ${response.status}.` }
  }
}

/** Whether the tracks an upload carries, as the server reported them, are the ones chosen, in any order. */
function sameTracks(carried: unknown, chosen: readonly string[]): boolean {
  if (!Array.isArray(carried) || carried.length !== chosen.length) return false
  const names: unknown[] = carried
  if (!names.every((name): name is string => typeof name === 'string')) return false
  const sorted = [...chosen].sort()
  return [...names].sort().every((name, i) => name === sorted[i])
}

/** Tries at ending an upload, a retry delay apart: a slice still being written holds it. */
const STOP_ATTEMPTS = 5

/**
 * End the upload on the server, and throw the AbortError that says so, or
 * the error that says the server was not told: it then holds the upload
 * until another takes its place, which it allows after IDLE_TIMEOUT_MS
 * without a slice.
 */
async function stopUpload(
  call: Call,
  url: string,
  onStatus: (status: GpxUploadStatus) => void,
  wait: (ms: number) => Promise<void>,
): Promise<never> {
  let ended = false
  for (let attempt = 0; attempt < STOP_ATTEMPTS && !ended; attempt++) {
    if (attempt > 0) await wait(RETRY_DELAY_MS)
    const response = await call(url, { method: 'DELETE' }).catch(() => undefined)
    const upload = response && (await bodyOf(response)).upload
    if (upload) onStatus(upload)
    ended = response?.ok === true || (!!upload && upload.state !== 'receiving')
  }
  if (!ended) {
    throw new Error(
      'Stopped sending, but the server could not be told. It holds the import until another one takes its place, which it allows after 15 minutes without a slice.',
    )
  }
  throw stopped()
}

/** What `promise` comes to, or undefined as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve, reject) => {
    const aborted = () => resolve(undefined)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** Wait `ms`, or less once `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

const stopped = () => new DOMException('The import was stopped', 'AbortError')

/** Refusals no second try changes. */
const FINAL = new Set([400, 401, 403, 413, 415, 422])

/**
 * Send `file` into the own vessel's recording, resolving to the finished
 * upload's status; `onStatus` hears each one on the way. An upload of the
 * same file with the same choices that a dropped connection or a restart
 * broke off goes on from where the server got to. Aborting `signal` gives
 * up the slice on its way and ends the upload on the server; what the server
 * wrote stays.
 */
export async function uploadGpx({
  file,
  tracks,
  onOverlap,
  onStatus,
  signal,
  request = fetch,
  sleep,
}: UploadOptions): Promise<GpxUploadStatus> {
  const wait = sleep ?? ((ms: number) => pause(ms))
  // Stop does not wait out a retry's delay.
  const backOff = (ms: number) => (sleep ? unlessAborted(sleep(ms), signal) : pause(ms, signal))
  const call: Call = (url, init = {}) => request(url, { credentials: 'include', ...init })
  const current = async () => {
    const response = await call(UPLOAD_URL)
    return response.ok ? (await bodyOf(response)).upload : undefined
  }

  const fingerprint = await fingerprintOf(file)
  const existing = await unlessAborted(
    current().catch(() => undefined),
    signal,
  )
  if (signal?.aborted) throw stopped()
  const same =
    existing?.state === 'receiving' &&
    existing.filename === file.name &&
    existing.size === file.size &&
    existing.fingerprint === fingerprint &&
    existing.onOverlap === onOverlap &&
    sameTracks(existing.tracks, tracks)
  let status: GpxUploadStatus
  if (same) {
    status = existing
  } else {
    const starting = call(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, tracks, onOverlap, fingerprint }),
    })
    const response = await unlessAborted(starting, signal)
    if (response === undefined) {
      // The request itself goes on, so that an upload it starts is ended once its answer comes.
      void starting
        .then(bodyOf)
        .then(({ upload }) => {
          if (upload?.state === 'receiving') {
            return call(`${UPLOAD_URL}/${encodeURIComponent(upload.id)}`, { method: 'DELETE' })
          }
          return undefined
        })
        .catch(() => undefined)
      throw stopped()
    }
    const body = await bodyOf(response)
    if (!response.ok || !body.upload) {
      throw new Error(body.message ?? `The server answered ${response.status}.`)
    }
    status = body.upload
  }
  onStatus(status)
  const url = `${UPLOAD_URL}/${encodeURIComponent(status.id)}`

  let failures = 0
  const retry = async (error: Error) => {
    if (++failures > RETRIES) throw error
    await backOff(Math.min(RETRY_DELAY_MS * 2 ** (failures - 1), RETRY_DELAY_MAX_MS))
  }
  while (status.state === 'receiving') {
    if (signal?.aborted) {
      await stopUpload(call, url, onStatus, wait)
    }
    const offset = status.received
    let response: Response
    try {
      response = await call(`${url}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(offset, offset + SLICE_BYTES),
        // Stop does not wait for a slice that is stuck on its way: the
        // server goes on from what it wrote either way.
        signal: signal ?? null,
      })
    } catch {
      if (signal?.aborted) continue
      await retry(new Error('Could not reach the server.'))
      // The slice may have arrived though its answer did not.
      const now = await current().catch(() => undefined)
      if (now?.id === status.id) status = now
      continue
    }
    const body = await bodyOf(response)
    if (response.ok && body.upload) {
      failures = 0
      status = body.upload
      onStatus(status)
      continue
    }
    if (FINAL.has(response.status)) {
      throw new Error(body.message ?? `The server answered ${response.status}.`)
    }
    // Out of step, a failed write the server took back, or the plugin
    // restarting: go on from where the server says it is.
    await retry(new Error(body.message ?? `The server answered ${response.status}.`))
    const now = body.upload ?? (await current().catch(() => undefined))
    if (now?.id === status.id) status = now
  }
  if (status.state !== 'finished') {
    throw new Error(status.error ?? `The import is ${status.state}.`)
  }
  return status
}
