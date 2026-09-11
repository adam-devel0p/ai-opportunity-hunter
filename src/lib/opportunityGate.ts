/**
 * Deterministic strong-opportunity gate (spec §32). Combines the Skeptical Verification Agent's
 * KEEP/REJECT with three checks that never touch Claude: the Phase 1 adjusted score against a
 * configurable threshold ("sufficient overall score"), the Phase 6 `evidenceStrength` component
 * against a floor ("sufficient evidence score"), and the deterministic `riskCategory`
 * classification (`src/lib/riskCategory.ts`, spec §8) against an operator opt-in
 * ("acceptable implementation risk"). A single failing check is enough to fail the whole gate —
 * every reason that failed is still collected, not just the first, so `verifyHandler.ts` can
 * record a complete picture in `companies.notes` rather than only the first thing that tripped.
 *
 * This function never calls Claude and never touches the DB — `verifyHandler.ts` is the only
 * caller, feeding it the Skeptic's output plus values already persisted by Phase 6.
 */

import type { RiskCategory } from "./riskCategory.js";

export interface OpportunityGateInput {
  verifierResult: "KEEP" | "REJECT";
  /** `opportunity_evaluations.adjustedScore` (0-100). */
  adjustedScore: number;
  /** `opportunity_evaluations.evidenceStrength` (0-20). */
  evidenceStrength: number;
  riskCategory: RiskCategory;
}

export interface OpportunityGateConfig {
  /** Spec §32's "approximately 75/100" initial target threshold. */
  scoreThreshold: number;
  /** Minimum acceptable `evidenceStrength` component — half of its 0-20 range by default, a
   * reasoned starting point (same category as ADR-0008/0009's other placeholder constants). */
  evidenceStrengthFloor: number;
  /** Spec §8: high-risk domains are excluded by default; an operator can flip this after
   * explicit manual review, per spec's "unless explicitly reviewed by the operator." */
  allowHighRisk: boolean;
}

export const DEFAULT_OPPORTUNITY_GATE_CONFIG: OpportunityGateConfig = {
  scoreThreshold: 75,
  evidenceStrengthFloor: 10,
  allowHighRisk: false,
};

export interface OpportunityGateResult {
  pass: boolean;
  /** Empty when `pass` is true. Every failing check is included, not just the first. */
  reasons: string[];
}

export function evaluateOpportunityGate(
  input: OpportunityGateInput,
  config: OpportunityGateConfig = DEFAULT_OPPORTUNITY_GATE_CONFIG,
): OpportunityGateResult {
  const reasons: string[] = [];

  if (input.verifierResult !== "KEEP") {
    reasons.push(
      `Skeptical reviewer returned ${input.verifierResult}, not KEEP.`,
    );
  }
  if (input.adjustedScore < config.scoreThreshold) {
    reasons.push(
      `Adjusted score ${input.adjustedScore} is below the gating threshold of ${config.scoreThreshold}.`,
    );
  }
  if (input.evidenceStrength < config.evidenceStrengthFloor) {
    reasons.push(
      `Evidence strength ${input.evidenceStrength} is below the required floor of ${config.evidenceStrengthFloor}.`,
    );
  }
  if (input.riskCategory === "HIGH_RISK" && !config.allowHighRisk) {
    reasons.push(
      "Opportunity touches a high-risk decision domain (spec §8) and requires explicit operator review before proceeding.",
    );
  }

  return { pass: reasons.length === 0, reasons };
}
