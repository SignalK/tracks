# SignalK/tracks

Track accumulation for Signal K: vessel positions kept in memory or in SQLite, plus the HTTP track API that serves them.

These guidelines are written for AI coding assistants, but they apply equally to human contributors. Where something looks overly specific, it's a guardrail for AI tools — humans should use judgment and follow the spirit.

## One package

The repo publishes a single package, `@signalk/tracks-plugin`: the position accumulator, the plugin, the API routes, and a client-side `TrackAccumulator`.

It was formerly two — a `module/` workspace publishing `@signalk/tracks` plus a four-line root wrapper — which is why the tag list carries historical `m<version>` tags alongside `v<version>`. Only `v*` tags are cut now.

The package is **ESM only** (`"type": "module"`) and ships `dist/` plus the webapp's `public/`.

## Build and test

```bash
npm ci
npm run build      # vite library build -> dist/index.js, trackStoreWorker.js + index.d.ts
npm test           # vitest; global setup builds the worker entry first
npm run test:watch # rebuilds the worker before each rerun
npm run test:e2e   # real signalk-server + real QuestDB; its own CI job
npm run typecheck  # tsc --noEmit (also run inside the build, via vite-plugin-checker)
npm run lint       # eslint flat config
npm run format     # prettier --write
```

The unit runner builds the production worker entry into ignored `.vitest-worker/`
before a run and before watch reruns, without the full declaration/typecheck
build. Worker dependencies trigger a full rerun because Vitest cannot see across
the thread boundary. Direct `vitest` invocation also runs this setup. Production
packaging still uses `npm run build` and must be smoke-tested from the tarball.

**`npm run test:e2e` needs a `signalk-server` to boot.** It packs the plugin with
`npm pack`, installs the tarball into a throwaway config dir, boots a real server against it,
and feeds positions as deltas over the WebSocket API. That covers what the unit suite mocks:
that the server can resolve and load the package at all (the `main`-vs-`exports` trap above),
that `signalKApiRoutes` mounts where it should, and that deltas reach the plugin through the
real streambundle.

Point `SIGNALK_SERVER_DIR` at a checkout, default `~/dev/xxx_signalk-server`, built first with
`npm run build:all`, or at an installed package's `node_modules/signalk-server`. CI does the
latter, against the oldest release with the v2 Track API and the newest.

The second tier installs **signalk-questdb** into that server and exercises the query-time
reconciliation through `getHistoryApi()` for real. Test the History API contract, not a provider's storage: how
questdb, influx or anything else keeps its rows is its own business, and a test asserting that
would fail on a provider change that this plugin is unaffected by. It skips itself when nothing
answers at `QUESTDB_URL` (default `http://localhost:9000`), so the server tier still runs
without it. A skipped test there counts as passed, so `QUESTDB_REQUIRED` makes a missing
QuestDB fail the run instead; CI sets it and runs QuestDB as a service container.

`tsconfig.json` extends `@tsconfig/node24`, the same base `signalk-server` uses, so both agree on
which built-ins exist rather than drifting apart. Two options are overridden deliberately: that base
sets `module: nodenext` and `moduleResolution: node16` for a Node-resolved application, while this
package is bundled by vite and needs `ESNext`/`bundler`.

Note the tsconfig target governs type checking only — `vite.config.ts` down-levels the shipped
`dist/` to `node20.19` independently, so raising the base does not raise what the published package
requires. `engines.node` is the field that says that.

