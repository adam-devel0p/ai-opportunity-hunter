import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS,
  computeNextEligibleResearchAt,
} from "./researchFreshness.js";

describe("computeNextEligibleResearchAt", () => {
  it("adds the default window to now", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const result = computeNextEligibleResearchAt(now);
    expect(result.getTime()).toBe(now.getTime() + DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS);
  });

  it("respects a custom window", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const oneDayMs = 24 * 60 * 60 * 1000;
    const result = computeNextEligibleResearchAt(now, oneDayMs);
    expect(result.getTime()).toBe(now.getTime() + oneDayMs);
  });
});
