import { Temporal } from '@js-temporal/polyfill'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createHarness, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { HarnessOptions, TestHarness } from './harness.test-utils.js'
import { toImportedTrack } from './importedTracks.js'
import type { TrackApi, TrackImport } from './trackApi.js'
import type { OnOverlap, TrackProvider } from './trackProvider.js'

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

/** Run the history import to its end, as the webapp starts it. */
const importHistory = async (h: TestHarness) => {
  const started = await request(h.app).post('/plugins/tracks/history-import').expect(202)
  const { startedAt } = (started.body as { state: { startedAt: string } }).state
  await vi.waitFor(
    async () => {
      const { body } = await request(h.app).get('/plugins/tracks/history-import')
      expect((body as { state?: { startedAt: string; finishedAt?: string } }).state).toMatchObject({
        startedAt,
        finishedAt: expect.any(String),
      })
    },
    { timeout: 20_000, interval: 50 },
  )
}

// Reads never ask a provider, but the history import brings what it holds
// into the recording, so a delete of the own vessel's track has to keep its
// span where the store held nothing, or an import would fill it back in.
describe('deleting with a history provider installed', () => {
  const history = {
    contexts: [SELF_CONTEXT, OTHER_CONTEXT],
    rows: [0, 1, 2, 3].map((i) => [iso(t0 + i * MINUTE), [24, 60 + i / 100]]),
  }
  const span = { from: instant(t0 + MINUTE), to: instant(t0 + 2 * MINUTE) }

  it('keeps a span of the own vessel the store held nothing of, which an import then leaves out', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        expect(await provider.deleteTrackSpan(`recorded:${SELF_CONTEXT}`, span)).toBe(true)
        const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
        expect(bin.body).toMatchObject([{ trackId: `recorded:${SELF_CONTEXT}`, pointCount: 0 }])
        await importHistory(h)
        expect(await timesOf(provider, SELF_CONTEXT)).toEqual([iso(t0), iso(t0 + 3 * MINUTE)])
      },
      { history },
    ))

  it('lets an import fill the span once the delete is restored', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        await provider.deleteTrackSpan(`recorded:${SELF_CONTEXT}`, span)
        const [entry] = (await request(h.app).get('/plugins/tracks/recycle-bin')).body as { id: number }[]
        await request(h.app).post(`/plugins/tracks/recycle-bin/${entry!.id}/restore`).expect(200)
        await importHistory(h)
        expect(await timesOf(provider, SELF_CONTEXT)).toHaveLength(4)
      },
      { history },
    ))

  it('keeps the span from an import after the entry is purged', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        await provider.deleteTrackSpan(`recorded:${SELF_CONTEXT}`, span)
        const [entry] = (await request(h.app).get('/plugins/tracks/recycle-bin')).body as { id: number }[]
        await request(h.app).delete(`/plugins/tracks/recycle-bin/${entry!.id}`).expect(200)
        expect((await request(h.app).get('/plugins/tracks/recycle-bin')).body).toEqual([])
        await importHistory(h)
        expect(await timesOf(provider, SELF_CONTEXT)).toEqual([iso(t0), iso(t0 + 3 * MINUTE)])
      },
      { history },
    ))

  it('keeps the span while the provider is away, once an import has started', () =>
    withHarness(
      async (h) => {
        await h.store()!.saveHistoryImport!({ context: SELF_CONTEXT, startedAt: Date.now(), filled: 0 }, [])
        expect(await providerOf(h).deleteTrackSpan(`recorded:${SELF_CONTEXT}`, span)).toBe(true)
        const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
        expect(bin.body).toMatchObject([{ trackId: `recorded:${SELF_CONTEXT}`, pointCount: 0 }])
      },
      { history: { noProvider: true } },
    ))

  it('answers false for another vessel only the provider holds, binning nothing', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        expect(await provider.deleteTrackSpan(`recorded:${OTHER_CONTEXT}`, span)).toBe(false)
        expect((await request(h.app).get('/plugins/tracks/recycle-bin')).body).toEqual([])
      },
      { history },
    ))
})

