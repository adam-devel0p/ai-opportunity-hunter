# Phase 11 — Autonomous scheduler/worker

**Completed:** 2026-09-11

## What was built

- `src/worker.ts` — the long-running autonomous loop (spec §50-51), split into independently
  testable layers:
  - `recoverStuckWorkItems(db, now, timeoutMs)` — wires Phase 2's pure `crashRecovery.ts`
    primitives to the live `work_items` table for the first time; run once at startup.
  - `ensureDiscoveryWork(db, now)` — keeps the queue's one upstream-less task type flowing: if no
    `DISCOVER` item is in a non-terminal status, picks the next campaign via Phase 3's
    `selectNextCampaign` SWRR algorithm (spec §16) and enqueues one, persisting the round-robin
    weights across restarts.
  - `runWorkerCycle(options)` — one unit of work: checks `system_config`'s autonomous-mode flag
    (spec §71), tops up discovery work, selects the single highest-priority eligible item (spec
    §49, Phase 2's `selectNextWorkItem`), transitions it to `RUNNING`, and dispatches it to the
    matching Phase 3-10 handler via a `TASK_HANDLERS` map — wrapped in try/catch so a thrown
    error is routed through `failureClassification.ts` instead of crashing the process (spec
    §66). Returns a discriminated result (`paused` / `idle` / `ran`) with no side-effecting
    sleep, so it's directly callable from tests.
  - `runWorker(options)` — the actual `while` loop: recovers crashed work once, then repeatedly
    runs one cycle and decides how long to wait before the next (immediate retry after real
    work, an idle poll interval when paused/idle, or an exponential-then-capped backoff after a
    quota-exhausted cycle — spec §51).
  - `main()` — the process entry point (`npm run worker`): opens the real DB, wires
    `SIGINT`/`SIGTERM` to an `AbortController` for graceful shutdown after the current cycle,
    and logs each cycle's outcome.
- `src/lib/config.ts` — new minimal `system_config` accessor, scoped to exactly two keys:
  `getAutonomousMode`/`setAutonomousMode` (spec §71 pause/resume, defaults to `false`) and
  `getCampaignSelectionState`/`setCampaignSelectionState` (persists the SWRR round-robin state
  across worker restarts).
- `scripts/autonomous.ts` — the CLI pause/resume control PLAN.md's Phase 11 text calls for
  ("toggled via a config script/CLI flag until Phase 12 gives it a dashboard control"):
  `npm run autonomous -- --status | --enable | --disable`.
- `launchd/com.aiopportunityhunter.worker.plist.example` — example macOS launchd job (spec §11's
  "run while the laptop is awake" convenience), with placeholder paths the operator must fill in
  before use; not auto-installed by anything.
- `package.json` gained `"worker"` (`tsx src/worker.ts`) and `"autonomous"`
  (`tsx scripts/autonomous.ts`) scripts.

## Deviations from PLAN.md

None in scope — this phase builds exactly what PLAN.md's Phase 11 section describes: the loop
itself, quota-aware backoff, `system_config`-driven pause/resume, and an example `launchd`
plist. See ADR-0018 for the judgment calls made where PLAN.md/the source spec didn't pin down a
specific mechanism (quota backoff ownership, how `DEFERRED` is reused as the worker's own
quota-exhaustion signal, handler-failure wrapping, the new config accessor's scope, the
discovery-work-replenishment design, `dbPath` threading, `REFRESH_EVIDENCE`'s stub, and the
`.example` plist).

## Testing performed

- `src/lib/config.test.ts` (7 tests): autonomous-mode default/round-trip/upsert; campaign
  selection state default/round-trip/malformed-value fallback.
- `src/worker.test.ts` (14 tests), against real temporary SQLite DBs (`runMigrations`) with
  `claudeClient.invokeClaude` mocked (so no real `claude` CLI is ever spawned, no quota spent):
  - `recoverStuckWorkItems`: a stuck `RUNNING` item past the timeout resets to `RETRYABLE`; one
    within the timeout is left alone.
  - `ensureDiscoveryWork`: no-op with no enabled campaigns; creates exactly one `DISCOVER` item
    when none is in flight; refuses a second while one is still non-terminal; creates a new one
    again once the prior item reaches a terminal status.
  - `runWorkerCycle`: returns `paused` when autonomous mode is off (the default); returns `idle`
    with nothing eligible; runs the real handler map end-to-end for a `PRESCREEN` item (asserts
    the company's lifecycle actually updates); accepts an injected handler override without
    touching `claudeClient` at all; marks `DEFERRED` on a `quota_exhausted` result without
    throwing; and — the literal test for spec §66's "one failure never takes down the loop" —
    catches a handler that throws and verifies the resulting `RETRYABLE` state was written via
    `failureClassification.ts`, not left to propagate.
  - `runWorker` integration tests (PLAN.md's two explicitly required scenarios):
    - **Quota-exhaustion-then-resume:** a mixed-priority queue (a `PRESCREEN` item outranking an
      intentionally-invalid `DISCOVER` item) with `invokeClaude` mocked to return
      `quota_exhausted` then `success`. Asserts: the loop backs off (`sleep` called once with the
      configured backoff value) before retrying, the *same* work item is picked back up and
      completed on the next cycle (no duplicate row), the lower-priority `DISCOVER` item is never
      touched, and real downstream progress happened (a `RESEARCH` item was enqueued).
    - **Crash recovery then continue:** a `PRESCREEN` item seeded directly as `RUNNING` with a
      stale `startedAt`; `runWorker` recovers it to `RETRYABLE` at startup and completes it in the
      very next cycle.
    - Pause/resume takes effect immediately: autonomous mode off yields exactly one `paused`
      cycle and zero `invokeClaude` calls.
- Manual (zero-cost) smoke test against the real project DB (`./data/aoh.db`, autonomous mode
  left at its default `false`): `npm run autonomous -- --status` correctly reports `DISABLED`;
  `npm run worker`, run for a few seconds and stopped with `SIGINT`, starts cleanly, logs
  `paused (autonomous mode off)` on its one cycle, and shuts down gracefully with no errors. A
  real multi-hour autonomous run (PLAN.md's third acceptance criterion) was **not** performed
  this phase — see ADR-0018 part 9 for why, and the "Known limitations" section below.
- `npm run build && npm run lint && npm test` — build and lint clean; full suite
  **40 test files, 371 tests, all passing** (up from the prior phase's count by the 21 tests this
  phase adds).

## New decisions

ADR-0018 (`docs/DECISIONS.md`) — ten parts covering: reusing `DEFERRED` as the cross-handler
quota-exhaustion signal at the worker level; keeping quota backoff as in-memory worker state
rather than per-item `runAfter`; wrapping every handler dispatch in try/catch inside
`runWorkerCycle` (the first phase where spec §66's "one failure never takes down the loop" is
literally true); the new `src/lib/config.ts`'s deliberately narrow two-key scope; autonomous
mode's safe `false` default; `ensureDiscoveryWork`'s one-in-flight discovery-replenishment
design; threading `RunResearchTaskOptions`'s `dbPath` through a shared `TaskHandler` type;
`REFRESH_EVIDENCE`'s deterministic-failure stub; and the `.example` launchd plist.

## Known limitations / follow-ups

- No live multi-hour autonomous run has been performed against real campaigns/companies yet
  (ADR-0018 part 9) — the operator should run one deliberately (`npm run autonomous -- --enable`
  then `npm run worker`, left running for a real stretch) and inspect `work_items`/
  `companies.notes`/the worker's log output afterward before fully trusting the scheduling/backoff
  design at real usage volumes. This is the same category of deferred live verification as
  Phases 8-10's offer/contact/outreach smoke tests.
- `src/lib/config.ts` is intentionally minimal (two keys) — every other `system_config` key
  DATABASE_SCHEMA.md eventually wants (score threshold, pricing bands, country/industry
  allowlists, discovery volume, model aliases, ...) is still unwritten. Phase 14 is where a
  general accessor/config UI belongs.
- `ensureDiscoveryWork` caps in-flight `DISCOVER` items at one. If real usage shows the queue
  going idle for meaningful stretches while waiting on a single slow/quota-deferred `DISCOVER`
  item even though multiple campaigns are enabled, this cap is a reasonable thing to revisit.
- The worker's quota backoff (30 min base, doubling, capped at 4h) is a reasoned starting point,
  not empirically tuned against real usage-limit reset timing — same category as every earlier
  phase's placeholder constants (ADR-0008/0009/0012/0014/0015).
- `REFRESH_EVIDENCE` still has no real handler (Phase 14 scope) — `src/worker.ts`'s entry for it
  is a deterministic-failure stub that should never actually fire given nothing creates such
  items yet.
- The `launchd` plist is a convenience template, not tested end-to-end as an installed
  `launchctl` job in this phase (would require installing a persistent machine-level job on the
  development machine, which is exactly the kind of side effect ADR-0018 part 10 avoids without
  the operator's explicit request) — `npm run worker` directly is the verified path.

## Next phase

`docs/PHASES.md` now points to **Phase 12 — Dashboard MVP** as current, with Phase 13 (feedback
loop) as next after that. The dashboard phase should give `system_config`'s autonomous-mode
toggle (currently `scripts/autonomous.ts`) a real UI control, and is a natural place for
`src/lib/config.ts` to grow into the general settings accessor DATABASE_SCHEMA.md describes.
