# Phase 2 — Work queue & state machine

**Completed:** 2026-09-10

## What was built

- `src/pipeline/stateMachine.ts` — three independent, explicit transition tables + validator
  functions (per ADR-0008 part 2, the spec §90 chain is split across three owning enums, so it
  isn't one shared function):
  - `transitionCompanyLifecycle` over `companies.lifecycleStatus`. `EXCLUDED` is a special case
    reachable from any other non-`EXCLUDED` status (spec §61's exclusion system is an operator
    action, not a pipeline stage — see ADR-0009 part 3).
  - `transitionOpportunityStatus` over `opportunities.status`.
  - `transitionWorkItemStatus` over `work_items.status`.
  - All three throw `InvalidTransitionError` (carrying `chain`/`from`/`to`) on an invalid move
    instead of silently succeeding, per PLAN.md's explicit requirement. Status types are
    derived from `typeof <table>.$inferSelect[...]` rather than redeclared, so the enums can't
    drift from `src/db/schema.ts`.
- `src/pipeline/priority.ts` — `TASK_TYPE_PRIORITY` (spec §49's 7-item ordering plus `ANALYZE`/
  `REFRESH_EVIDENCE` placed per ADR-0009 part 1), `isEligibleNow` (status +
  `runAfter`-vs-`now` check), and `selectNextWorkItem(items, now)`: pure selection over queue
  contents, highest priority wins, ties broken by `createdAt` ascending.
- `src/pipeline/failureClassification.ts` — `classifyFailure` (spec §66; defaults to
  `RETRYABLE`, see ADR-0009 part 4 for the exact rule), `computeRetryBackoffMs` (exponential
  from 1 minute, capped at 1 hour), and `resolveFailureOutcome` combining both into a
  `{status, runAfter}` update, validated through `stateMachine.transitionWorkItemStatus`.
- `src/pipeline/crashRecovery.ts` — spec §67: `findStuckRunningItems` (pure filter: `RUNNING` +
  `startedAt` older than `DEFAULT_STUCK_RUNNING_TIMEOUT_MS` = 30 min) and
  `planStuckWorkItemRecovery` (maps stuck items to a validated `RETRYABLE` transition plan).
- Docs updated: `ARCHITECTURE.md` (new `src/pipeline/` section, folder layout, "Known
  limitations"), `DECISIONS.md` (new ADR-0009), `PHASES.md` (phase marked done, current/next
  phase advanced).

## Deviations from PLAN.md

- PLAN.md's Phase 2 objective names `src/pipeline/stateMachine.ts` explicitly but doesn't name
  files for priority selection, failure classification, or crash recovery. Split those into
  their own modules (`priority.ts`, `failureClassification.ts`, `crashRecovery.ts`) rather than
  folding everything into `stateMachine.ts`, since they're conceptually distinct concerns with
  their own test suites, and `crashRecovery.ts` already depends on `stateMachine.ts` (not the
  reverse) — keeping them separate avoids a circular-concern single file.
- Spec §49's priority ordering only names 7 of the 9 `taskType` values; `ANALYZE` and
  `REFRESH_EVIDENCE` needed a placement to make `selectNextWorkItem` fully deterministic over
  the whole queue. Placed and justified in ADR-0009 part 1 — a judgment call, not specified by
  the source spec, same category of deviation as ADR-0008's penalty point values.
- `crashRecovery.ts`'s functions operate on plain in-memory objects (`RecoverableWorkItem`),
  not a live DB connection. PLAN.md Phase 2 says crash recovery should be "a function run at
  worker startup," which could be read as wanting DB wiring now — read it instead as "build the
  primitive Phase 11's `worker.ts` will run at startup," consistent with Phase 2's own
  objective line ("task handlers are stubs/fixtures for now") and PLAN.md's Phase 11 section,
  which is where `worker.ts` itself and its startup sequence actually get built.

## Testing performed

**Unit tests (all new this phase, Vitest, no Claude/DB involved except where noted):**
- `src/pipeline/stateMachine.test.ts` (13 tests): every transition declared in each of the
  three tables succeeds; `EXCLUDED` reachable from every other company status but not from
  itself; stage-skipping rejected in both the company chain (`DISCOVERED -> RESEARCHED`) and
  the opportunity chain (`OPPORTUNITY_IDENTIFIED -> VERIFIED`); a cross-chain status that was
  never valid for that enum is rejected, using PLAN.md's own example (`DISCOVERED -> WON`, cast
  since `WON` isn't a `CompanyLifecycleStatus` at the type level — this simulates untrusted/
  legacy runtime data, not a case the type system would normally let through); every terminal
  status (`NO_OPPORTUNITY`/`DISCARDED` for companies, `VERIFIER_REJECTED`/`SENT` for
  opportunities, `COMPLETED`/`FAILED`/`CANCELLED` for work items) rejects every outgoing
  transition; `PENDING -> COMPLETED` (skipping `RUNNING`) rejected.
