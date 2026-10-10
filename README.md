# @signalk/tracks-plugin

Signal K server plugin that accumulates vessel positions into tracks and implements the track API.

Positions are recorded to a SQLite file in the plugin's data directory, at a configured time
resolution, so tracks survive a restart with no other plugin required. The plugin is enabled on
install and needs no configuration to start recording.

Requires Signal K server >= 2.33.0 for the v2 Track API; older servers get the v1 routes only.

| Setting                                        | Behaviour                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Track resolution                               | Minimum spacing between recorded positions.                                    |
| Days of the own vessel's track to keep         | Trims only the own vessel. 0 keeps everything; it is never dropped for idling. |
| Days to keep another vessel after its last fix | Drops a vessel that has gone quiet. 0 keeps every vessel indefinitely.         |

The plugin's configuration page shows the current defaults, and is the authority on them.

The package also exports a client side `TrackAccumulator` class that manages the track for a single
vessel, exposing the result as `Observable<LatLngTuple[]>`.

## Where a track comes from

With a history provider installed — [signalk-questdb](https://www.npmjs.com/package/signalk-questdb),
[signalk-to-influxdb2](https://www.npmjs.com/package/signalk-to-influxdb2) — a track is answered from
both it and the plugin's own store: the provider is the finer record for as long as its retention
reaches, and the store is what remains of everything older or of any period the provider missed.

Nothing needs configuring for this, and the plugin works fully with no provider installed. Its own
store is a SQLite file in the plugin's data directory, so tracks survive a restart on their own.
See [docs/history-and-storage.md](docs/history-and-storage.md) for what that means in practice.

The own vessel is kept indefinitely by default. Other vessels are kept for 30 days after their last
fix — a harbour puts hundreds of AIS targets past a receiver in a day, and keeping every one of them
forever is rarely what anybody wants. Both are settings.

## Imported tracks

A client can store a track of its own, a GPX from a friend or a passage logged by another
device, with `POST /signalk/v2/api/tracks` (Signal K server with
[#3038](https://github.com/SignalK/signalk-server/pull/3038)). The body is a GeoJSON
Feature, the shape a v2 query returns; the plugin answers with an id such as
`tracks:imported:0f0f2a1e-…`, and `GET` or `DELETE /signalk/v2/api/tracks/<id>` fetch or
delete it. Storing needs write access; deleting needs administrator rights, or write
access on a server with security turned off.

An imported track is kept apart from the recording. It is listed by v2 queries like any
other track, filtered by vessel, time window and area, but as a feature of its own even when
it names a vessel the plugin also records. It is never merged with a history provider's data,
never removed by the retention settings, and never returned by the v1 routes, which answer
where vessels are now. Its own name and any other properties it was posted with come back as
posted.

A track needs times (`coordTimes`) or a vessel (`context`). One with neither is refused:
it would match no time window, and a query across every vessel needs one, so it could
only be found again by its id.

### Importing a GPX file

The Tracks webapp imports a GPX file from the **Import** form, and a client can do the same
with `POST /plugins/tracks/imports`, the file as the request body. Each track in the file
becomes an imported track as above. Ticking **Tracks of my own vessel** (`?self=true`) files
them under the own vessel; otherwise a track names a vessel only if the file says which, as
the plugin's own GPX export does.

A file is imported whole or not at all: if any track in it has neither times nor a vessel,
nothing is stored and the reason is shown. In a timed track, points without a time are
skipped, and the answer says how many. The route needs write access on a Signal K server that
lets a plugin say so, and administrator rights on an older one.

## Deleting tracks

`DELETE /signalk/v2/api/tracks/<id>` deletes a track, and with `from`, `to` or both only the
part recorded between them (on a Signal K server that accepts them; an older one refuses the
request rather than deleting the whole track). Deleting needs administrator rights, or write
access on a server with security turned off. The Tracks webapp offers both from each row.

A recorded track has the id `tracks:recorded:<vessel context>`. Deleting it whole removes
what was recorded up to now; the recording goes on, and what it records next is kept. With a
history provider installed the deleted span is hidden in what the provider returns too, since
the History API has no way to delete or hide data and the next query would otherwise fill it
back in.

Nothing deleted is gone at once. It goes to a recycle bin, listed in the Tracks webapp, where it
can be restored or deleted for good, until it is purged after the number of days set in the
plugin settings (180 by default). The retention settings above do not reach into the bin, but
they apply again to what is restored: an AIS vessel restored after its last fix has aged past
the retention is dropped at the next prune. Once a recorded span is purged its points are gone,
but the span stays hidden in the provider's data for good.

## Glitch filtering

A receiver occasionally reports a position far from the vessel — a bad almanac, a multipath
reflection, a unit resetting. On a live map it flickers past. In a stored track it is permanent:
one spike stretches the bounding box across an ocean and draws a line over the chart every time
the track is rendered.

Positions implying a speed above **Discard positions implying a speed above this (knots)** since
the previous accepted fix are discarded, defaulting to 100 knots. That is well above any real
vessel, and glitches usually miss it by orders of magnitude rather than by a little. The test is
speed rather than distance, so a track resuming after a long gap — a passage with the plugin
stopped, or an AIS target reappearing — is not filtered. Set it to 0 to record everything.

Positions a history provider supplies are not filtered here — they are that provider's record, and
it is the one that decides what to keep.

## Pausing while not under way

A boat on a mooring for the winter emits a position every second and travels nowhere. Setting
**Pause recording while navigation.state is one of** stops those months costing any rows.

On by default for `moored`, `not-under-way` and `aground`. It needs `navigation.state` to be set —
by [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) or by hand — and a
vessel that reports no state is always recorded, so an install with no state source behaves as
though this were off. Clear the list to record regardless of state.

Two limits are deliberate. **`anchored` is offered but rarely wanted**: an anchor alarm watches
exactly the track a vessel makes while swinging on its rode, so pausing there would break it.
And **AIS targets are never paused** — their navigational status comes from the transponder and
is often stale, so a vessel under way still reporting `moored` would otherwise vanish from the
track.

While paused, the plugin says so in its status on the server dashboard.

## Position sources

`navigation.position` often arrives from several sources at once — an internal GPS, an AIS
transponder, a plotter echoing its own fix. Signal K decides which one wins through **source
priority**, and the stream this plugin records from is already filtered by it, so normally only
the winning source is stored.

When no priority rule matches the path, though, every source comes through. Their fixes are
metres apart, so the track zigzags between receivers instead of following the boat. If that is
happening, the plugin says so in its status on the server dashboard, naming the sources it has
seen. The fix is to set a source priority for `navigation.position` in the server settings.

# Usage:

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

_`timespan` and `timespanOffset` are also accepted for Freeboard-SK compatibility, where
`timespan=23h&timespanOffset=1` means "23 hours ending an hour ago". They are not part of
the proposed track API and are expected to be superseded by `from`/`to`._

_A parameter these routes do not read is rejected with `400` rather than ignored, so a
typo such as `?duratoin=6h` fails rather than quietly returning the whole retained track.
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

_Every vessel the plugin holds a track for. Add `?radius=` to narrow it to vessels near your own._

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

---

# Development

```bash
npm ci
npm run build      # vite library build -> dist/
npm test           # vitest
npm run test:e2e   # against a real signalk-server; see below
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run format     # prettier --write
```

`npm run test:e2e` packs the plugin, installs it into a throwaway config directory, boots a real
Signal K server against it and feeds positions as deltas — so it covers plugin loading, route
mounting and the delta path, none of which the unit suite can. It needs a server to boot: a built
checkout, by default at `~/dev/xxx_signalk-server`, or an installed package's
`node_modules/signalk-server`, named with `SIGNALK_SERVER_DIR`. A second tier installs a real
history provider (signalk-questdb) into that server and exercises the reconciliation through it; it
skips itself if no QuestDB is reachable at `QUESTDB_URL`, unless `QUESTDB_REQUIRED` is set. CI runs
both tiers against the oldest supported signalk-server release and the latest, with QuestDB as a
service container.

The package is ESM only and targets Node >= 22.5.0, the release that added `node:sqlite`. ESM alone
would only need 20.19, the first release in which the Signal K server's `require()`-based plugin
loader can load an ES module, but recording to SQLite raises the floor. The server itself
requires Node >= 22, so this rules out nothing that could have run the plugin anyway.
