import { Temporal } from '@js-temporal/polyfill'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createHarness, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { HarnessOptions, TestHarness } from './harness.test-utils.js'
import type { TrackApi, TrackImport } from './trackApi.js'

const MINUTE = 60_000
const t0 = Date.now() - 60 * MINUTE
const iso = (ms: number) => new Date(ms).toISOString()
const instant = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms)
const lastHours = { from: instant(t0 - 60 * MINUTE), to: instant(Date.now() + 60 * MINUTE) }

const providerOf = (h: TestHarness): Required<TrackApi> => {
  const provider = h.trackProvider()
  if (!provider?.deleteTrackSpan || !provider.deleteTrack || !provider.getTrack || !provider.storeTrack) {
    throw new Error('plugin registered no provider that deletes tracks')
  }
  return provider as Required<TrackApi>
}

/** Four fixes a minute apart, from t0. */
const seedFour = (h: TestHarness, context = SELF_CONTEXT) =>
  h.seedTrack(
    context,
    [
      [60, 24],
      [60.01, 24],
      [60.02, 24],
      [60.03, 24],
    ],
    [t0, t0 + MINUTE, t0 + 2 * MINUTE, t0 + 3 * MINUTE],
  )

const timesOf = async (provider: TrackApi, context: string) => {
  const { features } = await provider.getTracks({ ...lastHours, contexts: [context], times: true })
  return features.flatMap(({ properties }) => (properties.coordTimes ?? []).flat())
}

const withHarness = async (run: (h: TestHarness) => Promise<void>, options?: HarnessOptions) => {
  const h = createHarness(options)
  try {
    await run(h)
  } finally {
    await h.stop()
  }
}

const passage = (timed = true): TrackImport => ({
  type: 'Feature',
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [24.9, 60.1],
        [25.0, 60.2],
      ],
    ],
  },
  properties: {
    ...(timed ? { coordTimes: [[iso(t0), iso(t0 + MINUTE)]] } : {}),
    name: 'Race day',
    context: OTHER_CONTEXT,
  },
})

describe('deleting recorded tracks', () => {
  it('gives each recorded track an id that fetches it whole', () =>
    withHarness(async (h) => {
      seedFour(h)
      const provider = providerOf(h)
      const { features } = await provider.getTracks({ ...lastHours, contexts: [SELF_CONTEXT] })
      const id = features[0]!.properties.id!
      expect(id).toBe(`recorded:${SELF_CONTEXT}`)
      const feature = await provider.getTrack(id)
      expect(feature?.properties).toMatchObject({ id, context: SELF_CONTEXT, isSelf: true, pointCount: 4 })
      expect(feature?.properties.coordTimes?.flat()).toHaveLength(4)
    }))

  it('deletes part of a track and keeps the rest', () =>
    withHarness(async (h) => {
      seedFour(h)
      const provider = providerOf(h)
      const id = `recorded:${SELF_CONTEXT}`
      expect(await provider.deleteTrackSpan(id, { from: instant(t0 + MINUTE), to: instant(t0 + 2 * MINUTE) })).toBe(
        true,
      )
      expect(await timesOf(provider, SELF_CONTEXT)).toEqual([iso(t0), iso(t0 + 3 * MINUTE)])
    }))

  it('deletes a whole track up to now, and records on afterwards', () =>
    withHarness(async (h) => {
      seedFour(h)
      const provider = providerOf(h)
      expect(await provider.deleteTrack(`recorded:${SELF_CONTEXT}`)).toBe(true)
      expect((await provider.getTracks({ ...lastHours, contexts: [SELF_CONTEXT] })).features).toEqual([])
      await request(h.app).get('/signalk/v1/api/vessels/self/track').expect(404)
      h.emit(SELF_CONTEXT, [61, 25], Date.now() + 1000)
      await expect.poll(() => timesOf(provider, SELF_CONTEXT)).toHaveLength(1)
    }))

  it('answers false for a vessel nobody has a track of', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      expect(await provider.deleteTrack(`recorded:${OTHER_CONTEXT}`)).toBe(false)
      expect(await provider.deleteTrackSpan(`recorded:${OTHER_CONTEXT}`, { to: instant(t0) })).toBe(false)
      const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
      expect(bin.body).toEqual([])
    }))

  it('accepts a span with nothing in it on a vessel it knows', () =>
    withHarness(async (h) => {
      seedFour(h)
      const provider = providerOf(h)
      expect(await provider.deleteTrackSpan(`recorded:${SELF_CONTEXT}`, { to: instant(t0 - MINUTE) })).toBe(true)
      expect(await timesOf(provider, SELF_CONTEXT)).toHaveLength(4)
    }))

  it('resolves the self alias', () =>
    withHarness(async (h) => {
      seedFour(h)
      const provider = providerOf(h)
      expect(await provider.deleteTrack('recorded:vessels.self')).toBe(true)
      expect(await timesOf(provider, SELF_CONTEXT)).toEqual([])
    }))
})

