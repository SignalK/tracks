import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fromGpx } from './gpx.js'
import {
  GpxReader,
  GpxUpload,
  MAX_PENDING_CHARS,
  newUpload,
  UploadConflictError,
  UploadFormatError,
} from './gpxUpload.js'
import type { GpxUploadState, TimedPosition, UploadCheckpoint, UploadPart } from './types.js'

const GPX_NS = 'http://www.topografix.com/GPX/1/1'
const t0 = Date.UTC(2025, 6, 1, 12)
const iso = (ms: number) => new Date(ms).toISOString()
const START: UploadCheckpoint = { offset: 0, open: [], segments: 0 }

const point = (lat: number, lon: number, time?: number) =>
  `<trkpt lat="${lat}" lon="${lon}">${time === undefined ? '' : `<time>${iso(time)}</time>`}</trkpt>`

const document = (tracks: string, root = `<gpx version="1.1" xmlns="${GPX_NS}">`) =>
  `<?xml version="1.0" encoding="UTF-8"?>\r\n${root}\r\n${tracks}\r\n</gpx>\r\n`

/** Two tracks, one with a name the reader must decode and two segments. */
const sample = document(
  [
    '<trk><name> Ström &amp; Söhne ⛵ </name><trkseg>',
    point(60, 24, t0),
    point(60.001, 24.001, t0 + 1000),
    '</trkseg><trkseg>',
    point(60.002, 24.002, t0 + 600_000),
    '</trkseg></trk>',
    '<trk><name>AIS Ariadne</name><trkseg>',
    point(59, 23, t0),
    '</trkseg></trk>',
  ].join('\r\n'),
)

/**
 * Every point read from `bytes` cut into slices of `size`. With `restart`, a
 * new reader takes over at each checkpoint, as after a restart, and reads on
 * from its byte.
 */
async function readAll(bytes: Uint8Array, tracks: string[], size: number, restart = false) {
  const segments = new Map<number, TimedPosition[]>()
  let untimed = 0
  let reader = new GpxReader(new Set(tracks), START)
  let offset = 0
  while (offset < bytes.length) {
    const next = Math.min(bytes.length, offset + size)
    const read = await reader.read(bytes.subarray(offset, next), next === bytes.length)
    expect(read.error).toBeUndefined()
    untimed += read.untimed
    for (const [segment, points] of read.parts) {
      segments.set(segment, [...(segments.get(segment) ?? []), ...points])
    }
    offset = next
    if (restart && read.checkpoint && next < bytes.length) {
      reader = new GpxReader(new Set(tracks), read.checkpoint)
      offset = read.checkpoint.offset
    }
  }
  return { segments, untimed }
}

/** The byte of `sample` that `text` starts at. */
const byteOf = (text: string) => Buffer.byteLength(sample.slice(0, sample.indexOf(text)))

const sorted = (points: TimedPosition[]) => [...points].sort((a, b) => a.timestamp - b.timestamp)

