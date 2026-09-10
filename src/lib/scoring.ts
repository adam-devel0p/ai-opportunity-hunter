/**
 * Deterministic opportunity scoring (spec §30-31). Pure functions only — no
 * Claude call ever supplies a score directly; agents supply the underlying
 * judgments (component values, penalty reasons) and this module is the only
 * place that turns them into numbers.
 */

export interface ScoreComponentRange {
  min: number;
  max: number;
}

export const SCORE_COMPONENT_RANGES = {
  evidenceStrength: { min: 0, max: 20 },
  painSeverity: { min: 0, max: 15 },
  economicImpactScore: { min: 0, max: 15 },
  deliverability: { min: 0, max: 15 },
  purchaseLikelihood: { min: 0, max: 10 },
  speedToValue: { min: 0, max: 5 },
  reachability: { min: 0, max: 5 },
  demonstrability: { min: 0, max: 5 },
  repeatability: { min: 0, max: 5 },
  urgency: { min: 0, max: 5 },
} as const satisfies Record<string, ScoreComponentRange>;

export type ScoreComponentName = keyof typeof SCORE_COMPONENT_RANGES;

export type ScoreComponents = Record<ScoreComponentName, number>;

export const MAX_RAW_SCORE = Object.values(SCORE_COMPONENT_RANGES).reduce(
  (sum, range) => sum + range.max,
  0,
);

/**
 * Named penalty reasons (spec §31) and the points each deducts from the raw
 * score. Exact amounts weren't specified by the product spec ("may be
 * determined in implementation planning" — §31) so these were chosen here,
 * scaled by how thoroughly the reason undermines the opportunity: see
 * ADR-0008 for the reasoning per reason.
 */
export const PENALTY_CATALOG = {
  WEAK_SPECULATIVE_EVIDENCE: 15,
  COMMODITY_SOLUTION_AVAILABLE: 10,
  PROBLEM_ALREADY_SOLVED: 20,
  LARGE_PROCUREMENT_BURDEN: 10,
  SIGNIFICANT_REGULATORY_RISK: 15,
  UNCLEAR_BUYER: 10,
  IMPLEMENTATION_DEPENDENCY_OUTSIDE_CONTROL: 10,
  COMPANY_FINANCIALLY_UNSUITABLE: 15,
  LONG_IMPLEMENTATION_CYCLE: 5,
  CROWDED_GENERIC_OFFER: 10,
} as const satisfies Record<string, number>;

export type PenaltyReason = keyof typeof PENALTY_CATALOG;

export interface Penalty {
  reason: PenaltyReason;
  amount: number;
}

export interface ScoreResult {
  rawScore: number;
  penalties: Penalty[];
  adjustedScore: number;
}

function assertComponentInRange(name: ScoreComponentName, value: number) {
  const range = SCORE_COMPONENT_RANGES[name];
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new RangeError(
      `Score component "${name}" must be an integer between ${range.min} and ${range.max}, got ${value}`,
    );
  }
}

/** Sum of component scores. Callers must supply already-validated components. */
export function calculateRawScore(components: ScoreComponents): number {
  let total = 0;
  for (const name of Object.keys(
    SCORE_COMPONENT_RANGES,
  ) as ScoreComponentName[]) {
    const value = components[name];
    assertComponentInRange(name, value);
    total += value;
  }
  return total;
}

/** Builds the penalty list (with resolved point amounts) from a set of reasons. */
export function buildPenalties(reasons: PenaltyReason[]): Penalty[] {
  return reasons.map((reason) => ({
    reason,
    amount: PENALTY_CATALOG[reason],
  }));
}

/** rawScore minus total penalties, clamped to [0, 100] per DATABASE_SCHEMA.md. */
export function calculateAdjustedScore(
  rawScore: number,
  penalties: Penalty[],
): number {
  const totalPenalty = penalties.reduce((sum, p) => sum + p.amount, 0);
  const adjusted = rawScore - totalPenalty;
  return Math.max(0, Math.min(MAX_RAW_SCORE, adjusted));
}

/** Full scoring pipeline: components + penalty reasons -> raw/adjusted score. */
export function scoreOpportunity(
  components: ScoreComponents,
  penaltyReasons: PenaltyReason[] = [],
): ScoreResult {
  const rawScore = calculateRawScore(components);
  const penalties = buildPenalties(penaltyReasons);
  const adjustedScore = calculateAdjustedScore(rawScore, penalties);
  return { rawScore, penalties, adjustedScore };
}
