# SignalK/tracks

Track accumulation for Signal K: an in-memory sliding window of vessel positions, plus the HTTP track API that serves them.

These guidelines are written for AI coding assistants, but they apply equally to human contributors. Where something looks overly specific, it's a guardrail for AI tools — humans should use judgment and follow the spirit.

## Two packages, one repo

| Path | Package | What |
|------|---------|------|
| `module/` | `@signalk/tracks` | The implementation: the RxJS accumulator, the plugin, the API routes, and a client-side `TrackAccumulator` |
| `/` (root) | `@signalk/tracks-plugin` | A four-line wrapper whose entire body is `module.exports = require('@signalk/tracks').default` |

The root package is what users install from the App Store; `module/` is what it depends on. They version **independently** — the tag list carries `v<version>` for the wrapper and `m<version>` for the module.

`module/` is declared as an npm workspace, so a single `npm ci` at the root installs both. That matters beyond convenience: CI sandboxes and the Signal K plugin registry run build and test steps **without network access**, so anything not installed by that one root install isn't available when the build runs.

The published wrapper tarball is four files (`index.js`, `package.json`, `README.md`, `LICENSE`). If you change packaging, verify with `npm pack --dry-run` that `module/` hasn't leaked in.

## Build and test

```bash
npm ci          # installs root + module/ (workspace)
npm run build   # tsc in module/
npm test        # mocha in module/
```

Both root scripts delegate to the `module/` workspace. `tsconfig.json` sets `strict`; keep it on.

## Architecture

- **Storage is in-memory and bounded.** `Tracks` keeps a `TrackAccumulator` per context, each fed by an RxJS `scan` that slices its buffer to `pointsToKeep`. Nothing is written to disk. A server restart loses every track that isn't re-hydrated at startup.
- **History is the persistence story.** `bootstrapSelfTrack()` calls `app.getHistoryApi()` on startup and refills the buffer from a history provider (signalk-questdb, signalk-to-influxdb2, …). Retries are deliberately patient — a cold boot may need minutes before a provider answers — and it gives up quietly after `BOOTSTRAP_MAX_NO_PROVIDER` "no provider" replies, because most installs have none. **The plugin must stay fully functional with no history provider installed.**
- **`/tracks` is a spatial query.** `radius` and `bbox` filter by *last* track position. This is the one thing the core v2 History API cannot answer — it has no spatial predicate — and it's the reason this plugin exists as more than a cache.
- **Contexts are fully qualified.** Positions are accumulated under the context carried by the delta, which for the own vessel is `vessels.urn:mrn:...`, never `vessels.self`. Resolve the `self` alias against `app.selfContext` before any lookup — forgetting this is [#18](https://github.com/SignalK/tracks/issues/18).
- **Coordinate order flips at the boundary.** Internally positions are `[lat, lng]` (`LatLngTuple`); GeoJSON output is `[lng, lat]` via `toLngLat`. Check which side of that boundary you're on before "fixing" an order that looks wrong.

## Code quality

- **Scope discipline.** Make only the change requested or clearly necessary. A bug fix doesn't need the surrounding code cleaned up.
- **Self-documenting code.** Comments explain *why*, not *what*. No echo comments.
- **TypeScript with real types.** Avoid `any`. Prefer a pure, testable helper in `utils.ts` over logic inlined in a route handler — that's what makes it reachable from `utils.test.ts`.
- **Tests.** New behaviour needs a test in `module/src/*.test.ts`. Test behaviour, not implementation.

## Contributing

- **One logical change per PR.** Refactors and behaviour changes go in separate PRs.
- **Angular conventional commits:** `<type>(<scope>): <subject>` — `feat | fix | docs | ci | chore | refactor | test | perf`. Imperative, no trailing period.
- **PR titles become release notes.** Releases are generated from merged PR titles by `.github/workflows/release_on_tag.yml`, so write the title as the line you'd want a user to read in the changelog.
- **Branch from latest `main`.** Hyphens in branch names, not slashes.
- **CI must be green.** `.github/workflows/signalk-ci.yml` calls the canonical `SignalK/signalk-server` reusable workflow across Linux x64/arm64, macOS and Windows on Node 22 and 24.

## Traps worth knowing

- **`npm test` used to fail on a clean checkout.** ts-node 9 can't drive TypeScript ≥ 4.7 (it calls `resolveTypeReferenceDirective` with the old signature) and mocha dies before loading a test. Fixed by moving to ts-node 10 — if you see that error again, check whether something pinned it back.
- **`@types/node` is unpinned and transitive,** arriving via `@types/express`. A TypeScript too old to parse the current `@types/node` produces ~50 errors that all point into `node_modules` and none at your code. Read the paths before you start debugging your own change.
- **The README documents the wrong path for a single vessel.** It says `/signalk/v1/api/tracks/<vesselId>`; the route is `/signalk/v1/api/vessels/<vesselId>/track` ([#12](https://github.com/SignalK/tracks/issues/12)).
- **Releases only fire on `v*` tags.** The `m*` module tags interleave chronologically with `v*`, and `generate_release_notes` picks the previous tag across all of them, so releasing both prefixes would measure each against the other's tag.
