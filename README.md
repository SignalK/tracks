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

`/signalk/v1/api/tracks?bbox=130,-35,139,-33`

_Bounded area is defined as `lon1, lat1, lon2, lat2`_

_`lon1, lat1` = lower left corner of bounded area_

_`lon2, lat2` = upper right corner of bounded area_

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
