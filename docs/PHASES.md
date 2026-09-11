# Phase tracker

Always check this file first. Update it as the **last step** of implementing a phase.

Legend: ⬜ not started · 🟨 in progress · ✅ done

| # | Phase | Status | Completion doc |
|---|-------|--------|----------------|
| 0 | Foundations & Claude-invocation spike | ✅ | [phase-0-foundations.md](phases/phase-0-foundations.md) |
| 1 | Data layer & domain model | ✅ | [phase-1-data-layer.md](phases/phase-1-data-layer.md) |
| 2 | Work queue & state machine | ✅ | [phase-2-work-queue.md](phases/phase-2-work-queue.md) |
| 3 | Discovery Agent + campaigns | ✅ | [phase-3-discovery-agent.md](phases/phase-3-discovery-agent.md) |
| 4 | Pre-Screening Agent | ✅ | [phase-4-prescreening-agent.md](phases/phase-4-prescreening-agent.md) |
| 5 | Deep Research Agent + evidence model | ✅ | [phase-5-deep-research-agent.md](phases/phase-5-deep-research-agent.md) |
| 6 | Opportunity Analysis Agent + scoring | ✅ | [phase-6-opportunity-analysis-agent.md](phases/phase-6-opportunity-analysis-agent.md) |
| 7 | Skeptical Verification Agent + gating | ✅ | [phase-7-skeptic-verification-agent.md](phases/phase-7-skeptic-verification-agent.md) |
| 8 | Offer Builder + pricing | ✅ | [phase-8-offer-builder.md](phases/phase-8-offer-builder.md) |
| 9 | Contact Research Agent | ✅ | [phase-9-contact-research-agent.md](phases/phase-9-contact-research-agent.md) |
| 10 | Outreach Writer | ✅ | [phase-10-outreach-writer.md](phases/phase-10-outreach-writer.md) |
| 11 | Autonomous scheduler/worker | ✅ | [phase-11-autonomous-worker.md](phases/phase-11-autonomous-worker.md) |
| 12 | Dashboard MVP | ✅ | [phase-12-dashboard-mvp.md](phases/phase-12-dashboard-mvp.md) |
| 13 | Feedback loop & outcome analytics | ✅ | [phase-13-feedback-loop-analytics.md](phases/phase-13-feedback-loop-analytics.md) |
| 14 | Operational hardening | ✅ | [phase-14-operational-hardening.md](phases/phase-14-operational-hardening.md) |

**Current phase:** 14 — Operational hardening (done — last planned phase)
**Next phase:** — none planned; see PLAN.md's "Deferred beyond these phases" for what comes after