describe('reading a GPX file in slices', () => {
  const bytes = new TextEncoder().encode(sample)
  const expected = fromGpx(sample).flatMap(({ segments }) => segments)

  it.each([1, 3, 7, 64, bytes.length])('reads what fromGpx reads, in slices of %i bytes', async (size) => {
    const { segments } = await readAll(bytes, ['Ström & Söhne ⛵', 'AIS Ariadne'], size)
    expect([...segments.keys()]).toEqual([1, 2, 3])
    expect([...segments.values()].map(sorted)).toEqual(expected)
  })

  it.each([1, 5, 16, 100])('reads on from each checkpoint as after a restart, in slices of %i bytes', async (size) => {
    const { segments } = await readAll(bytes, ['Ström & Söhne ⛵', 'AIS Ariadne'], size, true)
    expect([...segments.values()].map(sorted)).toEqual(expected)
  })

  it('reads the TimeZero fixture as fromGpx does, restarted at every checkpoint', async () => {
    const xml = readFileSync(new URL('./__fixtures__/timezero-seams.gpx', import.meta.url), 'utf8')
    const { segments } = await readAll(new TextEncoder().encode(xml), ['AIS SEAM TEST'], 4096, true)
    expect([...segments.values()].map(sorted)).toEqual(fromGpx(xml)[0]!.segments)
  })

  it('keeps a checkpoint between elements, where the parser can start again', async () => {
    const reader = new GpxReader(new Set(['AIS Ariadne']), START)
    const cut = sample.indexOf('<trkpt lat="59"') + 5
    const read = await reader.read(new TextEncoder().encode(sample.slice(0, cut)), false)
    const checkpoint = read.checkpoint!
    // Bytes, not characters: the name before it has some of several bytes.
    expect(new TextDecoder().decode(bytes.subarray(0, checkpoint.offset)).endsWith('<trkseg>')).toBe(true)
    expect(checkpoint.open.map(({ name }) => name)).toEqual(['gpx', 'trk', 'trkseg'])
    expect(checkpoint.open[0]!.attributes).toContainEqual(['xmlns', GPX_NS])
    expect(checkpoint).toMatchObject({ track: 'AIS Ariadne', segments: 3 })
  })

  it('reads on in a file whose GPX elements carry a prefix', async () => {
    const prefixed = document(
      `<g:trk><g:name>Own</g:name><g:trkseg>${point(60, 24, t0)}${point(61, 25, t0 + 1000)}</g:trkseg></g:trk>`
        .replace(/<(\/?)trkpt/g, '<$1g:trkpt')
        .replace(/<(\/?)time>/g, '<$1g:time>'),
      `<g:gpx version="1.1" xmlns:g="${GPX_NS}">`,
    ).replace('</gpx>', '</g:gpx>')
    const { segments } = await readAll(new TextEncoder().encode(prefixed), ['Own'], 3, true)
    expect([...segments.values()]).toEqual([
      [
        { position: [60, 24], timestamp: t0 },
        { position: [61, 25], timestamp: t0 + 1000 },
      ],
    ])
  })

  it('reads only the tracks chosen by name, and a track without one as the empty name', async () => {
    const xml = document(
      [
        `<trk><trkseg>${point(1, 1, t0)}</trkseg></trk>`,
        `<trk><name>Chosen</name><trkseg>${point(2, 2, t0)}</trkseg></trk>`,
        // Its name comes after its segment: too late to choose it by.
        `<trk><trkseg>${point(3, 3, t0)}</trkseg><name>Chosen</name></trk>`,
      ].join(''),
    )
    const { segments } = await readAll(new TextEncoder().encode(xml), ['', 'Chosen'], 5)
    expect([...segments.entries()]).toEqual([
      [1, [{ position: [1, 1], timestamp: t0 }]],
      [2, [{ position: [2, 2], timestamp: t0 }]],
      [3, [{ position: [3, 3], timestamp: t0 }]],
    ])
    const only = await readAll(new TextEncoder().encode(xml), ['Chosen'], 5)
    expect([...only.segments.keys()]).toEqual([2])
  })

  it('reads only GPX structure: not a segment in extensions, nor an element of another namespace', async () => {
    const xml = document(
      [
        '<trk><name>Own</name>',
        `<extensions><trkseg>${point(9, 9, t0)}</trkseg></extensions>`,
        `<trkseg>${point(1, 1, t0)}<x:trkpt xmlns:x="urn:other" lat="8" lon="8"/></trkseg>`,
        '</trk>',
      ].join(''),
    )
    const { segments } = await readAll(new TextEncoder().encode(xml), ['Own'], 11)
    expect([...segments.values()]).toEqual([[{ position: [1, 1], timestamp: t0 }]])
  })

  it('counts the points without a usable time and drops the ones that are no place', async () => {
    const xml = document(
      `<trk><name>Own</name><trkseg>${point(1, 1)}<trkpt lat="1" lon="1"><time>2024-02-30T00:00:00Z</time></trkpt>${point(91, 1, t0)}${point(1, 1, t0)}</trkseg></trk>`,
    )
    const { segments, untimed } = await readAll(new TextEncoder().encode(xml), ['Own'], 64)
    expect(untimed).toBe(2)
    expect([...segments.values()]).toEqual([[{ position: [1, 1], timestamp: t0 }]])
  })

  it('reports a file that is not well-formed, with the points read before it', async () => {
    const xml = document(`<trk><name>Own</name><trkseg>${point(1, 1, t0)}</trk>`)
    const read = await new GpxReader(new Set(['Own']), START).read(new TextEncoder().encode(xml), true)
    expect(read.error).toMatch(/not well-formed GPX/)
    expect([...read.parts.values()]).toEqual([[{ position: [1, 1], timestamp: t0 }]])
  })

  it('reports a file that is not UTF-8', async () => {
    const read = await new GpxReader(new Set(['Own']), START).read(new Uint8Array([0x3c, 0xff, 0x3e]), true)
    expect(read.error).toMatch(/not UTF-8/)
  })

  it('reports a file cut short', async () => {
    const read = await new GpxReader(new Set(['Own']), START).read(bytes.subarray(0, 100), true)
    expect(read.error).toMatch(/not well-formed GPX/)
  })

  it('reports a well-formed file whose root is not GPX', async () => {
    const xml = `<kml xmlns="${GPX_NS}"><trk><name>Own</name><trkseg>${point(1, 1, t0)}</trkseg></trk></kml>`
    const read = await new GpxReader(new Set(['Own']), START).read(new TextEncoder().encode(xml), true)
    expect(read.error).toBe('The file is not GPX: its root is <kml>')
    expect(read.parts.size).toBe(0)
  })

  it("reports a track's name that runs on past what it may hold, however many CDATA sections it takes", async () => {
    const reader = new GpxReader(new Set(['Own']), START)
    await reader.read(new TextEncoder().encode(`<gpx xmlns="${GPX_NS}"><trk><name>`), false)
    const sections = new TextEncoder().encode(`<![CDATA[${'x'.repeat(MAX_PENDING_CHARS / 4)}]]>`)
    for (let i = 0; i < 4; i++) {
      expect((await reader.read(sections, false)).error).toBeUndefined()
    }
    expect((await reader.read(new TextEncoder().encode('<![CDATA[x]]>'), false)).error).toMatch(/runs past/)
  })

  it('reads an empty GPX file as one without tracks', async () => {
    const read = await new GpxReader(new Set(['Own']), START).read(new TextEncoder().encode(document('')), true)
    expect(read.error).toBeUndefined()
  })

  it('reports text that runs on without markup past what the parser may hold', async () => {
    const reader = new GpxReader(new Set(['Own']), START)
    const head = await reader.read(new TextEncoder().encode(`<gpx xmlns="${GPX_NS}"><trk><name>`), false)
    expect(head.error).toBeUndefined()
    const text = new TextEncoder().encode('x'.repeat(MAX_PENDING_CHARS / 2))
    expect((await reader.read(text, false)).error).toBeUndefined()
    expect((await reader.read(text, false)).error).toBeUndefined()
    expect((await reader.read(new Uint8Array([0x78]), false)).error).toMatch(/without markup ending/)
  })
})

