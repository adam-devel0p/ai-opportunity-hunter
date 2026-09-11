/**
 * Deterministic vague-offer lint (spec §34, PLAN.md Phase 8). "The offer must define an actual
 * deliverable" — spec §34 gives one explicit bad example ("AI automation services.") and one
 * explicit good example (a specific, concrete workflow description). This is exactly the kind of
 * check ordinary code can reliably enforce rather than trusting the model to self-police (spec
 * §96/§97) — `src/pipeline/offerHandler.ts` runs this against every generated offer's `scope` and
 * regenerates once on a match, mirroring the "one retry" pattern used elsewhere in this app.
 */

/**
 * Known-vague scope phrases (spec §34's own bad example plus close variants of the same failure
 * mode: naming a technology/category instead of a deliverable). Matched against the whole
 * (trimmed) scope string, case-insensitively, so a scope that is *only* one of these phrases is
 * caught — a scope that merely mentions "AI automation" as part of a longer, concrete sentence is
 * not (that's what the word-count check below is for, not this list).
 */
const VAGUE_SCOPE_PATTERNS: readonly RegExp[] = [
  /^ai automation services?\.?$/i,
  /^automation services?\.?$/i,
  /^ai solutions?\.?$/i,
  /^ai-powered solutions?\.?$/i,
  /^ai integration\.?$/i,
  /^digital transformation( services)?\.?$/i,
  /^ai chatbot( solution)?\.?$/i,
  /^business process automation\.?$/i,
  /^process automation\.?$/i,
  /^workflow automation\.?$/i,
  /^custom software solution\.?$/i,
  /^bespoke software\.?$/i,
];

/** A scope this short cannot plausibly name a specific deliverable (spec §34's good example is a
 * full sentence describing what's actually built) — a second, independent line of defense beyond
 * the exact-phrase blocklist above, since a model can trivially dodge a fixed phrase list with a
 * different but equally vague one-liner. */
export const MIN_SCOPE_WORD_COUNT = 8;

export interface OfferLintResult {
  vague: boolean;
  reason?: string;
}

export function lintOfferScope(scope: string): OfferLintResult {
  const trimmed = scope.trim();

  const matchedPattern = VAGUE_SCOPE_PATTERNS.find((pattern) => pattern.test(trimmed));
  if (matchedPattern) {
    return {
      vague: true,
      reason: `"${trimmed}" matches the known-vague-offer blocklist (spec §34's own bad example category) — name the actual deliverable instead.`,
    };
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_SCOPE_WORD_COUNT) {
    return {
      vague: true,
      reason: `"${trimmed}" is only ${wordCount} word(s) — too short to describe a concrete deliverable (spec §34 requires the offer to "define an actual deliverable").`,
    };
  }

  return { vague: false };
}
