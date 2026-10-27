import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsyncTrackStore } from './asyncTrackStore.js'
import { fromGpx } from './gpx.js'
import { createHarness, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { TestHarness } from './harness.test-utils.js'
import type { TrackApi } from './trackApi.js'

const API = '/signalk/v1/api'
const SELF_ID = SELF_CONTEXT.replace('vessels.', '')

let harness: TestHarness | undefined

afterEach(async () => {
  await harness?.stop()
  harness = undefined
  vi.restoreAllMocks()
})

const withTracks = (...positions: [string, [number, number]][]) => {
  harness = createHarness({ selfPosition: [60, 24] })
  for (const [context, position] of positions) {
    harness.emit(context, position)
  }
  return harness
}

describe('GET /vessels/:vesselId/track', () => {
  it('returns a MultiLineString in [lng, lat] order', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)

    expect(res.body.type).toBe('MultiLineString')
    // internal storage is [lat, lng]; GeoJSON output flips to [lng, lat]
    expect(res.body.coordinates[0][0]).toEqual([24.9, 60.1])
  })

  it('resolves the self alias to the self context', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/self/track`).expect(200)

    expect(res.body.coordinates[0][0]).toEqual([24.9, 60.1])
  })

  it('404s for a vessel with no track', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/urn:mrn:imo:mmsi:000000000/track`).expect(404)

    expect(res.body.message).toMatch(/No track available/)
  })
})

describe('GET /tracks', () => {
  it('returns every accumulated context keyed by context id', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]], [OTHER_CONTEXT, [60.2, 24.8]])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(Object.keys(res.body).sort()).toEqual([OTHER_CONTEXT, SELF_CONTEXT].sort())
    expect(res.body[SELF_CONTEXT].type).toBe('MultiLineString')
  })

  it('filters by bounding box on the last position', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]], [OTHER_CONTEXT, [10, 10]])

    const res = await request(h.app).get(`${API}/tracks?bbox=24,59,25,61`).expect(200)

    expect(Object.keys(res.body)).toEqual([SELF_CONTEXT])
  })

  // A coordinate of 0 is valid but falsy; a truthiness-based filter used to
  // reject the whole bbox, so any box touching the equator returned nothing.
  it('accepts a bounding box with zero coordinates', async () => {
    const h = withTracks([SELF_CONTEXT, [1, 1]])

    const res = await request(h.app).get(`${API}/tracks?bbox=0,0,2,2`).expect(200)

    expect(Object.keys(res.body)).toEqual([SELF_CONTEXT])
  })

  it('filters by radius from the self position', async () => {
    const h = withTracks([SELF_CONTEXT, [60, 24]], [OTHER_CONTEXT, [10, 10]])

    const res = await request(h.app).get(`${API}/tracks?radius=10000`).expect(200)

    expect(Object.keys(res.body)).toEqual([SELF_CONTEXT])
  })

  it('serves the wildcard form', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/tracks/anything`).expect(200)
  })
})

describe('when the plugin has been stopped', () => {
  // A stopped plugin serves nothing. stop() closes the database — releasing the
  // file handle and checkpointing the WAL — so there is no store left to read.
  // The routes stay mounted and must degrade rather than throw: the server
  // calls stop() on a config save, and a 404 for a moment is a better answer
  // than a stack trace.
  it('answers without throwing once the store is closed', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])
    await h.stop()

    await request(h.app).get(`${API}/tracks`).expect(404)
  })

  // The store is unreadable once stopped, so this checks the subscription
  // rather than the result: a position emitted after stop() must not reach the
  // store, which is observable through the plugin's own accessor.
  it('stops accumulating new positions', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])
    const before = h.emitted()
    await h.stop()
    h.emit(SELF_CONTEXT, [61, 25])

    expect(h.emitted()).toBe(before)
  })
})

// ── Freeboard-SK compatibility ─────────────────────────────────────────────
// These pinned the gap before it was fixed: /self/track 404'd and the time
// parameters were ignored. Time-window behaviour itself is covered in
// selfTrack.test.ts; this just holds the route open.
describe('Freeboard-SK compatibility', () => {
  it('serves /self/track', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/self/track`).expect(200)

    expect(res.body.type).toBe('MultiLineString')
    expect(res.body.coordinates[0][0]).toEqual([24.9, 60.1])
  })

  it('accepts the timespan and resolution parameters', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/vessels/${SELF_ID}/track?timespan=1h&resolution=60`).expect(200)
  })
})

// Per-point recording times, for consumers that draw a track as dots spaced by
// time rather than as a line — the IMO AIS presentation in
// SignalK/signalk-server#2504. Opt-in so existing clients see no change.
describe('per-point timestamps', () => {
  const T0 = Date.UTC(2026, 7, 14, 9, 0, 0)
  const MINUTE = 60_000

  const seeded = () => {
    harness = createHarness({ selfPosition: [60, 24] })
    harness.seedTrack(
      SELF_CONTEXT,
      [
        [60.1, 24.9],
        [60.2, 25.0],
      ],
      [T0, T0 + MINUTE],
    )
    return harness
  }

  it('omits times unless asked', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)

    expect(res.body.times).toBeUndefined()
    expect(res.body.coordinates[0]).toHaveLength(2)
  })

  it('serves ISO-8601 UTC times aligned with the coordinates', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times=true`).expect(200)

    expect(res.body.times).toEqual([['2026-08-14T09:00:00.000Z', '2026-08-14T09:01:00.000Z']])
    expect(res.body.times[0]).toHaveLength(res.body.coordinates[0].length)
  })

  it('treats a valueless ?times as true', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times`).expect(200)

    expect(res.body.times[0][0]).toBe('2026-08-14T09:00:00.000Z')
  })

  it('honours times=false', async () => {
    const res = await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times=false`).expect(200)

    expect(res.body.times).toBeUndefined()
  })

  it('400s on an unparseable times value', async () => {
    await request(seeded().app).get(`${API}/vessels/${SELF_ID}/track?times=maybe`).expect(400)
  })

  it('serves times on /self/track too', async () => {
    const res = await request(seeded().app).get(`${API}/self/track?times`).expect(200)

    expect(res.body.times[0]).toHaveLength(2)
  })
})

