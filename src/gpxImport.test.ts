import { Readable } from 'node:stream'
import { Temporal } from '@js-temporal/polyfill'
import type { Request } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { GpxTrack } from './gpx.js'
import { createHarness, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { TestHarness } from './harness.test-utils.js'
import { fromGpxTrack } from './importedTracks.js'
import { TrackRejectedError } from './trackApi.js'
import { readText, UploadTooLargeError } from './upload.js'

const t0 = Date.UTC(2025, 6, 1, 12)
const MINUTE = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

const gpxTrack = (times: (number | undefined)[], context?: string): GpxTrack => ({
  name: 'Passage',
  ...(context === undefined ? {} : { context }),
  // fromGpx dates a point without <time> to 0.
  segments: [times.map((t, i) => ({ position: [60 + i / 100, 24], timestamp: t ?? 0 }))],
})

describe('a GPX track as an import', () => {
  it('keeps a timed track with its name and the file’s vessel', () => {
    const { track, skippedPoints } = fromGpxTrack(
      gpxTrack([t0, t0 + MINUTE], OTHER_CONTEXT),
      OTHER_CONTEXT,
      'imported:a',
    )
    expect(track).toEqual({
      id: 'imported:a',
      context: OTHER_CONTEXT,
      name: 'Passage',
      metadata: {},
      segments: [
        [
          { position: [60, 24], timestamp: t0 },
          { position: [60.01, 24], timestamp: t0 + MINUTE },
        ],
      ],
    })
    expect(skippedPoints).toBe(0)
  })

  it('keeps an untimed track untimed when it names a vessel', () => {
    const { track } = fromGpxTrack(gpxTrack([undefined, undefined]), SELF_CONTEXT)
    expect(track.segments).toEqual([[{ position: [60, 24] }, { position: [60.01, 24] }]])
    expect(track.context).toBe(SELF_CONTEXT)
  })

  // An import is timed throughout or not at all.
  it('leaves out the points without a time from a timed track, and counts them', () => {
    const { track, skippedPoints } = fromGpxTrack(gpxTrack([t0, undefined, t0 + MINUTE]))
    expect(track.segments[0]!.map(({ timestamp }) => timestamp)).toEqual([t0, t0 + MINUTE])
    expect(skippedPoints).toBe(1)
  })

  it('refuses a track with neither times nor a vessel', () => {
    expect(() => fromGpxTrack(gpxTrack([undefined]))).toThrow(TrackRejectedError)
  })
})

describe('reading an upload', () => {
  const fakeRequest = (text: string, body?: unknown, headers: Record<string, string> = {}) =>
    Object.assign(Readable.from([Buffer.from(text)]), { body, headers }) as unknown as Request

  it('reads the body as text', async () => {
    expect(await readText(fakeRequest('<gpx/>'))).toBe('<gpx/>')
  })

  it('refuses a body past the limit', async () => {
    await expect(readText(fakeRequest('x'.repeat(11)), 10)).rejects.toBeInstanceOf(UploadTooLargeError)
  })

  it('refuses a body declared past the limit without reading it', async () => {
    await expect(readText(fakeRequest('', undefined, { 'content-length': '11' }), 10)).rejects.toBeInstanceOf(
      UploadTooLargeError,
    )
  })

  it('takes a body already read as text', async () => {
    expect(await readText(fakeRequest('', '<gpx/>'))).toBe('<gpx/>')
  })
})

const gpxFile = (tracks: string) =>
  `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${tracks}</gpx>`
const trk = (name: string, times: (number | undefined)[]) =>
  `<trk><name>${name}</name><trkseg>${times
    .map((t, i) => `<trkpt lat="${60 + i / 100}" lon="24">${t === undefined ? '' : `<time>${iso(t)}</time>`}</trkpt>`)
    .join('')}</trkseg></trk>`

const withHarness = async (run: (h: TestHarness) => Promise<void>) => {
  const h = createHarness()
  try {
    await run(h)
  } finally {
    await h.stop()
  }
}

const upload = (h: TestHarness, body: string, query = '') =>
  request(h.app).post(`/plugins/tracks/imports${query}`).set('Content-Type', 'application/gpx+xml').send(body)

/** An id as the routes give it, less the provider prefix the server adds to v2 ids. */
const local = (id: string) => id.replace(/^tracks:/, '')

const listed = async (h: TestHarness) => {
  const { features } = await h.trackProvider()!.getTracks({
    from: Temporal.Instant.fromEpochMilliseconds(t0 - MINUTE),
    to: Temporal.Instant.fromEpochMilliseconds(t0 + 10 * MINUTE),
  })
  return features.map(({ properties }) => properties)
}

describe('the GPX upload route', () => {
  it('stores every track in the file as an import', () =>
    withHarness(async (h) => {
      const res = await upload(h, gpxFile(trk('Morning', [t0, t0 + MINUTE]) + trk('Evening', [t0 + 5 * MINUTE])))
      expect(res.status).toBe(201)
      const { ids, skippedPoints } = res.body as { ids: string[]; skippedPoints: number }
      expect(ids).toHaveLength(2)
      expect(ids[0]).toMatch(/^tracks:imported:/)
      expect(skippedPoints).toBe(0)
      expect((await listed(h)).map(({ id, name }) => [id, name])).toEqual(
        expect.arrayContaining([
          [local(ids[0]!), 'Morning'],
          [local(ids[1]!), 'Evening'],
        ]),
      )
    }))

  it('names the own vessel when asked to', () =>
    withHarness(async (h) => {
      const res = await upload(h, gpxFile(trk('Morning', [t0, t0 + MINUTE])), '?self=true')
      expect(res.status).toBe(201)
      const [properties] = await listed(h)
      expect(properties).toMatchObject({ context: SELF_CONTEXT, isSelf: true, name: 'Morning' })
    }))

  it('stores an untimed track for the own vessel', () =>
    withHarness(async (h) => {
      const res = await upload(h, gpxFile(trk('Plan', [undefined, undefined])), '?self=true')
      expect(res.status).toBe(201)
      const [id] = (res.body as { ids: string[] }).ids
      expect((await h.trackProvider()!.getTrack!(local(id!)))?.properties).toMatchObject({
        name: 'Plan',
        pointCount: 2,
      })
    }))

  it('stores nothing from a file with one track it cannot keep', () =>
    withHarness(async (h) => {
      const res = await upload(h, gpxFile(trk('Fine', [t0]) + trk('Untimed', [undefined])))
      expect(res.status).toBe(400)
      expect((res.body as { message: string }).message).toContain('Untimed')
      expect(await listed(h)).toEqual([])
    }))

  it('refuses a file that holds no track', () =>
    withHarness(async (h) => {
      expect((await upload(h, 'not gpx at all')).status).toBe(400)
      expect((await upload(h, gpxFile(''))).status).toBe(400)
    }))
})

describe('the import listing route', () => {
  // Whatever its time span: an old passage or an untimed track is still listed.
  it('lists every import as the webapp shows a track', () =>
    withHarness(async (h) => {
      const old = Date.UTC(2019, 5, 1)
      const timed = await upload(h, gpxFile(trk('Passage 2019', [old, old + MINUTE])), '?self=true')
      const untimed = await upload(h, gpxFile(trk('Plan', [undefined, undefined, undefined])), '?self=true')
      const res = await request(h.app).get('/plugins/tracks/imports').expect(200)
      expect(res.body).toEqual(
        expect.arrayContaining([
          {
            id: (timed.body as { ids: string[] }).ids[0],
            providerId: 'tracks',
            name: 'Passage 2019',
            context: SELF_CONTEXT,
            isSelf: true,
            from: iso(old),
            to: iso(old + MINUTE),
            pointCount: 2,
          },
          {
            id: (untimed.body as { ids: string[] }).ids[0],
            providerId: 'tracks',
            name: 'Plan',
            context: SELF_CONTEXT,
            isSelf: true,
            pointCount: 3,
          },
        ]),
      )
      expect(res.body).toHaveLength(2)
    }))
})
