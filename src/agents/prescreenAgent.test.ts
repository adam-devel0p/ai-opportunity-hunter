import { describe, expect, it, vi } from "vitest";
import {
  buildPrescreenPrompt,
  prescreenOutputSchema,
  runPrescreenAgent,
} from "./prescreenAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const baseCompany = {
  name: "Acme Vet Clinic",
  website: "https://acme-vet.example",
  country: "US",
  industry: "veterinary",
  description: "A small independent veterinary clinic.",
  sizeEstimate: "5-20 employees",
  discoveryNotes: "Discovery reason: likely manual appointment scheduling.",
};

describe("buildPrescreenPrompt", () => {
  it("includes company details and discovery notes", () => {
    const prompt = buildPrescreenPrompt({ company: baseCompany });

    expect(prompt).toContain("Acme Vet Clinic");
    expect(prompt).toContain("https://acme-vet.example");
    expect(prompt).toContain("veterinary");
    expect(prompt).toContain("5-20 employees");
    expect(prompt).toContain("likely manual appointment scheduling");
  });

  it("falls back to 'unknown'/'none' for missing optional fields and omits notes line", () => {
    const prompt = buildPrescreenPrompt({
      company: {
        name: "Mystery Co",
        website: "https://mystery.example",
        country: null,
        industry: null,
        description: null,
        sizeEstimate: null,
        discoveryNotes: null,
      },
    });

    expect(prompt).toContain("Country: unknown");
    expect(prompt).toContain("Industry: unknown");
    expect(prompt).toContain("Size estimate: unknown");
    expect(prompt).toContain("Description (from discovery, not yet verified): none");
    expect(prompt).not.toContain("Notes from discovery");
  });

  it("appends the previous validation error on retry", () => {
    const prompt = buildPrescreenPrompt(
      { company: baseCompany },
      { previousError: "classification: Invalid enum value" },
    );
    expect(prompt).toContain("did not match the required output format");
    expect(prompt).toContain("classification: Invalid enum value");
  });

  it("always includes the WebFetch-only integrity rules", () => {
    const prompt = buildPrescreenPrompt({ company: baseCompany });
    expect(prompt).toContain("Only use the WebFetch tool");
    expect(prompt).toContain("do not invent what the");
  });
});

describe("prescreenOutputSchema", () => {
  it("accepts a well-formed prescreen output", () => {
    const result = prescreenOutputSchema.safeParse({
      classification: "PROMISING",
      reasons: ["Real, active-looking small business site."],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid classification value", () => {
    const result = prescreenOutputSchema.safeParse({
      classification: "MAYBE_NOT_A_REAL_VALUE",
      reasons: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("runPrescreenAgent", () => {
  it("invokes Claude with WebFetch only and the fast model tier by default", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ classification: "PROMISING", reasons: ["looks real"] }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    const result = await runPrescreenAgent({ company: baseCompany });

    expect(result.status).toBe("success");
    expect(invokeClaude).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.tools).toEqual(["WebFetch"]);
    expect(callArgs?.model).toBe("haiku");
  });

  it("respects a model override", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ classification: "DISCARD", reasons: ["dead site"] }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    await runPrescreenAgent({ company: baseCompany }, { model: "sonnet" });

    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.model).toBe("sonnet");
  });
});
