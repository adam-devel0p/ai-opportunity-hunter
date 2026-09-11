# Architecture (current state)

This file describes what is **actually built**, as of the last completed phase. It is not
the plan (see [../PLAN.md](../PLAN.md) for that) — it's updated at the end of every phase to
reflect reality. If this file and the code disagree, the code wins; fix this file.

**Last updated:** Phase 5 (Deep Research Agent + evidence model) — complete. See
[phases/phase-5-deep-research-agent.md](phases/phase-5-deep-research-agent.md) for the full
writeup.

## Status

Phases 0-5 are done. The repo has a working TypeScript toolchain, the Phase 0 Claude-invocation
client, a full SQLite schema (Drizzle) plus the deterministic domain logic (domain
normalization/dedupe, opportunity scoring) from Phase 1, the Phase 2 queue/state-machine
primitives (priority selection, lifecycle transition validation, failure classification, crash
recovery), Phase 3's first real agent + live DB wiring (manually-configured discovery campaigns,
the Discovery Agent, diversity-aware campaign selection, the `DISCOVER` task handler), Phase 4's
second real agent (the Pre-Screening Agent + the `PRESCREEN` task handler), and now Phase 5's
third real agent: the Deep Research Agent + the `RESEARCH` task handler, which persists
provenance-verified evidence and enqueues `ANALYZE` work, plus the ADR-0004 `PostToolUse`
evidence-provenance hook (the first phase to need it — every `WebFetch` call is independently
recorded as a `sources` row). No worker loop, dashboard, or any agent past Deep Research yet —
see PLAN.md Phase 6 onward.

## Actual stack in use

- TypeScript 5.9 (`strict`, `noUncheckedIndexedAccess`), Node.js (developed against v26; repo
  requires `>=20`), ESM (`"type": "module"`, `NodeNext` module resolution).
- `zod` ^3.25 for structured-output validation (v3 API — `.url()`, `safeParse().error.format()`
  — chosen over v4 for now since it's what AGENT_CONTRACTS.md's draft schemas already assume;
  revisit only if a later phase has a concrete reason to move to v4).
