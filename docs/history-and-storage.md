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
survive a restart. A power cut can still lose the most recent ones, because
they are not forced onto the storage one at a time (on an SD card each such
write can take seconds), but it cannot damage the file. How long they are kept
depends on two settings: the own vessel's track is kept indefinitely by
default, and another vessel is dropped 30 days after its last fix.

So the provider is the finer record of the recent past, and the plugin's store
is what remains of everything older. The interval and the retention are both
settings on the plugin's configuration page, which is where their current
defaults are shown.

## Storage responsiveness and shutdown

SQLite runs in a dedicated worker, including opening the database, queries,
pruning and WAL checkpointing. A slow storage operation therefore does not block
the Signal K server's event loop. This does not make slow storage faster: a track
query can still wait behind earlier writes, while unrelated server requests can
continue. Large query results still arrive via structured cloning, and their
materialization and HTTP serialization take main-thread time, so the worker
does not remove every source of server latency.

Positions retain their arrival timestamp (or the supplied observation timestamp)
and coordinates are copied when accepted. Operations are ordered, with one batch
in flight; the entire adjacent waiting mutation run commits in one transaction,
bounded by the same queue byte/item limits. Positions
inside a context's resolution window are discarded before cloning/admission;
the worker also retains the store's throttle as a consistency guard. There is no
extra batching delay or change to the configured recording resolution, spatial
filters or schema. SQLite uses WAL with `synchronous=NORMAL`, so a commit does
not sync; the only syncs are the checkpoints, which run in the worker too.
Persisted vessel names are cached from
worker-acknowledged writes; the live data model still takes precedence.

Pending operations are bounded to 10,000 items / 8 MiB of serialized arguments,
including the batch in flight. If recording exceeds either limit, a plugin error
pauses further recording while accepted work drains. Recording automatically
resumes once both item and byte usage reach at most half capacity. The plugin
logs the gap's start time and dropped operation count (operations include names
and maintenance, not just positions). Dropped samples are not replayed.

A failed write transaction stops subsequent writes until a plugin restart;
uncertain writes are never retried. A successful rollback leaves the database
open, so History and v1 queries can still read committed tracks, including when
storage is full. Startup, worker exit or an uncertain rollback fail the whole
store. These errors remain visible instead of being replaced by healthy status.

Imported tracks are kept in tables of their own and written differently from
positions. Storing or deleting one waits for its commit, so the id it is given
reads back at once. It runs in a transaction of its own, so an import that cannot
be stored fails alone and recording carries on. It is admitted outside the limits
above, so a large import neither pauses recording nor is dropped. Once recording
writes have failed, imports are refused too. Retention never removes an imported
track: it stays until it is deleted.

Deleting a track, or part of one, moves its points into recycle bin tables in the
same database, and restoring moves them back; both are written as imports are.
The retention settings never reach into the bin. Its own retention, 180 days by
default, purges an entry during the regular prune. A recorded span keeps its
entry after its points are purged, because it is also what hides that span in a
history provider's answer: the History API has no delete, so a provider still
holds the positions, and the plugin filters them out of every v1 and v2 query.

Stopping unsubscribes input immediately, then returns a Promise that resolves
only after accepted work drains, SQLite closes and the worker exits. Plugin
lifecycle callers must await `stop()` before restarting or removing its data
directory. `start()` returns the initialization Promise; track requests submitted
during initialization wait behind it. This drain covers callers that actually
invoke and await `stop()`, such as a settings change or disabling the plugin.
The current server shutdown path does not guarantee that: a server restart can
lose accepted queued samples even on an otherwise orderly process shutdown.
Do not assume the plugin's async stop promise is awaited by the server.

Accepted but uncommitted data is still in RAM. Abrupt power loss or forced process
termination can lose pending samples; worker isolation does not promise zero data
loss. Committed records are not synced one by one either, so a power cut can
also lose the most recent of them, though never damage the file. Rollback of plugin code
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

## How much is asked of the provider

A provider has no spatial filter, so a query with a box still reads every
position in its time window, and providers produce one row per bucket of that
window whether or not anything was recorded in it. So each read is held to a
fixed number of buckets: a longer window is read at a wider resolution, so the
read stays the same size however far back it reaches.

A history read widened like that is coarser than the plugin's store, so for it
the rule below flips: the store keeps every bucket it has a position in, and
the provider only fills the buckets the store has nothing for.

A window with only an end, such as "everything older than a day", would
otherwise start at the Unix epoch. Instead the plugin first finds where the
provider's positions begin and reads from there, within the same budget; when
the provider has none in the window, it contributes nothing.

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
