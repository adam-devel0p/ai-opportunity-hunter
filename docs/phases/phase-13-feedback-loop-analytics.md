# Phase 13 — Feedback loop & outcome analytics

**Completed:** 2026-09-11

## What was built

- `src/lib/outcomeAnalytics.ts` — the new read-side analytics module (spec §47, §74):
  - `computeRateStat(numerator, denominator, minSampleSize)` / `computeAverageStat(values,
    minSampleSize)` — the two small generic primitives every metric below is built from, each
    returning its sample size and a `reliable` flag alongside the number itself.
  - `DEFAULT_MIN_SAMPLE_SIZE = 5` — the small-sample-size guard threshold (spec §74's "avoid
    misleading metrics when sample sizes are tiny").
  - `getOverallOutcomeMetrics(db)` — sent count, reply/positive-reply/meeting/win rates, average
    opportunity score across every scored opportunity, and score-vs-response (average score split
    by replied vs. not-replied).
  - `getPerformanceByDimension(db, dimension)` — the same five stats grouped by `industry`,
    `country`, `problemCategory`, `campaign`, or `priceBand`, sorted most-sent-first. Missing
    values fall back to a stable `"Unknown"` (or `"Manual / no campaign"` for campaign) label
    rather than being dropped.
  - Both build on a shared internal `getSentOutreachRecords(db)` — every outreach draft with a
    `SENT` outreach_outcomes event, joined against its opportunity/company/evaluation/offer/
    campaign. A draft that was only generated/reviewed but never sent contributes to nothing.
- `src/lib/outcomeAnalytics.test.ts` — 13 unit tests covering both stat primitives (including the
  small-sample-size guard behavior explicitly) and both query functions (rate correctness,
  un-sent drafts excluded, score-vs-response split, per-dimension grouping including the
  missing-value fallback and campaign attribution, sort order).
- `src/app/analytics/page.tsx` — a new dashboard route: overall metric tiles (sent count, four
  rates, average score), a score-vs-response comparison, and five stacked "performance by X"
  tables (one per dimension), each rate cell showing a "low sample" badge when `reliable` is
  false. Added to the nav bar (`src/app/layout.tsx`).
- `src/app/format.ts` gained `formatPercent`/`formatScore` display helpers, same pattern as the
  existing `formatCents`/`formatDate`/`formatDateTime`.

No schema changes and no new agent — Phase 12 already built the full outcome-recording write path
(`dashboardActions.recordOutreachOutcome`/`markSentManually`) and the `outreach_outcomes` table;
this phase is entirely new read-side aggregation over what's already persisted.

## Deviations from PLAN.md

None. PLAN.md's Phase 13 "Build" list says outcome recording is "wired to dashboard actions from
Phase 12" (confirmed already true, not re-done), plus "aggregate-by-dimension queries... small-
sample-size guarding" — both built as described. Surfacing the aggregates on a dashboard page
wasn't explicitly required by the acceptance criteria (which only ask for unit tests), but spec
§74 frames these as things to "show", and PLAN.md's own Phase 12 entry established the pattern of
building the dashboard page alongside the `src/lib` query module in the same phase — so `/analytics`
was built to keep the feature usable rather than leaving the module dashboard-invisible until some
unspecified later phase.

## Testing performed

- New: `src/lib/outcomeAnalytics.test.ts` — 13 tests, all passing.
- `npm run build` — passes (`build:worker` + `build:dashboard`, `/analytics` listed as a new
  dynamic route).
- `npm run lint` — clean.
- `npm test` — 44 test files, 407 tests, all passing.
- Manual UI verification: seeded a temporary fixture DB (4 companies across 3 industries, 2
  countries, 3 problem categories, 2 price bands, one via a named campaign, with a mix of
  REPLIED/INTERESTED/MEETING/WON/NO_REPLY outcome events) via a throwaway script, ran `next dev`
  against it, and fetched `/analytics` — confirmed the overall tiles, score-vs-response split, and
  all five per-dimension tables render the expected numbers (e.g. 2/4 sent replied → 50% reply
  rate; every cell in this tiny fixture correctly shows the "low sample" badge). Scratch script and
  fixture DB deleted afterward — not committed.

## New decisions

[ADR-0020](../DECISIONS.md#adr-0020-phase-13-feedback-loop--outcome-analytics-judgment-calls) —
six parts: no new schema, `SENT` event (not draft status) as the "sent" definition, the
`{value, sampleSize/denominator, reliable}` shape for every stat, one parameterized dimension
function instead of five, `averageOpportunityScore` scoped to all scored opportunities vs.
`scoreVsResponse` scoped to sent ones only, and the plain-stacked-tables page layout choice.

## Known limitations / follow-ups

- No real outreach outcome data exists yet — every opportunity produced by Phases 3-11's live
  smoke tests was `VERIFIER_REJECTED`, so `/analytics` has only ever been exercised against seeded
  fixture data, never a real operator's actual sent outreach. This is the same blocker
  ADR-0015/16/17 already documented for Phases 8-10's live smoke tests, now inherited by Phase 13.
- Spec §75 (Claude periodically reviewing this same data and recommending discovery-allocation
  changes) is explicitly deferred per PLAN.md's "Deferred beyond these phases" list — this phase
  only produces the statistics; nothing consumes them autonomously yet.
- The five dimension tables are always all computed and rendered on one page (no filtering/tabs) —
  fine at today's scale per ADR-0020 part 6, but revisit if a real operator's dimension cardinality
  (e.g. many distinct problem categories) makes the page unwieldy.

## Next phase

`docs/PHASES.md` now points to **Phase 14 — Operational hardening** (exclusion enforcement,
`DO_NOT_CONTACT` enforcement in outreach generation, re-research eligibility windows, CSV/JSON
export, DB backup/restore, a general config UI, the seed/test-mode CLI, logging/observability
polish, and a secret-handling pass). Nothing from this phase changes that plan.
