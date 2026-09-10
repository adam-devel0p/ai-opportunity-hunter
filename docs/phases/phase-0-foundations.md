# Phase 0 — Foundations & Claude-invocation spike

**Completed:** 2026-09-10

## What was built

- Repo scaffolding: `package.json` (ESM, Node >=20), `tsconfig.json` (strict,
  `noUncheckedIndexedAccess`, NodeNext), `eslint.config.js` (flat config, ESLint 10 +
  typescript-eslint 8.70), `vitest.config.ts`, `.gitignore` (excludes `node_modules/`, `.env*`,
  `*.db*`, `dist/`, etc.).
- `src/agents/claudeClient.ts` — the sole module that spawns the `claude` CLI. Exports
  `invokeClaude`, `buildSanitizedEnv`, `warnIfApiKeyPresent`, `detectQuotaExhaustion`. See
  `docs/ARCHITECTURE.md` for the full interface description.
- `src/config/models.ts` — `resolveModelAlias("fast" | "reasoning", env?)`, env-overridable
  tier→alias map (ADR-0006).
- `src/agents/schemas/deepResearchSpike.ts` — draft Zod schema + hand-mirrored JSON Schema for
  the spike's evidence-graded research output (not the final Phase 5 contract).
- `scripts/spike-research.ts` — takes a company URL, builds a research prompt baking in the
  spec §24 research-integrity rules verbatim, calls `invokeClaude` with `tools:
  ["WebSearch", "WebFetch"]` and a `jsonSchema`, validates the result against the Zod schema,
  prints it.
- `docs/ARCHITECTURE.md` rewritten to reflect the above as built (folder layout, confirmed
  model aliases, and a "Claude CLI invocation findings" section).
- `docs/DECISIONS.md`: ADR-0001 updated with a Phase 0 re-verification entry; new **ADR-0007**
  documenting the `--tools` + `--allowedTools` + `--permission-prompts none` finding.

## Deviations from PLAN.md

- PLAN.md §9 and AGENT_CONTRACTS.md's intro assumed `--allowedTools` alone was the tool-
  restriction mechanism. Empirical testing during this phase found that's incomplete —
  `--tools` is what actually defines the available tool set, and both flags are needed
  together (plus `--permission-prompts none`). `claudeClient.invokeClaude` implements the
  corrected mechanism; see ADR-0007 for the full finding, including a real observed failure
  mode (denied tool calls causing the model to answer from training-data recall instead of
  reporting the tool as unavailable).
- Added a `jsonSchema` option to `ClaudeInvocationOptions` (maps to `--json-schema`), not
  explicitly called for in PLAN.md's Phase 0 build list, because it was cheap to add once
  discovered and materially improves output reliability (constrains `result` to schema-shaped
  JSON with no markdown fences, even for tool-using calls). Documented as a first line of
  defense only — Zod validation remains the source of truth.
- Package versions were picked at current-as-of-September-2026 majors rather than the
  originally-drafted ones, with one deliberate exception: `typescript` is pinned to the 5.x
  line (`^5.9.3`), not the newer 6.x/7.x line, because `typescript-eslint` 8.70's peer range is
  `typescript: '>=4.8.4 <6.1.0'` — bumping past that broke the lint toolchain. `zod` stayed on
  the `^3.25` line (not v4) since AGENT_CONTRACTS.md's draft schemas already assume v3's API
  (`.url()`, `error.format()`); revisit only if a later phase has a concrete reason to move.
- Ran `npm audit fix`-equivalent proactively (bumped `vitest` 2→5, `eslint` 9→10) after the
  initial `npm install` reported 5 vulnerabilities (3 moderate, 1 high, 1 critical) in the
  vitest/vite/esbuild dev-tooling chain; final `npm install` reports 0 vulnerabilities.

## Testing performed

**Unit tests** — `src/agents/claudeClient.test.ts` (18 tests) and `src/config/models.test.ts`
(4 tests), 22 total plus 3 more from Zod schema exercise inside the client tests (25 total
reported by Vitest):

- `buildSanitizedEnv`: strips `ANTHROPIC_API_KEY` even when present in the input env, doesn't
  mutate its input, is a no-op when the key is already absent.
- `warnIfApiKeyPresent`: logs when the key is present, silent when absent.
- `detectQuotaExhaustion`: true for each fixture stderr/stdout sample (session limit, weekly
  limit, `rate_limit_error`, bare `429`, "usage limit reached"), false for ordinary errors and
  empty output, and confirmed it checks stdout as well as stderr.
- `invokeClaude` (spawn mocked via `vi.mock("node:child_process")`, no real CLI invoked):
  confirms `ANTHROPIC_API_KEY` never reaches the spawned child's `env` even when stubbed into
  `process.env`; confirms the exact `--tools`/`--allowedTools`/`--permission-prompts` argument
  shape; and covers all four result statuses (`success`, `invalid_json`, `quota_exhausted`,
  `error` — both non-zero-exit and `is_error: true` variants) plus a spawn-failure case.

Actual output:

```
npm run build   → tsc, no errors
npm run lint    → eslint ., no errors or warnings
npm test        → Test Files  2 passed (2); Tests  25 passed (25)
```

**Manual verification — `scripts/spike-research.ts` against 3 real companies** (chosen by
searching live for real, distinct small businesses across different industries, since the
operator asked me to pick rather than naming their own):

