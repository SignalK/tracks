import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  FINEST_SECONDS,
  freeWindows,
  historyStart,
  importStatus,
  occupied,
  PROBE_SECONDS,
  runHistoryImport,
  startOfDay,
} from './historyImport.js'
import type { HistoryImportDeps } from './historyImport.js'
import type { DeletedSpan, HistoryImportState, LatLngTuple, TimedPosition } from './types.js'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const day0 = Date.UTC(2026, 5, 1)

/** Fixes a second apart over `[from, to)`, moving east. */
const fixes = (from: number, to: number): TimedPosition[] => {
  const result: TimedPosition[] = []
  for (let t = from; t < to; t += 1000) {
    result.push({ position: [60, 24 + (t - day0) / 1e9] as LatLngTuple, timestamp: t })
  }
  return result
}

/**
 * A history provider over `held`, answering as questdb does with `first`:
 * the earliest fix in each bucket of the range, stamped at the bucket's
 * start, or at its end as some providers stamp it.
 */
function fakeHistory(held: TimedPosition[], { stampAtEnd = false } = {}) {
  const calls: { from: number; to: number; seconds: number }[] = []
  let failing = false
  const history: HistoryImportDeps['history'] = (from, to, seconds) => {
    calls.push({ from, to, seconds })
    if (failing) {
      return Promise.reject(new Error('provider unavailable'))
    }
    const width = seconds * 1000
    const buckets = new Map<number, TimedPosition>()
    for (const point of held) {
      if (point.timestamp < from || point.timestamp >= to) continue
      const bucket = from + Math.floor((point.timestamp - from) / width) * width
      const stamp = stampAtEnd ? bucket + width : bucket
      if (!buckets.has(bucket)) buckets.set(bucket, { position: point.position, timestamp: stamp, span: width })
    }
    return Promise.resolve([...buckets.values()])
  }
  return {
    history,
    calls,
    fail: (value: boolean) => {
      failing = value
    },
  }
}

/** A recording, and every state the import saved with what it wrote. */
function fakeStore(recorded: TimedPosition[] = [], deleted: DeletedSpan[] = []) {
  let failing = false
  const saved: HistoryImportState[] = []
  /** Where each save that wrote positions left the import, and how many it wrote. */
  const writes: { nextDay: number | undefined; count: number }[] = []
  const written: TimedPosition[] = []
  const deps: Pick<HistoryImportDeps, 'stored' | 'deleted' | 'save'> = {
    stored: (from, to) =>
      Promise.resolve([...recorded, ...written].filter(({ timestamp }) => timestamp >= from && timestamp <= to)),
    // A copy, as a store's answer is: a span deleted later is not in it.
    deleted: () => Promise.resolve([...deleted]),
    save: (state, runs) => {
      const points = runs.flat()
      if (failing && points.length > 0) {
        return Promise.reject(new Error('database or disk is full'))
      }
      saved.push(state)
      if (points.length > 0) writes.push({ nextDay: state.nextDay, count: points.length })
      // As a store holds them, without the bucket's width.
      written.push(...points.map(({ position, timestamp }) => ({ position, timestamp })))
      return Promise.resolve(state.filled)
    },
  }
  return {
    deps,
    saved,
    writes,
    written,
    deleted,
    failWrites: (value: boolean) => {
      failing = value
    },
  }
}

const begin = (startedAt: number): HistoryImportState => ({ context: SELF, startedAt, filled: 0 })

describe('freeWindows', () => {
  it('is the whole range where nothing is recorded', () => {
    expect(freeWindows([], 0, HOUR, 5 * MINUTE)).toEqual([{ from: 0, to: HOUR }])
  })

  it('leaves out the time between fixes closer than the gap, and keeps a longer gap', () => {
    const stored = [0, MINUTE, 2 * MINUTE, 9 * MINUTE, 10 * MINUTE].map((timestamp) => ({
      position: [60, 24] as LatLngTuple,
      timestamp,
    }))
    expect(freeWindows(stored, 0, 10 * MINUTE, 5 * MINUTE)).toEqual([{ from: 2 * MINUTE, to: 9 * MINUTE }])
  })

  it('counts a fix just outside the range against the stretch beside it', () => {
    const stored = [{ position: [60, 24] as LatLngTuple, timestamp: -MINUTE }]
    // From the fix before the range, the first four minutes are too close.
    expect(freeWindows(stored, 0, 3 * MINUTE, 5 * MINUTE)).toEqual([{ from: 0, to: 3 * MINUTE }])
    const close = [-MINUTE, 3 * MINUTE].map((timestamp) => ({ position: [60, 24] as LatLngTuple, timestamp }))
    expect(freeWindows(close, 0, 2 * MINUTE, 5 * MINUTE)).toEqual([])
  })
})

