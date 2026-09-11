# Phase 8 — Offer Builder + pricing

**Completed:** 2026-09-11

## What was built

- `src/lib/pricing.ts` — deterministic pricing-band logic (spec §35): `DEFAULT_PRICE_BANDS` (the
  four spec-named bands, each with a price range and a non-overlapping duration-day cutoff) and
  `DEFAULT_RECURRING_SUPPORT_RANGE` (the "Optional Ongoing Support" band); `resolvePriceBand`
  (duration-first, price as a fallback when duration is unknown); `evaluateOfferPricing` (full
  pipeline: resolves the band, checks whether the proposed price and optional recurring price
  actually fall within their ranges); `formatPricingBandGuide` (renders whatever band config is
  actually in effect into prompt text, never hardcoded prose). Pure functions, no DB, no Claude
  call — same shape as `src/lib/opportunityGate.ts`.
- `src/lib/offerLint.ts` — deterministic vague-offer detection (spec §34): `lintOfferScope`
  combines an exact-phrase blocklist (spec §34's own "AI automation services." bad example plus
  close variants naming a technology/category instead of a deliverable) with a
  `MIN_SCOPE_WORD_COUNT` (8) floor, since a model could otherwise dodge a fixed phrase list with
  an equally vague one-liner. Only `src/pipeline/offerHandler.ts` calls this.
- `src/agents/offerBuilderAgent.ts` — the Offer Builder Agent (AGENT_CONTRACTS.md §6):
  `offerBuilderOutputSchema` (Zod — `scope`, `expectedOutcome`, `keyAssumptions`,
  `durationEstimate`, `price`, `recurringPrice` (nullable, must be positive not zero),
  `exclusions`, `validationNeeded`, `demoConcept`, `whyCommerciallyAttractive`, and a new
  `priceJustification` field not in the original illustrative contract), a hand-mirrored JSON
  Schema, `buildOfferBuilderPrompt` (embeds spec §34's bad/good scope examples and spec §36's
  never-claim-a-demo-exists rule verbatim, takes a formatted pricing-band guide, and supports a
  `regeneration` block distinct from the schema-validation `retry` block), and
  `runOfferBuilderAgent` (reasoning model tier, no tools — same reasoning as Opportunity Analysis/
  Skeptical Verification: nothing left to fetch or search).
- `src/pipeline/offerHandler.ts` — `runBuildOfferTask`: the sixth live-DB-wired task handler.
  Loads the opportunity a `BUILD_OFFER` item targets (`entityId` is an opportunity id, same
  convention as `VERIFY`, set by `verifyHandler.ts` which only ever enqueues this task type on a
  gate pass), its `opportunity_evaluations` row, and the owning company; runs the Offer Builder
  Agent; runs the vague-offer lint (a match triggers exactly one regeneration, a second match
  fails the task without persisting anything); runs the pricing-band evaluation (never blocks,
  always records a justification when the price falls outside its band — the agent's own, or a
  deterministic fallback note if the agent didn't supply one); persists one `offers` row (price
  converted to cents, same convention as `opportunities.suggestedPriceMin`/`Max`); collapses the
  opportunity `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH` in one write; appends a summary line
  to `companies.notes`; and enqueues a `FIND_CONTACT` work item for Phase 9. Quota
  exhaustion/other failures handled the same way as every earlier handler.
- `scripts/offer.ts` — manual smoke-test entry point: `npm run offer -- --opportunity <id>` for
  one opportunity, or `--all [--limit <n>]` for every `PENDING` `BUILD_OFFER` item. Not run live
  this phase — see "Testing performed" below.
- `docs/AGENT_CONTRACTS.md` §6 updated to the real, final input/output shape and the
  post-generation checks. `docs/ARCHITECTURE.md` and `docs/PHASES.md` updated to reflect the
  above.
- `docs/DECISIONS.md`: new **ADR-0015** (5 parts) recording this phase's judgment calls.
- `package.json`: new `"offer": "tsx scripts/offer.ts"` script, same convention as `verify`.

## Deviations from PLAN.md

