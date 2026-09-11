import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPPORTUNITY_GATE_CONFIG,
  evaluateOpportunityGate,
} from "./opportunityGate.js";

describe("evaluateOpportunityGate", () => {
  it("passes a strong, KEEP, standard-risk opportunity above threshold", () => {
    const result = evaluateOpportunityGate({
      verifierResult: "KEEP",
      adjustedScore: 87,
      evidenceStrength: 18,
      riskCategory: "STANDARD",
    });
    expect(result).toEqual({ pass: true, reasons: [] });
  });

  it("fails on REJECT alone, even with a high score and strong evidence", () => {
    const result = evaluateOpportunityGate({
      verifierResult: "REJECT",
      adjustedScore: 90,
      evidenceStrength: 20,
      riskCategory: "STANDARD",
    });
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual([
      "Skeptical reviewer returned REJECT, not KEEP.",
    ]);
  });

  it("fails on score below threshold even when the verifier says KEEP", () => {
    const result = evaluateOpportunityGate({
      verifierResult: "KEEP",
      adjustedScore: 74,
      evidenceStrength: 18,
      riskCategory: "STANDARD",
    });
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual([
      "Adjusted score 74 is below the gating threshold of 75.",
    ]);
  });

  it("passes exactly at the threshold (>=, not strictly greater)", () => {
    const result = evaluateOpportunityGate({
      verifierResult: "KEEP",
      adjustedScore: 75,
      evidenceStrength: 18,
      riskCategory: "STANDARD",
    });
    expect(result.pass).toBe(true);
  });

  it("fails on thin evidence strength even with a passing overall score", () => {
    const result = evaluateOpportunityGate({
      verifierResult: "KEEP",
      adjustedScore: 80,
      evidenceStrength: 4,
      riskCategory: "STANDARD",
    });
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual([
      "Evidence strength 4 is below the required floor of 10.",
    ]);
  });

  it("fails a HIGH_RISK opportunity by default even when every other check passes", () => {
    const result = evaluateOpportunityGate({
      verifierResult: "KEEP",
      adjustedScore: 90,
      evidenceStrength: 20,
      riskCategory: "HIGH_RISK",
    });
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual([
      "Opportunity touches a high-risk decision domain (spec §8) and requires explicit operator review before proceeding.",
    ]);
  });

  it("allows a HIGH_RISK opportunity through when the operator has explicitly opted in via config", () => {
    const result = evaluateOpportunityGate(
      {
        verifierResult: "KEEP",
        adjustedScore: 90,
        evidenceStrength: 20,
        riskCategory: "HIGH_RISK",
      },
      { ...DEFAULT_OPPORTUNITY_GATE_CONFIG, allowHighRisk: true },
    );
    expect(result.pass).toBe(true);
  });

  it("collects every failing reason at once, not just the first", () => {
    const result = evaluateOpportunityGate({
      verifierResult: "REJECT",
      adjustedScore: 40,
      evidenceStrength: 2,
      riskCategory: "HIGH_RISK",
    });
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(4);
  });

  it("respects a custom threshold/floor config", () => {
    const result = evaluateOpportunityGate(
      {
        verifierResult: "KEEP",
        adjustedScore: 60,
        evidenceStrength: 6,
        riskCategory: "STANDARD",
      },
      { scoreThreshold: 50, evidenceStrengthFloor: 5, allowHighRisk: false },
    );
    expect(result.pass).toBe(true);
  });
});