On top of the base, `tsconfig.json` is strict and then some — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`. Keep them on; they caught real bugs when they went in.

Vite transpiles without type checking on its own, so the build runs `tsc` through
`vite-plugin-checker` and fails on the first error — **`npm run build` passing does mean the
types are sound.** `npm run typecheck` is still the quick way to check them without
building, and CI runs it separately. The checker is skipped under vitest, where a type
error in an unrelated file should not stop the suite.

## Architecture

- **Storage is always SQLite.** `start()` builds an `AsyncTrackStore`; its worker owns a `SqliteTrackStore` in the plugin's data directory, so tracks survive a restart with no other plugin involved; without a data directory it reports why and does not start. There is no in-memory alternative and no `source` setting — a track recorder that forgets everything on restart is not worth starting. `TrackAccumulator` remains as the exported client-side helper, not as plugin storage.
- **A history provider enriches a query, it does not replace the store.** Every query reconciles the two through `historyPositions()`: the provider answers for buckets where it has data, the store answers everywhere else. This is best-effort and per query — there is no startup pre-fill. In the v2 provider history also decides _which_ tracks exist: the store is often far younger than the provider, so contexts the provider lists for the window (`getContexts`) join the ones the store returns, and a `bbox` is matched on their reconciled track. Each provider read is held to a bucket budget (`HISTORY_BUCKET_BUDGET`): a longer window is read at a wider resolution, and then the store wins its buckets, since a widened read is the coarser source (`fillFromHistory`); a window with no start is first probed for where the provider's data begins rather than read from the epoch. **The plugin must stay fully functional with no history provider installed**; see `docs/history-and-storage.md`.
- **v1 and v2 are different purposes, not old and new.** Both are current, and neither supersedes the other.
  - **v1 `/signalk/v1/api/tracks`** is a **spatial query**: `radius` and `bbox` filter by the vessel's _last_ position — "which vessels are near me now". Situational awareness and collision avoidance; this is what Freeboard uses. It is the one thing the core v2 History API cannot answer, since that has no spatial predicate, and it's the reason this plugin exists as more than a cache.
  - **v2 `/signalk/v2/api/tracks`** is a **track query**: `bbox` matches _any_ position within the window — "which tracks passed through this box" — served through the provider registry with fan-out and `providerId` stamping.
  - The last-position rule is therefore **correct for v1 and wrong for v2**. `TrackParams.intersects` selects between them and is set only by the v2 provider; do not "fix" v1 to match v2.
- **Both entry points honour the same plugin contract.** Whatever the route, an installed history provider enriches the answer (see the storage bullet above and `docs/history-and-storage.md`). The v1 routes have done this since [#73](https://github.com/SignalK/tracks/pull/73); the v2 provider was written store-only and had to be brought back in line. A change to one entry point that silently leaves the other behind makes the plugin contradict itself depending on which route a client happens to use.
- **A vessel's name and a track's label are two different things.** `contextName()` returns the **bare** name (`Ariadne`) and is what the v2 `contextName` property carries — its spec says "Name of the vessel, aircraft or other context, where known. _Not a name for the track itself_". It resolves `name` and nothing else — matching the server's own `findContextName` in `packages/server-admin-ui/src/utils/pathKeys.ts` — and is **undefined** for a vessel that has not sent one. An MMSI is how a vessel is addressed, not what it is called, so it never appears here. `trackLabel()` returns the **display** label (`Own Ship`, `AIS Ariadne`) that v1's `name` carries, the convention TimeZero's GPX exports use; it falls back through the MMSI to the raw context, because a label always has to render something. The two therefore differ for an unnamed vessel by design — v1 says `AIS 987654321`, v2 omits the field — and that is not the plugin contradicting itself. Do not collapse them: putting a decorated label in `contextName` breaks the v2 contract, and stripping v1's label makes a track list unreadable. Both resolve per request, because an AIS static report can arrive long after the first position, and both accept a vessel's `name` as a **bare string** (how the full data model holds it) or a `{value}` wrapper (how deltas carry it). `app.getPath` is optional — older servers fall back to the MMSI.
- **Imported tracks are a separate kind of track, not a write into the recording.** `storeTrack` keeps a client's track in its own tables (`imported_tracks`, `imported_points`) under an `imported:<uuid>` id; a recorded track's id is `recorded:<context>`. An import is listed by v2 alongside recorded tracks, filtered on its own points and clipped per posted segment, but it is never reconciled with history, never pruned by either retention, and never returned by v1. Storing and deleting are acknowledged writes outside the recording budget (`docs/history-and-storage.md`), so an import can neither pause nor stop recording. An import with neither times nor a context is refused with `TrackRejectedError`, since nothing could list it again. A GPX upload goes through a plugin route rather than the v2 API, because the server parses only JSON and form bodies; a file with a track that cannot be kept is refused whole. The webapp also lists every import through a plugin route, whatever its time span, because its 30-day v2 query never matches an old or untimed one; servers older than the Track API's write routes name tracks without their provider prefix, so rows are matched on the id less that prefix.
- **A delete moves points to the recycle bin; it never drops them.** `deleteTrack`/`deleteTrackSpan` move rows into the `binned_*` tables, so every store read stays unchanged, and restoring moves them back. Recorded tracks are deletable too, which needs one more step: the History API has no delete, so a provider would refill the window on the next query. Each recorded entry is therefore also a deleted span (`deletedSpans()`), filtered out of history output in `visibleHistory()` for v1 and v2 alike, and it outlives the purge of its points as a tombstone, or purging would bring the history back. A whole delete of a recorded track ends at now: the recording goes on. The bin is purged in `prune()` after `recycleBinDays`, outside both retentions, which must never reach into it.
- **Thinning and simplification are different operations.** `thin()` decimates by _time_ — one point per N milliseconds, whether the boat was turning or holding a course. `simplify()` (Douglas-Peucker, `simplify.ts`) decimates by _shape_, keeping the points that carry the geometry. A route conversion needs the second: thinning 5,550 recorded points to 30 gives 30 evenly spaced positions that miss every turn, while simplifying to 30 gives the turns. In the v2 provider simplification runs **after** thinning, and `epsilon` implies `simplify` per the spec; `simplify` alone derives a tolerance from an extent — one part in a thousand of its diagonal, with a one-metre floor so a vessel swinging at anchor still collapses. The extent is the query's `bbox` when there is one, as the spec's "a tolerance suited to the size of the box" requires, so a viewer's detail follows its zoom; without one it is the track as thinning left it, measured before simplification because the post-simplification extent is what the tolerance produces. A `bbox` without `simplify` simplifies nothing. It is derived from an extent at all because a fixed metre value cannot suit both an ocean crossing and a marina approach.
- **Clipping cuts a track to the v2 `bbox`, before anything else shapes it.** With `clip` on, each stretch inside the box keeps the one point either side of it, so the line reaches the edge, and each re-entry starts a new segment (`breakBefore`, which `thin()` and `segment()` honour). It runs after history reconciliation, since history points cover the whole window, and before `resolution`, `maxPoints` and simplification, so those spend their budget on what is drawn. The sqlite store reads only the stretches near the box for a clipped query (`rowsNearBounds`); that narrows the read and never the answer, because the provider does the clipping. `clip` absent means a server that predates it, and returns whole tracks.
- **A track breaks where the recording stopped, not where its points are spaced.** Thinning spaces the kept points further apart than anything recorded between them, and a history provider's buckets can sit further apart than `segmentGapMinutes` while covering every minute. So `thin()` records on each point it keeps after dropping others the longest pause among them (`pauseBefore`), history points carry their bucket width (`span`), and `segment()` compares `pauseBetween()` with the gap rather than raw timestamps. Where a history point now precedes a stored one, `reconcile()` caps that point's `pauseBefore` at the time since the bucket, since history covered part of the pause. Code that copies or thins points must keep those two fields, or a thinned track falls apart into one-point segments ([#133](https://github.com/SignalK/tracks/issues/133)).
- **The webapp is plain static files, deliberately.** `public/` ships as-is and the server mounts it at `/@signalk/tracks-plugin` from the `signalk-webapp` keyword; there is no build step, because a bundler would mean a second build output for a page this size. Two consequences: `public` must stay in the `files` allowlist or the webapp silently vanishes from the published package, and everything the page references must be **relative**, since it is served from a scoped path. It lists tracks from the v2 API — note that API **refuses an unbounded multi-context query**, so the list passes a `duration` — and links each row to the v1 `track.gpx` route for export, because a page with no bundler cannot reach `toGpx` and duplicating GPX serialisation in it would drift from the module. Its label logic duplicates `trackLabel()` because it cannot import from `src/`; `webapp.test.ts` pins the two together.
- **GPX parsing goes through a real XML parser.** `gpx.ts` reads with `@xmldom/xmldom` and writes by hand, because a pattern cannot tell markup from text — a commented-out `<trk>`, or a `<trkseg>` inside CDATA, is text. Two consequences follow. **A document that is not well-formed yields no tracks** rather than the readable half, since returning part of a broken file claims a success it does not support. And **an invalid character reference does not survive a round trip**: the parser decodes `&#0;` into a character XML cannot express, and `toGpx` drops it on the way out. Values are checked on top of the parser, not by it: a coordinate must be an `xsd:decimal` within ±90/±180, a `<time>` must be an `xsd:dateTime` (`Date.parse` alone reads a bare `2024` and rolls `2024-02-30` into March), structural elements must be in GPX's namespace or none, and the Signal K context is matched on its **namespace URI** in the track's own `<extensions>` — never a trackpoint's, or a foreign `<context>` claims the vessel's identity. **Points are sorted by time within each segment** and deliberately not across them, because a segment boundary is a gap in recording. `src/__fixtures__/timezero-seams.gpx` covers TimeZero's overlapping 150-point block seams; the real vendor exports run when `TZ_EXPORT_DIR` points at them and skip when it does not. Coordinates are written at seven decimal places (~11 mm), so a round trip moves a position by at most 5.6 mm.
- **Both single-track routes read through `readSegments`.** The JSON route and `track.gpx` share one pipeline, so the same query cannot be answered two ways. Export is a route rather than client code for the same reason — `toGpx` stays the single serialiser. Three answers are possible and they are not interchangeable: a **404** means neither source knows the vessel, an empty **200** means a known vessel with nothing in the window, and a **503** means the vessel is known but the source that might have covered it could not be read — reporting that as an empty track would present an outage as an absence of positions. Establishing which requires asking the provider whether it knows the vessel at all, separately from reading its positions, because a windowed read cannot tell an unknown vessel from one whose data lies outside the window. A provider enriches a query and never fails it: wherever the store can answer, it does, and v2 never escalates at all, since one provider's outage must not fail a multi-context query for every other vessel in it.
- **Contexts are fully qualified.** Positions are accumulated under the context carried by the delta, which for the own vessel is `vessels.urn:mrn:...`, never `vessels.self`. Resolve the `self` alias against `app.selfContext` before any lookup — forgetting this is [#18](https://github.com/SignalK/tracks/issues/18).
- **Coordinate order flips at the boundary.** Internally positions are `[lat, lng]` (`LatLngTuple`); GeoJSON output is `[lng, lat]` via `toLngLat`. The `bbox` query parameter is `west,south,east,north` — GeoJSON order, matching the output rather than the internal one, and swapped to `[lat, lng]` corners as it is parsed. It was latitude-first up to 2.0.2. Check which side of that boundary you're on before "fixing" an order that looks wrong.
- **`throttleTime` thins on the leading edge.** A burst of positions inside one `resolution` window contributes exactly one point, and the rest are dropped, not buffered. Tests that feed positions synchronously see a single point unless they advance fake timers past `resolution`.

## Code quality

- **Scope discipline.** Make only the change requested or clearly necessary. A bug fix doesn't need the surrounding code cleaned up.
- **Self-documenting code.** Comments explain _why_, not _what_. No echo comments.
- **TypeScript with real types.** Avoid `any`; prefer `unknown` plus narrowing at the boundary. Prefer a pure, testable helper in `utils.ts` over logic inlined in a route handler — that's what makes it reachable from `utils.test.ts`.
- **Tests.** New behaviour needs a test in `src/*.test.ts`. Test behaviour, not implementation.

## Contributing

- **One logical change per PR.** Refactors and behaviour changes go in separate PRs.
- **Angular conventional commits:** `<type>(<scope>): <subject>` — `feat | fix | docs | ci | chore | refactor | test | perf`. Imperative, no trailing period.
- **Releases are cut by release-please.** Every releasable push to `main` updates a standing release PR titled `chore(release): X.Y.Z`; merging it bumps `package.json`, creates the tag and the GitHub Release, and `.github/workflows/release-please.yml` then dispatches `release_on_tag.yml` on the tag to publish to npm. The version follows the commits: `feat` → minor, `fix` and other releasable types → patch, `!` or a `BREAKING CHANGE:` footer → major; a `Release-As: X.Y.Z` footer overrides it. Do not bump the version in an ordinary PR. Pre-releases (`-beta.N`, `-rc.N`) are still tagged by hand, and `release_on_tag.yml` creates their Release itself.
- **A push with nothing releasable does not touch the release PR.** A gate in `.github/workflows/release-please.yml` decides what counts; its comment lists the cases. Two rules follow from it: revert with a conventional `revert:` subject, since release-please ignores GitHub's `Revert "…"`, and change the gate's last alternative together with `pull-request-title-pattern` in `release-please-config.json`, or the release PR's merge never creates a tag. Dependabot scopes its commits (`build(deps)`, `build(deps-dev)`, `ci(deps)`) so the gate can tell a runtime bump from the rest.
- **PR titles become release notes.** release-please asks GitHub to generate the notes from merged PR titles and their authors, so write the title as the line you'd want a user to read in the changelog. There is no CHANGELOG file to maintain.
- **Labels group the release notes, and the PR title sets them.** `.github/release.yml` maps labels to sections; `.github/workflows/label-by-title.yml` labels each PR from its title's type when it is opened or retitled; its header comment is the mapping. A label set by hand places a PR the same way until its title changes; an unlabelled PR still appears, under Other. The version never depends on labels. A PR merged without a label can be labelled afterwards; run the release-please workflow by hand to rewrite the standing release PR's notes.
- **Branch from latest `main`.** Hyphens in branch names, not slashes.
- **CI must be green.** `.github/workflows/signalk-ci.yml` calls the canonical `SignalK/signalk-server` reusable workflow across Linux x64/arm64, macOS and Windows on Node 22 and 24, and its `e2e` job runs `npm run test:e2e` against signalk-server from npm.
- **This file is the review baseline too.** `.coderabbit.yaml` points CodeRabbit here rather than restating the conventions, so a rule added below applies to automated review as well. If a review comment contradicts this file, the review is wrong — or this file is out of date, which is itself worth fixing.

## Traps worth knowing

- **`main` is load-bearing, despite `exports`.** The Signal K server resolves an installed plugin _by directory_ ([`importOrRequire`](https://github.com/SignalK/signalk-server/blob/master/src/modules.ts)). Node's CJS directory resolution reads `main`, not `exports`, and so does the server's `esm-resolve` fallback — with `exports` alone the resolver returns `undefined` and the plugin fails to load with a bare `MODULE_NOT_FOUND`. Keep both fields pointing at `dist/index.js`.
- **`engines.node` is `>=22.5.0`, and two separate things pin it.** ESM-only needs 20.19, the release where `require()` learned to load ES modules; below it the server's loader path cannot reach this plugin. `node:sqlite` needs 22.5.0, and the higher of the two wins. The server's own floor is `>=22`, so this excludes nothing that could have run the plugin. The reusable CI workflow checks the declared floor against the built-ins actually imported and **fails the build** on a mismatch — so adding a newer built-in means raising `engines.node` in the same PR.
- **The plugin must keep a default export.** The server's `import()` fallback returns `module.default` with no `?? mod`, so a named-only export loads as `undefined`.
- **The Signal K server runs express 4.** Route patterns use express 4 syntax — a bare `*` wildcard, not express 5's `*splat`. Pin `@types/express` to v4 so the types match the runtime.
- **`files` is an allowlist, and it is short.** `dist/`, `public/` and the icon — nothing else. The package once shipped at 174 MB unpacked because a denylist `.npmignore` failed to exclude `node_modules`. Dropping `public/` is the opposite failure and just as quiet: the plugin still works and the webapp is simply absent. Verify with `npm pack --dry-run` — expect a few dozen files and tens of KB, `public/` among them.
- **`connectable()` resets by default.** rxjs 7 replaced `publishReplay` + `ConnectableObservable`; its `connectable()` defaults to `resetOnDisconnect: true`, which would drop the accumulated buffer when the last subscriber leaves. The explicit `resetOnDisconnect: false` preserves the old behaviour and a test pins it.
- **The README used to document the wrong path for a single vessel** ([#12](https://github.com/SignalK/tracks/issues/12)) — the route is `/signalk/v1/api/vessels/<vesselId>/track`, not `/signalk/v1/api/tracks/<vesselId>`.
