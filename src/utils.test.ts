import { describe, expect, it } from 'vitest'
import {
  createInBounds,
  resolveContext,
  toIsoTimes,
  validateParameters,
  trackLabel,
  contextName,
  gpxFilename,
} from './utils.js'

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

  it('rejects a bbox that is not four finite numbers', () => {
    expect(validateParameters({ bbox: '1,2,3' }, undefined).bbox).toBeNull()
    expect(validateParameters({ bbox: '1,2,3,abc' }, undefined).bbox).toBeNull()
    expect(validateParameters({ bbox: '' }, undefined).bbox).toBeNull()
  })

  it('parses radius and falls back to the configured default', () => {
    expect(validateParameters({ radius: '500' }, 1000).radius).toBe(500)
    expect(validateParameters({}, 1000).radius).toBe(1000)
    expect(validateParameters({}, undefined).radius).toBeNull()
  })

  it('keeps an explicit radius of zero rather than the default', () => {
    expect(validateParameters({ radius: '0' }, 1000).radius).toBe(0)
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
