import { describe, expect, it, vi } from "vitest";
import {
  buildOutreachPrompt,
  outreachOutputSchema,
  runOutreachAgent,
  type BuildOutreachPromptInput,
} from "./outreachAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const basePromptInput: BuildOutreachPromptInput = {
  company: { name: "Northgate Recruitment" },
  opportunity: {
    problemTitle: "Slow applicant screening",
    problemDescription: "Recruiters manually check every application against role requirements.",
    proposedSolution: "Automated applicant intake and requirement-matching workflow.",
    affectedRole: "recruitment director",
  },
  offer: {
    scope: "Automated applicant intake workflow that extracts candidate details.",
    expectedOutcome: "Recruiters review a structured queue instead of raw applications.",
    demoConcept: "A sample dashboard showing three anonymized applications.",
  },
  contact: {
    name: "Jane Doe",
    role: "Recruitment Director",
    isPreferredForInitialOutreach: true,
  },
  evidence: [
    { claim: "The careers page lists 6 open roles.", classification: "FACT" },
    { claim: "Applications appear to go through a generic contact form.", classification: "INFERENCE" },
  ],
};

describe("buildOutreachPrompt", () => {
  it("includes the company, opportunity, offer, and contact content", () => {
    const prompt = buildOutreachPrompt(basePromptInput);
    expect(prompt).toContain("Northgate Recruitment");
    expect(prompt).toContain("Slow applicant screening");
    expect(prompt).toContain("Automated applicant intake workflow");
    expect(prompt).toContain("Jane Doe");
  });

  it("includes the gathered evidence with its classification", () => {
    const prompt = buildOutreachPrompt(basePromptInput);
    expect(prompt).toContain("[FACT] The careers page lists 6 open roles.");
    expect(prompt).toContain("[INFERENCE] Applications appear to go through a generic contact form.");
  });

  it("embeds spec §40's bad/good truthfulness examples verbatim", () => {
    const prompt = buildOutreachPrompt(basePromptInput);
    expect(prompt).toContain("I noticed your team spends hours doing X.");
    expect(prompt).toMatch(/I think there may be an easy automation\s+opportunity/);
  });

  it("embeds spec §39's banned-phrase examples and the never-claim-a-demo rule", () => {
    const prompt = buildOutreachPrompt(basePromptInput);
    expect(prompt).toMatch(/revolutionary AI solution/i);
    expect(prompt).toMatch(/never claim it has actually been built/i);
  });

  it("warns when the contact is not preferred for initial outreach (unconfirmed email)", () => {
    const prompt = buildOutreachPrompt({
      ...basePromptInput,
      contact: { ...basePromptInput.contact, isPreferredForInitialOutreach: false },
    });
    expect(prompt).toMatch(/not confirmed\/publicly listed/);
  });

  it("includes a regeneration block when a prior draft failed a deterministic check", () => {
    const prompt = buildOutreachPrompt(basePromptInput, {
      reason: "Body is 40 word(s) — outside the required 60-130 word range.",
    });
    expect(prompt).toContain("outside the required 60-130 word range");
  });

  it("includes a schema-validation retry block distinct from the regeneration block", () => {
    const prompt = buildOutreachPrompt(basePromptInput, undefined, {
      previousError: "Missing required field: subject",
    });
    expect(prompt).toContain("Missing required field: subject");
  });
});

describe("outreachOutputSchema", () => {
  it("accepts a well-formed subject/body pair", () => {
    expect(
      outreachOutputSchema.safeParse({ subject: "Candidate intake at ABC", body: "Hi Sarah, ..." })
        .success,
    ).toBe(true);
  });

  it("rejects a missing body", () => {
    expect(outreachOutputSchema.safeParse({ subject: "Candidate intake at ABC" }).success).toBe(false);
  });
});

describe("runOutreachAgent", () => {
  it("invokes Claude with the reasoning model tier and no tools", async () => {
    const mockInvoke = vi.mocked(invokeClaude);
    mockInvoke.mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ subject: "Candidate intake at ABC", body: "Hi Sarah, ..." }),
      raw: {},
      costUsd: 0.02,
      durationMs: 1800,
    });

    const result = await runOutreachAgent({
      company: basePromptInput.company,
      opportunity: basePromptInput.opportunity,
      offer: basePromptInput.offer,
      contact: basePromptInput.contact,
      evidence: basePromptInput.evidence,
    });

    expect(result.status).toBe("success");
    const call = mockInvoke.mock.calls[0]?.[0];
    expect(call?.tools).toEqual([]);
    expect(call?.model).toBe("sonnet");
  });
});
