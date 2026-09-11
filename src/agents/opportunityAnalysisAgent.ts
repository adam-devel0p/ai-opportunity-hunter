/**
 * Opportunity Analysis Agent (docs/AGENT_CONTRACTS.md §4, spec §26). Turns one company's
 * already-gathered evidence (Phase 5) into a candidate commercial opportunity: a problem
 * statement, proposed solution, ROI model with explicit known-vs-assumption separation (spec
 * §29), and the underlying judgment inputs to the Phase 1 scoring calculator
 * (`src/lib/scoring.ts`) — this agent supplies the ten component values and any penalty reasons
 * that apply, but never the final raw/adjusted score itself (spec §30: "Claude does not
 * self-score", enforced structurally by `scoring.ts` being the only thing that sums/subtracts
 * them, see `src/pipeline/analyzeHandler.ts`).
 *
 * Takes only this company's evidence + candidate-problem context — never other companies' data
 * (spec §53). Does not use any tools: everything it needs was already gathered by Deep Research.
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import { PENALTY_CATALOG, SCORE_COMPONENT_RANGES, type PenaltyReason, type ScoreComponentName } from "../lib/scoring.js";
import { PROBLEM_CATEGORY_SEED_LIST } from "../lib/problemCategories.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";

// --- score components / penalty reasons schemas, derived from scoring.ts so the agent's ------
// --- contract can never drift out of sync with the ranges/catalog the deterministic scorer ----
// --- actually enforces. -------------------------------------------------------------------------

const scoreComponentsShape = Object.fromEntries(
  (Object.keys(SCORE_COMPONENT_RANGES) as ScoreComponentName[]).map((name) => {
    const range = SCORE_COMPONENT_RANGES[name];
    return [name, z.number().int().min(range.min).max(range.max)];
  }),
) as Record<ScoreComponentName, z.ZodNumber>;

export const scoreComponentsSchema = z.object(scoreComponentsShape);

const penaltyReasonValues = Object.keys(PENALTY_CATALOG) as [
  PenaltyReason,
  ...PenaltyReason[],
];
export const penaltyReasonSchema = z.enum(penaltyReasonValues);

export const impactAssumptionSchema = z.object({
  assumption: z.string(),
  isKnown: z.boolean(),
});

export const opportunityAnalysisOutputSchema = z
  .object({
    problemTitle: z.string(),
    problemDescription: z.string(),
    problemCategory: z.string(),
    economicImpact: z.string(),
    impactAssumptions: z.array(impactAssumptionSchema),
    affectedRole: z.string(),
    proposedSolution: z.string(),
    implementationStrategy: z.string(),
    dependencies: z.array(z.string()),
    risks: z.array(z.string()),
    existingAlternatives: z.array(z.string()),
    estimatedDurationDays: z.number().nonnegative(),
    suggestedPriceMin: z.number().nonnegative(),
    suggestedPriceMax: z.number().nonnegative(),
    recurringRevenuePossibility: z.string().nullable(),
    demoConcept: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    validationQuestion: z.string(),
    scoreComponents: scoreComponentsSchema,
    penaltyReasons: z.array(penaltyReasonSchema),
  })
  .superRefine((data, ctx) => {
    if (data.suggestedPriceMax < data.suggestedPriceMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suggestedPriceMax"],
        message: "suggestedPriceMax must be >= suggestedPriceMin",
      });
    }
  });

export type OpportunityAnalysisOutput = z.infer<
  typeof opportunityAnalysisOutputSchema
>;

/**
 * Hand-mirrored JSON Schema (ADR-0007's `--json-schema` first line of defense), same convention
 * as every other agent's schema file. `--json-schema` doesn't support the cross-field
 * min<=max check the Zod `.superRefine` above does — that's fine, it's a first line of defense
 * only, Zod validation via `runStructuredAgent` remains the source of truth.
 */
