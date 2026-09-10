/**
 * Draft version of the Phase 5 Deep Research Agent contract (docs/AGENT_CONTRACTS.md §3),
 * used only by scripts/spike-research.ts to prove Claude can produce evidence-graded research
 * through claudeClient. Not final — Phase 5 owns refining this into the real contract.
 */

import { z } from "zod";

export const evidenceItemSchema = z.object({
  claim: z.string(),
  classification: z.enum(["FACT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"]),
  supportingExcerpt: z.string(),
  sourceUrl: z.string().url(),
  confidence: z.number().min(0).max(1),
});

export const deepResearchSpikeSchema = z.object({
  evidence: z.array(evidenceItemSchema),
  candidateProblems: z.array(z.string()),
});

export type DeepResearchSpikeOutput = z.infer<typeof deepResearchSpikeSchema>;

/**
 * Hand-written JSON Schema mirror of `deepResearchSpikeSchema`, passed to `--json-schema` so
 * the CLI constrains `result` to schema-shaped JSON before it ever reaches Zod. Zod remains
 * the source of truth (per AGENT_CONTRACTS.md, "returns JSON validated against a Zod schema
 * before anything touches the database") — this is a cheap first line of defense, not a
 * replacement. Keep the two in sync by hand; Phase 5 can introduce a zod-to-json-schema
 * dependency if this drifts often enough to be worth it.
 */
export const deepResearchSpikeJsonSchema = {
  type: "object",
  properties: {
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          classification: {
            type: "string",
            enum: ["FACT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"],
          },
          supportingExcerpt: { type: "string" },
          sourceUrl: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["claim", "classification", "supportingExcerpt", "sourceUrl", "confidence"],
      },
    },
    candidateProblems: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["evidence", "candidateProblems"],
} as const;