describe('occupied', () => {
  it('widens each bucket by its width either side, within the windows', () => {
    const probe = [{ position: [60, 24] as LatLngTuple, timestamp: 20 * MINUTE }]
    expect(occupied(probe, [{ from: 0, to: HOUR }], PROBE_SECONDS)).toEqual([{ from: 10 * MINUTE, to: 30 * MINUTE }])
    expect(occupied(probe, [{ from: 25 * MINUTE, to: HOUR }], PROBE_SECONDS)).toEqual([
      { from: 25 * MINUTE, to: 30 * MINUTE },
    ])
    expect(occupied([], [{ from: 0, to: HOUR }], PROBE_SECONDS)).toEqual([])
  })
})

describe('historyStart', () => {
  it('finds where history begins, a coarse bucket early', async () => {
    const { history, calls } = fakeHistory(fixes(day0 + 5 * HOUR, day0 + 6 * HOUR))
    const start = await historyStart(day0 + 10 * DAY_MS, history)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.from).toBe(0)
    expect(start).toBeLessThanOrEqual(day0 + 5 * HOUR)
    expect(start).toBeGreaterThan(day0 + 5 * HOUR - 2 * calls[0]!.seconds * 1000)
  })

  it('finds nothing in an empty provider', async () => {
    expect(await historyStart(day0, fakeHistory([]).history)).toBeUndefined()
  })
})

