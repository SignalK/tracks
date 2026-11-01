import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createHarness, SELF_CONTEXT } from './harness.test-utils.js'
import type { TestHarness } from './harness.test-utils.js'
import type { GpxUploadStatus } from './types.js'

const UPLOAD = '/plugins/tracks/imports/upload'
const t0 = Date.UTC(2025, 6, 1, 12)
const iso = (ms: number) => new Date(ms).toISOString()

const trkpt = (i: number, time: number) =>
  `<trkpt lat="${(60 + i / 1000).toFixed(3)}" lon="24"><time>${iso(time)}</time></trkpt>`

/** The own track, a second apart, beside an AIS target's at the same time. */
const own = Array.from({ length: 120 }, (_, i) => t0 + i * 1000)
const file = Buffer.from(
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">',
    `<trk><name>Own Ship</name><trkseg>${own.map((time, i) => trkpt(i, time)).join('\n')}</trkseg></trk>`,
    `<trk><name>AIS Ariadne</name><trkseg>${own.map((time, i) => trkpt(-i, time)).join('\n')}</trkseg></trk>`,
    '</gpx>',
  ].join('\n'),
)

// Every position kept, so a test can tell which ones the upload wrote.
const withHarness = async (run: (h: TestHarness) => Promise<void>) => {
  const h = createHarness({ config: { storageTolerance: 0 } })
  try {
    await run(h)
  } finally {
    await h.stop()
  }
}

const start = (h: TestHarness, body: Record<string, unknown> = {}) =>
  request(h.app)
    .post(UPLOAD)
    .send({ filename: 'export.gpx', size: file.length, tracks: ['Own Ship'], ...body })

const slice = (h: TestHarness, id: string, offset: number, bytes: Buffer) =>
  request(h.app).put(`${UPLOAD}/${id}?offset=${offset}`).set('Content-Type', 'application/octet-stream').send(bytes)

/** Send the file from `offset` on in slices of `size`, resolving to the last answer. */
async function sendFrom(h: TestHarness, id: string, offset: number, size: number) {
  let status: GpxUploadStatus | undefined
  for (let at = offset; at < file.length; at += size) {
    const response = await slice(h, id, at, file.subarray(at, at + size)).expect(200)
    status = response.body.upload as GpxUploadStatus
  }
  return status!
}

const storedTimes = async (h: TestHarness) =>
  (
    (await h.store()!.getFilteredTimedTracks({ bbox: null, radius: null, intersects: true, contexts: [SELF_CONTEXT] }))[
      SELF_CONTEXT
    ] ?? []
  ).map(({ timestamp }) => timestamp)

