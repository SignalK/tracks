import { outsideSpans } from './recycleBin.js'
import { fillGaps, MIN_FILLED_GAP_MS } from './utils.js'
import type { DeletedSpan, HistoryImportState, TimedPosition } from './types.js'

/**
 * A one-time import of the own vessel's track from a history provider into
 * the store's recording.
 *
 * Read day by day, from the first day the provider holds to the moment the
 * import was started, and written only where the recording has nothing for at
 * least {@link MIN_FILLED_GAP_MS}, as a GPX import of the own vessel is
 * (`fillGaps`): what the plugin recorded itself stays as it is, and the
 * provider fills the time it was not running. A deleted span stays deleted.
 *
 * Each day commits with the state that says it is done, so a stop or a
 * restart goes on with the next day. A day written twice writes nothing the
 * second time, since what the first wrote is then the recording.
 */

export interface HistoryImportDeps {
  /**
   * What history holds over `[from, to)`, in buckets of `seconds`, rejecting
   * when it cannot be read: an outage must not read as a day with nothing.
   */
  history: (from: number, to: number, seconds: number) => Promise<TimedPosition[]>
  /** What the recording holds over `[from, to]`. */
  stored: (from: number, to: number) => Promise<TimedPosition[]>
  /** The spans deleted from the recording. */
  deleted: () => Promise<DeletedSpan[]>
  /** Write a day's runs into the recording together with the state they bring it to. */
  save: (state: HistoryImportState, runs: TimedPosition[][]) => Promise<void>
  /** Whether to stop before the next day, as the plugin does when it stops. */
  stopped: () => boolean
  /** Told of the state after each day. */
  progress?: (state: HistoryImportState) => void
  now?: () => number
}

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The finest bucket the History API can ask for, in seconds: it takes whole
 * seconds. A provider that recorded more coarsely leaves the buckets between
 * its fixes empty.
 */
export const FINEST_SECONDS = 1

/**
 * The bucket a day is first read at, to find where it has positions.
 *
 * A provider fills every bucket of a range, empty ones with nulls (questdb's
 * `FILL(NULL)`), so a day read at a second is 86,400 rows whether it holds a
 * passage or nothing. Ten minutes makes that 144, and only the stretches with
 * positions are then read finely, one read each; stretches less than a probe
 * bucket apart are read as one.
 */
export const PROBE_SECONDS = 600

/**
 * How many buckets the read that finds where history begins asks for: a
 * thousand over everything since the epoch are about three weeks each, which
 * only sets how many empty days the import starts with.
 */
export const START_PROBE_BUCKETS = 1000

/** Start of the UTC day `time` falls in. */
export const startOfDay = (time: number): number => time - (((time % DAY_MS) + DAY_MS) % DAY_MS)

/**
 * The stretches of `[from, to)` where `stored` has nothing for at least
 * `minGap`: the only time a day's import can fill, as `fillGaps` decides it.
 * `stored` must reach `minGap` past both ends, or a stretch beside a position
 * just outside would count as free.
 */
export function freeWindows(
  stored: readonly TimedPosition[],
  from: number,
  to: number,
  minGap: number,
): { from: number; to: number }[] {
  const times = stored.map(({ timestamp }) => timestamp).sort((a, b) => a - b)
  const windows: { from: number; to: number }[] = []
  let previous = -Infinity
  for (const time of [...times, Infinity]) {
    if (time - previous >= minGap) {
      const start = Math.max(previous, from)
      const end = Math.min(time, to)
      if (start < end) {
        windows.push({ from: start, to: end })
      }
    }
    previous = time
  }
  return windows
}

/**
 * The parts of `windows` a probe at `seconds` found positions in. A bucket
 * counts from one width before its time to one after, since providers
 * disagree on whether a bucket's time marks its start or its end.
 */
export function occupied(
  probe: readonly TimedPosition[],
  windows: readonly { from: number; to: number }[],
  seconds: number,
): { from: number; to: number }[] {
  const width = seconds * 1000
  const spans: { from: number; to: number }[] = []
  for (const { timestamp } of [...probe].sort((a, b) => a.timestamp - b.timestamp)) {
    const last = spans.at(-1)
    if (last && timestamp - width <= last.to) {
      last.to = Math.max(last.to, timestamp + width)
    } else {
      spans.push({ from: timestamp - width, to: timestamp + width })
    }
  }
  const result: { from: number; to: number }[] = []
  for (const window of windows) {
    for (const span of spans) {
      const start = Math.max(window.from, span.from)
      const end = Math.min(window.to, span.to)
      if (start < end) {
        result.push({ from: start, to: end })
      }
    }
  }
  return result
}

/**
 * The runs one day of history fills, `[from, to)`, and whether the stretch it
 * filled up to the day's end goes on into the next.
 *
 * The recording is read first, and history only where it leaves room: a day
 * the plugin recorded whole asks the provider nothing. The rest is probed
 * coarsely and read finely over the stretches that have positions.
 *
 * `inGap` says the day before ended inside a stretch it was filling. What
 * lies before `from` is then what the import wrote there, not the recording,
 * and counted as recorded it would leave the rest of that stretch, after
 * midnight, too short to fill.
 */
