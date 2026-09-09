import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ThePlugin from './index.js'
import type { ContextPosition } from './index.js'
import type { Debug, LatLngTuple, Position } from './types.js'
import { SELF_CONTEXT } from './harness.test-utils.js'

/**
 * The plugin wired to a sqlite store, exercising what the shared harness
 * cannot: the data directory, and what survives a stop/start cycle.
 */
type Listener = (update: ContextPosition) => void

const debug: Debug = Object.assign(() => undefined, { enabled: false })

const createApp = (dataDir: string | undefined, selfPosition?: LatLngTuple) => {
  const listeners: Listener[] = []
  const errors: unknown[][] = []
  const app = {
    debug,
    error: (...args: unknown[]) => errors.push(args),
    selfContext: SELF_CONTEXT,
    getSelfPath: (): unknown =>
      selfPosition
        ? { value: { latitude: selfPosition[0], longitude: selfPosition[1] } satisfies Position }
        : undefined,
    ...(dataDir === undefined ? {} : { getDataDirPath: () => dataDir }),
    streambundle: {
      getBus: () => ({
        onValue: (cb: Listener) => {
          listeners.push(cb)
          return () => {
            const i = listeners.indexOf(cb)
            if (i >= 0) listeners.splice(i, 1)
          }
        },
      }),
    },
  }
  const emit = (context: string, position: LatLngTuple, timestamp?: number) => {
    for (const cb of listeners) {
      cb({
        context: context as ContextPosition['context'],
        value: { latitude: position[0], longitude: position[1] },
        ...(timestamp === undefined ? {} : { timestamp: new Date(timestamp).toISOString() }),
      })
    }
  }
  return { app, emit, errors }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracks-plugin-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('source: sqlite', () => {
  it('writes a database file in the plugin data directory', () => {
    const { app } = createApp(dir)
    const plugin = ThePlugin(app)
    plugin.start({ resolution: 0 })
    plugin.stop()

    expect(existsSync(join(dir, 'tracks.db'))).toBe(true)
  })

  it('keeps positions across a stop and start', async () => {
    const first = createApp(dir)
    const pluginA = ThePlugin(first.app)
    pluginA.start({ resolution: 0 })
    first.emit(SELF_CONTEXT, [60.1, 24.9], 1000)
    pluginA.stop()

    // A fresh plugin instance against the same directory, as a server restart
    // would produce. This is the whole point of recording to disk:
    // without it the track starts empty.
    const second = createApp(dir)
    const pluginB = ThePlugin(second.app)
    pluginB.start({ resolution: 0 })
    await expect(pluginB.getTracks()?.get(SELF_CONTEXT as ContextPosition['context'])).resolves.toEqual([[60.1, 24.9]])
    pluginB.stop()
  })

  // There is no in-memory fallback any more: a track recorder that forgets
  // everything on restart is not worth starting, so it says why and stops.
  // Every server that can load this plugin provides a data directory.
  it('reports and does not start when the server has no data directory', () => {
    const { app, emit, errors } = createApp(undefined)
    const plugin = ThePlugin(app)
    plugin.start({ resolution: 0 })
    emit(SELF_CONTEXT, [60.1, 24.9], 1000)

    expect(plugin.getTracks()).toBeUndefined()
    expect(errors.flat().join(' ')).toMatch(/data directory/)
    plugin.stop()
  })

  it('does not reuse a closed store after a restart', async () => {
    const { app, emit } = createApp(dir)
    const plugin = ThePlugin(app)
    plugin.start({ resolution: 0 })
    plugin.stop()

    // stop() closes the handle. Starting again must build a new store rather
    // than keep the closed one, which would throw on the next write.
    plugin.start({ resolution: 0 })
    emit(SELF_CONTEXT, [61, 25], 2000)
    await expect(plugin.getTracks()?.get(SELF_CONTEXT as ContextPosition['context'])).resolves.toEqual([[61, 25]])
    plugin.stop()
  })
})

// Opening a database touches the filesystem, so a read-only or full data
// directory throws — and an uncaught throw out of start() takes down more than
// this plugin.
describe('an unusable data directory', () => {
  it('reports the failure and does not start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-ro-'))
    // A directory where the database file should be: sqlite cannot open it.
    mkdirSync(join(dir, 'tracks.db'))
    const { app, errors } = createApp(dir)
    const plugin = ThePlugin(app)
    try {
      plugin.start({ resolution: 0 })

      expect(plugin.getTracks()).toBeUndefined()
      expect(errors.flat().join(' ')).toMatch(/track database/)
    } finally {
      plugin.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The failure above is reachable from a *running* plugin, not only a fresh
  // one: the server calls stop() then start() on every config save, and a data
  // directory that has become unusable in between fails the second start. If
  // stop() left the closed handle in place, the failed start reports itself
  // correctly and every query still goes to a database that is closed.
  it('does not serve the closed store when a restart fails', () => {
    const good = mkdtempSync(join(tmpdir(), 'sk-tracks-restart-'))
    const bad = mkdtempSync(join(tmpdir(), 'sk-tracks-restart-bad-'))
    mkdirSync(join(bad, 'tracks.db'))
    let dataDir = good
    const { app, errors } = createApp(good)
    // getDataDirPath is read on each start(), so the second one lands on the
    // unusable directory while the plugin instance stays the same.
    app.getDataDirPath = () => dataDir
    const plugin = ThePlugin(app)
    try {
      plugin.start({ resolution: 0 })
      expect(plugin.getTracks()).toBeDefined()

      plugin.stop()
      dataDir = bad
      plugin.start({ resolution: 0 })

      expect(errors.flat().join(' ')).toMatch(/track database/)
      expect(plugin.getTracks()).toBeUndefined()
    } finally {
      plugin.stop()
      rmSync(good, { recursive: true, force: true })
      rmSync(bad, { recursive: true, force: true })
    }
  })
})

// The two retentions are configured separately, so neither may switch the other
// off. Gating the prune call on the AIS setting meant `aisRetentionDays: 0` —
// "keep every vessel" — silently stopped trimming the own vessel's track too.
// A track recorder is only useful if it is recording. Installing it and then
// having to find and enable it loses exactly the passage the user installed it
// for, so the descriptor says so and this pins it.
describe('the plugin descriptor', () => {
  it('is enabled by default on install', () => {
    const { app } = createApp(dir)

    expect(ThePlugin(app).enabledByDefault).toBe(true)
  })
})

describe('retention settings are independent', () => {
  it('still trims the own track when AIS retention is disabled', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'sk-tracks-both-'))
    const { app, emit } = createApp(dir)
    const plugin = ThePlugin(app)
    try {
      plugin.start({ resolution: 0, retentionDays: 1, aisRetentionDays: 0 })
      const self = SELF_CONTEXT as ContextPosition['context']
      emit(self, [60, 24], Date.now() - 3 * 24 * 60 * 60 * 1000)
      emit(self, [60.1, 24.1], Date.now())

      // One hour on: the prune timer fires.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

      await expect(plugin.getTracks()?.get(self)).resolves.toHaveLength(1)
    } finally {
      plugin.stop()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