describe('an upload', () => {
  const bytes = new TextEncoder().encode(sample)
  const start = () =>
    newUpload({
      filename: 'export.gpx',
      size: bytes.length,
      context: 'vessels.self',
      tracks: ['AIS Ariadne', 'Ström & Söhne ⛵'],
      onOverlap: 'keep',
      keepEmpty: false,
    })

  /** A store that keeps what each write brought. */
  const saving = () => {
    const writes: UploadPart[][] = []
    const save = vi.fn(async (state: GpxUploadState, parts: UploadPart[]) => {
      writes.push(parts)
      return { ...state, imported: state.imported + parts.reduce((sum, { points }) => sum + points.length, 0) }
    })
    return { writes, save }
  }

  it('writes each slice and finishes with the one that brings the file to its size', async () => {
    const { writes, save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    const cut = byteOf('</trkseg><trkseg>') + 3
    await upload.append(0, bytes.subarray(0, cut))
    expect(upload.status).toMatchObject({ received: cut, state: 'receiving', imported: 2 })
    await upload.append(cut, bytes.subarray(cut))
    expect(upload.status).toMatchObject({ received: bytes.length, state: 'finished', imported: 4 })
    expect(writes.map((parts) => parts.map(({ segment, continues }) => [segment, continues]))).toEqual([
      [[1, false]],
      [
        [2, false],
        [3, false],
      ],
    ])
  })

  it('says a segment goes on from the slice before', async () => {
    const { writes, save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    const cut = byteOf(point(60.001, 24.001, t0 + 1000))
    await upload.append(0, bytes.subarray(0, cut))
    await upload.append(cut, bytes.subarray(cut))
    expect(writes[1]![0]).toMatchObject({ segment: 1, continues: true })
  })

  it('refuses a slice out of step, or past the file', async () => {
    const upload = new GpxUpload(start(), { ...saving(), replaced: () => undefined })
    await expect(upload.append(5, bytes.subarray(5, 10))).rejects.toThrow('starts at byte 0, not 5')
    await expect(upload.append(0, new Uint8Array(bytes.length + 1))).rejects.toBeInstanceOf(UploadConflictError)
  })

  it('refuses a slice while the one before is being written', async () => {
    let release = () => {}
    const save = vi.fn(
      (state: GpxUploadState) =>
        new Promise<GpxUploadState>((resolve) => {
          release = () => resolve(state)
        }),
    )
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    const first = upload.append(0, bytes.subarray(0, 10))
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    await expect(upload.append(10, bytes.subarray(10, 20))).rejects.toThrow('still being written')
    release()
    await first
  })

  it('reads on from what the store last saved when a write fails, for the slice to be sent again', async () => {
    const { writes, save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    const cut = byteOf('</trkseg><trkseg>') + 3
    await upload.append(0, bytes.subarray(0, cut))
    const saved = upload.status.received
    save.mockRejectedValueOnce(new Error('disk full'))
    await expect(upload.append(cut, bytes.subarray(cut))).rejects.toThrow('disk full')
    const from = upload.status.received
    // Back at the last checkpoint the store holds, which is not past the first slice.
    expect(from).toBeLessThanOrEqual(saved)
    await upload.append(from, bytes.subarray(from))
    expect(upload.status).toMatchObject({ state: 'finished', imported: 4 })
    expect(writes).toHaveLength(2)
  })

  it('fails on a file that is not GPX, keeping what it wrote', async () => {
    const { save } = saving()
    const broken = new TextEncoder().encode(sample.replace('</trk>', ''))
    const upload = new GpxUpload({ ...start(), size: broken.length }, { save, replaced: () => undefined })
    await expect(upload.append(0, broken)).rejects.toBeInstanceOf(UploadFormatError)
    expect(upload.status).toMatchObject({ state: 'failed', imported: 3 })
    await expect(upload.append(broken.length, new Uint8Array(0))).rejects.toThrow('The upload is failed')
  })

  it('ends when aborted', async () => {
    const { save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    await upload.abort()
    expect(upload.status.state).toBe('aborted')
    expect(upload.active).toBe(false)
  })

  it('is idle once nothing has arrived for a while', () => {
    let now = 0
    const upload = new GpxUpload(
      { ...start(), updatedAt: 0 },
      { ...saving(), replaced: () => undefined, now: () => now },
    )
    expect(upload.idle).toBe(false)
    now = 16 * 60_000
    expect(upload.idle).toBe(true)
  })

  it('holds itself for a slice while its body arrives', async () => {
    const { save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    const slice = upload.reserve(0)
    expect(() => upload.reserve(0)).toThrow('still being written')
    await expect(upload.abort()).rejects.toThrow('still being written')
    slice.release()
    await upload.reserve(0).write(bytes)
    expect(upload.status.state).toBe('finished')
  })

  it('is idle once a slice reserved has not arrived for a while', () => {
    let now = 0
    const upload = new GpxUpload(
      { ...start(), updatedAt: 0 },
      { ...saving(), replaced: () => undefined, now: () => now },
    )
    now = 10 * 60_000
    upload.reserve(0)
    now = 20 * 60_000
    expect(upload.idle).toBe(false)
    now = 26 * 60_000
    expect(upload.idle).toBe(true)
  })

  it('writes nothing more once a new upload has taken its place', async () => {
    const { save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    const slice = upload.reserve(0)
    upload.supersede()
    await expect(slice.write(bytes)).rejects.toThrow('Another file is being imported')
    expect(save).not.toHaveBeenCalled()
  })

  it('can no longer be stopped once a new upload has taken its place, unless that one failed to start', async () => {
    const { save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    upload.supersede()
    await expect(upload.abort()).rejects.toThrow('Another file is being imported')
    expect(() => upload.reserve(0)).toThrow('Another file is being imported')
    upload.resume()
    await upload.append(0, bytes)
    expect(upload.status.state).toBe('finished')
  })

  it('has received the whole file once finished, after a restart too', async () => {
    const { save } = saving()
    const upload = new GpxUpload(start(), { save, replaced: () => undefined })
    await upload.append(0, bytes)
    const saved = save.mock.results.at(-1)!.value as Promise<GpxUploadState>
    const restarted = new GpxUpload(await saved, { save, replaced: () => undefined })
    expect(restarted.status).toMatchObject({ state: 'finished', received: bytes.length })
  })

  it('tells after a slice replaced part of the recording', async () => {
    const replaced = vi.fn()
    const upload = new GpxUpload({ ...start(), onOverlap: 'replace' }, { ...saving(), replaced })
    await upload.append(0, bytes)
    expect(replaced).toHaveBeenCalledOnce()
  })
})
