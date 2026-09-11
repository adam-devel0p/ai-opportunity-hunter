/**
 * Deterministic `companies.nextEligibleResearchAt` computation (spec §60: "re-research windows
 * should eventually be configurable" — no exact value pinned down by the source spec). Set once
 * per successful Deep Research run (Phase 5's `researchHandler.ts`), consumed by Phase 4's
 * `prescreenHandler.ts` freshness short-circuit (ADR-0011 part 3) whenever a later phase
 * re-triggers `PRESCREEN` for an already-researched company.
 */

/** Same "reasoned starting point, not empirically tuned" status as ADR-0008/0009's other
 * placeholder constants and `sourceFreshness.ts`'s threshold — revisit once real re-research
 * usage (Phase 14) shows whether 90 days is too long/short. */
export const DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export function computeNextEligibleResearchAt(
  now: Date = new Date(),
  windowMs: number = DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS,
): Date {
  return new Date(now.getTime() + windowMs);
}
