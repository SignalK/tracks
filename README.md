# @signalk/tracks and @signalk/tracks-plugin
This repo contains two npm modules:
- `@signalk/tracks` - RxJs based module that accumulates positions into a track, using a configured time resolution and retains a sliding window of points. Contains the code for both a Signal K server plugin that implements the track api and client side "TrackAccumulator" class that manages the track for a single vessel. TrackAccumulator can optionally bootstrap the track data from the server. The result is available as `Observable<LatLng[]>`.
- `@signalk/tracks-plugin` Convenience module that exposes the plugin part of `@signalk/tracks`.


# Tracks
Plugin for tracks accumulation and the track API

# In memory vs in database

If you activate the `Use Db` option the data is written to a Sqlite database and persisted over server restarts. Otherwise the accumulated track data is lost when the server is restarted.

The plugin supports one write database and several read databases. It creates the default write database named `tracks.db` under SK settings directory in directory `plugin-config-data/tracks/`. If you place databases that have track data in the same structure they are used for retrieving track data. This allows you to create a track database for each season/trip and store them separately.


# Usage:

__Retrieve tracks for individual vessel:__

`/signalk/v1/api/tracks/<vesselId>`

---

__Retrieve tracks for all vessels:__

`/signalk/v1/api/tracks`

_If `maxRadius` is specified only vessels with last track position within this distance are returned._

---

__Retrieve tracks for all vessels within a given radius (in meters) from your vessel position:__

`/signalk/v1/api/tracks?radius=50000`

_Note: This value overrides the `maxRadius` value specified in plugin configuration._

---

__Retrieve tracks for all vessels within a bounded area:__

`/signalk/v1/api/tracks?bbox=130,-35,139,-33`

_Bounded area is defined as `lon1, lat1, lon2, lat2`_

_`lon1, lat1` = lower left corner of bounded area_

_`lon2, lat2` = upper right corner of bounded area_

---
