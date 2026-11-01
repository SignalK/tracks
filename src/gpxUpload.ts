import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { SaxesParser } from 'saxes'
import type { SaxesTagNS } from 'saxes'
import { dateTime, decimal, escapeXml, GPX_NAMESPACE, inRange } from './gpx.js'
import type {
  Context,
  GpxUploadState,
  OnOverlap,
  OpenTag,
  TimedPosition,
  UploadCheckpoint,
  UploadPart,
} from './types.js'

/**
 * A GPX file uploaded in slices, read as it arrives and written into the own
 * vessel's recording a slice at a time.
 *
 * A chartplotter's export of several years runs past a gigabyte, more than
 * one request can carry or the server can hold, so the client sends it in
 * slices of a few MiB, each naming the byte it starts at. A slice's reply
 * comes once its points are written, so the client never gets ahead of the
 * store, and a client that lost a reply asks where to go on rather than
 * guessing; a slice sent twice is refused rather than imported twice.
 *
 * Each slice is saved with a checkpoint: the last byte at which the file is
 * between two elements of GPX's own structure, with the start tags open
 * there. A restart reads on from it, the parser fed those tags first, and
 * the client sends again from that byte.
 */

/** The largest slice one request may carry. */
export const MAX_SLICE_BYTES = 8 * 1024 * 1024

/** An upload nobody has sent a slice to for this long gives way to a new one. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000

/** Characters handed to the parser at once: each runs without yielding. */
const PARSE_CHARS = 64 * 1024

/**
 * The most characters the parser holds between two pieces of markup it has
 * read whole: it keeps an unfinished text, tag or comment until its end
 * arrives, which a file could put off past any slice.
 */
export const MAX_PENDING_CHARS = 1024 * 1024

/**
 * GPX's elements from the root down to a point's time, each a child of the
 * one before. A track's `<name>` is a child of `<trk>` beside them.
 */
const CHAIN = ['gpx', 'trk', 'trkseg', 'trkpt', 'time']
const GPX = 1
const TRK = 2
const TRKSEG = 3
const TRKPT = 4
const TIME = 5

/** What is open at a point of the file, apart from the elements inside a segment. */
interface Structure {
  open: OpenTag[]
  track?: string | null
  segments: number
}

/** The request does not fit the upload's state; the upload's status says where it stands. */
export class UploadConflictError extends Error {}

/** The file is not one this plugin can read. */
export class UploadFormatError extends Error {}

const startTag = ({ name, attributes }: OpenTag): string =>
  `<${name}${attributes.map(([qualified, value]) => ` ${qualified}="${escapeXml(value)}"`).join('')}>`

/** How many leading bytes end on a character, so a slice cut inside one carries the rest to the next. */
function completeLength(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!
    // A continuation byte: the character starts further back.
    if ((byte & 0xc0) === 0x80) continue
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return length > back ? bytes.length - back : bytes.length
  }
  return bytes.length
}

/** What one read of the file brought. */
export interface GpxRead {
  /** Points of the chosen tracks by segment number, in file order. */
  parts: Map<number, TimedPosition[]>
  untimed: number
  /** The last place to read on from, when the bytes reached one. */
  checkpoint?: UploadCheckpoint
  error?: string
}

/**
 * The points of a GPX file's chosen tracks, read from its bytes in order.
 *
 * It reads what `fromGpx` reads, by the same rules: a `<trk>` under the root
 * `<gpx>`, a `<trkseg>` under it, a `<trkpt>` under that, each in GPX's
 * namespace or none; coordinates as `xsd:decimal` in range and times as
 * `xsd:dateTime`, a point without a usable one counted rather than placed. A
 * track is chosen by the `<name>` it has before its first segment, `''` for
 * none.
 */
