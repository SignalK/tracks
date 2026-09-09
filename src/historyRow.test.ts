import { describe, expect, it } from 'vitest'
import { historyRowPosition } from './utils.js'

// Both encodings are legal — the History API types a value as `unknown` and
// names objects like navigation.position explicitly — so signalk-questdb's
// `{latitude, longitude}` and signalk-to-influxdb2's `[lon, lat]` both have to
// work. Rejecting one returns an empty track rather than an error, so it fails
// silently.
describe('historyRowPosition', () => {
  it('accepts {latitude, longitude}, as signalk-questdb returns', () => {
    expect(historyRowPosition(['2026-01-01T00:00:00Z', { latitude: 60.1, longitude: 24.9 }])).toEqual([60.1, 24.9])
  })

  it('accepts a [lon, lat] pair, as the History API documents', () => {
    expect(historyRowPosition(['2026-01-01T00:00:00Z', [24.9, 60.1]])).toEqual([60.1, 24.9])
  })

  it('rejects a row that carries no usable position', () => {
    for (const row of [
      undefined,
      null,
      [],
      ['2026-01-01T00:00:00Z'],
      ['2026-01-01T00:00:00Z', null],
      ['2026-01-01T00:00:00Z', { latitude: 60.1 }],
      ['2026-01-01T00:00:00Z', ['60.1', '24.9']],
      ['2026-01-01T00:00:00Z', [1, 2, 3]],
      // NaN and Infinity are numbers, so a typeof check lets them through. One
      // in a coordinate reaches the store and stretches every bounding box that
      // track appears in, silently.
      ['2026-01-01T00:00:00Z', [NaN, 60.1]],
      ['2026-01-01T00:00:00Z', [24.9, Infinity]],
      ['2026-01-01T00:00:00Z', { latitude: NaN, longitude: 24.9 }],
      ['2026-01-01T00:00:00Z', { latitude: 60.1, longitude: -Infinity }],
    ]) {
      expect(historyRowPosition(row), JSON.stringify(row)).toBeUndefined()
    }
  })
})