// Own vessel vs AIS target, stated by the server. A client otherwise has to
// string-match the context against the self identity it fetched separately,
// and drawing another vessel's track as your own is the failure mode.
describe('isSelf', () => {
  it('marks the own vessel on a single-vessel track', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)

    expect(res.body.isSelf).toBe(true)
    expect(res.body.context).toBe(SELF_CONTEXT)
  })

  it('marks an AIS target as not self', async () => {
    const h = withTracks([OTHER_CONTEXT, [60.2, 24.8]])
    const otherId = OTHER_CONTEXT.replace('vessels.', '')

    const res = await request(h.app).get(`${API}/vessels/${otherId}/track`).expect(200)

    expect(res.body.isSelf).toBe(false)
    expect(res.body.context).toBe(OTHER_CONTEXT)
  })

  it('reports the resolved context when asked for the self alias', async () => {
    // The alias resolves to the fully qualified urn:mrn: context, so a client
    // that asked for `self` learns which vessel that actually is.
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/self/track`).expect(200)

    expect(res.body.context).toBe(SELF_CONTEXT)
    expect(res.body.isSelf).toBe(true)
  })

  it('marks /self/track as self', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/self/track`).expect(200)

    expect(res.body.isSelf).toBe(true)
  })

  it('distinguishes self from others in the all-tracks listing', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]], [OTHER_CONTEXT, [60.2, 24.8]])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[SELF_CONTEXT].isSelf).toBe(true)
    expect(res.body[OTHER_CONTEXT].isSelf).toBe(false)
  })
})