describe('a span that starts after now', () => {
  it('leaves nothing in the bin, even for the own vessel with a history provider installed', () =>
    withHarness(
      async (h) => {
        seedFour(h)
        const provider = providerOf(h)
        const later = Date.now() + 60 * MINUTE
        expect(
          await provider.deleteTrackSpan(`recorded:${SELF_CONTEXT}`, {
            from: instant(later),
            to: instant(later + MINUTE),
          }),
        ).toBe(true)
        expect((await request(h.app).get('/plugins/tracks/recycle-bin')).body).toEqual([])
        expect(await timesOf(provider, SELF_CONTEXT)).toHaveLength(4)
      },
      { history: { contexts: [SELF_CONTEXT], rows: [] } },
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

const importOwn = (h: TestHarness, track: TrackImport, onOverlap: OnOverlap) =>
  (h.trackProvider() as TrackProvider).importTrack(toImportedTrack(track), onOverlap)

describe('an import of the own vessel', () => {
  const ownPassage = (times: number[], context: string = SELF_CONTEXT): TrackImport => ({
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: [times.map((_, i) => [25, 61 + i / 100])] },
    properties: { coordTimes: [times.map(iso)], name: 'Before the plugin', context },
  })

  it('leaves what was recorded alone by default', () =>
    withHarness(async (h) => {
      seedFour(h)
      const provider = providerOf(h)
      const id = await provider.storeTrack(ownPassage([t0 + MINUTE, t0 + 2 * MINUTE - 10_000]))
      expect(id).toBe(`recorded:${SELF_CONTEXT}`)
      expect(await timesOf(provider, SELF_CONTEXT)).toEqual([0, 1, 2, 3].map((i) => iso(t0 + i * MINUTE)))
      const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
      expect(bin.body).toEqual([])
    }))

  it('fills only a stretch of at least five minutes with nothing recorded', () =>
    withHarness(async (h) => {
      const recorded = [0, 1, 2, 3, 20, 23].map((i) => t0 + i * MINUTE)
      h.seedTrack(
        SELF_CONTEXT,
        recorded.map((_, i): [number, number] => [60 + i / 100, 24]),
        recorded,
      )
      const provider = providerOf(h)
      // 3 recorded, 16 in the 17-minute gap, and 2 in the 3-minute one.
      const times = [...Array.from({ length: 19 }, (_, i) => t0 + (i + 1) * MINUTE), t0 + 21 * MINUTE, t0 + 22 * MINUTE]
      const kept = await importOwn(h, ownPassage(times), 'keep')
      expect(kept).toEqual({ id: `recorded:${SELF_CONTEXT}`, overlapping: 5, expired: 0 })
      expect(await timesOf(provider, SELF_CONTEXT)).toEqual(
        [...Array.from({ length: 20 }, (_, i) => t0 + i * MINUTE), t0 + 20 * MINUTE, t0 + 23 * MINUTE].map(iso),
      )
    }))

  // TimeZero's exports repeat a few points across block seams.
  it('writes points that two of its segments share only once', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const times = [0, 1, 2, 3].map((i) => t0 + i * MINUTE)
      const coordinates = times.map((_, i): [number, number] => [25, 61 + i / 100])
      const seams: TrackImport = {
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: [coordinates.slice(0, 3), coordinates.slice(1)] },
        properties: { coordTimes: [times.slice(0, 3).map(iso), times.slice(1).map(iso)], context: SELF_CONTEXT },
      }
      expect(await importOwn(h, seams, 'keep')).toEqual({ id: `recorded:${SELF_CONTEXT}`, overlapping: 2, expired: 0 })
      expect(await timesOf(provider, SELF_CONTEXT)).toEqual(times.map(iso))
    }))

  it('replaces what was recorded over its time when asked, binned so it can be restored', () =>
    withHarness(async (h) => {
      seedFour(h)
      const provider = providerOf(h)
      const { id } = await importOwn(h, ownPassage([t0 + MINUTE, t0 + 2 * MINUTE - 10_000]), 'replace')
      expect(id).toBe(`recorded:${SELF_CONTEXT}`)
      expect(await timesOf(provider, SELF_CONTEXT)).toEqual([
        iso(t0),
        iso(t0 + MINUTE),
        iso(t0 + 2 * MINUTE - 10_000),
        iso(t0 + 2 * MINUTE),
        iso(t0 + 3 * MINUTE),
      ])
      const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
      expect(bin.body).toEqual([expect.objectContaining({ trackId: id, kind: 'recorded', pointCount: 1 })])
      const imports = await request(h.app).get('/plugins/tracks/imports').expect(200)
      expect(imports.body).toEqual([])
    }))

  it('fills a stretch nothing recorded and accepts the self alias', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const id = await provider.storeTrack(ownPassage([t0, t0 + MINUTE], 'vessels.self'))
      expect(id).toBe(`recorded:${SELF_CONTEXT}`)
      expect(await timesOf(provider, SELF_CONTEXT)).toEqual([iso(t0), iso(t0 + MINUTE)])
      const bin = await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)
      expect(bin.body).toEqual([])
    }))

  it('keeps an untimed track of the own vessel as an import', () =>
    withHarness(async (h) => {
      const provider = providerOf(h)
      const untimed = ownPassage([t0, t0 + MINUTE])
      delete untimed.properties.coordTimes
      expect(await provider.storeTrack(untimed)).toMatch(/^imported:/)
    }))
})

