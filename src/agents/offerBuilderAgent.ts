/**
 * Offer Builder Agent (docs/AGENT_CONTRACTS.md §6, spec §34-36). Turns a gated, verified
 * opportunity into a concrete, priced offer — the first agent invoked only after an opportunity
 * has survived Skeptical Verification's gate (spec §32), per `src/pipeline/offerHandler.ts` only
 * ever being reachable via a `BUILD_OFFER` work item, which `verifyHandler.ts` enqueues
 * exclusively on a gate pass.
 *
 * Uses only what's already known about the opportunity — no tools, same reasoning as Opportunity
 * Analysis / Skeptical Verification (ADR-0013 part 4 / ADR-0014): this is judgment over
 * already-gathered material, nothing left to fetch or search.
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";

export const offerBuilderOutputSchema = z
  .object({
    scope: z.string(),
    expectedOutcome: z.string(),
    keyAssumptions: z.array(z.string()),
    durationEstimate: z.string(),
    // Whole currency units (e.g. 750 == EUR 750), matching the Opportunity Analysis Agent's
    // convention (ADR-0013 part 5) — the handler converts to cents at persist time.
    price: z.number().positive(),
    recurringPrice: z.number().positive().nullable(),
    exclusions: z.string(),
    validationNeeded: z.string(),
    demoConcept: z.string(),
    whyCommerciallyAttractive: z.string(),
    // Not in AGENT_CONTRACTS.md's original illustrative draft — added so a price that falls
    // outside its resolved pricing band (src/lib/pricing.ts) carries a real, model-supplied
    // reason rather than the handler inventing one. Required to be non-null only when the price
    // actually falls outside the band; the handler (not this schema) is what knows the band, so
    // it's nullable here and the handler records a deterministic fallback note if it's missing
    // when one was needed — see ADR-0015 part 2.
    priceJustification: z.string().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.recurringPrice != null && data.recurringPrice <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurringPrice"],
        message: "recurringPrice must be positive when present, or null when there is none",
      });
    }
  });

export type OfferBuilderOutput = z.infer<typeof offerBuilderOutputSchema>;

/**
 * Hand-mirrored JSON Schema (ADR-0007's `--json-schema` first line of defense), same convention
 * as every other agent's schema file.
 */
export const offerBuilderJsonSchema = {
  type: "object",
  properties: {
    scope: { type: "string" },
    expectedOutcome: { type: "string" },
    keyAssumptions: { type: "array", items: { type: "string" } },
    durationEstimate: { type: "string" },
    price: { type: "number", exclusiveMinimum: 0 },
    recurringPrice: { type: ["number", "null"] },
    exclusions: { type: "string" },
    validationNeeded: { type: "string" },
    demoConcept: { type: "string" },
    whyCommerciallyAttractive: { type: "string" },
    priceJustification: { type: ["string", "null"] },
  },
  required: [
    "scope",
    "expectedOutcome",
    "keyAssumptions",
    "durationEstimate",
    "price",
    "recurringPrice",
    "exclusions",
    "validationNeeded",
    "demoConcept",
    "whyCommerciallyAttractive",
    "priceJustification",
  ],
} as const;

export interface OfferBuilderCompanyInput {
  name: string;
  industry: string | null;
  country: string | null;
  sizeEstimate: string | null;
}

/** Everything the offer is built from — the already-formed, already-verified opportunity plus
 * its Phase 6 score/confidence (context only; the agent never re-derives or overrides them). */
export interface OfferBuilderOpportunityInput {
  problemTitle: string;
  problemDescription: string;
  problemCategory: string;
  economicImpact: string | null;
  affectedRole: string | null;
  proposedSolution: string;
  implementationStrategy: string | null;
  dependencies: string[];
  risks: string[];
  existingAlternatives: string[];
  estimatedDurationDays: number | null;
  /** Whole currency units — Phase 6's own suggested range, given as an anchor, not a hard cap. */
  suggestedPriceMin: number | null;
  suggestedPriceMax: number | null;
  recurringRevenuePossibility: string | null;
  demoConcept: string | null;
  adjustedScore: number;
  verifierConfidence: number | null;
  company: OfferBuilderCompanyInput;
}

export interface BuildOfferBuilderPromptInput {
  opportunity: OfferBuilderOpportunityInput;
  pricingBandGuide: string;
}

