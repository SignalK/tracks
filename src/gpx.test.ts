import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fromGpx, toGpx } from './gpx.js'
import type { GpxTrack } from './gpx.js'
import type { TimedPosition } from './types.js'

const at = (lat: number, lng: number, timestamp = 0): TimedPosition => ({ position: [lat, lng], timestamp })

const track = (over: Partial<GpxTrack> = {}): GpxTrack => ({
  name: 'Own Ship',
  segments: [[at(60, 24, 1000), at(60.1, 24.1, 2000)]],
  ...over,
})

describe('toGpx', () => {
  it('writes a GPX 1.1 document', () => {
    const xml = toGpx([track()])

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('version="1.1"')
    expect(xml).toContain('xmlns="http://www.topografix.com/GPX/1/1"')
  })

  it('writes coordinates as lat/lon attributes and the time as a child', () => {
    const xml = toGpx([track({ segments: [[at(60.1, 24.9, 0)]] })])

    expect(xml).toContain('<trkpt lat="60.1" lon="24.9">')
    expect(xml).toContain('<time>1970-01-01T00:00:00.000Z</time>')
  })

  // Several tracks in one file is what makes "select three trips, export"
  // produce one file. TimeZero writes one file per vessel; GPX allows either.
  it('puts several tracks in one document', () => {
    const xml = toGpx([track({ name: 'Own Ship' }), track({ name: 'AIS Ariadne' })])

    expect(xml.match(/<trk>/g)).toHaveLength(2)
    expect(xml).toContain('<name>Own Ship</name>')
    expect(xml).toContain('<name>AIS Ariadne</name>')
  })

  it('writes one trkseg per segment', () => {
    const xml = toGpx([track({ segments: [[at(60, 24)], [at(61, 25)]] })])

    expect(xml.match(/<trkseg>/g)).toHaveLength(2)
  })

  it('omits a segment with no points rather than writing an empty trkseg', () => {
    const xml = toGpx([track({ segments: [[at(60, 24)], []] })])

    expect(xml.match(/<trkseg>/g)).toHaveLength(1)
  })

  it('escapes markup in a vessel name', () => {
    const xml = toGpx([track({ name: 'Fish & Chips <2>' })])

    expect(xml).toContain('<name>Fish &amp; Chips &lt;2&gt;</name>')
  })

  it('omits the extensions block when there is no context', () => {
    expect(toGpx([track()])).not.toContain('<extensions>')
  })
})

