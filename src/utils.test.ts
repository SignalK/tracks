import { describe, expect, it } from 'vitest'
import {
  clipToBounds,
  createCrossesBounds,
  createInBounds,
  createReachesBounds,
  resolveContext,
  toIsoTimes,
  validateParameters,
  QueryParameterError,
  SelfPositionUnavailableError,
  createMatcher,
  trackLabel,
  contextName,
  gpxFilename,
  asciiFilename,
  rfc8187,
  longitudeSpan,
  longitudeSpanOf,
  fillGaps,
  MIN_FILLED_GAP_MS,
  mergeSpan,
  subtractSpans,
  withinSpans,
} from './utils.js'
import type { LatLngTuple, TimedPosition, TrackParams } from './types.js'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789'

describe('resolveContext', () => {
  it('resolves the self alias to the self context', () => {
    expect(resolveContext('self', SELF)).toBe(SELF)
    expect(resolveContext('vessels.self', SELF)).toBe(SELF)
  })
  it('qualifies a bare vessel id', () => {
    expect(resolveContext('urn:mrn:imo:mmsi:987654321', SELF)).toBe('vessels.urn:mrn:imo:mmsi:987654321')
  })
  it('leaves an already qualified context alone', () => {
    expect(resolveContext('vessels.urn:mrn:imo:mmsi:987654321', SELF)).toBe('vessels.urn:mrn:imo:mmsi:987654321')
  })
  it('falls back to the literal id when selfContext is unavailable', () => {
    expect(resolveContext('self', undefined)).toBe('vessels.self')
  })
})

describe('inBounds', () => {
  it('works for bounds', () => {
    const inBounds = createInBounds({ sw: [-10, -10], ne: [10, 175] })
    expect(inBounds([-11, 176])).toBe(false)
    expect(inBounds([-9, 174])).toBe(true)
    expect(inBounds([-9, 176])).toBe(false)
    expect(inBounds([+9, -11])).toBe(false)
    expect(inBounds([+9, -10])).toBe(true)
  })
  it('works for bounds crossing dateline', () => {
    const inBounds = createInBounds({ sw: [-10, 175], ne: [10, -175] })
    expect(inBounds([-11, 176])).toBe(false)
    expect(inBounds([-9, 176])).toBe(true)
    expect(inBounds([-9, -176])).toBe(true)
    expect(inBounds([-9, -174])).toBe(false)
    expect(inBounds([+9, -174])).toBe(false)
    expect(inBounds([+9, -176])).toBe(true)
    expect(inBounds([+11, -176])).toBe(false)
  })
})

