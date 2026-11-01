import { describe, expect, it } from 'vitest'
import { segment } from './timeWindow.js'
import { timedTracksJson } from './timedTracksJson.js'
import type { TimedTrackCollection } from './types.js'
import { toIsoTimes } from './utils.js'

const decode = (bytes: Uint8Array): unknown => JSON.parse(`{${new TextDecoder().decode(bytes)}}`)

describe('timedTracksJson', () => {
  const tracks: TimedTrackCollection = {
    'vessels.a': [
      { position: [60.1, 24.9], timestamp: Date.UTC(2026, 10, 1, 12, 0, 0) },
      { position: [60.2, 24.8], timestamp: Date.UTC(2026, 10, 1, 12, 0, 10) },
      { position: [60.3, 24.7], timestamp: Date.UTC(2026, 10, 1, 13, 0, 0) },
    ],
    'vessels.b': [],
  }

  it('gives each vessel the coordinates, in [lng, lat] order, and times the list answered with', () => {
    const fragments = timedTracksJson(tracks, 60_000)
    const segments = segment(tracks['vessels.a']!, 60_000)

    expect(decode(fragments['vessels.a']!)).toEqual({
      coordinates: segments.map((s) => s.map(({ position: [lat, lng] }) => [lng, lat])),
      times: segments.map(toIsoTimes),
    })
    expect(segments).toHaveLength(2)
  })

  it('leaves out a vessel with nothing in the window', () => {
    expect(Object.keys(timedTracksJson(tracks, 0))).toEqual(['vessels.a'])
  })

  it('owns the buffer of each fragment, so the worker can transfer it', () => {
    const fragment = timedTracksJson(tracks, 0)['vessels.a']!
    expect(fragment.byteOffset).toBe(0)
    expect(fragment.buffer.byteLength).toBe(fragment.byteLength)
  })
})
