/**
 * Discovery Agent (docs/AGENT_CONTRACTS.md §1, spec §14-17). Finds real, existing businesses
 * matching a campaign's criteria — it does NOT diagnose problems or judge fit; that's Phase 4
 * (Pre-Screening) and later. Uses the "fast" model tier per spec §52's explicit example
 * ("discovery" is listed under the lower-cost/faster model column).
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import type { DiscoveryCampaignCriteria } from "../db/schema.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";

export const discoveryCompanySchema = z.object({
  name: z.string(),
  website: z.string().url(),
  country: z.string(),
  industry: z.string(),
  description: z.string(),
  sizeEstimate: z.string().nullable(),
  reasonToScreen: z.string(),
});

export const discoveryOutputSchema = z.object({
  companies: z.array(discoveryCompanySchema),
});

export type DiscoveryCompany = z.infer<typeof discoveryCompanySchema>;
export type DiscoveryOutput = z.infer<typeof discoveryOutputSchema>;

/**
 * Hand-mirrored JSON Schema for `discoveryOutputSchema`, passed as `--json-schema` (ADR-0007
 * — a first line of defense only; Zod validation via `runStructuredAgent` remains the source
 * of truth). Keep in sync by hand, same convention as `schemas/deepResearchSpike.ts`.
 */
export const discoveryJsonSchema = {
  type: "object",
  properties: {
    companies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          website: { type: "string" },
          country: { type: "string" },
          industry: { type: "string" },
          description: { type: "string" },
          sizeEstimate: { type: ["string", "null"] },
          reasonToScreen: { type: "string" },
        },
        required: [
          "name",
          "website",
          "country",
          "industry",
          "description",
          "sizeEstimate",
          "reasonToScreen",
        ],
      },
    },
  },
  required: ["companies"],
} as const;

/** Default number of companies to ask for per discovery run when the caller doesn't specify. */
export const DEFAULT_DISCOVERY_TARGET_COUNT = 8;

const DISCOVERY_INTEGRITY_RULES = `
Discovery integrity rules — these are not negotiable, follow them exactly:
- Every company you return must be real. You must have found genuine evidence it exists (a
  working website, a business directory or registry listing, a news mention, etc.) via
  WebSearch/WebFetch.
- Never invent a company name, website URL, location, or description. Do not "fill in" a
  plausible-sounding business to reach the target count.
- If you cannot find enough real, distinct businesses matching the criteria, return fewer
  companies rather than inventing ones.
- Do not return a company already listed in "companies already known for this campaign" below
  (matching by domain) — that list exists to help you avoid rediscovering the same business,
  though it is not guaranteed exhaustive.
- This step only identifies candidate businesses to screen later. Do not diagnose their
  problems or judge whether they're a good fit here — just capture identity and a short reason
  they might be worth screening.
`.trim();

export interface BuildDiscoveryPromptInput {
  campaignName: string;
  criteria: DiscoveryCampaignCriteria;
  knownDomains: readonly string[];
  targetCount: number;
}

export function buildDiscoveryPrompt(
  input: BuildDiscoveryPromptInput,
  retry?: { previousError: string },
): string {
  const criteriaLines = [
    input.criteria.geography?.length
      ? `- Geography: ${input.criteria.geography.join(", ")}`
      : null,
    input.criteria.industry?.length
      ? `- Industry: ${input.criteria.industry.join(", ")}`
      : null,
    input.criteria.sizeRange ? `- Company size: ${input.criteria.sizeRange}` : null,
    input.criteria.keywords?.length
      ? `- Keywords: ${input.criteria.keywords.join(", ")}`
      : null,
    input.criteria.hypothesis
      ? `- Opportunity hypothesis (context only, not a requirement to satisfy yet): ${input.criteria.hypothesis}`
      : null,
  ].filter((line): line is string => line !== null);

  const knownDomainsBlock =
    input.knownDomains.length > 0
      ? `Companies already known for this campaign (avoid rediscovering these):\n${input.knownDomains
          .map((domain) => `- ${domain}`)
          .join("\n")}`
      : "No companies are known for this campaign yet.";

  const retryBlock = retry
    ? `\nYour previous response did not match the required output format. Fix this and try again:\n${retry.previousError}\n`
    : "";

  return `
You are the Discovery Agent for a small-business sales-opportunity pipeline. Your only job
right now is to find up to ${input.targetCount} real, distinct businesses matching this
discovery campaign — not to research or diagnose them.

Campaign: "${input.campaignName}"
${criteriaLines.length > 0 ? criteriaLines.join("\n") : "(no further criteria specified)"}

${knownDomainsBlock}

Use WebSearch and WebFetch to find real candidate businesses (business directories, search
results, local listings, industry association pages, etc.). For each one, produce a JSON
object with:

- "name": canonical company name.
- "website": the company's website URL.
- "country": country/location.
- "industry": industry/category.
- "description": a short, factual description of the business.
- "sizeEstimate": approximate company size if you found any indication (e.g. "5-20 employees"),
  otherwise null.
- "reasonToScreen": one sentence on why this business might be worth screening for this
  campaign.

Return a JSON object: { "companies": [...] }.

${DISCOVERY_INTEGRITY_RULES}
${retryBlock}`.trim();
}

export interface RunDiscoveryAgentInput {
  campaignName: string;
  criteria: DiscoveryCampaignCriteria;
  knownDomains: readonly string[];
  targetCount?: number;
}

export interface RunDiscoveryAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runDiscoveryAgent(
  input: RunDiscoveryAgentInput,
  overrides: RunDiscoveryAgentOverrides = {},
): Promise<StructuredAgentResult<DiscoveryOutput>> {
  const targetCount = input.targetCount ?? DEFAULT_DISCOVERY_TARGET_COUNT;

  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("fast"),
    tools: ["WebSearch", "WebFetch"],
    jsonSchema: discoveryJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 5 * 60 * 1000,
    schema: discoveryOutputSchema,
    buildPrompt: (retry) =>
      buildDiscoveryPrompt(
        {
          campaignName: input.campaignName,
          criteria: input.criteria,
          knownDomains: input.knownDomains,
          targetCount,
        },
        retry,
      ),
  });
}