describe('clipToBounds', () => {
  const track = (...positions: LatLngTuple[]): TimedPosition[] =>
    positions.map((position, i) => ({ position, timestamp: i * 60_000 }))
  const shape = (points: TimedPosition[]) => points.map(({ position, breakBefore }) => [position, !!breakBefore])
  const box = { sw: [60, 24], ne: [61, 25] } as const

  it('keeps the stretch inside and the one point either side of it', () => {
    const points = track([59, 23], [59.5, 23.5], [60.2, 24.2], [60.5, 24.5], [61.5, 25.5], [62, 26])
    expect(shape(clipToBounds(points, { sw: [...box.sw], ne: [...box.ne] }))).toEqual([
      [[59.5, 23.5], false],
      [[60.2, 24.2], false],
      [[60.5, 24.5], false],
      [[61.5, 25.5], false],
    ])
  })

  it('starts a new stretch on each re-entry, sharing the outside point between them', () => {
    const points = track([60.2, 24.2], [62, 26], [60.5, 24.5], [60.6, 24.6])
    expect(shape(clipToBounds(points, { sw: [...box.sw], ne: [...box.ne] }))).toEqual([
      [[60.2, 24.2], false],
      [[62, 26], false],
      [[62, 26], true],
      [[60.5, 24.5], false],
      [[60.6, 24.6], false],
    ])
  })

  it('clips to a box crossing the antimeridian', () => {
    const points = track([0, 170], [0, 179.5], [0, -179.5], [0, -170])
    expect(shape(clipToBounds(points, { sw: [-1, 179], ne: [1, -179] }))).toEqual([
      [[0, 170], false],
      [[0, 179.5], false],
      [[0, -179.5], false],
      [[0, -170], false],
    ])
    // Neither point is inside, but the line between them runs through the box.
    expect(shape(clipToBounds(track([0, 170], [0, -170]), { sw: [-1, 179], ne: [1, -179] }))).toEqual([
      [[0, 170], false],
      [[0, -170], false],
    ])
    expect(clipToBounds(track([2, 170], [2, -170]), { sw: [-1, 179], ne: [1, -179] })).toEqual([])
  })

  it('keeps a line that crosses the box between two points outside it, as a stretch of its own', () => {
    const points = track([60.2, 24.2], [62, 26], [59, 23], [59, 22])
    expect(shape(clipToBounds(points, { sw: [...box.sw], ne: [...box.ne] }))).toEqual([
      [[60.2, 24.2], false],
      [[62, 26], false],
      [[62, 26], true],
      [[59, 23], false],
    ])
  })

  it('draws no line into a point that starts a new one', () => {
    // The line from the second point to the third runs through the box, but
    // the third starts a new line, as does the last.
    const points: TimedPosition[] = [
      { position: [60.5, 24.5], timestamp: 0 },
      { position: [60.5, 25.5], timestamp: 60_000 },
      { position: [60.5, 23.5], timestamp: 120_000, breakBefore: true },
      { position: [60.5, 24.4], timestamp: 180_000 },
      { position: [60.6, 24.6], timestamp: 240_000, breakBefore: true },
    ]
    expect(shape(clipToBounds(points, { sw: [...box.sw], ne: [...box.ne] }))).toEqual([
      [[60.5, 24.5], false],
      [[60.5, 25.5], false],
      [[60.5, 23.5], true],
      [[60.5, 24.4], false],
      [[60.6, 24.6], true],
    ])
    // Nor out of the box: a stretch inside ends at its last point there.
    const leaving: TimedPosition[] = [
      { position: [60.5, 24.5], timestamp: 0 },
      { position: [62, 26], timestamp: 60_000, breakBefore: true },
    ]
    expect(shape(clipToBounds(leaving, { sw: [...box.sw], ne: [...box.ne] }))).toEqual([[[60.5, 24.5], false]])
  })

  it('leaves out a line that passes beside the box', () => {
    expect(clipToBounds(track([59, 23], [59.5, 26], [62, 26]), { sw: [...box.sw], ne: [...box.ne] })).toEqual([])
  })

  it('returns a track that never leaves the box unchanged', () => {
    const points = track([60.2, 24.2], [60.5, 24.5])
    expect(clipToBounds(points, { sw: [...box.sw], ne: [...box.ne] })).toEqual(points)
  })
})

