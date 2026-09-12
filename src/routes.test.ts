import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fromGpx } from './gpx.js'
import { createHarness, deferred, OTHER_CONTEXT, SELF_CONTEXT } from './harness.test-utils.js'
import type { TestHarness } from './harness.test-utils.js'

const API = '/signalk/v1/api'
const SELF_ID = SELF_CONTEXT.replace('vessels.', '')

let harness: TestHarness | undefined

afterEach(() => {
  harness?.stop()
  harness = undefined
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
    h.stop()

    await request(h.app).get(`${API}/tracks`).expect(404)
  })

  // The store is unreadable once stopped, so this checks the subscription
  // rather than the result: a position emitted after stop() must not reach the
  // store, which is observable through the plugin's own accessor.
  it('stops accumulating new positions', () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])
    const before = h.emitted()
    h.stop()
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

  // A 404 means neither source knows the vessel. `getValues` narrowed to a
  // window cannot tell an unknown vessel from one whose history lies outside
  // it, so a vessel the provider lists is a known vessel with an empty track.
  it('serves an empty track for a vessel history knows but has no rows for', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], rows: [] },
    }))

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(200)

    expect(res.body.coordinates).toEqual([])
  })

  it('exports an empty GPX for that vessel rather than 404ing', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], rows: [] },
    }))

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track.gpx`).expect(200)

    // Parsed rather than pattern-matched: a 200 carrying malformed GPX would
    // otherwise pass. `toGpx` omits a <trk> that has no segments -- a track
    // with a name and no points loses nothing by being left out -- so an empty
    // export is a well-formed document carrying no tracks at all.
    expect(res.text).toContain('<gpx ')
    expect(fromGpx(res.text)).toEqual([])
  })

  it('still 404s when the provider lists no such context', async () => {
    const h = (harness = createHarness({ selfPosition: [60, 24], history: { contexts: [], rows: [] } }))

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
  })

  // The upstream interface requires getContexts, but a provider built against
  // an older server-api may not have it. A missing method must degrade to the
  // old behaviour rather than throw.
  it('still 404s against a provider with no getContexts', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { rows: [], withoutGetContexts: true },
    }))

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
  })

  // The reason the existence question is not scoped to the requested window.
  // A provider filters its context list by the range it is asked for, and a
  // bare /track with an empty store falls back to a window of the last day --
  // so a vessel last seen before that is exactly the one a window-scoped probe
  // would fail to rescue.
  it('serves an empty track for a vessel whose history predates the fallback window', async () => {
    const TWO_DAYS_AGO = Date.now() - 2 * 24 * 60 * 60 * 1000
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], contextsSince: TWO_DAYS_AGO, rows: [] },
    }))

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(200)

    expect(res.body.coordinates).toEqual([])
  })

  // The probe runs only for a vessel about to 404 -- which is exactly the
  // request a client can repeat without limit, since the routes are open. One
  // question to the provider must serve a burst of them, or enumerating vessel
  // ids would drive a ten-year query each time.
  it('asks the provider once for a burst of misses, not once per request', async () => {
    let probes = 0
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: {
        rows: [],
        get contexts() {
          probes += 1
          return []
        },
      },
    }))

    for (let i = 0; i < 5; i += 1) {
      await request(h.app).get(`${API}/vessels/vessels.urn:mrn:imo:mmsi:90000000${i}/track`).expect(404)
    }

    expect(probes).toBe(1)
  })

  // Two things make this test the real thing rather than a restatement of the
  // cache. The provider's answer is held open, so the first caller cannot fill
  // the cache before the others arrive. And every request is dispatched before
  // any is awaited -- supertest does not send on construction, so building an
  // array of requests and awaiting them later would run them one at a time and
  // the cache alone would satisfy the assertion.
  it('shares one in-flight query across concurrent misses', async () => {
    let calls = 0
    const gate = deferred()
    const allArrived = deferred()
    let arrived = 0
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: {
        // Read once per getValues call, which every request makes on its way
        // to the probe -- so this counts arrivals without a new harness knob.
        get rows() {
          arrived += 1
          if (arrived === 8) {
            allArrived.release()
          }
          return []
        },
        contexts: [],
        deferContexts: {
          release: gate.release,
          get wait() {
            calls += 1
            return gate.wait
          },
        },
      },
    }))
    const arrivals = allArrived.wait

    const inFlight = Array.from({ length: 8 }, () =>
      request(h.app)
        .get(`${API}/vessels/${OTHER_CONTEXT}/track`)
        .then((r) => r),
    )
    // Waited on rather than slept through: the gate opens when the last of the
    // eight has reached the store, so "all in flight" is observed, not timed.
    await arrivals
    expect(calls).toBe(1)

    gate.release()
    const responses = await Promise.all(inFlight)

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(404))
    expect(calls).toBe(1)
  })

  // The bound is the epoch, not a span of years, so a provider that still
  // holds a context from long ago is not mistaken for one that never knew it.
  it('finds a vessel whose history is older than any fixed span', async () => {
    const FIFTEEN_YEARS_AGO = Date.now() - 15 * 365 * 24 * 60 * 60 * 1000
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], contextsSince: FIFTEEN_YEARS_AGO, rows: [] },
    }))

    const res = await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(200)

    expect(res.body.coordinates).toEqual([])
  })

  // The cache has to expire, or a vessel a provider has newly learned about
  // would stay invisible for the rest of the process.
  it('asks again once the cached list has expired', async () => {
    let probes = 0
    let known: string[] = []
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: {
        rows: [],
        get contexts() {
          probes += 1
          return known
        },
      },
    }))

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
    expect(probes).toBe(1)

    // The provider learns about the vessel, and the clock passes the window.
    known = [OTHER_CONTEXT]
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 31_000)
      await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(200)
    } finally {
      vi.useRealTimers()
    }
    expect(probes).toBe(2)
  })

  // A failed probe must not be remembered: the next miss has to ask again
  // rather than inherit the rejection for the rest of the window.
  it('retries after a failed existence query rather than caching the failure', async () => {
    let probes = 0
    let failing = true
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: {
        rows: [],
        contexts: [OTHER_CONTEXT],
        get getContextsRejects() {
          probes += 1
          return failing
        },
      },
    }))

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
    failing = false

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(200)
    expect(probes).toBeGreaterThan(1)
  })

  it('still 404s when the existence query itself fails', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], rows: [], getContextsRejects: true },
    }))

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
  })

  // A provider that never answers must not hold the request open indefinitely:
  // the bounded call gives up and the 404 stands.
  it('still 404s when the existence query never settles', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: [OTHER_CONTEXT], rows: [], getContextsHangs: true },
    }))

    await request(h.app).get(`${API}/vessels/${OTHER_CONTEXT}/track`).expect(404)
  }, 15_000)

  // At least one provider maps its stored `self` back to the spec's spelling,
  // so the own vessel has to be recognised under either one.
  it('accepts vessels.self as naming the own vessel', async () => {
    const h = (harness = createHarness({
      selfPosition: [60, 24],
      history: { contexts: ['vessels.self'], rows: [] },
    }))

    const res = await request(h.app).get(`${API}/vessels/${SELF_ID}/track`).expect(200)

    expect(res.body.coordinates).toEqual([])
  })

  it('404s for a vessel neither the store nor history knows', async () => {
    const h = withTracks([SELF_CONTEXT, [60.1, 24.9]])

    await request(h.app).get(`${API}/vessels/urn:mrn:imo:mmsi:999999999/track.gpx`).expect(404)
  })

  // The GPX and JSON routes share one read pipeline, so a query answered by
  // one must be answered the same way by the other -- the history
  // reconciliation and windowless fallback are too subtle to duplicate.
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