// Times on the all-vessels listing. The filtering is shared with the untimed
// form, so these also pin that the two cannot disagree about which tracks match.
describe('GET /tracks?times', () => {
  const T0 = Date.UTC(2026, 7, 14, 9, 0, 0)
  const MINUTE = 60_000

  const seeded = () => {
    harness = createHarness({ selfPosition: [60, 24] })
    harness.seedTrack(
      SELF_CONTEXT,
      [
        [60.1, 24.9],
        [60.2, 25.0],
      ],
      [T0, T0 + MINUTE],
    )
    harness.seedTrack(OTHER_CONTEXT, [[60.3, 24.7]], [T0 + 2 * MINUTE])
    return harness
  }

  it('omits times unless asked', async () => {
    const res = await request(seeded().app).get(`${API}/tracks`).expect(200)

    expect(res.body[SELF_CONTEXT].times).toBeUndefined()
    expect(res.body[SELF_CONTEXT].coordinates).toEqual([
      [
        [24.9, 60.1],
        [25.0, 60.2],
      ],
    ])
  })

  it('serves times aligned with coordinates for every vessel', async () => {
    const res = await request(seeded().app).get(`${API}/tracks?times`).expect(200)

    expect(res.body[SELF_CONTEXT].times).toEqual([['2026-08-14T09:00:00.000Z', '2026-08-14T09:01:00.000Z']])
    expect(res.body[OTHER_CONTEXT].times).toEqual([['2026-08-14T09:02:00.000Z']])
    for (const context of [SELF_CONTEXT, OTHER_CONTEXT]) {
      const { coordinates, times } = res.body[context]
      expect(times).toHaveLength(coordinates.length)
      expect(times[0]).toHaveLength(coordinates[0].length)
    }
  })

  it('keeps isSelf alongside the times', async () => {
    const res = await request(seeded().app).get(`${API}/tracks?times`).expect(200)

    expect(res.body[SELF_CONTEXT].isSelf).toBe(true)
    expect(res.body[OTHER_CONTEXT].isSelf).toBe(false)
  })

  it('selects the same vessels with and without times', async () => {
    // The timed and untimed forms share one filter; a bbox that excludes a
    // vessel must exclude it either way.
    const h = seeded()
    const bbox = 'bbox=24.5,60.05,25.5,60.25'

    const plain = await request(h.app).get(`${API}/tracks?${bbox}`).expect(200)
    const timed = await request(h.app).get(`${API}/tracks?${bbox}&times`).expect(200)

    expect(Object.keys(timed.body).sort()).toEqual(Object.keys(plain.body).sort())
    expect(Object.keys(plain.body)).toEqual([SELF_CONTEXT])
  })

  it('applies the time window to the listing', async () => {
    const h = seeded()

    const res = await request(h.app)
      .get(`${API}/tracks?times&from=2026-08-14T09:00:30Z&to=2026-08-14T09:01:30Z`)
      .expect(200)

    expect(res.body[SELF_CONTEXT].times).toEqual([['2026-08-14T09:01:00.000Z']])
  })
})

// A list of tracks is only usable if each one is labelled the way a plotter
// labels it. TimeZero's exports name tracks `Own Ship` and `AIS <shipname>`,
// never a serial number, and the management UI is built on this.
describe('malformed bbox', () => {
  // #80. The handler's catch turned the matcher's throw into 404 "No track
  // available", so a bad query was indistinguishable from an empty result.
  it('answers 400 for a bbox whose south exceeds its north', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks?bbox=24,61,26,59`).expect(400)

    expect(res.body.message).toMatch(/south \(61\) must not be greater than north \(59\)/)
  })

  // Worse than the inverted box: this one answered 200 with every track,
  // because a null bbox skips the filter rather than failing it.
  it('answers 400 for a bbox that is not four numbers', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks?bbox=a,b,c,d`).expect(400)

    expect(res.body.message).toMatch(/four comma-separated numbers/)
  })

  it('still answers unfiltered when no bbox is given', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[OTHER_CONTEXT]).toBeDefined()
  })
})