describe('validateParameters', () => {
  it('parses a four-value bbox', () => {
    expect(validateParameters({ bbox: '-20,-10,20,10' }, undefined).bbox).toEqual({
      sw: [-10, -20],
      ne: [10, 20],
    })
  })

  // A coordinate of 0 is valid (equator / prime meridian) but falsy, so a
  // truthiness-based filter used to silently drop it and reject the whole bbox.
  it('keeps zero coordinates', () => {
    expect(validateParameters({ bbox: '0,0,20,10' }, undefined).bbox).toEqual({
      sw: [0, 0],
      ne: [10, 20],
    })
  })

  // GeoJSON order, matching the coordinates these endpoints emit, the
  // Resources API and the v2 Track API. It was latitude-first until then,
  // which is why a v2 example sent here used to match nothing.
  it('reads the bbox as west,south,east,north', () => {
    // South Australia: longitudes 130..139, latitudes -35..-33
    const { bbox } = validateParameters({ bbox: '130,-35,139,-33' }, undefined)

    expect(bbox).toEqual({ sw: [-35, 130], ne: [-33, 139] })

    const inBounds = createInBounds(bbox!)
    expect(inBounds([-34, 135])).toBe(true) // inside
    expect(inBounds([135, -34])).toBe(false) // the same point written lat-first
  })

  // Thrown, not dropped: a bbox that yields null skips the filter entirely and
  // answers with every track, so a typo silently returns more than was asked
  // for. Absent stays absent -- no bbox is not an error.
  it('rejects a bbox that is not four finite numbers', () => {
    expect(() => validateParameters({ bbox: '1,2,3' }, undefined)).toThrow(QueryParameterError)
    expect(() => validateParameters({ bbox: '1,2,3,abc' }, undefined)).toThrow(QueryParameterError)
    expect(() => validateParameters({ bbox: '' }, undefined)).toThrow(QueryParameterError)
  })

  // #80. createInBounds throws on an inverted box, which the route's catch
  // reported as 404 -- a malformed query impersonating an empty result.
  it('rejects a bbox whose south exceeds its north', () => {
    expect(() => validateParameters({ bbox: '24,61,26,59' }, undefined)).toThrow(
      /bbox south \(61\) must not be greater than north \(59\)/,
    )
  })

  it('leaves an absent bbox unfiltered', () => {
    expect(validateParameters({}, undefined).bbox).toBeNull()
  })

  it('parses radius and falls back to the configured default', () => {
    expect(validateParameters({ radius: '500' }, 1000).radius).toBe(500)
    expect(validateParameters({}, 1000).radius).toBe(1000)
    expect(validateParameters({}, undefined).radius).toBeNull()
  })

  it('keeps an explicit radius of zero rather than the default', () => {
    expect(validateParameters({ radius: '0' }, 1000).radius).toBe(0)
  })

  // Thrown rather than dropped, for the same reason as the bbox: a radius that
  // yields null skips the filter and answers with every track.
  it('rejects a radius that is not a number', () => {
    expect(() => validateParameters({ radius: 'abc' }, undefined)).toThrow(QueryParameterError)
    expect(() => validateParameters({ radius: '' }, undefined)).toThrow(QueryParameterError)
    expect(() => validateParameters({ radius: 'Infinity' }, undefined)).toThrow(QueryParameterError)
  })

  // A negative radius matched nothing at all -- an empty result for a query
  // that cannot be satisfied, which reads as "no vessels near you".
  it('rejects a negative radius', () => {
    expect(() => validateParameters({ radius: '-5' }, undefined)).toThrow(/must not be negative/)
  })

  it('takes the first value when express repeats a query parameter', () => {
    expect(validateParameters({ radius: ['500', '900'] }, undefined).radius).toBe(500)
  })
})

describe('toIsoTimes', () => {
  const at = (timestamp: number) => ({ position: [60, 24] as [number, number], timestamp })

  it('formats epoch milliseconds as ISO-8601 UTC', () => {
    expect(toIsoTimes([at(Date.UTC(2026, 7, 14, 9, 0, 0))])).toEqual(['2026-08-14T09:00:00.000Z'])
  })

  it('is positionally aligned with the segment it came from', () => {
    const segment = [at(0), at(1000), at(2000)]
    expect(toIsoTimes(segment)).toHaveLength(segment.length)
  })

  it('renders a non-UTC recording time in UTC', () => {
    // A track outlives the zone it was recorded in, so the wire format is
    // always UTC regardless of the server's local time.
    expect(toIsoTimes([at(Date.parse('2026-08-14T09:00:00+12:00'))])).toEqual(['2026-08-13T21:00:00.000Z'])
  })

  it('returns nothing for an empty segment', () => {
    expect(toIsoTimes([])).toEqual([])
  })
})

// The v2 Track API's contextName: "Name of the vessel, aircraft or other
// context, where known. Not a name for the track itself." Bare, so a client
// can decorate it however it likes -- which is why it is separate from
// trackLabel below.
describe('contextName', () => {
  const SELF = 'vessels.urn:mrn:imo:mmsi:211111111'
  const OTHER = 'vessels.urn:mrn:imo:mmsi:244813000'
  const none = () => undefined

  it('is the bare vessel name, undecorated', () => {
    expect(contextName(OTHER, (p: string) => (p === `${OTHER}.name` ? 'Ariadne' : undefined))).toBe('Ariadne')
  })

  // trackLabel turns the own vessel into `Own Ship`; contextName must not,
  // because the v2 field names the vessel rather than the track.
  it('does not special-case the own vessel', () => {
    expect(contextName(SELF, (p: string) => (p === `${SELF}.name` ? 'Ariadne' : undefined))).toBe('Ariadne')
  })

  it('accepts the {value} wrapper as well as a bare string', () => {
    expect(contextName(OTHER, (p: string) => (p === `${OTHER}.name` ? { value: 'Ariadne' } : undefined))).toBe(
      'Ariadne',
    )
  })

  // An MMSI is how a vessel is addressed, not what it is called. The server's
  // own findContextName resolves `name` and nothing else, and "where known"
  // means an absent field -- so the MMSI fallback lives in trackLabel instead.
  it('is undefined when the vessel has no name, even with an mmsi', () => {
    expect(contextName(OTHER, (p: string) => (p === `${OTHER}.mmsi` ? '244813000' : undefined))).toBeUndefined()
  })

  it('is undefined when nothing is known', () => {
    expect(contextName('vessels.urn:mrn:signalk:uuid:abc', none)).toBeUndefined()
  })
})

