import { describe, expect, it, vi } from "vitest";
import {
  buildDiscoveryPrompt,
  discoveryOutputSchema,
  runDiscoveryAgent,
} from "./discoveryAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

describe("buildDiscoveryPrompt", () => {
  it("includes campaign name, criteria, and known domains", () => {
    const prompt = buildDiscoveryPrompt({
      campaignName: "UK recruitment agencies",
      criteria: {
        geography: ["UK"],
        industry: ["recruitment"],
        sizeRange: "5-50 employees",
        keywords: ["staffing"],
        hypothesis: "manual candidate screening",
      },
      knownDomains: ["already-known.example"],
      targetCount: 5,
    });

    expect(prompt).toContain("UK recruitment agencies");
    expect(prompt).toContain("Geography: UK");
    expect(prompt).toContain("Industry: recruitment");
    expect(prompt).toContain("5-50 employees");
    expect(prompt).toContain("staffing");
    expect(prompt).toContain("already-known.example");
    expect(prompt).toContain("up to 5 real, distinct businesses");
  });

  it("states no companies are known when the list is empty", () => {
    const prompt = buildDiscoveryPrompt({
      campaignName: "test",
      criteria: {},
      knownDomains: [],
      targetCount: 8,
    });
    expect(prompt).toContain("No companies are known for this campaign yet.");
  });

  it("appends the previous validation error on retry", () => {
    const prompt = buildDiscoveryPrompt(
      { campaignName: "test", criteria: {}, knownDomains: [], targetCount: 8 },
      { previousError: "companies[0].website: Invalid url" },
    );
    expect(prompt).toContain("did not match the required output format");
    expect(prompt).toContain("companies[0].website: Invalid url");
  });

  it("always includes the never-invent-a-company integrity rules", () => {
    const prompt = buildDiscoveryPrompt({
      campaignName: "test",
      criteria: {},
      knownDomains: [],
      targetCount: 8,
    });
    expect(prompt).toContain("Never invent a company name, website URL, location");
  });
});

describe("discoveryOutputSchema", () => {
  it("accepts a well-formed discovery output", () => {
    const result = discoveryOutputSchema.safeParse({
      companies: [
        {
          name: "Acme Ltd",
          website: "https://acme.example",
          country: "UK",
          industry: "recruitment",
          description: "A recruitment agency.",
          sizeEstimate: "5-20 employees",
          reasonToScreen: "Looks like a small agency with manual processes.",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a company with an invalid website URL", () => {
    const result = discoveryOutputSchema.safeParse({
      companies: [
        {
          name: "Acme Ltd",
          website: "not-a-url",
          country: "UK",
          industry: "recruitment",
          description: "A recruitment agency.",
          sizeEstimate: null,
          reasonToScreen: "reason",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("runDiscoveryAgent", () => {
  it("invokes Claude with WebSearch/WebFetch tools and the fast model tier by default", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ companies: [] }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    const result = await runDiscoveryAgent({
      campaignName: "test campaign",
      criteria: {},
      knownDomains: [],
    });

    expect(result.status).toBe("success");
    expect(invokeClaude).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(callArgs?.model).toBe("haiku");
  });

  it("respects a model override", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ companies: [] }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    await runDiscoveryAgent(
      { campaignName: "test", criteria: {}, knownDomains: [] },
      { model: "sonnet" },
    );

    const callArgs = vi.mocked(invokeClaude).mock.calls[0]?.[0];
    expect(callArgs?.model).toBe("sonnet");
  });
});
