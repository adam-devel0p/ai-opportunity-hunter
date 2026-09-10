# Architecture (current state)

This file describes what is **actually built**, as of the last completed phase. It is not
the plan (see [../PLAN.md](../PLAN.md) for that) — it's updated at the end of every phase to
reflect reality. If this file and the code disagree, the code wins; fix this file.

**Last updated:** Phase 0 (Foundations & Claude-invocation spike) — complete. See
[phases/phase-0-foundations.md](phases/phase-0-foundations.md) for the full writeup.

## Status

Phase 0 is done. The repo has a working TypeScript toolchain and exactly one reusable module
(`src/agents/claudeClient.ts`) plus a throwaway spike script built on top of it. No database,
no work queue, no dashboard, no real agents yet — see PLAN.md Phase 1 onward.

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
- Next.js dashboard, `better-sqlite3` + Drizzle: **not yet added** — deferred to Phase 1 (DB)
  and Phase 12 (dashboard) respectively. Do not add these dependencies early.

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
scripts/
  spike-research.ts            Phase 0 spike script (see below). Throwaway, not a
                                production agent — no persistence, no Source-row hook.
docs/
  phases/
    phase-0-foundations.md     Phase 0 completion doc.
```

Nothing under `src/pipeline`, `src/app`, `src/db`, or `src/worker.ts` exists yet — those are
Phase 1+ (see PLAN.md's target layout for what's still to come).

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
loop, `work_items`/`prompt_versions` logging (needs the DB, Phase 1), the ADR-0004
`PostToolUse` Source-row hook (needs the DB; likely wired in whichever phase first does
research with persistence — Phase 5).

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

- No database yet — nothing here persists anything (Phase 1).
- No retry-with-validation-error loop in `claudeClient` yet — the real
  `docs/AGENT_CONTRACTS.md` contract (one retry, error appended, then `FAILED`) needs the work
  queue (Phase 2) to have somewhere to record the `FAILED` status.
- No Source-row provenance hook (ADR-0004) yet — needs the DB to write rows into.
- `scripts/spike-research.ts` is intentionally throwaway: no persistence, no retry, draft
  schema only. Do not import it from real agent code in later phases — Phase 5 builds the real
  Deep Research Agent from scratch against the finalized contract.
