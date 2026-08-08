# SignalK/tracks

Track accumulation for Signal K: an in-memory sliding window of vessel positions, plus the HTTP track API that serves them.

These guidelines are written for AI coding assistants, but they apply equally to human contributors. Where something looks overly specific, it's a guardrail for AI tools — humans should use judgment and follow the spirit.

## One package

The repo publishes a single package, `@signalk/tracks-plugin`: the position accumulator, the plugin, the API routes, and a client-side `TrackAccumulator`.

It was formerly two — a `module/` workspace publishing `@signalk/tracks` plus a four-line root wrapper — which is why the tag list carries historical `m<version>` tags alongside `v<version>`. Only `v*` tags are cut now.

The package is **ESM only** (`"type": "module"`) and ships only `dist/`.

## Build and test

```bash
npm ci
npm run build      # vite library build -> dist/index.js + rolled-up index.d.ts
npm test           # vitest
npm run typecheck  # tsc --noEmit (the build itself does not typecheck)
npm run lint       # eslint flat config
npm run format     # prettier --write
```

`tsconfig.json` is strict and then some — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`. Keep them on; they caught real bugs when they went in.

Vite transpiles without type checking, so **`npm run build` passing does not mean the types are sound.** CI runs `typecheck` separately and so should you.

## Architecture

- **Storage is in-memory and bounded.** `Tracks` keeps a `TrackAccumulator` per context, each fed by an RxJS `scan` that slices its buffer to `pointsToKeep`. Nothing is written to disk. A server restart loses every track that isn't re-hydrated at startup.
- **History is the persistence story.** `bootstrapSelfTrack()` calls `app.getHistoryApi()` on startup and refills the buffer from a history provider (signalk-questdb, signalk-to-influxdb2, …). Retries are deliberately patient — a cold boot may need minutes before a provider answers — and it gives up quietly after `BOOTSTRAP_MAX_NO_PROVIDER` "no provider" replies, because most installs have none. **The plugin must stay fully functional with no history provider installed.**
- **`/tracks` is a spatial query.** `radius` and `bbox` filter by _last_ track position. This is the one thing the core v2 History API cannot answer — it has no spatial predicate — and it's the reason this plugin exists as more than a cache.
- **Contexts are fully qualified.** Positions are accumulated under the context carried by the delta, which for the own vessel is `vessels.urn:mrn:...`, never `vessels.self`. Resolve the `self` alias against `app.selfContext` before any lookup — forgetting this is [#18](https://github.com/SignalK/tracks/issues/18).
- **Coordinate order flips at the boundary.** Internally positions are `[lat, lng]` (`LatLngTuple`); GeoJSON output is `[lng, lat]` via `toLngLat`. Check which side of that boundary you're on before "fixing" an order that looks wrong.
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
- **Label the PR so it lands in the right section.** `.github/release.yml` groups the notes: `feature`/`enhancement` → 🚀 Features, `bug`/`fix` → 🐛 Fixes, `documentation` → 📖 Documentation, `dependencies` → 📦 Dependencies. An unlabelled PR still appears, under Other. `skip-changelog` omits it entirely — for changes with nothing to tell a user.
- **Branch from latest `main`.** Hyphens in branch names, not slashes.
- **CI must be green.** `.github/workflows/signalk-ci.yml` calls the canonical `SignalK/signalk-server` reusable workflow across Linux x64/arm64, macOS and Windows on Node 22 and 24.

## Traps worth knowing

- **`main` is load-bearing, despite `exports`.** The Signal K server resolves an installed plugin _by directory_ ([`importOrRequire`](https://github.com/SignalK/signalk-server/blob/master/src/modules.ts)). Node's CJS directory resolution reads `main`, not `exports`, and so does the server's `esm-resolve` fallback — with `exports` alone the resolver returns `undefined` and the plugin fails to load with a bare `MODULE_NOT_FOUND`. Keep both fields pointing at `dist/index.js`.
- **ESM-only needs Node >= 20.19.** That is the release where `require()` learned to load ES modules; below it the server's loader path cannot reach this plugin. Hence `engines.node`.
- **The plugin must keep a default export.** The server's `import()` fallback returns `module.default` with no `?? mod`, so a named-only export loads as `undefined`.
- **The Signal K server runs express 4.** Route patterns use express 4 syntax — a bare `*` wildcard, not express 5's `*splat`. Pin `@types/express` to v4 so the types match the runtime.
- **Publish only `dist/`.** `files` in `package.json` is an allowlist; the package once shipped at 174 MB unpacked because a denylist `.npmignore` failed to exclude `node_modules`. Verify with `npm pack --dry-run` — expect a handful of files and tens of KB.
- **`connectable()` resets by default.** rxjs 7 replaced `publishReplay` + `ConnectableObservable`; its `connectable()` defaults to `resetOnDisconnect: true`, which would drop the accumulated buffer when the last subscriber leaves. The explicit `resetOnDisconnect: false` preserves the old behaviour and a test pins it.
- **The README used to document the wrong path for a single vessel** ([#12](https://github.com/SignalK/tracks/issues/12)) — the route is `/signalk/v1/api/vessels/<vesselId>/track`, not `/signalk/v1/api/tracks/<vesselId>`.
