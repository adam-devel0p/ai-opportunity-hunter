# Phase 6 — Opportunity Analysis Agent + scoring wiring

**Completed:** 2026-09-11

## What was built

- `src/agents/opportunityAnalysisAgent.ts` — the Opportunity Analysis Agent
  (AGENT_CONTRACTS.md §4): `opportunityAnalysisOutputSchema` (Zod — the full spec §26 field set
  plus `scoreComponents`/`penaltyReasons`, derived programmatically from `src/lib/scoring.ts`'s
  `SCORE_COMPONENT_RANGES`/`PENALTY_CATALOG` so the two can never drift out of sync), a
  hand-mirrored JSON Schema, `buildOpportunityAnalysisPrompt` (bakes in spec §27's deliverability
  guidance, §28's value requirement, §29's ROI-model example, the ten scoring-component
  definitions, the penalty catalog, and — verbatim from §88/§89 — the core honesty rule that a
  bare observed fact is not itself evidence of volume/workload/a specific fix), and
  `runOpportunityAnalysisAgent` (reasoning model tier, no tools — this agent only reasons over
  evidence Deep Research already gathered).
- `src/lib/problemCategories.ts` — `PROBLEM_CATEGORY_SEED_LIST` (spec §25), inspiration-only
  prompt content.
- `src/pipeline/analyzeHandler.ts` — `runAnalyzeTask`: the fourth live-DB-wired task handler.
  Loads the company an `ANALYZE` work item targets, loads all its `evidence_items` (joined
  against `sources` for URL context), runs the Opportunity Analysis Agent, and:
  - computes `rawScore`/`adjustedScore` via `src/lib/scoring.ts`'s `scoreOpportunity()` from the
    agent's `scoreComponents`/`penaltyReasons` — never from a Claude-supplied number;
  - inserts one `opportunities` row (status persisted straight at `VERIFICATION_PENDING`) and one
    `opportunity_evaluations` row;
  - retroactively links this company's not-yet-linked evidence to the new opportunity
    (`evidenceItems.opportunityId`);
  - appends an `"Analysis: opportunity \"...\" formed..."` summary to `companies.notes`;
  - enqueues a `VERIFY` work item (`entityId` = the opportunity id — the first task type whose
    `entityId` is an opportunity, not a company).
  Quota exhaustion/other failures handled the same way as the prior three handlers.
