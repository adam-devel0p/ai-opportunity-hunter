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
| 5 | Deep Research Agent + evidence model | ⬜ | — |
| 6 | Opportunity Analysis Agent + scoring | ⬜ | — |
| 7 | Skeptical Verification Agent + gating | ⬜ | — |
| 8 | Offer Builder + pricing | ⬜ | — |
| 9 | Contact Research Agent | ⬜ | — |
| 10 | Outreach Writer | ⬜ | — |
| 11 | Autonomous scheduler/worker | ⬜ | — |
| 12 | Dashboard MVP | ⬜ | — |
| 13 | Feedback loop & outcome analytics | ⬜ | — |
| 14 | Operational hardening | ⬜ | — |

**Current phase:** 5 — Deep Research Agent + evidence model
**Next phase:** 6 — Opportunity Analysis Agent + scoring

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

Full detail for every phase (objective, acceptance criteria, explicit exclusions) lives in
[../PLAN.md](../PLAN.md). This file only tracks status. When a phase finishes, its
implementing session must:

1. Flip its row to ✅ and link the completion doc (`docs/phases/phase-N-<slug>.md`).
2. Move "Current phase" / "Next phase" forward.
3. Update [ARCHITECTURE.md](ARCHITECTURE.md) to reflect what now actually exists.
4. Add any new ADRs to [DECISIONS.md](DECISIONS.md) if non-obvious calls were made.