describe('trackLabel', () => {
  const SELF = 'vessels.urn:mrn:imo:mmsi:211111111'
  const OTHER = 'vessels.urn:mrn:imo:mmsi:244813000'
  const none = () => undefined

  it('names the own vessel Own Ship', () => {
    expect(trackLabel(SELF, SELF, none)).toBe('Own Ship')
  })

  it('prefixes another vessel with AIS, as a plotter does', () => {
    expect(trackLabel(OTHER, SELF, (p: string) => (p === `${OTHER}.name` ? 'MIA' : undefined))).toBe('AIS MIA')
  })

  // The full data model holds `name` as a bare string, while deltas carry the
  // {value} wrapper. Reading only one shape yields the MMSI fallback for a
  // vessel whose name is perfectly well known.
  it('accepts the {value} wrapper as well as a bare string', () => {
    expect(trackLabel(OTHER, SELF, (p: string) => (p === `${OTHER}.name` ? { value: 'MIA' } : undefined))).toBe(
      'AIS MIA',
    )
  })

  it('falls back to the mmsi from the data model', () => {
    expect(trackLabel(OTHER, SELF, (p: string) => (p === `${OTHER}.mmsi` ? '244813000' : undefined))).toBe(
      'AIS 244813000',
    )
  })

  // A vessel can be tracked before any static report arrives, so the context is
  // all there is. Two unnamed vessels must still be distinguishable.
  it('falls back to the mmsi parsed out of the context', () => {
    expect(trackLabel(OTHER, SELF, none)).toBe('AIS 244813000')
  })

  it('falls back to the context when there is no mmsi anywhere', () => {
    const odd = 'vessels.urn:mrn:signalk:uuid:abc'
    expect(trackLabel(odd, SELF, none)).toBe(odd)
  })

  it('ignores a blank name rather than rendering "AIS "', () => {
    expect(trackLabel(OTHER, SELF, (p: string) => (p === `${OTHER}.name` ? '   ' : undefined))).toBe('AIS 244813000')
  })

  // Without selfContext there is nothing to compare against, so the own vessel
  // is labelled like any other target rather than guessed at.
  it('falls back to the mmsi when selfContext is unknown', () => {
    expect(trackLabel(SELF, undefined, none)).toBe('AIS 211111111')
  })
})

describe('gpxFilename', () => {
  it.each([
    ['Own Ship', 'Own-Ship.gpx'],
    ['AIS MIA', 'AIS-MIA.gpx'],
  ])('turns %s into a filename', (label, expected) => {
    expect(gpxFilename(label)).toBe(expected)
  })

  // A vessel name arrives from an AIS transmission: it must not be able to
  // escape the downloads folder or break out of the header it travels in.
  it.each([
    ['a path traversal', '../../etc/passwd'],
    ['a quote', 'a"b'],
    ['a backslash', 'a\\b'],
    ['a control character', 'a\u0000b'],
  ])('neutralises %s', (_kind, label) => {
    const name = gpxFilename(label)

    const unsafe = [...name].filter((character) => '/\\"\''.includes(character) || character < ' ')

    expect(unsafe).toEqual([])
    expect(name.startsWith('.')).toBe(false)
    expect(name.endsWith('.gpx')).toBe(true)
  })

  // Replacing everything outside ASCII would quietly rename somebody's boat.
  it.each([
    ['Ärger', 'Ärger.gpx'],
    ['日本', '日本.gpx'],
  ])('keeps non-ASCII in %s', (label, expected) => {
    expect(gpxFilename(label)).toBe(expected)
  })

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['only separators', '///'],
  ])('falls back for a %s name', (_kind, label) => {
    expect(gpxFilename(label)).toBe('track.gpx')
  })
})