- `src/pipeline/priority.test.ts` (12 tests): `TASK_TYPE_PRIORITY` matches spec §49's ordering
  exactly (`VERIFY > BUILD_OFFER > FIND_CONTACT > WRITE_OUTREACH > RESEARCH > PRESCREEN >
  DISCOVER`) plus the `ANALYZE`/`REFRESH_EVIDENCE` placement, and `DISCOVER` is confirmed the
  overall lowest; `isEligibleNow` correctly gates on status and `runAfter` vs. `now`;
  `selectNextWorkItem` reproduces PLAN.md's own example (a pending `VERIFY` task selected over
  a pending `DISCOVER` task) plus a 5-item mixed-priority selection, FIFO tie-breaking by
  `createdAt`, and ignoring ineligible items that would otherwise win on priority.
- `src/pipeline/failureClassification.test.ts` (16 tests, `it.each` over fixture messages): all
  ten of spec §66's listed transient causes (DNS, network, rate limit/429, DB locked/
  `SQLITE_BUSY`, timeout, usage limit, page unavailable) classify `RETRYABLE`; an unrecognized
  message defaults `RETRYABLE`; `401`/`403`/`404`/"invalid state transition" classify
  `NON_RETRYABLE`; exhausting `maxAttempts` forces `NON_RETRYABLE` even for an otherwise-
  transient cause; `computeRetryBackoffMs` doubles from 1 minute and caps at 1 hour;
  `resolveFailureOutcome` produces the right `{status, runAfter}` shape for both outcomes.
- `src/pipeline/crashRecovery.test.ts` (7 tests): a `RUNNING` item well past
  `DEFAULT_STUCK_RUNNING_TIMEOUT_MS` is found stuck; one within the timeout is left alone
  (PLAN.md's explicit acceptance criterion, both directions); non-`RUNNING` items are never
  flagged regardless of age; a `RUNNING` item with no `startedAt` is left alone rather than
  guessed at; a custom timeout is respected; `planStuckWorkItemRecovery` produces the validated
  `RETRYABLE` transition plan for stuck items and an empty plan otherwise.
- Existing Phase 0/1 suites (`claudeClient.test.ts`, `models.test.ts`, `schema.test.ts`,
  `normalize.test.ts`, `scoring.test.ts`) unchanged and still passing — Phase 2 touched none of
  those modules.

**Actual command output:**
```
npm run build   → tsc, no errors
npm run lint    → eslint ., no errors or warnings
npm test        → Test Files  9 passed (9); Tests  100 passed (100)
```

## New decisions

[ADR-0009](../DECISIONS.md#adr-0009-phase-2-queuestate-machine-judgment-calls-not-pinned-down-by-the-source-spec):
priority weights for `ANALYZE`/`REFRESH_EVIDENCE`, the work-item transition graph
(`RETRYABLE`/`DEFERRED` go straight back to `RUNNING`; `CANCELLED` only reachable from
non-`RUNNING` states), `DISCARDED` vs. `EXCLUDED` reachability, failure-classification defaults
and the 1m/1h retry backoff schedule, and the 30-minute stuck-`RUNNING` timeout.

## Known limitations / follow-ups

- Nothing in `src/pipeline/` reads or writes a real `work_items`/`companies`/`opportunities`
  row yet — every function operates on plain objects/arrays satisfying a small interface
  (`QueueableWorkItem`, `RecoverableWorkItem`). This is intentional per Phase 2's scope ("task
  handlers are stubs/fixtures for now"); Phase 3 onward is where real handlers start reading
  and writing `work_items` through these primitives.
- `failureClassification.ts`'s pattern lists are a reasoned starting point (see ADR-0009 part
  4), not exhaustive — expect to extend them once Phase 3+ produce real failure messages from
  live web research/Claude calls, same caveat `claudeClient.ts`'s `detectQuotaExhaustion`
  patterns already carry.
- `crashRecovery.ts` isn't called from anywhere yet (no `worker.ts` exists). Phase 11 is where
  it actually runs, once at startup, against a live DB query for `RUNNING` items.
- No `ANALYZE` handler enqueues/consumes work yet — its priority placement (ADR-0009 part 1) is
  currently untested against real usage; flag in Phase 6's completion doc if it turns out to be
  wrong once real opportunities exist.

## Next phase

`docs/PHASES.md` now points to **Phase 3 — Discovery Agent + campaigns** as current, with
Phase 4 (Pre-Screening Agent) next. Phase 3's discovery handler is the first thing that will
actually create `work_items` rows and use `priority.ts`'s `TASK_TYPE_PRIORITY` for real — worth
double-checking at that point that a freshly-inserted `DISCOVER` item's stored `priority` column
is populated from `TASK_TYPE_PRIORITY.DISCOVER` rather than a magic number.
