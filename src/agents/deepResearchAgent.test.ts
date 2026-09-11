import { describe, expect, it, vi } from "vitest";
import {
  buildDeepResearchPrompt,
  deepResearchOutputSchema,
  runDeepResearchAgent,
} from "./deepResearchAgent.js";
import { invokeClaude } from "./claudeClient.js";
import { SOURCE_CAPTURE_HOOK_ENV } from "./sourceCaptureHook.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const baseCompany = {
  name: "Acme Vet Clinic",
  website: "https://acme-vet.example",
  country: "US",
  region: null,
  industry: "veterinary",
  businessType: null,
  description: "A small independent veterinary clinic.",
  sizeEstimate: "5-20 employees",
  priorNotes: "Discovery reason: likely manual appointment scheduling.\nPrescreen (PROMISING): live site.",
};

describe("buildDeepResearchPrompt", () => {
  it("includes company details and prior notes", () => {
    const prompt = buildDeepResearchPrompt({ company: baseCompany });
    expect(prompt).toContain("Acme Vet Clinic");
    expect(prompt).toContain("https://acme-vet.example");
    expect(prompt).toContain("veterinary");
    expect(prompt).toContain("5-20 employees");
    expect(prompt).toContain("likely manual appointment scheduling");
  });

  it("falls back to 'unknown'/'none' for missing optional fields and omits the notes/region/business type lines", () => {
    const prompt = buildDeepResearchPrompt({
      company: {
        name: "Mystery Co",
        website: "https://mystery.example",
        country: null,
        region: null,
        industry: null,
        businessType: null,
        sizeEstimate: null,
        description: null,
        priorNotes: null,
      },
    });
    expect(prompt).toContain("Country: unknown");
    expect(prompt).toContain("Industry: unknown");
    expect(prompt).toContain("Size estimate: unknown");
    expect(prompt).toContain("Description (from earlier pipeline stages, not yet verified): none");
    expect(prompt).not.toContain("Region:");
    expect(prompt).not.toContain("Business type:");
    expect(prompt).not.toContain("Notes from earlier pipeline stages");
  });

  it("appends the previous validation error on retry", () => {
    const prompt = buildDeepResearchPrompt(
      { company: baseCompany },
      { previousError: "evidence.0.classification: Invalid enum value" },
    );
    expect(prompt).toContain("did not match the required output format");
    expect(prompt).toContain("evidence.0.classification: Invalid enum value");
  });

  it("bakes in the spec §24 research integrity rules verbatim", () => {
    const prompt = buildDeepResearchPrompt({ company: baseCompany });
    expect(prompt).toContain("Do not invent facts.");
    expect(prompt).toContain("Do not invent quotes.");
    expect(prompt).toContain("Do not invent employee counts.");
    expect(prompt).toContain("Do not invent revenue.");
    expect(prompt).toContain("Do not invent technologies.");
    expect(prompt).toContain("Do not invent customer volumes.");
    expect(prompt).toContain("Do not invent staff workload.");
    expect(prompt).toContain("Do not invent emails.");
    expect(prompt).toContain(
      "Do not claim that something is manual merely because automation is not visible.",
    );
    expect(prompt).toContain(
      "Do not claim a business lacks a system merely because the system is not publicly visible.",
    );
    expect(prompt).toContain("Do not claim a financial loss unless there is supporting evidence.");
    expect(prompt).toContain("When information cannot be established, record it as unknown.");
  });

  it("includes the tool-denial fabrication guard and the sourceUrl provenance rule", () => {
    const prompt = buildDeepResearchPrompt({ company: baseCompany });
    expect(prompt).toContain("never\n  fall back to answering from general/training-data knowledge");
    expect(prompt).toContain("must be a page you actually fetched with WebFetch");
  });

  it("frames research as problem-oriented, not AI-oriented", () => {
    const prompt = buildDeepResearchPrompt({ company: baseCompany });
    expect(prompt).toContain("not \"where could we add AI.\"");
  });
});

describe("deepResearchOutputSchema", () => {
  it("accepts a well-formed output", () => {
    const result = deepResearchOutputSchema.safeParse({
      evidence: [
        {
          claim: "The homepage lists a contact form as the only way to request a quote.",
          classification: "FACT",
          supportingExcerpt: "Request a quote via our contact form.",
          sourceUrl: "https://acme-vet.example/contact",
          confidence: 0.9,
        },
      ],
      candidateProblems: ["Manual quote request handling"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid classification value", () => {
    const result = deepResearchOutputSchema.safeParse({
      evidence: [
        {
          claim: "x",
          classification: "CONFIRMED",
          supportingExcerpt: "x",
          sourceUrl: "https://acme-vet.example",
          confidence: 0.5,
        },
      ],
      candidateProblems: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL sourceUrl", () => {
    const result = deepResearchOutputSchema.safeParse({
      evidence: [
        {
          claim: "x",
          classification: "FACT",
          supportingExcerpt: "x",
          sourceUrl: "not-a-url",
          confidence: 0.5,
        },
      ],
      candidateProblems: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    const result = deepResearchOutputSchema.safeParse({
      evidence: [
        {
          claim: "x",
          classification: "FACT",
          supportingExcerpt: "x",
          sourceUrl: "https://acme-vet.example",
          confidence: 1.5,
        },
      ],
      candidateProblems: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("runDeepResearchAgent", () => {
  it("invokes Claude with WebSearch+WebFetch, the reasoning model tier, and the source-capture hook wired via settings/extraEnv", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ evidence: [], candidateProblems: [] }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    const result = await runDeepResearchAgent({
      company: baseCompany,
      dbPath: "/tmp/aoh-test.db",
      companyId: "company-1",
      taskId: "wi-1",
    });

    expect(result.status).toBe("success");
    expect(invokeClaude).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(callArgs?.model).toBe("sonnet");

    const settings = callArgs?.settings as {
      hooks: { PostToolUse: Array<{ matcher: string }> };
    };
    expect(settings.hooks.PostToolUse[0]?.matcher).toBe("WebFetch");

    expect(callArgs?.extraEnv?.[SOURCE_CAPTURE_HOOK_ENV.DB_PATH]).toBe("/tmp/aoh-test.db");
    expect(callArgs?.extraEnv?.[SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]).toBe("company-1");
    expect(callArgs?.extraEnv?.[SOURCE_CAPTURE_HOOK_ENV.TASK_ID]).toBe("wi-1");
  });

  it("respects a model override", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ evidence: [], candidateProblems: [] }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    await runDeepResearchAgent(
      { company: baseCompany, dbPath: "/tmp/aoh-test.db", companyId: "company-1", taskId: "wi-1" },
      { model: "opus" },
    );

    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.model).toBe("opus");
  });
});
