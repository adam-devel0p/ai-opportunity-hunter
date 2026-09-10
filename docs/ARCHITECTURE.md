# Architecture (current state)

This file describes what is **actually built**, as of the last completed phase. It is not
the plan (see [../PLAN.md](../PLAN.md) for that) — it's updated at the end of every phase to
reflect reality. If this file and the code disagree, the code wins; fix this file.

**Last updated:** Phase 1 (Data layer & domain model) — complete. See
[phases/phase-1-data-layer.md](phases/phase-1-data-layer.md) for the full writeup.

## Status

Phases 0-1 are done. The repo has a working TypeScript toolchain, the Phase 0 Claude-invocation
client, and now a full SQLite schema (Drizzle) plus the deterministic domain logic (domain
normalization/dedupe, opportunity scoring) that doesn't need Claude at all. No work queue,
worker loop, dashboard, or real agents yet — see PLAN.md Phase 2 onward.

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
    schemas/
      deepResearchSpike.ts    Draft Zod + JSON Schema pair for the spike script only —
                               Phase 5 owns the real Deep Research Agent contract.
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
scripts/
  spike-research.ts            Phase 0 spike script (see below). Throwaway, not a
                                production agent — no persistence, no Source-row hook.
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
```

Nothing under `src/pipeline`, `src/app`, or `src/worker.ts` exists yet — those are Phase 2+
(see PLAN.md's target layout for what's still to come). No agent orchestration, work-queue
processing, or UI was added in Phase 1 — `work_items` exists as a table only; nothing reads or
writes it yet outside of the Phase 1 round-trip test.

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
  - an explicit `env` built by `buildSanitizedEnv()`, which clones `process.env` and deletes
    `ANTHROPIC_API_KEY` — never inherited, regardless of what the parent shell has set.
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

Not yet built (later phases' responsibility): the one-retry-with-validation-error-appended
loop, `work_items`/`prompt_versions` logging (the DB now exists as of Phase 1, but nothing
wires `claudeClient` to it yet — that's Phase 2/3's job), the ADR-0004 `PostToolUse` Source-row
hook (likely wired in whichever phase first does research with persistence — Phase 5).

## `src/db/` (Phase 1)

- `schema.ts` — all 13 tables from `docs/DATABASE_SCHEMA.md` as Drizzle `sqliteTable`
  definitions. IDs are `crypto.randomUUID()` (no extra cuid dependency). Enums use Drizzle's
  `text(col, { enum: [...] })` (TS-level literal union; no DB-level `CHECK`, see ADR-0008 part
  3). JSON-shaped columns (`criteria`, `impactAssumptions`, `dependencies`, `risks`,
  `penalties`, the four `verifier*` arrays, `keyAssumptions`, `system_config.value`) use
  Drizzle's `{ mode: "json" }` text columns with a `$type<T>()` annotation.
- `client.ts` — `createDb(path)` opens `better-sqlite3` with `journal_mode = WAL` and
  `foreign_keys = ON` (SQLite defaults foreign keys OFF per-connection; without this pragma the
  FK references in the schema would be silently unenforced), wraps it in `drizzle()`.
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

## Known limitations

- No retry-with-validation-error loop in `claudeClient` yet — the real
  `docs/AGENT_CONTRACTS.md` contract (one retry, error appended, then `FAILED`) needs the work
  queue (Phase 2) to exist so there's somewhere to record the `FAILED` status. The DB now exists
  (Phase 1) but nothing writes `work_items`/`prompt_versions` rows from `claudeClient` yet.
- No Source-row provenance hook (ADR-0004) yet — the `sources` table exists but nothing
  populates it outside of the Phase 1 round-trip test; that's Phase 5.
- `scripts/spike-research.ts` is intentionally throwaway: no persistence, no retry, draft
  schema only. Do not import it from real agent code in later phases — Phase 5 builds the real
  Deep Research Agent from scratch against the finalized contract.
- No work-queue processing, lifecycle transition functions, or crash recovery yet — `work_items`
  and every lifecycle-status enum exist as columns only; `src/pipeline/stateMachine.ts` (Phase 2)
  is what will actually enforce valid transitions and reset stuck `RUNNING` items.
- `updatedAt` columns are set at insert time only; nothing yet re-sets them on update, since no
  update code paths exist before Phase 2+. Any phase adding an update path must set it
  explicitly (see DATABASE_SCHEMA.md's "Conventions").
- Opportunity scoring (`src/lib/scoring.ts`) is correct and tested in isolation but not wired to
  any real `opportunity_evaluations` row yet — Phase 6 does that.