describe('malformed radius', () => {
  it('answers 400 for a radius that is not a number', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks?radius=abc`).expect(400)

    expect(res.body.message).toMatch(/radius must be a number/)
  })

  it('answers 400 for a negative radius', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks?radius=-5`).expect(400)

    expect(res.body.message).toMatch(/must not be negative/)
  })

  // Not a 404: the query is fine, the server has nothing to measure from.
  it('answers 503 for a radius query with no self position', async () => {
    const h = (harness = createHarness({}))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks?radius=1000`).expect(503)

    expect(res.body.message).toMatch(/No position for the own vessel/)
  })
})

describe('unknown query parameters', () => {
  // Silently dropped before: the route answered 200 with the whole track, so a
  // filter the caller believed in was never applied and nothing said so.
  it('rejects bbox on the single-vessel route, which does not filter spatially', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))

    const res = await request(h.app).get(`${API}/vessels/self/track?bbox=24,59,26,61`).expect(400)

    expect(res.body.message).toMatch(/Unknown query parameter bbox/)
  })

  it('rejects a misspelled parameter rather than returning everything', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))

    const res = await request(h.app).get(`${API}/self/track?duratoin=6h`).expect(400)

    expect(res.body.message).toMatch(/duratoin/)
  })

  // The collection route does filter spatially, so the same key is valid there.
  it('still accepts bbox and radius on the collection route', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    await request(h.app).get(`${API}/tracks?bbox=24,59,26,61`).expect(200)
    await request(h.app).get(`${API}/tracks?radius=100000`).expect(200)
  })

  it('rejects an unknown parameter on the collection route too', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))

    const res = await request(h.app).get(`${API}/tracks?wibble=7`).expect(400)

    expect(res.body.message).toMatch(/wibble/)
  })

  // Checked against Freeboard-SK 3.2.0-beta.1 source (skstream.worker.ts): the
  // trail fetch builds `/self/track?` with exactly these three, and the AIS
  // fetch calls `/tracks?radius=`. Rejecting any of them would break the
  // plugin's main consumer on upgrade, so both call sites are pinned here.
  it('accepts every parameter Freeboard-SK sends to the vessel trail', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/self/track?timespan=23h&resolution=60&timespanOffset=1`).expect(200)
    await request(h.app).get(`${API}/self/track?timespan=1h&resolution=10`).expect(200)
  })

  it('accepts the radius Freeboard-SK sends when fetching AIS tracks', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/tracks?radius=10000`).expect(200)
  })

  it('accepts the documented parameters on the gpx route', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/self/track.gpx?duration=6h`).expect(200)
  })
})