- ESLint 10 flat config (`eslint.config.js`) + `typescript-eslint` 8.70 (pins TypeScript to the
  5.x line — typescript-eslint 8.x's peer range is `>=4.8.4 <6.1.0`, so do not bump TypeScript
  to 6.x/7.x without checking typescript-eslint's supported range first).
- Vitest 5 for tests (`vitest.config.ts`).
- `tsx` for running TypeScript scripts directly (`npm run spike:research`).
- Claude invoked as a CLI subprocess (`claude -p ... --output-format json`), never the Agent
  SDK library, never `ANTHROPIC_API_KEY` — see [DECISIONS.md](DECISIONS.md) ADR-0001 and
  ADR-0007.
- `better-sqlite3` ^13 + `drizzle-orm` ^0.45 + `drizzle-kit` ^0.31 (dev) for the database layer
  (ADR-0002). `better-sqlite3` ships prebuilt native binaries for common platforms
  (`prebuilds/`), so it loads without running its `node-gyp rebuild` install script — confirmed
  working in this environment, where install scripts are restricted by default.
- Next.js dashboard: **not yet added** — deferred to Phase 12. Do not add this dependency
  early.

## Folder layout (as actually built)

```
src/
  agents/
    claudeClient.ts           The only place that spawns the `claude` CLI. See below.
    claudeClient.test.ts      Unit tests: env sanitization, quota detection, invocation shape.
    runStructuredAgent.ts     Shared validated-invoke-with-retry layer (Phase 3, ADR-0010 part
                               1) — invokes Claude via claudeClient, parses/validates the result
                               against a caller-supplied Zod schema, retries once with the
                               validation error appended to the prompt. Every agent from Phase 3
                               onward builds on this instead of reimplementing the retry loop.
    runStructuredAgent.test.ts
    discoveryAgent.ts          Discovery Agent (AGENT_CONTRACTS.md §1, Phase 3): Zod schema +
                                hand-mirrored JSON Schema, prompt builder baking in the
                                never-invent-a-company rule (spec §14), `runDiscoveryAgent`
                                (fast model tier per spec §52, WebSearch+WebFetch tools).
    discoveryAgent.test.ts
    prescreenAgent.ts          Pre-Screening Agent (AGENT_CONTRACTS.md §2, Phase 4): Zod schema +
                                hand-mirrored JSON Schema, prompt builder (fast model tier,
                                `WebFetch`-only, ADR-0011 part 2), `runPrescreenAgent`.
    prescreenAgent.test.ts
    deepResearchAgent.ts       Deep Research Agent (AGENT_CONTRACTS.md §3, Phase 5): Zod schema
                                + hand-mirrored JSON Schema, prompt builder (bakes in spec §24's
                                research integrity rules verbatim plus ADR-0012's additions),
                                `runDeepResearchAgent` (reasoning model tier, WebSearch+WebFetch,
                                registers the source-capture hook via `settings`/`extraEnv`).
    deepResearchAgent.test.ts
    sourceCaptureHook.ts       Shared logic for the ADR-0004 `PostToolUse` hook (Phase 5):
                                `buildSourceCaptureHookSettings` (the `--settings` payload,
                                exec-form command+args pointing at the hook script below),
                                `buildSourceCaptureHookEnv` (env vars carrying DB path/company
                                id/task id to the hook's separate OS process), and
                                `extractWebFetchEvent` (parses a PostToolUse payload — used by
                                both this module's settings builder and the hook script itself).
    sourceCaptureHook.test.ts
    schemas/
      deepResearchSpike.ts    Draft Zod + JSON Schema pair for the spike script only —
                               superseded by deepResearchAgent.ts's real contract; kept only
                               because scripts/spike-research.ts still imports it.
  config/
    models.ts                 Tier -> `--model` alias map (ADR-0006).
    models.test.ts
  db/
    schema.ts                  Drizzle schema for all 13 tables (DATABASE_SCHEMA.md).
    client.ts                  `createDb(path)` — opens better-sqlite3 with WAL +
                                foreign_keys pragmas, wraps it in Drizzle.
    migrate.ts                 `runMigrations(path)` — applies `drizzle/*.sql` via
                                drizzle-orm's migrator. Used by both the CLI script below
                                and tests (each test run gets its own temp DB file).
    schema.test.ts             Insert/read round-trip for every table; dedupe rejection test.
  lib/
    normalize.ts                `normalizeDomain(website)` — spec §17 dedupe key.
    normalize.test.ts
    scoring.ts                  Pure opportunity scoring (spec §30-31) — component ranges,
                                 penalty catalog (ADR-0008), raw/adjusted score calculation.
                                 Not wired to real opportunities yet (Phase 6 does that).
    scoring.test.ts
    sourceFreshness.ts          `computeSourceFreshnessState` (spec §23, Phase 5) — deterministic
                                 `sources.freshnessState` derivation: `UNAVAILABLE` for a
                                 non-2xx/missing HTTP status, else `FRESH`/`STALE` by a
                                 configurable age threshold (default 30 days, ADR-0012 part 7).
    sourceFreshness.test.ts
    researchFreshness.ts        `computeNextEligibleResearchAt` (spec §60, Phase 5) —
                                 deterministic `companies.nextEligibleResearchAt` derivation
                                 (default 90-day window, ADR-0012 part 7), set by
                                 `researchHandler.ts` on every successful research run.
    researchFreshness.test.ts
    campaigns.ts                 `discovery_campaigns` CRUD (Phase 3, spec §15): create/list/
                                  get, and operator status toggles (enable/pause/disable/
                                  blacklist — freely reversible, no state-machine restriction)
                                  plus `setCampaignPriority`.
    campaigns.test.ts
  pipeline/
    stateMachine.ts              Lifecycle transition validators for all three §90-derived
                                  enums (company/opportunity/work-item), each its own table +
                                  function. Throws `InvalidTransitionError` on an invalid move.
    stateMachine.test.ts
    priority.ts                  `TASK_TYPE_PRIORITY` (spec §49 ordering, ADR-0009 part 1) and
                                  `selectNextWorkItem` — pure selection over queue contents.
    priority.test.ts
    failureClassification.ts     `classifyFailure` (spec §66, ADR-0009 part 4),
                                  `computeRetryBackoffMs` (1m exponential, capped 1h), and
                                  `resolveFailureOutcome` tying both to a state-machine-validated
                                  work-item update.
    failureClassification.test.ts
    crashRecovery.ts             `findStuckRunningItems` / `planStuckWorkItemRecovery` (spec
                                  §67) — pure functions; not yet wired to a live DB or called
                                  anywhere (Phase 11's `worker.ts` calls this at startup).
    crashRecovery.test.ts
    campaignSelection.ts         `selectNextCampaign` (Phase 3, spec §16, ADR-0010 part 2) —
                                  pure smooth-weighted-round-robin selection over ENABLED
                                  campaigns, weighted by operator-set priority, state threaded
                                  explicitly by the caller (not persisted anywhere yet — Phase
                                  3 runs one campaign at a time via `scripts/discover.ts`).
    campaignSelection.test.ts
    discoverHandler.ts           `runDiscoverTask` (Phase 3) — the first live-DB-wired task
                                  handler: loads the campaign a `DISCOVER` work item targets
                                  (`entityId` holds a campaign id for this task type, ADR-0010
                                  part 3), runs the Discovery Agent, inserts new companies
                                  deduped by normalized domain (global, not per-campaign —
                                  ADR-0010 part 4), transitions each to `PRESCREEN_PENDING`,
                                  enqueues a `PRESCREEN` work item per new company, and
                                  finalizes the `DISCOVER` item (`COMPLETED`, or `DEFERRED` on
                                  quota exhaustion, or routed through `failureClassification`
                                  on other failures — ADR-0010 part 5).
    discoverHandler.test.ts
    prescreenHandler.ts          `runPrescreenTask` (Phase 4) — the second live-DB-wired task
                                  handler: loads the company a `PRESCREEN` work item targets
                                  (`entityId` is a company id here, per DATABASE_SCHEMA.md's
                                  default), short-circuits to `DISCARDED` without ever calling
                                  Claude if `nextEligibleResearchAt` hasn't passed yet (ADR-0011
                                  part 3), otherwise runs the Pre-Screening Agent and acts on its
                                  classification: `DISCARD` → company `DISCARDED`, nothing
                                  re-queued; `MAYBE`/`PROMISING` (treated identically, ADR-0011
                                  part 1) → company `PRESCREENED -> RESEARCH_PENDING` (one DB
                                  write, ADR-0011 part 5) and a `RESEARCH` work item enqueued.
                                  Classification + reasons appended to `companies.notes`
                                  (ADR-0011 part 4). Quota exhaustion/other failures handled the
                                  same way as `discoverHandler.ts`.
    prescreenHandler.test.ts
    researchHandler.ts           `runResearchTask` (Phase 5) — the third live-DB-wired task
                                  handler: loads the company a `RESEARCH` work item targets
                                  (`entityId` is a company id, same convention as `PRESCREEN`),
                                  runs the Deep Research Agent, and persists only the evidence
                                  items whose `sourceUrl` matches a `sources` row the ADR-0004
                                  hook actually recorded for this task (ADR-0012 part 3) —
                                  everything else is dropped, not persisted, with the drop count
                                  surfaced in both the handler's return value and
                                  `companies.notes`. On success: company transitions
                                  `RESEARCH_PENDING -> RESEARCHED` unconditionally (even with
                                  zero surviving evidence, ADR-0012 part 5), `lastResearchedAt`/
                                  `nextEligibleResearchAt` are set via `researchFreshness.ts`,
                                  candidate problems are appended to `companies.notes`, and an
                                  `ANALYZE` work item is enqueued. Quota exhaustion/other
                                  failures handled the same way as `discoverHandler.ts`/
                                  `prescreenHandler.ts`.
    researchHandler.test.ts
scripts/
  spike-research.ts            Phase 0 spike script (see below). Throwaway, not a
                                production agent — no persistence, no Source-row hook.
  campaigns.ts                  Manual campaign CRUD CLI (Phase 3) — create/list/show/enable/
                                 pause/disable/blacklist/priority. `npm run campaigns -- <cmd>`.
  discover.ts                   Runs one real DISCOVER work item against the live `claude` CLI
                                 for a given campaign (Phase 3's manual smoke-test entry point;
                                 no worker loop exists yet). `npm run discover -- --campaign
                                 <id> [--count <n>]`.
  prescreen.ts                   Runs real PRESCREEN work items against the live `claude` CLI
                                 (Phase 4's manual smoke-test entry point). `npm run prescreen --
                                 --company <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING PRESCREEN item.
  research.ts                    Runs real RESEARCH work items against the live `claude` CLI
                                 (Phase 5's manual smoke-test entry point). `npm run research --
                                 --company <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING RESEARCH item.
  hooks/
    captureSourceHook.ts          The ADR-0004 `PostToolUse` hook subprocess entry point (Phase
                                  5) — spawned directly by the `claude` CLI (via `--settings`,
                                  see `src/agents/sourceCaptureHook.ts`), not by this app's own
                                  Node process. Exports a testable `runCaptureSourceHook(...)`
                                  core; `main()` is a thin stdin/env/real-DB shell around it.
    captureSourceHook.test.ts
  db/
    migrate.ts                  `npm run db:migrate` — applies pending migrations to
                                 `AOH_DB_PATH` (default `./data/aoh.db`).
drizzle/
  0000_*.sql, meta/             Generated migration history (`npm run db:generate`).
                                 Committed — this is real schema history, not build output.
docs/
  phases/
    phase-0-foundations.md     Phase 0 completion doc.
    phase-1-data-layer.md      Phase 1 completion doc.
    phase-2-work-queue.md      Phase 2 completion doc.
    phase-3-discovery-agent.md Phase 3 completion doc.
    phase-4-prescreening-agent.md Phase 4 completion doc.
    phase-5-deep-research-agent.md Phase 5 completion doc.
```

Nothing under `src/app` or `src/worker.ts` exists yet — those are Phase 11+ (see PLAN.md's
target layout for what's still to come). No dashboard and no agent past Deep Research exist yet.
Phase 2's `src/pipeline/` modules besides `campaignSelection.ts`/`discoverHandler.ts`/
`prescreenHandler.ts`/`researchHandler.ts` are still deterministic primitives only (pure
functions over plain objects/arrays), not wired to `work_items` reads/writes — that wiring
happens incrementally as each later phase's agent handler is built (Phase 6 onward) and finally
in Phase 11's `worker.ts` loop, which is also what will actually run `campaignSelection.ts`
autonomously instead of the operator picking a campaign by id via `scripts/discover.ts`.

## `src/agents/claudeClient.ts`

Exports:

- `invokeClaude(options: ClaudeInvocationOptions): Promise<ClaudeInvocationResult>` — spawns
  `claude` via `node:child_process.spawn` (no shell, so prompt content can never be interpreted
  as shell syntax) with:
  - `-p <prompt> --output-format json --model <alias>`
  - `--tools <comma-list>` **and** `--allowedTools <same comma-list>` — both required together,
    see ADR-0007. `tools: []` is the explicit way to request zero tools.
  - `--permission-prompts none` always, as a defense-in-depth auto-deny backstop.
  - `--json-schema <json>` when the caller passes `jsonSchema` — confirmed to constrain the
    `result` field to schema-conformant JSON even for tool-using calls (ADR-0007). Not a
    substitute for Zod validation of the parsed result.
  - `--settings <json>` when the caller passes `settings` (Phase 5, ADR-0012 part 1) — used by
    the Deep Research Agent to register the ADR-0004 `PostToolUse` source-capture hook. Omitted
    entirely for every other agent (no call site needs it yet).
  - an explicit `env` built by `buildSanitizedEnv()` merged with any caller-supplied `extraEnv`
    (Phase 5 — context a `--settings`-registered hook subprocess needs, since it can't share
    in-memory state with this process), which clones `process.env` and deletes
    `ANTHROPIC_API_KEY` — never inherited, regardless of what the parent shell or `extraEnv` has
    set (stripped a second time after merging `extraEnv`, defensively).
  - `warnIfApiKeyPresent()` logs a loud console warning (not an error — this app's own calls
    are safe either way) if the *parent* environment has `ANTHROPIC_API_KEY` set, since that's
    a latent foot-gun for other tools run from the same shell (ADR-0001).
- Result is a discriminated union on `status`: `"success"` (with `resultText`, the raw parsed
  CLI JSON, `costUsd`, `durationMs`), `"quota_exhausted"`, `"invalid_json"`, or `"error"`.
  Callers pattern-match on `status`, never on thrown exceptions, for the expected failure
  modes (an actual throw only happens for genuinely unexpected bugs).
- `detectQuotaExhaustion(...)` is exported standalone (pure function over stderr/stdout/exit
  code) specifically so it's unit-testable against fixture text without spawning a real
  process. Current patterns: "you've hit your session limit", "you've hit your weekly limit",
  "usage limit reached", `rate_limit_error`, bare `429`. These are string/regex heuristics, not
  a documented API — expect to add patterns here as real exhaustion messages are observed in
  practice (see ADR-0001's "Consequences").

Not yet built (later phases' responsibility): `work_items`/`prompt_versions` logging (the DB now
exists as of Phase 1, but nothing wires `claudeClient` to it yet).

## `src/db/` (Phase 1)

- `schema.ts` — all 13 tables from `docs/DATABASE_SCHEMA.md` as Drizzle `sqliteTable`
  definitions. IDs are `crypto.randomUUID()` (no extra cuid dependency). Enums use Drizzle's
  `text(col, { enum: [...] })` (TS-level literal union; no DB-level `CHECK`, see ADR-0008 part
  3). JSON-shaped columns (`criteria`, `impactAssumptions`, `dependencies`, `risks`,
  `penalties`, the four `verifier*` arrays, `keyAssumptions`, `system_config.value`) use
  Drizzle's `{ mode: "json" }` text columns with a `$type<T>()` annotation.
- `client.ts` — `createDb(path)` creates the DB file's parent directory if missing (Phase 3
  fix — a fresh checkout's gitignored `./data/` doesn't exist until something creates it),
  opens `better-sqlite3` with `journal_mode = WAL` and `foreign_keys = ON` (SQLite defaults
  foreign keys OFF per-connection; without this pragma the FK references in the schema would
  be silently unenforced), wraps it in `drizzle()`.
- `migrate.ts` — `runMigrations(path)` applies everything in `drizzle/` via
  `drizzle-orm/better-sqlite3/migrator`. Both `scripts/db/migrate.ts` (real DB, path from
  `AOH_DB_PATH`, default `./data/aoh.db`) and `schema.test.ts` (a fresh temp-dir DB per test)
  call this same function — no separate test-only migration path to drift out of sync with what
  actually ships.
- Migrations are generated with `npm run db:generate` (`drizzle-kit generate`, config in
  `drizzle.config.ts` at repo root) and committed under `drizzle/`. Re-run this after any
  `schema.ts` change and commit the resulting SQL file.

## `src/lib/` (Phase 1)

- `normalize.ts` — `normalizeDomain(website)`: builds a `URL` (prepending `https://` if the
  input has no scheme), lowercases the hostname, strips a leading `www.`. Deliberately just
  returns the hostname — path/query/fragment/protocol are never part of it, since `URL.hostname`
  excludes them by construction, so there's no separate stripping step to get wrong. Redirect
  resolution (spec §17's "where reliable") is explicitly not attempted here — it needs a network
  call, which a normalization *function* shouldn't make; if a later phase wants it, it belongs
  in the discovery/pre-screening agent's fetch step, with the result fed back through this same
  function.
- `scoring.ts` — pure scoring per spec §30-31: `SCORE_COMPONENT_RANGES` (the ten components,
  0-20/0-15/.../0-5, summing to `MAX_RAW_SCORE = 100`), `calculateRawScore` (sums components,
  throws `RangeError` on an out-of-range or non-integer component — this is a boundary check on
  data that will come from a Claude agent's structured output in Phase 6, not defensive
  programming against code that can't produce bad values), `PENALTY_CATALOG` (ten named reasons
  from spec §31 with point values chosen in ADR-0008), `buildPenalties`/`calculateAdjustedScore`
  (adjusted score clamped to `[0, 100]`, per DATABASE_SCHEMA.md), and `scoreOpportunity` tying
  all three together. Not wired to real `opportunity_evaluations` rows yet — Phase 6 does that;
  Phase 1 only guarantees the arithmetic itself is correct and tested.
- `sourceFreshness.ts` (Phase 5) — `computeSourceFreshnessState` per spec §23:
  `UNAVAILABLE` for a missing/non-2xx HTTP status, else `FRESH`/`STALE` by
  `DEFAULT_SOURCE_FRESHNESS_THRESHOLD_MS` (30 days, ADR-0012 part 7). The one live call site
  (the hook, at insert time) only ever exercises `FRESH`/`UNAVAILABLE`; `STALE` is
  unit-tested but unreachable until a later phase recomputes freshness for an existing row.
- `researchFreshness.ts` (Phase 5) — `computeNextEligibleResearchAt` per spec §60:
  adds `DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS` (90 days, ADR-0012 part 7) to `now`. Set on
  `companies.nextEligibleResearchAt` by `researchHandler.ts` after every successful research
  run; consumed by `prescreenHandler.ts`'s freshness short-circuit (ADR-0011 part 3).

## `src/pipeline/` (Phase 2)

All four modules are pure/deterministic — no Claude call, no live DB access. They're the
primitives PLAN.md Phase 3+ agent handlers and Phase 11's `worker.ts` build on, not
orchestration themselves.

- `stateMachine.ts` — per ADR-0008 part 2, the spec §90 chain is split across three
  independently-owned enums, so there are three separate transition tables + validator
  functions here, not one shared one: `transitionCompanyLifecycle`,
  `transitionOpportunityStatus`, `transitionWorkItemStatus`. Each throws
  `InvalidTransitionError` (carrying `chain`/`from`/`to`) rather than silently accepting an
  invalid move. `EXCLUDED` is handled as a cross-cutting special case in
  `transitionCompanyLifecycle` (reachable from any other company status, since spec §61
  exclusion is an operator action, not a pipeline stage) rather than repeated in every row of
  `COMPANY_LIFECYCLE_TRANSITIONS` — see ADR-0009 part 3.
- `priority.ts` — `TASK_TYPE_PRIORITY` (spec §49's ordering, plus `ANALYZE`/`REFRESH_EVIDENCE`
  placed per ADR-0009 part 1) and `selectNextWorkItem(items, now)`: filters to
  `PENDING`/`RETRYABLE`/`DEFERRED` items whose `runAfter` has passed (`isEligibleNow`), then
  picks the highest-priority one, breaking ties by `createdAt` ascending (oldest first). Generic
  over any object shape satisfying `QueueableWorkItem`, so it works against plain fixtures now
  and real Drizzle rows later without change.
- `failureClassification.ts` — `classifyFailure({errorMessage, attempts, maxAttempts})` (spec
  §66): defaults to `RETRYABLE` (most listed failure causes are transient), pattern-matches a
  short list of genuinely permanent causes (401/403/404, "invalid state transition") to
  `NON_RETRYABLE`, and treats an item that has exhausted `maxAttempts` (default 3) as
  `NON_RETRYABLE` regardless of cause. `computeRetryBackoffMs(attempts)` is exponential from 1
  minute, capped at 1 hour — deliberately a different, shorter schedule than Phase 11's
  quota-exhaustion backoff (PLAN.md §12), see ADR-0009 part 4. `resolveFailureOutcome` combines
  both into a `{status, runAfter}` work-item update, routed through
  `stateMachine.transitionWorkItemStatus` so an invalid outcome can't be produced silently.
- `crashRecovery.ts` — spec §67: `findStuckRunningItems(items, now, timeoutMs)` is a pure
  filter (`RUNNING` + `startedAt` older than `DEFAULT_STUCK_RUNNING_TIMEOUT_MS` = 30 min, see
  ADR-0009 part 5; a `RUNNING` item with no `startedAt` is left alone rather than guessed at).
  `planStuckWorkItemRecovery` maps those to `{id, nextStatus: "RETRYABLE"}` via the validated
  state-machine transition. Not wired to a live DB or called by anything yet — Phase 11's
  `worker.ts` is what will actually run this once at startup against real `work_items` rows.

## `src/config/models.ts`

`resolveModelAlias(tier: "fast" | "reasoning", env?)` reads `AOH_MODEL_FAST` /
`AOH_MODEL_REASONING` env vars, falling back to defaults `"haiku"` (fast) and `"sonnet"`
(reasoning) — see "Model alias configuration" below for why these specific defaults.

## Model alias configuration

Confirmed against `claude --help` (CLI version 2.1.263) during Phase 0:

> `--model <model>` — Provide an alias for the latest model (e.g. `'fable'`, `'opus'`, or
> `'sonnet'`) or a model's full name (e.g. `'claude-fable-5'`).

Empirically confirmed working aliases (Sept 2026): `sonnet`, `opus`, `haiku`, `fable`. Current
canonical models behind them at time of writing: Sonnet 5 (`claude-sonnet-5`), Opus 5
(`claude-opus-5`), Haiku 4.5 (`claude-haiku-4-5-20251001`), Fable 5.1 (`claude-fable-5-1`).
Aliases always track "latest" for their tier, so exact canonical IDs will drift — that's the
entire point of using aliases via config (ADR-0006) rather than hardcoding IDs. `models.ts`
defaults `reasoning` to `"sonnet"` (used for research/analysis-heavy agents) and `fast` to
`"haiku"` (cheap classification-style calls, e.g. Phase 4 Pre-Screening). Re-check this section
if a future phase's spike calls start returning "unknown model alias" errors.

## Claude CLI invocation findings (Phase 0)

These are load-bearing findings from empirical testing, not assumptions — see ADR-0007 for the
full reasoning:

- `--allowedTools` alone does **not** restrict the available tool set (the full default
  Claude Code toolset, including Bash/Edit/Write, remains available underneath it). `--tools`
  is the flag that actually defines what exists for a given call.
- `--tools` alone (without matching `--allowedTools`) causes every tool call to be denied, and
  on denial the model may answer from training-data recall as if it were fresh research —
  a real, observed fabrication risk, not theoretical. Both flags, aligned, are required.
- `--json-schema` works alongside `--tools`/`--allowedTools`/web search+fetch and reliably
  constrains `result` to schema-shaped JSON with no markdown fences.
- The CLI's `--output-format json` result object includes a `total_cost_usd` field that is
  present regardless of billing source — it is a list-price-equivalent usage estimate, **not**
  proof of which pool (subscription vs. API) actually got billed. Do not use its presence/value
  as a billing-safety check anywhere in this codebase; the operator's claude.ai/console usage
  page is the only real signal (see ADR-0001's verification history).

## Claude CLI hook findings (Phase 5)

Confirmed against Claude Code's hooks reference and empirically in this phase's live smoke test
(see ADR-0012):

- A `PostToolUse` hook fires *after* the tool call already completed — it cannot block, retry,
  or alter the underlying `WebFetch`/`WebSearch` call itself, only annotate/replace what Claude
  sees about it afterward (which this app doesn't use). Its only real use here is the side
  effect: writing a `sources` row.
- Hooks registered via `--settings <json>` (as opposed to a project `.claude/settings.json`) do
  fire in `-p`/headless mode, including the "exec form" (`command` + `args`, no shell) used here.
- `WebFetch`'s `tool_response` is the *small model's extracted answer* to the fetch's own
  prompt, not the raw page — there is no `title` field anywhere in it. The hook therefore never
  populates `sources.title`; it's left null (schema already allows this).
- A cross-host redirect produces **two** separate `PostToolUse` events (one for the original
  URL, one for the followed URL) rather than one — confirmed both in the docs and in this
  phase's live run. The hook records both as independent `sources` rows; this is intentional
  (each represents a real fetch), not a bug.
- `WebSearch`'s `tool_response` contains only result titles/URLs, never fetched page content —
  confirmed both in the docs and by inspecting real `WebSearch` calls in this phase's live run.
  This is why the hook matcher is `"WebFetch"` only (ADR-0012 part 1).

## Known limitations

- `scripts/spike-research.ts` is intentionally throwaway: no persistence, no retry, draft
  schema only, and now superseded by `src/agents/deepResearchAgent.ts`'s real contract. Do not
  import it from real agent code.
- `src/pipeline/stateMachine.ts`, `priority.ts`, `failureClassification.ts`, and
  `crashRecovery.ts` are still pure primitives with no live-DB wiring of their own beyond what
  `discoverHandler.ts` (`DISCOVER`), `prescreenHandler.ts` (`PRESCREEN`), and
  `researchHandler.ts` (`RESEARCH`) call directly. Phase 6 onward wires the rest incrementally;
  Phase 11's `worker.ts` is what runs `crashRecovery` at startup and drives the main loop instead
  of the operator invoking `scripts/discover.ts`/`scripts/prescreen.ts`/`scripts/research.ts` by
  hand.
- `ANALYZE` work items now exist in the live DB (created by `researchHandler.ts` on every
  successful research run) but nothing consumes them yet — Phase 6's Opportunity Analysis Agent
  is the first handler that will pick them up. The 8 real companies from Phases 3-4's manual
  smoke tests are all `RESEARCHED` with a `PENDING` `ANALYZE` work item as of Phase 5's own
  manual smoke test, ready for Phase 6 to exercise without needing a fresh
  discovery/prescreen/research run.
- `src/pipeline/failureClassification.ts`'s pattern lists (transient vs. permanent error text)
  are a reasoned starting point, not exhaustive — Phase 3's live discovery runs didn't exercise
  the failure path (both real runs succeeded), so these patterns are still unvalidated against
  real Discovery Agent failure text; expect to extend them once Phase 4+ produce real failures.
- `updatedAt` columns are set at insert time only in most tables; Phase 3's `discoverHandler.ts`
  is the first code path to actually update rows post-insert (`companies.lifecycleStatus`/
  `lastDiscoveredAt`, `work_items.status`), and it does set `updatedAt` explicitly on every
  update, per DATABASE_SCHEMA.md's "Conventions." Later phases adding new update paths must do
  the same.
- Opportunity scoring (`src/lib/scoring.ts`) is correct and tested in isolation but not wired to
  any real `opportunity_evaluations` row yet — Phase 6 does that.
- No worker loop or scheduler exists yet (Phase 11), so `campaignSelection.ts`'s
  weighted-round-robin selection state is never actually persisted anywhere — Phase 3 only
  proves the pure selection function works; an operator runs discovery one campaign at a time
  via `scripts/discover.ts --campaign <id>`, choosing the campaign themselves rather than
  going through `selectNextCampaign`.
- `system_config` (discovery volume, etc.) and `prompt_versions` are still not written to by
  any code path — Phase 3 kept discovery volume as a code constant/CLI flag instead of building
  a general config-accessor layer for one setting (ADR-0010 part 8), and prompt-template
  versioning has no per-call log to link against yet (ADR-0010 part 9).
- `companies.notes` is now used for several purposes: genuine operator notes, a seeded
  `"Discovery reason: ..."` string (Phase 3, ADR-0010 part 7), a `"Prescreen (...): ..."` line
  (Phase 4, ADR-0011 part 4), and now (Phase 5) a `"Research: N evidence item(s) recorded..."`
  summary plus a `"Research candidate problems: ..."` line — none have a dedicated schema column
  (ADR-0012 part 6). Revisit if a later phase (e.g. the Phase 12 dashboard) needs these
  distinguished as structured fields rather than one free-text audit trail.
- The evidence-provenance cross-check (ADR-0012 part 3: an evidence item's `sourceUrl` must
  match a hook-recorded `sources` row for that task) was exercised for real in this phase's live
  8-company smoke test, not just in fixtures: 1 of 23 evidence items for one company ("Animal
  Hospital Southwest") was dropped because its cited `sourceUrl` didn't match any page the hook
  recorded as fetched — the exact scenario ADR-0004 exists to guard against, caught live.
- `sources.title` is always null (Phase 5) — `WebFetch`'s `tool_response` never includes a page
  title (see "Claude CLI hook findings" above), only its extracted-answer text. Getting a real
  title would need a separate fetch mechanism (e.g. `curl` via Bash); not pursued this phase.
