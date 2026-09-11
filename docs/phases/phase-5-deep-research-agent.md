# Phase 5 — Deep Research Agent + evidence model

**Completed:** 2026-09-11

## What was built

- `src/agents/deepResearchAgent.ts` — the Deep Research Agent (AGENT_CONTRACTS.md §3):
  `deepResearchOutputSchema` (Zod: `evidence: {claim, classification, supportingExcerpt,
  sourceUrl, confidence}[]` + `candidateProblems: string[]`), a hand-mirrored JSON Schema,
  `buildDeepResearchPrompt` (bakes in spec §24's research integrity rules verbatim, plus
  additions: the tool-denial fabrication guard, the sourceUrl/provenance rule, spec §20's
  problem-not-AI framing, and spec §21's classification definitions with their exact spec
  examples), and `runDeepResearchAgent` (reasoning model tier, `WebSearch`+`WebFetch`, 8-minute
  timeout, registers the source-capture hook via `settings`/`extraEnv`).
- `src/agents/sourceCaptureHook.ts` — shared logic between the agent and the hook subprocess:
  `buildSourceCaptureHookSettings` (the `--settings` payload registering a `PostToolUse` hook on
  `WebFetch` only, exec form pointing at `node_modules/.bin/tsx` + the hook script),
  `buildSourceCaptureHookEnv` (env vars carrying DB path/company id/task id to the hook's
  separate OS process), and `extractWebFetchEvent` (parses a `PostToolUse` payload).
- `scripts/hooks/captureSourceHook.ts` — the ADR-0004 hook subprocess itself: a testable
  `runCaptureSourceHook` core (given a payload string + env + `Db`, inserts a `sources` row) and
  a thin `main()` reading real stdin/env and opening a real DB connection.
- `src/pipeline/researchHandler.ts` — `runResearchTask`: the third live-DB-wired task handler.
  Loads the company a `RESEARCH` work item targets, runs the Deep Research Agent, and persists
  only evidence items whose `sourceUrl` matches a `sources` row the hook recorded for that same
  task (tolerating a trailing-slash difference) — anything else is dropped, counted, and noted.
  On success: company transitions `RESEARCH_PENDING -> RESEARCHED` unconditionally,
  `lastResearchedAt`/`nextEligibleResearchAt` are set deterministically, candidate problems +
  an evidence-count summary are appended to `companies.notes`, and an `ANALYZE` work item is
  enqueued.
- `src/lib/sourceFreshness.ts` — `computeSourceFreshnessState` (spec §23): `UNAVAILABLE` for a
  missing/non-2xx HTTP status, else `FRESH`/`STALE` by a 30-day default threshold.
- `src/lib/researchFreshness.ts` — `computeNextEligibleResearchAt` (spec §60): adds a 90-day
  default window to `now`.
- `src/agents/claudeClient.ts` — new `settings` option (`--settings <json>`) and `extraEnv`
  option (merged into the sanitized child env, with `ANTHROPIC_API_KEY` stripped a second time
  defensively after merging).
- `src/db/client.ts` — added a `busy_timeout = 5000` pragma, since the hook is now a second
  writer process against the same SQLite file.
- `scripts/research.ts` — manual smoke-test entry point: `npm run research -- --company <id>`
  for one company, or `--all [--limit <n>]` for every `PENDING` `RESEARCH` item.
- `docs/DECISIONS.md`: new **ADR-0012** (7 parts) recording this phase's judgment calls.
  `docs/ARCHITECTURE.md` and `docs/PHASES.md` updated to reflect the above.

## Deviations from PLAN.md

