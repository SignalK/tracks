# @signalk/tracks-plugin

Signal K server plugin that accumulates vessel positions into tracks and implements the track API.

Positions are recorded to a SQLite file in the plugin's data directory, at a configured time
resolution, so tracks survive a restart with no other plugin required. The plugin is enabled on
install and needs no configuration to start recording.

Requires Signal K server >= 2.33.0 for the v2 Track API; older servers get the v1 routes only.

| Setting                               | Behaviour                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Track resolution                      | Minimum spacing between recorded positions.                                                                 |
| Days to keep other vessels' positions | Drops other vessels' positions older than this, even while a vessel stays in range. 0 keeps every position. |

The plugin's configuration page shows the current defaults, and is the authority on them.

The package also exports a client side `TrackAccumulator` class that manages the track for a single
vessel, exposing the result as `Observable<LatLngTuple[]>`.

## Where a track comes from

Every track is answered from the plugin's own store, a SQLite file in the plugin's data
directory, so tracks survive a restart on their own. Base stations and aids to navigation are not
recorded, since their position never changes.

A history provider — [signalk-questdb](https://www.npmjs.com/package/signalk-questdb),
[signalk-to-influxdb2](https://www.npmjs.com/package/signalk-to-influxdb2) — is not read when a
track is asked for. What it holds of the own vessel reaches the store once, through
[the history import](#importing-from-a-history-provider), and the plugin works fully with no
provider installed. See [docs/history-and-storage.md](docs/history-and-storage.md) for what that
means in practice.

The own vessel is kept indefinitely. Other vessels' positions are kept for the number of
days set in the plugin settings, also for a vessel that never leaves receiver range — a harbour
puts hundreds of AIS targets past a receiver in a day, and keeping every one of them forever is
rarely what anybody wants. Space freed by removing positions is reused for new ones, which slows
the file's growth, but the file never shrinks on its own: only an SQLite `VACUUM` returns that
space to the file system.

### Keeping tracks for years

The own vessel's track is kept here indefinitely. For a track recorded before Signal K, or while
this plugin was not running, a history provider can hold more:
[the history import](#importing-from-a-history-provider) copies what the server's default
provider holds of the own vessel into this plugin's store. Where several providers are installed,
the default is chosen under **Data → Preferences**.

[signalk-questdb](https://www.npmjs.com/package/signalk-questdb) is one such provider. From
2.3.0 it can
[keep the own track past its retention](https://github.com/dirkwa/signalk-questdb#retention-and-the-archive),
and it
[imports a chartplotter's GPX export](https://github.com/dirkwa/signalk-questdb#importing-a-gpx-track)
of any size, which the history import then brings into this plugin.

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
it names a vessel the plugin also records. It is never removed by the retention settings, and never returned by the v1 routes, which answer
where vessels are now. Its own name and any other properties it was posted with come back as
posted. It carries `imported`, the time it was stored, which a recorded track does not, so a
client drawing a vessel's recording can leave the import out of it. Imports stored by a version
before that time was kept are dated to the first start of a version that keeps it.

A timed track of the own vessel is the exception: it is the boat's own passage, logged before
the plugin was installed or by another plotter, so it is written into the own vessel's
recording instead of being kept as an import, and the answer is the recording's id,
`tracks:recorded:<context>`. By default it only fills what the recording is missing: its
points are used where the recording has no position for at least five minutes, and left out
elsewhere, so nothing recorded is overwritten and two sources are never interleaved minute by
minute. Asked to replace instead, it takes the place of what was recorded over the same time: the
positions this plugin stored there go to the recycle bin first, one entry per segment, and with a
history provider installed the entry is kept even where nothing was recorded, so the history
import leaves that time out too. Restoring the entry brings the recording back. An untimed track of the own vessel
stays an import, since it cannot be placed in time.

A track with neither times (`coordTimes`) nor a vessel (`context`) is kept too. No time
window or vessel query matches it, but `GET /plugins/tracks/imports` lists it with every other
import, and `GET /signalk/v2/api/tracks/<id>` returns it.

### Importing a GPX file

The Tracks webapp imports a GPX file from the **Import** form, and a client can do the same
with `POST /plugins/tracks/imports`, the file as the request body with `Content-Type:
application/gpx+xml`. Each track in the file becomes an imported track as above. Ticking
**Tracks of my own vessel** (`?self=true`) files them under the own vessel, which writes a
timed one into the recording; otherwise a track names a vessel only if the file says which, as
the plugin's own GPX export does. Ticking **Replace what my vessel recorded over the same time**
as well (`onOverlap=replace`; the default is `keep`) replaces the recording rather than filling
it.

The file can be at most 25 MiB. A larger export, such as years of a chartplotter's tracks, is
better imported into a history provider; see [Keeping tracks for years](#keeping-tracks-for-years).

In a timed track, points without a time are skipped, and the answer says how many
(`skippedPoints`), as it does for the points left out where the recording already has positions
(`overlappingPoints`). A track posted through the Track API's `POST /signalk/v2/api/tracks` is
always kept beside the recording this way, since that API has no such choice yet. The route
needs write access on a Signal K server that lets a plugin say so, and administrator rights on
an older one.

### Importing from a history provider

With a history provider installed, the Tracks webapp offers **Import from history**. It copies
the own vessel's track from the provider into this plugin's recording, a day at a time from the
first day the provider holds to the moment it was started, at the finest resolution the
provider keeps, one position a second at most. Like a GPX import it fills only stretches of at
least five minutes where the recording has nothing, so what the plugin recorded itself stays as
it is, and a deleted span stays deleted.

The import runs on the server. How far it got shows in the webapp and in the plugin's status,
and a stop or a restart breaks it off only until a minute after the plugin starts again, when
it goes on with the next day. Started again once it has finished, it fills only what is still
missing. A day under way at a second a position is up to 86,400 rows in the plugin's file.

It needs administrator rights. `GET /plugins/tracks/history-import` says whether a provider is
installed (`provider`) and how far the import got (`state`), and `POST` starts it, or resumes
one that stopped.

The webapp lists every imported track, however old and whether or not it has times, next to
the last 30 days of recorded ones, so a passage imported from years ago can be found there. It
can be deleted there on a Signal K server that deletes tracks by id.

`GET /plugins/tracks/imports` returns every imported track, and no recorded ones, each with
`imported`, the time it was stored.

The Tracks webapp exports an imported track as GPX from its row, as it was imported. A client
can download the same file from `GET /plugins/tracks/imports/<id>/track.gpx`, with the id less
its `tracks:` prefix: under the track's own name, and without times if it had none.

## Deleting tracks

`DELETE /signalk/v2/api/tracks/<id>` deletes a track, and with `from`, `to` or both only the
part recorded between them (on a Signal K server that accepts them; an older one refuses the
request rather than deleting the whole track). Deleting needs administrator rights, or write
access on a server with security turned off. The Tracks webapp offers both from each row.

A recorded track has the id `tracks:recorded:<vessel context>`. Deleting it whole removes
what was recorded up to now; the recording goes on, and what it records next is kept. With a
history provider installed a deleted span of the own vessel is kept even where nothing was
recorded, and the history import leaves it out, since the History API has no way to delete data
and the import would otherwise fill it back in.

Nothing deleted is gone at once. It goes to a recycle bin, listed in the Tracks webapp, where it
can be restored or deleted for good, until it is purged after the number of days set in the
plugin settings (180 by default). The retention settings above do not reach into the bin, but
they apply again to what is restored: an AIS vessel's positions restored after they have aged
past the retention are dropped at the next prune. Once a recorded span is purged its points are gone,
but the history import keeps leaving it out for good.

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

Positions the history import brings from a provider are not filtered here — they are that
provider's record, and it is the one that decides what to keep.

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

## Resolution by state

The own vessel can be recorded at a different spacing for each `navigation.state`, finer or
coarser than the track resolution. Out of the box only `anchored` is set, to one second, so the
swing around the anchor shows.

Detail finer than the track resolution is kept in full for a day, and is then simplified with
everything else (see [Simplifying stored tracks](#simplifying-stored-tracks)). With that turned
off, it is thinned by time instead: while a stay at anchor goes on, its older part is thinned only to the spacing an anchor alarm reads the whole stay at, one second
per day of the stay, so it keeps roughly 86,400 points plus the last day. That holds until the
spacing reaches the track resolution, after 10 days at the default ten seconds; from then on the older
part is kept at the track resolution, never coarser. A day after the stay ends, it is thinned back
to the track resolution.

Other vessels have a resolution of their own, the track resolution unless set. Their
`navigation.state` is not used: it is whatever their transponder was last set to, and often stale.
Detail recorded for them finer than the track resolution is thinned the same way.

## Simplifying stored tracks

To keep reads fast on a small board, the plugin simplifies what it stores once a day is more than
a day old. A position that lies within half a metre of the line its neighbours draw is deleted, as
simplifying the track to half a metre would leave it out. One position a minute is kept wherever
the recording had one, so a straight leg never looks like a pause. Half a metre is below a GPS's
own noise. A day recorded every second keeps 3 to 5 % of its positions.

It applies to every vessel, and to what an import writes into the recording: the history import,
and a GPX upload of the own vessel. Imported tracks kept on their own are left as they are.

A track drawn at a tolerance of half a metre or more, which is what a chart asks for, comes out the
same as it would from every position. A track read without one has fewer points.

> **Deleted positions cannot be brought back.** To keep every position, keep a copy of your own
> somewhere else and archive it: a GPX export of the track, a backup of the plugin's `tracks.db`
> taken before updating, or a history provider such as
> [signalk-questdb](https://www.npmjs.com/package/signalk-questdb), which keeps a record of its
> own.

The setting "Simplify stored tracks older than a day to this many metres" sets the tolerance. 0
turns it off, and detail finer than the track resolution is then thinned by time as described
above. Raising it simplifies every day again; lowering it brings nothing back.

After an update that turns it on, the store simplifies what it already holds in the background, a
day at a time, without slowing reads. The database file does not shrink: SQLite reuses the space
for new positions.

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
history provider (signalk-questdb) into that server and exercises the history import through it; it
skips itself if no QuestDB is reachable at `QUESTDB_URL`, unless `QUESTDB_REQUIRED` is set. CI runs
both tiers against the oldest supported signalk-server release and the latest, with QuestDB as a
service container.

The package is ESM only and targets Node >= 22.5.0, the release that added `node:sqlite`. ESM alone
would only need 20.19, the first release in which the Signal K server's `require()`-based plugin
loader can load an ES module, but recording to SQLite raises the floor. The server itself
requires Node >= 22, so this rules out nothing that could have run the plugin anyway.