function formatOpportunity(opportunity: OfferBuilderOpportunityInput): string {
  const { company } = opportunity;
  const suggestedPriceLine =
    opportunity.suggestedPriceMin != null && opportunity.suggestedPriceMax != null
      ? `${opportunity.suggestedPriceMin}-${opportunity.suggestedPriceMax}`
      : "not estimated";

  return [
    `Company: ${company.name} (industry: ${company.industry ?? "unknown"}, country: ${company.country ?? "unknown"}, size: ${company.sizeEstimate ?? "unknown"})`,
    `Problem title: ${opportunity.problemTitle}`,
    `Problem category: ${opportunity.problemCategory}`,
    `Problem description: ${opportunity.problemDescription}`,
    `Economic impact: ${opportunity.economicImpact ?? "none given"}`,
    `Affected role: ${opportunity.affectedRole ?? "unknown"}`,
    `Proposed solution: ${opportunity.proposedSolution}`,
    `Implementation strategy: ${opportunity.implementationStrategy ?? "none given"}`,
    `Dependencies: ${opportunity.dependencies.length > 0 ? opportunity.dependencies.join("; ") : "none given"}`,
    `Risks: ${opportunity.risks.length > 0 ? opportunity.risks.join("; ") : "none given"}`,
    `Existing alternatives considered: ${opportunity.existingAlternatives.length > 0 ? opportunity.existingAlternatives.join("; ") : "none given"}`,
    `Estimated duration (days): ${opportunity.estimatedDurationDays ?? "unknown"}`,
    `Phase 6's suggested price range (whole currency units, an anchor, not a hard cap): ${suggestedPriceLine}`,
    `Recurring revenue possibility noted earlier: ${opportunity.recurringRevenuePossibility ?? "none given"}`,
    `Demo concept noted earlier: ${opportunity.demoConcept ?? "none given"}`,
    `Adjusted opportunity score: ${opportunity.adjustedScore}/100`,
    `Skeptical verifier's independent confidence: ${opportunity.verifierConfidence ?? "unknown"}`,
  ].join("\n");
}

export function buildOfferBuilderPrompt(
  input: BuildOfferBuilderPromptInput,
  regeneration?: { reason: string },
  retry?: { previousError: string },
): string {
  const regenerationBlock = regeneration
    ? `\nYour previous offer was rejected by a deterministic quality check before it ever reached the operator. Fix this specific problem and produce a genuinely different, concrete offer:\n${regeneration.reason}\n`
    : "";
  const retryBlock = retry
    ? `\nYour previous response did not match the required output format. Fix this and try again:\n${retry.previousError}\n`
    : "";

  return `
You are the Offer Builder for a small-business sales-opportunity pipeline. A separate process
has already researched this company, formed an opportunity, and had it survive an adversarial
skeptical review. Your job is to turn it into one concrete, priced, sellable offer — not to
re-litigate whether the opportunity is real.

Opportunity:
${formatOpportunity(input.opportunity)}

Pricing bands (spec §35 — configurable starting bands, not hardcoded prices):
${input.pricingBandGuide}

The offer must define an ACTUAL deliverable. This is the single most important rule:

BAD (never do this):
"AI automation services."

GOOD (do this):
"Automated applicant intake workflow that extracts candidate details, checks them against role requirements, and creates a structured recruiter review queue."

The bad example fails because it names a technology category, not a deliverable. The good
example fails only if it stops being specific to this company's actual problem — do not write a
generic offer that could apply to any business; ground every field in the opportunity above.

Demo concept (spec §36): describe a potential low-risk demo/proof the operator could show before
asking for a purchase (e.g. a dummy invoice processor, a sample CV qualification workflow, a mock
enquiry responder, a sample dashboard, a prototype booking experience). Never claim the demo has actually been built — you are describing a concept, not a delivered artifact.

Price honestly (spec §35): the price should reflect likely value, implementation effort,
uncertainty, market/business size, support burden, sales friction, and risk — do not blindly
maximize it. If your price genuinely falls outside the pricing band matching your own duration
estimate, explain why in "priceJustification" (e.g. unusually broad scope, unusual delivery risk,
premium urgency); otherwise set "priceJustification" to null. Only propose "recurringPrice" when
there is genuine ongoing value or cost to support (spec §35's "Optional Ongoing Support" band,
approximately 50-500/month) — otherwise it must be null, not zero.
${regenerationBlock}${retryBlock}
Return a single JSON object with exactly these fields: "scope" (the concrete deliverable — this
is what gets lint-checked against the bad example above, so make it specific), "expectedOutcome",
"keyAssumptions" (string array), "durationEstimate" (free text, e.g. "2 days"), "price" (whole
currency units), "recurringPrice" (whole currency units or null), "exclusions" (what is
explicitly NOT included), "validationNeeded" (what should be confirmed before/during delivery),
"demoConcept", "whyCommerciallyAttractive", "priceJustification" (string or null).
`.trim();
}

export interface RunOfferBuilderAgentInput {
  opportunity: OfferBuilderOpportunityInput;
  pricingBandGuide: string;
  /** Set by the handler when re-invoking after a deterministic vague-offer lint failure (spec
   * §34) — distinct from `runStructuredAgent`'s own schema-validation retry, since this is a
   * business-logic quality check, not a shape failure. */
  regenerationReason?: string;
}

export interface RunOfferBuilderAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runOfferBuilderAgent(
  input: RunOfferBuilderAgentInput,
  overrides: RunOfferBuilderAgentOverrides = {},
): Promise<StructuredAgentResult<OfferBuilderOutput>> {
  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("reasoning"),
    tools: [],
    jsonSchema: offerBuilderJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 5 * 60 * 1000,
    schema: offerBuilderOutputSchema,
    buildPrompt: (retry) =>
      buildOfferBuilderPrompt(
        { opportunity: input.opportunity, pricingBandGuide: input.pricingBandGuide },
        input.regenerationReason ? { reason: input.regenerationReason } : undefined,
        retry,
      ),
  });
}