- None from PLAN.md's stated Phase 5 scope. The one implementation detail not pinned down by
  the plan — how the ADR-0004 hook actually gets wired given `claude -p`'s non-interactive
  headless invocation model — required its own research pass (Claude Code's hooks reference)
  before implementation; see ADR-0012 part 1.

## Testing performed

**Unit/fixture tests** — 6 new test files (plus additions to `claudeClient.test.ts`), all using
mocked `invokeClaude`/`runDeepResearchAgent` or a real temp SQLite DB via `runMigrations` (same
conventions as Phases 3-4; no real CLI invoked in automated tests):

- `src/lib/sourceFreshness.test.ts` — UNAVAILABLE for missing/non-2xx status; FRESH/STALE
  threshold boundary; custom threshold override.
- `src/lib/researchFreshness.test.ts` — default and custom window addition.
- `src/agents/sourceCaptureHook.test.ts` — env mapping; hook settings shape (matcher `WebFetch`
  only, exec form command+args); `extractWebFetchEvent` against well-formed WebFetch payloads,
  a redirect case (prefers `tool_response.url`), a fallback case, a non-WebFetch (`WebSearch`)
  payload, malformed JSON, and a payload with no URL anywhere.
- `scripts/hooks/captureSourceHook.test.ts` — inserts a `sources` row for a successful WebFetch
  event; records `UNAVAILABLE` for a failed fetch; no-ops for a non-WebFetch event, missing env
  vars, or malformed stdin; records two independent rows for a simulated redirect (two
  `PostToolUse` events, two URLs).
- `src/agents/claudeClient.test.ts` (additions) — `--settings <json>` passed when provided and
  omitted otherwise; `extraEnv` merged into the child env with `ANTHROPIC_API_KEY` still
  stripped even if `extraEnv` itself set it.
- `src/agents/deepResearchAgent.test.ts` — prompt includes company details/prior notes and
  falls back correctly for missing fields; retry block; **verbatim spec §24 rules present**
  (each line individually asserted); tool-denial guard and sourceUrl-provenance rule present;
  problem-not-AI framing present; schema accepts well-formed output and rejects bad
  classification/non-URL sourceUrl/out-of-range confidence; `runDeepResearchAgent` calls
  `invokeClaude` with `WebSearch`+`WebFetch`, the reasoning tier, and the hook wired via
  `settings`/`extraEnv`; respects a model override.
- `src/pipeline/researchHandler.test.ts` (the Phase 5 acceptance-criterion fixture tests) —
  unknown company id throws; **a strong-candidate fixture with multiple FACTs from distinct
  sources**: all persisted with correct source links, company `RESEARCHED`, candidate problems
  in notes, `ANALYZE` enqueued, and **every persisted evidence item has a real linked source
  with a `retrievedAt` timestamp** (the structural-provenance acceptance criterion); **a bare
  brochure-site fixture** (UNKNOWN/HYPOTHESIS only): classifications persisted honestly, not
  upgraded; **an unverified-sourceUrl fixture**: the evidence item is dropped, not persisted,
  drop count surfaced in both the outcome and `companies.notes`, and the company still advances
  to `RESEARCHED` (thin evidence is a valid outcome, not a block); trailing-slash URL match
  tolerance; `quota_exhausted` → `DEFERRED` without touching lifecycle or attempts; non-quota
  failure → `RETRYABLE` with backoff; exhausted attempts → `FAILED`.

Actual output:

```
npm run build   → tsc, no errors
npm run lint    → eslint ., no errors or warnings
npm test        → Test Files  22 passed (22); Tests  194 passed (194)
```

**Manual smoke test — live deep research against real companies (the single most important
manual check in the whole plan, per PLAN.md):**

Confirmed `ANTHROPIC_API_KEY` unset in the shell (ran with `env -u ANTHROPIC_API_KEY`
defensively regardless), then ran `npm run research` against the live `./data/aoh.db` — first a
single company alone to validate the hook wiring end-to-end against the real CLI before
spending further quota, then `--all` for the remaining 7. All 8 real veterinary clinics from
Phases 3-4's smoke tests (still sitting `RESEARCH_PENDING` with a `PENDING` `RESEARCH` work
item) were researched — no fresh discovery/prescreen run needed.

Result: **all 8 succeeded**, transitioned to `RESEARCHED`, with an `ANALYZE` work item enqueued
for each. 157 evidence items recorded total across all 8 companies (range 17-22 per company).
Total reported cost: ~$2.46 (~$0.31/company average).

**Provenance mechanism validated live, not just in fixtures:** the ADR-0004 hook correctly
recorded every real `WebFetch` call as a `sources` row for all 8 companies (11-16 sources per
company, including redirected/failed fetches marked `UNAVAILABLE`), and the sourceUrl↔source
cross-check in `researchHandler.ts` fired for real once: "Animal Hospital Southwest" had 1 of 23
evidence items dropped because its cited `sourceUrl` didn't match any page the hook recorded as
actually fetched during that task — exactly the fabrication/mismatch scenario this whole
mechanism exists to catch, caught live on the very first multi-company run. The other 7
companies had zero drops (every cited source matched a real fetch).

**Fabrication spot-check (the acceptance criterion itself):** independently re-fetched 4 FACT
claims across 2 companies against the actual live pages (outside the pipeline, via a separate
tool call) and compared verbatim:
- Neabore Veterinary Clinic — `frequently-asked-questions/`: confirmed "please call ahead" /
  walk-ins not accepted, the insurance-reimbursement-not-direct-billing policy, and the exact
  three named after-hours emergency hospitals (NorthStar VETS, Red Bank Veterinary Hospital,
  BluePearl Pet Hospital) all matched the agent's claims and excerpts exactly.
