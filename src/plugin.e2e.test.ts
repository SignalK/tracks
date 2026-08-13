import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from './e2e.test-utils.js'
import type { E2EServer } from './e2e.test-utils.js'

/**
 * The plugin inside a real Signal K server.
 *
 * Run with `npm run test:e2e`; excluded from the default suite because it needs
 * a built server checkout at SIGNALK_SERVER_DIR.
 */

const CTX = 'vessels.urn:mrn:imo:mmsi:244170001'
const MINUTE = 60_000

interface TrackResponse {
  type: string
  coordinates: [number, number][][]
  times?: string[][]
  isSelf?: boolean
  context?: string
}

let server: E2EServer

beforeAll(async () => {
  server = await startServer({ config: { segmentGapMinutes: 5 } })
}, 180_000)

afterAll(() => {
  server?.stop()
})

describe('the server loads and mounts the plugin', () => {
  it('serves the track API under /signalk/v1/api', async () => {
    // Proves what the unit suite cannot: the server resolved the packaged
    // plugin by directory, imported it, and mounted signalKApiRoutes.
    await expect(server.api('/tracks')).resolves.toEqual({})
  })
})

describe('positions arriving as deltas', () => {
  it('reaches the plugin through the real streambundle', async () => {
    const t0 = Date.now() - 10 * MINUTE
    await server.feed(CTX, [60.1, 24.9], t0)
    await server.feed(CTX, [60.11, 24.91], t0 + MINUTE)

    const tracks = (await server.api('/tracks')) as Record<string, TrackResponse>
    expect(Object.keys(tracks)).toContain(CTX)
    expect(tracks[CTX]?.type).toBe('MultiLineString')
  })

  it('files points at the delta timestamp, not arrival time', async () => {
    // Both positions are sent now but dated ten minutes ago; a time window
    // around the delta timestamps must find them.
    const t0 = Date.now() - 10 * MINUTE
    const from = new Date(t0 - MINUTE).toISOString()
    const to = new Date(t0 + 5 * MINUTE).toISOString()

    const track = (await server.api(`/vessels/${CTX.replace('vessels.', '')}/track?from=${from}&to=${to}&times`)) as
      TrackResponse | undefined

    expect(track?.times?.[0]?.length).toBeGreaterThan(0)
  })

  it('serves per-point times through the real server', async () => {
    const track = (await server.api(`/vessels/${CTX.replace('vessels.', '')}/track?times`)) as TrackResponse

    expect(track.times).toBeDefined()
    expect(track.times?.[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(track.times?.[0]?.length).toBe(track.coordinates[0]?.length)
  })

  it('reports the context and isSelf', async () => {
    const track = (await server.api(`/vessels/${CTX.replace('vessels.', '')}/track`)) as TrackResponse

    expect(track.context).toBe(CTX)
    // The fed vessel is not the server's own, which has no position here.
    expect(track.isSelf).toBe(false)
  })

  it('distinguishes vessels in the all-tracks listing', async () => {
    const other = 'vessels.urn:mrn:imo:mmsi:244170002'
    await server.feed(other, [59.5, 24.2], Date.now() - MINUTE)

    const tracks = (await server.api('/tracks?times')) as Record<string, TrackResponse>

    expect(Object.keys(tracks).sort()).toEqual([CTX, other].sort())
    for (const context of Object.keys(tracks)) {
      expect(tracks[context]?.isSelf).toBe(false)
      expect(tracks[context]?.times).toBeDefined()
    }
  })
})

describe('query parameters through the real server', () => {
  it('400s on an invalid time window rather than 500ing', async () => {
    const res = await fetch(`${server.url}/signalk/v1/api/tracks?from=not-a-date`)
    expect(res.status).toBe(400)
  })

  it('excludes everything with a window in the far past', async () => {
    const track = (await server.api(
      `/vessels/${CTX.replace('vessels.', '')}/track?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z`,
    )) as TrackResponse

    expect(track.coordinates).toEqual([])
  })
})
