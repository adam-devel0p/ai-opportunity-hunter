# Phase tracker

Always check this file first. Update it as the **last step** of implementing a phase.

Legend: ⬜ not started · 🟨 in progress · ✅ done

| # | Phase | Status | Completion doc |
|---|-------|--------|----------------|
| 0 | Foundations & Claude-invocation spike | ✅ | [phase-0-foundations.md](phases/phase-0-foundations.md) |
| 1 | Data layer & domain model | ✅ | [phase-1-data-layer.md](phases/phase-1-data-layer.md) |
| 2 | Work queue & state machine | ✅ | [phase-2-work-queue.md](phases/phase-2-work-queue.md) |
| 3 | Discovery Agent + campaigns | ⬜ | — |
| 4 | Pre-Screening Agent | ⬜ | — |
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

**Current phase:** 3 — Discovery Agent + campaigns
**Next phase:** 4 — Pre-Screening Agent

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

Full detail for every phase (objective, acceptance criteria, explicit exclusions) lives in
[../PLAN.md](../PLAN.md). This file only tracks status. When a phase finishes, its
implementing session must:

1. Flip its row to ✅ and link the completion doc (`docs/phases/phase-N-<slug>.md`).
2. Move "Current phase" / "Next phase" forward.
3. Update [ARCHITECTURE.md](ARCHITECTURE.md) to reflect what now actually exists.
4. Add any new ADRs to [DECISIONS.md](DECISIONS.md) if non-obvious calls were made.
