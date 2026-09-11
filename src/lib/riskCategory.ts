/**
 * Deterministic high-risk-domain classification (spec §8). The spec's example is explicit that
 * industry alone is not the signal: "automating appointment intake for a clinic may be
 * reasonable while automatically diagnosing patients is not" — both are the same industry
 * (healthcare), so this classifier matches against the *proposed solution/problem*, not
 * `companies.industry`. It's a keyword/phrase heuristic over spec §8's explicit list of
 * high-risk decision domains, not real NLP — a reasoned starting point in the same spirit as
 * `src/pipeline/failureClassification.ts`'s error-text pattern list, expected to need more
 * patterns once real opportunities are classified against it (see ADR-0014).
 */

export type RiskCategory = "STANDARD" | "HIGH_RISK";

interface RiskPattern {
  label: string;
  pattern: RegExp;
  /** If present, `pattern` only counts as a match within a sentence that ALSO contains this —
   * narrows a generic word (e.g. "diagnostic") down to its medical sense. Checked per-sentence,
   * not merely "appears anywhere in the document": a company's evidence/description routinely
   * mentions unrelated context words (e.g. a veterinary clinic's "patient portal") far from the
   * actual match, which a whole-document co-occurrence check would wrongly treat as related. */
  requiresContext?: RegExp;
}

/** Splits into rough sentences for `requiresContext` proximity checks — doesn't need to be
 * linguistically exact, just good enough to separate "diagnose the patient's symptoms" (one
 * sentence, should match) from "...diagnostic... Unrelated sentence mentions a patient portal."
 * (two sentences, should not). */
function splitIntoSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/);
}

/** One entry per spec §8 bullet. */
const HIGH_RISK_PATTERNS: readonly RiskPattern[] = [
  {
    label: "medical diagnosis / treatment recommendation",
    // "diagnos*"/"prescrib*" alone are too generic (e.g. a "technical SEO diagnostic" audit,
    // observed as a real false positive in this phase's live smoke test against real
    // veterinary-clinic opportunities) — require a co-occurring medical/clinical context word.
    pattern: /\b(diagnos\w*|treatment recommendation\w*|prescrib\w*|clinical decision\w*)\b/i,
    requiresContext:
      /\b(patient\w*|medical|clinical|symptom\w*|illness|disease|condition|health|veterinary)\b/i,
  },
  { label: "legal advice", pattern: /\blegal advice\b/i },
  {
    label: "credit decisions",
    pattern: /\bcredit (decision|scoring|approval|denial|risk assessment)\w*\b/i,
  },
  {
    label: "insurance underwriting",
    pattern: /\b(insurance underwrit\w*|underwriting)\b/i,
  },
  {
    label: "automated employment decisions with significant legal consequences",
    pattern:
      /\b(automated (hiring|firing|termination|employment) decision\w*|automatically (hire|fire|terminate)\w*)\b/i,
  },
  {
    label: "financial trading",
    pattern: /\b(financial|algorithmic|automated) trading\b/i,
  },
  {
    label: "highly sensitive regulated personal information",
    pattern:
      /\b(health record\w*|medical record\w*|genetic data|protected health information|\bphi\b|social security number|\bssn\b)\b/i,
  },
  { label: "surveillance", pattern: /\bsurveillance\b/i },
  { label: "safety-critical systems", pattern: /\bsafety[- ]critical\b/i },
];

export interface RiskClassificationInput {
  problemCategory: string;
  problemDescription: string;
  proposedSolution: string;
  implementationStrategy?: string | null;
}

export interface RiskClassificationResult {
  riskCategory: RiskCategory;
  /** Which spec §8 domain(s) matched, for audit/notes — empty when STANDARD. */
  matchedReasons: string[];
}

export function classifyOpportunityRisk(
  input: RiskClassificationInput,
): RiskClassificationResult {
  const haystack = [
    input.problemCategory,
    input.problemDescription,
    input.proposedSolution,
    input.implementationStrategy ?? "",
  ].join("\n");

  const sentences = splitIntoSentences(haystack);

  const matchedReasons = HIGH_RISK_PATTERNS.filter((p) => {
    if (!p.requiresContext) {
      return p.pattern.test(haystack);
    }
    return sentences.some(
      (sentence) => p.pattern.test(sentence) && p.requiresContext!.test(sentence),
    );
  }).map((p) => p.label);

  return {
    riskCategory: matchedReasons.length > 0 ? "HIGH_RISK" : "STANDARD",
    matchedReasons,
  };
}
