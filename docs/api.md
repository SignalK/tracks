# HTTP API

The routes the plugin serves, for clients and integrations. What the plugin does is in the
[README](../README.md), and how it does it in [how-it-works.md](how-it-works.md). That page
describes these routes:

- the v2 Track API, `/signalk/v2/api/tracks`: what it answers
  ([Keeping tracks for years](how-it-works.md#keeping-tracks-for-years)), storing a track
  ([Imported tracks](how-it-works.md#imported-tracks)) and deleting one
  ([Deleting tracks](how-it-works.md#deleting-tracks));
- `POST /plugins/tracks/imports`, a GPX file of up to 25 MiB
  ([Importing a GPX file](how-it-works.md#importing-a-gpx-file));
- `GET /plugins/tracks/imports` and `GET /plugins/tracks/imports/<id>/track.gpx`, the imports
  and their GPX, and `/plugins/tracks/history-import`
  ([Importing from a history provider](how-it-works.md#importing-from-a-history-provider));
- `DELETE /plugins/tracks/database`
  ([Deleting the whole database](how-it-works.md#deleting-the-whole-database)).

This page has the v1 routes, the routes of an upload in slices, and the client library.

Requires Signal K server >= 2.33.0 for the v2 Track API; older servers get the v1 routes only.

## The v1 routes

**Retrieve track for an individual vessel:**

`/signalk/v1/api/vessels/<vesselId>/track`

_`<vesselId>` may be `self` or a fully qualified context such as `urn:mrn:imo:mmsi:123456789`._

**Retrieve the own vessel's track:**

`/signalk/v1/api/self/track`

---

**Narrow a track to a time window:**

`/signalk/v1/api/self/track?from=2026-08-09T06:00:00Z&to=2026-08-09T12:00:00Z`

`/signalk/v1/api/self/track?duration=6h`

_`from` and `to` are ISO-8601 timestamps; `to` defaults to now. `duration` is a window
ending now. A window ending at now includes its most recent point; one ending earlier is
half-open, so consecutive windows tile without returning the shared point twice._

_Without a window these routes return the last 24 hours. The own vessel is kept
indefinitely, and with the history import its whole track can be years of positions,
too many for one answer; name a window to read further back. A vessel that recorded
nothing in that day, a boat moored with recording paused for instance, gets an empty
track. The GPX export, `/signalk/v1/api/self/track.gpx` or
`/signalk/v1/api/vessels/<vesselId>/track.gpx`, still exports the whole recording without
a window._

_`timespan` and `timespanOffset` are also accepted for Freeboard-SK compatibility, where
`timespan=23h&timespanOffset=1` means "23 hours ending an hour ago". They are not part of
the proposed track API and are expected to be superseded by `from`/`to`._

_A parameter these routes do not read is rejected with `400` rather than ignored, so a
typo such as `?duratoin=6h` fails rather than quietly returning the last 24 hours.
`bbox` and `radius` are **not** accepted here: they select which vessels to return and so
belong to `/tracks` below. To ask whether one vessel's track passed through a box, use the
v2 Track API, which matches any position in the window ([being designed in
SignalK/signalk-server#2504](https://github.com/SignalK/signalk-server/issues/2504))._

---

**Reduce the number of points returned:**

`/signalk/v1/api/self/track?duration=24h&resolution=5m`

_`resolution` is the minimum spacing between returned points. Durations accept a bare
number of seconds or an `s`/`m`/`h`/`d` suffix. The first and last points are always kept,
so thinning never shortens the track._

---

**Retrieve the time each position was recorded:**

`/signalk/v1/api/self/track?duration=6h&times`

```json
{
  "type": "MultiLineString",
  "coordinates": [
    [
      [24.9, 60.1],
      [25.0, 60.2]
    ]
  ],
  "times": [["2026-08-14T09:00:00.000Z", "2026-08-14T09:01:00.000Z"]],
  "context": "vessels.urn:mrn:imo:mmsi:123456789",
  "isSelf": true,
  "name": "Own Ship"
}
```

_`times` adds a `times` array positionally aligned with `coordinates`: `times[i][j]` is when
`coordinates[i][j]` was recorded, as ISO-8601 UTC. It is opt-in because the response grows by
roughly a third and clients that only draw the geometry have no use for it. Accepts
`true`/`1`/`yes` and `false`/`0`/`no`; a valueless `?times` reads as true._

_`context` is the fully qualified context the track belongs to, and `isSelf` says whether it is
the own vessel. Asking for `self` resolves the alias, so the response tells you which vessel
`self` actually is._

_`name` is a display label, the way a chart plotter shows one: `Own Ship`, or `AIS <shipname>`
falling back to `AIS <mmsi>` and finally the raw context. It is for putting in a list — the v2
Track API's `contextName` carries the undecorated vessel name instead, and is absent for a
vessel that has not sent one._

---

**Retrieve tracks for all vessels:**

`/signalk/v1/api/tracks`

_Every vessel the plugin holds a track for in the last 24 hours, the same default window as
above; the window parameters select another, and a vessel with nothing in the window is left
out. Add `?radius=` to narrow it to vessels near your own._

_Each entry carries `isSelf`, so the own vessel can be told from an AIS target without
string-matching the context against the server's self-identity, and `name` for display._

_`?times` works here too, adding a `times` array to every vessel's entry. Note that asking for
times also segments each track on the gap threshold, so `coordinates` and `times` line up;
without `times` each vessel keeps its single unsegmented line._

---

**Retrieve tracks for all vessels within a given radius (in meters) from your vessel position:**

`/signalk/v1/api/tracks?radius=50000`

_Distance from the own vessel's current position, matched against each track's **last** position — "which vessels are near me now". The v2 Track API asks a different question and matches any position in the window._

---

**Retrieve tracks for all vessels within a bounded area:**

`/signalk/v1/api/tracks?bbox=130,-35,139,-33`

_Bounded area is defined as `west, south, east, north` — GeoJSON coordinate order, the
same as the coordinates this endpoint returns, the Resources API, and the v2 Track API._

_A box crossing the antimeridian is expressed with `west` greater than `east`, for
example `bbox=175,-10,-175,10`._

> **Changed:** this parameter was `lat1, lon1, lat2, lon2` — latitude first — up to and
> including 2.0.2. A box in the old order is still four valid numbers, so it will not be
> rejected; it will simply describe a different area. Freeboard-SK is unaffected, as it
> filters by `radius` rather than `bbox`.

## Importing a large file in slices

The Tracks webapp imports a large GPX file of the own vessel in slices
([how-it-works.md](how-it-works.md#importing-a-large-file)). A client does the same through these
routes, which need write access:

- `POST /plugins/tracks/imports/upload` with a JSON body of `filename` and `size`, the file's
  name and size in bytes, `tracks`, the names of the tracks to import (`""` for a track without
  one, the name it has before its first `<trkseg>`), `onOverlap`, `keep` or `replace`, and
  optionally a `fingerprint` of up to 256 characters that tells the file from another of its name
  and size, kept to decide whether an upload broken off is the same file. It answers `201` with
  the `upload`.
- `PUT /plugins/tracks/imports/upload/<id>?offset=<byte>` with the next slice of at most 8 MiB as
  `application/octet-stream`, answered once its points are written. A slice that does not start at
  the upload's `received` is answered `409`, with the upload, to go on from there. The slice that
  brings the file to its size finishes the upload.
- `GET /plugins/tracks/imports/upload` returns the last upload, and
  `DELETE /plugins/tracks/imports/upload/<id>` stops it.

An `upload` carries its `id`, `filename`, `size`, `tracks`, `onOverlap`, its `fingerprint` when
the start gave one, how many bytes it has `received`, its `state` (`receiving`, `finished`,
`aborted` or `failed`, with an `error`), and how many points it `imported`, left out as
`overlapping`, and left out as `untimed`.

## Client library

The package also exports a client side `TrackAccumulator` class that manages the track for a single
vessel, exposing the result as `Observable<LatLngTuple[]>`.
