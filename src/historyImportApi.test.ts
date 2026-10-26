import { Temporal } from '@js-temporal/polyfill'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness, SELF_CONTEXT } from './harness.test-utils.js'
import type { HarnessOptions, TestHarness } from './harness.test-utils.js'
import { DAY_MS, startOfDay } from './historyImport.js'
import type { TrackApi } from './trackApi.js'

const HOUR = 60 * 60_000
const iso = (ms: number) => new Date(ms).toISOString()
// Two hours a second apart, three days ago: before the store recorded anything.
const from = startOfDay(Date.now()) - 3 * DAY_MS + 10 * HOUR
const rows = Array.from({ length: 7200 }, (_, i) => [iso(from + i * 1000), [24 + i * 1e-5, 60]])
const history = { rows, aggregatesFirst: true }

const withHarness = async (run: (h: TestHarness) => Promise<void>, options?: HarnessOptions) => {
  const h = createHarness(options)
  try {
    await run(h)
  } finally {
    await h.stop()
  }
}

const importState = async (h: TestHarness) => {
  const response = await request(h.app).get('/plugins/tracks/history-import')
  expect(response.status).toBe(200)
  return response.body as { provider: boolean; state?: Record<string, unknown> }
}

const finished = async (h: TestHarness) => {
  await vi.waitFor(
    async () => {
      expect((await importState(h)).state?.finishedAt).toBeDefined()
    },
    { timeout: 20_000, interval: 50 },
  )
  return (await importState(h)).state!
}

/** What the store recorded for the own vessel, none for a vessel it never saw. */
const storedTimes = async (h: TestHarness) =>
  (
    (await h.store()!.getFilteredTimedTracks({ bbox: null, radius: null, intersects: true, contexts: [SELF_CONTEXT] }))[
      SELF_CONTEXT
    ] ?? []
  ).map(({ timestamp }) => timestamp)

