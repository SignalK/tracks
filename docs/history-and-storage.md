# Where a track comes from

The plugin can answer a query from two places: its own store, and a history
provider such as [signalk-questdb](https://www.npmjs.com/package/signalk-questdb)
or [signalk-to-influxdb2](https://www.npmjs.com/package/signalk-to-influxdb2).
Neither is simply better than the other, which is why both are used.

|                              | The plugin's store                 | A history provider                               |
| ---------------------------- | ---------------------------------- | ------------------------------------------------ |
| How often a position is kept | coarse, at a configurable interval | fine, at whatever interval it was configured for |
| How long it is kept          | see below                          | until its retention drops it                     |
| Size                         | small                              | far larger, which is why retention exists        |

The plugin writes its positions to a SQLite file in its data directory, so they
survive a restart. How long they are kept depends on two settings: the own
vessel's track is kept indefinitely by default, and another vessel is dropped
30 days after its last fix.

So the provider is the finer record of the recent past, and the plugin's store
is what remains of everything older. The interval and the retention are both
settings on the plugin's configuration page, which is where their current
defaults are shown.

## Storage responsiveness and shutdown

SQLite runs in a dedicated worker, including opening the database, queries,
pruning and WAL checkpointing. A slow storage operation therefore does not block
the Signal K server's event loop. This does not make slow storage faster: a track
query can still wait behind earlier writes, while unrelated server requests can
continue.

Positions retain their arrival timestamp (or the supplied observation timestamp)
and coordinates are copied when accepted. Operations are ordered, with one batch
in flight; adjacent waiting mutations commit in one transaction. There is no
extra batching delay or change to the configured recording resolution, spatial
filters or schema. SQLite uses WAL with `synchronous=FULL`. Persisted vessel names are cached from
worker-acknowledged writes; the live data model still takes precedence.

Pending operations are bounded to 10,000 items / 8 MiB of serialized arguments,
including the batch in flight. If recording exceeds either limit, a plugin error
pauses further recording while accepted work drains. Restart the plugin after
storage recovers. Database/worker failures also report an error and stop recording;
uncertain writes are not retried. These errors remain visible instead of being
replaced by the periodic healthy status.

Stopping unsubscribes input immediately, then returns a Promise that resolves
only after accepted work drains, SQLite closes and the worker exits. Plugin
lifecycle callers must await `stop()` before restarting or removing its data
directory. `start()` returns the initialization Promise; track requests submitted
during initialization wait behind it.

Accepted but uncommitted data is still in RAM. Abrupt power loss or forced process
termination can lose pending samples; worker isolation does not promise zero data
loss. The durability of committed records is unchanged. Rollback of plugin code
must never replace the database with an older copy over newly recorded tracks.

## What you get with no history provider

Everything comes from the plugin's own store, at whatever interval it is
configured to keep, for as far back as it has been running. Nothing else is needed, and no other plugin has to
be installed.

```
query window
├──────────────────────────────────────────────────┤
│ plugin store, at the configured interval          │
```

## What you get with one

The provider answers for the period it covers, and the plugin's store fills
everything else.

```
query window: last two years
├───────────────────────────────────────┬──────────┤
│ plugin store, coarse                  │ provider │
│                                       │ finer    │
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
