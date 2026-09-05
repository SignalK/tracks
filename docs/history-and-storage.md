# Where a track comes from

The plugin can answer a query from two places: its own store, and a history
provider such as [signalk-questdb](https://www.npmjs.com/package/signalk-questdb)
or [signalk-to-influxdb2](https://www.npmjs.com/package/signalk-to-influxdb2).
Neither is simply better than the other, which is why both are used.

|                              | The plugin's store                     | A history provider                                      |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------- |
| How often a position is kept | once a minute by default, configurable | whatever it was configured for, often every few seconds |
| How long it is kept          | see below                              | until its retention drops it                            |
| Size                         | about 15 MB a year at the default      | far larger, which is why retention exists               |

How long the plugin keeps a position depends on the **Where tracks come from
after a restart** setting: `sqlite` writes to a database file and keeps
positions for as long as its retention setting says, indefinitely by default;
`memory` and `history` hold them in memory only, so a restart empties them.
This page describes the `sqlite` case, where there is a durable store to
reconcile against.

So the provider is the finer record of the recent past, and the plugin's store
is what remains of everything older.

## What you get with no history provider

Everything comes from the plugin's own store: one position a minute, for as far
back as it has been running. Nothing else is needed, and no other plugin has to
be installed.

```
query window
├──────────────────────────────────────────────────┤
│ plugin store, one point a minute                  │
```

## What you get with one

The provider answers for the period it covers, and the plugin's store fills
everything else.

```
query window: last two years
├───────────────────────────────────────┬──────────┤
│ plugin store, one point a minute      │ provider │
│                                       │ ~2s      │
                                        └ retention begins
```

A track can therefore change granularity partway along: coarse where it came
from the store, fine where the provider reached. That is expected. Passing
`resolution` on a query thins the result to a spacing you choose, which is the
way to get an evenly spaced track regardless of where each part came from.

## When the provider has holes

Retention is only one way a provider's coverage can be incomplete. All of these
happen, and all are handled the same way:

- it was installed after the boat had already been recording
- it was disabled for a while, or its database was down
- its retention has dropped the older data

In each case the provider simply returns nothing for that period, and the
plugin's store supplies it instead:

```
├─────────┬──────────────┬─────────┬──────────────┤
│ store   │ provider     │ store   │ provider     │
│         │              │ ↑ provider was down    │
```

Nothing has to be configured for this. The plugin does not read the provider's
retention setting, or ask how long it has been running — it asks for the window
and uses what comes back, so coverage that changes underneath needs no
attention.

## Why the two never double up

A provider aggregates into buckets and stamps each one on its boundary:
`19:00:00.000`, `19:01:00.000`. The plugin's store keeps the time a fix
actually arrived: `19:00:01.212`. The same physical position therefore has two
different timestamps in the two sources, and simply merging them would keep
both.

Instead, each bucket of time is filled from exactly one source: the provider
where it has a position, the store everywhere else. Individual points are never
compared, so there is nothing to get wrong.

## If a vessel was not moving

Neither source has anything, and the track is correctly empty for that period
rather than filled in. A gap in a track means the vessel was not being
recorded — which, with the **Pause recording while navigation.state is one of**
setting, may be deliberate.
