import { describe, expect, it } from 'vitest'
import { parseDuration, parseTrackQuery, thin, TimeWindowError } from './timeWindow.js'
import type { TimedPosition } from './types.js'

const NOW = Date.parse('2026-08-09T12:00:00Z')
const HOUR = 60 * 60 * 1000

describe('parseDuration', () => {
  it('treats a bare number as seconds', () => {
    expect(parseDuration('30')).toBe(30_000)
  })
  it('accepts s, m, h and d suffixes', () => {
    expect(parseDuration('5s')).toBe(5_000)
    expect(parseDuration('1m')).toBe(60_000)
    expect(parseDuration('2h')).toBe(2 * HOUR)
    expect(parseDuration('1d')).toBe(24 * HOUR)
  })
  it('rejects nonsense', () => {
    expect(() => parseDuration('soon')).toThrow(TimeWindowError)
    expect(() => parseDuration('')).toThrow(TimeWindowError)
    expect(() => parseDuration('5y')).toThrow(TimeWindowError)
  })
})

describe('parseTrackQuery', () => {
  it('returns no window when no time parameters are given', () => {
    expect(parseTrackQuery({}, NOW).window).toBeUndefined()
  })

  it('resolves from/to', () => {
    const { window } = parseTrackQuery({ from: '2026-08-09T10:00:00Z', to: '2026-08-09T11:00:00Z' }, NOW)
    expect(window).toEqual({ from: NOW - 2 * HOUR, to: NOW - HOUR, inclusiveEnd: false })
  })

  it('defaults to now when only from is given, and includes the newest point', () => {
    const { window } = parseTrackQuery({ from: '2026-08-09T11:00:00Z' }, NOW)
    expect(window).toEqual({ from: NOW - HOUR, to: NOW, inclusiveEnd: true })
  })

  it('rejects an inverted range', () => {
    expect(() => parseTrackQuery({ from: '2026-08-09T11:00:00Z', to: '2026-08-09T10:00:00Z' }, NOW)).toThrow(
      TimeWindowError,
    )
  })

  it('rejects an unparseable instant', () => {
    expect(() => parseTrackQuery({ from: 'yesterday' }, NOW)).toThrow(TimeWindowError)
  })

  it('resolves duration as a window ending now', () => {
    expect(parseTrackQuery({ duration: '2h' }, NOW).window).toEqual({
      from: NOW - 2 * HOUR,
      to: NOW,
      inclusiveEnd: true,
    })
  })

  // Freeboard-SK compatibility: timespanOffset is a bare number of hours back
  // from now, and timespan is the length of the window ending there.
  it('resolves the Freeboard timespan/timespanOffset pair', () => {
    expect(parseTrackQuery({ timespan: '1h' }, NOW).window).toEqual({
      from: NOW - HOUR,
      to: NOW,
      inclusiveEnd: true,
    })
    // an offset band ends before now, so it stays half-open and tiles cleanly
    expect(parseTrackQuery({ timespan: '23h', timespanOffset: '1' }, NOW).window).toEqual({
      from: NOW - 24 * HOUR,
      to: NOW - HOUR,
      inclusiveEnd: false,
    })
  })

  it('tiles the three Freeboard bands without gaps or overlap', () => {
    const beyond24 = parseTrackQuery({ timespan: '24h', timespanOffset: '24' }, NOW).window
    const next23 = parseTrackQuery({ timespan: '23h', timespanOffset: '1' }, NOW).window
    const lastHour = parseTrackQuery({ timespan: '1h' }, NOW).window

    expect(beyond24?.to).toBe(next23?.from)
    expect(next23?.to).toBe(lastHour?.from)
    expect(lastHour?.to).toBe(NOW)
  })

  it('prefers from/to over duration and timespan', () => {
    const { window } = parseTrackQuery({ from: '2026-08-09T11:00:00Z', duration: '5h', timespan: '9h' }, NOW)
    expect(window).toEqual({ from: NOW - HOUR, to: NOW, inclusiveEnd: true })
  })

  it('parses resolution as a duration in milliseconds', () => {
    expect(parseTrackQuery({ resolution: '5s' }, NOW).resolution).toBe(5_000)
    expect(parseTrackQuery({ resolution: '1m' }, NOW).resolution).toBe(60_000)
    // Freeboard also sends bare numbers for resolution elsewhere in the API
    expect(parseTrackQuery({ resolution: '60' }, NOW).resolution).toBe(60_000)
  })

  it('ignores a zero resolution rather than thinning everything away', () => {
    expect(parseTrackQuery({ resolution: '0' }, NOW).resolution).toBeUndefined()
  })

  it('takes the first value when express repeats a parameter', () => {
    expect(parseTrackQuery({ timespan: ['1h', '9h'] }, NOW).window).toEqual({
      from: NOW - HOUR,
      to: NOW,
      inclusiveEnd: true,
    })
  })
})

describe('thin', () => {
  const points = (...offsets: number[]): TimedPosition[] =>
    offsets.map((offset) => ({ position: [offset, offset], timestamp: NOW + offset }))

  it('returns everything when no resolution is set', () => {
    const p = points(0, 1, 2)
    expect(thin(p, undefined)).toEqual(p)
  })

  it('drops points closer together than the resolution', () => {
    const p = points(0, 100, 200, 1000, 1100, 2000)
    expect(thin(p, 1000).map((x) => x.timestamp - NOW)).toEqual([0, 1000, 2000])
  })

  it('always keeps the last point so the track keeps its extent', () => {
    const p = points(0, 100, 200)
    const result = thin(p, 1000)
    expect(result[0]?.timestamp).toBe(NOW)
    expect(result[result.length - 1]?.timestamp).toBe(NOW + 200)
  })

  it('leaves one- and two-point tracks alone', () => {
    expect(thin(points(0), 1000)).toHaveLength(1)
    expect(thin(points(0, 1), 1000)).toHaveLength(2)
  })
})