describe('deleting with a history provider installed', () => {
  // History is not deletable through the History API, so a deleted span has
  // to stay hidden from it, or the next query fills it back in.
  const history = {
    contexts: [OTHER_CONTEXT],
    rows: [0, 1, 2, 3].map((i) => [iso(t0 + i * MINUTE), [24, 60 + i / 100]]),
  }

  it('hides the deleted span of history from v2 and v1', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        const id = `recorded:${OTHER_CONTEXT}`
        expect(await timesOf(provider, OTHER_CONTEXT)).toHaveLength(4)
        // History alone knows the vessel, and that is enough to delete from it.
        expect(await provider.deleteTrackSpan(id, { from: instant(t0 + MINUTE), to: instant(t0 + 2 * MINUTE) })).toBe(
          true,
        )
        expect(await timesOf(provider, OTHER_CONTEXT)).toEqual([iso(t0), iso(t0 + 3 * MINUTE)])
        const v1 = await request(h.app)
          .get(`/signalk/v1/api/vessels/urn:mrn:imo:mmsi:987654321/track?from=${iso(t0 - MINUTE)}&times=true`)
          .expect(200)
        expect((v1.body as { times: string[][] }).times.flat()).toEqual([iso(t0), iso(t0 + 3 * MINUTE)])
      },
      { history },
    ))

  it('shows history again once the delete is restored', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        await provider.deleteTrack(`recorded:${OTHER_CONTEXT}`)
        expect(await timesOf(provider, OTHER_CONTEXT)).toEqual([])
        const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
        const [entry] = bin.body as { id: number; trackId: string; kind: string; pointCount: number }[]
        expect(entry).toMatchObject({ trackId: `recorded:${OTHER_CONTEXT}`, kind: 'recorded', pointCount: 0 })
        await request(h.app).post(`/plugins/tracks/recycle-bin/${entry!.id}/restore`).expect(200)
        expect(await timesOf(provider, OTHER_CONTEXT)).toHaveLength(4)
      },
      { history },
    ))

  it('keeps history hidden after the entry is purged', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        await provider.deleteTrack(`recorded:${OTHER_CONTEXT}`)
        const bin = await request(h.app).get('/plugins/tracks/recycle-bin')
        const [entry] = bin.body as { id: number }[]
        await request(h.app).delete(`/plugins/tracks/recycle-bin/${entry!.id}`).expect(200)
        expect((await request(h.app).get('/plugins/tracks/recycle-bin')).body).toEqual([])
        expect(await timesOf(provider, OTHER_CONTEXT)).toEqual([])
        await request(h.app).post(`/plugins/tracks/recycle-bin/${entry!.id}/restore`).expect(404)
      },
      { history },
    ))
})

