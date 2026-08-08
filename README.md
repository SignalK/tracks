# @signalk/tracks-plugin

Signal K server plugin that accumulates vessel positions into tracks and implements the track API.

Positions are accumulated into a per-vessel sliding window using a configured time resolution, held
in memory. On startup the plugin can rehydrate the own vessel's track from a history provider (such
as `signalk-to-influxdb2` or `signalk-questdb`) so tracks are available immediately after a restart
instead of starting empty. It works with no history provider installed — tracks simply build up from
live data.

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

**Retrieve tracks for all vessels:**

`/signalk/v1/api/tracks`

_If `maxRadius` is specified only vessels with last track position within this distance are returned._

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

The package is ESM only and targets Node >= 20.19, the first release in which the Signal K server's
`require()`-based plugin loader can load an ES module.
