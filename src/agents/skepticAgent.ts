/**
 * Skeptical Verification Agent (docs/AGENT_CONTRACTS.md §5, spec §33). A fresh-context
 * adversarial pass over an already-formed opportunity: its job is NOT to improve the pitch, it
 * is to try to disprove it. Deliberately given the opportunity's factual content and its
 * underlying evidence only — never the Opportunity Analysis Agent's own `confidence`,
 * `scoreComponents`, or `penaltyReasons` (its own judgment framing), so this pass forms an
 * independent view rather than anchoring on the first agent's confidence (spec §33's "fresh
 * context" requirement, `src/pipeline/verifyHandler.ts` enforces this by simply never reading
 * those fields off the opportunity/evaluation rows into this agent's input).
 *
 * Uses only what Deep Research + Opportunity Analysis already gathered — no tools, same
 * reasoning as Opportunity Analysis Agent (ADR-0013 part 4): there is nothing left to fetch or
 * search, this is judgment over existing material.
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";

export const skepticOutputSchema = z.object({
  result: z.enum(["KEEP", "REJECT"]),
  adjustedConfidence: z.number().min(0).max(1),
  weaknesses: z.array(z.string()),
  unsupportedAssumptions: z.array(z.string()),
  missingInformation: z.array(z.string()),
  dealkillers: z.array(z.string()),
});

export type SkepticOutput = z.infer<typeof skepticOutputSchema>;

/**
 * Hand-mirrored JSON Schema (ADR-0007's `--json-schema` first line of defense), same convention
 * as every other agent's schema file.
 */
export const skepticJsonSchema = {
  type: "object",
  properties: {
    result: { type: "string", enum: ["KEEP", "REJECT"] },
    adjustedConfidence: { type: "number", minimum: 0, maximum: 1 },
    weaknesses: { type: "array", items: { type: "string" } },
    unsupportedAssumptions: { type: "array", items: { type: "string" } },
    missingInformation: { type: "array", items: { type: "string" } },
    dealkillers: { type: "array", items: { type: "string" } },
  },
  required: [
    "result",
    "adjustedConfidence",
    "weaknesses",
    "unsupportedAssumptions",
    "missingInformation",
    "dealkillers",
  ],
} as const;

export type EvidenceClassification =
  | "FACT"
  | "INFERENCE"
  | "HYPOTHESIS"
  | "UNKNOWN";

export interface SkepticEvidenceInput {
  claim: string;
  classification: EvidenceClassification;
  supportingExcerpt: string | null;
  sourceUrl: string | null;
}

export interface SkepticCompanyInput {
  name: string;
  industry: string | null;
  country: string | null;
  sizeEstimate: string | null;
}

/**
 * Deliberately excludes `confidence`, `scoreComponents`, and `penaltyReasons` — those are the
 * Opportunity Analysis Agent's own judgment framing, not fresh-context material (spec §33).
 */
export interface SkepticOpportunityInput {
  problemTitle: string;
  problemDescription: string;
  problemCategory: string;
  economicImpact: string | null;
  impactAssumptions: { assumption: string; isKnown: boolean }[];
  affectedRole: string | null;
  proposedSolution: string;
  implementationStrategy: string | null;
  dependencies: string[];
  risks: string[];
  existingAlternatives: string[];
  estimatedDurationDays: number | null;
  /** Whole currency units (matches how the Opportunity Analysis Agent expresses prices). */
  suggestedPriceMin: number | null;
  suggestedPriceMax: number | null;
  recurringRevenuePossibility: string | null;
  validationQuestion: string | null;
  company: SkepticCompanyInput;
}

export interface BuildSkepticPromptInput {
  opportunity: SkepticOpportunityInput;
  evidence: SkepticEvidenceInput[];
}

const CLASSIFICATION_ORDER: EvidenceClassification[] = [
  "FACT",
  "INFERENCE",
  "HYPOTHESIS",
  "UNKNOWN",
];

function formatEvidenceBlock(evidence: SkepticEvidenceInput[]): string {
  if (evidence.length === 0) {
    return "No evidence items are linked to this opportunity.";
  }
  const blocks = CLASSIFICATION_ORDER.map((classification) => {
    const items = evidence.filter((e) => e.classification === classification);
    if (items.length === 0) return null;
    const lines = items.map((item, i) => {
      const parts = [
        `  ${i + 1}. ${item.claim}`,
        item.supportingExcerpt ? `     Excerpt: ${item.supportingExcerpt}` : null,
        item.sourceUrl ? `     Source: ${item.sourceUrl}` : null,
      ].filter((line): line is string => line !== null);
      return parts.join("\n");
    });
    return `${classification}:\n${lines.join("\n")}`;
  }).filter((block): block is string => block !== null);
  return blocks.join("\n\n");
}

/** Spec §33's question list, embedded verbatim. */
const SKEPTIC_QUESTIONS = `
- Is the evidence actually sufficient?
- Is the main problem inferred rather than demonstrated?
- Is there an obvious existing solution?
- Does the business already appear to use such a system?
- Is the benefit too small?
- Is the company too small?
- Is the company too sophisticated?
- Is integration likely impossible?
- Are regulatory/security requirements disproportionate?
- Is the price unrealistic?
- Would the buyer care?
- Is the operator capable of delivering it?
- Is the problem merely cosmetic?
- Is this another generic "AI chatbot" idea?
- Is there evidence of urgency?
- Is there a much cheaper off-the-shelf alternative?
`.trim();

