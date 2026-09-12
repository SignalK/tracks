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
npm run build      # vite library build -> dist/index.js + rolled-up index.d.ts
npm test           # vitest
npm run test:e2e   # real signalk-server + real QuestDB; never in CI
npm run typecheck  # tsc --noEmit (the build itself does not typecheck)
npm run lint       # eslint flat config
npm run format     # prettier --write
```

**`npm run test:e2e` needs a built `signalk-server` checkout.** It packs the plugin with
`npm pack`, installs the tarball into a throwaway config dir, boots a real server against it,
and feeds positions as deltas over the WebSocket API. That covers what the unit suite mocks:
that the server can resolve and load the package at all (the `main`-vs-`exports` trap above),
that `signalKApiRoutes` mounts where it should, and that deltas reach the plugin through the
real streambundle.

Point it at a checkout with `SIGNALK_SERVER_DIR`, default `~/dev/xxx_signalk-server`; build
that checkout first with `npm run build:all`.

The second tier installs **signalk-questdb** into that server and exercises the query-time
reconciliation through `getHistoryApi()` for real. Test the History API contract, not a provider's storage: how
questdb, influx or anything else keeps its rows is its own business, and a test asserting that
would fail on a provider change that this plugin is unaffected by. It skips itself when nothing
answers at `QUESTDB_URL` (default `http://localhost:9000`), so the server tier still runs
without it.

`tsconfig.json` extends `@tsconfig/node24`, the same base `signalk-server` uses, so both agree on
which built-ins exist rather than drifting apart. Two options are overridden deliberately: that base
sets `module: nodenext` and `moduleResolution: node16` for a Node-resolved application, while this
package is bundled by vite and needs `ESNext`/`bundler`.

Note the tsconfig target governs type checking only — `vite.config.ts` down-levels the shipped
`dist/` to `node20.19` independently, so raising the base does not raise what the published package
requires. `engines.node` is the field that says that.