describe('an import of the own vessel with a history provider installed', () => {
  it('fills a gap the provider holds positions in, asking it nothing', () => {
    let asked = 0
    return withHarness(
      async (h) => {
        const provider = providerOf(h)
        const times = [5, 10, 15].map((minutes) => t0 + minutes * MINUTE)
        await importOwn(
          h,
          {
            type: 'Feature',
            geometry: {
              type: 'MultiLineString',
              coordinates: [
                [
                  [25, 61],
                  [25, 61.01],
                  [25, 61.02],
                ],
              ],
            },
            properties: { coordTimes: [times.map(iso)], context: SELF_CONTEXT },
          },
          'keep',
        )
        expect(await timesOf(provider, SELF_CONTEXT)).toEqual(times.map(iso))
        expect(asked).toBe(0)
      },
      {
        history: {
          contexts: [SELF_CONTEXT],
          rows: [[iso(t0 + 10 * MINUTE), [24, 60]]],
          onValues: () => {
            asked++
          },
          onHistoryApi: () => {
            asked++
          },
        },
      },
    )
  })

  // A replace keeps the span it took over in the bin even where nothing was
  // recorded, as a delete does, so a history import does not draw the old
  // passage between the imported points.
  it('leaves the span it replaced out of a history import', () =>
    withHarness(
      async (h) => {
        const provider = providerOf(h)
        await importOwn(
          h,
          {
            type: 'Feature',
            geometry: {
              type: 'MultiLineString',
              coordinates: [
                [
                  [25, 61],
                  [25, 61.01],
                ],
              ],
            },
            properties: {
              coordTimes: [[iso(t0 + MINUTE), iso(t0 + 21 * MINUTE)]],
              context: SELF_CONTEXT,
            },
          },
          'replace',
        )
        await importHistory(h)
        expect(await timesOf(provider, SELF_CONTEXT)).toEqual([
          iso(t0 + MINUTE),
          iso(t0 + 21 * MINUTE),
          iso(t0 + 40 * MINUTE),
        ])
      },
      {
        history: {
          contexts: [SELF_CONTEXT],
          rows: [11, 40].map((minutes) => [iso(t0 + minutes * MINUTE), [24, 60]]),
        },
      },
    ))
})
