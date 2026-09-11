import { describe, expect, it } from "vitest";
import { lintOfferScope } from "./offerLint.js";

describe("lintOfferScope", () => {
  it("catches spec §34's exact bad example", () => {
    const result = lintOfferScope("AI automation services.");
    expect(result.vague).toBe(true);
    expect(result.reason).toMatch(/blocklist/);
  });

  it("catches close variants of the bad example", () => {
    expect(lintOfferScope("AI solutions").vague).toBe(true);
    expect(lintOfferScope("Digital transformation services.").vague).toBe(true);
    expect(lintOfferScope("AI chatbot solution").vague).toBe(true);
    expect(lintOfferScope("  automation services  ").vague).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(lintOfferScope("ai automation services.").vague).toBe(true);
  });

  it("catches an unlisted but too-short scope via the word-count floor", () => {
    const result = lintOfferScope("Smart AI stuff for your business.");
    expect(result.vague).toBe(true);
    expect(result.reason).toMatch(/word/);
  });

  it("passes spec §34's exact good example", () => {
    const result = lintOfferScope(
      "Automated applicant intake workflow that extracts candidate details, checks them against role requirements, and creates a structured recruiter review queue.",
    );
    expect(result.vague).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("does not flag a longer scope that merely mentions a blocklisted phrase as part of it", () => {
    const result = lintOfferScope(
      "Beyond generic AI automation services, this builds a specific invoice-matching pipeline against the existing accounting export.",
    );
    expect(result.vague).toBe(false);
  });
});