function formatOpportunity(opportunity: SkepticOpportunityInput): string {
  const { company } = opportunity;
  const priceLine =
    opportunity.suggestedPriceMin != null && opportunity.suggestedPriceMax != null
      ? `${opportunity.suggestedPriceMin}-${opportunity.suggestedPriceMax}`
      : "unknown";
  const assumptionLines = opportunity.impactAssumptions.map(
    (a) => `  - [${a.isKnown ? "KNOWN" : "ASSUMPTION"}] ${a.assumption}`,
  );

  return [
    `Company: ${company.name} (industry: ${company.industry ?? "unknown"}, country: ${company.country ?? "unknown"}, size: ${company.sizeEstimate ?? "unknown"})`,
    `Problem title: ${opportunity.problemTitle}`,
    `Problem category: ${opportunity.problemCategory}`,
    `Problem description: ${opportunity.problemDescription}`,
    `Economic impact claim: ${opportunity.economicImpact ?? "none given"}`,
    assumptionLines.length > 0
      ? `Impact assumptions:\n${assumptionLines.join("\n")}`
      : "Impact assumptions: none given",
    `Affected role: ${opportunity.affectedRole ?? "unknown"}`,
    `Proposed solution: ${opportunity.proposedSolution}`,
    `Implementation strategy: ${opportunity.implementationStrategy ?? "none given"}`,
    `Dependencies: ${opportunity.dependencies.length > 0 ? opportunity.dependencies.join("; ") : "none given"}`,
    `Risks: ${opportunity.risks.length > 0 ? opportunity.risks.join("; ") : "none given"}`,
    `Existing alternatives considered: ${opportunity.existingAlternatives.length > 0 ? opportunity.existingAlternatives.join("; ") : "none given"}`,
    `Estimated duration (days): ${opportunity.estimatedDurationDays ?? "unknown"}`,
    `Suggested price range (whole currency units): ${priceLine}`,
    `Recurring revenue possibility: ${opportunity.recurringRevenuePossibility ?? "none given"}`,
    `Proposed validation question: ${opportunity.validationQuestion ?? "none given"}`,
  ].join("\n");
}

export function buildSkepticPrompt(
  input: BuildSkepticPromptInput,
  retry?: { previousError: string },
): string {
  const retryBlock = retry
    ? `\nYour previous response did not match the required output format. Fix this and try again:\n${retry.previousError}\n`
    : "";

  return `
You are the Skeptical Verification Agent for a small-business sales-opportunity pipeline. A
separate agent has already proposed the opportunity below.

Your job is NOT to improve the sales pitch. Do not polish the wording or find a way to make it
work. Your job is to find every real reason this opportunity is bad, and decide whether it
survives.

You are being given only the opportunity's factual content and the evidence that supposedly
supports it — deliberately not the other agent's own confidence or scoring, so you form an
independent judgment rather than anchoring on it.

Opportunity under review:
${formatOpportunity(input.opportunity)}

Evidence supposedly supporting this opportunity:
${formatEvidenceBlock(input.evidence)}

Work through these questions honestly, grounded only in the material above (do not invent facts
about the company that aren't stated):
${SKEPTIC_QUESTIONS}

Be deliberately biased toward REJECT for mediocre opportunities — a genuinely strong opportunity
should be obvious and should survive this scrutiny easily; if you are unsure, that uncertainty is
itself a reason to lean REJECT rather than KEEP. In particular:
- If the "evidence" is mostly HYPOTHESIS/UNKNOWN with little or no direct FACT support, that is
  grounds for REJECT even if the reasoning sounds plausible.
- If the problem could be explained away as normal/expected for this kind of business, or as
  merely cosmetic, REJECT.
- If this is essentially another generic "AI chatbot"/"AI automation" idea without a specific,
  evidenced reason it fits this company, REJECT.
- If nothing suggests actual urgency or a business owner would plausibly pay for this now, treat
  that as a real weakness, not a minor one.

Return a single JSON object with exactly these fields: "result" ("KEEP" or "REJECT"),
"adjustedConfidence" (0-1, your own independent confidence that this is a genuinely good
opportunity — not a restatement of any confidence you were given), "weaknesses" (string array),
"unsupportedAssumptions" (string array — claims treated as established that the evidence doesn't
actually support), "missingInformation" (string array — what would need to be known to judge this
properly), "dealkillers" (string array — reasons that alone would kill the opportunity; can be
empty).
${retryBlock}`.trim();
}

export interface RunSkepticAgentInput {
  opportunity: SkepticOpportunityInput;
  evidence: SkepticEvidenceInput[];
}

export interface RunSkepticAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runSkepticAgent(
  input: RunSkepticAgentInput,
  overrides: RunSkepticAgentOverrides = {},
): Promise<StructuredAgentResult<SkepticOutput>> {
  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("reasoning"),
    tools: [],
    jsonSchema: skepticJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 5 * 60 * 1000,
    schema: skepticOutputSchema,
    buildPrompt: (retry) =>
      buildSkepticPrompt(
        { opportunity: input.opportunity, evidence: input.evidence },
        retry,
      ),
  });
}
