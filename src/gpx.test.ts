import { existsSync, readFileSync } from 'node:fs'
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

  // Seven decimals is ~11 mm, finer than any GPS fix. Pinned on a value that
  // actually needs rounding: the other tests use coordinates that do not, so
  // they would pass at any precision.
  it('writes coordinates at seven decimal places', () => {
    const xml = toGpx([track({ segments: [[at(60.123456789, -0.000000049, 0)]] })])

    expect(xml).toContain('lat="60.1234568"')
    // Rounds to zero, and writes it as zero rather than "-0".
    expect(xml).toContain('lon="0"')
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

  it('refuses to write a position GPX cannot express', () => {
    const xml = toGpx([track({ segments: [[at(91, 181, 0), at(60, 24, 1000)]] })])

    expect(xml).not.toContain('lat="91"')
    expect(xml).toContain('<trkpt lat="60" lon="24">')
  })

  // A <trk> with no <trkseg> is a name and nothing else, and fromGpx ignores
  // it -- so writing one loses the track and its identity on a round-trip.
  it('omits a track whose segments are all empty', () => {
    const xml = toGpx([track({ name: 'Empty', context: 'vessels.urn:mrn:imo:mmsi:1', segments: [[], []] })])

    expect(xml).not.toContain('<trk>')
    expect(fromGpx(xml)).toEqual([])
  })

  it('omits a track left empty by out-of-range points', () => {
    const xml = toGpx([track({ segments: [[at(91, 181, 0)]] })])

    expect(xml).not.toContain('<trk>')
  })

  // One unreadable timestamp must not cost the whole document: toISOString
  // throws outside the Date range, which would abort every track in the file.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['out of range', 1e20],
  ])('writes a track whose point has a %s timestamp', (_kind, timestamp) => {
    const xml = toGpx([track({ segments: [[{ position: [60, 24], timestamp }]] })])

    expect(xml).toContain('<trkpt lat="60" lon="24">')
    expect(xml).toContain('<time>1970-01-01T00:00:00.000Z</time>')
  })

  it('omits a segment with no points rather than writing an empty trkseg', () => {
    const xml = toGpx([track({ segments: [[at(60, 24)], []] })])

    expect(xml.match(/<trkseg>/g)).toHaveLength(1)
  })

  // A NUL or a lone surrogate has no entity form, so writing one produces a
  // document no conformant reader will load.
  it.each([
    ['NUL', 0],
    ['a C0 control', 0x0b],
    ['a lone surrogate', 0xd800],
  ])('drops %s from a name rather than emitting invalid XML', (_kind, code) => {
    const xml = toGpx([track({ name: `X${String.fromCodePoint(code)}Y` })])

    expect(xml).toContain('<name>XY</name>')
    expect(xml).not.toContain(String.fromCodePoint(code))
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

  // GPX extensions are an open field any vendor may write into. A foreign
  // <context> read as ours would attribute an imported track to a vessel it
  // does not belong to.
  it.each([
    ['a foreign prefix', '<evil:context xmlns:evil="http://evil.example/">vessels.urn:mrn:imo:mmsi:999</evil:context>'],
    ['no namespace at all', '<context>vessels.urn:mrn:imo:mmsi:888</context>'],
  ])('ignores a context element with %s', (_kind, extension) => {
    const xml = `<gpx><trk><name>A</name><extensions>${extension}</extensions><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.context).toBeUndefined()
  })

  // Matched on the namespace, not the prefix: the prefix is arbitrary.
  it('reads a context under any prefix bound to the Signal K namespace', () => {
    const xml =
      `<gpx><trk><name>A</name><extensions>` +
      `<sk:context xmlns:sk="https://signalk.org/specification/1.7.0/">vessels.urn:mrn:imo:mmsi:7</sk:context>` +
      `</extensions><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.context).toBe('vessels.urn:mrn:imo:mmsi:7')
  })

  // XML permits whitespace before the closing angle bracket of any tag. A file
  // written that way lost every track, which is the worst possible failure for
  // a parser whose job is to be forgiving about structure.
  it('reads structural tags written with whitespace', () => {
    const xml = `<gpx><trk ><name >A</name ><trkseg ><trkpt lat="1" lon="2"/></trkseg ></trk ></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]).toEqual([{ position: [1, 2], timestamp: 0 }])
  })

  it('reads a trkpt whose closing tag carries whitespace', () => {
    const xml =
      `<gpx><trk><name>A</name><trkseg>` +
      `<trkpt lat="1" lon="2"><time>2020-01-01T00:00:00Z</time></trkpt >` +
      `</trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]).toHaveLength(1)
  })

  // A word boundary sits before a hyphen too, so an unknown element whose name
  // merely starts with "trkpt" was read as a position the file never declared.
  it.each([
    ['trkpt-extra', '<trkpt-extra lat="9" lon="9"/>'],
    ['ns:trkpt', '<ns:trkpt lat="9" lon="9"/>'],
  ])('does not read <%s> as a track point', (_name, element) => {
    const xml = `<gpx><trk><name>A</name><trkseg>${element}<trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]).toEqual([{ position: [1, 2], timestamp: 0 }])
  })

  // An XML prefix is an NCName, so hyphens and dots are legal in it.
  it.each([['sig-k'], ['sig.k']])('reads a context under the %s prefix', (prefix) => {
    const xml =
      `<gpx><trk><name>A</name><extensions>` +
      `<${prefix}:context xmlns:${prefix}="https://signalk.org/specification/1.7.0/">vessels.urn:mrn:imo:mmsi:7</${prefix}:context>` +
      `</extensions><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.context).toBe('vessels.urn:mrn:imo:mmsi:7')
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

  // A numeric reference's output must not be decoded again either: XML expands
  // `&#38;amp;` to the literal `&amp;`, not to `&`.
  it.each([
    ['&#38;amp;', '&amp;'],
    ['&#38;lt;', '&lt;'],
    ['&#x26;amp;', '&amp;'],
  ])('decodes %s exactly once', (reference, expected) => {
    const xml = `<gpx><trk><name>${reference}</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.name).toBe(expected)
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

  // A word boundary also matches after a hyphen, so `data-lat` would be read
  // as this element's latitude -- interpreting structure it should ignore.
  it.each([
    ['data-lat/data-lon', '<trkpt data-lat="5" data-lon="6"/>'],
    ['xlat/xlon', '<trkpt xlat="5" xlon="6"/>'],
  ])('does not mistake %s for a coordinate', (_kind, trkpt) => {
    const xml = `<gpx><trk><name>A</name><trkseg>${trkpt}<trkpt lat="60" lon="24"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]).toEqual([{ position: [60, 24], timestamp: 0 }])
  })

  // Beyond ±90 / ±180 is not a place. Such a value reaching the store
  // stretches every bounding box the track appears in.
  it.each([
    ['latitude', '<trkpt lat="91" lon="24"/>'],
    ['longitude', '<trkpt lat="60" lon="181"/>'],
    ['both', '<trkpt lat="-91" lon="-181"/>'],
  ])('drops a point whose %s is outside GPX bounds', (_which, trkpt) => {
    const xml = `<gpx><trk><name>A</name><trkseg>${trkpt}<trkpt lat="60" lon="24"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.segments[0]).toEqual([{ position: [60, 24], timestamp: 0 }])
  })

  // XML 1.0's character range has holes -- NUL, most C0 controls and the
  // surrogate block. Decoding one puts a character into a name that cannot be
  // written back out as well-formed XML.
  it.each([
    ['NUL', '&#0;'],
    ['a C0 control', '&#11;'],
    ['a surrogate', '&#xD800;'],
  ])('keeps %s as a reference rather than decoding it', (_kind, reference) => {
    const xml = `<gpx><trk><name>X${reference}Y</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.name).toBe(`X${reference}Y`)
  })

  it.each([
    ['tab', '&#9;', '\t'],
    ['newline', '&#10;', '\n'],
  ])('still decodes %s, which XML permits', (_kind, reference, character) => {
    const xml = `<gpx><trk><name>X${reference}Y</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`

    expect(fromGpx(xml)[0]?.name).toBe(`X${character}Y`)
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

// A file as a real plotter writes it, rather than as this module does.
//
// The fixture is synthetic but reproduces what matters: TimeZero paginates in
// blocks of 150 and the seams overlap, so a point can be milliseconds older
// than the one before it.
describe('a plotter-written export', () => {
  const seamFixture = readFileSync(new URL('./__fixtures__/timezero-seams.gpx', import.meta.url), 'utf8')

  it('reads the track, its name and every point', () => {
    const [parsed] = fromGpx(seamFixture)

    expect(parsed?.name).toBe('AIS SEAM TEST')
    expect(parsed?.segments.flat()).toHaveLength(450)
  })

  it('orders the block seams the export leaves crossed', () => {
    const raw = [...seamFixture.matchAll(/<time>([^<]*)</g)].map((m) => Date.parse(m[1]!))
    const inverted = raw.filter((t, i) => i > 0 && raw[i - 1]! > t)
    // The fixture has to still exhibit the problem, or this proves nothing.
    expect(inverted.length).toBeGreaterThan(0)

    const points = fromGpx(seamFixture)[0]!.segments.flat()

    expect(points.every((p, i) => i === 0 || points[i - 1]!.timestamp <= p.timestamp)).toBe(true)
  })

  it('ignores the vendor extensions it does not understand', () => {
    expect(fromGpx(seamFixture)[0]?.context).toBeUndefined()
  })
})

// The real exports, when this machine has them: 704 KB of vendor data does not
// belong in the repository for a unit test, and a path that exists on one
// workstation must not fail the suite everywhere else.
const TZ_EXPORT_DIR = process.env.TZ_EXPORT_DIR ?? '/home/dirk/dev/tmp/TZ'
const OWN_SHIP = 'gpx_export_own_ship/own_ship.gpx'

describe.skipIf(!existsSync(`${TZ_EXPORT_DIR}/${OWN_SHIP}`))('real TimeZero exports', () => {
  const read = (file: string) => readFileSync(`${TZ_EXPORT_DIR}/${file}`, 'utf8')

  // Gated per file rather than per suite: the own-ship export existing does
  // not mean the AIS ones do, and a missing one would fail rather than skip.
  for (const [file, name, points] of [
    [OWN_SHIP, 'Own Ship', 5550],
    ['gpx_export_ais/ais_mia.gpx', 'AIS MIA', 109],
    ['gpx_export_ais/ais_ile.gpx', "AIS L'ILE DU PAPILLON", 42],
  ] as const) {
    it.skipIf(!existsSync(`${TZ_EXPORT_DIR}/${file}`))(`reads every point of ${file}`, () => {
      const [parsed] = fromGpx(read(file))

      expect(parsed?.name).toBe(name)
      expect(parsed?.segments.flat()).toHaveLength(points)
    })
  }

  it('orders the 150-point block seams that the export leaves crossed', () => {
    const xml = read(OWN_SHIP)
    const raw = [...xml.matchAll(/<time>([^<]*)</g)].map((m) => Date.parse(m[1]!))

    expect(raw.filter((t, i) => i > 0 && raw[i - 1]! > t).length).toBeGreaterThan(0)

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