describe('track names', () => {
  it('names the own vessel Own Ship', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/self/track`).expect(200)

    expect(res.body.name).toBe('Own Ship')
  })

  it('names another vessel from its AIS name', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      paths: { [`${OTHER_CONTEXT}.name`]: 'MIA' },
    }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[OTHER_CONTEXT].name).toBe('AIS MIA')
  })

  // The server's data model is empty after a restart, and a vessel that has
  // sailed out of range never repeats its static report. Without a remembered
  // name its months-old track reverts to a bare MMSI for good.
  it('still knows a name the data model has forgotten', async () => {
    const paths: Record<string, unknown> = { [`${OTHER_CONTEXT}.name`]: 'MIA' }
    const h = (harness = createHarness({ selfPosition: [60, 24], paths }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    // The vessel goes out of range: the server forgets it, then restarts.
    delete paths[`${OTHER_CONTEXT}.name`]
    await h.stop()
    h.restart()

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[OTHER_CONTEXT].name).toBe('AIS MIA')
  })

  // The data model carries a bare string for some sources and the `{value}`
  // wrapper for others -- contextName unwraps both. Capture has to agree, or a
  // wrapped name renders live and is never stored, vanishing on restart.
  it('remembers a name that arrives in the value wrapper', async () => {
    const paths: Record<string, unknown> = { [`${OTHER_CONTEXT}.name`]: { value: 'MIA' } }
    const h = (harness = createHarness({ selfPosition: [60, 24], paths }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    delete paths[`${OTHER_CONTEXT}.name`]
    await h.stop()
    h.restart()

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[OTHER_CONTEXT].name).toBe('AIS MIA')
  })

  // A remembered name is a stand-in, never an override: an AIS static report
  // can arrive long after the first position, and correcting the name is
  // exactly what it is for.
  it('prefers the live name over the remembered one', async () => {
    const paths: Record<string, unknown> = { [`${OTHER_CONTEXT}.name`]: 'MIA' }
    const h = (harness = createHarness({ selfPosition: [60, 24], paths }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    paths[`${OTHER_CONTEXT}.name`] = 'MIA II'

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[OTHER_CONTEXT].name).toBe('AIS MIA II')
  })

  // Remembering must stay per-vessel: a name recorded for one context may not
  // leak onto another that was never named.
  it('does not lend a remembered name to an unnamed vessel', async () => {
    const third = 'vessels.urn:mrn:imo:mmsi:111222333'
    const paths: Record<string, unknown> = { [`${OTHER_CONTEXT}.name`]: 'MIA' }
    const h = (harness = createHarness({ selfPosition: [60, 24], paths }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])
    h.emit(third, [60.3, 24.7])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[third].name).toBe('AIS 111222333')
  })

  // Older servers have no getPath at all, and a vessel can be tracked before
  // its static report arrives. Neither may leave the track unlabelled.
  it('falls back to the mmsi when the server cannot resolve a name', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks`).expect(200)

    expect(res.body[OTHER_CONTEXT].name).toBe('AIS 987654321')
  })

  // The whole reason names are resolved per request rather than cached at first
  // fix: an AIS target's static report routinely arrives minutes after its
  // first position, and a track stuck at "AIS 987654321" forever is the bug.
  it('picks up a name that arrives after the first request', async () => {
    const paths: Record<string, unknown> = {}
    const h = (harness = createHarness({ selfPosition: [60, 24], paths }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const before = await request(h.app).get(`${API}/tracks`).expect(200)
    expect(before.body[OTHER_CONTEXT].name).toBe('AIS 987654321')

    // The static report lands.
    paths[`${OTHER_CONTEXT}.name`] = 'MIA'

    const after = await request(h.app).get(`${API}/tracks`).expect(200)
    expect(after.body[OTHER_CONTEXT].name).toBe('AIS MIA')
  })

  it('names tracks in the timed response too', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      paths: { [`${OTHER_CONTEXT}.name`]: 'MIA' },
    }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/tracks?times`).expect(200)

    expect(res.body[OTHER_CONTEXT].name).toBe('AIS MIA')
  })
})

// The webapp cannot reach `toGpx` -- it ships as static files with no bundler
// -- so the conversion lives behind a route rather than being duplicated in
// the page, where it would drift from the module.
describe('GET /vessels/:vesselId/track.gpx', () => {
  it('serves the track as a GPX document', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/vessels/${SELF_ID}/track.gpx`).expect(200)

    expect(res.headers['content-type']).toContain('application/gpx+xml')
    expect(res.text).toContain('<gpx')
  })

  // Parsed rather than string-matched: what matters is that a reader gets a
  // document back, not that it was spelled a particular way.
  it('serves a document that reads back as the same track', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/self/track.gpx`).expect(200)
    const [track] = fromGpx(res.text)

    expect(track?.context).toBe(SELF_CONTEXT)
    expect(track?.segments.flat().map((p) => p.position)).toEqual([[60.1, 24.9]])
  })

  it('offers the file under a name derived from the vessel', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    const res = await request(h.app).get(`${API}/self/track.gpx`).expect(200)

    // Two parameters, per RFC 5987: an ASCII-only quoted form for readers that
    // understand nothing else, and filename* carrying the real name.
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="Own-Ship.gpx"; filename*=UTF-8\'\'Own-Ship.gpx',
    )
  })

  // An HTTP header carries bytes: a name outside Latin-1 makes setHeader throw,
  // and this route's catch would have reported that as "no track available" --
  // a 404 for a track that exists. A name inside Latin-1 but outside ASCII
  // arrives mojibaked instead, which nobody reports as a bug.
  it.each([
    ['a Latin-1 name', 'Ärger'],
    ['a non-Latin-1 name', '日本'],
  ])('serves the file for %s', async (_kind, vesselName) => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      paths: { [`${OTHER_CONTEXT}.name`]: vesselName },
    }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track.gpx`).expect(200)

    const disposition = res.headers['content-disposition'] ?? ''
    // The real name travels in filename*, ASCII-only in the quoted form.
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(`AIS-${vesselName}.gpx`)}`)
    expect(/filename="([^"]*)"/.exec(disposition)?.[1]).toMatch(/^[\x20-\x7e]+$/)
  })

  // RFC 8187's attr-char excludes !'()*, which encodeURIComponent leaves raw.
  it('escapes reserved characters in the extended filename', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      paths: { [`${OTHER_CONTEXT}.name`]: 'Boat (Test)' },
    }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track.gpx`).expect(200)

    const extended = /filename\*=UTF-8''(\S+)/.exec(res.headers['content-disposition'] ?? '')?.[1]
    expect(extended).toBeDefined()
    expect(extended).not.toMatch(/[!'()*]/)
  })

  // A known vessel with nothing inside the window is an empty track, not a
  // missing one, on a server with no history provider too.
  it('serves an empty track when no history provider is registered', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { noProvider: true },
    }))
    // Known to the store, but nothing inside the window the request asks for.
    h.seedTrack(OTHER_CONTEXT, [[60.2, 24.8]], [Date.now() - 90 * 24 * 60 * 60 * 1000])

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track?timespan=1h`).expect(200)

    expect(res.body.coordinates).toEqual([])
  })

  // An empty export is a well-formed document carrying no tracks: `toGpx`
  // leaves out a <trk> with no segments.
  it('exports an empty GPX for a known vessel with nothing in the window', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    h.seedTrack(OTHER_CONTEXT, [[60.2, 24.8]], [Date.now() - 90 * 24 * 60 * 60 * 1000])

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track.gpx?timespan=1h`).expect(200)

    expect(res.text).toContain('<gpx ')
    expect(fromGpx(res.text)).toEqual([])
  })

  // A provider takes no part in a read, so its outage cannot fail one.
  it('still serves the stored track when the provider fails', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], rows: [], getValuesRejects: true },
    }))
    h.emit(OTHER_CONTEXT, [60.2, 24.8])

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(200)

    expect(res.body.coordinates.flat()).not.toHaveLength(0)
  })

  it('404s for a vessel the store does not know', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/vessels/urn:mrn:imo:mmsi:999999999/track.gpx`).expect(404)
  })

  // The export reads a day at a time, stepping over days with nothing; the
  // JSON route reads the window in one piece. Thinned and split at a stop
  // across midnight, the two must still agree point for point.
  it('exports a track of several days as the JSON route reads it', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24], config: { segmentGapMinutes: 10 } }))
    const day = Date.UTC(2026, 6, 1)
    const times = [
      ...Array.from({ length: 60 }, (_, i) => day - 30 * 60_000 + i * 30_000),
      // On after a stop of an hour across midnight, then again three days on.
      ...Array.from({ length: 60 }, (_, i) => day + 60 * 60_000 + i * 30_000),
      ...Array.from({ length: 60 }, (_, i) => day + 3 * 24 * 60 * 60_000 + i * 30_000),
    ]
    h.seedTrack(
      SELF_CONTEXT,
      times.map((_, i) => [60 + i * 1e-4, 24]),
      times,
    )

    for (const query of ['', '?resolution=2m']) {
      const json = await request(h.app)
        .get(`${API}/self/track${query}${query ? '&' : '?'}times`)
        .expect(200)
      const gpx = await request(h.app).get(`${API}/self/track.gpx${query}`).expect(200)

      const segments = fromGpx(gpx.text)[0]!.segments
      expect(segments).toHaveLength(3)
      expect(segments.map((points) => points.map(({ position }) => [position[1], position[0]]))).toEqual(
        json.body.coordinates,
      )
      expect(segments.map((points) => points.map(({ timestamp }) => new Date(timestamp).toISOString()))).toEqual(
        json.body.times,
      )
    }
  })

  // A recording of years read in one piece is copied whole to the server's
  // thread and then written whole: hundreds of megabytes on a Pi.
  it('reads the export a day at a time, and only the days with positions', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24] }))
    const day = Date.UTC(2026, 6, 1)
    const times = [day + 1000, day + 2000, day + 10 * 24 * 60 * 60_000, day + 12 * 24 * 60 * 60_000]
    h.seedTrack(
      SELF_CONTEXT,
      times.map(() => [60, 24]),
      times,
    )
    const read = vi.spyOn(AsyncTrackStore.prototype, 'getTimed')

    await request(h.app).get(`${API}/self/track.gpx`).expect(200)

    const windows = read.mock.calls.map(([, window]) => window)
    expect(windows).toHaveLength(3)
    for (const window of windows) expect(window!.to - window!.from).toBeLessThanOrEqual(24 * 60 * 60_000)
  })

  // The GPX and JSON routes share one read pipeline, so a query answered by
  // one must be answered the same way by the other.
  it('returns the same points as the JSON route', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]], [SELF_CONTEXT, [60.2, 25.0]])

    const json = await request(h.app).get(`${API}/self/track`).expect(200)
    const gpx = await request(h.app).get(`${API}/self/track.gpx`).expect(200)

    const fromJson = (json.body.coordinates as [number, number][][]).flat().map(([lng, lat]) => [lat, lng])
    expect(
      fromGpx(gpx.text)[0]
        ?.segments.flat()
        .map((p) => p.position),
    ).toEqual(fromJson)
  })
})

// The webapp says how long other vessels are kept, and lists them that far back.
describe('GET /plugins/tracks/settings', () => {
  it.each([
    [{}, 7],
    [{ aisRetentionDays: 3 }, 3],
    [{ aisRetentionDays: 0 }, 0],
  ])('answers how many days other vessels are kept (%j)', async (config, days) => {
    const h = (harness = createHarness({ selfPosition: [60, 24], config }))

    const res = await request(h.app).get('/plugins/tracks/settings').expect(200)

    expect(res.body).toEqual({ aisRetentionDays: days })
  })
})

// The webapp's danger zone: everything gone, and recording on, on an empty store.
describe('DELETE /plugins/tracks/database', () => {
  it('refuses without the confirming word, and keeps everything', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).delete('/plugins/tracks/database').expect(400)
    await request(h.app).delete('/plugins/tracks/database?confirm=delete').expect(400)

    await request(h.app).get(`${API}/self/track`).expect(200)
  })

  it('deletes every track, import and bin entry, and records on', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]], [OTHER_CONTEXT, [60.2, 24.8]])
    await request(h.app)
      .post('/plugins/tracks/imports')
      .set('Content-Type', 'application/gpx+xml')
      .send(
        '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Old</name><trkseg>' +
          '<trkpt lat="61" lon="25"><time>2020-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>',
      )
      .expect(201)
    const provider = h.trackProvider() as Required<TrackApi>
    expect(await provider.deleteTrack(`recorded:${OTHER_CONTEXT}`)).toBe(true)
    expect((await request(h.app).get('/plugins/tracks/imports').expect(200)).body).toHaveLength(1)
    expect((await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)).body).toHaveLength(1)

    const res = await request(h.app).delete('/plugins/tracks/database?confirm=DELETE').expect(200)

    expect(res.body).toEqual({ deleted: true })
    await request(h.app).get(`${API}/self/track`).expect(404)
    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
    expect((await request(h.app).get('/plugins/tracks/imports').expect(200)).body).toEqual([])
    expect((await request(h.app).get('/plugins/tracks/recycle-bin').expect(200)).body).toEqual([])

    h.emit(SELF_CONTEXT, [60.3, 24.7])
    const after = await request(h.app).get(`${API}/self/track`).expect(200)
    expect(after.body.coordinates).toEqual([[[24.7, 60.3]]])
  })
})

// Reads come from the store alone: what a provider holds reaches a track
// through the history import, once, rather than on every query.
describe('reads with a history provider installed', () => {
  it('ask the provider nothing', async () => {
    let asked = 0
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: {
        get contexts() {
          asked++
          return [SELF_CONTEXT, OTHER_CONTEXT]
        },
        rows: [[new Date(Date.now() - 60_000).toISOString(), [25, 61]]],
        onValues: () => {
          asked++
        },
        onHistoryApi: () => {
          asked++
        },
      },
    }))
    h.seedTrack(SELF_CONTEXT, [[60.1, 24.9]], [Date.now() - 120_000])

    const track = await request(h.app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)
    await request(h.app).get(`${API}/self/track.gpx`).expect(200)
    const all = await request(h.app).get(`${API}/tracks?times`).expect(200)
    const v2 = await h.trackProvider()!.getTracks({ contexts: [SELF_CONTEXT, OTHER_CONTEXT] })

    expect(track.body.coordinates).toEqual([[[24.9, 60.1]]])
    expect(Object.keys(all.body)).toEqual([SELF_CONTEXT])
    expect(v2.features.map(({ properties }) => properties.context)).toEqual([SELF_CONTEXT])
    expect(asked).toBe(0)
  })

  it('404 a vessel only the provider holds', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], rows: [[new Date(Date.now() - 60_000).toISOString(), [25, 61]]] },
    }))

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track.gpx`).expect(404)
  })
})