describe('the history import route', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the own vessel from history into the recording, and says how far it got', async () => {
    await withHarness(
      async (h) => {
        expect(await importState(h)).toEqual({ provider: true })
        const started = await request(h.app).post('/plugins/tracks/history-import')
        expect(started.status).toBe(202)
        expect(started.body.state).toMatchObject({ running: true, filled: 0 })
        const state = await finished(h)
        expect(state).toMatchObject({ running: false, filled: 7200 })
        expect(state.error).toBeUndefined()
        expect(Date.parse(String(state.firstDay))).toBeLessThanOrEqual(from)
        expect(await storedTimes(h)).toEqual(rows.map(([time]) => Date.parse(String(time))))
      },
      { history },
    )
  })

  it('reads a provider that stamps its buckets on their end', async () => {
    await withHarness(
      async (h) => {
        await request(h.app).post('/plugins/tracks/history-import')
        // The bucket where history begins ends after the import started.
        expect((await finished(h)).filled).toBeGreaterThanOrEqual(7199)
      },
      { history: { ...history, stampsAtEnd: true } },
    )
  })

  it('starts where history does, past a row without a usable time', async () => {
    await withHarness(
      async (h) => {
        await request(h.app).post('/plugins/tracks/history-import')
        const state = await finished(h)
        expect(state.filled).toBe(7200)
        expect(Date.parse(String(state.firstDay))).toBeGreaterThan(from - 30 * DAY_MS)
      },
      { history: { ...history, rows: [['not a time', [24, 60]], ...rows] } },
    )
  })

  it('fills nothing more when started again', async () => {
    await withHarness(
      async (h) => {
        await request(h.app).post('/plugins/tracks/history-import')
        await finished(h)
        const again = await request(h.app).post('/plugins/tracks/history-import')
        expect(again.status).toBe(202)
        await vi.waitFor(
          async () => {
            const { state } = await importState(h)
            expect(state?.finishedAt).toBeDefined()
            expect(state?.startedAt).toBe(again.body.state.startedAt)
          },
          { timeout: 20_000, interval: 50 },
        )
        expect((await importState(h)).state?.filled).toBe(0)
        expect(await storedTimes(h)).toHaveLength(7200)
      },
      { history },
    )
  })

  it('refuses a second start while one runs', async () => {
    await withHarness(
      async (h) => {
        const [first, second] = await Promise.all([
          request(h.app).post('/plugins/tracks/history-import'),
          request(h.app).post('/plugins/tracks/history-import'),
        ])
        expect([first.status, second.status].sort()).toEqual([202, 409])
        await finished(h)
      },
      { history: { ...history, valuesDelayMs: 20 } },
    )
  })

  it('reports why it stopped when the store could not save that either', async () => {
    await withHarness(
      async (h) => {
        const store = h.store()!
        const save = store.saveHistoryImport!.bind(store)
        let broken = false
        vi.spyOn(store, 'saveHistoryImport').mockImplementation((state, runs, since) => {
          broken ||= runs.some((run) => run.length > 0)
          return broken ? Promise.reject(new Error('database or disk is full')) : save(state, runs, since)
        })
        await request(h.app).post('/plugins/tracks/history-import')
        await vi.waitFor(
          async () => {
            expect((await importState(h)).state).toMatchObject({ running: false, error: 'database or disk is full' })
          },
          { timeout: 20_000, interval: 50 },
        )
      },
      { history },
    )
  })

  it('offers nothing to import from without a history provider', async () => {
    await withHarness(
      async (h) => {
        expect(await importState(h)).toEqual({ provider: false })
        const refused = await request(h.app).post('/plugins/tracks/history-import')
        expect(refused.status).toBe(409)
        expect(await importState(h)).toEqual({ provider: false })
      },
      { history: { noProvider: true } },
    )
    await withHarness(async (h) => {
      expect(await importState(h)).toEqual({ provider: false })
    })
  })

  it('leaves a span deleted from the recording deleted', async () => {
    await withHarness(
      async (h) => {
        const provider = h.trackProvider() as Required<TrackApi>
        const span = { from: from + HOUR, to: from + 2 * HOUR }
        expect(
          await provider.deleteTrackSpan(`recorded:${SELF_CONTEXT}`, {
            from: Temporal.Instant.fromEpochMilliseconds(span.from),
            to: Temporal.Instant.fromEpochMilliseconds(span.to),
          }),
        ).toBe(true)
        await request(h.app).post('/plugins/tracks/history-import')
        await finished(h)
        const times = await storedTimes(h)
        expect(times).toHaveLength(3600)
        expect(times.some((time) => time >= span.from && time <= span.to)).toBe(false)
      },
      { history },
    )
  })

  it('reports a stopped import after a paused recording, a sentence each', async () => {
    await withHarness(
      async (h) => {
        await importState(h)
        await h.store()!.saveHistoryImport!(
          {
            context: SELF_CONTEXT,
            startedAt: Date.now(),
            firstDay: startOfDay(from),
            nextDay: startOfDay(from),
            filled: 0,
            error: 'provider unavailable',
          },
          [],
        )
        await h.stop()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
        h.restart()
        await vi.waitFor(
          async () => {
            expect((await importState(h)).state).toBeDefined()
          },
          { timeout: 20_000, interval: 50 },
        )
        h.emit(SELF_CONTEXT, [60.1, 24.9], Date.now())
        // The restart reads the stopped import back by itself, which can come
        // after the route has answered: report until the status has it.
        await vi.waitFor(
          async () => {
            await vi.advanceTimersByTimeAsync(30_000)
            expect(h.statuses.at(-1)).toContain('History import')
          },
          { timeout: 20_000, interval: 50 },
        )
        expect(h.statuses.at(-1)).toBe(
          "Not recording: navigation.state is 'moored'. 1 position(s) skipped. " +
            'History import stopped: provider unavailable. Resume it in the Tracks webapp.',
        )
      },
      { history, selfPosition: [60, 24], selfState: 'moored', config: { pauseWhenState: ['moored'] } },
    )
  })

  it('goes on after a restart with an import a stop broke off', async () => {
    await withHarness(
      async (h) => {
        await importState(h)
        await h.store()!.saveHistoryImport!(
          {
            context: SELF_CONTEXT,
            startedAt: Date.now(),
            firstDay: startOfDay(from),
            nextDay: startOfDay(from),
            filled: 0,
          },
          [],
        )
        await h.stop()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        h.restart()
        // A fresh worker opens the store first, which a loaded machine takes a while for.
        await vi.waitFor(
          async () => {
            expect((await importState(h)).state).toMatchObject({ running: false, filled: 0 })
          },
          { timeout: 20_000, interval: 50 },
        )
        expect(await storedTimes(h)).toEqual([])
        await vi.advanceTimersByTimeAsync(60_000)
        vi.useRealTimers()
        expect((await finished(h)).filled).toBe(7200)
        expect(await storedTimes(h)).toHaveLength(7200)
      },
      { history },
    )
  })

  it('waits to go on while an import is being started by hand', async () => {
    await withHarness(
      async (h) => {
        await importState(h)
        await h.store()!.saveHistoryImport!(
          {
            context: SELF_CONTEXT,
            startedAt: Date.now(),
            firstDay: startOfDay(from),
            nextDay: startOfDay(from),
            filled: 0,
          },
          [],
        )
        await h.stop()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        h.restart()
        await vi.waitFor(
          async () => {
            expect((await importState(h)).state).toBeDefined()
          },
          { timeout: 20_000, interval: 50 },
        )
        // The start by hand has read the progress when the resume comes due,
        // and goes on to save it back.
        const store = h.store()!
        const read = store.historyImport!.bind(store)
        let release = () => {}
        const held = new Promise<void>((resolve) => (release = resolve))
        let readByHand = false
        vi.spyOn(store, 'historyImport').mockImplementationOnce(async (context) => {
          const state = await read(context)
          readByHand = true
          await held
          return state
        })
        const started = request(h.app)
          .post('/plugins/tracks/history-import')
          .then((response) => response)
        await vi.waitFor(() => expect(readByHand).toBe(true), { timeout: 20_000, interval: 10 })
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await importState(h)).state).toMatchObject({ running: false, filled: 0 })
        release()
        expect((await started).status).toBe(202)
        await vi.advanceTimersByTimeAsync(60_000)
        vi.useRealTimers()
        expect((await finished(h)).filled).toBe(7200)
        expect(await storedTimes(h)).toHaveLength(7200)
      },
      { history },
    )
  })

  it('goes on no second time once started by hand while waiting to', async () => {
    let reads = 0
    await withHarness(
      async (h) => {
        await importState(h)
        const startedAt = Date.now() - 1000
        await h.store()!.saveHistoryImport!(
          {
            context: SELF_CONTEXT,
            startedAt,
            firstDay: startOfDay(from),
            nextDay: startOfDay(from),
            filled: 0,
            error: 'provider unavailable',
          },
          [],
        )
        await h.stop()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        h.restart()
        await vi.waitFor(
          async () => {
            expect((await importState(h)).state).toBeDefined()
          },
          { timeout: 20_000, interval: 50 },
        )
        // Started by hand, it goes on with the import that stopped, and tries
        // again what that one stopped on.
        const resumed = await request(h.app).post('/plugins/tracks/history-import')
        expect(resumed.status).toBe(202)
        expect(resumed.body.state.startedAt).toBe(iso(startedAt))
        expect(resumed.body.state.error).toBeUndefined()
        await vi.waitFor(
          async () => {
            expect((await importState(h)).state?.finishedAt).toBeDefined()
          },
          { timeout: 20_000, interval: 50 },
        )
        const done = reads
        await vi.advanceTimersByTimeAsync(60_000)
        vi.useRealTimers()
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(reads).toBe(done)
        expect((await importState(h)).state).toMatchObject({ running: false, filled: 7200 })
      },
      {
        history: {
          ...history,
          onValues: () => {
            reads++
          },
        },
      },
    )
  })
})
