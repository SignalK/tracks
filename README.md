# @signalk/tracks-plugin

Signal K server plugin that accumulates vessel positions into tracks and implements the track API.

Positions are accumulated into a per-vessel sliding window using a configured time resolution. The
**Where tracks come from after a restart** setting chooses what happens to them:

| Setting   | Behaviour                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history` | _(default)_ Held in memory, and the own vessel's track is refilled on startup from a history provider such as `signalk-to-influxdb2` or `signalk-questdb`. |
| `sqlite`  | Recorded to a database file in the plugin's data directory, so every vessel's track survives a restart with no other plugin required.                      |
| `memory`  | Held in memory only; tracks start empty after a restart.                                                                                                   |

All three work with no other plugin installed — with `history` and no provider present, tracks simply
build up from live data. `sqlite` also takes a retention setting, in days, for how long to keep
positions.

This replaces the earlier `bootstrapFromHistory` checkbox. Existing configurations keep working:
the setting is still read, with `false` mapping to `memory` and anything else to `history`.

The package also exports a client side `TrackAccumulator` class that manages the track for a single
vessel, exposing the result as `Observable<LatLngTuple[]>`.

## Where a track comes from

With a history provider installed — [signalk-questdb](https://www.npmjs.com/package/signalk-questdb),
[signalk-to-influxdb2](https://www.npmjs.com/package/signalk-to-influxdb2) — a track is answered from
both it and the plugin's own store: the provider is the finer record for as long as its retention
reaches, and the store is what remains of everything older or of any period the provider missed.

Nothing needs configuring for this, and the plugin works exactly as before with no provider
installed. See [docs/history-and-storage.md](docs/history-and-storage.md) for what that means in
practice.

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

The same check runs over positions loaded from a history provider at startup, since those carry
the same glitches.

## Pausing while not under way

A boat on a mooring for the winter emits a position every second and travels nowhere. Setting
**Pause recording while navigation.state is one of** stops those months costing any rows.

Off by default, and it needs `navigation.state` to be set — by
[signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) or by hand. A vessel
that reports no state is always recorded, so nothing changes for an install that has not opted in.

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
  "isSelf": true
}
```

_`times` adds a `times` array positionally aligned with `coordinates`: `times[i][j]` is when
`coordinates[i][j]` was recorded, as ISO-8601 UTC. It is opt-in because the response grows by
roughly a third and clients that only draw the geometry have no use for it. Accepts
`true`/`1`/`yes` and `false`/`0`/`no`; a valueless `?times` reads as true._

_`context` is the fully qualified context the track belongs to, and `isSelf` says whether it is
the own vessel. Asking for `self` resolves the alias, so the response tells you which vessel
`self` actually is._

---

**Retrieve tracks for all vessels:**

`/signalk/v1/api/tracks`

_If `maxRadius` is specified only vessels with last track position within this distance are returned._

_Each entry carries `isSelf`, so the own vessel can be told from an AIS target without
string-matching the context against the server's self identity._

_`?times` works here too, adding a `times` array to every vessel's entry. Note that asking for
times also segments each track on the gap threshold, so `coordinates` and `times` line up;
without `times` each vessel keeps its single unsegmented line._

---

**Retrieve tracks for all vessels within a given radius (in meters) from your vessel position:**

`/signalk/v1/api/tracks?radius=50000`

_Note: This value overrides the `maxRadius` value specified in plugin configuration._

---

**Retrieve tracks for all vessels within a bounded area:**

`/signalk/v1/api/tracks?bbox=-35,130,-33,139`

_Bounded area is defined as `lat1, lon1, lat2, lon2`_

_`lat1, lon1` = south-west corner of bounded area_

_`lat2, lon2` = north-east corner of bounded area_

_Note the order is **latitude first**, unlike the GeoJSON this endpoint returns, where
each coordinate is `[longitude, latitude]`. A box crossing the antimeridian is expressed
with `lon1` greater than `lon2`, for example `bbox=-10,175,10,-175`._

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
mounting and the delta path, none of which the unit suite can. It needs a built server checkout;
set `SIGNALK_SERVER_DIR` if yours is not at `~/dev/xxx_signalk-server`. A second tier installs a
real history provider (signalk-questdb) into that server and exercises the startup bootstrap
through it; it skips itself if no QuestDB is reachable at `QUESTDB_URL`. Neither tier runs in CI.

The package is ESM only and targets Node >= 22.5.0, the release that added `node:sqlite`. ESM alone
would only need 20.19, the first release in which the Signal K server's `require()`-based plugin
loader can load an ES module, but the sqlite track source raises the floor. The server itself
requires Node >= 22, so this rules out nothing that could have run the plugin anyway.
