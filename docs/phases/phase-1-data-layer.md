# Phase 1 — Data layer & domain model

**Completed:** 2026-09-10

## What was built

- `src/db/schema.ts` — Drizzle schema for all 13 tables from
  [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md): `discovery_campaigns`, `work_items`,
  `companies`, `opportunities`, `sources`, `evidence_items`, `opportunity_evaluations`,
  `offers`, `contacts`, `outreach_drafts`, `outreach_outcomes`, `system_config`,
  `prompt_versions`. IDs are `crypto.randomUUID()`; enums are Drizzle `text(col, { enum })`
  literal unions; JSON-shaped columns use `{ mode: "json" }` with `$type<T>()`.
- `src/db/client.ts` — `createDb(path)`: opens `better-sqlite3` with `journal_mode = WAL` and
  `foreign_keys = ON`, wraps it in `drizzle()`.
- `src/db/migrate.ts` + `scripts/db/migrate.ts` — `runMigrations(path)` applies the committed
  `drizzle/*.sql` migration via `drizzle-orm/better-sqlite3/migrator`; the CLI script wraps it
  for `npm run db:migrate` (`AOH_DB_PATH` env var, default `./data/aoh.db`).
- `drizzle.config.ts` + `drizzle/0000_messy_psynapse.sql` (+ `drizzle/meta/`) — generated via
  `npm run db:generate` (`drizzle-kit generate`), committed as real migration history.
- `src/lib/normalize.ts` — `normalizeDomain(website)`, spec §17 dedupe key: builds a `URL`
  (prepending `https://` if no scheme given), lowercases the host, strips a leading `www.`.
  Path/query/fragment/protocol are excluded by construction (they're not part of
  `URL.hostname`), so there's no separate stripping step.
- `src/lib/scoring.ts` — pure opportunity scoring per spec §30-31: `SCORE_COMPONENT_RANGES`
  (ten components summing to `MAX_RAW_SCORE = 100`), `calculateRawScore` (sums + validates
  each component is an in-range integer), `PENALTY_CATALOG` (ten named penalty reasons from
  §31 with point values chosen here — see ADR-0008), `buildPenalties`, `calculateAdjustedScore`
  (clamped to `[0, 100]`), and `scoreOpportunity` combining all three.
- New dependencies: `drizzle-orm` ^0.45, `better-sqlite3` ^13 (runtime); `drizzle-kit` ^0.31,
  `@types/better-sqlite3` ^7.6 (dev). New `package.json` scripts: `db:generate`, `db:migrate`.