describe('fromGpx', () => {
  it('reads back what toGpx wrote', () => {
    const original = track({ context: 'vessels.urn:mrn:imo:mmsi:244813000' })

    expect(fromGpx(toGpx([original]))).toEqual([original])
  })

  // The identity TimeZero throws away. Its exports carry an opaque GUID and no
  // MMSI, so they cannot round-trip a vessel; carrying the context means ours
  // can, while staying readable by anything that ignores extensions.
  it('round-trips the Signal K context through extensions', () => {
    const context = 'vessels.urn:mrn:imo:mmsi:244813000'

    expect(fromGpx(toGpx([track({ context })]))[0]?.context).toBe(context)
  })

  it('reads a self-closing trkpt and attributes in either order', () => {
    const xml = `<gpx><trk><name>A</name><trkseg><trkpt lat="1" lon="2"/><trkpt lon="4" lat="3"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]?.map((p) => p.position)).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('decodes entities in a name', () => {
    const xml = `<gpx><trk><name>Fish &amp; Chips &lt;2&gt;</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.name).toBe('Fish & Chips <2>')
  })

  // An escaped entity must not decode twice: "&amp;lt;" is the literal "&lt;".
  it('does not double-decode an escaped ampersand', () => {
    const xml = `<gpx><trk><name>&amp;lt;</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.name).toBe('&lt;')
  })

  // One NaN reaching the store stretches every bounding box that track is in.
  it('drops a point whose coordinates are not finite', () => {
    const xml = `<gpx><trk><name>A</name><trkseg><trkpt lat="abc" lon="2"/><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]).toHaveLength(1)
  })

  it('dates a point with no usable time to the start of time', () => {
    const xml = `<gpx><trk><name>A</name><trkseg><trkpt lat="1" lon="2"><time>not a date</time></trkpt></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]?.[0]?.timestamp).toBe(0)
  })

  // Number('') and Number(' ') are 0, not NaN, so a blank attribute would land
  // a point at null island and stretch every bounding box the track appears in.
  it.each([
    ['empty', '<trkpt lat="" lon=""/>'],
    ['whitespace', '<trkpt lat=" " lon=" "/>'],
    ['missing', '<trkpt/>'],
  ])('drops a point whose coordinates are %s', (_kind, trkpt) => {
    const xml = `<gpx><trk><name>A</name><trkseg>${trkpt}<trkpt lat="60" lon="24"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]).toEqual([{ position: [60, 24], timestamp: 0 }])
  })

  // XML permits either quote style and plotters use both. Matching only double
  // quotes drops every point of such a file without a word.
  it.each([
    ['single', "<trkpt lat='1' lon='2'/>"],
    ['mixed', `<trkpt lat='1' lon="2"/>`],
    ['spaced', '<trkpt lat = "1" lon = "2"/>'],
  ])('reads %s-quoted coordinate attributes', (_style, trkpt) => {
    const xml = `<gpx><trk><name>A</name><trkseg>${trkpt}</trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]?.[0]?.position).toEqual([1, 2])
  })

  it('decodes hexadecimal character references as well as decimal', () => {
    const xml = (name: string) => `<gpx><trk><name>${name}</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml('A&#x26;B'))[0]?.name).toBe('A&B')
    expect(fromGpx(xml('A&#38;B'))[0]?.name).toBe('A&B')
  })

  // String.fromCodePoint throws outside the Unicode range, and a file is not
  // ours to trust: one bad reference in a name would abort the whole import
  // rather than losing one track.
  it.each([
    ['decimal', '&#999999999;'],
    ['hexadecimal', '&#xFFFFFFFF;'],
  ])('keeps an out-of-range %s reference instead of throwing', (_kind, reference) => {
    const xml = `<gpx><trk><name>X${reference}Y</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.name).toBe(`X${reference}Y`)
  })

  it('ignores a track with no points at all', () => {
    expect(fromGpx(`<gpx><trk><name>A</name></trk></gpx>`)).toEqual([])
  })

  it('names an unnamed track rather than leaving it blank', () => {
    const xml = `<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.name).toBe('Track')
  })

  // TimeZero paginates its export in blocks of 150 and the seams overlap, so
  // the last point of a block can be milliseconds newer than the first of the
  // next. Everything downstream assumes points arrive in order.
  it('sorts points that arrive out of order', () => {
    const xml =
      `<gpx><trk><name>A</name><trkseg>` +
      `<trkpt lat="1" lon="1"><time>2020-01-01T00:00:02Z</time></trkpt>` +
      `<trkpt lat="2" lon="2"><time>2020-01-01T00:00:01Z</time></trkpt>` +
      `</trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]?.map((p) => p.position)).toEqual([
      [2, 2],
      [1, 1],
    ])
  })
})

// The files a real plotter produces, rather than the ones this module writes.
describe('real TimeZero exports', () => {
  const read = (file: string) => readFileSync(`/home/dirk/dev/tmp/TZ/${file}`, 'utf8')
  const OWN_SHIP = 'gpx_export_own_ship/own_ship.gpx'

  it.each([
    [OWN_SHIP, 'Own Ship', 5550],
    ['gpx_export_ais/ais_mia.gpx', 'AIS MIA', 109],
    ['gpx_export_ais/ais_ile.gpx', "AIS L'ILE DU PAPILLON", 42],
  ])('reads every point of %s', (file, name, points) => {
    const [parsed] = fromGpx(read(file))

    expect(parsed?.name).toBe(name)
    expect(parsed?.segments.flat()).toHaveLength(points)
  })

  it('orders the 150-point block seams that the export leaves crossed', () => {
    const xml = read(OWN_SHIP)
    const raw = [...xml.matchAll(/<time>([^<]*)</g)].map((m) => Date.parse(m[1]!))
    const inversions = raw.filter((t, i) => i > 0 && raw[i - 1]! > t)
    // The fixture has to still exhibit the problem, or this proves nothing.
    expect(inversions.length).toBeGreaterThan(0)

    const points = fromGpx(xml)[0]!.segments.flat()

    expect(points.every((p, i) => i === 0 || points[i - 1]!.timestamp <= p.timestamp)).toBe(true)
  })

  // Not byte-identical: TimeZero writes thirteen decimal places, which is a
  // float artefact rather than information -- the seventh is already 11 mm,
  // finer than any GPS fix. What must survive is every point, every time, and
  // a position that has not actually moved.
  it('survives a re-export with every point and time intact', () => {
    const parsed = fromGpx(read(OWN_SHIP))
    const before = parsed[0]!.segments.flat()

    const after = fromGpx(toGpx(parsed))[0]!.segments.flat()

    expect(after).toHaveLength(before.length)
    expect(after.map((p) => p.timestamp)).toEqual(before.map((p) => p.timestamp))
    const worst = Math.max(
      ...after.map((p, i) =>
        Math.max(Math.abs(p.position[0] - before[i]!.position[0]), Math.abs(p.position[1] - before[i]!.position[1])),
      ),
    )
    // Rounding to seven decimal places moves a coordinate by at most half a
    // unit in the last place -- 5e-8 degrees, about 6 mm. Anything larger
    // would mean the re-export had actually moved the track.
    expect(worst).toBeLessThanOrEqual(5e-8)
  })
})