// Thinning spaces points further apart than the gap, so a thinned track must
// not be segmented at the gap alone (#133).
describe('segment gaps on a thinned track', () => {
  const MINUTE = 60_000
  // One fix a minute, fifteen minutes long, gap setting two minutes: any split
  // in this stretch is one that thinning invented.
  const seedContinuous = (h: TestHarness, start: number, minutes = 15) =>
    h.seedTrack(
      SELF_CONTEXT,
      Array.from({ length: minutes }, (_, i): [number, number] => [60 + i * 0.001, 24]),
      Array.from({ length: minutes }, (_, i) => start + i * MINUTE),
    )

  it('keeps a continuous track in one segment at a resolution wider than the gap', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24], config: { segmentGapMinutes: 2 } }))
    seedContinuous(h, Date.now() - 30 * MINUTE)

    const res = await request(h.app).get(`${API}/vessels/self/track?duration=1h&resolution=3m`).expect(200)

    expect(res.body.coordinates).toHaveLength(1)
    // A segment of one point draws nothing, which is what the bug looked like.
    expect(res.body.coordinates[0].length).toBeGreaterThan(1)
  })

  it('does the same for /tracks?times', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24], config: { segmentGapMinutes: 2 } }))
    seedContinuous(h, Date.now() - 30 * MINUTE)

    const res = await request(h.app).get(`${API}/tracks?duration=1h&resolution=3m&times`).expect(200)

    expect(res.body[SELF_CONTEXT].coordinates).toHaveLength(1)
    expect(res.body[SELF_CONTEXT].times).toHaveLength(1)
  })

  it('breaks /tracks?times exactly at a short stop the store thinned around', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24], config: { segmentGapMinutes: 2 } }))
    const start = Date.now() - 50 * MINUTE
    // Ten minutes, a five-minute stop, ten more: longer than the gap, but
    // shorter than the spacing the store thins these points to.
    const minutes = [...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 14 + i)]
    h.seedTrack(
      SELF_CONTEXT,
      minutes.map((m): [number, number] => [60 + m * 0.001, 24]),
      minutes.map((m) => start + m * MINUTE),
    )

    const res = await request(h.app).get(`${API}/tracks?duration=1h&resolution=3m&times`).expect(200)

    expect(res.body[SELF_CONTEXT].coordinates).toHaveLength(2)
  })

  it('still breaks where the recording actually stopped', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24], config: { segmentGapMinutes: 2 } }))
    const start = Date.now() - 50 * MINUTE
    // An hour-long stop is far beyond the gap plus twice the spacing.
    h.seedTrack(
      SELF_CONTEXT,
      [
        [60, 24],
        [60.001, 24],
        [60.002, 24],
        [60.1, 24],
        [60.101, 24],
      ],
      [start, start + MINUTE, start + 2 * MINUTE, start + 40 * MINUTE, start + 41 * MINUTE],
    )

    const res = await request(h.app).get(`${API}/vessels/self/track?duration=1h&resolution=3m`).expect(200)

    expect(res.body.coordinates).toHaveLength(2)
  })
})
