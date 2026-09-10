import { describe, expect, it } from "vitest";
import {
  MAX_RAW_SCORE,
  PENALTY_CATALOG,
  SCORE_COMPONENT_RANGES,
  buildPenalties,
  calculateAdjustedScore,
  calculateRawScore,
  scoreOpportunity,
  type ScoreComponents,
} from "./scoring.js";

const maxComponents: ScoreComponents = {
  evidenceStrength: 20,
  painSeverity: 15,
  economicImpactScore: 15,
  deliverability: 15,
  purchaseLikelihood: 10,
  speedToValue: 5,
  reachability: 5,
  demonstrability: 5,
  repeatability: 5,
  urgency: 5,
};

describe("SCORE_COMPONENT_RANGES", () => {
  it("matches the §30 component ranges and sums to 100", () => {
    expect(SCORE_COMPONENT_RANGES.evidenceStrength).toEqual({ min: 0, max: 20 });
    expect(SCORE_COMPONENT_RANGES.painSeverity).toEqual({ min: 0, max: 15 });
    expect(SCORE_COMPONENT_RANGES.economicImpactScore).toEqual({
      min: 0,
      max: 15,
    });
    expect(SCORE_COMPONENT_RANGES.deliverability).toEqual({ min: 0, max: 15 });
    expect(SCORE_COMPONENT_RANGES.purchaseLikelihood).toEqual({
      min: 0,
      max: 10,
    });
    expect(SCORE_COMPONENT_RANGES.speedToValue).toEqual({ min: 0, max: 5 });
    expect(SCORE_COMPONENT_RANGES.reachability).toEqual({ min: 0, max: 5 });
    expect(SCORE_COMPONENT_RANGES.demonstrability).toEqual({ min: 0, max: 5 });
    expect(SCORE_COMPONENT_RANGES.repeatability).toEqual({ min: 0, max: 5 });
    expect(SCORE_COMPONENT_RANGES.urgency).toEqual({ min: 0, max: 5 });
    expect(MAX_RAW_SCORE).toBe(100);
  });
});

describe("calculateRawScore", () => {
  it("sums all components correctly", () => {
    expect(calculateRawScore(maxComponents)).toBe(100);
    expect(
      calculateRawScore({
        ...maxComponents,
        evidenceStrength: 0,
        urgency: 0,
      }),
    ).toBe(75);
  });

  it("rejects a component above its max", () => {
    expect(() =>
      calculateRawScore({ ...maxComponents, evidenceStrength: 21 }),
    ).toThrow(RangeError);
  });

  it("rejects a component below its min", () => {
    expect(() =>
      calculateRawScore({ ...maxComponents, urgency: -1 }),
    ).toThrow(RangeError);
  });

  it("rejects a non-integer component", () => {
    expect(() =>
      calculateRawScore({ ...maxComponents, painSeverity: 7.5 }),
    ).toThrow(RangeError);
  });
});

describe("buildPenalties / calculateAdjustedScore", () => {
  it("subtracts each penalty's catalog amount from the raw score", () => {
    const penalties = buildPenalties([
      "WEAK_SPECULATIVE_EVIDENCE",
      "LONG_IMPLEMENTATION_CYCLE",
    ]);
    expect(penalties).toEqual([
      { reason: "WEAK_SPECULATIVE_EVIDENCE", amount: 15 },
      { reason: "LONG_IMPLEMENTATION_CYCLE", amount: 5 },
    ]);
    expect(calculateAdjustedScore(100, penalties)).toBe(80);
  });

  it("clamps the adjusted score to 0 rather than going negative", () => {
    const penalties = buildPenalties([
      "PROBLEM_ALREADY_SOLVED",
      "COMPANY_FINANCIALLY_UNSUITABLE",
      "SIGNIFICANT_REGULATORY_RISK",
    ]);
    expect(calculateAdjustedScore(10, penalties)).toBe(0);
  });

  it("clamps the adjusted score to 100 as an upper bound", () => {
    expect(calculateAdjustedScore(150, [])).toBe(100);
  });

  it("every catalog entry has a positive point value", () => {
    for (const amount of Object.values(PENALTY_CATALOG)) {
      expect(amount).toBeGreaterThan(0);
    }
  });
});

describe("scoreOpportunity", () => {
  it("produces raw, penalties, and adjusted score together", () => {
    const result = scoreOpportunity(maxComponents, [
      "WEAK_SPECULATIVE_EVIDENCE",
    ]);
    expect(result.rawScore).toBe(100);
    expect(result.penalties).toEqual([
      { reason: "WEAK_SPECULATIVE_EVIDENCE", amount: 15 },
    ]);
    expect(result.adjustedScore).toBe(85);
  });

  it("defaults to no penalties", () => {
    const result = scoreOpportunity(maxComponents);
    expect(result.penalties).toEqual([]);
    expect(result.adjustedScore).toBe(result.rawScore);
  });

  it("handles a realistic mid-range opportunity", () => {
    const result = scoreOpportunity(
      {
        evidenceStrength: 14,
        painSeverity: 10,
        economicImpactScore: 9,
        deliverability: 12,
        purchaseLikelihood: 6,
        speedToValue: 3,
        reachability: 4,
        demonstrability: 3,
        repeatability: 2,
        urgency: 3,
      },
      ["LONG_IMPLEMENTATION_CYCLE"],
    );
    expect(result.rawScore).toBe(66);
    expect(result.adjustedScore).toBe(61);
  });
});