Phase 0 confirmed both risks it existed to de-risk: research quality (3/3 real-company spike
runs judged strong, see [phase-0-foundations.md](phases/phase-0-foundations.md)) and the
billing mechanism (ADR-0001 re-verified current; the operator's own claude.ai/console usage
check is still outstanding — see that phase doc's "Known limitations").

Phase 1 added the full SQLite schema (Drizzle, 13 tables) and the deterministic domain logic
that doesn't need Claude: domain normalization/dedupe and opportunity scoring, both pure
functions with unit tests. See [phase-1-data-layer.md](phases/phase-1-data-layer.md) and new
ADR-0008 for the non-obvious calls made (penalty point values, splitting spec §90's state chain
across three tables).

Phase 2 added the deterministic queue/state-machine primitives (`src/pipeline/`): priority
selection over queue contents (spec §49), lifecycle transition validation for all three
§90-derived enums, retryable-vs-non-retryable failure classification + backoff (spec §66), and
stuck-`RUNNING` crash recovery (spec §67) — all pure functions, no live DB wiring and no real
agent handlers yet. See [phase-2-work-queue.md](phases/phase-2-work-queue.md) and new ADR-0009
for the judgment calls made (where `ANALYZE`/`REFRESH_EVIDENCE` fall in the priority order, the
work-item transition graph, `DISCARDED` vs `EXCLUDED`, failure-classification defaults, and the
stuck-`RUNNING` timeout).

Phase 3 added the first real agent + live DB wiring: `discovery_campaigns` CRUD
(`src/lib/campaigns.ts` + `scripts/campaigns.ts`), the Discovery Agent
(`src/agents/discoveryAgent.ts`) built on a new shared validated-invoke-with-retry layer
(`src/agents/runStructuredAgent.ts`), diversity-aware campaign selection via smooth weighted
round-robin (`src/pipeline/campaignSelection.ts`, spec §16), and the `DISCOVER` task handler
(`src/pipeline/discoverHandler.ts`) that persists deduped companies and enqueues `PRESCREEN`
work items. Manually verified live against a real campaign — see
[phase-3-discovery-agent.md](phases/phase-3-discovery-agent.md) and new ADR-0010 for the
judgment calls made (retry-loop module placement, the SWRR selection algorithm, `DISCOVER`
work items reusing `entityId` for a campaign id, per-campaign dedupe hinting vs. global dedupe
enforcement, quota-exhaustion → `DEFERRED` handling, model tier, `reasonToScreen` storage, and
deferring `system_config`/`prompt_versions` wiring).

Phase 4 added the second real agent: the Pre-Screening Agent (`src/agents/prescreenAgent.ts`,
fast model tier, `WebFetch` only) and the `PRESCREEN` work-item handler
(`src/pipeline/prescreenHandler.ts`) that classifies a discovered company as `DISCARD` (company
transitions to `DISCARDED`, nothing re-queued) or `MAYBE`/`PROMISING` (company transitions
`PRESCREENED -> RESEARCH_PENDING`, a `RESEARCH` work item is enqueued), plus a deterministic
`nextEligibleResearchAt` freshness short-circuit that discards without ever calling Claude.
Manually verified live against all 8 real veterinary clinics Phase 3 discovered — all classified
`PROMISING` with specific, non-fabricated reasons — see
[phase-4-prescreening-agent.md](phases/phase-4-prescreening-agent.md) and new ADR-0011 for the
judgment calls made (`MAYBE` treated the same as `PROMISING`, `WebFetch`-only tooling, the
forward-looking freshness check, reason storage in `notes`, and single-write transitive lifecycle
transitions).

Phase 5 added the third real agent: the Deep Research Agent (`src/agents/deepResearchAgent.ts`,
reasoning model tier, `WebSearch`+`WebFetch`) and the `RESEARCH` work-item handler
(`src/pipeline/researchHandler.ts`) that persists evidence — but only evidence items whose
`sourceUrl` matches a `sources` row the new ADR-0004 `PostToolUse` hook
(`src/agents/sourceCaptureHook.ts`, `scripts/hooks/captureSourceHook.ts`) independently recorded
during that same task; anything else is dropped rather than persisted with unverifiable
provenance. `claudeClient.ts` gained `settings`/`extraEnv` options to support this (ADR-0012).
On success, the company transitions `RESEARCH_PENDING -> RESEARCHED` (unconditionally, even with
thin/no evidence — that's Phase 6's judgment to make), `nextEligibleResearchAt`/
`lastResearchedAt` are set deterministically (`src/lib/researchFreshness.ts`, spec §60), and an
`ANALYZE` work item is enqueued for Phase 6. Manually verified live against all 8 real
veterinary clinics from Phases 3-4 — see [phase-5-deep-research-agent.md](phases/phase-5-deep-research-agent.md)
and new ADR-0012 for the judgment calls made (hook delivery mechanism and matcher scope,
env-var-based hook context passing, the sourceUrl↔source cross-check and its drop policy, model
tier, unconditional `RESEARCHED` transition + `ANALYZE` enqueueing, notes-field conventions, and
the two new freshness-threshold constants).

Phase 6 added the fourth real agent: the Opportunity Analysis Agent
(`src/agents/opportunityAnalysisAgent.ts`, reasoning model tier, no tools) and the `ANALYZE`
work-item handler (`src/pipeline/analyzeHandler.ts`) that turns a company's evidence into a
scored opportunity. The agent supplies the ten spec §30 score-component judgments and any spec
§31 penalty reasons; `src/lib/scoring.ts` (built Phase 1, unused until now) is the only thing
that ever sums/subtracts them into `rawScore`/`adjustedScore` — Claude never supplies a final
score. Every successful `ANALYZE` run forms exactly one `opportunities` + `opportunity_evaluations`
row regardless of score (rejecting weak ones is Phase 7's job), persisted straight at
`VERIFICATION_PENDING`, with the company's evidence retroactively linked via `opportunityId` and
a `VERIFY` work item enqueued. Two new `opportunities` columns (`existingAlternatives`,
`validationQuestion`) and a corrected `impactAssumptions` type
(`{assumption, isKnown}[]`, not bare `string[]`) closed a Phase-1 schema gap needed for spec §29's
known-vs-assumption requirement. Manually verified live against all 8 real veterinary clinics from
Phases 3-5 — see [phase-6-opportunity-analysis-agent.md](phases/phase-6-opportunity-analysis-agent.md)
and new ADR-0013 for the judgment calls made (score components/penalties as agent-supplied
judgment inputs vs. deterministic arithmetic, always forming an opportunity regardless of score,
the single-write status collapse, tool/model-tier choice, currency-unit-to-cents conversion, the
two schema fixes, and spec §59 deferral).

Phase 7 added the fifth real agent: the Skeptical Verification Agent
(`src/agents/skepticAgent.ts`, reasoning model tier, no tools) and the `VERIFY` work-item handler
(`src/pipeline/verifyHandler.ts`) — the first phase where an opportunity can actually be
rejected. The skeptic runs a fresh-context adversarial pass (spec §33's question list embedded
verbatim) over an opportunity's factual content + evidence, deliberately never seeing the
Opportunity Analysis Agent's own `confidence`/`scoreComponents`/`penaltyReasons`. Its KEEP/REJECT
is one of four independent inputs to a new deterministic strong-opportunity gate
(`src/lib/opportunityGate.ts`, spec §32) alongside the adjusted score vs. a ~75/100 threshold, the
evidence-strength component vs. a floor, and a new deterministic risk-category classifier
(`src/lib/riskCategory.ts`, spec §8) that flags high-risk decision domains from the proposed
solution's text (never from `companies.industry` alone). Any one failing check fails the whole
gate: a pass transitions the opportunity to `VERIFIED` and enqueues `BUILD_OFFER`; any failure —
not only an explicit skeptic REJECT — transitions it to `VERIFIER_REJECTED`. Manually verified
live against all 8 real veterinary-clinic opportunities from Phases 3-6 (all correctly REJECTed,
low confidence throughout) — see
[phase-7-skeptic-verification-agent.md](phases/phase-7-skeptic-verification-agent.md) and new
ADR-0014 for the judgment calls made (fresh-context input shape, gate independence/reason
collection, `VERIFIER_REJECTED` reused for every gate failure, deterministic risk
classification and the same-sentence-proximity fix a live false positive required, gate-config
defaults, and `BUILD_OFFER` enqueueing).

Phase 8 added the sixth real agent: the Offer Builder (`src/agents/offerBuilderAgent.ts`,
reasoning model tier, no tools) and the `BUILD_OFFER` work-item handler
(`src/pipeline/offerHandler.ts`) — reachable only via a `BUILD_OFFER` work item, which
`verifyHandler.ts` enqueues exclusively on a spec §32 gate pass, so every offer this handler
builds is for an opportunity that already survived Skeptical Verification. Two new deterministic
modules gate what gets persisted: `src/lib/offerLint.ts` (spec §34's vague-offer blocklist plus a
minimum word-count floor — a match regenerates the offer once, a second match fails the task
without persisting anything) and `src/lib/pricing.ts` (spec §35's configurable pricing bands —
never blocks a deviant price, but always records a justification, the agent's own or a
deterministic fallback, when the price falls outside the band its own duration estimate
resolves to). On success, the opportunity collapses `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH`
in one write (same pattern as every earlier handler) and a `FIND_CONTACT` work item is enqueued
for Phase 9. No live manual smoke test this phase — Phase 7's real veterinary-clinic run left all
8 opportunities `VERIFIER_REJECTED`, so there was no live `VERIFIED` opportunity to build an offer
for; PLAN.md's Phase 8 acceptance criteria only require fixture/unit tests, which this phase's 3
new test files (`offerLint.test.ts`, `pricing.test.ts`, `offerBuilderAgent.test.ts`) plus
`offerHandler.test.ts` cover directly. See
[phase-8-offer-builder.md](phases/phase-8-offer-builder.md) and new ADR-0015 for the judgment
calls made (pricing bands as a code-constant config with non-overlapping duration cutoffs, the
`priceJustification` contract addition and its recording-not-blocking behavior, the vague-offer
lint's blocklist + word-count design and its one-regeneration-then-fail behavior, the
single-write status collapse + `FIND_CONTACT` enqueue, and the deferred live smoke test).

Phase 9 added the seventh real agent: the Contact Research Agent (`src/agents/contactAgent.ts`,
fast model tier, `WebSearch`+`WebFetch`) and the `FIND_CONTACT` work-item handler
(`src/pipeline/contactHandler.ts`) — reachable only via a `FIND_CONTACT` work item, which
`offerHandler.ts` enqueues unconditionally on every successful offer, so every contact this
handler finds is for an opportunity that already survived Skeptical Verification and has a
concrete priced offer. A new `src/lib/contactDisplay.ts` enforces spec §38's "never represent a
guessed email as verified" hard rule at a dedicated data-access layer: `isVerifiedEmail` is only
ever true when `emailConfidence === "VERIFIED"`, by construction. Every completed `FIND_CONTACT`
task forms exactly one `contacts` row regardless of the email confidence found — including a
correct-role-but-no-named-individual outcome, which the contract handles by returning the target
role/title as `name` rather than inventing a person — and on success the opportunity collapses
`CONTACT_RESEARCH -> OUTREACH_READY` in one write with a `WRITE_OUTREACH` work item enqueued for
Phase 10. No live manual smoke test this phase — same blocker as Phase 8: all 8 real
veterinary-clinic opportunities from Phases 3-7 remain `VERIFIER_REJECTED`, so there was no live
`CONTACT_RESEARCH` opportunity to run `scripts/contact.ts` against; PLAN.md's Phase 9 acceptance
criteria's fixture/unit tests (`contactAgent.test.ts`, `contactDisplay.test.ts`,
`contactHandler.test.ts`) cover the acceptance criteria instead. See
[phase-9-contact-research-agent.md](phases/phase-9-contact-research-agent.md) and new ADR-0016 for
the judgment calls made (model tier/tools choice, the email/emailConfidence schema coupling, the
no-named-individual-found design, `contactDisplay.ts` as the enforced data-access layer, the
single-write status collapse + `WRITE_OUTREACH` enqueue, and the deferred live smoke test).

Phase 10 added the eighth and final agent of the core research-to-outreach pipeline: the
Outreach Writer (`src/agents/outreachAgent.ts`, reasoning model tier, no tools) and the
`WRITE_OUTREACH` work-item handler (`src/pipeline/outreachHandler.ts`) — reachable only via a
`WRITE_OUTREACH` work item, which `contactHandler.ts` enqueues unconditionally on every completed
contact search, so every draft this handler writes is for an opportunity that already survived
Skeptical Verification and has both a priced offer and a researched contact. A new
`src/lib/outreachLint.ts` enforces spec §39-40's deterministic post-generation checks — word
count (60-130 words), a banned-marketing-phrase/generic-mass-email blocklist, and a truthfulness
heuristic tying unhedged confident phrasing to the presence of at least one FACT-classified
evidence item — with a match triggering exactly one regeneration before the task fails outright
(same "one regeneration then fail" pattern as Phase 8's vague-offer lint). Every completed
`WRITE_OUTREACH` task persists exactly one `outreach_drafts` row at `status: "DRAFT"`; unlike
every earlier handler, this one does **not** transition `opportunities.status` or enqueue further
work — `OUTREACH_READY -> SENT` is reserved for an actual manual operator send (spec §41/§45),
not automatic draft generation, so this is intentionally the last automated pipeline stage. No
live manual smoke test this phase — same blocker as Phases 8-9: all 8 real veterinary-clinic
opportunities from Phases 3-7 remain `VERIFIER_REJECTED`, so there was no live `OUTREACH_READY`
opportunity to run `scripts/outreach.ts` against; PLAN.md's Phase 10 acceptance criteria's
fixture/unit tests (`outreachAgent.test.ts`, `outreachLint.test.ts`, `outreachHandler.test.ts`)
cover the acceptance criteria instead. See
[phase-10-outreach-writer.md](phases/phase-10-outreach-writer.md) and new ADR-0017 for the
judgment calls made (model tier/no tools, the three independent deterministic-check modules and
their "collect every reason" aggregation, the truthfulness heuristic's structural-approximation
design, the `"[Your name]"` sign-off placeholder, the deliberate no-status-transition/no-enqueue
behavior, the company-keyed contact lookup, and the deferred live smoke test).

Phase 11 added the long-running autonomous loop: `src/worker.ts` ties every Phase 2-10 primitive
and handler together into continuous operation (spec §50), wiring Phase 2's `crashRecovery.ts` and
`priority.ts` to the live `work_items` table for the first time. Each cycle checks a new minimal
`system_config` accessor (`src/lib/config.ts`) for autonomous mode (spec §71 pause/resume,
`scripts/autonomous.ts` the CLI toggle until Phase 12's dashboard), tops up `DISCOVER` work via
Phase 3's `selectNextCampaign` when none is in flight, selects the single highest-priority eligible
item, and dispatches it to the matching handler — wrapped in try/catch so a thrown error is routed
through `failureClassification.ts` instead of crashing the loop (spec §66, the first phase where
that's literally wired up). Quota exhaustion (spec §51) is detected by reusing every handler's
existing `DEFERRED` convention and handled with worker-owned exponential backoff (30 min base,
doubling, capped at 4h), never a tight retry loop and never automatic API-key fallback. An example
macOS `launchd` plist is provided as a `.example` template. Manually verified live (zero-cost,
autonomous mode off) against the real project DB — `npm run worker` starts, logs `paused`, and
shuts down cleanly on `SIGINT` — see
[phase-11-autonomous-worker.md](phases/phase-11-autonomous-worker.md) and new ADR-0018 for the
judgment calls made (reusing `DEFERRED` as the quota signal, worker-owned vs. per-item backoff,
the try/catch handler wrapping, the new config accessor's deliberately narrow scope, autonomous
mode's safe default, the discovery-replenishment design, `dbPath` threading through a shared
handler type, the `REFRESH_EVIDENCE` stub, and the deferred live multi-hour run).

Phase 12 added the first UI: a Next.js (App Router) dashboard under `src/app` (spec §42-46, §69,
§71-73, §85), built on new plain DB-only modules in `src/lib` (`dashboardQueries.ts`,
`dashboardActions.ts`, `activity.ts`) that the `src/app` server components/actions just wire up —
summary metrics, an opportunity list with basic filters, a full opportunity detail page (evidence
UX, the spec §85 human-trust panel mapped from existing fields, and every spec §45 operator
action including the spec §46 rejection-reason picker), a spec §69 activity feed derived from
`work_items` at read time rather than a new event table, the spec §71 autonomous pause/resume
toggle, and spec §72's manual "research this company now" entry point (skips discovery/
pre-screening, inserts the company straight at `RESEARCH_PENDING`). One schema addition
(`opportunities.operatorVerdict`) makes the operator's own Approve/Reject verdict representable
separately from the pipeline's own `status`. `next dev`/`next build` are pinned to `--webpack`
(not Turbopack, the Next 16 default) since only webpack honors the `extensionAlias` config this
project needs to let Next's bundler resolve the backend's NodeNext-style `.js`-suffixed imports.
Verified via 31 new Vitest unit/fixture tests plus a 7-scenario Playwright suite
(`e2e/dashboard.spec.ts`) run against a real `next dev --webpack` server and a seeded fixture DB
(`scripts/seedE2eFixture.ts`) — see [phase-12-dashboard-mvp.md](phases/phase-12-dashboard-mvp.md)
and new ADR-0019 for the ten judgment calls made (the tsconfig/bundler split, skipping
`eslint-plugin-react` over an ESLint 10 peer-range gap, the `operatorVerdict` column, the
activity-feed design, manual-research's discovery-skip + already-progressed handling, the spec
§85 label-to-field mapping, the Sent-Manually/outcome-event split, filtering scope, the
Playwright fixture-seeding approach, and the two features deliberately deferred). No real
end-to-end operator walkthrough against live pipeline data was possible this phase — every real
opportunity produced by Phases 3-11's live smoke tests was `VERIFIER_REJECTED`, so there has
never been a real `VERIFIED`/`OUTREACH_READY` opportunity to view; PLAN.md's own "manual UX
walkthrough... using data produced by earlier phases" acceptance criterion is deferred until one
exists.

Phase 13 added the feedback loop's read side: `src/lib/outcomeAnalytics.ts` (spec §47, §74) —
`getOverallOutcomeMetrics` (sent count, reply/positive-reply/meeting/win rates, average
opportunity score, score-vs-response) and `getPerformanceByDimension` (the same stats grouped by
industry/country/problem category/campaign/price band) — both built over the `outreach_outcomes`
table Phase 12 already wrote to, with no schema changes needed. Every rate/average carries its own
sample size and a `reliable` flag (`DEFAULT_MIN_SAMPLE_SIZE = 5`) so a 1-of-1 "100% reply rate"
can never be presented as meaningful (spec §74's explicit small-sample-size requirement), rendered
on a new `/analytics` dashboard page as a "low sample" badge rather than being hidden outright. No
new agent, no new tables. See
[phase-13-feedback-loop-analytics.md](phases/phase-13-feedback-loop-analytics.md) and new
ADR-0020 for the six judgment calls made (no schema changes, `SENT`-event-based "sent"
definition, the `{value, sampleSize, reliable}` stat shape, one parameterized dimension function,
`averageOpportunityScore`'s all-scored-opportunities scope vs. `scoreVsResponse`'s sent-only
scope, and the stacked-tables page layout). No real outreach outcome data exists yet — same
`VERIFIER_REJECTED` blocker Phases 8-10 already hit — so `/analytics` has only been verified
against seeded fixture data.

Phase 14 added the remaining operator-safety and data-stewardship requirements PLAN.md scoped for
"before trusting the system with real, ongoing use," with no new Claude-invoking agent — every
new module this phase is deterministic TypeScript. A new `exclusion_rules` table
(domain/industry/country, spec §61) is checked live by `discoverHandler.ts` and, authoritatively,
by `prescreenHandler.ts` right before every Claude call; permanent single-company exclusion reuses
the existing `companies.lifecycleStatus = "EXCLUDED"` special case plus a new
`dashboardActions.excludeCompany`. `src/lib/doNotContact.ts` is a single predicate both
`contactHandler.ts` (skips enqueueing `WRITE_OUTREACH`, the acceptance-criteria requirement) and
`outreachHandler.ts` (a defensive re-check) call for spec §65. `REFRESH_EVIDENCE` finally has a
real handler (`refreshEvidenceHandler.ts`, reusing `researchHandler.ts`'s evidence-persistence
rule via a new shared `researchEvidence.ts`) topped up every worker cycle by a new
`ensureRefreshEvidenceWork`, batch-capped at 3 — spec §60 re-research is now actually wired end to
end, not just the freshness-window math Phase 5 built. `system_config` gained two operator-facing
keys (the spec §32 gate's threshold/floor/high-risk policy, and the re-research window), exposed
on a new `/settings` dashboard page alongside exclusion-rule management, one-click backup
(`src/lib/backup.ts`, `better-sqlite3`'s own `.backup()` API), and JSON/CSV export links
(`src/lib/exportData.ts`, `/api/export`) — spec §79/§80/§70. A CLI-only seed/test mode
(`scripts/seed.ts`, spec §99) drives known company URLs through screening -> research -> analysis
-> verification -> offer creation by calling each stage's real handler directly, distinct from
Phase 12's manual-research entry point (which deliberately skips screening). Verified via 90+ new
unit/fixture tests across 8 new test files plus extensions to 7 existing ones, a real
backup/corrupt/restore round-trip, a real multi-format export against seeded data, real CLI smoke
runs of every new script, and 2 new Playwright scenarios (9/9 passing) covering the new dashboard
UI end-to-end in a real browser — see
[phase-14-operational-hardening.md](phases/phase-14-operational-hardening.md) and new ADR-0021 for
the ten judgment calls made (the exclusion split between `exclusion_rules` and
`lifecycleStatus`/`EXCLUDED`, the two-enforcement-point pattern shared by exclusion and DNC, why
`REFRESH_EVIDENCE` never transitions `lifecycleStatus`, the deliberately narrow two-key
`system_config` expansion, seed mode's CLI-only scope, the backup/restore API choices, the export
shape, the `/settings` page's scope, and the observability/secret-handling pass's single targeted
fix).

Full detail for every phase (objective, acceptance criteria, explicit exclusions) lives in
[../PLAN.md](../PLAN.md). This file only tracks status. When a phase finishes, its
implementing session must:

1. Flip its row to ✅ and link the completion doc (`docs/phases/phase-N-<slug>.md`).
2. Move "Current phase" / "Next phase" forward.
3. Update [ARCHITECTURE.md](ARCHITECTURE.md) to reflect what now actually exists.
4. Add any new ADRs to [DECISIONS.md](DECISIONS.md) if non-obvious calls were made.