export async function importDay(
  from: number,
  to: number,
  deps: Pick<HistoryImportDeps, 'history' | 'stored' | 'deleted'>,
  inGap = false,
): Promise<{ runs: TimedPosition[][]; inGap: boolean }> {
  const around = await deps.stored(from - MIN_FILLED_GAP_MS, to + MIN_FILLED_GAP_MS)
  const stored = inGap ? around.filter(({ timestamp }) => timestamp >= from) : around
  const free = freeWindows(stored, from, to, MIN_FILLED_GAP_MS)
  if (free.length === 0) {
    return { runs: [], inGap: false }
  }
  const goesOn = free.at(-1)!.to === to
  const probe = await deps.history(free[0]!.from, free.at(-1)!.to, PROBE_SECONDS)
  const spans: { from: number; to: number }[] = []
  for (const span of occupied(probe, free, PROBE_SECONDS)) {
    const last = spans.at(-1)
    if (last && span.from - last.to < PROBE_SECONDS * 1000) {
      last.to = span.to
    } else {
      spans.push({ ...span })
    }
  }
  const points: TimedPosition[] = []
  for (const span of spans) {
    for (const point of await deps.history(span.from, span.to, FINEST_SECONDS)) {
      if (point.timestamp >= span.from && point.timestamp < span.to) {
        points.push(point)
      }
    }
  }
  // Asked after the provider, whose reads can take minutes: a span deleted
  // meanwhile stays deleted too.
  const visible = outsideSpans(points, await deps.deleted()).sort((a, b) => a.timestamp - b.timestamp)
  const runs = fillGaps([visible], stored, MIN_FILLED_GAP_MS).runs.map((run) =>
    run.map(({ position, timestamp }) => ({ position, timestamp })),
  )
  return { runs, inGap: goesOn }
}

/**
 * Where history begins, or undefined when it holds nothing before `until`.
 *
 * Read once at a coarse bucket from the epoch, and moved back by one bucket
 * for a provider that stamps buckets on their end.
 */
export async function historyStart(until: number, history: HistoryImportDeps['history']): Promise<number | undefined> {
  const seconds = Math.max(FINEST_SECONDS, Math.ceil(until / 1000 / START_PROBE_BUCKETS))
  const probe = await history(0, until, seconds)
  if (probe.length === 0) {
    return undefined
  }
  let earliest = Infinity
  for (const { timestamp } of probe) {
    earliest = Math.min(earliest, timestamp)
  }
  return Math.max(0, earliest - seconds * 1000)
}

/**
 * Go on with an import from where `state` left it, resolving to the state it
 * stopped in: finished, failed with `error` set, or stopped before a day.
 *
 * The state moves on only once what brings it there is written, so a write
 * that fails leaves its day to be done again.
 */
export async function runHistoryImport(
  state: HistoryImportState,
  deps: HistoryImportDeps,
): Promise<HistoryImportState> {
  const now = deps.now ?? Date.now
  // Cleared here rather than by the caller: whatever failed before is being
  // tried again.
  let current: HistoryImportState = { ...state }
  delete current.error
  const advance = async (next: HistoryImportState, runs: TimedPosition[][] = []) => {
    await deps.save(next, runs)
    current = next
    deps.progress?.(current)
  }
  try {
    if (current.nextDay === undefined) {
      const start = await historyStart(current.startedAt, deps.history)
      if (start === undefined) {
        await advance({ ...current, finishedAt: now() })
        return current
      }
      await advance({ ...current, firstDay: startOfDay(start), nextDay: startOfDay(start) })
    }
    while (current.nextDay! < current.startedAt) {
      if (deps.stopped()) {
        return current
      }
      const from = current.nextDay!
      const to = Math.min(from + DAY_MS, current.startedAt)
      const day = await importDay(from, to, deps, current.inGap === true)
      const next: HistoryImportState = {
        ...current,
        nextDay: to,
        filled: current.filled + day.runs.reduce((sum, run) => sum + run.length, 0),
      }
      delete next.inGap
      await advance(day.inGap ? { ...next, inGap: true } : next, day.runs)
    }
    await advance({ ...current, finishedAt: now() })
    return current
  } catch (err) {
    const failed = { ...current, error: err instanceof Error ? err.message : String(err) }
    // The state as it stood is kept, so the next attempt goes on from the
    // day that failed. Saving it can fail as well, when the store is the
    // reason; the caller still hears why.
    await deps.save(failed, []).catch(() => {})
    deps.progress?.(failed)
    return failed
  }
}

/** What the plugin status says of an import: while it runs, or once it failed. */
export function importStatus(state: HistoryImportState, running: boolean): string | undefined {
  if (!running) {
    return state.error === undefined
      ? undefined
      : `History import stopped: ${state.error}. Resume it in the Tracks webapp.`
  }
  if (state.firstDay === undefined || state.nextDay === undefined) {
    return 'Importing history: finding where it begins'
  }
  const share = Math.floor((100 * (state.nextDay - state.firstDay)) / Math.max(1, state.startedAt - state.firstDay))
  const day = new Date(state.nextDay).toISOString().slice(0, 10)
  return `Importing history: ${share}% done, up to ${day}, ${state.filled} positions filled`
}
