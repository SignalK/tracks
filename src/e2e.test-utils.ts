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
 * backfill tests, a running QuestDB.
 */

/** Where the signalk-server checkout lives. Override with SIGNALK_SERVER_DIR. */
const SERVER_DIR = process.env.SIGNALK_SERVER_DIR ?? join(process.env.HOME ?? '', 'dev/xxx_signalk-server')

/** QuestDB HTTP endpoint for the backfill tier. */
export const QUESTDB_URL = process.env.QUESTDB_URL ?? 'http://localhost:9000'

export interface E2EServer {
  url: string
  configDir: string
  /** Send a position delta as a provider would, over the WebSocket API. */
  feed: (context: string, position: [number, number], timestamp?: number, source?: string) => Promise<void>
  /** GET a path under /signalk/v1/api and parse the JSON. */
  api: (path: string) => Promise<unknown>
  stop: () => void
}

/** A port unlikely to collide with a dev server or the boat's own services. */
const basePort = 4700 + Math.floor(process.pid % 50)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

  const port = basePort
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
        return {
          url,
          configDir,
          feed: (context, position, timestamp, source) => feedDelta(url, context, position, timestamp, source),
          api: async (path: string) => {
            const r = await fetch(`${url}/signalk/v1/api${path}`)
            return r.json()
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

/** Run a SQL statement against QuestDB's HTTP endpoint. */
export async function questdb(sql: string): Promise<{ dataset: unknown[][] }> {
  const res = await fetch(`${QUESTDB_URL}/exec?query=${encodeURIComponent(sql)}`)
  if (!res.ok) {
    throw new Error(`QuestDB rejected the query (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as { dataset: unknown[][] }
}

/** Whether QuestDB is reachable, so the backfill tier can skip cleanly. */
export async function questdbAvailable(): Promise<boolean> {
  try {
    await questdb('SELECT 1')
    return true
  } catch {
    return false
  }
}