export class GpxReader {
  private readonly parser = new SaxesParser({ xmlns: true })
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  /** Local names of the open elements, `''` for one outside GPX's namespace. */
  private readonly path: string[]
  /** How many of the open elements, from the root, are the first of CHAIN. */
  private matched: number
  private structure: Structure
  /** Characters the parser was given, for where in this read a clean point falls. */
  private fed = 0
  /** Bytes of the file the reader has been given, from the start. */
  private offset: number
  /** The end of a character a slice cut, for the next one. */
  private carry = new Uint8Array(0)
  private clean: { at: number; structure: Structure } | undefined
  /** Where in the characters fed the parser last finished reading a piece of markup. */
  private mark = 0
  private error: string | undefined
  private nameText = ''
  private timeText = ''
  private point: [number, number] | undefined
  private parts = new Map<number, TimedPosition[]>()
  private untimed = 0

  constructor(
    private readonly tracks: ReadonlySet<string>,
    from: UploadCheckpoint,
  ) {
    this.offset = from.offset
    this.structure = {
      open: from.open,
      ...(from.track === undefined ? {} : { track: from.track }),
      segments: from.segments,
    }
    this.path = CHAIN.slice(0, from.open.length)
    this.matched = from.open.length
    this.parser.on('error', (err) => {
      this.error ??= `The file is not well-formed GPX: ${err.message}`
    })
    if (from.open.length > 0) {
      const prefix = from.open.map(startTag).join('')
      this.parser.write(prefix)
      this.fed = prefix.length
      this.mark = prefix.length
    }
    const read = () => {
      this.mark = this.parser.position
    }
    this.parser.on('opentag', (tag) => {
      read()
      this.open(tag)
    })
    this.parser.on('closetag', () => {
      read()
      this.close()
    })
    this.parser.on('text', (text) => {
      read()
      this.text(text)
    })
    this.parser.on('cdata', (text) => {
      read()
      this.text(text)
    })
    for (const event of ['comment', 'processinginstruction', 'doctype', 'xmldecl'] as const) {
      this.parser.on(event, read)
    }
  }

