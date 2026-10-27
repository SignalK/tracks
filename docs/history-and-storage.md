# Where a track comes from

Every query is answered from the plugin's own store. A history provider such
as [signalk-questdb](https://www.npmjs.com/package/signalk-questdb) or
[signalk-to-influxdb2](https://www.npmjs.com/package/signalk-to-influxdb2)
keeps a record of its own, often finer, and often reaching back to before the
plugin was installed. The plugin does not read it when a track is asked for,
but copies the own vessel's part of it into the store once, with the
[history import](#importing-what-the-provider-holds).

The plugin writes its positions to a SQLite file in its data directory, so they
survive a restart. A power cut can still lose the most recent ones, because
they are not forced onto the storage one at a time (on an SD card each such
write can take seconds), but it cannot damage the file. How long they are kept
depends on whose they are: the own vessel's track is kept indefinitely, and
another vessel's positions are dropped after the number of days set in the
plugin settings, whether it is still in range or not. Setting that to 0 keeps
every position.

Once a day is more than a day old, the store also simplifies it, to half a
metre unless the plugin's settings give another tolerance, for every vessel and
for what the history import wrote: a position within that distance of the line
its neighbours draw is deleted, keeping one a minute (see the README's
"Simplifying stored tracks"). An imported day the recording has nothing of
is simplified that way as it is written. This is for speed, and it cannot be undone. To
keep every position, archive a copy of your own: a GPX export, a backup of
`tracks.db`, or the history provider's own record.

The interval and the retention are both settings on the plugin's configuration
page, which is where their current defaults are shown.

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
track: it stays until it is deleted. A timed track imported for the own vessel is
the exception: it is written into the recording, by default only where the
recording has nothing for at least five minutes, or, when asked, in place of
what was recorded over the same time, which goes to the recycle bin first. From then on it is part of the recording like any position.

Deleting a track, or part of one, moves its points into recycle bin tables in the
same database, and restoring moves them back; both are written as imports are.
The retention settings never reach into the bin. Its own retention, 180 days by
default, purges an entry during the regular prune. A recorded span keeps its
entry after its points are purged, because it is also what keeps the history
import out of that span: the History API has no delete, so a provider still
holds the positions.

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

The store still answers every query alone, and a query never waits for the
provider. What the provider holds of the own vessel joins the track once it is
imported, where the plugin had recorded nothing:

```
query window
├──────────────────────────┬───────────────────────┤
│ imported from history,   │ plugin store, as      │
│ before the plugin ran    │ recorded              │
```

A track can therefore change granularity partway along: as fine as the
provider kept it where it was imported, at the configured interval where the
plugin recorded it. That is expected. Passing `resolution` on a query thins the
result to a spacing you choose, which is the way to get an evenly spaced track
regardless of where each part came from. Another vessel's track comes from the
store alone.

## Importing what the provider holds

Asked to, from **Import from history** in the Tracks webapp, the plugin copies the
own vessel's track from the provider into its own store once. It reads a day at
a time, from the first day the provider holds up to the moment the import was
started; live recording covers the time after that.

- **The store first.** A day is read from the store before the provider is
  asked anything, and only stretches of at least five minutes without a stored
  position are filled, as a GPX import of the own vessel fills them. What the
  plugin recorded itself stays as it is, and a day it recorded whole asks the
  provider nothing.
- **Coarse, then fine.** A provider answers every bucket of a range, empty ones
  too, so a whole day read at a second would be 86,400 rows whether it held a
  passage or nothing. The stretches to fill are first read in ten-minute buckets, and
  then a second at a time only where those found positions.
- **Deleted stays deleted.** A span deleted from the recording is left out,
  including one deleted while the day was being read. A delete of the own
  vessel with a provider installed keeps its span even where the store held
  nothing, and after its points are purged, for this.
- **Across midnight.** A stretch the recording left empty over midnight is
  filled on both days, however little of it lies after midnight.
- **One day, one commit.** Each day is written together with the import's
  progress, in a table of the plugin's file, so a stop or a restart goes on
  with the next day. Writing a day twice writes nothing the second time, since
  what the first wrote is then the recording; that is also why an import
  started again after it finished only fills what is still missing.

A read or a write that fails stops the import, keeping the day it was on, and
the plugin's status says so. It goes on from that day when started again, or a minute after
the plugin next starts.

## Where the store has nothing

A track is empty for a period the store holds no positions for, rather than
filled in. That says the vessel was not being recorded, not that it stood
still: the plugin was not running, or recording was paused, deliberately with
the **Pause recording while navigation.state is one of** setting. A history
import fills such a gap of the own vessel from what a provider recorded
meanwhile.