- `src/db/schema.ts` — two new `opportunities` columns (`existingAlternatives`,
  `validationQuestion`) and `impactAssumptions`'s stored type corrected from `string[]` to
  `{assumption: string, isKnown: boolean}[]` (a genuine Phase 1 gap: spec §29's core
  known-vs-assumption requirement couldn't be represented by the old type at all). Migration
  `drizzle/0001_naive_mathemanic.sql`.
- `scripts/analyze.ts` — manual smoke-test entry point: `npm run analyze -- --company <id>` for
  one company, or `--all [--limit <n>]` for every `PENDING` `ANALYZE` item.
- `docs/AGENT_CONTRACTS.md` §4 updated to the real, final output contract (score
  components/penalties added, currency-unit convention documented). `docs/DATABASE_SCHEMA.md`,
  `docs/ARCHITECTURE.md`, and `docs/PHASES.md` updated to reflect the above.
- `docs/DECISIONS.md`: new **ADR-0013** (7 parts) recording this phase's judgment calls.

## Deviations from PLAN.md

- None from PLAN.md's stated Phase 6 scope. Two schema gaps inherited from Phase 1 needed
  closing to actually implement what AGENT_CONTRACTS.md's draft §4 already called for
  (`existingAlternatives`/`validationQuestion` columns, and `impactAssumptions`'s type) — see
  ADR-0013 part 6. The scoring-input contract (`scoreComponents`/`penaltyReasons` on the agent's
  output) isn't in AGENT_CONTRACTS.md's original draft at all; PLAN.md's Phase 6 objective
  ("wiring `opportunity_evaluations.rawScore`/`adjustedScore` from `src/lib/scoring.ts` against
  the agent's output") required deciding how the agent's output actually reaches `scoring.ts`'s
  inputs, so this was designed and documented as ADR-0013 part 1 rather than left ambiguous.

## Testing performed

**Unit/fixture tests** — 2 new test files, using mocked `invokeClaude`/`runOpportunityAnalysisAgent`
or a real temp SQLite DB via `runMigrations` (same conventions as Phases 3-5; no real CLI invoked
in automated tests):

- `src/agents/opportunityAnalysisAgent.test.ts` — prompt includes company details, evidence
  grouped by classification (FACT before UNKNOWN), honestly flags empty evidence, bakes in the
  §88/§89 integrity rules and the scoring/penalty guides verbatim, appends the retry block;
  schema accepts well-formed output and rejects an out-of-range/non-integer score component, an
  invalid penalty reason, and `suggestedPriceMax < suggestedPriceMin`; confirms a bogus
  model-supplied `rawScore`/`adjustedScore` field is silently stripped, never validated through;
  `runOpportunityAnalysisAgent` calls `invokeClaude` with no tools and the reasoning tier by
  default, respects a model override.
- `src/pipeline/analyzeHandler.test.ts` (the Phase 6 acceptance-criterion fixture tests) —
  unknown company id throws; **§88's bad-opportunity example** (a bare contact-form-style fact,
  honestly scored): adjusted score lands below 75, the unsupported claim is persisted with
  `isKnown: false`, never as a bare fact; **§89's correct-reasoning example** (3 FACTs, 1
  INFERENCE, 2 UNKNOWNs, 1 HYPOTHESIS): opportunity forms at `VERIFICATION_PENDING` with a
  `validationQuestion` matching §89's own "next research question," `impactAssumptions` correctly
  split 2 known / 1 assumed, all 7 evidence items linked, exactly one `VERIFY` item enqueued at
  the right priority; a zero-evidence company still gets an honestly-scored opportunity (agent
  invoked with an empty evidence array, not skipped — "insufficient evidence" is a valid input,
  not an error state); **the persisted score always matches `scoring.ts`'s deterministic output**
  for given components/penalties, asserted directly against `calculateRawScore`/`buildPenalties`/
  `calculateAdjustedScore`; suggested prices convert from whole currency units to cents;
  `quota_exhausted` → `DEFERRED` without creating an opportunity or touching attempts; non-quota
  failure → `RETRYABLE` with backoff; exhausted attempts → `FAILED`.
- `src/db/schema.test.ts` updated: the existing opportunity round-trip fixture now uses the
  corrected `impactAssumptions` shape.

Actual output:

```
npm run build     → tsc, no errors
npm run lint      → eslint ., no errors or warnings
npm test          → Test Files  24 passed (24); Tests  217 passed (217)
```

**Manual smoke test — live analysis against real companies:**

PLAN.md's Phase 6 acceptance criteria don't require a live run (unlike Phases 0/3/4/5), but the 8
real veterinary clinics from Phases 3-5 were already sitting `RESEARCHED` with a `PENDING`
`ANALYZE` item, so ran it anyway before calling the phase done. Confirmed `ANTHROPIC_API_KEY`
unset (`env -u ANTHROPIC_API_KEY`), applied migration `0001` to the live `./data/aoh.db`
(`npm run db:migrate` — safe additive `ALTER TABLE ADD COLUMN`), then `npm run analyze -- --all`.

First attempt failed immediately on the first company (`table opportunities has no column named
existing_alternatives`) because the live DB predated this phase's migration — a real, useful
catch: confirmed the handler correctly does nothing destructive on an uncaught exception (no
partial writes; SQLite's per-statement failure meant the insert simply never happened), the
`RUNNING` work item was reset to `PENDING` by hand, the migration was applied, and the run was
retried from scratch.

**Result: all 8 succeeded.** Each formed exactly one opportunity, persisted at
`VERIFICATION_PENDING`, with all of that company's evidence linked (157 evidence items total,
matching Phase 5's count exactly — 0 unlinked afterward) and one `VERIFY` work item enqueued per
company. Adjusted scores ranged 0-37/100 (raw scores 48-62/100 before penalties) — every one of
the 8 real companies landed well below the ~75 Phase 7 gating threshold ADR-0008 anticipated,
consistent with these being small, unremarkable practice-management problems rather than strong
opportunities. `WEAK_SPECULATIVE_EVIDENCE` and `COMMODITY_SOLUTION_AVAILABLE` were the most
common penalties (6/8 and 6/8 companies respectively). Total reported cost: ~$1.12 across all 8
(~$0.14/company average — meaningfully cheaper than Phase 5's Deep Research, consistent with no
tool calls being made).

**Quality spot-check (Cherokee Animal Hospital, adjusted score 37 — the highest of the 8):**
inspected the full opportunity record directly in the DB. `problemDescription` correctly labels
each claim FACT/UNKNOWN inline (e.g. "no evidence of an online booking form... for boarding
(FACT)" vs. "no figures on actual call/email volume... are available (UNKNOWN)");
`economicImpact` explicitly frames its EUR figures as "Illustrative model only (not confirmed
figures)"; `impactAssumptions` correctly separates 2 `isKnown: true` lines (the two directly
observed facts) from 4 `isKnown: false` lines (the ROI model's estimated hours/rate/reduction and
an unconfirmed lost-booking claim); `existingAlternatives` names real, plausible competing SaaS
products (Gingr, PetExec, Kennel Connect, Rover for Business) — which is exactly what earned this
opportunity its `COMMODITY_SOLUTION_AVAILABLE` penalty, a legitimate signal, not a bug;
`validationQuestion` asks a single, concrete, answerable next question; `suggestedPriceMin`/`Max`
persisted as 70000/180000 cents, correctly converted from the agent's EUR 700/1800.

**Verdict: strong, no fabrication or overclaiming found.** The agent consistently declined to
convert single observed facts into confident-sounding conclusions, used `UNKNOWN` liberally and
correctly, and separated known evidence from ROI assumptions exactly per spec §29 — the same
honest pattern the §88 fixture was designed to enforce, holding up against real evidence, not
just the mocked fixture.

**Billing safety:** `ANTHROPIC_API_KEY` confirmed unset in the shell before the run. Reported
`total_cost_usd` summed to ~$1.12 across all 8 companies. Per ADR-0001, this field is not proof
of which pool was billed — the operator's claude.ai/console usage-page confirmation remains the
same outstanding manual check flagged by Phases 0, 3, 4, and 5, now also covering this phase's
run.

## New decisions

- **ADR-0013** (new, 7 parts): the agent supplies score components + penalty reasons as judgment
  inputs, `scoring.ts` alone computes the final numbers (and Zod's non-strict parsing structurally
  drops any hallucinated `rawScore`/`adjustedScore` field); every completed `ANALYZE` task always
  forms exactly one opportunity regardless of score, leaving rejection to Phase 7;
  `VERIFICATION_PENDING` is persisted directly in one write, same pattern as Phase 4; no tools +
  the reasoning model tier; prices expressed in whole currency units by the agent, converted to
  cents at persist time; two schema gaps closed (`existingAlternatives`/`validationQuestion`
  columns, corrected `impactAssumptions` type); spec §59 (fuzzy duplicate-opportunity detection)
  deferred as out of current pipeline scope. See `docs/DECISIONS.md`.

## Known limitations / follow-ups

- The operator's claude.ai/console billing confirmation is still outstanding — now covering
  Phases 0, 3, 4, 5, and 6's real-CLI runs.
- `companies.lifecycleStatus`'s `RESEARCHED -> NO_OPPORTUNITY` transition (built Phase 1/2) is
  still never exercised — this phase always forms an opportunity, deferring the "is this even
  worth pursuing" decision to Phase 7's gate. Whether anything should ever drive a company to
  `NO_OPPORTUNITY` is an open question for a later phase.
- Spec §59 (recognizing that two differently-worded opportunities represent the same underlying
  problem) isn't implemented — nothing in the current pipeline can yet re-run `ANALYZE` for an
  already-analyzed company, so it wasn't in scope. Revisit alongside Phase 14's
  `REFRESH_EVIDENCE`/re-research wiring.
- `companies.notes` now carries a fifth kind of content (the Phase 6 `"Analysis: opportunity
  ... formed"` line) — same open item flagged since ADR-0010 part 7. Revisit if the Phase 12
  dashboard needs these distinguished as structured fields.
- No `system_config`/`prompt_versions` writes yet, same as Phases 3-5 — still deferred.
- ADR-0008's penalty point values and the ~75 gating threshold remain reasoned starting points,
  not empirically tuned — this phase's live run (all 8 real opportunities landing 0-37/100) is
  the first real data point suggesting they're at least plausible (no real opportunity scored
  suspiciously close to the threshold either way), but Phase 7 is where the threshold itself
  actually gets exercised.
- The live DB required a manual `npm run db:migrate` this phase (a schema change was needed after
  Phase 5 last touched the live DB) — the first phase where this was necessary. Worth noting for
  future phases: always migrate the live DB before running a new handler's manual smoke test
  against it.

## Next phase

`docs/PHASES.md` now points to **Phase 7 — Skeptical Verification Agent + strong-opportunity
gating** as current, with Phase 6 marked done. Phase 7 should read `docs/AGENT_CONTRACTS.md` §5
and can exercise its work directly against the real opportunities already sitting
`VERIFICATION_PENDING` with a `PENDING` `VERIFY` work item in the live `./data/aoh.db` (all 8
veterinary-clinic opportunities from this phase) — no fresh discovery/prescreen/research/analyze
run needed. Phase 7 reads `opportunity_evaluations` rows this phase produced and implements the
actual `KEEP`/`REJECT` decision plus the gating function (threshold, evidence-score floor,
risk-category interaction) that ADR-0008's penalty values and this phase's live scores were
chosen against — all 8 real opportunities (adjusted scores 0-37/100) are expected to fail gating,
which is the first real test of whether that expectation holds.
