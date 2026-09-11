/**
 * Deterministic `sources.freshnessState` derivation (spec §23, DATABASE_SCHEMA.md: "Freshness
 * is derived deterministically from `retrievedAt` vs a configurable threshold, not asked of
 * Claude"). A source is `UNAVAILABLE` if the fetch itself didn't succeed (a non-2xx HTTP
 * status, or no status at all), otherwise `FRESH` until `thresholdMs` has elapsed since
 * `retrievedAt`, after which it's `STALE`.
 *
 * At insert time (the only caller today — the ADR-0004 hook, Phase 5) `retrievedAt` is always
 * `now`, so a successful fetch is always `FRESH` and `STALE` is unreachable from that one call
 * site. The function is written generally (not hardcoded to "just inserted") so a later phase
 * (re-research eligibility, spec §60, Phase 14) can recompute freshness for an existing row on
 * read without a second implementation.
 */

export type SourceFreshnessState = "FRESH" | "STALE" | "UNAVAILABLE";

/** No value in the source spec pins this down ("configurable" per DATABASE_SCHEMA.md) — 30
 * days is a reasoned starting point matching the general shape of spec §60's re-research
 * triggers, not an empirically tuned value. Revisit alongside ADR-0008/0009's other placeholder
 * constants if real usage suggests otherwise. */
export const DEFAULT_SOURCE_FRESHNESS_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export interface ComputeSourceFreshnessStateInput {
  /** HTTP status of the fetch, or null if the fetch itself failed/never completed. */
  httpStatus: number | null;
  retrievedAt: Date;
  now?: Date;
  thresholdMs?: number;
}

export function computeSourceFreshnessState(
  input: ComputeSourceFreshnessStateInput,
): SourceFreshnessState {
  if (input.httpStatus === null || input.httpStatus < 200 || input.httpStatus >= 300) {
    return "UNAVAILABLE";
  }
  const now = input.now ?? new Date();
  const thresholdMs = input.thresholdMs ?? DEFAULT_SOURCE_FRESHNESS_THRESHOLD_MS;
  const ageMs = now.getTime() - input.retrievedAt.getTime();
  return ageMs > thresholdMs ? "STALE" : "FRESH";
}