None from PLAN.md's stated Phase 8 scope. One thing PLAN.md left implicit and this phase had to
resolve: the `offers` table (built Phase 1) has no column for a price-band-deviation
justification, and no general `system_config` accessor layer exists for configurable pricing
bands (PLAN.md's Phase 8 text says "configurable pricing bands (§35) in `system_config`"). Both
followed the same precedent every prior phase already established (ADR-0010 part 7/8, ADR-0011
part 4, ADR-0012 part 6/7, ADR-0014 part 5): pricing bands are a code-constant config taken as an
optional function parameter (not a new `system_config`-backed settings layer built for one
phase's numbers), and the justification is folded into the existing `companies.notes` audit-trail
line rather than a new migration for one phase's free text. See ADR-0015 parts 1-2.

## Testing performed

**Unit/fixture tests** — 4 new test files, using mocked `invokeClaude`/`runOfferBuilderAgent` or a
real temp SQLite DB via `runMigrations` (same conventions as Phases 3-7; no real CLI invoked in
automated tests):

- `src/lib/pricing.test.ts` — band resolution for each of the four duration ranges plus the
  above-largest-band clamp; falls back to resolving by price when duration is null; respects a
  custom bands config; `evaluateOfferPricing` reports `priceInBand` true/false correctly
  (including the PLAN.md acceptance-criterion scenario: duration says one band, price matches a
  different one); recurring-price range evaluated independently, including a custom range;
  `formatPricingBandGuide` mentions every band name and the recurring range.
- `src/lib/offerLint.test.ts` (the Phase 8 acceptance-criterion vague-offer tests) — catches spec
  §34's exact bad example ("AI automation services.") and close variants, case-insensitively;
  catches an unlisted but too-short scope via the word-count floor; passes spec §34's exact good
  example verbatim; does not flag a longer, genuinely specific scope that merely mentions a
  blocklisted phrase in passing.
- `src/agents/offerBuilderAgent.test.ts` — prompt includes the opportunity content and the
  pricing-band guide; embeds spec §34's bad/good examples and spec §36's demo rule verbatim;
  includes a regeneration block distinct from the schema-validation retry block; schema accepts a
  well-formed output, rejects a zero `recurringPrice` (must be null, not zero), accepts a positive
  one; `runOfferBuilderAgent` calls `invokeClaude` with no tools and the reasoning tier.
- `src/pipeline/offerHandler.test.ts` (the Phase 8 acceptance-criterion fixture tests) — unknown
  opportunity id throws; a valid offer is persisted, the opportunity transitions to
  `CONTACT_RESEARCH`, and exactly one `FIND_CONTACT` item is enqueued at the right priority;
  **a vague first offer is caught by the lint and triggers regeneration** (mocked second call
  returns a valid offer — the PLAN.md acceptance criterion, verified via
  `toHaveBeenCalledTimes(2)` and inspecting the second call's `regenerationReason`); an offer still
  vague after one regeneration fails the task without persisting an `offers` row and without
  moving the opportunity off `VERIFIED`; an out-of-band price records the agent's own
  `priceJustification` in `companies.notes`; an out-of-band price with no agent-supplied
  justification gets a deterministic fallback note instead; `quota_exhausted` → `DEFERRED` without
  mutating the opportunity or touching attempts; non-quota failure → `RETRYABLE` with backoff;
  exhausted attempts → `FAILED`.

Actual output:

```
npm run build     → tsc, no errors
npm run lint      → eslint ., no errors or warnings
npm test          → Test Files  32 passed (32); Tests  291 passed (291)
```

**No live manual smoke test this phase.** PLAN.md's Phase 8 acceptance criteria list only
fixture/unit tests (unlike Phases 0/3/5's explicit real-company requirement). Phase 7's completion
doc already recorded that all 8 real veterinary-clinic opportunities carried through from Phases
3-7 ended up `VERIFIER_REJECTED` — none passed the gate — so there is no live `VERIFIED`
opportunity with a real `PENDING` `BUILD_OFFER` item to run `scripts/offer.ts` against without
first re-running fresh discovery/prescreen/research/analyze/verify for a new company, which is out
of this phase's own scope. `scripts/offer.ts` exists and is ready for the next real `VERIFIED`
opportunity. See ADR-0015 part 5.

## New decisions

- **ADR-0015** (new, 5 parts): pricing bands as a code-constant config (non-overlapping duration
  cutoffs resolving spec §35's overlapping prose ranges); the `priceJustification` contract
  addition and its record-don't-block behavior (agent-supplied or deterministic fallback); the
  vague-offer lint's blocklist + word-count design and its one-regeneration-then-fail behavior;
  the single-write `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH` collapse + `FIND_CONTACT`
  enqueue; the deferred live smoke test. See `docs/DECISIONS.md`.

## Known limitations / follow-ups

- `DEFAULT_PRICE_BANDS`' duration cutoffs and `MIN_SCOPE_WORD_COUNT` are reasoned starting points,
  not empirically tuned — no live offer has been generated yet to validate them against.
- `scripts/offer.ts` has not been exercised against the real `claude` CLI. The next session that
  gets a fresh company through the whole pipeline to a real `VERIFIED` opportunity should run
  `npm run offer -- --opportunity <id>` at least once and spot-check the result (is the offer
  genuinely specific to the company, is the price sane, is the demo concept honestly framed as a
  concept) before trusting this phase's prompt design the way Phase 5's live evidence-quality
  check validated Deep Research.
- The operator's claude.ai/console billing confirmation remains outstanding for any future live
  run of this phase's agent (no cost was incurred this phase since nothing ran live).
- `companies.notes` now carries a seventh kind of free-text content (Phase 8's `"Offer: ..."`
  line) — same open item flagged since ADR-0010 part 7; still no dedicated structured columns for
  any pipeline stage's audit-trail summary.
- No `system_config`/`prompt_versions` writes yet, same as every prior phase — still deferred to
  a later general config-accessor pass.

## Next phase

`docs/PHASES.md` now points to **Phase 9 — Contact Research Agent** as current, with Phase 8
marked done. Phase 9 should read `docs/AGENT_CONTRACTS.md` §7 and PLAN.md's Phase 9 section, and
picks up `FIND_CONTACT` work items this phase enqueues (`entityId` is an opportunity id, same
convention as `VERIFY`/`BUILD_OFFER`). As with Phase 8, there is currently no live opportunity
sitting at `CONTACT_RESEARCH` with a real `PENDING` `FIND_CONTACT` item — Phase 9 will likely also
rely on fixture tests unless a fresh company is run through the full pipeline first.
