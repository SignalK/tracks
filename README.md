# @signalk/tracks-plugin

Records where your boat and the vessels around it have been, and keeps those tracks for chart
plotters such as Freeboard-SK.

The plugin stores positions in a SQLite file in its data directory, so tracks survive a restart
without any other plugin. It is enabled on install and starts recording with no configuration.
Its webapp and the Signal K Track API need Signal K server 2.33.0 or later. Freeboard-SK draws
trails through the plugin's v1 routes.

## What it does

- **Records the own vessel and AIS targets.** The own vessel's track is kept for good, other
  vessels' for 7 days by default. Turn **Record other vessels (AIS)** off to record the own vessel
  only. Base stations and aids to navigation are not recorded.
- **Leaves out glitches.** A position that would mean an impossible speed, such as a GPS fix
  far off for a moment, is not recorded.
- **Pauses while the boat is not going anywhere.** While `navigation.state` says moored, not
  under way or aground, the own vessel is not recorded. At anchor it is recorded every second,
  so an anchor alarm sees the swing.
- **Keeps reads fast and the file from growing quickly.** Once a day is more than a day old,
  positions that add nothing you could see on a chart are removed. A day recorded every second
  keeps 3 to 5 % of its positions.
- **Imports tracks**: GPX files, including a chartplotter's export of several years, and the
  own vessel's history from a history provider such as
  [signalk-questdb](https://www.npmjs.com/package/signalk-questdb).
- **Exports tracks** as GPX, the own vessel's whole recording in one file.
- **Deletes with a safety net.** A deleted track, or part of one, goes to a recycle bin first.

A gap in a track is time with nothing recorded: the plugin was not running, the GPS had no fix, or
recording was paused.

## The Tracks webapp

Open **Tracks** from the Signal K web apps. It lists:

- **Own vessel**: its whole recording, your own GPX imports included.
- **Other vessels**: as far back as the plugin keeps them, or 30 days where it keeps them for good.
- **Imported tracks**: other boats' tracks you imported, however old.

From a row you can download the track as GPX, or delete it, whole or between two times. A deleted
track waits in the **recycle bin**, 180 days by default, where it can be restored.

### Importing a GPX file

**Import** takes a GPX file.

- **Another boat's track**, a friend's passage say: leave **Tracks of my own vessel** unticked.
  It is kept as an imported track of its own, apart from your recording. Such a file can be up to
  25 MB.
- **Your own boat's tracks**: tick **Tracks of my own vessel**. The webapp reads the file in the
  browser first and lists its tracks, so that you can choose which are your boat's. Then it sends
  the file in slices, so even a chartplotter's export of several years goes through.
  - Tracks of AIS targets the plotter followed are left unticked.
  - Where the file names your boat's track `Own Ship`, as TimeZero does, a passage another boat
    shared that was somewhere else at the same time is noted in the list, and left unticked where
    that is plain. Look over the list before you import.
  - By default the tracks only fill the gaps where your recording has nothing. Tick **Replace
    what my vessel recorded over the same time** to have them take its place instead; what they
    replace goes to the recycle bin.
  - An import that breaks off goes on where it stopped when you import the same file again.

What goes into your recording is simplified like the rest of it, so keep the original file if you
want every point.

### Importing from a history provider

With a history provider installed, **Import from history** copies what it holds of the own vessel
into this plugin's recording. It fills only what the recording is missing, runs on the server,
and goes on after a restart.

### Danger zone

**Danger zone** deletes the whole database and starts again with an empty one, also when the
database no longer opens. It skips the recycle bin and cannot be undone, so export what you want
to keep first. It forgets the parts you deleted too, so a history import afterwards brings them
back.

## Settings

| Setting                                                     | What it does                                                         | Default                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| Track resolution                                            | The shortest time between two recorded positions.                    | 10 s                           |
| Record other vessels (AIS)                                  | Off records the own vessel only.                                     | On                             |
| Days to keep other vessels' positions                       | Other vessels' positions older than this are dropped. 0 keeps them.  | 7                              |
| Split a track after this many minutes without a fix         | Starts a new segment after a gap, so no line is drawn across it.     | 0, off                         |
| Days to keep a deleted track in the recycle bin             | How long a deleted track can be restored.                            | 180                            |
| Simplify stored tracks older than a day to this many metres | How much the daily simplification may move the line. 0 turns it off. | 0.5 m                          |
| Discard positions implying a speed above this (knots)       | The glitch filter. 0 records everything.                             | 100                            |
| Pause recording while navigation.state is one of            | The states in which the own vessel is not recorded.                  | moored, not-under-way, aground |
| Own vessel resolution by navigation.state                   | A different resolution for each state.                               | every second while anchored    |
| Resolution for other vessels                                | The resolution for AIS targets.                                      | the track resolution           |

The plugin's configuration page explains each setting.

## Good to know

- **Updating from 3.7 or earlier.** The first start after updating rewrites `tracks.db`, in the
  plugin's data directory (usually `~/.signalk/plugin-config-data/tracks/`), once, in a format
  that usually takes less than half the space. That takes about 9 seconds for two million
  positions on a Raspberry Pi 5, while the plugin waits.
  - Back up `tracks.db` before updating. An older version cannot read the rewritten file.
  - It needs free disk space for the new file, up to the size of the old one.
  - Close any other program that has the file open, such as an `sqlite3` shell. If something
    keeps the file from being rewritten, the plugin does not start, says why in its status, and
    tries again at its next start.
- **Simplified positions are gone for good.** To keep every position, keep a copy elsewhere: a
  GPX export, a backup of `tracks.db`, or a history provider.
- **The file does not shrink by itself.** The space of dropped or deleted positions is reused for
  new ones.
- **Pausing and the finer recording at anchor need `navigation.state`**, from
  [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) or set by hand. Without
  it, the boat is always recorded at the track resolution. AIS targets are never paused.
- **Several position sources.** If no source priority is set for `navigation.position`, the fixes
  of several receivers can end up in the track and make it zigzag. The plugin then says so in its
  status on the server dashboard. Set a source priority in the server settings.

## More detail

- [docs/how-it-works.md](docs/how-it-works.md): how recording, keeping, simplifying, importing and
  deleting work, in detail.
- [docs/api.md](docs/api.md): the HTTP routes, for clients and integrations.
- [docs/history-and-storage.md](docs/history-and-storage.md): the store, and what a history
  provider adds.

## Development

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
