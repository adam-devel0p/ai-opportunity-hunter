import { describe, expect, it, vi } from "vitest";
import {
  buildOpportunityAnalysisPrompt,
  opportunityAnalysisOutputSchema,
  runOpportunityAnalysisAgent,
} from "./opportunityAnalysisAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const baseCompany = {
  name: "Acme Vet Clinic",
  website: "https://acme-vet.example",
  country: "US",
  industry: "veterinary",
  businessType: "clinic",
  description: "A small independent veterinary clinic.",
  sizeEstimate: "5-20 employees",
  priorNotes: "Research candidate problems: manual appointment scheduling.",
};

const wellFormedOutput = {
  problemTitle: "Manual enquiry triage",
  problemDescription: "Enquiries arrive through a general contact form with no visible triage.",
  problemCategory: "customer enquiry handling",
  economicImpact: "Potential staff time savings from faster, more consistent enquiry handling.",
  impactAssumptions: [
    { assumption: "FAQ promises replies within two business days.", isKnown: true },
    { assumption: "Assume ~5 hours/week spent manually triaging enquiries.", isKnown: false },
  ],
  affectedRole: "front desk / reception",
  proposedSolution: "Automated enquiry classification and first-response drafting.",
  implementationStrategy: "Integrate with the existing contact form and email inbox.",
  dependencies: ["Access to the contact form's email destination"],
  risks: ["Low actual enquiry volume could make this uneconomical"],
  existingAlternatives: ["Generic email-triage SaaS tools"],
  estimatedDurationDays: 5,
  suggestedPriceMin: 500,
  suggestedPriceMax: 1200,
  recurringRevenuePossibility: "Optional monthly monitoring retainer",
  demoConcept: "A short demo classifying 10 sample enquiries",
  confidence: 0.6,
  validationQuestion: "Does the business receive enough enquiry volume for this to matter?",
  scoreComponents: {
    evidenceStrength: 10,
    painSeverity: 8,
    economicImpactScore: 7,
    deliverability: 12,
    purchaseLikelihood: 5,
    speedToValue: 3,
    reachability: 3,
    demonstrability: 4,
    repeatability: 3,
    urgency: 2,
  },
  penaltyReasons: ["WEAK_SPECULATIVE_EVIDENCE"],
};

describe("buildOpportunityAnalysisPrompt", () => {
  it("includes company details and grouped evidence by classification", () => {
    const prompt = buildOpportunityAnalysisPrompt({
      company: baseCompany,
      evidence: [
        {
          claim: "Website sends enquiries through a general form.",
          classification: "FACT",
          supportingExcerpt: "Contact us via the form below.",
          confidence: 0.9,
          sourceUrl: "https://acme-vet.example/contact",
        },
        {
          claim: "Actual incoming volume is unknown.",
          classification: "UNKNOWN",
          supportingExcerpt: null,
          confidence: 0.2,
          sourceUrl: "https://acme-vet.example/contact",
        },
      ],
    });

    expect(prompt).toContain("Acme Vet Clinic");
    expect(prompt).toContain("https://acme-vet.example");
    expect(prompt).toContain("FACT:");
    expect(prompt).toContain("Website sends enquiries through a general form.");
    expect(prompt).toContain("UNKNOWN:");
    expect(prompt).toContain("Actual incoming volume is unknown.");
    // FACT block appears before UNKNOWN block (classification order).
    expect(prompt.indexOf("FACT:")).toBeLessThan(prompt.indexOf("UNKNOWN:"));
  });

  it("honestly flags empty evidence rather than omitting the section", () => {
    const prompt = buildOpportunityAnalysisPrompt({ company: baseCompany, evidence: [] });
    expect(prompt).toContain("No evidence items were recorded for this company");
  });

  it("bakes in the §88/§89 integrity rules verbatim", () => {
    const prompt = buildOpportunityAnalysisPrompt({ company: baseCompany, evidence: [] });
    expect(prompt).toContain(
      "they probably process hundreds of leads manually and need an AI chatbot",
    );
    expect(prompt).toContain('"isKnown": true only if it is directly');
  });

  it("includes the scoring component guide and penalty catalog", () => {
    const prompt = buildOpportunityAnalysisPrompt({ company: baseCompany, evidence: [] });
    expect(prompt).toContain('"evidenceStrength" (0-20)');
    expect(prompt).toContain('"urgency" (0-5)');
    expect(prompt).toContain('"PROBLEM_ALREADY_SOLVED"');
  });

  it("appends the previous validation error on retry", () => {
    const prompt = buildOpportunityAnalysisPrompt(
      { company: baseCompany, evidence: [] },
      { previousError: "scoreComponents.evidenceStrength: Expected integer" },
    );
    expect(prompt).toContain("did not match the required output format");
    expect(prompt).toContain("scoreComponents.evidenceStrength");
  });
});

describe("opportunityAnalysisOutputSchema", () => {
  it("accepts a well-formed output", () => {
    const result = opportunityAnalysisOutputSchema.safeParse(wellFormedOutput);
    expect(result.success).toBe(true);
  });

  it("rejects a score component out of range", () => {
    const result = opportunityAnalysisOutputSchema.safeParse({
      ...wellFormedOutput,
      scoreComponents: { ...wellFormedOutput.scoreComponents, evidenceStrength: 25 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer score component", () => {
    const result = opportunityAnalysisOutputSchema.safeParse({
      ...wellFormedOutput,
      scoreComponents: { ...wellFormedOutput.scoreComponents, painSeverity: 7.5 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid penalty reason", () => {
    const result = opportunityAnalysisOutputSchema.safeParse({
      ...wellFormedOutput,
      penaltyReasons: ["NOT_A_REAL_REASON"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty penaltyReasons array", () => {
    const result = opportunityAnalysisOutputSchema.safeParse({
      ...wellFormedOutput,
      penaltyReasons: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects suggestedPriceMax below suggestedPriceMin", () => {
    const result = opportunityAnalysisOutputSchema.safeParse({
      ...wellFormedOutput,
      suggestedPriceMin: 1000,
      suggestedPriceMax: 500,
    });
    expect(result.success).toBe(false);
  });

  it("silently strips a bogus model-supplied rawScore/adjustedScore field rather than trusting it", () => {
    const result = opportunityAnalysisOutputSchema.safeParse({
      ...wellFormedOutput,
      rawScore: 999,
      adjustedScore: 999,
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("rawScore");
    expect(result.data).not.toHaveProperty("adjustedScore");
  });
});

describe("runOpportunityAnalysisAgent", () => {
  it("invokes Claude with no tools and the reasoning model tier by default", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify(wellFormedOutput),
      raw: {},
      costUsd: 0.02,
      durationMs: 1000,
    });

    const result = await runOpportunityAnalysisAgent({ company: baseCompany, evidence: [] });

    expect(result.status).toBe("success");
    expect(invokeClaude).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.tools).toEqual([]);
    expect(callArgs?.model).toBe("sonnet");
  });

  it("respects a model override", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify(wellFormedOutput),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    await runOpportunityAnalysisAgent(
      { company: baseCompany, evidence: [] },
      { model: "opus" },
    );

    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.model).toBe("opus");
  });
});