On top of the base, `tsconfig.json` is strict and then some — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`. Keep them on; they caught real bugs when they went in.

Vite transpiles without type checking, so **`npm run build` passing does not mean the types are sound.** CI runs `typecheck` separately and so should you.

## Architecture

- **Storage is always SQLite.** `start()` builds a `SqliteTrackStore` in the plugin's data directory, so tracks survive a restart with no other plugin involved; without a data directory it reports why and does not start. There is no in-memory alternative and no `source` setting — a track recorder that forgets everything on restart is not worth starting. `TrackAccumulator` remains as the exported client-side helper, not as plugin storage.
- **A history provider enriches a query, it does not replace the store.** Every query reconciles the two through `historyPositions()`: the provider answers for buckets where it has data, the store answers everywhere else. This is best-effort and per query — there is no startup pre-fill. **The plugin must stay fully functional with no history provider installed**; see `docs/history-and-storage.md`.
- **v1 and v2 are different purposes, not old and new.** Both are current, and neither supersedes the other.
  - **v1 `/signalk/v1/api/tracks`** is a **spatial query**: `radius` and `bbox` filter by the vessel's _last_ position — "which vessels are near me now". Situational awareness and collision avoidance; this is what Freeboard uses. It is the one thing the core v2 History API cannot answer, since that has no spatial predicate, and it's the reason this plugin exists as more than a cache.
  - **v2 `/signalk/v2/api/tracks`** is a **track query**: `bbox` matches _any_ position within the window — "which tracks passed through this box" — served through the provider registry with fan-out and `providerId` stamping.
  - The last-position rule is therefore **correct for v1 and wrong for v2**. `TrackParams.intersects` selects between them and is set only by the v2 provider; do not "fix" v1 to match v2.
- **Both entry points honour the same plugin contract.** Whatever the route, an installed history provider enriches the answer (see the storage bullet above and `docs/history-and-storage.md`). The v1 routes have done this since [#73](https://github.com/SignalK/tracks/pull/73); the v2 provider was written store-only and had to be brought back in line. A change to one entry point that silently leaves the other behind makes the plugin contradict itself depending on which route a client happens to use.
- **A vessel's name and a track's label are two different things.** `contextName()` returns the **bare** name (`Ariadne`) and is what the v2 `contextName` property carries — its spec says "Name of the vessel, aircraft or other context, where known. _Not a name for the track itself_". It resolves `name` and nothing else — matching the server's own `findContextName` in `packages/server-admin-ui/src/utils/pathKeys.ts` — and is **undefined** for a vessel that has not sent one. An MMSI is how a vessel is addressed, not what it is called, so it never appears here. `trackLabel()` returns the **display** label (`Own Ship`, `AIS Ariadne`) that v1's `name` carries, the convention TimeZero's GPX exports use; it falls back through the MMSI to the raw context, because a label always has to render something. The two therefore differ for an unnamed vessel by design — v1 says `AIS 987654321`, v2 omits the field — and that is not the plugin contradicting itself. Do not collapse them: putting a decorated label in `contextName` breaks the v2 contract, and stripping v1's label makes a track list unreadable. Both resolve per request, because an AIS static report can arrive long after the first position, and both accept a vessel's `name` as a **bare string** (how the full data model holds it) or a `{value}` wrapper (how deltas carry it). `app.getPath` is optional — older servers fall back to the MMSI.
- **Thinning and simplification are different operations.** `thin()` decimates by _time_ — one point per N milliseconds, whether the boat was turning or holding a course. `simplify()` (Douglas-Peucker, `simplify.ts`) decimates by _shape_, keeping the points that carry the geometry. A route conversion needs the second: thinning 5,550 recorded points to 30 gives 30 evenly spaced positions that miss every turn, while simplifying to 30 gives the turns. In the v2 provider simplification runs **after** thinning, and `epsilon` implies `simplify` per the spec; `simplify` alone derives a tolerance from the extent of the track as thinning left it — one part in a thousand of its diagonal, with a one-metre floor so a vessel swinging at anchor still collapses. The extent is measured before simplification, because the post-simplification extent is what the tolerance produces. It is derived from the extent at all because a fixed metre value cannot suit both an ocean crossing and a marina approach.
- **The webapp is plain static files, deliberately.** `public/` ships as-is and the server mounts it at `/@signalk/tracks-plugin` from the `signalk-webapp` keyword; there is no build step, because a bundler would mean a second build output for a page this size. Two consequences: `public` must stay in the `files` allowlist or the webapp silently vanishes from the published package, and everything the page references must be **relative**, since it is served from a scoped path. It is a pure client of the v2 API — note that API **refuses an unbounded multi-context query**, so the list passes a `duration`. Its label logic duplicates `trackLabel()` because it cannot import from `src/`; `webapp.test.ts` pins the two together.
- **GPX parsing goes through a real XML parser.** `gpx.ts` reads with `@xmldom/xmldom` and writes by hand, because a pattern cannot tell markup from text — a commented-out `<trk>`, or a `<trkseg>` inside CDATA, is text. Two consequences follow. **A document that is not well-formed yields no tracks** rather than the readable half, since returning part of a broken file claims a success it does not support. And **an invalid character reference does not survive a round trip**: the parser decodes `&#0;` into a character XML cannot express, and `toGpx` drops it on the way out. Values are checked on top of the parser, not by it: a coordinate must be an `xsd:decimal` within ±90/±180, a `<time>` must be an `xsd:dateTime` (`Date.parse` alone reads a bare `2024` and rolls `2024-02-30` into March), structural elements must be in GPX's namespace or none, and the Signal K context is matched on its **namespace URI** in the track's own `<extensions>` — never a trackpoint's, or a foreign `<context>` claims the vessel's identity. **Points are sorted by time within each segment** and deliberately not across them, because a segment boundary is a gap in recording. `src/__fixtures__/timezero-seams.gpx` covers TimeZero's overlapping 150-point block seams; the real vendor exports run when `TZ_EXPORT_DIR` points at them and skip when it does not. Coordinates are written at seven decimal places (~11 mm), so a round trip moves a position by at most 5.6 mm.
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
- **PR titles become release notes.** Releases are generated from merged PR titles by `.github/workflows/release_on_tag.yml`, so write the title as the line you'd want a user to read in the changelog. There is no CHANGELOG file to maintain.
- **Every PR needs exactly one release-notes label**, enforced by `.github/workflows/require_pr_label.yml`. `.github/release.yml` groups the notes: `feature`/`enhancement` → 🚀 Features, `bug`/`fix` → 🐛 Fixes, `documentation` → 📖 Documentation, `dependencies` → 📦 Dependencies. `skip-changelog` omits the PR entirely — for changes with nothing to tell a user. The two files list the same labels on purpose: adding one to the gate without a matching category in `release.yml` puts the PR back in the uncategorised "Other" bucket the gate exists to prevent.
- **Branch from latest `main`.** Hyphens in branch names, not slashes.
- **CI must be green.** `.github/workflows/signalk-ci.yml` calls the canonical `SignalK/signalk-server` reusable workflow across Linux x64/arm64, macOS and Windows on Node 22 and 24.
- **This file is the review baseline too.** `.coderabbit.yaml` points CodeRabbit here rather than restating the conventions, so a rule added below applies to automated review as well. If a review comment contradicts this file, the review is wrong — or this file is out of date, which is itself worth fixing.

