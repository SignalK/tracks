# Worker review validation — 2026-09-28

Thanks for the detailed review. I have merged current main (including #127 / 3.0.1) and addressed the four main points:

1. **Capacity recovery:** admission resumes automatically when both outstanding items and bytes fall to at most half their limits. Recovery clears the plugin's storage error and logs the gap start and dropped operation count. Accepted work stays FIFO; dropped work is not replayed. An oversized single import also no longer permanently disables recording.
2. **Drain batching:** the whole adjacent run of pending mutations is committed together, bounded by the existing 10,000-item / 8 MiB admission limits. Queries remain FIFO barriers; there is no added batching timer or 128-op cap.
3. **Admission thinning:** leading-edge resolution filtering now happens before position cloning/sizing/queueing, per context. The store's guard remains as well. Imports and pruning preserve/reset the admission state consistently; pruning shares a captured cutoff time with the worker. A regression covers a retained context across pruning so its next resolution boundary is not accidentally skipped.
4. **Read availability:** a rolled-back write failure stops further writes, without terminating the database worker. Committed history remains queryable. Uncertain writes are not retried. Startup/worker failures and uncertain rollback state still fail the whole store. A test deliberately fails a >128-operation transaction, checks atomic rollback, and reads previously committed data afterwards.

Also updated the shutdown caveat and AGENTS.md. The docs now explicitly distinguish awaited plugin stop from server shutdown, which cannot currently guarantee draining. Large-result structured-clone/serialization overhead remains a documented follow-up rather than a claimed fix.

For tests, Vitest now builds the production worker entry into an isolated ignored directory before each run and each watch rerun, instead of a full pretest library/declaration build. Worker-side dependency edits trigger reruns. I exercised watch mode by changing sqliteStore.ts and verified both a new worker artifact and passing rerun. Packaged production-worker loading is checked separately.

Validation on the Raspberry Pi (Linux arm64, Node 24.21.0): **592 passed, 5 skipped, 21 files**; production build, strict TypeScript, ESLint, formatting and diff whitespace checks pass. Extracted package directory loading, startup, write/read, stop/reopen integrity and a real external writer lock were exercised. Real-server/QuestDB E2E and cross-platform CI have not been run locally.

I also compared the published 3.0.1 tarball, the revised packaged worker and our existing local 3.0.0 worker repair on the Pi, using separate fresh databases and synthetic named-vessel data:

- At **one update per second for 60 seconds**, with 60-second recording resolution, strace counted **71 fsync/fdatasync calls for the old repair, 15 for stock 3.0.1, and 14 for this worker** (including startup and close). Each stored the same one position. This confirms the value of #127; these are syscall counts, not inferred counts from WAL file size.
- With 600 synthetic 10-Hz observations delivered at an accelerated 1-ms cadence, three rotated-order runs had median process CPU times of about **767 ms for the old repair and 57 ms for stock 3.0.1**. Three final-candidate runs had median **174 ms**. The worker still has messaging overhead versus synchronous 3.0.1 on healthy storage. These are isolated test-process timings, **not a percentage reduction in total live Pi CPU**; no browser workload is included.
- With a separate connection holding a writer lock for 200 ms, the worker preserved the sample and a scheduled 10-ms main-thread heartbeat completed in **10.5–10.8 ms**. Stock 3.0.1 instead threw `ERR_SQLITE_ERROR` (database locked); it did not wait in this scenario. This is a contention test, not evidence that every remaining fsync stall has been eliminated on the live server.

The live server is still on the existing local repair while these checks run. A real live 3.0.1 A/B trace requires a separately approved server restart; the measurements above deliberately do not claim to be that trace.