- Docs updated: `DATABASE_SCHEMA.md` (enum values filled in for `companies.lifecycleStatus`,
  `opportunities.status`, `opportunities.rejectionReason`; conventions section updated to match
  what's actually implemented; a new "Splitting spec §90 across tables" note), `ARCHITECTURE.md`
  (new `src/db/` and `src/lib/` sections, updated folder layout and known limitations),
  `DECISIONS.md` (new ADR-0008).

## Deviations from PLAN.md

- PLAN.md's Phase 1 objective describes the scoring calculator only; it doesn't mention the
  penalty catalog needing concrete point values, but DATABASE_SCHEMA.md's
  `opportunity_evaluations.penalties` column requires them to exist as real numbers for the
  round-trip test and for `calculateAdjustedScore` to be meaningfully testable. Assigned ten
  point values (5/10/15/20, scaled by severity) and recorded the reasoning as ADR-0008, per
  spec §31's explicit "may be determined in implementation planning."
- DATABASE_SCHEMA.md left `companies.lifecycleStatus`, `opportunities.status`, and
  `opportunities.rejectionReason` as "spec §90 state list" / "spec §46 list" without spelling
  out exact enum values. Spec §90's single state chain doesn't map cleanly onto the schema's
  three-table split (company vs. opportunity vs. outreach-outcome-event), and §90 itself says
  "exact implementation statuses may differ" — so the chain was split at entity-ownership
  boundaries rather than force-fit into one enum. Full reasoning in ADR-0008 part 2 and
  DATABASE_SCHEMA.md's "Splitting spec §90 across tables" note. `rejectionReason`'s values are
  spec §46's list verbatim, uppercased/underscored.
- Enum columns use Drizzle's `text(col, { enum: [...] })` (TS-level literal unions) without
  additional SQL `CHECK` constraints, even though DATABASE_SCHEMA.md's original conventions
  line said "TS string-literal unions + a CHECK constraint **or** Drizzle enum." Read the "or"
  as permission to pick one; picked the TS-only approach since this is a single-writer local
  app where Drizzle's typed API is the only thing that ever writes to the DB — see ADR-0008
  part 3 for the full reasoning and the condition under which this should be revisited.

## Testing performed

**Unit tests:**
- `src/lib/normalize.test.ts` (3 tests): the exact three-URL-variant example from spec §17
  (`https://www.example.com`, `http://example.com/`, `https://example.com/about?ref=x`) plus
  bare-domain and mixed-case variants all collapse to `"example.com"`; distinct hosts (including
  a subdomain and a different TLD) stay distinct; a fragment is stripped.
- `src/lib/scoring.test.ts` (12 tests): component ranges match §30 exactly and sum to 100;
  `calculateRawScore` sums correctly and rejects out-of-range/non-integer components;
  `buildPenalties`/`calculateAdjustedScore` apply catalog amounts correctly, clamp at both 0 and
  100, and every catalog entry is a positive point value; `scoreOpportunity` end-to-end
  including a realistic mixed-component/one-penalty example.
- `src/db/schema.test.ts` (6 tests, using a real `runMigrations` against a fresh temp-dir SQLite
  file per test, not a mock): migrations apply cleanly and every table is queryable immediately
  after; insert/read round trip for `discovery_campaigns` and `system_config`/`prompt_versions`
  individually; a duplicate `normalizedDomain` insert throws (dedupe enforced at the DB level);
  a full downstream chain — company → work_item → opportunity → source → evidence_item →
  opportunity_evaluation → offer → contact → outreach_draft → outreach_outcome — inserted and
  read back in one test, confirming every FK and JSON column round-trips correctly.
- `src/agents/claudeClient.test.ts` and `src/config/models.test.ts` (25 tests, unchanged from
  Phase 0) still pass — Phase 1 touched neither module.

**Manual verification:**
- `npm run db:generate` against `src/db/schema.ts` produced one clean migration (13 tables, all
  expected indexes/FKs reported, no warnings).
- `AOH_DB_PATH=/tmp/aoh-migrate-check/aoh.db npm run db:migrate` against a brand-new path
  created the file and applied the migration successfully (confirms the CLI script, not just
  the test harness's programmatic path, works end-to-end).
- Confirmed `better-sqlite3` loads correctly (`require("better-sqlite3")` succeeds) despite its
  `node-gyp rebuild` install script being skipped by this environment's script-allowlisting —
  it ships prebuilt binaries for `darwin-arm64` etc. under `prebuilds/` and uses those instead.

**Actual command output:**
```
npm run build   → tsc, no errors
npm run lint    → eslint ., no errors or warnings
npm test        → Test Files  5 passed (5); Tests  46 passed (46)
```

## New decisions

- **ADR-0008** (new): penalty catalog point values (with per-reason rationale), the rationale
  for splitting spec §90's single state chain across `companies.lifecycleStatus` /
  `opportunities.status` / `outreach_outcomes.event`, and the decision to use TS-level enum
  typing without DB-level `CHECK` constraints. See `docs/DECISIONS.md`.

## Known limitations / follow-ups

- `work_items` exists as a table with no queue-processing logic on top of it yet — that's
  Phase 2's `src/pipeline/stateMachine.ts` and priority-selection function.
- No lifecycle transition functions exist yet; nothing currently prevents an invalid
  `lifecycleStatus`/`status` transition from being written directly. Phase 2 is explicitly
  scoped to build that as an explicit, throws-on-invalid-transition function per company/
  opportunity enum.
- `updatedAt` is set at insert time only (via `$defaultFn`); no code path re-sets it on update
  yet, since Phase 1 builds no update logic. Whichever phase first updates a row (likely Phase
  2's state machine) needs to set it explicitly.
- Penalty point values (ADR-0008) are a reasoned starting point, not tuned against real data —
  flag in Phase 6/7's completion docs if real opportunities suggest they need adjustment.
- `src/lib/scoring.ts` is correct and tested in isolation but not called from anywhere that
  persists an `opportunity_evaluations` row yet — that wiring is explicitly Phase 6's job, not
  Phase 1's (per PLAN.md's Phase 1 scope: "as a pure function, not wired to real opportunities
  yet").

## Next phase

`docs/PHASES.md` now points to **Phase 2 — Work queue & state machine** as current, with Phase
1 marked done. Phase 2 should build `src/pipeline/stateMachine.ts` (explicit transition
functions for all three status enums introduced in this phase — see ADR-0008 for exactly which
enum lives where), priority-ordered work-item selection, retry/backoff classification, and
crash recovery — all still fully deterministic, no Claude calls, per PLAN.md's Phase 2 scope.
