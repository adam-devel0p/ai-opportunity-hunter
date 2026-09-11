import { describe, expect, it, vi } from "vitest";
import {
  buildContactPrompt,
  contactOutputSchema,
  runContactAgent,
  type ContactAgentCompanyInput,
  type ContactAgentOpportunityInput,
} from "./contactAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const baseCompany: ContactAgentCompanyInput = {
  name: "Northgate Recruitment",
  website: "https://northgate-recruitment.example",
  industry: "recruitment",
  country: "UK",
  sizeEstimate: "10-20 employees",
};

const baseOpportunity: ContactAgentOpportunityInput = {
  problemTitle: "Slow applicant screening",
  problemDescription: "Recruiters manually check every application against role requirements.",
  affectedRole: "recruitment director",
};

describe("buildContactPrompt", () => {
  it("includes the company and opportunity content", () => {
    const prompt = buildContactPrompt({ company: baseCompany, opportunity: baseOpportunity });
    expect(prompt).toContain("Northgate Recruitment");
    expect(prompt).toContain("Slow applicant screening");
    expect(prompt).toContain("recruitment director");
  });

  it("includes spec §37's preferred contact roles list", () => {
    const prompt = buildContactPrompt({ company: baseCompany, opportunity: baseOpportunity });
    expect(prompt).toContain("owner");
    expect(prompt).toContain("practice manager");
    expect(prompt).toContain("recruitment director");
  });

  it("embeds the never-invent-a-name/email integrity rules", () => {
    const prompt = buildContactPrompt({ company: baseCompany, opportunity: baseOpportunity });
    expect(prompt).toMatch(/never invent a person's name/i);
    expect(prompt).toMatch(/never invent an email address/i);
    expect(prompt).toMatch(/never represent a guessed email as verified/i);
  });

  it("includes a schema-validation retry block when given one", () => {
    const prompt = buildContactPrompt(
      { company: baseCompany, opportunity: baseOpportunity },
      { previousError: "Missing required field: emailConfidence" },
    );
    expect(prompt).toContain("Missing required field: emailConfidence");
  });
});

describe("contactOutputSchema", () => {
  const validPubliclyListed = {
    name: "Jane Doe",
    role: "Recruitment Director",
    source: "Fetched from the company's team page.",
    profileUrl: "https://northgate-recruitment.example/team/jane-doe",
    email: "jane.doe@northgate-recruitment.example",
    emailSource: "Listed on the team page.",
    emailConfidence: "PUBLICLY_LISTED" as const,
  };

  it("accepts a well-formed PUBLICLY_LISTED output", () => {
    expect(contactOutputSchema.safeParse(validPubliclyListed).success).toBe(true);
  });

  it("accepts a well-formed UNKNOWN output with a null email", () => {
    const result = contactOutputSchema.safeParse({
      ...validPubliclyListed,
      email: null,
      emailSource: null,
      emailConfidence: "UNKNOWN",
    });
    expect(result.success).toBe(true);
  });

  it("accepts GUESSED and VERIFIED with a non-null email", () => {
    for (const emailConfidence of ["GUESSED", "VERIFIED"] as const) {
      const result = contactOutputSchema.safeParse({ ...validPubliclyListed, emailConfidence });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a null email paired with a non-UNKNOWN confidence", () => {
    const result = contactOutputSchema.safeParse({
      ...validPubliclyListed,
      email: null,
      emailSource: null,
      emailConfidence: "GUESSED",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-null email paired with UNKNOWN confidence", () => {
    const result = contactOutputSchema.safeParse({
      ...validPubliclyListed,
      emailConfidence: "UNKNOWN",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email string", () => {
    const result = contactOutputSchema.safeParse({ ...validPubliclyListed, email: "not-an-email" });
    expect(result.success).toBe(false);
  });
});

describe("runContactAgent", () => {
  it("invokes Claude with the fast model tier and WebSearch+WebFetch tools", async () => {
    const mockInvoke = vi.mocked(invokeClaude);
    mockInvoke.mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({
        name: "Jane Doe",
        role: "Recruitment Director",
        source: "Fetched from the company's team page.",
        profileUrl: null,
        email: null,
        emailSource: null,
        emailConfidence: "UNKNOWN",
      }),
      raw: {},
      costUsd: 0.01,
      durationMs: 1500,
    });

    const result = await runContactAgent({ company: baseCompany, opportunity: baseOpportunity });

    expect(result.status).toBe("success");
    const call = mockInvoke.mock.calls[0]?.[0];
    expect(call?.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(call?.model).toBe("haiku");
  });
});