## Traps worth knowing

- **`main` is load-bearing, despite `exports`.** The Signal K server resolves an installed plugin _by directory_ ([`importOrRequire`](https://github.com/SignalK/signalk-server/blob/master/src/modules.ts)). Node's CJS directory resolution reads `main`, not `exports`, and so does the server's `esm-resolve` fallback — with `exports` alone the resolver returns `undefined` and the plugin fails to load with a bare `MODULE_NOT_FOUND`. Keep both fields pointing at `dist/index.js`.
- **`engines.node` is `>=22.5.0`, and two separate things pin it.** ESM-only needs 20.19, the release where `require()` learned to load ES modules; below it the server's loader path cannot reach this plugin. `node:sqlite` needs 22.5.0, and the higher of the two wins. The server's own floor is `>=22`, so this excludes nothing that could have run the plugin. The reusable CI workflow checks the declared floor against the built-ins actually imported and **fails the build** on a mismatch — so adding a newer built-in means raising `engines.node` in the same PR.
- **The plugin must keep a default export.** The server's `import()` fallback returns `module.default` with no `?? mod`, so a named-only export loads as `undefined`.
- **The Signal K server runs express 4.** Route patterns use express 4 syntax — a bare `*` wildcard, not express 5's `*splat`. Pin `@types/express` to v4 so the types match the runtime.
- **`files` is an allowlist, and it is short.** `dist/`, `public/` and the icon — nothing else. The package once shipped at 174 MB unpacked because a denylist `.npmignore` failed to exclude `node_modules`. Dropping `public/` is the opposite failure and just as quiet: the plugin still works and the webapp is simply absent. Verify with `npm pack --dry-run` — expect a few dozen files and tens of KB, `public/` among them.
- **`connectable()` resets by default.** rxjs 7 replaced `publishReplay` + `ConnectableObservable`; its `connectable()` defaults to `resetOnDisconnect: true`, which would drop the accumulated buffer when the last subscriber leaves. The explicit `resetOnDisconnect: false` preserves the old behaviour and a test pins it.
- **The README used to document the wrong path for a single vessel** ([#12](https://github.com/SignalK/tracks/issues/12)) — the route is `/signalk/v1/api/vessels/<vesselId>/track`, not `/signalk/v1/api/tracks/<vesselId>`.
