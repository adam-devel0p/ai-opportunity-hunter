# Architecture (current state)

This file describes what is **actually built**, as of the last completed phase. It is not
the plan (see [../PLAN.md](../PLAN.md) for that) — it's updated at the end of every phase to
reflect reality. If this file and the code disagree, the code wins; fix this file.

**Last updated:** Phase -1 (not yet started — repository scaffolding only).

## Status

Nothing has been implemented yet. This document, [../PLAN.md](../PLAN.md),
[PHASES.md](PHASES.md), [DECISIONS.md](DECISIONS.md), [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)
and [AGENT_CONTRACTS.md](AGENT_CONTRACTS.md) are the planning artifacts a fresh Claude Code
session should read before starting Phase 0.

## Target stack (see PLAN.md and DECISIONS.md for rationale)

- TypeScript, Node.js LTS
- Next.js (App Router) for the dashboard
- SQLite via `better-sqlite3` + Drizzle ORM + `drizzle-kit` migrations
- Claude invoked as a CLI subprocess (`claude -p ... --output-format json`), never the Agent
  SDK library, never `ANTHROPIC_API_KEY` — see [DECISIONS.md](DECISIONS.md) ADR-0001
- Vitest for tests
- Single app, no workspace monorepo — see ADR-0003

## Target folder layout

```
src/
  app/            Next.js dashboard routes (server components + server actions)
  agents/         Claude invocation wrapper, per-agent prompt builders, Zod contracts
    claudeClient.ts
    schemas/
    prompts/
  db/             Drizzle schema, migrations, client
  pipeline/       Work queue, state machine, priority selection, task handlers
  lib/            Deterministic domain logic: normalization, dedupe, scoring, config
  worker.ts       Autonomous scheduler entrypoint (separate long-running process)
scripts/          One-off/manual scripts (spikes, seed/test mode CLI, backup/export)
docs/
  phases/         One completion doc per finished phase
```

This will fill in with real module names/paths as phases land. Nothing below this line exists
yet.

## Model alias configuration

Not yet determined — Phase 0 must confirm current valid `claude -p --model` alias values and
record them here (they are configured, not hardcoded — see ADR-0006 — but the actual current
alias strings belong in this living doc, not in the plan or the ADR, since they drift).

## Known limitations

None yet (nothing built).
