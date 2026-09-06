import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Boots a real Signal K server with this plugin installed.
 *
 * The unit suite drives the plugin behind a bare express app, which proves the
 * handlers but mocks everything around them. This proves the parts that mock
 * cannot: that the server resolves and loads the built package at all, that
 * `signalKApiRoutes` actually mounts under /signalk/v1/api, and that positions
 * arriving as deltas reach the plugin through the real streambundle.
 *
 * Deliberately not in CI. It needs a built server checkout and, for the
 * history-provider tests, a running QuestDB.
 */

/** Where the signalk-server checkout lives. Override with SIGNALK_SERVER_DIR. */
const SERVER_DIR = process.env.SIGNALK_SERVER_DIR ?? join(process.env.HOME ?? '', 'dev/xxx_signalk-server')

/** QuestDB endpoint used by the history-provider tier. */
export const QUESTDB_URL = process.env.QUESTDB_URL ?? 'http://localhost:9000'

export interface E2EServer {
  url: string
  configDir: string
  /** Send a position delta as a provider would, over the WebSocket API. */
  feed: (context: string, position: [number, number], timestamp?: number, source?: string) => Promise<void>
  /** GET a path under /signalk/v1/api and parse the JSON. */
  api: (path: string) => Promise<unknown>
  /**
   * GET a path under /signalk/v2/api, keeping the status.
   *
   * The status is what distinguishes "no provider registered" (501) from an
   * answered query, which is the thing a provider registration test is about.
   */
  apiV2: (path: string) => Promise<{ status: number; body: unknown }>
  /** The server's own vessel context, as it resolved it. */
  selfContext: string
  stop: () => void
}

/** A port unlikely to collide with a dev server or the boat's own services. */
const basePort = 4700 + Math.floor(process.pid % 50)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ceiling on a single API request in these tests.
 *
 * Longer than the readiness probe's 2s, which polls in a loop and is meant to
 * retry quickly. Here the server has already accepted the request, so this is
 * only ever hit by a route that hangs — and it has to clear the slowest honest
 * response, which for a track query means reading the whole store.
 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Install the plugin into a throwaway config dir from a packed tarball.
 *
 * A tarball rather than a link: `npm pack` applies the `files` allowlist, so
 * this fails the same way a user's install would if the build output or
 * package.json `main` were wrong — which is one of the things worth proving.
 */
