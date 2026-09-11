# Phase 4 — Pre-Screening Agent

**Completed:** 2026-09-11

## What was built

- `src/agents/prescreenAgent.ts` — the Pre-Screening Agent (AGENT_CONTRACTS.md §2):
  `prescreenOutputSchema` (Zod, `classification: DISCARD|MAYBE|PROMISING` + `reasons: string[]`),
  a hand-mirrored JSON Schema for `--json-schema`, `buildPrescreenPrompt` (bakes in the
  `WebFetch`-only integrity rules — never invent unfetched page content, a failed fetch is
  itself valid `DISCARD` evidence, and the retry-error block), and `runPrescreenAgent` (fast
  model tier per ARCHITECTURE.md's existing model-alias notes, `WebFetch` only, 3-minute
  timeout).
- `src/pipeline/prescreenHandler.ts` — `runPrescreenTask`: the second live-DB-wired task
  handler. Loads the company a `PRESCREEN` work item targets (`entityId` is a company id for
  this task type, matching DATABASE_SCHEMA.md's default), short-circuits to `DISCARDED` without
  ever calling Claude if `company.nextEligibleResearchAt` is set and still in the future, else
  runs the Pre-Screening Agent and acts on its classification: `DISCARD` → company transitions
  to `DISCARDED` with reasons appended to `notes`, no work re-queued; `MAYBE`/`PROMISING` (routed
  identically) → company transitions `PRESCREENED -> RESEARCH_PENDING` and a `RESEARCH` work
  item is enqueued. Quota exhaustion and other failures are handled the same way as
  `discoverHandler.ts` (`DEFERRED` without burning a retry attempt, or routed through
  `failureClassification.resolveFailureOutcome`).
- `scripts/prescreen.ts` — manual smoke-test entry point: `npm run prescreen -- --company <id>`
  for one company, or `--all [--limit <n>]` for every `PENDING` `PRESCREEN` item.
- `docs/DECISIONS.md`: new **ADR-0011** (5 parts) recording this phase's judgment calls.
  `docs/ARCHITECTURE.md` and `docs/PHASES.md` updated to reflect the above.

## Deviations from PLAN.md

- AGENT_CONTRACTS.md §2's output enum has three values (`DISCARD|MAYBE|PROMISING`) but PLAN.md's
  Phase 4 build text only describes two outcomes. `MAYBE` is routed identically to `PROMISING`
  (both proceed to `RESEARCH`) — see ADR-0011 part 1.
- The Pre-Screening Agent is given `WebFetch` only, not `WebSearch`+`WebFetch` like Discovery —
  see ADR-0011 part 2.
- No dedicated schema column for pre-screen classification/reasons; appended to `companies.notes`
  as a new line, same convention as Phase 3's `reasonToScreen` (ADR-0010 part 7) — see ADR-0011
  part 4.

Full list of judgment calls and reasoning: see ADR-0011 in `docs/DECISIONS.md`.

## Testing performed

**Unit/fixture tests** — 2 new test files, both using a real temp SQLite DB via `runMigrations`
(same pattern as `discoverHandler.test.ts`) and a mocked `runPrescreenAgent`/`invokeClaude` (no
real CLI invoked in automated tests):

- `src/agents/prescreenAgent.test.ts` — prompt includes company details and discovery notes;
  falls back to "unknown"/"none" and omits the notes line when fields are missing; retry block
  appends the previous validation error; always includes the `WebFetch`-only integrity rules;
  schema accepts a well-formed output and rejects an invalid classification value;
  `runPrescreenAgent` calls `invokeClaude` with `WebFetch` only and the fast model tier by
  default, respects a model override.
- `src/pipeline/prescreenHandler.test.ts` (the Phase 4 acceptance-criterion fixture tests) —
  unknown company id throws; **a strong candidate classified `PROMISING` transitions the company
  to `RESEARCH_PENDING` and enqueues exactly one `RESEARCH` work item with the correct
  priority**; `MAYBE` is routed identically to `PROMISING`; **a dead/parked-site fixture
  classified `DISCARD` transitions the company to `DISCARDED`, records the reasons in `notes`,
  and creates no `RESEARCH` item**; **an already-researched-recently company (fixture with
  `nextEligibleResearchAt` in the future) is discarded via the deterministic freshness check
  with the mocked `runPrescreen` asserted never called** — confirms the Claude call is skipped
  entirely, not just cheap; `quota_exhausted` routes to `DEFERRED` without touching company
  lifecycle or incrementing `attempts`; a non-quota failure routes through
  `failureClassification` to `RETRYABLE` with backoff; an item that has exhausted its retry
  budget routes to `FAILED`.

Actual output:

```
npm run build   → tsc, no errors
npm run lint    → eslint ., no errors or warnings
npm test        → Test Files  16 passed (16); Tests  150 passed (150)
```

**Manual smoke test — live pre-screening against real companies:**

Confirmed `ANTHROPIC_API_KEY` unset in the shell (ran with `env -u ANTHROPIC_API_KEY`
defensively regardless, per established practice), then ran `npm run prescreen -- --all` against
the live `./data/aoh.db`, which still had all 8 real veterinary clinics from Phase 3's manual
smoke test sitting `PRESCREEN_PENDING` with a `PENDING` `PRESCREEN` work item each — no fresh
discovery run needed.

Result: **all 8 classified `PROMISING`**, each transitioned to `RESEARCH_PENDING` with exactly
one `RESEARCH` work item enqueued. Total reported cost across all 8 calls: ~$0.24.

**Verdict: strong.** Every classification's recorded reasons cite specific, verifiable details
distinct to that company — street addresses, phone numbers, named veterinarians, review counts/
ratings, posted hours, specific service lines, certifications (AAHA/Fear Free/Cat Friendly),
recent dated events (2026 awards, team photos, facility relocations) — not templated or
generic-sounding language. Notably, "The Stock Doc Veterinary Services" (rivertonvet.com), which
Phase 3's completion doc flagged as returning HTTP 403 to a bare `curl` (likely bot-blocking),
still loaded successfully for the agent's `WebFetch` call and produced specific, plausible detail
(4 named veterinarians, 2026-dated job postings, a functional client/payment portal) — consistent
with Phase 0's already-documented finding that bot-blocking affects some fetch methods
differently, not evidence of fabrication (no invented specifics, no generic filler). No reason
line was disconnected from an actual observation.

Given all 8 candidates came from a single well-targeted Phase 3 campaign ("independent US
veterinary clinics"), a 8-for-8 `PROMISING` rate is plausible and not itself a red flag — this
run didn't exercise a real `DISCARD` case live (only via fixture), so the `DISCARD` path's
real-world behavior (as opposed to fixture behavior) remains unverified against an actual dead
site. Flagged below as a follow-up.

**Billing safety:** `ANTHROPIC_API_KEY` confirmed unset in the shell before the run. Reported
`total_cost_usd` summed to ~$0.24 across 8 calls. Per ADR-0001, this field is not proof of which
pool was billed — **operator confirmation via claude.ai/console's usage page is still the
outstanding manual check**, the same open item Phases 0 and 3 already flagged and has not yet
been closed; this phase's runs are now also covered by that same outstanding check.

## New decisions

- **ADR-0011** (new, 5 parts): `MAYBE` treated identically to `PROMISING`; `WebFetch`-only
  tooling (no `WebSearch`) to keep pre-screening cheap; the `nextEligibleResearchAt` freshness
  short-circuit implemented now even though the current pipeline can't yet produce a `PRESCREEN`
  item where it fires (forward-looking, per PLAN.md's explicit acceptance criterion); reasons
  recorded in `companies.notes` (same convention as ADR-0010 part 7); the
  `PRESCREEN_PENDING -> PRESCREENED -> RESEARCH_PENDING` chain is validated through both
  transition functions but persisted in one DB write. See `docs/DECISIONS.md`.

## Known limitations / follow-ups

- The operator's claude.ai/console billing confirmation (originally a Phase 0 acceptance
  criterion) is still outstanding — now covering Phase 0's, Phase 3's, and Phase 4's real-CLI
  runs.
- The live smoke test never exercised a real `DISCARD` outcome (all 8 real companies were
  genuinely promising) — that path is currently verified only by fixture tests with a mocked
  dead-site response, not against a real unreachable/parked site. Worth a targeted manual check
  in a later phase if a clearly dead company ever surfaces from discovery.
- The `nextEligibleResearchAt` freshness short-circuit (ADR-0011 part 3) is implemented and
  fixture-tested but not reachable from the live pipeline yet — nothing currently creates a
  `PRESCREEN` item for an already-researched company. It will become exercisable once a later
  phase adds a path that does (e.g. Phase 12's §72 manual "research this company now" trigger).
- `companies.notes` now carries three potential kinds of content (operator notes, the seeded
  Discovery reason, and now a Prescreen classification+reasons line) — same open item as Phase
  3's ADR-0010 part 7 flagged, now one layer deeper. Revisit if the Phase 12 dashboard needs
  these distinguished as structured fields.
- No `system_config`/`prompt_versions` writes yet, same as Phase 3 — still deferred.

## Next phase

`docs/PHASES.md` now points to **Phase 5 — Deep Research Agent + evidence model** as current,
with Phase 4 marked done. Phase 5 should read `docs/AGENT_CONTRACTS.md` §3 and can exercise its
work directly against the real companies already sitting `RESEARCH_PENDING` with a `PENDING`
`RESEARCH` work item in the live `./data/aoh.db` (all 8 veterinary clinics from Phases 3-4) —
no fresh discovery/prescreen run needed. Per PLAN.md, Phase 5 is "the single most important
manual check in the whole plan": the operator must spot-check real FACT claims against actual
source pages before Phase 6 builds on top of this evidence. Phase 5 also owns wiring the
ADR-0004 `PostToolUse` Source-row provenance hook, which no phase has needed until now.
