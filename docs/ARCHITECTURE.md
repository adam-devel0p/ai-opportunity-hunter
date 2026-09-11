# Architecture (current state)

This file describes what is **actually built**, as of the last completed phase. It is not
the plan (see [../PLAN.md](../PLAN.md) for that) — it's updated at the end of every phase to
reflect reality. If this file and the code disagree, the code wins; fix this file.

**Last updated:** Phase 14 (Operational hardening) — complete, the last planned phase. See
[phases/phase-14-operational-hardening.md](phases/phase-14-operational-hardening.md) for the
full writeup.

## Status

Phases 0-14 are done — every phase PLAN.md planned in detail. The repo has a working TypeScript toolchain, the Phase 0 Claude-invocation
client, a full SQLite schema (Drizzle) plus the deterministic domain logic (domain
normalization/dedupe, opportunity scoring) from Phase 1, the Phase 2 queue/state-machine
primitives (priority selection, lifecycle transition validation, failure classification, crash
recovery), Phase 3's first real agent + live DB wiring (manually-configured discovery campaigns,
the Discovery Agent, diversity-aware campaign selection, the `DISCOVER` task handler), Phase 4's
second real agent (the Pre-Screening Agent + the `PRESCREEN` task handler), Phase 5's third real
agent (the Deep Research Agent + the `RESEARCH` task handler, which persists provenance-verified
evidence and enqueues `ANALYZE` work, plus the ADR-0004 `PostToolUse` evidence-provenance hook),
Phase 6's fourth real agent (the Opportunity Analysis Agent + the `ANALYZE` task handler, which
turns a company's evidence into a scored `opportunities`/`opportunity_evaluations` row — the
first phase to wire `src/lib/scoring.ts` to real data), Phase 7's fifth real agent (the
Skeptical Verification Agent + the `VERIFY` task handler, which runs a fresh-context adversarial
pass over a formed opportunity and combines it with a deterministic strong-opportunity gate —
score threshold, evidence-strength floor, risk-category classification — to decide `VERIFIED` vs.
`VERIFIER_REJECTED`, the first phase where an opportunity can actually be rejected, and the first
to enqueue `BUILD_OFFER` work), Phase 8's sixth real agent (the Offer Builder + the `BUILD_OFFER`
task handler, which turns a gated `VERIFIED` opportunity into a concrete, priced `offers` row —
the first phase to enforce spec §34's vague-offer lint and spec §35's pricing bands, both
deterministic), Phase 9's seventh real agent (the Contact Research Agent + the
`FIND_CONTACT` task handler, which finds the real person most likely to own a gated opportunity's
problem and persists a `contacts` row — the first phase to enforce spec §38's "never represent a
guessed email as verified" hard rule at a dedicated data-access layer
(`src/lib/contactDisplay.ts`) rather than trusting a future dashboard to check it correctly), and
Phase 10's eighth and final pipeline agent (the Outreach Writer + the `WRITE_OUTREACH` task
handler, which writes one honest cold-outreach draft per verified opportunity with an offer and a
contact, and persists an `outreach_drafts` row — the first handler that deliberately does NOT
transition the opportunity's lifecycle status or enqueue further work, since actually sending mail
is a manual operator action, spec §41, not something this pipeline does), and now Phase 11's
autonomous worker loop (`src/worker.ts`): the long-running process that ties every earlier
handler together into continuous operation (spec §50), with `system_config`-driven pause/resume
(spec §71, via a new minimal `src/lib/config.ts` and `scripts/autonomous.ts` CLI), quota-aware
exponential backoff (spec §51, reusing every handler's existing `DEFERRED` convention), crash
recovery wired to the live DB for the first time (Phase 2's `crashRecovery.ts`), and
self-replenishing `DISCOVER` work via Phase 3's campaign selection. And now Phase 12's dashboard
(`src/app`, a Next.js App Router app): the operator's first UI — summary metrics, an opportunity
list + full detail page (evidence UX, the spec §85 human-trust panel, every spec §45 operator
action), a spec §69 activity feed, the spec §71 autonomous pause/resume toggle, and spec §72's
manual research entry point — built on new plain `src/lib` modules
(`dashboardQueries.ts`/`dashboardActions.ts`/`activity.ts`) the Next.js server components/actions
just wire up. And now Phase 13's feedback loop read side: `src/lib/outcomeAnalytics.ts` (spec §47,
§74) aggregates the `outreach_outcomes` table Phase 12 already wrote to — overall reply/positive-
reply/meeting/win rates and average opportunity score, plus the same broken down by industry/
country/problem category/campaign/price band — every rate/average hedged with its own sample size
and a small-sample-size `reliable` flag, surfaced on a new `/analytics` dashboard page. No schema
changes, no new agent. And now Phase 14's operational hardening: a new `exclusion_rules` table
(spec §61 domain/industry/country blocks) checked live by `discoverHandler.ts` and, authoritatively,
by `prescreenHandler.ts` right before every PRESCREEN Claude call, both via a shared pure matcher
(`src/pipeline/exclusionCheck.ts`) and DB wrapper (`src/lib/exclusions.ts`); permanent
single-company exclusion reuses the existing `companies.lifecycleStatus = "EXCLUDED"` transition
plus a new `dashboardActions.excludeCompany`. A single DO_NOT_CONTACT predicate
(`src/lib/doNotContact.ts`) is enforced both where it matters (`contactHandler.ts` skips
enqueueing `WRITE_OUTREACH`) and defensively (`outreachHandler.ts` re-checks before calling
Claude), spec §65. `REFRESH_EVIDENCE` finally has a real handler
(`src/pipeline/refreshEvidenceHandler.ts`, spec §60) reusing `researchHandler.ts`'s
evidence-persistence rule via a new shared `src/pipeline/researchEvidence.ts`, topped up every
worker cycle by a new batch-capped `ensureRefreshEvidenceWork`. `src/lib/config.ts` gained two
more `system_config`-backed accessors (the spec §32 gate's threshold/floor/high-risk policy, the
re-research window), both wired live in `worker.ts`'s `TASK_HANDLERS` map and both editable from a
new `/settings` dashboard page alongside exclusion-rule management, one-click backup
(`src/lib/backup.ts`), and JSON/CSV export (`src/lib/exportData.ts`, `/api/export`). A CLI-only
seed/test mode (`scripts/seed.ts`, `src/lib/seedCompanies.ts`, spec §99) drives known company URLs
through the full screening-through-offer pipeline for prompt tuning. No new Claude-invoking agent
this phase — everything added is deterministic TypeScript, same "Claude only where judgment is
genuinely required" split the whole project follows. See the dedicated sections below and
ADR-0021.

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
- Next.js ^16 (App Router) + React ^19 for the dashboard (Phase 12, PLAN.md §14/ADR-0003) —
  server components read Drizzle directly, server actions write directly, no REST/tRPC layer.
  `next dev`/`next build` are pinned to `--webpack` rather than Turbopack (the Next 16 default);
  see "The dashboard (`src/app`, Phase 12)" below and ADR-0019 part 1 for why. `eslint-plugin-
  react-hooks` (not full `eslint-plugin-react` — ADR-0019 part 2) lints `src/app/**`.
  `@playwright/test` drives real-browser smoke tests (`e2e/`).

## Folder layout (as actually built)

```
src/
  agents/
    claudeClient.ts           The only place that spawns the `claude` CLI. See below.
    claudeClient.test.ts      Unit tests: env sanitization, quota detection, invocation shape.
    runStructuredAgent.ts     Shared validated-invoke-with-retry layer (Phase 3, ADR-0010 part
                               1) — invokes Claude via claudeClient, parses/validates the result
                               against a caller-supplied Zod schema, retries once with the
                               validation error appended to the prompt. Every agent from Phase 3
                               onward builds on this instead of reimplementing the retry loop.
    runStructuredAgent.test.ts
    discoveryAgent.ts          Discovery Agent (AGENT_CONTRACTS.md §1, Phase 3): Zod schema +
                                hand-mirrored JSON Schema, prompt builder baking in the
                                never-invent-a-company rule (spec §14), `runDiscoveryAgent`
                                (fast model tier per spec §52, WebSearch+WebFetch tools).
    discoveryAgent.test.ts
    prescreenAgent.ts          Pre-Screening Agent (AGENT_CONTRACTS.md §2, Phase 4): Zod schema +
                                hand-mirrored JSON Schema, prompt builder (fast model tier,
                                `WebFetch`-only, ADR-0011 part 2), `runPrescreenAgent`.
    prescreenAgent.test.ts
    deepResearchAgent.ts       Deep Research Agent (AGENT_CONTRACTS.md §3, Phase 5): Zod schema
                                + hand-mirrored JSON Schema, prompt builder (bakes in spec §24's
                                research integrity rules verbatim plus ADR-0012's additions),
                                `runDeepResearchAgent` (reasoning model tier, WebSearch+WebFetch,
                                registers the source-capture hook via `settings`/`extraEnv`).
    deepResearchAgent.test.ts
    sourceCaptureHook.ts       Shared logic for the ADR-0004 `PostToolUse` hook (Phase 5):
                                `buildSourceCaptureHookSettings` (the `--settings` payload,
                                exec-form command+args pointing at the hook script below),
                                `buildSourceCaptureHookEnv` (env vars carrying DB path/company
                                id/task id to the hook's separate OS process), and
                                `extractWebFetchEvent` (parses a PostToolUse payload — used by
                                both this module's settings builder and the hook script itself).
    sourceCaptureHook.test.ts
    opportunityAnalysisAgent.ts  Opportunity Analysis Agent (AGENT_CONTRACTS.md §4, Phase 6):
                                  Zod schema (including `scoreComponents`/`penaltyReasons`,
                                  derived programmatically from `src/lib/scoring.ts`'s ranges/
                                  catalog so the two can't drift, ADR-0013 part 1) + hand-mirrored
                                  JSON Schema, prompt builder (bakes in spec §27-29's
                                  deliverability/value/ROI guidance and the §88/§89
                                  honest-evidence integrity rules verbatim), `runOpportunityAnalysisAgent`
                                  (reasoning model tier, no tools — ADR-0013 part 4).
    opportunityAnalysisAgent.test.ts
    skepticAgent.ts             Skeptical Verification Agent (AGENT_CONTRACTS.md §5, Phase 7):
                                 Zod schema + hand-mirrored JSON Schema, prompt builder (embeds
                                 spec §33's question list verbatim, biases the model toward
                                 REJECT on mediocre cases), `runSkepticAgent` (reasoning model
                                 tier, no tools — ADR-0014). Input type deliberately has no field
                                 for the Analysis Agent's `confidence`/`scoreComponents`/
                                 `penaltyReasons` (fresh-context enforcement, ADR-0014 part 1).
    skepticAgent.test.ts
    offerBuilderAgent.ts        Offer Builder Agent (AGENT_CONTRACTS.md §6, Phase 8): Zod schema
                                 (including the Phase-8-added nullable `priceJustification` field,
                                 ADR-0015 part 2) + hand-mirrored JSON Schema, prompt builder
                                 (embeds spec §34's bad/good scope examples and spec §36's
                                 never-claim-a-demo-exists rule verbatim, takes a formatted
                                 pricing-band guide as input), `runOfferBuilderAgent` (reasoning
                                 model tier, no tools). Supports a `regenerationReason` input
                                 distinct from the schema-validation retry, used by the handler's
                                 vague-offer-lint regeneration (ADR-0015 part 3).
    offerBuilderAgent.test.ts
    contactAgent.ts             Contact Research Agent (AGENT_CONTRACTS.md §7, Phase 9): Zod
                                 schema (`contactOutputSchema`, with a `superRefine` structurally
                                 coupling `email`/`emailConfidence`, ADR-0016 part 2) + hand-mirrored
                                 JSON Schema, prompt builder (embeds spec §37's preferred-contact-
                                 roles list and never-invent-a-person/email integrity rules
                                 verbatim), `runContactAgent` (fast model tier, WebSearch+WebFetch
                                 tools — ADR-0016 part 1).
    contactAgent.test.ts
    outreachAgent.ts            Outreach Writer (AGENT_CONTRACTS.md §8, Phase 10): Zod schema
                                 (`{ subject, body }`) + hand-mirrored JSON Schema, prompt builder
                                 (embeds spec §39's style rules and spec §40's bad/good
                                 truthfulness examples verbatim, signs off with a literal
                                 "[Your name]" placeholder — ADR-0017 part 4), `runOutreachAgent`
                                 (reasoning model tier, no tools). Supports a `regenerationReason`
                                 input distinct from the schema-validation retry, used by the
                                 handler's deterministic-lint regeneration (ADR-0017 part 2).
    outreachAgent.test.ts
    schemas/
      deepResearchSpike.ts    Draft Zod + JSON Schema pair for the spike script only —
                               superseded by deepResearchAgent.ts's real contract; kept only
                               because scripts/spike-research.ts still imports it.
  config/
    models.ts                 Tier -> `--model` alias map (ADR-0006).
    models.test.ts
  db/
    schema.ts                  Drizzle schema for all 14 tables (DATABASE_SCHEMA.md).
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
                                 penalty catalog (ADR-0008), raw/adjusted score calculation. Wired
                                 to real `opportunity_evaluations` rows since Phase 6
                                 (`src/pipeline/analyzeHandler.ts`).
    scoring.test.ts
    problemCategories.ts        `PROBLEM_CATEGORY_SEED_LIST` (spec §25, Phase 6) — inspiration-only
                                 category list fed into the Opportunity Analysis Agent's prompt;
                                 `opportunities.problemCategory` is free text, never constrained
                                 to this list.
    sourceFreshness.ts          `computeSourceFreshnessState` (spec §23, Phase 5) — deterministic
                                 `sources.freshnessState` derivation: `UNAVAILABLE` for a
                                 non-2xx/missing HTTP status, else `FRESH`/`STALE` by a
                                 configurable age threshold (default 30 days, ADR-0012 part 7).
    sourceFreshness.test.ts
    researchFreshness.ts        `computeNextEligibleResearchAt` (spec §60, Phase 5) —
                                 deterministic `companies.nextEligibleResearchAt` derivation
                                 (default 90-day window, ADR-0012 part 7), set by
                                 `researchHandler.ts` on every successful research run.
    researchFreshness.test.ts
    riskCategory.ts              `classifyOpportunityRisk` (spec §8, Phase 7) — deterministic
                                  keyword/phrase heuristic over the opportunity's
                                  problem/solution text (never `companies.industry` alone, per
                                  spec §8's own clinic-intake-vs-diagnosis example), one regex
                                  per spec §8 high-risk domain. Two patterns require a
                                  same-*sentence* medical-context word (`requiresContext`) to
                                  avoid generic-word false positives (e.g. a "diagnostic" audit)
                                  — see ADR-0014 part 4 for the real false positive this closed.
    riskCategory.test.ts
    opportunityGate.ts            `evaluateOpportunityGate` (spec §32, Phase 7) — the
                                   deterministic strong-opportunity gate: combines
                                   `verifierResult`, `adjustedScore` vs. a configurable
                                   threshold (default 75), `evidenceStrength` vs. a configurable
                                   floor (default 10), and `riskCategory` vs. an
                                   operator-opt-in policy (default excluded). Any one failing
                                   check fails the whole gate; every failing reason is
                                   collected, not just the first (ADR-0014 part 2). Pure, no DB,
                                   no Claude call — `verifyHandler.ts` is the only caller.
    opportunityGate.test.ts
    pricing.ts                   `resolvePriceBand`/`evaluateOfferPricing`/
                                  `formatPricingBandGuide` (spec §35, Phase 8) — deterministic
                                  pricing-band resolution (duration-first, price as a fallback),
                                  in-band checks for both the one-off price and the optional
                                  recurring-support range. Pure, no DB, no Claude call — mirrors
                                  `opportunityGate.ts`'s shape (config as an optional parameter,
                                  code-constant default — ADR-0015 part 1).
    pricing.test.ts
    offerLint.ts                  `lintOfferScope` (spec §34, Phase 8) — deterministic vague-offer
                                   detection: an exact-phrase blocklist (spec §34's own bad
                                   example plus close variants) plus a minimum word-count floor.
                                   `src/pipeline/offerHandler.ts` is the only caller (ADR-0015
                                   part 3).
    offerLint.test.ts
    contactDisplay.ts             `toContactDisplay`/`getContactDisplay` (spec §38, Phase 9) — the
                                   data-access-layer enforcement of "never represent a guessed
                                   email as verified": `isVerifiedEmail` is only ever true when
                                   `emailConfidence === "VERIFIED"`, by construction (ADR-0016
                                   part 4). `isPreferredForInitialOutreach` gives the same
                                   treatment to spec §38's softer "prefer publicly listed or
                                   verified addresses" preference. `contactHandler.ts` already
                                   exercises this for real; any later read path (Outreach Writer,
                                   the dashboard) should build on it instead of re-deriving the
                                   check.
    contactDisplay.test.ts
    outreachLint.ts               `lintOutreachDraft` (spec §39-40, Phase 10) — three independent
                                   deterministic checks (`checkOutreachWordCount`,
                                   `checkOutreachBannedPhrases`, `checkOutreachTruthfulness`),
                                   combined and aggregating every failing reason at once (ADR-0017
                                   part 2, unlike `offerLint.ts`'s short-circuit-on-first-match).
                                   The truthfulness check is a structural approximation, not real
                                   claim-to-evidence tracing (ADR-0017 part 3): an unhedged
                                   confident-assertion sentence only fails the check when the
                                   opportunity has zero FACT-classified evidence at all.
                                   `outreachHandler.ts` is the only caller.
    outreachLint.test.ts
    campaigns.ts                 `discovery_campaigns` CRUD (Phase 3, spec §15): create/list/
                                  get, and operator status toggles (enable/pause/disable/
                                  blacklist — freely reversible, no state-machine restriction)
                                  plus `setCampaignPriority`.
    campaigns.test.ts
    config.ts                     `getAutonomousMode`/`setAutonomousMode` (spec §71, Phase 11),
                                   `getCampaignSelectionState`/`setCampaignSelectionState`
                                   (persists `campaignSelection.ts`'s SWRR weights across worker
                                   restarts), and, since Phase 14,
                                   `getOpportunityGateConfig`/`setOpportunityGateConfig` (wires a
                                   live value into `opportunityGate.ts`'s already-parameterized
                                   config, spec §32/§70) and
                                   `getReResearchWindowMs`/`setReResearchWindowMs` (same for
                                   `researchFreshness.ts`, spec §60/§70) — every accessor falls
                                   back to its module's own code-constant default on an unset or
                                   malformed stored value. `worker.ts`'s `TASK_HANDLERS` map reads
                                   both live every cycle. The remaining `system_config` keys
                                   DATABASE_SCHEMA.md's original wishlist names (country/industry
                                   allowlists as a `system_config` key specifically, pricing bands,
                                   discovery volume, research depth, min confidence, max
                                   simultaneous work, daily limits) remain unwritten (ADR-0021
                                   part 5).
    config.test.ts
    exclusions.ts                  `exclusion_rules` CRUD + `checkExclusion` (spec §61, Phase 14)
                                    — the DB-wired wrapper around
                                    `src/pipeline/exclusionCheck.ts`'s pure matcher that
                                    `discoverHandler.ts`/`prescreenHandler.ts` call. Loads every
                                    rule fresh on each check (ADR-0021 part 1/2).
    exclusions.test.ts
    doNotContact.ts                 `isDoNotContact` (spec §65, Phase 14) — the single predicate
                                     both `contactHandler.ts` (skip enqueueing `WRITE_OUTREACH`)
                                     and `outreachHandler.ts` (defensive re-check) call, so the
                                     rule can't drift between the two sites (ADR-0021 part 3).
    doNotContact.test.ts
    seedCompanies.ts                 `seedCompanyForTesting` (spec §99, Phase 14) — inserts a
                                      company at `PRESCREEN_PENDING` + enqueues a `PRESCREEN` item
                                      from a CLI-supplied URL, mirroring `discoverHandler.ts`'s own
                                      per-candidate insert logic exactly (`sourceCampaignId` stays
                                      null). Distinct from `dashboardActions.requestManualResearch`
                                      (spec §72), which skips screening — see ADR-0021 part 6.
    seedCompanies.test.ts
    backup.ts                        `backupDatabase`/`restoreDatabase` (spec §80, Phase 14) —
                                      `better-sqlite3`'s own `.backup()` API for a WAL-safe
                                      point-in-time snapshot; restore is a plain file copy plus
                                      stale `-wal`/`-shm` sidecar cleanup (ADR-0021 part 7).
    backup.test.ts
    exportData.ts                    `buildExportBundle`/`bundleToJson`/`exportEntityCsv` (spec
                                      §79, Phase 14) — companies/opportunities/contacts/
                                      outreach-drafts/outreach-outcomes as one bundle; CSV
                                      serializes nested JSON columns inline (ADR-0021 part 8).
    exportData.test.ts
    dashboardQueries.ts            Read-side queries for the Phase 12 dashboard (spec §42-44,
                                    §73): `getSummaryMetrics`, `listOpportunities`,
                                    `getOpportunityDetail`, `listCompanies`, `getCompanyDetail`,
                                    `getCompanyByNormalizedDomain`. Plain functions over a `Db`,
                                    aggregates computed in TypeScript over `.all()` rather than
                                    SQL `COUNT`/`JOIN` (repo-scale justification in the module
                                    docstring).
    dashboardQueries.test.ts
    dashboardActions.ts            Operator-action write paths for the Phase 12 dashboard (spec
                                    §45-46, §72): `approveOpportunity`, `rejectOpportunity`,
                                    `markDraftReviewed`, `markSentManually` (the one path that
                                    drives the real `OUTREACH_READY -> SENT` transition, ADR-0019
                                    part 7), `recordOutreachOutcome`, `requestManualResearch`
                                    (skips discovery/pre-screening, inserts straight at
                                    `RESEARCH_PENDING` — ADR-0019 part 5). `src/app/actions/*.ts`
                                    are thin `"use server"` wrappers over these.
    dashboardActions.test.ts
    activity.ts                    `getRecentActivity` (spec §69, Phase 12) — derives a run-
                                    history feed from `work_items` at read time rather than a new
                                    event-log table (ADR-0019 part 4); expands a completed
                                    `DISCOVER` item into one entry per company discovered in its
                                    time window to match the spec's own example.
    activity.test.ts
    appDb.ts                       `getDb()` (Phase 12) — a `globalThis`-cached `Db` singleton
                                    for the Next.js process, so dev-mode hot reloads don't leak
                                    `better-sqlite3` connections.
    outcomeAnalytics.ts             `getOverallOutcomeMetrics`/`getPerformanceByDimension` (spec
                                    §47, §74, Phase 13) — the feedback-loop aggregate queries:
                                    reply/positive-reply/meeting/win rates, average opportunity
                                    score, score-vs-response, and the same broken down by
                                    industry/country/problem category/campaign/price band. Every
                                    rate (`computeRateStat`) and average (`computeAverageStat`)
                                    carries its own sample size and a `reliable` flag against
                                    `DEFAULT_MIN_SAMPLE_SIZE = 5` (ADR-0020 part 3) — spec §74's
                                    small-sample-size guard. No new tables; aggregates entirely
                                    over `outreach_outcomes`/`outreach_drafts`/`opportunities`/
                                    `companies`/`offers`/`discovery_campaigns` rows Phase 12
                                    already wrote to (ADR-0020 part 1).
    outcomeAnalytics.test.ts
  pipeline/
    stateMachine.ts              Lifecycle transition validators for all three §90-derived
                                  enums (company/opportunity/work-item), each its own table +
                                  function. Throws `InvalidTransitionError` on an invalid move.
    stateMachine.test.ts
    priority.ts                  `TASK_TYPE_PRIORITY` (spec §49 ordering, ADR-0009 part 1) and
                                  `selectNextWorkItem` — pure selection over queue contents.
    priority.test.ts
    failureClassification.ts     `classifyFailure` (spec §66, ADR-0009 part 4),
                                  `computeRetryBackoffMs` (1m exponential, capped 1h), and
                                  `resolveFailureOutcome` tying both to a state-machine-validated
                                  work-item update.
    failureClassification.test.ts
    exclusionCheck.ts             `checkExclusionRules` (spec §61, Phase 14) — pure, exact
                                   (case-insensitive) DOMAIN/INDUSTRY/COUNTRY matcher over a
                                   candidate; no DB, no Claude call. `src/lib/exclusions.ts` is the
                                   DB-wired caller.
    exclusionCheck.test.ts
    researchEvidence.ts           `persistVerifiedEvidence`/`urlsMatch` (Phase 14) — the
                                   provenance-verified evidence-persistence rule factored out of
                                   `researchHandler.ts` (no behavior change) so
                                   `refreshEvidenceHandler.ts` can reuse it exactly (ADR-0021
                                   part 4).
    crashRecovery.ts             `findStuckRunningItems` / `planStuckWorkItemRecovery` (spec
                                  §67) — pure functions; not yet wired to a live DB or called
                                  anywhere (Phase 11's `worker.ts` calls this at startup).
    crashRecovery.test.ts
    campaignSelection.ts         `selectNextCampaign` (Phase 3, spec §16, ADR-0010 part 2) —
                                  pure smooth-weighted-round-robin selection over ENABLED
                                  campaigns, weighted by operator-set priority, state threaded
                                  explicitly by the caller (not persisted anywhere yet — Phase
                                  3 runs one campaign at a time via `scripts/discover.ts`).
    campaignSelection.test.ts
    discoverHandler.ts           `runDiscoverTask` (Phase 3) — the first live-DB-wired task
                                  handler: loads the campaign a `DISCOVER` work item targets
                                  (`entityId` holds a campaign id for this task type, ADR-0010
                                  part 3), runs the Discovery Agent, inserts new companies
                                  deduped by normalized domain (global, not per-campaign —
                                  ADR-0010 part 4), transitions each to `PRESCREEN_PENDING`,
                                  enqueues a `PRESCREEN` work item per new company, and
                                  finalizes the `DISCOVER` item (`COMPLETED`, or `DEFERRED` on
                                  quota exhaustion, or routed through `failureClassification`
                                  on other failures — ADR-0010 part 5). Since Phase 14, each new
                                  candidate is also checked against live `exclusion_rules` before
                                  insertion — a match inserts straight at `EXCLUDED` instead of
                                  `PRESCREEN_PENDING`, no `PRESCREEN` item enqueued; an already-known
                                  company is also re-checked on rediscovery (ADR-0021 part 2).
    discoverHandler.test.ts
    prescreenHandler.ts          `runPrescreenTask` (Phase 4) — the second live-DB-wired task
                                  handler: loads the company a `PRESCREEN` work item targets
                                  (`entityId` is a company id here, per DATABASE_SCHEMA.md's
                                  default). Since Phase 14, the *first* check is a live
                                  `exclusion_rules` match (`src/lib/exclusions.ts`) — this is the
                                  authoritative exclusion enforcement point, since it runs right
                                  before every Claude call regardless of when the rule was added
                                  (ADR-0021 part 2); a match transitions the company to `EXCLUDED`
                                  without calling Claude. Otherwise short-circuits to `DISCARDED`
                                  without ever calling Claude if `nextEligibleResearchAt` hasn't
                                  passed yet (ADR-0011 part 3), otherwise runs the Pre-Screening
                                  Agent and acts on its classification: `DISCARD` → company
                                  `DISCARDED`, nothing re-queued; `MAYBE`/`PROMISING` (treated
                                  identically, ADR-0011 part 1) → company
                                  `PRESCREENED -> RESEARCH_PENDING` (one DB write, ADR-0011 part 5)
                                  and a `RESEARCH` work item enqueued. Classification + reasons
                                  appended to `companies.notes` (ADR-0011 part 4). Quota
                                  exhaustion/other failures handled the same way as
                                  `discoverHandler.ts`.
    prescreenHandler.test.ts
    researchHandler.ts           `runResearchTask` (Phase 5) — the third live-DB-wired task
                                  handler: loads the company a `RESEARCH` work item targets
                                  (`entityId` is a company id, same convention as `PRESCREEN`),
                                  runs the Deep Research Agent, and persists only the evidence
                                  items whose `sourceUrl` matches a `sources` row the ADR-0004
                                  hook actually recorded for this task (ADR-0012 part 3) —
                                  everything else is dropped, not persisted, with the drop count
                                  surfaced in both the handler's return value and
                                  `companies.notes`. On success: company transitions
                                  `RESEARCH_PENDING -> RESEARCHED` unconditionally (even with
                                  zero surviving evidence, ADR-0012 part 5), `lastResearchedAt`/
                                  `nextEligibleResearchAt` are set via `researchFreshness.ts`,
                                  candidate problems are appended to `companies.notes`, and an
                                  `ANALYZE` work item is enqueued. Quota exhaustion/other
                                  failures handled the same way as `discoverHandler.ts`/
                                  `prescreenHandler.ts`.
    researchHandler.test.ts
    analyzeHandler.ts             `runAnalyzeTask` (Phase 6) — the fourth live-DB-wired task
                                  handler: loads the company an `ANALYZE` work item targets
                                  (`entityId` is a company id, same convention as `PRESCREEN`/
                                  `RESEARCH`), loads all its `evidence_items` (joined against
                                  `sources` for URL context), runs the Opportunity Analysis
                                  Agent, and turns the result into one `opportunities` row plus
                                  one `opportunity_evaluations` row — the raw/adjusted score is
                                  always computed by `src/lib/scoring.ts` from the agent's
                                  `scoreComponents`/`penaltyReasons`, never taken from the agent
                                  directly (ADR-0013 part 1). Every `ANALYZE` task that reaches a
                                  successful Claude call forms exactly one opportunity regardless
                                  of score (ADR-0013 part 2); the opportunity is persisted
                                  straight at `VERIFICATION_PENDING` in one write (ADR-0013 part
                                  3, same pattern as `prescreenHandler.ts`); this company's
                                  not-yet-linked evidence is retroactively linked to the new
                                  opportunity via `evidenceItems.opportunityId`; a summary line is
                                  appended to `companies.notes`; and a `VERIFY` work item is
                                  enqueued (`entityId` = the opportunity id — the first task type
                                  whose `entityId` is an opportunity, not a company). Quota
                                  exhaustion/other failures handled the same way as
                                  `discoverHandler.ts`/`prescreenHandler.ts`/`researchHandler.ts`.
    analyzeHandler.test.ts
    verifyHandler.ts               `runVerifyTask` (Phase 7) — the fifth live-DB-wired task
                                    handler: loads the opportunity a `VERIFY` work item targets
                                    (`entityId` is an *opportunity* id, the first task type
                                    where that's true — set by `analyzeHandler.ts`), its
                                    `opportunity_evaluations` row, its linked evidence, and the
                                    owning company, runs the Skeptical Verification Agent with a
                                    fresh-context input (ADR-0014 part 1), classifies risk
                                    (`riskCategory.ts`), evaluates the spec §32 gate
                                    (`opportunityGate.ts`), persists the skeptic's output into
                                    `opportunity_evaluations.verifier*`, transitions the
                                    opportunity to `VERIFIED` or `VERIFIER_REJECTED` in one write
                                    (ADR-0014 part 3), appends a full-reasons summary to
                                    `companies.notes`, and — on a gate pass only — enqueues a
                                    `BUILD_OFFER` work item (ADR-0014 part 6). Quota
                                    exhaustion/other failures handled the same way as every
                                    earlier handler.
    verifyHandler.test.ts
    offerHandler.ts                 `runBuildOfferTask` (Phase 8) — the sixth live-DB-wired task
                                     handler: loads the opportunity a `BUILD_OFFER` item targets
                                     (`entityId` is an opportunity id, same convention as `VERIFY`
                                     — set by `verifyHandler.ts`, which only enqueues this task
                                     type on a gate pass, so this handler trusts that without
                                     re-checking `opportunities.status`), its
                                     `opportunity_evaluations` row, and the owning company, runs
                                     the Offer Builder Agent, and runs two deterministic checks on
                                     the result: `src/lib/offerLint.ts`'s vague-offer lint (a match
                                     regenerates once, a second match fails the task without
                                     persisting an offer) and `src/lib/pricing.ts`'s band
                                     evaluation (never blocks; records a justification — the
                                     agent's own or a deterministic fallback — whenever the price
                                     falls outside its band). On success, persists one `offers`
                                     row, collapses the opportunity
                                     `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH` in one write,
                                     appends a summary to `companies.notes`, and enqueues a
                                     `FIND_CONTACT` work item (Phase 9's agent). Quota
                                     exhaustion/other failures handled the same way as every
                                     earlier handler.
    offerHandler.test.ts
    contactHandler.ts               `runFindContactTask` (Phase 9) — the seventh live-DB-wired
                                     task handler: loads the opportunity a `FIND_CONTACT` item
                                     targets (`entityId` is an opportunity id, same convention as
                                     `VERIFY`/`BUILD_OFFER` — set by `offerHandler.ts`, which
                                     enqueues this task type unconditionally on every successful
                                     offer, so this handler trusts that without re-checking
                                     `opportunities.status`) and the owning company, runs the
                                     Contact Research Agent with the opportunity's
                                     `problemTitle`/`problemDescription`/`affectedRole` as
                                     targeting context, and persists exactly one `contacts` row
                                     regardless of the email confidence found (ADR-0016 part 3/5
                                     — same "form the record, let a read path judge it" pattern as
                                     `analyzeHandler.ts`). Computes its outcome's
                                     `isVerifiedEmail`/`isPreferredForInitialOutreach` via
                                     `src/lib/contactDisplay.ts` rather than reading
                                     `emailConfidence` inline. On success, collapses the
                                     opportunity `CONTACT_RESEARCH -> OUTREACH_READY` in one write,
                                     appends a summary to `companies.notes`, and enqueues a
                                     `WRITE_OUTREACH` work item (Phase 10's agent) — unless the
                                     found contact (or the owning company) is `DO_NOT_CONTACT`
                                     (`src/lib/doNotContact.ts`, spec §65, Phase 14), in which case
                                     the contact is still recorded but no `WRITE_OUTREACH` item is
                                     ever created; a prior contact for the same company/email
                                     already marked DNC has that flag inherited onto the new row
                                     (ADR-0021 part 3). Quota exhaustion/other failures handled the
                                     same way as every earlier handler.
    contactHandler.test.ts
    outreachHandler.ts              `runWriteOutreachTask` (Phase 10) — the eighth and final
                                     live-DB-wired handler of the core pipeline: loads the
                                     opportunity a `WRITE_OUTREACH` item targets (`entityId` is an
                                     opportunity id, same convention as `VERIFY`/`BUILD_OFFER`/
                                     `FIND_CONTACT` — set by `contactHandler.ts`), its `offers`
                                     row, its linked evidence, and the company's most recent
                                     `contacts` row (looked up by `companyId` + `createdAt desc`,
                                     since `contacts` has no direct opportunity link — ADR-0017
                                     part 6), runs the Outreach Writer, and runs
                                     `src/lib/outreachLint.ts`'s three checks on the result (a
                                     match regenerates once, a second match fails the task without
                                     persisting a draft — same pattern as `offerHandler.ts`'s
                                     vague-offer lint). On success, persists one `outreach_drafts`
                                     row at `status: "DRAFT"` and appends a summary to
                                     `companies.notes` — but, unlike every earlier handler, does
                                     NOT transition `opportunities.status` and enqueues no further
                                     work item (ADR-0017 part 5): sending is a manual operator
                                     action, not this handler's job. Since Phase 14, a defensive
                                     `isDoNotContact` re-check runs right before ever calling Claude
                                     (COMPLETED, no draft, if it trips) — closes the race where a
                                     `WRITE_OUTREACH` item was already queued before the operator
                                     set DO_NOT_CONTACT (ADR-0021 part 3). Quota exhaustion/other
                                     failures handled the same way as every earlier handler.
    outreachHandler.test.ts
    refreshEvidenceHandler.ts       `runRefreshEvidenceTask` (spec §60, Phase 14) — the
                                     `REFRESH_EVIDENCE` handler `worker.ts` stubbed out through
                                     Phase 11-13: loads a company already at `RESEARCHED`/
                                     `NO_OPPORTUNITY` (throws otherwise), re-runs the Deep Research
                                     Agent, and persists new evidence via the shared
                                     `researchEvidence.ts` rule. Unlike `researchHandler.ts`, does
                                     NOT transition `lifecycleStatus` (no
                                     `RESEARCHED -> RESEARCHED` self-loop exists in
                                     `stateMachine.ts`) — only updates `lastResearchedAt`/
                                     `nextEligibleResearchAt` and enqueues a fresh `ANALYZE` item
                                     (ADR-0021 part 4).
    refreshEvidenceHandler.test.ts
  worker.ts                       The autonomous scheduler/worker loop (Phase 11, spec §50-51) —
                                   see the dedicated section below for the full breakdown
                                   (`recoverStuckWorkItems`, `ensureDiscoveryWork`,
                                   `runWorkerCycle`, `runWorker`, `main()`). The process entry
                                   point for `npm run worker`.
  worker.test.ts
  app/                             The Next.js App Router dashboard (Phase 12) — see the
                                   dedicated section below for the full breakdown. Server
                                   components + `"use server"` actions; all logic they call lives
                                   in `src/lib/dashboardQueries.ts`/`dashboardActions.ts`/
                                   `activity.ts` above.
    layout.tsx                     Root layout: nav bar, `globals.css` import.
    page.tsx                       Dashboard home: summary metrics, autonomous mode toggle,
                                   activity feed.
    globals.css                    Hand-written stylesheet (light/dark via
                                   `prefers-color-scheme`) — no UI framework dependency added.
    format.ts                      Display-only formatting helpers (currency, dates) — not
                                   shared with backend code.
    opportunities/
      page.tsx                     Opportunity list + basic filters/search (spec §73 basics).
      [id]/page.tsx                 Full opportunity card, evidence UX, spec §85 trust panel,
                                    operator-action forms (spec §45-46).
    companies/
      page.tsx                     Company list + search/lifecycle-status filter.
      [id]/page.tsx                 Company detail — lifecycle status, notes, linked
                                    opportunities.
      new/page.tsx                  Manual research entry form (spec §72).
    analytics/
      page.tsx                     Outcome analytics (spec §47, §74, Phase 13) — overall metric
                                    tiles, score-vs-response, five stacked performance-by-dimension
                                    tables. Reads `src/lib/outcomeAnalytics.ts` directly, same
                                    server-component-only pattern as every other dashboard page.
    actions/
      autonomous.ts                 `toggleAutonomousMode` — thin wrapper over
                                    `src/lib/config.ts`.
      opportunities.ts              Thin wrappers over `src/lib/dashboardActions.ts`'s
                                    opportunity/outreach actions.
      companies.ts                  Thin wrapper over `requestManualResearch`, redirects to the
                                    new company's detail page.
scripts/
  spike-research.ts            Phase 0 spike script (see below). Throwaway, not a
                                production agent — no persistence, no Source-row hook.
  campaigns.ts                  Manual campaign CRUD CLI (Phase 3) — create/list/show/enable/
                                 pause/disable/blacklist/priority. `npm run campaigns -- <cmd>`.
  discover.ts                   Runs one real DISCOVER work item against the live `claude` CLI
                                 for a given campaign (Phase 3's manual smoke-test entry point;
                                 no worker loop exists yet). `npm run discover -- --campaign
                                 <id> [--count <n>]`.
  prescreen.ts                   Runs real PRESCREEN work items against the live `claude` CLI
                                 (Phase 4's manual smoke-test entry point). `npm run prescreen --
                                 --company <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING PRESCREEN item.
  research.ts                    Runs real RESEARCH work items against the live `claude` CLI
                                 (Phase 5's manual smoke-test entry point). `npm run research --
                                 --company <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING RESEARCH item.
  analyze.ts                     Runs real ANALYZE work items against the live `claude` CLI
                                 (Phase 6's manual smoke-test entry point). `npm run analyze --
                                 --company <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING ANALYZE item.
  verify.ts                      Runs real VERIFY work items against the live `claude` CLI
                                 (Phase 7's manual smoke-test entry point). `npm run verify --
                                 --opportunity <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING VERIFY item.
  offer.ts                       Runs real BUILD_OFFER work items against the live `claude` CLI
                                 (Phase 8's manual smoke-test entry point). `npm run offer --
                                 --opportunity <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING BUILD_OFFER item. Not yet exercised live this phase — see
                                 ADR-0015 part 5 (no VERIFIED opportunity existed to run it
                                 against; fixture tests cover the acceptance criteria instead).
  contact.ts                     Runs real FIND_CONTACT work items against the live `claude` CLI
                                 (Phase 9's manual smoke-test entry point). `npm run contact --
                                 --opportunity <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING FIND_CONTACT item. Not yet exercised live this phase — see
                                 ADR-0016 part 6 (same blocker as ADR-0015 part 5: no VERIFIED
                                 opportunity has ever existed to carry through to CONTACT_RESEARCH;
                                 fixture tests cover the acceptance criteria instead).
  outreach.ts                    Runs real WRITE_OUTREACH work items against the live `claude` CLI
                                 (Phase 10's manual smoke-test entry point). `npm run outreach --
                                 --opportunity <id>` for one, or `--all [--limit <n>]` for every
                                 PENDING WRITE_OUTREACH item; prints the generated subject/body.
                                 Not yet exercised live this phase — see ADR-0017 part 7 (same
                                 blocker as ADR-0015/0016: no opportunity has ever reached
                                 OUTREACH_READY; fixture tests cover the acceptance criteria
                                 instead).
  autonomous.ts                  Toggles/reads `system_config`'s autonomous-mode flag (Phase 11,
                                 spec §71). `npm run autonomous -- --status | --enable |
                                 --disable`.
  refreshEvidence.ts             Runs real `REFRESH_EVIDENCE` items (Phase 14, spec §60) via
                                 `refreshEvidenceHandler.ts` — `--company <id>` or `--all
                                 [--limit <n>]`, same shape as `research.ts`.
  exclusions.ts                  Exclusion-rule CLI (Phase 14, spec §61): `add`/`list`/`remove`
                                 over `exclusion_rules`, plus `exclude-company`/`do-not-contact`
                                 wrapping `dashboardActions.ts`'s operator actions.
  backup.ts                      `create [--out <path>]` / `restore <path> [--target <dbPath>]`
                                 over `src/lib/backup.ts` (Phase 14, spec §80).
  export.ts                      `--format json|csv [--out <path>]` over `src/lib/exportData.ts`
                                 (Phase 14, spec §79) — JSON writes one combined file; CSV writes
                                 one file per entity into a directory.
  seed.ts                        Seed/test mode (Phase 14, spec §99): `add --urls <a,b,c>` (or
                                 `--file <path>`) inserts companies at `PRESCREEN_PENDING` via
                                 `src/lib/seedCompanies.ts`; `run` additionally drives each one
                                 through PRESCREEN -> RESEARCH -> ANALYZE -> VERIFY -> BUILD_OFFER
                                 in-process by calling each stage's real handler directly
                                 (`--stop-after <STAGE>` to stop earlier), printing a trail and
                                 stopping a given company early on DISCARD/exclusion/gate
                                 failure/task failure.
  seedE2eFixture.ts              Seeds a deterministic full-pipeline fixture (company through an
                                 `OUTREACH_READY` opportunity with a `DRAFT` outreach draft) into
                                 `AOH_DB_PATH` via direct Drizzle inserts (Phase 12) — never
                                 invokes the real `claude` CLI. Used exclusively by
                                 `playwright.config.ts`'s `webServer`, not a production script.
  hooks/
    captureSourceHook.ts          The ADR-0004 `PostToolUse` hook subprocess entry point (Phase
                                  5) — spawned directly by the `claude` CLI (via `--settings`,
                                  see `src/agents/sourceCaptureHook.ts`), not by this app's own
                                  Node process. Exports a testable `runCaptureSourceHook(...)`
                                  core; `main()` is a thin stdin/env/real-DB shell around it.
    captureSourceHook.test.ts
  db/
    migrate.ts                  `npm run db:migrate` — applies pending migrations to
                                 `AOH_DB_PATH` (default `./data/aoh.db`).
drizzle/
  0000_*.sql, meta/             Generated migration history (`npm run db:generate`).
  0001_naive_mathemanic.sql     Phase 6: adds `opportunities.existing_alternatives` /
                                 `validation_question`. Committed — this is real schema history,
                                 not build output.
  0002_marvelous_celestials.sql Phase 12: adds `opportunities.operator_verdict`.
launchd/
  com.aiopportunityhunter.worker.plist.example  Example macOS launchd job for `src/worker.ts`
                                 (Phase 11, spec §11's "run while the laptop is awake"
                                 convenience) — placeholder absolute paths, not auto-installed
                                 (ADR-0018 part 10). Copy, edit, and `launchctl load` manually.
e2e/
  dashboard.spec.ts              Playwright smoke tests (Phase 12) — 7 scenarios run serially
                                 against one seeded fixture DB (`playwright.config.ts`'s
                                 `webServer` re-seeds a fresh file per run via
                                 `scripts/seedE2eFixture.ts`): summary metrics + autonomous-mode
                                 toggle, opportunity list navigation, the full evidence trail +
                                 trust panel, Approve, Reject-with-reason, Draft Reviewed → Sent
                                 Manually → outcome recording, and manual company entry.
docs/
  phases/
    phase-0-foundations.md     Phase 0 completion doc.
    phase-1-data-layer.md      Phase 1 completion doc.
    phase-2-work-queue.md      Phase 2 completion doc.
    phase-3-discovery-agent.md Phase 3 completion doc.
    phase-4-prescreening-agent.md Phase 4 completion doc.
    phase-5-deep-research-agent.md Phase 5 completion doc.
    phase-6-opportunity-analysis-agent.md Phase 6 completion doc.
    phase-7-skeptic-verification-agent.md Phase 7 completion doc.
    phase-8-offer-builder.md   Phase 8 completion doc.
    phase-9-contact-research-agent.md Phase 9 completion doc.
    phase-10-outreach-writer.md Phase 10 completion doc.
    phase-11-autonomous-worker.md Phase 11 completion doc.
    phase-12-dashboard-mvp.md  Phase 12 completion doc.
    phase-13-feedback-loop-analytics.md Phase 13 completion doc.
```

`src/app` now holds the Phase 12 dashboard plus Phase 13's `/analytics` page (see the dedicated
sections below). Phase 10's Outreach Writer remains the last *agent* in the core pipeline —
Phases 12-13 built dashboard UI and read-side analytics, not new agents, and Phase 14 (operational
hardening) doesn't add one either.
Phase 2's `src/pipeline/` modules besides
`campaignSelection.ts`/`discoverHandler.ts`/`prescreenHandler.ts`/`researchHandler.ts`/
`analyzeHandler.ts`/`verifyHandler.ts`/`offerHandler.ts`/`contactHandler.ts`/`outreachHandler.ts`
are still deterministic primitives only (pure functions over plain objects/arrays) — as of
Phase 11, `crashRecovery.ts` and `priority.ts` are now also wired to live `work_items` reads/
writes, via `src/worker.ts` (see the dedicated section below), which also now runs
`campaignSelection.ts` autonomously instead of the operator picking a campaign by id via
`scripts/discover.ts`.

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
  - `--settings <json>` when the caller passes `settings` (Phase 5, ADR-0012 part 1) — used by
    the Deep Research Agent to register the ADR-0004 `PostToolUse` source-capture hook. Omitted
    entirely for every other agent (no call site needs it yet).
  - an explicit `env` built by `buildSanitizedEnv()` merged with any caller-supplied `extraEnv`
    (Phase 5 — context a `--settings`-registered hook subprocess needs, since it can't share
    in-memory state with this process), which clones `process.env` and deletes
    `ANTHROPIC_API_KEY` — never inherited, regardless of what the parent shell or `extraEnv` has
    set (stripped a second time after merging `extraEnv`, defensively).
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

Not yet built (later phases' responsibility): `work_items`/`prompt_versions` logging (the DB now
exists as of Phase 1, but nothing wires `claudeClient` to it yet).

## `src/db/` (Phase 1)

- `schema.ts` — all 14 tables from `docs/DATABASE_SCHEMA.md` as Drizzle `sqliteTable`
  definitions. IDs are `crypto.randomUUID()` (no extra cuid dependency). Enums use Drizzle's
  `text(col, { enum: [...] })` (TS-level literal union; no DB-level `CHECK`, see ADR-0008 part
  3). JSON-shaped columns (`criteria`, `impactAssumptions`, `dependencies`, `risks`,
  `penalties`, the four `verifier*` arrays, `keyAssumptions`, `system_config.value`) use
  Drizzle's `{ mode: "json" }` text columns with a `$type<T>()` annotation.
- `client.ts` — `createDb(path)` creates the DB file's parent directory if missing (Phase 3
  fix — a fresh checkout's gitignored `./data/` doesn't exist until something creates it),
  opens `better-sqlite3` with `journal_mode = WAL` and `foreign_keys = ON` (SQLite defaults
  foreign keys OFF per-connection; without this pragma the FK references in the schema would
  be silently unenforced), wraps it in `drizzle()`.
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
- `sourceFreshness.ts` (Phase 5) — `computeSourceFreshnessState` per spec §23:
  `UNAVAILABLE` for a missing/non-2xx HTTP status, else `FRESH`/`STALE` by
  `DEFAULT_SOURCE_FRESHNESS_THRESHOLD_MS` (30 days, ADR-0012 part 7). The one live call site
  (the hook, at insert time) only ever exercises `FRESH`/`UNAVAILABLE`; `STALE` is
  unit-tested but unreachable until a later phase recomputes freshness for an existing row.
- `researchFreshness.ts` (Phase 5) — `computeNextEligibleResearchAt` per spec §60:
  adds `DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS` (90 days, ADR-0012 part 7) to `now`. Set on
  `companies.nextEligibleResearchAt` by `researchHandler.ts` after every successful research
  run; consumed by `prescreenHandler.ts`'s freshness short-circuit (ADR-0011 part 3).

## `src/pipeline/` (Phase 2)

All four modules are pure/deterministic — no Claude call, no live DB access. They're the
primitives PLAN.md Phase 3+ agent handlers and Phase 11's `worker.ts` build on, not
orchestration themselves.

- `stateMachine.ts` — per ADR-0008 part 2, the spec §90 chain is split across three
  independently-owned enums, so there are three separate transition tables + validator
  functions here, not one shared one: `transitionCompanyLifecycle`,
  `transitionOpportunityStatus`, `transitionWorkItemStatus`. Each throws
  `InvalidTransitionError` (carrying `chain`/`from`/`to`) rather than silently accepting an
  invalid move. `EXCLUDED` is handled as a cross-cutting special case in
  `transitionCompanyLifecycle` (reachable from any other company status, since spec §61
  exclusion is an operator action, not a pipeline stage) rather than repeated in every row of
  `COMPANY_LIFECYCLE_TRANSITIONS` — see ADR-0009 part 3.
- `priority.ts` — `TASK_TYPE_PRIORITY` (spec §49's ordering, plus `ANALYZE`/`REFRESH_EVIDENCE`
  placed per ADR-0009 part 1) and `selectNextWorkItem(items, now)`: filters to
  `PENDING`/`RETRYABLE`/`DEFERRED` items whose `runAfter` has passed (`isEligibleNow`), then
  picks the highest-priority one, breaking ties by `createdAt` ascending (oldest first). Generic
  over any object shape satisfying `QueueableWorkItem`, so it works against plain fixtures now
  and real Drizzle rows later without change.
- `failureClassification.ts` — `classifyFailure({errorMessage, attempts, maxAttempts})` (spec
  §66): defaults to `RETRYABLE` (most listed failure causes are transient), pattern-matches a
  short list of genuinely permanent causes (401/403/404, "invalid state transition") to
  `NON_RETRYABLE`, and treats an item that has exhausted `maxAttempts` (default 3) as
  `NON_RETRYABLE` regardless of cause. `computeRetryBackoffMs(attempts)` is exponential from 1
  minute, capped at 1 hour — deliberately a different, shorter schedule than Phase 11's
  quota-exhaustion backoff (PLAN.md §12), see ADR-0009 part 4. `resolveFailureOutcome` combines
  both into a `{status, runAfter}` work-item update, routed through
  `stateMachine.transitionWorkItemStatus` so an invalid outcome can't be produced silently.
- `crashRecovery.ts` — spec §67: `findStuckRunningItems(items, now, timeoutMs)` is a pure
  filter (`RUNNING` + `startedAt` older than `DEFAULT_STUCK_RUNNING_TIMEOUT_MS` = 30 min, see
  ADR-0009 part 5; a `RUNNING` item with no `startedAt` is left alone rather than guessed at).
  `planStuckWorkItemRecovery` maps those to `{id, nextStatus: "RETRYABLE"}` via the validated
  state-machine transition. As of Phase 11, `src/worker.ts`'s `recoverStuckWorkItems` runs this
  once at startup against real `work_items` rows (see below).

## `src/worker.ts` (Phase 11, extended Phase 14)

The autonomous scheduler/worker loop (spec §50-51) — the first phase to wire `priority.ts` and
`crashRecovery.ts` to a live DB and to run every Phase 3-10 handler continuously rather than one
at a time via a `scripts/*.ts` CLI invocation. See ADR-0018 for the judgment calls behind this
design (Phase 11) and ADR-0021 for Phase 14's additions below.

- `recoverStuckWorkItems(db, now, timeoutMs)` — runs once at worker startup: queries all
  `RUNNING` work items, applies `crashRecovery.ts`'s pure `planStuckWorkItemRecovery`, and writes
  each recovered item to `RETRYABLE`.
- `ensureDiscoveryWork(db, now)` — called at the top of every cycle (skipped while paused): if no
  `DISCOVER` item is in a non-terminal status (`PENDING`/`RUNNING`/`RETRYABLE`/`DEFERRED`), picks
  the next `ENABLED` campaign via `campaignSelection.selectNextCampaign` (persisting its
  round-robin weights in `system_config` via `src/lib/config.ts`) and enqueues one `DISCOVER`
  item. Discovery is the only task type nothing upstream ever creates automatically — every other
  type is enqueued by the handler that finishes the stage before it — so without this the queue
  would run dry once the operator's manual `scripts/discover.ts` runs finished (ADR-0018 part 6).
- `runWorkerCycle(options)` — one unit of work, no sleeping, no looping: checks
  `getAutonomousMode` (returns `{kind: "paused"}` if off), calls `ensureDiscoveryWork`, selects
  the single highest-priority eligible item via `priority.selectNextWorkItem` over every row in
  `work_items`, transitions it to `RUNNING`, and dispatches it through `TASK_HANDLERS` (a
  `Record<TaskType, TaskHandler>` mapping each task type to its real Phase 3-10 handler function,
  overridable per-call via a `handlers` option for tests). The dispatch call is wrapped in
  try/catch — a thrown error (e.g. a handler's own referential-integrity guard) is routed through
  `failureClassification.resolveFailureOutcome` instead of propagating, the first real
  implementation of spec §66/PLAN.md §8's "each task handler is wrapped so one failure never
  takes down the loop" (ADR-0018 part 3). Returns a discriminated `{kind: "paused" | "idle" |
  "ran", ...}` result; a `"ran"` result's `quotaExhausted` flag is derived from
  `workItemStatus === "DEFERRED"`, reusing every handler's existing quota-exhaustion convention
  rather than adding a new field (ADR-0018 part 1).
- `runWorker(options)` — the actual `while` loop: recovers crashed work once, then repeatedly
  calls `runWorkerCycle` and decides how long to wait before the next call — immediately again
  after real work, the idle poll interval (`DEFAULT_IDLE_POLL_INTERVAL_MS` = 60s) when paused or
  idle (this is also what makes a `system_config` pause/resume toggle take effect within one
  cycle, spec §71), or an exponential backoff (`DEFAULT_QUOTA_BACKOFF_BASE_MS` = 30 min, doubling
  per *consecutive* quota-exhausted cycle, capped at `DEFAULT_QUOTA_BACKOFF_MAX_MS` = 4h,
  ADR-0018 part 2) after a quota-exhausted cycle. Accepts an injectable `sleep` function and
  `maxCycles` bound for tests, and an `AbortSignal` for graceful shutdown between cycles (never
  mid-handler) in real usage.
- `main()` — the `npm run worker` process entry point: opens the real DB (`AOH_DB_PATH`, default
  `./data/aoh.db`), wires `SIGINT`/`SIGTERM` to an `AbortController`, and logs each cycle's
  outcome to stdout.
- `TaskHandler`'s type signature takes a fourth `dbPath: string` parameter that only `RESEARCH`'s
  wrapper uses (`researchHandler.ts`'s `RunResearchTaskOptions.dbPath`, needed by the ADR-0004
  hook subprocess) — every other handler's closure simply ignores it, which TypeScript's
  structural function typing permits (ADR-0018 part 7).
- `TASK_HANDLERS`'s `VERIFY` and `RESEARCH`/`REFRESH_EVIDENCE` entries now read live
  `system_config` values every cycle (`getOpportunityGateConfig(db)`, `getReResearchWindowMs(db)`)
  before calling their handler, rather than always falling through to each module's code-constant
  default — Phase 14, ADR-0021 part 5.
- `REFRESH_EVIDENCE`'s `TASK_HANDLERS` entry is now the real `refreshEvidenceHandler.ts` (Phase
  14, spec §60) instead of the Phase 11-13 deterministic-failure stub. `ensureRefreshEvidenceWork(db,
  now, batchSize)` — called every cycle alongside `ensureDiscoveryWork` — is the new per-cycle
  top-up: scans `RESEARCHED`/`NO_OPPORTUNITY` companies whose `nextEligibleResearchAt` has passed
  and that don't already have a `REFRESH_EVIDENCE` item in flight, enqueueing up to
  `DEFAULT_REFRESH_EVIDENCE_BATCH_SIZE` (3) per cycle — capped, unlike `ensureDiscoveryWork`'s
  "at most one ever," since several companies can become eligible at once (ADR-0021 part 4).

## The dashboard (`src/app`, Phase 12)

The operator's first UI (spec §42-46, §69, §71-73, §85; PLAN.md §14/ADR-0003) — a Next.js App
Router app, one entry point into the same codebase as `src/worker.ts`, not a separate service.
Server components read `src/lib/dashboardQueries.ts` directly; server actions (`"use server"`
files under `src/app/actions/`) call `src/lib/dashboardActions.ts` directly. No REST/tRPC layer,
no client-side data fetching — every page in this phase renders with zero client JavaScript,
using plain `<form action={serverActionFunction}>` submissions (Next resolves the function
reference to a POST under the hood) for every mutation, including the filter forms (`method="get"`,
so filters are just query params a server component reads).

- `getDb()` (`src/lib/appDb.ts`) is a `globalThis`-cached singleton so Next's dev-mode hot reloads
  don't open a new `better-sqlite3` connection on every edit. `AOH_DB_PATH` (default
  `./data/aoh.db`) is the same env var every other entry point already uses.
- Pages: `/` (summary metrics, autonomous toggle, activity feed), `/opportunities` (list +
  filters), `/opportunities/[id]` (full card, evidence UX, trust panel, every operator action),
  `/companies` (list + search), `/companies/[id]` (detail — DO_NOT_CONTACT toggle and "Exclude
  company" button since Phase 14, spec §61/§65), `/companies/new` (spec §72's entry form),
  `/analytics` (Phase 13's outcome analytics — see the dedicated bullet below), `/settings` (Phase
  14, spec §70/§61/§79-80 — exclusion-rule management, the spec §32 gate config, the re-research
  window, one-click backup, JSON/CSV export links; see the dedicated bullet below). Every
  list/detail page sets `export const dynamic = "force-dynamic"` — this is a single-operator app
  reading live pipeline state, and there is no reason for Next to ever serve a stale cached render
  of it.
- Spec §85's six trust labels (WHY CLAUDE LIKES THIS / WHY THE SKEPTIC MIGHT REJECT IT / WHAT WE
  KNOW / WHAT WE INFER / WHAT WE DON'T KNOW / WHAT TO VERIFY) are populated from fields that
  already existed on `opportunities`/`opportunity_evaluations` — no agent was re-prompted for
  new "trust" text this phase. See ADR-0019 part 6 for the exact field-to-label mapping.
- `opportunities.operatorVerdict` (`PENDING | APPROVED | REJECTED`, new this phase) is the
  operator's own Approve/Reject verdict (spec §45), independent of the pipeline's own `status`
  (`VERIFIED`/`VERIFIER_REJECTED` reflect what the Skeptical Verification Agent decided). See
  ADR-0019 part 3.
- `markSentManually` (`src/lib/dashboardActions.ts`) is the only code path that writes
  `opportunities.status: "SENT"` — the real `OUTREACH_READY -> SENT` transition (spec §41/§90)
  this project has been building toward since Phase 10 deliberately left it un-automated. It also
  records the `SENT` `outreach_outcomes` event in the same call, so the two can't disagree.
  `recordOutreachOutcome`'s event type excludes `"SENT"` at the type level to keep this split
  enforced (ADR-0019 part 7).
- The spec §69 activity feed (`src/lib/activity.ts`'s `getRecentActivity`) is derived from
  `work_items` at read time — no new event-log table (ADR-0019 part 4). It reports each stage's
  *current* entity state, not a historical snapshot; see that ADR for when this assumption would
  need revisiting.
- `requestManualResearch` (spec §72) skips discovery/pre-screening entirely for a manually-named
  company — it inserts the company straight at `RESEARCH_PENDING` and enqueues a `RESEARCH` work
  item directly, the same "insert at the right lifecycle stage" pattern `discoverHandler.ts` uses
  for `PRESCREEN_PENDING`. For a domain that already exists past `RESEARCH_PENDING`, it reports
  the company's current state instead of re-enqueueing (which would fail on an invalid lifecycle
  transition) — see ADR-0019 part 5.
- Build/dev tooling: `next dev`/`next build` are both pinned to `--webpack` (`package.json`), not
  Turbopack (the Next 16 default) — only webpack honors the `experimental.extensionAlias`
  (`next.config.ts`) this project needs so Next's bundler can resolve the backend's
  NodeNext-style `.js`-suffixed relative imports (e.g. `from "../db/schema.js"`) to their `.ts`
  sources. `tsconfig.json` (Next-owned, auto-edited by Next on every run) covers `src/app`;
  `tsconfig.backend.json` (the pre-Phase-12 `tsconfig.json`, renamed) covers everything else. See
  ADR-0019 part 1 for the full reasoning and what would let this be simplified later.
- Playwright (`playwright.config.ts`, `e2e/dashboard.spec.ts`, `npm run test:e2e`): 9 scenarios
  run serially (`test.describe.serial`) against one real `next dev --webpack` server and a fresh
  fixture DB seeded by `scripts/seedE2eFixture.ts` (direct Drizzle inserts, never the real
  `claude` CLI — ADR-0019 part 9). Covers every PLAN.md Phase 12 acceptance-criterion scenario:
  viewing the full evidence trail, approve/reject with a reason, marking sent, toggling
  autonomous mode, and manual company entry queuing a real (fixture-seeded) pipeline run, plus
  (Phase 14) DO_NOT_CONTACT/exclude-company on the company page and exclusion-rule/gate-config
  management on `/settings`.
- `/settings` (Phase 14, spec §70): exclusion-rule add/remove (`src/lib/exclusions.ts`), the spec
  §32 gate's threshold/floor/high-risk toggle and the spec §60 re-research window in days (both
  `src/lib/config.ts`, converted to/from ms at the form boundary), a "Create backup now" button
  (`src/lib/backup.ts`, writes to `./data/backups/`), and download links for `/api/export`
  (`src/app/api/export/route.ts` — `?format=json` for the full bundle, `?format=csv&entity=<name>`
  per entity, since CSV can't cleanly hold five differently-shaped tables in one file). Same
  zero-client-JS plain-form pattern as every other page; new actions live in
  `src/app/actions/settings.ts`. Company-level exclude/DO_NOT_CONTACT actions live on
  `/companies/[id]` instead (`src/app/actions/companies.ts`'s `excludeCompanyAction`/
  `setCompanyDoNotContactAction`) — spec §61/§65 act on one company, not global config (ADR-0021
  part 9).
- `/analytics` (Phase 13, spec §47/§74): reads `src/lib/outcomeAnalytics.ts` directly (same
  zero-client-JS server-component pattern as every other page). Overall metric tiles (sent count,
  four rates, average opportunity score), a score-vs-response comparison, and five stacked
  "performance by X" tables (industry/country/problem category/campaign/price band) — each rate
  cell renders a "low sample" badge (reusing the existing `.badge--warn` style) whenever that
  cell's `reliable` flag is false, rather than presenting a tiny-sample percentage as trustworthy.
  Not covered by the Playwright suite (Phase 13 added no new e2e scenarios — its acceptance
  criteria only call for unit tests on the aggregate calculations); verified manually this phase
  against a seeded temporary fixture DB instead. See ADR-0020.

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

## Claude CLI hook findings (Phase 5)

Confirmed against Claude Code's hooks reference and empirically in this phase's live smoke test
(see ADR-0012):

- A `PostToolUse` hook fires *after* the tool call already completed — it cannot block, retry,
  or alter the underlying `WebFetch`/`WebSearch` call itself, only annotate/replace what Claude
  sees about it afterward (which this app doesn't use). Its only real use here is the side
  effect: writing a `sources` row.
- Hooks registered via `--settings <json>` (as opposed to a project `.claude/settings.json`) do
  fire in `-p`/headless mode, including the "exec form" (`command` + `args`, no shell) used here.
- `WebFetch`'s `tool_response` is the *small model's extracted answer* to the fetch's own
  prompt, not the raw page — there is no `title` field anywhere in it. The hook therefore never
  populates `sources.title`; it's left null (schema already allows this).
- A cross-host redirect produces **two** separate `PostToolUse` events (one for the original
  URL, one for the followed URL) rather than one — confirmed both in the docs and in this
  phase's live run. The hook records both as independent `sources` rows; this is intentional
  (each represents a real fetch), not a bug.
- `WebSearch`'s `tool_response` contains only result titles/URLs, never fetched page content —
  confirmed both in the docs and by inspecting real `WebSearch` calls in this phase's live run.
  This is why the hook matcher is `"WebFetch"` only (ADR-0012 part 1).

## Known limitations

- `scripts/spike-research.ts` is intentionally throwaway: no persistence, no retry, draft
  schema only, and now superseded by `src/agents/deepResearchAgent.ts`'s real contract. Do not
  import it from real agent code.
- `src/pipeline/stateMachine.ts`, `priority.ts`, `failureClassification.ts`, and
  `crashRecovery.ts` are still pure primitives with no live-DB wiring of their own beyond what
  `discoverHandler.ts` (`DISCOVER`), `prescreenHandler.ts` (`PRESCREEN`),
  `researchHandler.ts` (`RESEARCH`), and `analyzeHandler.ts` (`ANALYZE`) call directly. Phase 7
  onward wires the rest incrementally; Phase 11's `worker.ts` is what runs `crashRecovery` at
  startup and drives the main loop instead of the operator invoking `scripts/discover.ts`/
  `scripts/prescreen.ts`/`scripts/research.ts`/`scripts/analyze.ts` by hand.
- `FIND_CONTACT` work items now exist in the live DB (created by `offerHandler.ts` on every
  successful offer) but nothing consumes them yet — Phase 9's Contact Research Agent is the first
  handler that will pick them up.
- `src/pipeline/failureClassification.ts`'s pattern lists (transient vs. permanent error text)
  are a reasoned starting point, not exhaustive — Phase 3's live discovery runs didn't exercise
  the failure path (both real runs succeeded), so these patterns are still unvalidated against
  real Discovery Agent failure text; expect to extend them once Phase 4+ produce real failures.
- `updatedAt` columns are set at insert time only in most tables; Phase 3's `discoverHandler.ts`
  is the first code path to actually update rows post-insert (`companies.lifecycleStatus`/
  `lastDiscoveredAt`, `work_items.status`), and it does set `updatedAt` explicitly on every
  update, per DATABASE_SCHEMA.md's "Conventions." Later phases adding new update paths must do
  the same.
- Opportunity scoring (`src/lib/scoring.ts`) is now wired to real `opportunity_evaluations` rows
  (Phase 6, `src/pipeline/analyzeHandler.ts`) — the ten component values and penalty reasons come
  from the Opportunity Analysis Agent's judgment, but the raw/adjusted arithmetic is always
  `scoring.ts`'s, never Claude's (ADR-0013 part 1).
- As of Phase 11, `src/worker.ts` runs `campaignSelection.selectNextCampaign` autonomously via
  `ensureDiscoveryWork`, with its round-robin state persisted in `system_config` (a new
  `src/lib/config.ts`, ADR-0018 part 4) — an operator can still run `scripts/discover.ts
  --campaign <id>` manually for a one-off campaign, but the worker no longer needs that.
- `system_config` now has four keys written by any code path (`autonomousMode`,
  `campaignSelectionState` from Phase 11; `opportunityGateConfig`, `reResearchWindowMs` added
  Phase 14, both via `src/lib/config.ts`) — every other key DATABASE_SCHEMA.md eventually wants
  (discovery volume, pricing bands, country/industry allowlists specifically as a `system_config`
  key, research depth, min confidence, max simultaneous work, daily limits) remains unwritten,
  same as before (ADR-0010 part 8, ADR-0018 part 4, now also ADR-0021 part 5). `prompt_versions`
  is still not written to by any code path (ADR-0010 part 9).
- `companies.notes` is now used for several purposes: genuine operator notes, a seeded
  `"Discovery reason: ..."` string (Phase 3, ADR-0010 part 7), a `"Prescreen (...): ..."` line
  (Phase 4, ADR-0011 part 4), a `"Research: N evidence item(s) recorded..."` summary plus a
  `"Research candidate problems: ..."` line (Phase 5, ADR-0012 part 6), and now (Phase 6) an
  `"Analysis: opportunity \"...\" formed..."` line — none have a dedicated schema column. Revisit
  if a later phase (e.g. the Phase 12 dashboard) needs these distinguished as structured fields
  rather than one free-text audit trail.
- Spec §59 (recognizing that two differently-worded opportunities for the same company represent
  the same underlying problem) is still not implemented — out of scope for Phase 6 (ADR-0013 part
  7). Now that `REFRESH_EVIDENCE` (Phase 14) really does re-run `ANALYZE` for an already-researched
  company, a second `ANALYZE` pass can genuinely form a second, differently-worded opportunity row
  for the same underlying problem with no dedupe check between them — spec §59 remains an open
  follow-up, now with a real path that can trigger it (previously only a hypothetical one).
- `companies.lifecycleStatus`'s `RESEARCHED -> NO_OPPORTUNITY` transition (built Phase 1/2) is
  still never exercised by any real code path — Phase 6 always forms an opportunity regardless of
  score and leaves rejection to Phase 7's gate (ADR-0013 part 2). Whether anything should ever
  drive a company to `NO_OPPORTUNITY` is an open question for a later phase (e.g. an
  operator-manual dashboard action).
- The evidence-provenance cross-check (ADR-0012 part 3: an evidence item's `sourceUrl` must
  match a hook-recorded `sources` row for that task) was exercised for real in this phase's live
  8-company smoke test, not just in fixtures: 1 of 23 evidence items for one company ("Animal
  Hospital Southwest") was dropped because its cited `sourceUrl` didn't match any page the hook
  recorded as fetched — the exact scenario ADR-0004 exists to guard against, caught live.
- `sources.title` is always null (Phase 5) — `WebFetch`'s `tool_response` never includes a page
  title (see "Claude CLI hook findings" above), only its extracted-answer text. Getting a real
  title would need a separate fetch mechanism (e.g. `curl` via Bash); not pursued this phase.
- `src/lib/riskCategory.ts` (Phase 7) is a keyword/phrase heuristic, not real NLP — it will miss
  high-risk phrasing it has no pattern for, and (by design, per ADR-0014 part 4) errs toward
  over-flagging borderline cases like an intake form's "medical records requests" category rather
  than under-flagging. Its patterns were already extended once, mid-phase, after a live smoke
  test caught a real false positive ("technical SEO diagnostic" flagged as medical diagnosis) —
  expect more patterns to be needed as real opportunities are classified against it.
- `DEFAULT_OPPORTUNITY_GATE_CONFIG`'s three constants (`scoreThreshold: 75`,
  `evidenceStrengthFloor: 10`, `allowHighRisk: false`) are still reasoned starting points, not
  empirically tuned (ADR-0014 part 5) — but as of Phase 14 an operator *can* change them, live,
  from `/settings` (`getOpportunityGateConfig`/`setOpportunityGateConfig`,
  `worker.ts`'s `TASK_HANDLERS.VERIFY` reads the live value every cycle).
- An operator wanting to let a specific `HIGH_RISK` opportunity through (spec §8's "unless
  explicitly reviewed by the operator") can now flip `allowHighRisk` from `/settings` (Phase 14),
  but it's still global, not per-opportunity — a later phase should add a real per-opportunity
  override path if a global toggle proves too blunt in practice.
- `DEFAULT_PRICE_BANDS`' duration cutoffs (Phase 8, `src/lib/pricing.ts`) and
  `MIN_SCOPE_WORD_COUNT` (`src/lib/offerLint.ts`) are reasoned starting points, not empirically
  tuned — same category as every earlier phase's placeholder constants (ADR-0008/0009/0012/0014).
  No live offer has been generated yet to validate them against (see below).
- Phase 8's `scripts/offer.ts` has not been run against a real `VERIFIED` opportunity — Phase 7's
  live smoke test left all 8 real veterinary-clinic opportunities `VERIFIER_REJECTED` (none
  passed the gate), so there was nothing live to build an offer for. The next phase (or the
  operator, ad hoc) that gets a fresh company through the pipeline to a real `VERIFIED`
  opportunity should run `npm run offer -- --opportunity <id>` at least once and spot-check the
  result, per this project's general "verify live behavior once real data exists" pattern.
- `companies.notes` now carries a seventh kind of content (Phase 8's `"Offer: ..."` line, which
  can itself embed a price-band-deviation justification in brackets) — same open item flagged
  since ADR-0010 part 7.
- Phase 9's `scripts/contact.ts` has not been run against the real `claude` CLI either — same
  blocker as Phase 8 (ADR-0016 part 6): no opportunity has ever reached `VERIFIED`/`OFFER_READY`/
  `CONTACT_RESEARCH` in the live DB, so there is nothing real to find a contact for yet. Whichever
  session first carries a fresh company all the way through the pipeline should run
  `npm run contact -- --opportunity <id>` and spot-check the result (is the contact genuinely
  plausible, is the email-confidence label honest) before trusting this phase's prompt design.
- `companies.notes` now carries an eighth kind of content (Phase 9's `"Contact: ..."` line) — same
  open item flagged since ADR-0010 part 7.
- `src/lib/contactDisplay.ts`'s `getContactDisplay` has no live caller yet beyond its own tests —
  `contactHandler.ts` uses the pure `toContactDisplay` directly on the row it just inserted, since
  it already has that row in hand. `outreachHandler.ts` (Phase 10) also uses `toContactDisplay`
  directly on a freshly-queried row rather than `getContactDisplay`, same reasoning; the DB-read
  form remains forward-looking for the Phase 12 dashboard.
- `companies.notes` now carries a ninth kind of content (Phase 10's `"Outreach: ..."` line) — same
  open item flagged since ADR-0010 part 7.
- Phase 10's `scripts/outreach.ts` has not been run against the real `claude` CLI — same blocker
  as Phase 8/9 (ADR-0017 part 7): no opportunity has ever reached `OUTREACH_READY` in the live DB.
  Whichever session first carries a fresh company all the way through the pipeline should run
  `npm run outreach -- --opportunity <id>` and read the draft against spec §87's stated qualities
  (specific, truthful, short, human, low pressure, problem-focused, not AI-hype) before trusting
  this phase's prompt/lint design.
- `src/lib/outreachLint.ts`'s truthfulness heuristic (Phase 10) is a keyword/sentence-pattern
  approximation, not real claim-to-evidence tracing (ADR-0017 part 3) — same category as
  `riskCategory.ts` (ADR-0014 part 4): it will miss confident phrasing it has no pattern for, and
  only checks "does any FACT exist at all," not "does a FACT support *this* sentence." Expect to
  extend its pattern lists once real drafts are checked against it.
- `outreachHandler.ts` (Phase 10) is the first handler that does not transition
  `opportunities.status` or enqueue a further work item on success (ADR-0017 part 5) — this is
  intentional (sending is a manual operator action) — Phase 12's `markSentManually`/
  `recordOutreachOutcome` (`src/lib/dashboardActions.ts`) are what actually drive
  `OUTREACH_READY -> SENT` and `outreach_outcomes` recording, and Phase 13's
  `src/lib/outcomeAnalytics.ts` is what reads that history back out as rates/averages.
- `contacts` has no `opportunityId` column, so `outreachHandler.ts` looks up "the most recent
  contact row for this opportunity's company" by `createdAt desc` rather than a direct join
  (ADR-0017 part 6) — correct today because Phase 9 inserts exactly one contact immediately
  before enqueueing the `WRITE_OUTREACH` item that leads here, but would need a real FK if a
  future phase ever lets a company accumulate multiple concurrent in-flight opportunities each
  with their own contact.
- No live multi-hour autonomous `npm run worker` run (with autonomous mode actually enabled) has
  been performed yet against real campaigns/companies (ADR-0018 part 9) — only a zero-cost,
  autonomous-mode-off smoke test confirming the process starts/logs/shuts down cleanly. The
  operator should run one deliberately and inspect `work_items`/`companies.notes`/the worker's
  log output afterward before fully trusting the scheduling/quota-backoff design at real usage
  volumes — same category of deferred live verification as Phases 8-10's offer/contact/outreach
  smoke tests.
- `ensureDiscoveryWork` (Phase 11) caps in-flight `DISCOVER` items at one regardless of how many
  campaigns are `ENABLED` (ADR-0018 part 6) — a reasoned starting point, not empirically tuned;
  revisit if real usage shows the queue idling for meaningful stretches on a single slow/
  quota-deferred `DISCOVER` item while other campaigns sit ready to run.
- The worker's quota-exhaustion backoff constants (`DEFAULT_QUOTA_BACKOFF_BASE_MS` = 30 min,
  `DEFAULT_QUOTA_BACKOFF_MAX_MS` = 4h, Phase 11) are a reasoned starting point, not tuned against
  real Claude usage-limit reset timing — same category as every earlier phase's placeholder
  constants (ADR-0008/0009/0012/0014/0015).
- `launchd/com.aiopportunityhunter.worker.plist.example` (Phase 11) has not been installed and
  run end-to-end as a real `launchctl` job in this phase (ADR-0018 part 10) — only `npm run
  worker` directly has been verified live. The operator should test the actual `launchctl load`
  path with their own filled-in paths before relying on it.
- Phase 14 gave `/settings` a dashboard control for spec §32's gate config (including
  `allowHighRisk`, still global not per-opportunity) and the re-research window, but
  `system_config`'s remaining general key set (pricing bands, country/industry allowlists as a
  `system_config` key specifically, discovery volume, research depth, min confidence, max
  simultaneous work, daily limits) still has no dashboard control or wiring — ADR-0021 part 5's
  deliberate scope call, not an oversight.
- Dashboard filtering (Phase 12) covers only spec §73's basics (status/verifier-result/min-score/
  industry/country/search for opportunities; lifecycle-status/search for companies) via plain GET
  query params — no date-range/campaign/reply-status filters, saved filters, or client-side
  auto-submit polish yet (ADR-0019 part 8).
- No real end-to-end dashboard walkthrough against live pipeline data has been performed —
  Phases 7-10's live smoke tests left every real opportunity `VERIFIER_REJECTED`, so there has
  never been a real `VERIFIED`/`OUTREACH_READY` opportunity to view in this dashboard. PLAN.md's
  own Phase 12 acceptance criterion asking for exactly this walkthrough is deferred until a real
  opportunity clears verification; the Playwright suite's seeded fixture is what was actually
  exercised this phase.
- `next dev`/`next build` are pinned to `--webpack` (Phase 12, ADR-0019 part 1) because only
  webpack currently honors the `experimental.extensionAlias` config this project's shared
  NodeNext-style `.js`-suffixed imports need — revisit if a future Next release adds equivalent
  Turbopack support (Turbopack is the Next 16 default otherwise).
- No real outreach outcome data exists yet for `/analytics` (Phase 13) to summarize — same
  `VERIFIER_REJECTED` blocker as Phases 8-10's deferred live smoke tests. It has only been
  exercised against a seeded temporary fixture DB (see
  [phase-13-feedback-loop-analytics.md](phases/phase-13-feedback-loop-analytics.md)'s "Testing
  performed"); a real read of it is pending the first real `SENT` outreach draft plus outcome
  events.
- `DEFAULT_MIN_SAMPLE_SIZE = 5` (`src/lib/outcomeAnalytics.ts`, Phase 13, ADR-0020 part 3) is a
  reasoned starting point, not empirically tuned — same category as every earlier phase's
  placeholder constants. No `system_config` wiring lets an operator change it without a code
  change yet.
- Spec §75 (Claude periodically reviewing outcome analytics and recommending discovery-allocation
  changes) and §76 (recurring-pattern detection across companies) remain unimplemented by design —
  explicitly deferred per PLAN.md's "Deferred beyond these phases" list. Phase 13 only produces
  the statistics; nothing consumes them autonomously.
- `restoreDatabase` (Phase 14, spec §80) has no automated safeguard against restoring over a DB
  file the worker/dashboard currently has open — it's a plain file copy, by design (spec §80's
  "this can initially be extremely simple," ADR-0021 part 7). The operator is responsible for
  stopping `npm run worker`/`next dev`/`next start` first; no code enforces this.
- `DEFAULT_REFRESH_EVIDENCE_BATCH_SIZE = 3` (`src/worker.ts`, Phase 14) is a reasoned starting
  point, not empirically tuned — same category as every earlier phase's placeholder constants
  (ADR-0008/0009/0012/0014/0015/0020). No live multi-hour worker run has yet exercised a scenario
  with more than a handful of companies simultaneously past their re-research window, so whether 3
  per cycle is too conservative or too aggressive in practice is still an open question.
  `ensureRefreshEvidenceWork`'s `batchSize` parameter exists for whenever that turns out to matter.
  Wiring this to `system_config` (rather than a code constant) is a natural follow-up alongside the
  gate config/re-research window, not done this phase (ADR-0021 part 5's same "two keys is enough
  for now" scope call).
- As noted above, wiring `REFRESH_EVIDENCE` for real means a second `ANALYZE` pass can now form a
  second, differently-worded `opportunities` row for a problem an earlier pass already surfaced —
  spec §59's duplicate-opportunity-prevention gap (still unimplemented, ADR-0013 part 7) is no
  longer purely hypothetical.
- No real live run has exercised `REFRESH_EVIDENCE`/exclusion/DO_NOT_CONTACT against real
  `claude` CLI output or real autonomous-mode traffic this phase — same `VERIFIER_REJECTED`-adjacent
  blocker every phase since 8 has hit (no real opportunity/company has reached a state where these
  paths fire in practice yet). Verified instead via unit/fixture tests (90+ new/extended test
  cases), real CLI smoke runs of every new script against a real (migrated, non-fixture) SQLite
  file, and 9 passing Playwright scenarios against a real browser + real `next dev` server — see
  [phase-14-operational-hardening.md](phases/phase-14-operational-hardening.md)'s "Testing
  performed" for the exact commands run.
