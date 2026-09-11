import { describe, expect, it, vi } from "vitest";
import { formatPricingBandGuide } from "../lib/pricing.js";
import {
  buildOfferBuilderPrompt,
  offerBuilderOutputSchema,
  runOfferBuilderAgent,
  type OfferBuilderOpportunityInput,
} from "./offerBuilderAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const baseOpportunity: OfferBuilderOpportunityInput = {
  problemTitle: "Slow applicant screening",
  problemDescription: "Recruiters manually check every application against role requirements.",
  problemCategory: "recruitment operations",
  economicImpact: "Estimated 5 hours/week of recruiter time on manual screening.",
  affectedRole: "recruitment director",
  proposedSolution: "Automated applicant intake and requirement-matching workflow.",
  implementationStrategy: "Integrate with the existing application form and ATS export.",
  dependencies: ["Access to the ATS export format"],
  risks: ["ATS export format may change without notice"],
  existingAlternatives: ["Fully manual review (current state)"],
  estimatedDurationDays: 2,
  suggestedPriceMin: 900,
  suggestedPriceMax: 1800,
  recurringRevenuePossibility: null,
  demoConcept: null,
  adjustedScore: 82,
  verifierConfidence: 0.7,
  company: {
    name: "Northgate Recruitment",
    industry: "recruitment",
    country: "UK",
    sizeEstimate: "10-20 employees",
  },
};

describe("buildOfferBuilderPrompt", () => {
  it("includes the opportunity content and the pricing band guide", () => {
    const prompt = buildOfferBuilderPrompt({
      opportunity: baseOpportunity,
      pricingBandGuide: formatPricingBandGuide(),
    });
    expect(prompt).toContain("Slow applicant screening");
    expect(prompt).toContain("Northgate Recruitment");
    expect(prompt).toContain("WORKFLOW_IMPLEMENTATION");
  });

  it("embeds spec §34's bad and good examples verbatim", () => {
    const prompt = buildOfferBuilderPrompt({
      opportunity: baseOpportunity,
      pricingBandGuide: formatPricingBandGuide(),
    });
    expect(prompt).toContain("AI automation services.");
    expect(prompt).toContain(
      "Automated applicant intake workflow that extracts candidate details, checks them against role requirements, and creates a structured recruiter review queue.",
    );
  });

  it("embeds spec §36's never-claim-a-demo-exists rule", () => {
    const prompt = buildOfferBuilderPrompt({
      opportunity: baseOpportunity,
      pricingBandGuide: formatPricingBandGuide(),
    });
    expect(prompt).toMatch(/never claim the demo has actually been built/i);
  });

  it("includes a regeneration block when a prior offer was lint-rejected", () => {
    const prompt = buildOfferBuilderPrompt(
      { opportunity: baseOpportunity, pricingBandGuide: formatPricingBandGuide() },
      { reason: "Scope matched the vague-offer blocklist." },
    );
    expect(prompt).toContain("Scope matched the vague-offer blocklist.");
  });

  it("includes a schema-validation retry block distinct from the regeneration block", () => {
    const prompt = buildOfferBuilderPrompt(
      { opportunity: baseOpportunity, pricingBandGuide: formatPricingBandGuide() },
      undefined,
      { previousError: "Missing required field: price" },
    );
    expect(prompt).toContain("Missing required field: price");
  });
});

describe("offerBuilderOutputSchema", () => {
  const validOutput = {
    scope: "Automated applicant intake workflow that extracts candidate details from submissions.",
    expectedOutcome: "Recruiters review a structured queue instead of raw applications.",
    keyAssumptions: ["ATS export format stays stable"],
    durationEstimate: "2 days",
    price: 1400,
    recurringPrice: null,
    exclusions: "Does not include ATS replacement or migration.",
    validationNeeded: "Confirm export format with the recruitment director.",
    demoConcept: "A sample dashboard showing three anonymized applications processed end to end.",
    whyCommerciallyAttractive: "Directly reduces recruiter hours on a recurring weekly task.",
    priceJustification: null,
  };

  it("accepts a well-formed output", () => {
    expect(offerBuilderOutputSchema.safeParse(validOutput).success).toBe(true);
  });

  it("rejects a zero recurringPrice (must be null, not zero, when there is none)", () => {
    const result = offerBuilderOutputSchema.safeParse({ ...validOutput, recurringPrice: 0 });
    expect(result.success).toBe(false);
  });

  it("accepts a positive recurringPrice", () => {
    const result = offerBuilderOutputSchema.safeParse({ ...validOutput, recurringPrice: 150 });
    expect(result.success).toBe(true);
  });
});

describe("runOfferBuilderAgent", () => {
  it("invokes Claude with the reasoning model tier and no tools", async () => {
    const mockInvoke = vi.mocked(invokeClaude);
    mockInvoke.mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({
        scope: "Automated applicant intake workflow that extracts candidate details from submissions.",
        expectedOutcome: "Recruiters review a structured queue instead of raw applications.",
        keyAssumptions: [],
        durationEstimate: "2 days",
        price: 1400,
        recurringPrice: null,
        exclusions: "None beyond scope.",
        validationNeeded: "Confirm export format.",
        demoConcept: "A sample dashboard.",
        whyCommerciallyAttractive: "Saves recurring recruiter hours.",
        priceJustification: null,
      }),
      raw: {},
      costUsd: 0.03,
      durationMs: 2000,
    });

    const result = await runOfferBuilderAgent({
      opportunity: baseOpportunity,
      pricingBandGuide: formatPricingBandGuide(),
    });

    expect(result.status).toBe("success");
    const call = mockInvoke.mock.calls[0]?.[0];
    expect(call?.tools).toEqual([]);
    expect(call?.model).toBe("sonnet");
  });
});
