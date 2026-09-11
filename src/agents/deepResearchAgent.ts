/**
 * Deep Research Agent (docs/AGENT_CONTRACTS.md §3, spec §19). The most important research
 * component in the pipeline (§19: "this agent is the most important research component") — it
 * does NOT form or score an opportunity (Phase 6 does that); it only produces properly
 * classified, provenance-backed evidence plus raw candidate problems for Phase 6 to evaluate.
 *
 * Uses the "reasoning" model tier (not "fast" like Discovery/Pre-Screening): spec §52 lists
 * "deep analysis" and "complex opportunity reasoning" under the more-capable-model column, and
 * this is the one agent in the pipeline that has to dynamically decide what to investigate
 * rather than perform a narrow classification — same choice the Phase 0 spike already made.
 *
 * Registers the ADR-0004 `PostToolUse` hook (src/agents/sourceCaptureHook.ts) via `--settings`
 * so every `WebFetch` call is independently recorded as a `sources` row — the agent's own
 * `sourceUrl` claims are never trusted as the sole record of what was actually fetched (see
 * `src/pipeline/researchHandler.ts`, which cross-checks every evidence item's `sourceUrl`
 * against those hook-recorded rows before persisting anything).
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";
import {
  buildSourceCaptureHookEnv,
  buildSourceCaptureHookSettings,
} from "./sourceCaptureHook.js";

export const deepResearchEvidenceSchema = z.object({
  claim: z.string(),
  classification: z.enum(["FACT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"]),
  supportingExcerpt: z.string(),
  sourceUrl: z.string().url(),
  confidence: z.number().min(0).max(1),
});

export const deepResearchOutputSchema = z.object({
  evidence: z.array(deepResearchEvidenceSchema),
  candidateProblems: z.array(z.string()),
});

export type DeepResearchEvidence = z.infer<typeof deepResearchEvidenceSchema>;
export type DeepResearchOutput = z.infer<typeof deepResearchOutputSchema>;

/**
 * Hand-mirrored JSON Schema for `deepResearchOutputSchema` (ADR-0007's `--json-schema` first
 * line of defense, same convention as every other agent's schema file). Supersedes
 * `schemas/deepResearchSpike.ts`, which remains only as the throwaway Phase 0 spike's contract
 * — do not import it from here.
 */