export const opportunityAnalysisJsonSchema = {
  type: "object",
  properties: {
    problemTitle: { type: "string" },
    problemDescription: { type: "string" },
    problemCategory: { type: "string" },
    economicImpact: { type: "string" },
    impactAssumptions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          assumption: { type: "string" },
          isKnown: { type: "boolean" },
        },
        required: ["assumption", "isKnown"],
      },
    },
    affectedRole: { type: "string" },
    proposedSolution: { type: "string" },
    implementationStrategy: { type: "string" },
    dependencies: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    existingAlternatives: { type: "array", items: { type: "string" } },
    estimatedDurationDays: { type: "number", minimum: 0 },
    suggestedPriceMin: { type: "number", minimum: 0 },
    suggestedPriceMax: { type: "number", minimum: 0 },
    recurringRevenuePossibility: { type: ["string", "null"] },
    demoConcept: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    validationQuestion: { type: "string" },
    scoreComponents: {
      type: "object",
      properties: Object.fromEntries(
        (Object.keys(SCORE_COMPONENT_RANGES) as ScoreComponentName[]).map(
          (name) => [
            name,
            {
              type: "integer",
              minimum: SCORE_COMPONENT_RANGES[name].min,
              maximum: SCORE_COMPONENT_RANGES[name].max,
            },
          ],
        ),
      ),
      required: Object.keys(SCORE_COMPONENT_RANGES),
    },
    penaltyReasons: {
      type: "array",
      items: { type: "string", enum: Object.keys(PENALTY_CATALOG) },
    },
  },
  required: [
    "problemTitle",
    "problemDescription",
    "problemCategory",
    "economicImpact",
    "impactAssumptions",
    "affectedRole",
    "proposedSolution",
    "implementationStrategy",
    "dependencies",
    "risks",
    "existingAlternatives",
    "estimatedDurationDays",
    "suggestedPriceMin",
    "suggestedPriceMax",
    "recurringRevenuePossibility",
    "demoConcept",
    "confidence",
    "validationQuestion",
    "scoreComponents",
    "penaltyReasons",
  ],
} as const;

export interface OpportunityAnalysisCompanyInput {
  name: string;
  website: string;
  country: string | null;
  industry: string | null;
  businessType: string | null;
  sizeEstimate: string | null;
  description: string | null;
  /** Free-text context carried over from earlier pipeline stages (discovery/prescreen/research
   * notes, including Phase 5's seeded "Research candidate problems: ..." line). */
  priorNotes: string | null;
}

export type EvidenceClassification =
  | "FACT"
  | "INFERENCE"
  | "HYPOTHESIS"
  | "UNKNOWN";

export interface OpportunityAnalysisEvidenceInput {
  claim: string;
  classification: EvidenceClassification;
  supportingExcerpt: string | null;
  confidence: number;
  sourceUrl: string | null;
}

export interface BuildOpportunityAnalysisPromptInput {
  company: OpportunityAnalysisCompanyInput;
  evidence: OpportunityAnalysisEvidenceInput[];
}

const CLASSIFICATION_ORDER: EvidenceClassification[] = [
  "FACT",
  "INFERENCE",
  "HYPOTHESIS",
  "UNKNOWN",
];

function formatEvidenceBlock(evidence: OpportunityAnalysisEvidenceInput[]): string {
  if (evidence.length === 0) {
    return "No evidence items were recorded for this company — Deep Research produced no verifiable findings (a dead/thin site, everything fetched failed, or nothing cited could be independently verified as fetched). Treat this honestly as insufficient evidence, not as license to invent findings.";
  }

  const blocks = CLASSIFICATION_ORDER.map((classification) => {
    const items = evidence.filter((e) => e.classification === classification);
    if (items.length === 0) return null;
    const lines = items.map((item, i) => {
      const parts = [
        `  ${i + 1}. ${item.claim}`,
        item.supportingExcerpt ? `     Excerpt: ${item.supportingExcerpt}` : null,
        `     Confidence: ${item.confidence}`,
        item.sourceUrl ? `     Source: ${item.sourceUrl}` : null,
      ].filter((line): line is string => line !== null);
      return parts.join("\n");
    });
    return `${classification}:\n${lines.join("\n")}`;
  }).filter((block): block is string => block !== null);

  return blocks.join("\n\n");
}

/** Verbatim from spec §88/§89 — the single most important behavioral guard for this agent: a
 * bare observed fact (e.g. "there is a contact form") is not itself evidence of volume, workload,
 * or a specific technology fix. */
