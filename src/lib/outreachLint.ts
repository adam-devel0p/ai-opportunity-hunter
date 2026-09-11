/**
 * Deterministic post-generation checks for the Outreach Writer (spec §39-40, PLAN.md Phase 10).
 * Same philosophy as `src/lib/offerLint.ts`: don't trust the model to self-police word count,
 * marketing hype, or false confidence — check it in ordinary code and regenerate on a miss
 * (spec §96/§97). `src/pipeline/outreachHandler.ts` runs `lintOutreachDraft` against every
 * generated draft before it's ever persisted.
 */

export const MIN_OUTREACH_WORD_COUNT = 60;
export const MAX_OUTREACH_WORD_COUNT = 130;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface OutreachLintCheck {
  valid: boolean;
  reason?: string;
}

/** Spec §39's word-count preference, checked against the body only (the subject line is not
 * part of the "approximately 60-130 words" guidance). */
export function checkOutreachWordCount(body: string): OutreachLintCheck & { wordCount: number } {
  const wordCount = countWords(body);
  if (wordCount < MIN_OUTREACH_WORD_COUNT || wordCount > MAX_OUTREACH_WORD_COUNT) {
    return {
      valid: false,
      wordCount,
      reason: `Body is ${wordCount} word(s) — outside the required ${MIN_OUTREACH_WORD_COUNT}-${MAX_OUTREACH_WORD_COUNT} word range (spec §39).`,
    };
  }
  return { valid: true, wordCount };
}

/**
 * Spec §39's own banned-phrase examples verbatim, plus close variants of the same
 * hype-marketing-language failure mode (same "exact phrases + close variants" shape as
 * `offerLint.ts`'s vague-offer blocklist). Matched anywhere in the text (not anchored, unlike
 * `offerLint.ts` — this checks a whole email, not a single short field).
 */
const BANNED_OUTREACH_PATTERNS: readonly RegExp[] = [
  /revolutionary ai/i,
  /transform your business/i,
  /unlock the power of ai/i,
  /cutting-edge ai/i,
  /state-of-the-art ai/i,
  /game-chang(e|ing|er)/i,
  /harness the power of/i,
  /leverage the power of ai/i,
  /take your business to the next level/i,
  /supercharge your/i,
  /unlock (your|the) (full )?potential/i,
];

/** Spec §39's "generic mass-email language" examples — greetings/openers that signal a
 * mail-merge blast rather than a genuine, specific observation about this one company. */
const GENERIC_MASS_EMAIL_PATTERNS: readonly RegExp[] = [
  /dear (sir|madam)/i,
  /to whom it may concern/i,
  /dear valued customer/i,
  /dear business owner/i,
];

export function checkOutreachBannedPhrases(subject: string, body: string): OutreachLintCheck {
  const combined = `${subject}\n${body}`;
  const matchedHype = BANNED_OUTREACH_PATTERNS.find((pattern) => pattern.test(combined));
  if (matchedHype) {
    return {
      valid: false,
      reason: `Contains banned marketing language matching /${matchedHype.source}/ (spec §39's exaggerated-AI-hype examples).`,
    };
  }
  const matchedGeneric = GENERIC_MASS_EMAIL_PATTERNS.find((pattern) => pattern.test(combined));
  if (matchedGeneric) {
    return {
      valid: false,
      reason: `Contains generic mass-email language matching /${matchedGeneric.source}/ (spec §39 requires this to read as addressed to one specific person/company).`,
    };
  }
  return { valid: true };
}

export interface OutreachEvidenceInput {
  classification: "FACT" | "INFERENCE" | "HYPOTHESIS" | "UNKNOWN";
}

/**
 * Phrasing that asserts an internal fact about the company's current process with no hedge —
 * spec §40's bad example ("I noticed your team spends hours doing X") stated as flat fact.
 */
const CONFIDENT_ASSERTION_PATTERNS: readonly RegExp[] = [
  /\byou(?:r)?(?: team| staff)? (?:currently )?spend(?:s)? hours\b/i,
  /\byour (?:team|staff|recruiters?|people) (?:is|are) (?:currently )?spending\b/i,
  /\byou (?:currently )?do(?:es)? (?:this|that|it) manually\b/i,
  /\bis (?:currently )?done manually\b/i,
  /\byou definitely\b/i,
  /\bwithout (?:a )?doubt\b/i,
  /\bI (?:know|can see) (?:that )?you\b/i,
];

/** Hedge words/phrases that turn a claim into an honest inference rather than an asserted fact —
 * spec §40's good example ("if the first sorting step is still being done manually, I think
 * there may be an easy automation opportunity"). */
const HEDGE_PATTERNS: readonly RegExp[] = [
  /\bif\b/i,
  /\bmay\b/i,
  /\bmight\b/i,
  /\bcould\b/i,
  /\bpossibly\b/i,
  /\bi think\b/i,
  /\bseems?\b/i,
  /\bappears?\b/i,
  /\blikely\b/i,
  /\bmaybe\b/i,
];

function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Spec §40's truthfulness heuristic: a sentence that confidently asserts something about the
 * company's internal process, with no hedge, must be backed by at least one FACT-classified
 * evidence item somewhere in this opportunity's evidence — otherwise it's an unhedged claim
 * resting on nothing stronger than INFERENCE/HYPOTHESIS, which spec §40 explicitly forbids
 * ("must not say... unless evidence supports that"). This is a structural approximation (per
 * PLAN.md Phase 10's own "assert structural properties, not exact wording" framing), not real
 * claim-to-evidence tracing — it does not verify *which* fact supports *which* sentence, only
 * that confident, unhedged phrasing never appears when the opportunity has no FACT evidence at
 * all.
 */
export function checkOutreachTruthfulness(
  body: string,
  evidence: OutreachEvidenceInput[],
): OutreachLintCheck {
  const hasFactEvidence = evidence.some((item) => item.classification === "FACT");
  if (hasFactEvidence) {
    return { valid: true };
  }

  const violations = splitSentences(body).filter((sentence) => {
    const isConfident = CONFIDENT_ASSERTION_PATTERNS.some((pattern) => pattern.test(sentence));
    if (!isConfident) return false;
    const isHedged = HEDGE_PATTERNS.some((pattern) => pattern.test(sentence));
    return !isHedged;
  });

  if (violations.length > 0) {
    return {
      valid: false,
      reason:
        `Confidently asserts a claim with no FACT-classified evidence to support it and no ` +
        `hedging language (spec §40): "${violations[0]}"`,
    };
  }
  return { valid: true };
}

export interface OutreachLintResult {
  valid: boolean;
  reasons: string[];
  wordCount: number;
}

export function lintOutreachDraft(
  draft: { subject: string; body: string },
  evidence: OutreachEvidenceInput[],
): OutreachLintResult {
  const wordCountCheck = checkOutreachWordCount(draft.body);
  const bannedPhraseCheck = checkOutreachBannedPhrases(draft.subject, draft.body);
  const truthfulnessCheck = checkOutreachTruthfulness(draft.body, evidence);

  const reasons = [wordCountCheck, bannedPhraseCheck, truthfulnessCheck]
    .filter((check) => !check.valid)
    .map((check) => check.reason!);

  return { valid: reasons.length === 0, reasons, wordCount: wordCountCheck.wordCount };
}