function installPlugin(configDir: string, repoRoot: string): void {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' })
  const packed = execFileSync('npm', ['pack', '--pack-destination', configDir, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  // npm pack --json has two shapes across versions: an array of results, or an
  // object keyed by filename.
  const parsed: unknown = JSON.parse(packed)
  const filename = Array.isArray(parsed)
    ? (parsed[0] as { filename: string }).filename
    : Object.values(parsed as Record<string, { filename: string }>)[0]?.filename
  if (!filename) {
    throw new Error(`could not read a filename out of npm pack --json: ${packed}`)
  }
  writeFileSync(join(configDir, 'package.json'), JSON.stringify({ name: 'sk-e2e-config', private: true }, null, 2))
  execFileSync('npm', ['install', join(configDir, filename)], { cwd: configDir, stdio: 'pipe' })
}

export interface E2EOptions {
  /** Plugin configuration written to plugin-config-data/tracks.json. */
  config?: Record<string, unknown>
  /** Seconds to wait for the server to answer before giving up. */
  timeoutSeconds?: number
  /**
   * Other plugins to install and enable alongside this one, as
   * `{ 'npm-package-name': pluginConfiguration }`.
   *
   * Used to stand up a real history provider so the bootstrap can be exercised
   * through `getHistoryApi()` — the interface this plugin actually depends on —
   * rather than against a provider's private storage.
   */
  plugins?: Record<string, Record<string, unknown>>
  /** Port to boot on, when a test needs its own server. */
  port?: number
}

export async function startServer(options: E2EOptions = {}): Promise<E2EServer> {
  const repoRoot = process.cwd()
  const configDir = mkdtempSync(join(tmpdir(), 'sk-tracks-e2e-'))
  installPlugin(configDir, repoRoot)

  mkdirSync(join(configDir, 'plugin-config-data'), { recursive: true })
  writeFileSync(
    join(configDir, 'plugin-config-data', 'tracks.json'),
    JSON.stringify(
      {
        enabled: true,
        configuration: {
          resolution: 0,
          pointsToKeep: 1000,
          maxAge: 3600,
          source: 'memory',
          ...options.config,
        },
      },
      null,
      2,
    ),
  )

  for (const [pkg, configuration] of Object.entries(options.plugins ?? {})) {
    execFileSync('npm', ['install', pkg], { cwd: configDir, stdio: 'pipe' })
    // The plugin id is the package name without a scope, which is how the
    // server names the config file.
    const id = pkg.replace(/^@[^/]+\//, '')
    writeFileSync(
      join(configDir, 'plugin-config-data', `${id}.json`),
      JSON.stringify({ enabled: true, configuration }, null, 2),
    )
  }

  const port = options.port ?? basePort
  const child: ChildProcess = spawn('node', ['bin/signalk-server', '-c', configDir], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      // The server's own NMEA and TCP listeners collide with a dev server or
      // the boat's, and a failed bind there would otherwise abort the boot.
      NMEA0183PORT: String(port + 100),
      TCPSTREAMPORT: String(port + 200),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const log: string[] = []
  child.stdout?.on('data', (d: Buffer) => log.push(d.toString()))
  child.stderr?.on('data', (d: Buffer) => log.push(d.toString()))

  const url = `http://localhost:${port}`
  const stop = () => {
    child.kill('SIGTERM')
    rmSync(configDir, { recursive: true, force: true })
  }

  const deadline = Date.now() + (options.timeoutSeconds ?? 60) * 1000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/signalk`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        // Bounded like the probe above it: the server has answered /signalk,
        // but an unbounded fetch here could still hang past the deadline the
        // loop exists to enforce.
        const self = (await (
          await fetch(`${url}/signalk/v1/api/self`, { signal: AbortSignal.timeout(2000) })
        ).json()) as string
        return {
          url,
          configDir,
          selfContext: typeof self === 'string' ? self : `vessels.${String(self)}`,
          feed: (context, position, timestamp, source) => feedDelta(url, context, position, timestamp, source),
          // Both bounded: a route that accepts the connection and then never
          // finishes would otherwise hang the suite on the request rather than
          // failing it, and vitest's own timeout is the wrong place to notice.
          api: async (path: string) => {
            const r = await fetch(`${url}/signalk/v1/api${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
            return r.json()
          },
          apiV2: async (path: string) => {
            const r = await fetch(`${url}/signalk/v2/api${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
            return { status: r.status, body: await r.json() }
          },
          stop,
        }
      }
    } catch {
      // not up yet
    }
    await wait(500)
  }

  stop()
  throw new Error(`signalk-server did not start within the timeout. Output:\n${log.join('')}`)
}

/**
 * Push a position delta over the WebSocket API.
 *
 * Via the real delta path rather than by calling the plugin: that is what makes
 * this an end-to-end test rather than a slower unit test.
 */
async function feedDelta(
  url: string,
  context: string,
  position: [number, number],
  timestamp?: number,
  source = 'e2e.gps',
): Promise<void> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/signalk/v1/stream?subscribe=none`)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('websocket failed to open'))
  })
  ws.send(
    JSON.stringify({
      context,
      updates: [
        {
          $source: source,
          timestamp: new Date(timestamp ?? Date.now()).toISOString(),
          values: [{ path: 'navigation.position', value: { latitude: position[0], longitude: position[1] } }],
        },
      ],
    }),
  )
  // The send is fire-and-forget; give the server a moment to apply it before
  // the socket closes.
  await wait(250)
  ws.close()
}

/**
 * Whether a QuestDB is listening, so the provider tier can skip cleanly.
 *
 * A liveness probe only. What the provider stores, and how, is its own
 * business: this plugin reaches it through `getHistoryApi()` and must keep
 * working across any change to that.
 */
export async function questdbAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${QUESTDB_URL}/`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}