describe('uploading a GPX file in slices', () => {
  it("writes the chosen tracks into the own vessel's recording, a slice at a time", async () => {
    await withHarness(async (h) => {
      const started = await start(h).expect(201)
      const { id } = started.body.upload as GpxUploadStatus
      expect(started.body.upload).toMatchObject({ received: 0, state: 'receiving', size: file.length })
      const done = await sendFrom(h, id, 0, 1000)
      expect(done).toMatchObject({ state: 'finished', received: file.length, imported: 120, overlapping: 0 })
      expect(await storedTimes(h)).toEqual(own)
      expect((await request(h.app).get(UPLOAD).expect(200)).body.upload).toEqual(done)
    })
  })

  it('goes on after a restart from where the store last saved it', async () => {
    await withHarness(async (h) => {
      const { id } = (await start(h).expect(201)).body.upload as GpxUploadStatus
      for (let at = 0; at < 4000; at += 1000) {
        await slice(h, id, at, file.subarray(at, at + 1000)).expect(200)
      }
      await h.stop()
      h.restart()
      const resumed = (await request(h.app).get(UPLOAD).expect(200)).body.upload as GpxUploadStatus
      expect(resumed).toMatchObject({ id, state: 'receiving' })
      expect(resumed.received).toBeGreaterThan(3000)
      expect(resumed.received).toBeLessThanOrEqual(4000)
      await slice(h, id, 4000, file.subarray(4000, 5000)).expect(409)
      expect(await sendFrom(h, id, resumed.received, 777)).toMatchObject({ state: 'finished', imported: 120 })
      expect(await storedTimes(h)).toEqual(own)
    })
  })

  it('fills only where the recording has nothing, by default', async () => {
    await withHarness(async (h) => {
      // Recorded over the upload's first minute, and on for ten more.
      const recorded = Array.from({ length: 11 * 60 }, (_, i) => t0 + i * 1000)
      h.seedTrack(
        SELF_CONTEXT,
        recorded.map(() => [59, 23]),
        recorded,
      )
      await storedTimes(h)
      const { id } = (await start(h).expect(201)).body.upload as GpxUploadStatus
      expect(await sendFrom(h, id, 0, 1000)).toMatchObject({ imported: 0, overlapping: 120 })
      expect(await storedTimes(h)).toEqual(recorded)
    })
  })

  it('replaces what was recorded over each segment, in one recycle bin entry however many slices it takes', async () => {
    await withHarness(async (h) => {
      const recorded = Array.from({ length: 120 }, (_, i) => t0 + i * 1000 + 500)
      h.seedTrack(
        SELF_CONTEXT,
        recorded.map(() => [59, 23]),
        recorded,
      )
      await storedTimes(h)
      const { id } = (await start(h, { onOverlap: 'replace' }).expect(201)).body.upload as GpxUploadStatus
      expect(await sendFrom(h, id, 0, 500)).toMatchObject({ state: 'finished', imported: 120 })
      // The last recorded point lies after the segment's last: it stays.
      expect(await storedTimes(h)).toEqual([...own, recorded.at(-1)])
      const bin = (await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)).body as {
        from: string
        to: string
        pointCount: number
      }[]
      expect(bin).toEqual([expect.objectContaining({ from: iso(own[0]!), to: iso(own.at(-1)!), pointCount: 119 })])
    })
  })

  it('takes one upload at a time, and a new one once that has ended', async () => {
    await withHarness(async (h) => {
      const { id } = (await start(h).expect(201)).body.upload as GpxUploadStatus
      const refused = await start(h).expect(409)
      expect(refused.body.upload).toMatchObject({ id })
      const aborted = await request(h.app).delete(`${UPLOAD}/${id}`).expect(200)
      expect(aborted.body.upload).toMatchObject({ state: 'aborted' })
      await start(h).expect(201)
      await request(h.app).delete(`${UPLOAD}/${id}`).expect(404)
    })
  })

  it('answers where to go on when a slice is out of step', async () => {
    await withHarness(async (h) => {
      const { id } = (await start(h).expect(201)).body.upload as GpxUploadStatus
      await slice(h, id, 0, file.subarray(0, 100)).expect(200)
      const response = await slice(h, id, 0, file.subarray(0, 100)).expect(409)
      expect(response.body).toMatchObject({
        message: 'The next slice starts at byte 100, not 0',
        upload: { received: 100 },
      })
    })
  })

  it('refuses a request it cannot take', async () => {
    await withHarness(async (h) => {
      await start(h, { size: 0 }).expect(400)
      await start(h, { tracks: [] }).expect(400)
      await start(h, { onOverlap: 'merge' }).expect(400)
      await slice(h, 'nope', 0, file.subarray(0, 10)).expect(404)
      const { id } = (await start(h).expect(201)).body.upload as GpxUploadStatus
      await request(h.app).put(`${UPLOAD}/${id}`).send(file.subarray(0, 10)).expect(400)
      await slice(h, id, 0, Buffer.alloc(0)).expect(400)
    })
  })

  it('stops at a file that is not GPX', async () => {
    await withHarness(async (h) => {
      const text = Buffer.from('<gpx><trk></gpx>')
      const { id } = (await start(h, { size: text.length }).expect(201)).body.upload as GpxUploadStatus
      const response = await slice(h, id, 0, text).expect(422)
      expect(response.body).toMatchObject({
        message: expect.stringMatching(/not well-formed/),
        upload: { state: 'failed' },
      })
    })
  })
})
