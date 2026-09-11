import { describe, expect, it, vi } from "vitest";
import {
  buildSkepticPrompt,
  skepticOutputSchema,
  runSkepticAgent,
  type SkepticOpportunityInput,
} from "./skepticAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const baseOpportunity: SkepticOpportunityInput = {
  problemTitle: "Enquiry response-capacity friction",
  problemDescription:
    "Reviews suggest response delays; the FAQ's 2-day promise is a known target, but actual volume and existing automation are unknown.",
  problemCategory: "customer enquiry handling",
  economicImpact: "Potential reduction in delayed-response complaints, exact size unknown.",
  impactAssumptions: [
    { assumption: "FAQ promises replies within two business days.", isKnown: true },
    { assumption: "Assume moderate weekly enquiry volume.", isKnown: false },
  ],
  affectedRole: "front desk / reception",
  proposedSolution: "Automated enquiry classification and first-response drafting.",
  implementationStrategy: "Integrate with the existing contact form and email inbox.",
  dependencies: [],
  risks: [],
  existingAlternatives: [],
  estimatedDurationDays: 5,
  suggestedPriceMin: 600,
  suggestedPriceMax: 1500,
  recurringRevenuePossibility: null,
  validationQuestion:
    "Determine whether additional evidence supports significant enquiry volume or operational friction.",
  company: {
    name: "Acme Vet Clinic",
    industry: "veterinary",
    country: "US",
    sizeEstimate: "5-20 employees",
  },
};

const baseEvidence = [
  {
    claim: "Website sends enquiries through a general form.",
    classification: "FACT" as const,
    supportingExcerpt: "Contact us via the form below.",
    sourceUrl: "https://acme-vet.example/contact",
  },
];

describe("buildSkepticPrompt", () => {
  it("includes the opportunity content but never a confidence/score field", () => {
    const prompt = buildSkepticPrompt({ opportunity: baseOpportunity, evidence: baseEvidence });

    expect(prompt).toContain("Enquiry response-capacity friction");
    expect(prompt).toContain("Automated enquiry classification and first-response drafting.");
    expect(prompt).toContain("Acme Vet Clinic");
    // Deliberately never given the Analysis Agent's own confidence/score framing (spec §33).
    expect(prompt).not.toMatch(/scoreComponents/i);
    expect(prompt).not.toMatch(/penaltyReasons/i);
    expect(prompt).not.toMatch(/"confidence":/);
  });

  it("includes the evidence grouped by classification", () => {
    const prompt = buildSkepticPrompt({ opportunity: baseOpportunity, evidence: baseEvidence });
    expect(prompt).toContain("FACT:");
    expect(prompt).toContain("Website sends enquiries through a general form.");
    expect(prompt).toContain("https://acme-vet.example/contact");
  });

  it("handles zero evidence items honestly", () => {
    const prompt = buildSkepticPrompt({ opportunity: baseOpportunity, evidence: [] });
    expect(prompt).toContain("No evidence items are linked to this opportunity.");
  });

  it("embeds the spec §33 question list verbatim", () => {
    const prompt = buildSkepticPrompt({ opportunity: baseOpportunity, evidence: baseEvidence });
    expect(prompt).toContain("Is the main problem inferred rather than demonstrated?");
    expect(prompt).toContain("Is this another generic \"AI chatbot\" idea?");
    expect(prompt).toContain("Is there a much cheaper off-the-shelf alternative?");
  });

  it("instructs the model that its job is to find reasons the opportunity is bad, not improve it", () => {
    const prompt = buildSkepticPrompt({ opportunity: baseOpportunity, evidence: baseEvidence });
    expect(prompt).toContain("Your job is NOT to improve the sales pitch");
    expect(prompt).toContain("Be deliberately biased toward REJECT for mediocre opportunities");
  });

  it("appends the previous validation error on retry", () => {
    const prompt = buildSkepticPrompt(
      { opportunity: baseOpportunity, evidence: baseEvidence },
      { previousError: "result: Invalid enum value" },
    );
    expect(prompt).toContain("did not match the required output format");
    expect(prompt).toContain("result: Invalid enum value");
  });
});

describe("skepticOutputSchema", () => {
  it("accepts a well-formed KEEP output", () => {
    const result = skepticOutputSchema.safeParse({
      result: "KEEP",
      adjustedConfidence: 0.6,
      weaknesses: ["Volume is unconfirmed."],
      unsupportedAssumptions: [],
      missingInformation: ["Actual enquiry volume."],
      dealkillers: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a confidence outside 0-1", () => {
    const result = skepticOutputSchema.safeParse({
      result: "REJECT",
      adjustedConfidence: 1.5,
      weaknesses: [],
      unsupportedAssumptions: [],
      missingInformation: [],
      dealkillers: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid result value", () => {
    const result = skepticOutputSchema.safeParse({
      result: "MAYBE",
      adjustedConfidence: 0.5,
      weaknesses: [],
      unsupportedAssumptions: [],
      missingInformation: [],
      dealkillers: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("runSkepticAgent", () => {
  it("invokes Claude with no tools and the reasoning model tier by default", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({
        result: "KEEP",
        adjustedConfidence: 0.6,
        weaknesses: [],
        unsupportedAssumptions: [],
        missingInformation: [],
        dealkillers: [],
      }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    const result = await runSkepticAgent({ opportunity: baseOpportunity, evidence: baseEvidence });

    expect(result.status).toBe("success");
    expect(invokeClaude).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.tools).toEqual([]);
    expect(callArgs?.model).toBe("sonnet");
  });

  it("respects a model override", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({
        result: "REJECT",
        adjustedConfidence: 0.2,
        weaknesses: [],
        unsupportedAssumptions: [],
        missingInformation: [],
        dealkillers: [],
      }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    await runSkepticAgent({ opportunity: baseOpportunity, evidence: baseEvidence }, { model: "opus" });

    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.model).toBe("opus");
  });
});