describe('asciiFilename', () => {
  it('leaves an ASCII filename alone', () => {
    expect(asciiFilename('AIS-Ariadne.gpx')).toBe('AIS-Ariadne.gpx')
  })

  // An HTTP header carries bytes: anything outside Latin-1 makes setHeader
  // throw, and anything outside ASCII is reinterpreted byte-wise by the
  // client, so the quoted form has to be ASCII even though the real name
  // travels in filename*.
  it.each([
    ['an umlaut', 'AIS-Ärger.gpx'],
    ['CJK', '日本.gpx'],
    ['an emoji', 'boat-🚢.gpx'],
  ])('replaces %s', (_kind, filename) => {
    const result = asciiFilename(filename)

    expect([...result].every((character) => character < '\u0080')).toBe(true)
    expect(result.endsWith('.gpx')).toBe(true)
  })

  // Pinned exactly, because "all ASCII and ends in .gpx" holds for almost any
  // mangling -- including ones that leave a leading dash or an empty stem.
  it.each([
    ['AIS-Ärger.gpx', 'AIS-rger.gpx'],
    ['AIS-Ariadne.gpx', 'AIS-Ariadne.gpx'],
    ['Ärger.gpx', 'rger.gpx'],
  ])('renders %s as %s', (filename, expected) => {
    expect(asciiFilename(filename)).toBe(expected)
  })

  it.each([['日本.gpx'], ['.gpx'], ['🚢.gpx']])('falls back for %s, where nothing readable survives', (filename) => {
    expect(asciiFilename(filename)).toBe('track.gpx')
  })

  it('never leaves a leading dash', () => {
    expect(asciiFilename('Ärger.gpx').startsWith('-')).toBe(false)
  })
})