describe('historyStart from a cutoff', () => {
  it('starts at or before the first kept fix for an end-stamped provider', async () => {
    const { history } = fakeHistory(fixes(day0 + 12 * HOUR, day0 + 13 * HOUR), { stampAtEnd: true })
    const start = await historyStart(day0 + DAY_MS, history, day0)
    expect(start).toBeDefined()
    expect(start).toBeLessThanOrEqual(day0 + 12 * HOUR)
  })

  it('asks nothing when the cutoff is not before the end', async () => {
    const { history, calls } = fakeHistory(fixes(day0, day0 + HOUR))
    await expect(historyStart(day0 + DAY_MS, history, day0 + DAY_MS)).resolves.toBeUndefined()
    await expect(historyStart(day0 + DAY_MS, history, day0 + 2 * DAY_MS)).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('finishes an import whose start lies before the retention cutoff', async () => {
    const { history, calls } = fakeHistory(fixes(day0, day0 + HOUR))
    const store = fakeStore()
    const final = await runHistoryImport(begin(day0 + DAY_MS), {
      ...store.deps,
      history,
      stopped: () => false,
      keepFrom: () => day0 + 3 * DAY_MS,
    })
    expect(final.finishedAt).toBeDefined()
    expect(final.error).toBeUndefined()
    expect(calls).toEqual([])
    expect(store.written).toEqual([])
  })

  it('probes only from the cutoff on, at buckets sized for that range', async () => {
    const { history, calls } = fakeHistory(fixes(day0 + 12 * HOUR, day0 + 13 * HOUR))
    const start = await historyStart(day0 + DAY_MS, history, day0)
    expect(calls).toEqual([{ from: day0, to: day0 + DAY_MS, seconds: Math.ceil(DAY_MS / 1000 / 1000) }])
    expect(start).toBeGreaterThanOrEqual(day0 + 12 * HOUR - 2 * 87_000)
    expect(start).toBeLessThanOrEqual(day0 + 12 * HOUR)
  })
})

describe('runHistoryImport', () => {
  it('fills a recording that has nothing at the finest resolution, day by day', async () => {
    const held = fixes(day0 + 22 * HOUR, day0 + DAY_MS + 2 * HOUR)
    const { history } = fakeHistory(held)
    const store = fakeStore()
    const final = await runHistoryImport(begin(day0 + 3 * DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(final.finishedAt).toBeDefined()
    expect(final.error).toBeUndefined()
    expect(final.firstDay).toBe(startOfDay(final.firstDay!))
    expect(store.written.map(({ timestamp }) => timestamp)).toEqual(held.map(({ timestamp }) => timestamp))
    expect(final.filled).toBe(held.length)
    // Each day commits on its own.
    expect(store.writes).toEqual([
      { nextDay: day0 + DAY_MS, count: 2 * 3600 },
      { nextDay: day0 + 2 * DAY_MS, count: 2 * 3600 },
    ])
  })

  it('fills only where the recording has nothing for five minutes', async () => {
    // Recorded once a minute from 10 to 11; history every second from 9 to 12.
    const recorded = Array.from({ length: 61 }, (_, i) => ({
      position: [60, 24] as LatLngTuple,
      timestamp: day0 + 10 * HOUR + i * MINUTE,
    }))
    const { history } = fakeHistory(fixes(day0 + 9 * HOUR, day0 + 12 * HOUR))
    const store = fakeStore(recorded)
    await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    const times = store.written.map(({ timestamp }) => timestamp)
    expect(times.length).toBe(2 * 3600 - 1)
    expect(times.some((t) => t >= day0 + 10 * HOUR && t <= day0 + 11 * HOUR)).toBe(false)
    expect(Math.min(...times)).toBe(day0 + 9 * HOUR)
    expect(Math.max(...times)).toBe(day0 + 12 * HOUR - 1000)
  })

  it('asks history nothing for a day the recording covers, and reads an empty day only coarsely', async () => {
    const recorded = Array.from({ length: 24 * 60 + 1 }, (_, i) => ({
      position: [60, 24] as LatLngTuple,
      timestamp: day0 + i * MINUTE,
    }))
    // History holds the covered day and nothing on the next.
    const { history, calls } = fakeHistory(fixes(day0, day0 + 2 * HOUR))
    const store = fakeStore(recorded)
    await runHistoryImport(begin(day0 + 2 * DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(store.written).toEqual([])
    // The days before it are empty too: each costs one coarse read.
    const perDay = calls.slice(1)
    expect(perDay.some(({ from }) => from >= day0 && from < day0 + DAY_MS)).toBe(false)
    expect(perDay.some(({ from }) => from >= day0 + DAY_MS)).toBe(true)
    expect(perDay.every(({ seconds }) => seconds === PROBE_SECONDS)).toBe(true)
  })

  it('reads the parts of a day that hold positions, not the whole day, at a second', async () => {
    const { history, calls } = fakeHistory(fixes(day0 + 13 * HOUR, day0 + 14 * HOUR))
    const store = fakeStore()
    await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    const fine = calls.filter(({ seconds }) => seconds === FINEST_SECONDS)
    expect(fine).toHaveLength(1)
    expect(fine[0]!.to - fine[0]!.from).toBeLessThanOrEqual(HOUR + 2 * PROBE_SECONDS * 1000)
    expect(store.written).toHaveLength(3600)
  })

  it('starts at the day the own vessel retention keeps from', async () => {
    const held = fixes(day0 + 12 * HOUR, day0 + 13 * HOUR)
    const later = fixes(day0 + 2 * DAY_MS + 12 * HOUR, day0 + 2 * DAY_MS + 13 * HOUR)
    const { history, calls } = fakeHistory([...held, ...later])
    const store = fakeStore()
    const keepFrom = () => day0 + DAY_MS + 6 * HOUR
    const final = await runHistoryImport(begin(day0 + 3 * DAY_MS), {
      ...store.deps,
      history,
      stopped: () => false,
      keepFrom,
    })
    expect(final.firstDay).toBe(day0 + 2 * DAY_MS)
    expect(store.written.map(({ timestamp }) => timestamp)).toEqual(later.map(({ timestamp }) => timestamp))
    expect(final.filled).toBe(later.length)
    // Nothing before it is read, not even to find where history begins.
    expect(calls.some(({ from }) => from < day0 + DAY_MS)).toBe(false)
  })

  it('leaves out what lies before the cutoff on the first day it keeps', async () => {
    const held = fixes(day0 + 10 * HOUR, day0 + 12 * HOUR)
    const { history } = fakeHistory(held)
    const store = fakeStore()
    const final = await runHistoryImport(begin(day0 + DAY_MS), {
      ...store.deps,
      history,
      stopped: () => false,
      keepFrom: () => day0 + 11 * HOUR,
    })
    const kept = held.filter(({ timestamp }) => timestamp >= day0 + 11 * HOUR)
    expect(store.written.map(({ timestamp }) => timestamp)).toEqual(kept.map(({ timestamp }) => timestamp))
    expect(final.filled).toBe(kept.length)
  })

  it('skips ahead when the retention has moved past the day a resumed import is at', async () => {
    const held = fixes(day0 + 12 * HOUR, day0 + 13 * HOUR)
    const later = fixes(day0 + 2 * DAY_MS + 12 * HOUR, day0 + 2 * DAY_MS + 13 * HOUR)
    const { history } = fakeHistory([...held, ...later])
    const store = fakeStore()
    const resumed: HistoryImportState = { ...begin(day0 + 3 * DAY_MS), firstDay: day0, nextDay: day0, inGap: true }
    const final = await runHistoryImport(resumed, {
      ...store.deps,
      history,
      stopped: () => false,
      keepFrom: () => day0 + 2 * DAY_MS,
    })
    expect(final.finishedAt).toBeDefined()
    expect(store.written.map(({ timestamp }) => timestamp)).toEqual(later.map(({ timestamp }) => timestamp))
  })

  it('leaves a deleted span deleted', async () => {
    const deleted = [{ from: day0 + 9 * HOUR + 30 * MINUTE, to: day0 + 10 * HOUR }]
    const { history } = fakeHistory(fixes(day0 + 9 * HOUR, day0 + 11 * HOUR))
    const store = fakeStore([], deleted)
    await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(store.written.length).toBeGreaterThan(0)
    expect(store.written.some(({ timestamp }) => timestamp >= deleted[0]!.from && timestamp <= deleted[0]!.to)).toBe(
      false,
    )
  })

  it('stops before a day when asked, and goes on from there', async () => {
    const held = fixes(day0 + 12 * HOUR, day0 + 2 * DAY_MS + 12 * HOUR)
    const { history, calls } = fakeHistory(held)
    const store = fakeStore()
    let days = 0
    const stopped = await runHistoryImport(begin(day0 + 4 * DAY_MS), {
      ...store.deps,
      history,
      stopped: () => days >= 1,
      progress: (state) => {
        if (state.filled > 0) days++
      },
    })
    expect(stopped.finishedAt).toBeUndefined()
    expect(stopped.nextDay).toBe(day0 + DAY_MS)
    const asked = calls.length
    const final = await runHistoryImport(stopped, { ...store.deps, history, stopped: () => false })
    expect(final.finishedAt).toBeDefined()
    // Not where history begins again, nor the day already done.
    expect(calls.slice(asked).every(({ from }) => from >= day0 + DAY_MS)).toBe(true)
    expect(store.written).toHaveLength(held.length)
    expect(final.filled).toBe(held.length)
  })

  it('keeps the day it failed on, and goes on from it when asked again', async () => {
    const held = fixes(day0 + 12 * HOUR, day0 + DAY_MS + 12 * HOUR)
    const provider = fakeHistory(held)
    const store = fakeStore()
    let days = 0
    const failed = await runHistoryImport(begin(day0 + 3 * DAY_MS), {
      ...store.deps,
      history: provider.history,
      stopped: () => false,
      progress: (state) => {
        if (state.filled > 0 && ++days === 1) provider.fail(true)
      },
    })
    expect(failed.error).toBe('provider unavailable')
    expect(failed.finishedAt).toBeUndefined()
    expect(failed.nextDay).toBe(day0 + DAY_MS)
    expect(store.saved.at(-1)).toEqual(failed)
    provider.fail(false)
    const final = await runHistoryImport(failed, { ...store.deps, history: provider.history, stopped: () => false })
    expect(final.error).toBeUndefined()
    expect(final.finishedAt).toBeDefined()
    expect(store.written).toHaveLength(held.length)
  })

  it('reads up to the moment it was started, and no further', async () => {
    const startedAt = day0 + 15 * HOUR
    const { history, calls } = fakeHistory(fixes(day0 + 14 * HOUR, day0 + 16 * HOUR))
    const store = fakeStore()
    const final = await runHistoryImport(begin(startedAt), { ...store.deps, history, stopped: () => false })
    expect(final.nextDay).toBe(startedAt)
    expect(calls.slice(1).every(({ to }) => to <= startedAt)).toBe(true)
    expect(store.written).toHaveLength(3600)
  })

  it('writes nothing the second time over the same days', async () => {
    const { history } = fakeHistory(fixes(day0 + 9 * HOUR, day0 + 11 * HOUR))
    const store = fakeStore()
    await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    const first = store.written.length
    const again = await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(store.written).toHaveLength(first)
    expect(again.filled).toBe(0)
  })

  it('keeps a day whose write failed to be done again', async () => {
    const held = fixes(day0 + 12 * HOUR, day0 + 13 * HOUR)
    const { history } = fakeHistory(held)
    const store = fakeStore()
    store.failWrites(true)
    const failed = await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(failed.error).toBe('database or disk is full')
    expect(failed.nextDay).toBe(day0)
    expect(failed.filled).toBe(0)
    expect(failed.finishedAt).toBeUndefined()
    store.failWrites(false)
    const final = await runHistoryImport(failed, { ...store.deps, history, stopped: () => false })
    expect(final.finishedAt).toBeDefined()
    expect(store.written).toHaveLength(held.length)
    expect(final.filled).toBe(held.length)
  })

  it('goes on filling a stretch across midnight, however little of it lies after', async () => {
    const midnight = day0 + DAY_MS
    const recorded = [midnight - 10 * MINUTE, midnight + 3 * MINUTE].map((timestamp) => ({
      position: [60, 24] as LatLngTuple,
      timestamp,
    }))
    const held = fixes(midnight - 12 * MINUTE, midnight + 5 * MINUTE)
    const { history } = fakeHistory(held)
    const store = fakeStore(recorded)
    const final = await runHistoryImport(begin(day0 + 2 * DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(final.finishedAt).toBeDefined()
    const times = new Set(store.written.map(({ timestamp }) => timestamp))
    // Everything but the two instants the recording has.
    expect(times.size).toBe(held.length - 2)
    expect(times.has(midnight + MINUTE)).toBe(true)
  })

  it('hands the save each bucket with its width, and where a stretch across midnight began', async () => {
    const midnight = day0 + DAY_MS
    const { history } = fakeHistory(fixes(midnight - 10 * MINUTE, midnight + 10 * MINUTE))
    const store = fakeStore()
    const saves: { runs: TimedPosition[][]; since: number | undefined }[] = []
    const save: HistoryImportDeps['save'] = (state, runs, since) => {
      if (runs.length > 0) saves.push({ runs, since })
      return store.deps.save(state, runs, since)
    }
    await runHistoryImport(begin(day0 + 2 * DAY_MS), { ...store.deps, save, history, stopped: () => false })
    // The empty days the import starts with carry their stretch into the first.
    expect(saves.map(({ since }) => since)).toEqual([day0, midnight])
    const points = saves.flatMap(({ runs }) => runs.flat())
    expect(points).toHaveLength(20 * 60)
    expect(points.every(({ span }) => span === FINEST_SECONDS * 1000)).toBe(true)
  })

  it('fills after midnight what the stretch across it leaves, though nothing filled it before', async () => {
    // History has nothing before either midnight. The stretch across the
    // first is thirteen minutes, the one across the second four.
    const first = day0 + DAY_MS
    const second = day0 + 2 * DAY_MS
    const recorded = [first - 10 * MINUTE, first + 3 * MINUTE, second - MINUTE, second + 3 * MINUTE].map(
      (timestamp) => ({ position: [60, 24] as LatLngTuple, timestamp }),
    )
    const early = fixes(day0 + HOUR, day0 + HOUR + MINUTE)
    const afterFirst = fixes(first, first + 3 * MINUTE)
    const { history } = fakeHistory([...early, ...afterFirst, ...fixes(second, second + 3 * MINUTE)])
    const store = fakeStore(recorded)
    const final = await runHistoryImport(begin(day0 + 3 * DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(final.finishedAt).toBeDefined()
    expect(store.written.map(({ timestamp }) => timestamp).sort((a, b) => a - b)).toEqual(
      [...early, ...afterFirst].map(({ timestamp }) => timestamp),
    )
  })

  it('reads a provider that stamps its buckets on their end', async () => {
    // A provider installed a few days ago, whose start probe bucket ends
    // after the import started, holding only a day's last eight minutes.
    const end = day0 + DAY_MS
    const held = fixes(end - 8 * MINUTE, end)
    const { history } = fakeHistory(held, { stampAtEnd: true })
    const store = fakeStore()
    const final = await runHistoryImport(begin(day0 + 3 * DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(final.firstDay).toBeLessThanOrEqual(end - 8 * MINUTE)
    // The last bucket's stamp is the next day's start, where it is not asked for.
    expect(store.written.length).toBeGreaterThanOrEqual(held.length - 1)
  })

  it('reads each stretch with positions on its own', async () => {
    // Recorded from 01:00 to 23:00, history all day.
    const recorded = Array.from({ length: 22 * 60 + 1 }, (_, i) => ({
      position: [60, 24] as LatLngTuple,
      timestamp: day0 + HOUR + i * MINUTE,
    }))
    const { history, calls } = fakeHistory(fixes(day0, day0 + DAY_MS))
    const store = fakeStore(recorded)
    await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    const fine = calls.filter(({ seconds }) => seconds === FINEST_SECONDS)
    expect(fine).toHaveLength(2)
    const buckets = fine.reduce((sum, { from, to }) => sum + (to - from) / 1000, 0)
    expect(buckets).toBeLessThanOrEqual(2 * 3600)
    // From midnight to 01:00, and after the fix at 23:00.
    expect(store.written).toHaveLength(2 * 3600 - 1)
  })

  it('leaves a span deleted while the provider is read deleted', async () => {
    const held = fixes(day0 + 9 * HOUR, day0 + 11 * HOUR)
    const provider = fakeHistory(held)
    const store = fakeStore()
    const span = { from: day0 + 10 * HOUR, to: day0 + 11 * HOUR }
    const history: HistoryImportDeps['history'] = async (from, to, seconds) => {
      const answer = await provider.history(from, to, seconds)
      if (seconds === FINEST_SECONDS) store.deleted.push(span)
      return answer
    }
    await runHistoryImport(begin(day0 + DAY_MS), { ...store.deps, history, stopped: () => false })
    expect(store.written).toHaveLength(3600)
    expect(store.written.some(({ timestamp }) => timestamp >= span.from)).toBe(false)
  })

  it('finishes with nothing when history holds nothing', async () => {
    const store = fakeStore()
    const final = await runHistoryImport(begin(day0), {
      ...store.deps,
      history: fakeHistory([]).history,
      stopped: () => false,
    })
    expect(final.finishedAt).toBeDefined()
    expect(final.firstDay).toBeUndefined()
    expect(final.filled).toBe(0)
  })
})

describe('importStatus', () => {
  const state = { ...begin(day0 + 10 * DAY_MS), firstDay: day0, nextDay: day0 + 4 * DAY_MS, filled: 1234 }

  it('says how far a running import got', () => {
    expect(importStatus(state, true)).toBe('Importing history: 40% done, up to 2026-06-05, 1234 positions filled')
    expect(importStatus(begin(day0), true)).toBe('Importing history: finding where it begins')
  })

  it('says why an import stopped, and nothing once it finished', () => {
    expect(importStatus({ ...state, error: 'provider unavailable' }, false)).toBe(
      'History import stopped: provider unavailable. Resume it in the Tracks webapp.',
    )
    expect(importStatus({ ...state, finishedAt: day0 }, false)).toBeUndefined()
  })
})
