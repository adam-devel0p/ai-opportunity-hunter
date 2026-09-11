import { describe, expect, it } from "vitest";
import { checkExclusionRules, type ExclusionRule } from "./exclusionCheck.js";

const domainRule: ExclusionRule = {
  id: "r1",
  type: "DOMAIN",
  value: "excluded.example",
  reason: "Operator asked never to be contacted again.",
};
const industryRule: ExclusionRule = {
  id: "r2",
  type: "INDUSTRY",
  value: "gambling",
  reason: null,
};
const countryRule: ExclusionRule = {
  id: "r3",
  type: "COUNTRY",
  value: "RU",
  reason: "Out of scope for this market.",
};

describe("checkExclusionRules", () => {
  it("returns not excluded when no rule matches", () => {
    const result = checkExclusionRules([domainRule, industryRule, countryRule], {
      normalizedDomain: "fine.example",
      industry: "veterinary",
      country: "US",
    });
    expect(result.excluded).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("matches a DOMAIN rule case-insensitively", () => {
    const result = checkExclusionRules([domainRule], {
      normalizedDomain: "Excluded.Example",
      industry: null,
      country: null,
    });
    expect(result.excluded).toBe(true);
    expect(result.reason).toContain("domain");
    expect(result.reason).toContain("Operator asked never to be contacted again.");
    expect(result.rule?.id).toBe("r1");
  });

  it("matches an INDUSTRY rule case-insensitively", () => {
    const result = checkExclusionRules([industryRule], {
      normalizedDomain: "fine.example",
      industry: "Gambling",
      country: "US",
    });
    expect(result.excluded).toBe(true);
    expect(result.reason).toContain("industry");
  });

  it("matches a COUNTRY rule case-insensitively", () => {
    const result = checkExclusionRules([countryRule], {
      normalizedDomain: "fine.example",
      industry: "veterinary",
      country: "ru",
    });
    expect(result.excluded).toBe(true);
    expect(result.reason).toContain("country");
  });

  it("does not match an INDUSTRY/COUNTRY rule against a null candidate field", () => {
    const result = checkExclusionRules([industryRule, countryRule], {
      normalizedDomain: "fine.example",
      industry: null,
      country: null,
    });
    expect(result.excluded).toBe(false);
  });

  it("does not substring-match a near-miss value", () => {
    const result = checkExclusionRules([countryRule], {
      normalizedDomain: "fine.example",
      industry: null,
      country: "RUS",
    });
    expect(result.excluded).toBe(false);
  });

  it("returns the first matching rule when multiple could apply", () => {
    const result = checkExclusionRules([domainRule, industryRule], {
      normalizedDomain: "excluded.example",
      industry: "gambling",
      country: null,
    });
    expect(result.rule?.id).toBe("r1");
  });
});