describe('a span that starts after now', () => {
  it('leaves nothing in the bin, even for a vessel history knows', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        const later = Date.now() + 60 * MINUTE
        expect(
          await provider.deleteTrackSpan(`recorded:${OTHER_CONTEXT}`, {
            from: instant(later),
            to: instant(later + MINUTE),
          }),
        ).toBe(true)
        expect((await request(h.app).get('/plugins/tracks/recycle-bin')).body).toEqual([])
        expect(await timesOf(provider, OTHER_CONTEXT)).toHaveLength(4)
      },
      {
        history: {
          contexts: [OTHER_CONTEXT],
          rows: [0, 1, 2, 3].map((i) => [iso(t0 + i * MINUTE), [24, 60 + i / 100]]),
        },
      },
    ))
})

describe('deleting imported tracks', () => {
  it('moves a whole import to the bin and restores it', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage())
      expect(await provider.deleteTrack(id)).toBe(true)
      expect(await provider.getTrack(id)).toBeUndefined()
      expect(await provider.deleteTrack(id)).toBe(false)
      const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
      expect(bin.body).toMatchObject([
        { trackId: id, kind: 'imported', name: 'Race day', context: OTHER_CONTEXT, whole: true, pointCount: 2 },
      ])
      const [entry] = bin.body as { id: number }[]
      await request(h.app).post(`/plugins/tracks/recycle-bin/${entry!.id}/restore`).expect(200)
      expect((await provider.getTrack(id))?.properties.pointCount).toBe(2)
    }))

  it('deletes a span of a timed import', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage())
      expect(await provider.deleteTrackSpan(id, { from: instant(t0 + MINUTE) })).toBe(true)
      expect((await provider.getTrack(id))?.properties.coordTimes).toEqual([[iso(t0)]])
    }))

  // The track exists, so the delete succeeded; it just had nothing to move.
  it('answers true for a span with none of an import’s points, binning nothing', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage())
      expect(await provider.deleteTrackSpan(id, { from: instant(t0 + 10 * MINUTE) })).toBe(true)
      expect((await request(h.app).get('/plugins/tracks/recycle-bin')).body).toEqual([])
    }))

  it('refuses a span of an import without times as the client’s error', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage(false))
      await expect(provider.deleteTrackSpan(id, { from: instant(t0) })).rejects.toMatchObject({
        isTrackRejected: true,
      })
      expect(await provider.deleteTrackSpan('imported:missing', { from: instant(t0) })).toBe(false)
    }))

  it('will not restore a span while its whole track is in the bin', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const id = await provider.storeTrack(passage())
      await provider.deleteTrackSpan(id, { from: instant(t0 + MINUTE) })
      await provider.deleteTrack(id)
      const bin = (await request(h.app).get('/plugins/tracks/recycle-bin')).body as { id: number; whole: boolean }[]
      const span = bin.find(({ whole }) => !whole)!
      await request(h.app).post(`/plugins/tracks/recycle-bin/${span.id}/restore`).expect(409)
    }))
})

describe('recycle bin routes', () => {
  it('rejects an id that is not one, and reports an unknown one', () =>
    withHarness(async (h) => {
      await request(h.app).post('/plugins/tracks/recycle-bin/abc/restore').expect(400)
      await request(h.app).delete('/plugins/tracks/recycle-bin/0').expect(400)
      await request(h.app).post('/plugins/tracks/recycle-bin/42/restore').expect(404)
      await request(h.app).delete('/plugins/tracks/recycle-bin/42').expect(404)
    }))

  it('says when an entry will be purged', () =>
    withHarness(
      async (h) => {
        seedFour(h)
        await providerOf(h).deleteTrack(`recorded:${SELF_CONTEXT}`)
        const [entry] = (await request(h.app).get('/plugins/tracks/recycle-bin')).body as {
          deletedAt: string
          purgeAt: string
          isSelf: boolean
        }[]
        expect(Date.parse(entry!.purgeAt) - Date.parse(entry!.deletedAt)).toBe(7 * 24 * 60 * MINUTE)
        expect(entry!.isSelf).toBe(true)
      },
      { config: { recycleBinDays: 7 } },
    ))
})