describe('rfc8187', () => {
  it('leaves an unreserved name alone', () => {
    expect(rfc8187('AIS-Ariadne.gpx')).toBe('AIS-Ariadne.gpx')
  })

  // encodeURIComponent is close but not exact: it leaves !'()* unescaped, and
  // RFC 8187's attr-char set excludes them, so a vessel called `Boat (Test)`
  // would put raw parentheses into the header.
  it.each([
    ['parentheses', 'Boat (Test).gpx'],
    ['an apostrophe', "L'ILE.gpx"],
    ['an asterisk', 'Star*.gpx'],
    ['an exclamation mark', 'Hey!.gpx'],
  ])('escapes %s', (_kind, filename) => {
    expect(rfc8187(filename)).not.toMatch(/[!'()*]/)
  })

  it('percent-encodes non-ASCII as UTF-8', () => {
    expect(rfc8187('日本.gpx')).toBe('%E6%97%A5%E6%9C%AC.gpx')
  })
})

describe('createCrossesBounds', () => {
  const crosses = createCrossesBounds({ sw: [60, 24], ne: [61, 25] })

  it('finds a line through the box, a corner or an edge of it', () => {
    expect(crosses([59, 23], [62, 26])).toBe(true)
    expect(crosses([59.9, 24.5], [60.1, 23.9])).toBe(true)
    expect(crosses([59, 24], [60, 24])).toBe(true)
    expect(crosses([59, 23], [59.5, 26])).toBe(false)
    expect(crosses([59.9, 23.9], [59.9, 23.9])).toBe(false)
  })

  it('takes a line across the antimeridian the short way round', () => {
    const nearGreenwich = createCrossesBounds({ sw: [-1, 0], ne: [1, 10] })
    expect(nearGreenwich([0, 170], [0, -170])).toBe(false)
    const nearFiji = createCrossesBounds({ sw: [-1, 179], ne: [1, -179] })
    expect(nearFiji([0, 170], [0, -170])).toBe(true)
    expect(nearFiji([0, -170], [0, 170])).toBe(true)
    expect(createCrossesBounds({ sw: [-1, 175], ne: [1, 178] })([0, -170], [0, 170])).toBe(true)
  })
})

describe('createReachesBounds', () => {
  const reaches = createReachesBounds({ sw: [60, 24], ne: [61, 25] })
  const at = (position: LatLngTuple, breakBefore?: true): TimedPosition => ({
    position,
    timestamp: 0,
    ...(breakBefore ? { breakBefore } : {}),
  })

  it('finds a point inside or a line through, but not a line a break leaves undrawn', () => {
    expect(reaches([at([59, 23]), at([60.5, 24.5])])).toBe(true)
    expect(reaches([at([59, 23]), at([62, 26])])).toBe(true)
    expect(reaches([at([59, 23]), at([62, 26], true)])).toBe(false)
    expect(reaches([at([59, 23]), at([59.5, 26])])).toBe(false)
  })
})

describe('createMatcher', () => {
  it('matches a track that crosses the box between two points outside it', () => {
    const params = { bbox: { sw: [60, 24], ne: [61, 25] }, radius: null, intersects: true } as TrackParams
    const matches = createMatcher(params, undefined)
    expect(
      matches([
        [59, 23],
        [62, 26],
      ]),
    ).toBe(true)
    expect(
      matches([
        [59, 23],
        [59.5, 26],
      ]),
    ).toBe(false)
    // The last position, as v1 asks, is still a point.
    expect(
      createMatcher(
        { ...params, intersects: false },
        undefined,
      )([
        [59, 23],
        [62, 26],
      ]),
    ).toBe(false)
  })

  // The query is well-formed; the server just has no position to measure from.
  // Distinct from a malformed radius, and reported differently.
  it('signals an outage when a radius query has no self position', () => {
    const params = validateParameters({ radius: '500' }, undefined)

    expect(() => createMatcher(params, undefined)).toThrow(SelfPositionUnavailableError)
  })
})

describe('longitudeSpanOf', () => {
  const extremesOf = (longitudes: number[]) => {
    const east = longitudes.filter((lon) => lon >= 0)
    const west = longitudes.filter((lon) => lon < 0)
    return {
      lowest: Math.min(...longitudes),
      highest: Math.max(...longitudes),
      lowestEast: east.length > 0 ? Math.min(...east) : null,
      highestWest: west.length > 0 ? Math.max(...west) : null,
    }
  }
  const width = ([west, east]: [number, number]) => (east >= west ? east - west : east + 360 - west)
  /** Deterministic, so a failure names the same longitudes on every run. */
  const random = (() => {
    let seed = 1
    return () => {
      seed = (seed * 48271) % 2147483647
      return seed / 2147483647
    }
  })()
  const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180

  it.each([
    ['one point', [24.9]],
    ['east of the prime meridian', [24.9, 25.2, 25]],
    ['across the prime meridian', [-1.5, 0.5, 2]],
    ['across the antimeridian', [179.5, -179.6, 179.9]],
    ['on the prime meridian', [0, 120, 170]],
    ['on the antimeridian', [-180, -170, 175]],
    ['west only', [-120, -100, -60]],
  ])('gives what every longitude gives for a track %s', (_kind, longitudes) => {
    expect(longitudeSpanOf(extremesOf(longitudes))).toEqual(longitudeSpan(longitudes))
  })

  it('agrees with every longitude for any track narrower than half the globe', () => {
    for (let run = 0; run < 2000; run++) {
      const start = random() * 360 - 180
      const extent = random() * 179.9
      const longitudes = Array.from({ length: 2 + Math.floor(random() * 8) }, () => wrap(start + random() * extent))
      expect(longitudeSpanOf(extremesOf(longitudes)), longitudes.join(', ')).toEqual(longitudeSpan(longitudes))
    }
  })

  it('leaves a track with a longitude outside ±180 to every longitude', () => {
    // Every longitude bounds this one as [409.1, 118.5]; its extremes would say [118.5, -138.6].
    expect(longitudeSpanOf(extremesOf([409.1, -138.6, 118.5]))).toBeUndefined()
    expect(longitudeSpanOf(extremesOf([-200, 10, 20]))).toBeUndefined()
    for (let run = 0; run < 2000; run++) {
      const longitudes = Array.from({ length: 2 + Math.floor(random() * 6) }, () =>
        random() < 0.3 ? random() * 1080 - 540 : random() * 360 - 180,
      )
      const span = longitudeSpanOf(extremesOf(longitudes))
      if (span !== undefined) {
        expect(span, longitudes.join(', ')).toEqual(longitudeSpan(longitudes))
      }
    }
  })

  it('leaves a track half the globe wide or wider to every longitude', () => {
    // The widest gap here lies between -150 and -30, clear of both meridians.
    expect(longitudeSpanOf(extremesOf([-150, -30, 20, 120]))).toBeUndefined()
    expect(longitudeSpanOf(extremesOf([-90, 0, 90]))).toBeUndefined()
    for (let run = 0; run < 2000; run++) {
      const longitudes = Array.from({ length: 2 + Math.floor(random() * 8) }, () => wrap(random() * 360))
      if (width(longitudeSpan(longitudes)) >= 180) {
        expect(longitudeSpanOf(extremesOf(longitudes)), longitudes.join(', ')).toBeUndefined()
      }
    }
  })
})

describe('fillGaps', () => {
  const at = (...minutes: number[]): TimedPosition[] =>
    minutes.map((m) => ({ position: [60, 24], timestamp: m * 60_000 }))
  const minutesOf = (runs: TimedPosition[][]) => runs.map((run) => run.map(({ timestamp }) => timestamp / 60_000))

  it('starts a new run at each recorded stretch and segment boundary', () => {
    const { runs } = fillGaps([at(1, 2, 12, 13), at(14)], at(6, 7), MIN_FILLED_GAP_MS)
    expect(minutesOf(runs)).toEqual([[1, 2], [12, 13], [14]])
  })

  it('fills everything when nothing is recorded', () => {
    expect(fillGaps([at(1, 2)], [], MIN_FILLED_GAP_MS)).toEqual({ runs: [at(1, 2)], overlapping: 0 })
  })

  it('fills a gap of exactly minGap, and leaves out and counts the recorded instants', () => {
    const { runs, overlapping } = fillGaps([at(1, 2, 3, 4, 5, 6, 7, 8)], at(2, 7), MIN_FILLED_GAP_MS)
    expect(minutesOf(runs)).toEqual([[1], [3, 4, 5, 6], [8]])
    expect(overlapping).toBe(2)
  })

  it('leaves out and counts every point in a gap shorter than minGap', () => {
    const { runs, overlapping } = fillGaps([at(3, 4, 5, 6)], at(2, 6.5), MIN_FILLED_GAP_MS)
    expect(runs).toEqual([])
    expect(overlapping).toBe(4)
  })
})

describe('spans', () => {
  it('merges a span with those it overlaps or touches', () => {
    expect(mergeSpan([], [5, 9])).toEqual([[5, 9]])
    expect(
      mergeSpan(
        [
          [0, 2],
          [10, 12],
          [20, 22],
        ],
        [3, 9],
      ),
    ).toEqual([
      [0, 12],
      [20, 22],
    ])
    expect(
      mergeSpan(
        [
          [0, 2],
          [20, 22],
        ],
        [5, 9],
      ),
    ).toEqual([
      [0, 2],
      [5, 9],
      [20, 22],
    ])
    expect(
      mergeSpan(
        [
          [0, 2],
          [5, 6],
          [20, 22],
        ],
        [1, 30],
      ),
    ).toEqual([[0, 30]])
  })

  it('leaves the parts of a span outside others', () => {
    expect(subtractSpans([0, 10], [])).toEqual([[0, 10]])
    expect(
      subtractSpans(
        [0, 10],
        [
          [3, 4],
          [7, 8],
        ],
      ),
    ).toEqual([
      [0, 2],
      [5, 6],
      [9, 10],
    ])
    expect(
      subtractSpans(
        [3, 8],
        [
          [0, 4],
          [7, 20],
        ],
      ),
    ).toEqual([[5, 6]])
    expect(subtractSpans([3, 8], [[0, 20]])).toEqual([])
    expect(subtractSpans([3, 8], [[10, 20]])).toEqual([[3, 8]])
  })

  it('tells a time within a span, ends included', () => {
    const spans: [number, number][] = [
      [0, 2],
      [10, 12],
    ]
    expect([0, 2, 3, 9, 10, 12, 13].map((time) => withinSpans(spans, time))).toEqual([
      true,
      true,
      false,
      false,
      true,
      true,
      false,
    ])
  })
})