1. **The Law Office of Sally G. Kelsey** (`https://www.strole-kelseylaw.com/`) — solo personal
   injury/criminal defense/workers'-comp practice, Lawrence, KS.
   - Verdict: **strong.** 9 evidence items, 4 FACT (grounded in third-party directory pages —
     LawInfo, FindLaw — since the firm's own site returned HTTP 403 to direct fetch), 1
     INFERENCE, 1 HYPOTHESIS, 3 UNKNOWN. Correctly recorded the firm's own-site fetch failure
     as UNKNOWN rather than fabricating anything about it or claiming the firm lacks a system
     because it couldn't be observed (exactly the §24 rule this was testing). No invented
     specifics detected.
2. **NICHE Employment Solutions** (`https://nichejob.co.uk/`) — boutique UK recruitment agency,
   Northwich, Cheshire.
   - Verdict: **strong.** 9 evidence items, cross-referenced UK Companies House data (real
     incorporation date, SIC code, accounts date) for FACT items. Notably caught and correctly
     flagged a name-collision risk — a similarly-named but distinct Wiltshire company with 217
     Trustpilot reviews — as its own INFERENCE rather than conflating the two companies' data,
     which would have been a serious and easy-to-miss error. UNKNOWNs correctly used for
     headcount/revenue/reviews.
3. **Independent HVAC Solutions** (`https://www.independent-hvac.com/`) — locally owned HVAC
   contractor, Van Alstyne, TX.
   - Verdict: **strong.** 9 evidence items, verified Lennox Premier Dealer status (with its
     stated 4-star-rating requirement) against Lennox's own dealer-locator page as a second
     independent source. Appropriately hedged HYPOTHESIS items (e.g. "may rely on a single
     intake channel... could be more prone to bottlenecks") rather than asserting them as fact.
     Yelp fetch also 403'd and was correctly recorded as UNKNOWN.

All three runs produced schema-valid JSON (validated against `deepResearchSpikeSchema`) with
at least one FACT and at least one UNKNOWN, and no fabricated-sounding specifics were found on
review of any of the three outputs. One incidental finding worth flagging for Phase 5: two of
three companies' own websites returned HTTP 403 to direct `WebFetch` (likely bot/WAF
protection), and in both cases Claude correctly fell back to researching via third-party
sources rather than fabricating or silently giving up — but Phase 5's prompt should probably
explicitly address the "target site blocks fetches" case since it came up in 2/3 real runs, not
as an edge case.

**Billing safety:** `ANTHROPIC_API_KEY` was confirmed unset in the shell used for all runs
above (`env -u ANTHROPIC_API_KEY` was used defensively regardless). `buildSanitizedEnv` is unit
tested to strip it even if present. **Manual confirmation via claude.ai/console's usage page
that these specific runs billed to subscription usage rather than API credits is still pending
operator action** — the CLI's own JSON output includes a `total_cost_usd` field on every
response (e.g. $0.26, $0.31, $0.23 for the three spike runs above), but this field is present
regardless of billing source and is not proof either way (see ADR-0001's updated verification
history and `docs/ARCHITECTURE.md`'s "Claude CLI invocation findings"). Operator should check
the usage page and this doc should be updated with the outcome before treating this criterion
as fully closed.

## New decisions

- **ADR-0007** (new): tool restriction requires both `--tools` and `--allowedTools` together,
  plus `--permission-prompts none`; `--allowedTools` alone does not restrict the tool set, and
  `--tools` alone causes silent-fabrication-on-denial. See `docs/DECISIONS.md`.
- **ADR-0001** (updated, not superseded): added a Phase 0 re-verification entry confirming the
  Agent-SDK-credit-pool split is still paused as of September 2026, and a note that
  `total_cost_usd` in CLI output is not a valid billing-source proxy.

## Known limitations / follow-ups

- Billing-safety manual confirmation (operator checking claude.ai/console) is outstanding —
  see "Testing performed" above. Someone should update this doc once checked.
- `claudeClient` does not yet implement the one-retry-with-validation-error-appended loop from
  AGENT_CONTRACTS.md, or any `work_items`/`prompt_versions` logging — both need the DB (Phase
  1) and queue (Phase 2) to exist first.
- The ADR-0004 `PostToolUse` Source-row provenance hook is not built. `scripts/spike-research.ts`
  has no independent record of what was actually fetched beyond what the model self-reports in
  `sourceUrl` — acceptable for a throwaway spike, not acceptable once Phase 5 builds the real
  Deep Research Agent.
- Two of three spike companies' own sites 403'd direct `WebFetch` — worth designing Phase 5's
  prompt with this case in mind from the start rather than treating it as rare.
- Package versions (TypeScript 5.9 pinned below typescript-eslint's supported ceiling, zod v3
  not v4) are deliberate current-state choices, not oversights — see "Deviations" above if a
  later phase considers bumping either.

## Next phase

`docs/PHASES.md` now points to **Phase 1 — Data layer & domain model** as current, with Phase 0
marked done. Phase 1 should read `docs/DATABASE_SCHEMA.md` and build the Drizzle schema +
migrations + the normalization/dedupe and scoring pure functions — no agent orchestration, no
queue processing, no UI (per PLAN.md's Phase 1 scope). Nothing about the Phase 1 plan changed
because of what Phase 0 found; the only carry-forward is the two "Known limitations" items above
that Phase 5 (not Phase 1) needs to keep in mind.
