import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    plugin.start({ source: 'sqlite', resolution: 0 })
    plugin.stop()

    expect(existsSync(join(dir, 'tracks.db'))).toBe(true)
  })

  it('keeps positions across a stop and start', async () => {
    const first = createApp(dir)
    const pluginA = ThePlugin(first.app)
    pluginA.start({ source: 'sqlite', resolution: 0 })
    first.emit(SELF_CONTEXT, [60.1, 24.9], 1000)
    pluginA.stop()

    // A fresh plugin instance against the same directory, as a server restart
    // would produce. This is the whole point of the sqlite source: without it
    // the track starts empty.
    const second = createApp(dir)
    const pluginB = ThePlugin(second.app)
    pluginB.start({ source: 'sqlite', resolution: 0 })
    await expect(pluginB.getTracks()?.get(SELF_CONTEXT as ContextPosition['context'])).resolves.toEqual([[60.1, 24.9]])
    pluginB.stop()
  })

  it('falls back to memory and reports it when the server has no data directory', async () => {
    const { app, emit, errors } = createApp(undefined)
    const plugin = ThePlugin(app)
    plugin.start({ source: 'sqlite', resolution: 0 })
    emit(SELF_CONTEXT, [60.1, 24.9], 1000)

    // Still functional, just not persistent — and it says so rather than
    // failing to start.
    await expect(plugin.getTracks()?.get(SELF_CONTEXT as ContextPosition['context'])).resolves.toEqual([[60.1, 24.9]])
    expect(errors.flat().join(' ')).toMatch(/data directory/)
    plugin.stop()
  })

  it('does not reuse a closed store after a restart', async () => {
    const { app, emit } = createApp(dir)
    const plugin = ThePlugin(app)
    plugin.start({ source: 'sqlite', resolution: 0 })
    plugin.stop()

    // stop() closes the handle. Starting again must build a new store rather
    // than keep the closed one, which would throw on the next write.
    plugin.start({ source: 'sqlite', resolution: 0 })
    emit(SELF_CONTEXT, [61, 25], 2000)
    await expect(plugin.getTracks()?.get(SELF_CONTEXT as ContextPosition['context'])).resolves.toEqual([[61, 25]])
    plugin.stop()
  })
})