const OPPORTUNITY_INTEGRITY_RULES = `
Opportunity-analysis integrity rules — these are not negotiable, follow them exactly:
- Never state a claim in "problemDescription" or "economicImpact" with more certainty than the
  evidence above actually supports. Every substantive claim must trace back to a FACT, INFERENCE,
  HYPOTHESIS, or UNKNOWN evidence item — do not silently upgrade an inference or hypothesis into
  a stated fact.
- A single observed fact (e.g. "the company has a contact form") is NOT itself evidence of high
  volume, manual processing, or the need for any specific technology. Do not chain an
  unsupported assumption onto a real fact and present the result as established.
- This is exactly the failure mode to avoid: given only the fact that a company has a contact
  form, concluding "they probably process hundreds of leads manually and need an AI chatbot" is
  unacceptable — volume, manual processing, and the fix are all unsupported, and economic value
  and urgency are unknown. If your evidence is this thin, say so honestly instead: keep
  "evidenceStrength" and "confidence" low, keep the problem framed around what is actually known
  vs. unknown, and use "validationQuestion" to state what would need to be established next,
  rather than manufacturing a stronger-sounding opportunity than the evidence supports.
- In "impactAssumptions", every line must be tagged "isKnown": true only if it is directly
  supported by FACT-classified evidence above; anything estimated, inferred, or hypothesized for
  the ROI calculation must be "isKnown": false. Never present a hypothetical number as a known
  fact (spec §29).
- If the evidence is empty or too thin to support a credible opportunity, you must still return a
  complete, well-formed object — do not fabricate facts to fill it in. Reflect the honest
  weakness in low score components (especially "evidenceStrength") and low "confidence", and use
  "validationQuestion" to name the single most useful next research question.
`.trim();

function formatScoreComponentGuide(): string {
  const descriptions: Record<ScoreComponentName, string> = {
    evidenceStrength: "how strong/direct the supporting FACTs are, vs. thin inference/hypothesis/unknown",
    painSeverity: "how severe the underlying friction/problem appears to be for the business",
    economicImpactScore: "how meaningful the estimated economic impact is, per your ROI model below",
    deliverability: "how realistically the operator (a solo/small technical operator) could deliver the proposed solution — spec §27",
    purchaseLikelihood: "how likely this company would actually pay for this, given its apparent size/maturity/budget signals",
    speedToValue: "how quickly the company would see value after implementation",
    reachability: "how reachable a real decision-maker plausibly is, given what's known about the company",
    demonstrability: "how easily the solution could be demonstrated/proven before a full commitment",
    repeatability: "how repeatable this problem/solution pattern might be across similar businesses (future revenue potential)",
    urgency: "how time-sensitive or currently pressing the problem appears to be",
  };
  return (Object.keys(SCORE_COMPONENT_RANGES) as ScoreComponentName[])
    .map((name) => {
      const range = SCORE_COMPONENT_RANGES[name];
      return `- "${name}" (${range.min}-${range.max}): ${descriptions[name]}`;
    })
    .join("\n");
}

function formatPenaltyCatalog(): string {
  const descriptions: Record<PenaltyReason, string> = {
    WEAK_SPECULATIVE_EVIDENCE: "the case rests mostly on HYPOTHESIS/UNKNOWN rather than FACT/INFERENCE",
    COMMODITY_SOLUTION_AVAILABLE: "an easily available off-the-shelf solution likely already solves this",
    PROBLEM_ALREADY_SOLVED: "evidence suggests the company has already solved this problem",
    LARGE_PROCUREMENT_BURDEN: "buying/approving this would likely require a large procurement process",
    SIGNIFICANT_REGULATORY_RISK: "the domain carries meaningful regulatory/compliance risk",
    UNCLEAR_BUYER: "it's unclear who at the company would actually own this decision",
    IMPLEMENTATION_DEPENDENCY_OUTSIDE_CONTROL: "delivery depends on something outside the operator's control (e.g. a third party's system access)",
    COMPANY_FINANCIALLY_UNSUITABLE: "signals suggest the company can't realistically afford this",
    LONG_IMPLEMENTATION_CYCLE: "implementation would likely take unusually long",
    CROWDED_GENERIC_OFFER: "this is an extremely crowded, generic offer with little differentiation",
  };
  return (Object.keys(PENALTY_CATALOG) as PenaltyReason[])
    .map((reason) => `- "${reason}": ${descriptions[reason]}`)
    .join("\n");
}

