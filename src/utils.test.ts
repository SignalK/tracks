import { describe, expect, it } from 'vitest'
import { createInBounds, resolveContext, toIsoTimes, validateParameters } from './utils.js'

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
