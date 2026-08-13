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
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run format     # prettier --write
```

The package is ESM only and targets Node >= 22.5.0, the release that added `node:sqlite`. ESM alone
would only need 20.19, the first release in which the Signal K server's `require()`-based plugin
loader can load an ES module, but the sqlite track source raises the floor. The server itself
requires Node >= 22, so this rules out nothing that could have run the plugin anyway.