export function buildOpportunityAnalysisPrompt(
  input: BuildOpportunityAnalysisPromptInput,
  retry?: { previousError: string },
): string {
  const { company, evidence } = input;

  const companyLines = [
    `- Name: ${company.name}`,
    `- Website: ${company.website}`,
    `- Country: ${company.country ?? "unknown"}`,
    `- Industry: ${company.industry ?? "unknown"}`,
    company.businessType ? `- Business type: ${company.businessType}` : null,
    `- Size estimate: ${company.sizeEstimate ?? "unknown"}`,
    `- Description (from earlier pipeline stages, not yet verified): ${company.description ?? "none"}`,
    company.priorNotes ? `- Notes from earlier pipeline stages: ${company.priorNotes}` : null,
  ].filter((line): line is string => line !== null);

  const retryBlock = retry
    ? `\nYour previous response did not match the required output format. Fix this and try again:\n${retry.previousError}\n`
    : "";

  return `
You are the Opportunity Analysis Agent for a small-business sales-opportunity pipeline. Deep
Research has already gathered evidence about ONE company — the one below. Your job is to decide
whether a plausible, evidence-backed commercial opportunity exists, and if so, describe it
precisely — you do not do any further research yourself.

The core question: what expensive or valuable problem does this business plausibly have that a
solo/small operator could realistically solve?

Company:
${companyLines.join("\n")}

Evidence gathered so far:
${formatEvidenceBlock(evidence)}

Problem category inspiration (not exhaustive — propose something else if it fits better):
${PROBLEM_CATEGORY_SEED_LIST.join(", ")}

Deliverability (spec §27) — prefer solutions realistically deliverable by a solo/small operator
using: existing APIs, existing SaaS, Claude, simple custom backend/frontend work, integrations,
workflow engines, legitimate browser automation, lightweight databases, existing communication
platforms, existing cloud services. Avoid recommending: massive ERP replacements, multi-year
transformations, mission-critical infrastructure rewrites, projects requiring a large team,
projects requiring extensive enterprise procurement, integrations that cannot reasonably be
accessed, or speculative technology with unclear feasibility.

Value (spec §28) — ask "why would this company actually pay for this?" Potential value sources
include: staff hours saved, faster lead response, higher conversion, fewer lost enquiries, less
repetitive work, fewer mistakes, shorter processing time, lower support volume, improved customer
experience, increased capacity without hiring, reduced administrative workload, improved data
quality, improved response speed, improved visibility/reporting, reduced operational friction.

ROI model (spec §29) — build a lightweight model and separate known values from assumptions
explicitly in "impactAssumptions". Example of the expected shape/reasoning (not this company's
real numbers):
  Assumption: 2 employees x 5 hours/week x EUR 30/hour loaded labor cost = ~EUR 1,200/month effort.
  Potential reduction: 40% -> ~EUR 480/month estimated saving.
The purpose is to judge whether a roughly EUR 500-2,000 project appears economically sensible for
this company — not a hard cap, just the scale this pipeline is built around.

Score components — give an honest integer for each, grounded only in the evidence above:
${formatScoreComponentGuide()}

Penalty reasons — include any that apply (can be empty array):
${formatPenaltyCatalog()}

${OPPORTUNITY_INTEGRITY_RULES}

Express "suggestedPriceMin"/"suggestedPriceMax" as whole currency units (e.g. 750 meaning
EUR 750), not cents.

Return a single JSON object with exactly these fields: "problemTitle", "problemDescription",
"problemCategory", "economicImpact", "impactAssumptions" (array of {"assumption", "isKnown"}),
"affectedRole", "proposedSolution", "implementationStrategy", "dependencies" (string array),
"risks" (string array), "existingAlternatives" (string array), "estimatedDurationDays",
"suggestedPriceMin", "suggestedPriceMax", "recurringRevenuePossibility" (nullable),
"demoConcept" (nullable), "confidence" (0-1), "validationQuestion", "scoreComponents" (object with
the ten fields above), "penaltyReasons" (string array).
${retryBlock}`.trim();
}

export interface RunOpportunityAnalysisAgentInput {
  company: OpportunityAnalysisCompanyInput;
  evidence: OpportunityAnalysisEvidenceInput[];
}

export interface RunOpportunityAnalysisAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runOpportunityAnalysisAgent(
  input: RunOpportunityAnalysisAgentInput,
  overrides: RunOpportunityAnalysisAgentOverrides = {},
): Promise<StructuredAgentResult<OpportunityAnalysisOutput>> {
  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("reasoning"),
    tools: [],
    jsonSchema: opportunityAnalysisJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 5 * 60 * 1000,
    schema: opportunityAnalysisOutputSchema,
    buildPrompt: (retry) =>
      buildOpportunityAnalysisPrompt(
        { company: input.company, evidence: input.evidence },
        retry,
      ),
  });
}
