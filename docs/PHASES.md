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
| 9 | Contact Research Agent | ⬜ | — |
| 10 | Outreach Writer | ⬜ | — |
| 11 | Autonomous scheduler/worker | ⬜ | — |
| 12 | Dashboard MVP | ⬜ | — |
| 13 | Feedback loop & outcome analytics | ⬜ | — |
| 14 | Operational hardening | ⬜ | — |

**Current phase:** 9 — Contact Research Agent
**Next phase:** 10 — Outreach Writer

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

Full detail for every phase (objective, acceptance criteria, explicit exclusions) lives in
[../PLAN.md](../PLAN.md). This file only tracks status. When a phase finishes, its
implementing session must:

1. Flip its row to ✅ and link the completion doc (`docs/phases/phase-N-<slug>.md`).
2. Move "Current phase" / "Next phase" forward.
3. Update [ARCHITECTURE.md](ARCHITECTURE.md) to reflect what now actually exists.
4. Add any new ADRs to [DECISIONS.md](DECISIONS.md) if non-obvious calls were made.