  /** Read the file's next bytes; `end` says they are its last. */
  async read(bytes: Uint8Array, end: boolean): Promise<GpxRead> {
    this.begin()
    // The byte of the file the text starts at: the carried end of a character first.
    const start = this.offset - this.carry.length
    const all = new Uint8Array(this.carry.length + bytes.length)
    all.set(this.carry)
    all.set(bytes, this.carry.length)
    this.offset += bytes.length
    const complete = end ? all.length : completeLength(all)
    this.carry = all.slice(complete)
    let text: string
    try {
      text = this.decoder.decode(all.subarray(0, complete))
    } catch {
      return { parts: this.parts, untimed: 0, error: `The file is not UTF-8 near byte ${start}` }
    }
    const base = this.fed
    for (let i = 0; i < text.length && !this.error; i += PARSE_CHARS) {
      this.parser.write(text.slice(i, i + PARSE_CHARS))
      // Counted here: the parser's own position is off between two writes.
      if (base + Math.min(text.length, i + PARSE_CHARS) - this.mark > MAX_PENDING_CHARS) {
        this.error ??= `The file is not GPX: more than ${MAX_PENDING_CHARS} characters without markup ending near byte ${start}`
      }
      await yieldToLoop()
    }
    this.fed += text.length
    if (end && !this.error) {
      this.parser.close()
    }
    const { clean } = this
    return {
      parts: this.parts,
      untimed: this.untimed,
      ...(clean === undefined
        ? {}
        : {
            checkpoint: {
              offset: start + Buffer.byteLength(text.slice(0, clean.at - base)),
              ...clean.structure,
            },
          }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  private begin(): void {
    this.parts = new Map()
    this.untimed = 0
    this.clean = undefined
  }

  /**
   * Whether the innermost open element is the `depth`th of CHAIN, at its
   * place: a `<trkseg>` inside an `<extensions>` payload is not a segment.
   * Counted rather than compared name by name, since it is asked several
   * times for each of millions of points.
   */
  private at(depth: number): boolean {
    return this.path.length === depth && this.matched === depth
  }

  /** Whether the innermost open element is a track's `<name>`. */
  private inName(): boolean {
    return this.path.length === TRK + 1 && this.matched >= TRK && this.path[TRK] === 'name'
  }

  private open(tag: SaxesTagNS): void {
    // The parser reports an error and reads on; nothing after it counts.
    if (this.error) return
    const local = tag.uri === '' || tag.uri === GPX_NAMESPACE ? tag.local : ''
    if (this.matched === this.path.length && local === CHAIN[this.matched]) {
      this.matched++
    }
    this.path.push(local)
    if (this.path.length === GPX && !this.at(GPX)) {
      this.error = `The file is not GPX: its root is <${tag.name}>`
      return
    }
    if (this.at(TRKPT)) {
      this.point = [decimal(tag.attributes.lat?.value), decimal(tag.attributes.lon?.value)]
      this.timeText = ''
      return
    }
    if (this.inName()) {
      this.nameText = ''
      return
    }
    if (!this.at(GPX) && !this.at(TRK) && !this.at(TRKSEG)) {
      return
    }
    const { open, track, segments } = this.structure
    const written: OpenTag = {
      name: tag.name,
      attributes: Object.values(tag.attributes).map(({ name, value }): [string, string] => [name, value]),
    }
    if (this.at(GPX)) {
      this.structure = { open: [written], segments }
    } else if (this.at(TRK)) {
      this.structure = { open: [...open, written], track: null, segments }
    } else {
      // A name after the first segment comes too late to choose the track by.
      this.structure = { open: [...open, written], track: track ?? '', segments: segments + 1 }
    }
    this.clean = { at: this.parser.position, structure: this.structure }
  }

  private text(text: string): void {
    if (this.at(TIME)) {
      this.timeText = this.captured(this.timeText, text)
    } else if (this.inName()) {
      this.nameText = this.captured(this.nameText, text)
    }
  }

  /**
   * `held` and `text` together, unless that runs past MAX_PENDING_CHARS: a
   * name or time is read from text that can come in any number of CDATA
   * sections, each within the bound on what the parser holds.
   */
  private captured(held: string, text: string): string {
    if (held.length + text.length > MAX_PENDING_CHARS) {
      this.error ??= `The file is not GPX: a track's name or a point's time runs past ${MAX_PENDING_CHARS} characters`
      return held
    }
    return held + text
  }

  private close(): void {
    if (this.error) return
    const { open, segments } = this.structure
    if (this.at(TRKPT)) {
      this.addPoint()
    } else if (this.inName()) {
      if (this.structure.track === null) {
        this.structure = { ...this.structure, track: this.nameText.trim() }
      }
    } else if (this.at(TRKSEG)) {
      this.structure = { ...this.structure, open: open.slice(0, TRK) }
    } else if (this.at(TRK)) {
      this.structure = { open: open.slice(0, GPX), segments }
    } else if (this.at(GPX)) {
      this.structure = { open: [], segments }
    }
    this.path.pop()
    this.matched = Math.min(this.matched, this.path.length)
    // Not past the root: a parser started again there would find a document without one.
    if (this.matched === this.path.length && this.path.length >= GPX && this.path.length <= TRKSEG) {
      this.clean = { at: this.parser.position, structure: this.structure }
    }
  }

  private addPoint(): void {
    const point = this.point
    this.point = undefined
    const { track, segments } = this.structure
    if (!point || !inRange(...point) || !this.tracks.has(track ?? '')) {
      return
    }
    const raw = this.timeText.trim()
    const timestamp = raw === '' ? Number.NaN : dateTime(raw)
    if (!Number.isFinite(timestamp)) {
      this.untimed++
      return
    }
    let part = this.parts.get(segments)
    if (!part) this.parts.set(segments, (part = []))
    part.push({ position: point, timestamp })
  }
}

/** An upload as the routes answer it. */
export interface GpxUploadStatus {
  id: string
  filename: string
  size: number
  tracks: string[]
  onOverlap: OnOverlap
  /** What the client said tells the file from another of its name and size. */
  fingerprint?: string
  /** Bytes taken so far: where the next slice starts. */
  received: number
  state: GpxUploadState['state']
  error?: string
  imported: number
  overlapping: number
  untimed: number
  /** Points left out because they are older than the own vessel's retention keeps. */
  expired: number
  startedAt: string
  updatedAt: string
}

export interface GpxUploadDeps {
  /** Write a slice's points with the state they bring the upload to; see `TrackStore.saveGpxUpload`. */
  save: (state: GpxUploadState, parts: UploadPart[]) => Promise<GpxUploadState>
  /** Told after a slice replaced part of the recording. */
  replaced: () => void
  /**
   * The oldest time a slice writes: the own vessel's retention deletes what
   * lies before it within the hour. Everything when unset.
   */
  keepFrom?: () => number
  now?: () => number
}

/** What a client asks for to start an upload. */
export interface UploadStart {
  filename: string
  size: number
  tracks: string[]
  onOverlap: OnOverlap
  fingerprint?: string
}

/** The longest fingerprint an upload keeps. */
const MAX_FINGERPRINT = 256

/** A request to start an upload, or why it cannot start one. */
export function parseUploadStart(body: unknown): UploadStart | string {
  const {
    filename,
    size,
    tracks,
    onOverlap = 'keep',
    fingerprint,
  } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof filename !== 'string' || filename === '') {
    return 'filename must name the file'
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    return "size must be the file's size in bytes"
  }
  if (!Array.isArray(tracks) || tracks.length === 0 || !tracks.every((name) => typeof name === 'string')) {
    return "tracks must name the file's tracks to import"
  }
  if (onOverlap !== 'keep' && onOverlap !== 'replace') {
    return "onOverlap must be 'keep' or 'replace'"
  }
  if (fingerprint !== undefined && (typeof fingerprint !== 'string' || fingerprint.length > MAX_FINGERPRINT)) {
    return `fingerprint must be a string of at most ${MAX_FINGERPRINT} characters`
  }
  return { filename, size, tracks, onOverlap, ...(fingerprint === undefined ? {} : { fingerprint }) }
}

/** The state of an upload about to start. */
export function newUpload(
  start: {
    filename: string
    size: number
    context: Context
    tracks: string[]
    onOverlap: OnOverlap
    fingerprint?: string
    keepEmpty: boolean
  },
  now = Date.now(),
): GpxUploadState {
  return {
    id: randomUUID(),
    ...start,
    state: 'receiving',
    checkpoint: { offset: 0, open: [], segments: 0 },
    imported: 0,
    overlapping: 0,
    untimed: 0,
    startedAt: now,
    updatedAt: now,
  }
}

/** A slice's hold on its upload; see `GpxUpload.reserve`. */
export interface SliceReservation {
  write: (bytes: Uint8Array) => Promise<void>
  release: () => void
}

/** One upload: the slices it takes, one at a time, and its state as the store last saved it. */
export class GpxUpload {
  private reader!: GpxReader
  private received = 0
  private busy = false
  /** When the slice being received was reserved. */
  private reservedAt = 0
  private superseded = false
  private readonly now: () => number

  constructor(
    private state: GpxUploadState,
    private readonly deps: GpxUploadDeps,
  ) {
    this.now = deps.now ?? Date.now
    this.rewind()
  }

  get id(): string {
    return this.state.id
  }

  get active(): boolean {
    return this.state.state === 'receiving'
  }

  /**
   * Receiving, but nothing has arrived for IDLE_TIMEOUT_MS: no slice was
   * written in that time, and none has been on its way for as long.
   */
  get idle(): boolean {
    return this.active && this.now() - (this.busy ? this.reservedAt : this.state.updatedAt) > IDLE_TIMEOUT_MS
  }

  /**
   * Give way to a new upload: a slice of this one still on its way is
   * refused rather than written, so it cannot write over the new upload's
   * state in the store.
   */
  supersede(): void {
    this.superseded = true
  }

  /** Take back `supersede()`, when the new upload could not be started after all. */
  resume(): void {
    this.superseded = false
  }

  get status(): GpxUploadStatus {
    const {
      id,
      filename,
      size,
      tracks,
      onOverlap,
      fingerprint,
      state,
      error,
      imported,
      overlapping,
      untimed,
      expired = 0,
      startedAt,
      updatedAt,
    } = this.state
    return {
      id,
      filename,
      size,
      tracks,
      onOverlap,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      received: this.received,
      state,
      ...(error === undefined ? {} : { error }),
      imported,
      overlapping,
      untimed,
      expired,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
    }
  }

  /**
   * Read and write the slice starting at byte `offset`, resolving once its
   * points are written. The slice that brings the file to its size finishes
   * the upload.
   */
  async append(offset: number, bytes: Uint8Array): Promise<void> {
    await this.reserve(offset).write(bytes)
  }

  /**
   * Hold the upload for the slice starting at byte `offset` while its body
   * arrives, so that no other request reads one beside it; `write` the bytes
   * once they are in, or `release` the upload when they never come.
   */
  reserve(offset: number): SliceReservation {
    this.expectReceiving()
    if (offset !== this.received) {
      throw new UploadConflictError(`The next slice starts at byte ${this.received}, not ${offset}`)
    }
    this.busy = true
    this.reservedAt = this.now()
    let held = true
    const release = () => {
      if (held) {
        held = false
        this.busy = false
      }
    }
    return {
      write: async (bytes) => {
        if (!held) throw new UploadConflictError('The slice was written already')
        try {
          await this.write(offset, bytes)
        } finally {
          release()
        }
        if (this.state.error !== undefined && this.state.state === 'failed') {
          throw new UploadFormatError(this.state.error)
        }
      },
      release,
    }
  }

  private async write(offset: number, bytes: Uint8Array): Promise<void> {
    if (offset + bytes.length > this.state.size) {
      throw new UploadConflictError(`The slice runs past the file's size of ${this.state.size} bytes`)
    }
    try {
      const end = offset + bytes.length === this.state.size
      const read = await this.reader.read(bytes, end)
      const readParts = [...read.parts].map(([segment, points]): UploadPart => ({
        segment,
        // Within a segment only: a segment is a stretch of recording, and
        // TimeZero's exports overlap where their blocks of points join.
        points: points.sort((a, b) => a.timestamp - b.timestamp),
        continues: segment === this.state.lastSegment,
      }))
      const lastSegment = readParts.at(-1)?.segment ?? this.state.lastSegment
      // A part left with no points is still saved: the store ends the
      // segment before it there, so the slice after does not take that
      // segment's state for its own.
      const keepFrom = this.deps.keepFrom?.() ?? Number.NEGATIVE_INFINITY
      let expired = 0
      const parts = readParts.map((part): UploadPart => {
        const points = part.points.filter(({ timestamp }) => timestamp >= keepFrom)
        expired += part.points.length - points.length
        return points.length === part.points.length ? part : { ...part, points }
      })
      const next: GpxUploadState = {
        ...this.state,
        ...(lastSegment === undefined ? {} : { lastSegment }),
        ...(read.checkpoint === undefined ? {} : { checkpoint: read.checkpoint }),
        untimed: this.state.untimed + read.untimed,
        expired: (this.state.expired ?? 0) + expired,
        updatedAt: this.now(),
        ...(read.error !== undefined ? { state: 'failed', error: read.error } : end ? { state: 'finished' } : {}),
      }
      if (this.superseded) {
        throw new UploadConflictError('Another file is being imported')
      }
      this.state = await this.deps.save(next, parts)
      this.received += bytes.length
      if (this.state.onOverlap === 'replace' && parts.length > 0) {
        this.deps.replaced()
      }
    } catch (err) {
      // Read on from what the store last saved, which the client sends again.
      this.rewind()
      throw err
    }
  }

  /** End the upload. What it wrote stays: a file imported again fills only the gaps, or replaces itself. */
  async abort(): Promise<void> {
    this.expectReceiving()
    this.busy = true
    try {
      this.state = await this.deps.save({ ...this.state, state: 'aborted', updatedAt: this.now() }, [])
    } finally {
      this.busy = false
    }
  }

  private expectReceiving(): void {
    if (!this.active) {
      throw new UploadConflictError(`The upload is ${this.state.state}`)
    }
    // Its state saved now would take the place of the new upload's.
    if (this.superseded) {
      throw new UploadConflictError('Another file is being imported')
    }
    if (this.busy) {
      throw new UploadConflictError('The slice before is still being written')
    }
  }

  private rewind(): void {
    this.reader = new GpxReader(new Set(this.state.tracks), this.state.checkpoint)
    // The end of a file comes after its last checkpoint.
    this.received = this.state.state === 'finished' ? this.state.size : this.state.checkpoint.offset
  }
}
