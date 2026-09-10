# Phase tracker

Always check this file first. Update it as the **last step** of implementing a phase.

Legend: ⬜ not started · 🟨 in progress · ✅ done

| # | Phase | Status | Completion doc |
|---|-------|--------|----------------|
| 0 | Foundations & Claude-invocation spike | ✅ | [phase-0-foundations.md](phases/phase-0-foundations.md) |
| 1 | Data layer & domain model | ⬜ | — |
| 2 | Work queue & state machine | ⬜ | — |
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

**Current phase:** 1 — Data layer & domain model
**Next phase:** 2 — Work queue & state machine

Phase 0 confirmed both risks it existed to de-risk: research quality (3/3 real-company spike
runs judged strong, see [phase-0-foundations.md](phases/phase-0-foundations.md)) and the
billing mechanism (ADR-0001 re-verified current; the operator's own claude.ai/console usage
check is still outstanding — see that phase doc's "Known limitations").

Full detail for every phase (objective, acceptance criteria, explicit exclusions) lives in
[../PLAN.md](../PLAN.md). This file only tracks status. When a phase finishes, its
implementing session must:

1. Flip its row to ✅ and link the completion doc (`docs/phases/phase-N-<slug>.md`).
2. Move "Current phase" / "Next phase" forward.
3. Update [ARCHITECTURE.md](ARCHITECTURE.md) to reflect what now actually exists.
4. Add any new ADRs to [DECISIONS.md](DECISIONS.md) if non-obvious calls were made.