export const deepResearchJsonSchema = {
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

/** Verbatim from spec §24 ("Research integrity") — these lines must not be paraphrased, per
 * AGENT_CONTRACTS.md §3's "System prompt hard-codes the research integrity rules from spec §24
 * verbatim" requirement. */
const RESEARCH_INTEGRITY_RULES_VERBATIM = `
Do not invent facts.
Do not invent quotes.
Do not invent employee counts.
Do not invent revenue.
Do not invent technologies.
Do not invent customer volumes.
Do not invent staff workload.
Do not invent emails.
Do not claim that something is manual merely because automation is not visible.
Do not claim a business lacks a system merely because the system is not publicly visible.
Do not claim a financial loss unless there is supporting evidence.
When information cannot be established, record it as unknown.
`.trim();

/** Additions beyond the verbatim §24 text: the tool-denial fabrication guard required by
 * ADR-0007's consequences, the sourceUrl/provenance rule this handler's hook cross-check
 * depends on, spec §20's problem-not-AI framing, and spec §21's classification definitions
 * (reproduced with their exact spec examples). */
const ADDITIONAL_INTEGRITY_RULES = `
- If a WebSearch or WebFetch call is denied or fails, say so and record it as UNKNOWN — never
  fall back to answering from general/training-data knowledge and presenting it as if it came
  from this company's own public sources.
- Every evidence item's "sourceUrl" must be a page you actually fetched with WebFetch during
  this session, never a URL you only saw in a WebSearch result without fetching it. A
  deterministic check independent of this output will drop any evidence item whose sourceUrl
  doesn't match a page you actually fetched.
- This is problem-oriented research, not AI-oriented research: look for meaningful business
  problems (expensive friction, lost revenue, manual effort, poor customer experience,
  operational bottlenecks, repetitive work) — not "where could we add AI." The eventual fix
  might be AI, ordinary software, automation, integration, a script, better workflow, an
  existing SaaS product, or nothing at all.
- Classify every evidence item as exactly one of:
  - FACT: directly supported by a public source you fetched (e.g. "Candidates are instructed to
    email their CV to recruitment@example.com.").
  - INFERENCE: a reasonable conclusion based on one or more facts but not directly established
    (e.g. "Candidate intake may require manual processing.").
  - HYPOTHESIS: a possibility worth validating with the company, not yet grounded in facts (e.g.
    "The recruiting team may spend several hours each week manually categorizing
    applications.").
  - UNKNOWN: information necessary to evaluate the opportunity but not currently established
    (e.g. "Actual weekly applicant volume is unknown.") — cite the page you checked that didn't
    reveal it as the sourceUrl. Use this liberally rather than guessing.
  Never silently convert an inference or hypothesis into a fact.
`.trim();

export interface DeepResearchCompanyInput {
  name: string;
  website: string;
  country: string | null;
  region: string | null;
  industry: string | null;
  businessType: string | null;
  sizeEstimate: string | null;
  description: string | null;
  /** Free-text context carried over from discovery/pre-screening (e.g. seeded notes). */
  priorNotes: string | null;
}

export interface BuildDeepResearchPromptInput {
  company: DeepResearchCompanyInput;
}

export function buildDeepResearchPrompt(
  input: BuildDeepResearchPromptInput,
  retry?: { previousError: string },
): string {
  const { company } = input;

  const companyLines = [
    `- Name: ${company.name}`,
    `- Website: ${company.website}`,
    `- Country: ${company.country ?? "unknown"}`,
    company.region ? `- Region: ${company.region}` : null,
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
You are the Deep Research Agent for a small-business sales-opportunity pipeline. Your job is to
research ONE company — the one below, and nothing else — and produce evidence-graded findings
about how it appears to operate, looking for observable signals of expensive friction, lost
revenue, manual effort, poor customer experience, operational bottlenecks, or repetitive work.
You are gathering evidence about the business, not pitching a technology.

Company:
${companyLines.join("\n")}

Use WebSearch and WebFetch to investigate this company's public-facing website and any other
public sources you judge useful (news, job listings, review sites, case studies, careers pages,
etc.) — decide what's worth checking for this specific company rather than mechanically
checking the same fixed list for every company.

Produce a JSON object with:

- "evidence": an array of evidence items. Each item has:
  - "claim": one specific statement about the company.
  - "classification": one of FACT, INFERENCE, HYPOTHESIS, or UNKNOWN (see below).
  - "supportingExcerpt": a short excerpt or paraphrase from the source backing this claim (for
    UNKNOWN items, briefly say what you looked for and didn't find).
  - "sourceUrl": the exact URL you fetched that supports this claim.
  - "confidence": your confidence in this specific claim, 0 to 1.
- "candidateProblems": an array of short strings — raw, unrefined possible business problems
  suggested by the evidence above. This is not your final analysis, just candidates for a later,
  separate step to evaluate.

Return a JSON object: { "evidence": [...], "candidateProblems": [...] }.

Research integrity rules — these are not negotiable, follow them exactly:
${RESEARCH_INTEGRITY_RULES_VERBATIM}

${ADDITIONAL_INTEGRITY_RULES}
${retryBlock}`.trim();
}

export interface RunDeepResearchAgentInput {
  company: DeepResearchCompanyInput;
  /** Path to the live SQLite DB file — passed to the ADR-0004 hook subprocess via env var,
   * since it runs as a separate OS process with no access to this app's in-memory `Db` handle. */
  dbPath: string;
  companyId: string;
  taskId: string;
}

export interface RunDeepResearchAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runDeepResearchAgent(
  input: RunDeepResearchAgentInput,
  overrides: RunDeepResearchAgentOverrides = {},
): Promise<StructuredAgentResult<DeepResearchOutput>> {
  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("reasoning"),
    tools: ["WebSearch", "WebFetch"],
    jsonSchema: deepResearchJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 8 * 60 * 1000,
    schema: deepResearchOutputSchema,
    settings: buildSourceCaptureHookSettings(),
    extraEnv: buildSourceCaptureHookEnv({
      dbPath: input.dbPath,
      companyId: input.companyId,
      taskId: input.taskId,
    }),
    buildPrompt: (retry) => buildDeepResearchPrompt({ company: input.company }, retry),
  });
}