- Neabore Veterinary Clinic — `about/our-team/`: the agent's claimed staff roster (3
  veterinarians, 5 technicians, 1 assistant, 2 receptionists, with names) matched the live page
  exactly.
- Dallas Veterinary Clinic — `contact/`: confirmed the exact stated hours (Mon-Fri 7:30am-5:30pm,
  Sat 9am-2pm select dates only, closed Sunday) matched.
- Dallas Veterinary Clinic — `after-hours-emergencies/`: confirmed the clinic refers after-hours
  callers to exactly the three named external providers (ASPCA Animal Poison Control, MEDVET,
  Arista Advanced Pet Care) claimed by the agent.

**Verdict: strong, no fabrication found.** Every spot-checked FACT traced to real page content
with no invented specifics, no overstatement of confidence, and no upgrading of what should have
been INFERENCE/HYPOTHESIS/UNKNOWN. UNKNOWN items were used liberally and honestly (e.g. "actual
call volume... is unknown," "unknown whether current job openings reflect turnover vs. growth")
rather than guessed at. Classification separation held up: HYPOTHESIS items were explicitly
framed as unconfirmed possibilities ("may be," "could," "potential"), not asserted as fact.
Candidate problems were grounded in cited evidence rather than generic "add AI" framing,
consistent with spec §20.

**Billing safety:** `ANTHROPIC_API_KEY` confirmed unset in the shell before both runs. Reported
`total_cost_usd` summed to ~$2.46 across all 8 companies (all 8 real Claude calls plus retries,
if any). Per ADR-0001, this field is not proof of which pool was billed — the operator's
claude.ai/console usage-page confirmation remains the same outstanding manual check flagged by
Phases 0, 3, and 4, now also covering this phase's runs.

## New decisions

- **ADR-0012** (new, 7 parts): hook delivery via `--settings` exec form, matched only on
  `WebFetch` (not `WebSearch`, which never fetches page content); hook context passed via env
  vars since it runs as a separate OS process; the sourceUrl↔source cross-check and its
  drop-not-block policy (validated live, see above); Deep Research uses the `"reasoning"` model
  tier; the company always transitions to `RESEARCHED` and `ANALYZE` is always enqueued
  regardless of evidence volume; candidate problems/evidence summaries recorded in
  `companies.notes` (same convention as prior phases); the two new freshness constants (30-day
  source staleness, 90-day re-research window) are reasoned placeholders, not tuned values. See
  `docs/DECISIONS.md`.

## Known limitations / follow-ups

- The operator's claude.ai/console billing confirmation is still outstanding — now covering
  Phases 0, 3, 4, and 5's real-CLI runs.
- `sources.title` is always null — `WebFetch`'s `tool_response` never includes a page title
  (confirmed against the hooks/tools reference and this phase's live payloads), only its
  extracted-answer text. A real title would need a separate fetch mechanism; not pursued.
- `sourceFreshness.ts`'s `STALE` branch is implemented and unit-tested but unreachable from the
  one live call site (a source is always `retrievedAt = now` at insert time) — same
  "implemented now, forward-looking" pattern as ADR-0011 part 3, for a later phase that
  recomputes freshness for an existing row on read (Phase 14).
- `companies.notes` now carries a fourth kind of content (the Phase 5 research summary +
  candidate-problems line, on top of Discovery/Prescreen's existing lines) — same open item
  flagged in ADR-0010 part 7 / ADR-0011 part 4, now one layer deeper. Revisit if the Phase 12
  dashboard needs these distinguished as structured fields.
- No `system_config`/`prompt_versions` writes yet, same as Phases 3-4 — still deferred.
- The evidence-provenance cross-check's trailing-slash tolerance (`urlsMatch`) is intentionally
  narrow — it doesn't normalize protocol, casing, or query-string differences. This wasn't
  exercised as a false-negative risk in the live run (the one real drop was a genuine mismatch,
  not a normalization near-miss), but worth revisiting if future runs show more drops than
  expected due to trivial URL formatting differences rather than real fabrication.

## Next phase

`docs/PHASES.md` now points to **Phase 6 — Opportunity Analysis Agent + scoring** as current,
with Phase 5 marked done. Phase 6 should read `docs/AGENT_CONTRACTS.md` §4 and can exercise its
work directly against the real companies already sitting `RESEARCHED` with a `PENDING` `ANALYZE`
work item in the live `./data/aoh.db` (all 8 veterinary clinics from Phases 3-5) — no fresh
discovery/prescreen/research run needed. Phase 6 reads `evidence_items`/`sources` rows this
phase produced (157 across the 8 companies) and wires `src/lib/scoring.ts` (built in Phase 1,
still unused) to real `opportunity_evaluations` rows for the first time.
