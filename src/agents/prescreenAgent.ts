/**
 * Pre-Screening Agent (docs/AGENT_CONTRACTS.md §2, spec §18). Cheap, fast-tier classification of
 * one already-discovered company, so that expensive Deep Research (Phase 5) is only spent on
 * companies worth it (spec §13). It does NOT diagnose problems or produce evidence — just a
 * classification and the reasons behind it.
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";

export const prescreenOutputSchema = z.object({
  classification: z.enum(["DISCARD", "MAYBE", "PROMISING"]),
  reasons: z.array(z.string()),
});

export type PrescreenOutput = z.infer<typeof prescreenOutputSchema>;

/**
 * Hand-mirrored JSON Schema for `prescreenOutputSchema`, passed as `--json-schema` (ADR-0007 —
 * a first line of defense only; Zod validation via `runStructuredAgent` remains the source of
 * truth). Keep in sync by hand, same convention as `discoveryAgent.ts`.
 */
export const prescreenJsonSchema = {
  type: "object",
  properties: {
    classification: { type: "string", enum: ["DISCARD", "MAYBE", "PROMISING"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["classification", "reasons"],
} as const;

const PRESCREEN_INTEGRITY_RULES = `
Pre-screening integrity rules — these are not negotiable, follow them exactly:
- Only use the WebFetch tool. Do not guess at the content of any page you did not actually
  fetch.
- If the homepage fails to load, times out, or the site is clearly dead/parked, that failure is
  itself valid evidence for "DISCARD" — report exactly what happened, do not invent what the
  site might have said.
- Do not diagnose the company's problems or propose any solution here — that is a separate,
  later step. Your only job is: is this company worth a deeper research pass, or not?
- Give at least one concrete reason grounded in what you actually observed (page content you
  fetched, or the fact that a fetch failed) — never a generic reason unconnected to this company.
`.trim();

export interface PrescreenCompanyInput {
  name: string;
  website: string;
  country: string | null;
  industry: string | null;
  description: string | null;
  sizeEstimate: string | null;
  /** Free-text context carried over from discovery (e.g. the seeded "Discovery reason: ..." note). */
  discoveryNotes: string | null;
}

export interface BuildPrescreenPromptInput {
  company: PrescreenCompanyInput;
}

export function buildPrescreenPrompt(
  input: BuildPrescreenPromptInput,
  retry?: { previousError: string },
): string {
  const { company } = input;

  const companyLines = [
    `- Name: ${company.name}`,
    `- Website: ${company.website}`,
    `- Country: ${company.country ?? "unknown"}`,
    `- Industry: ${company.industry ?? "unknown"}`,
    `- Size estimate: ${company.sizeEstimate ?? "unknown"}`,
    `- Description (from discovery, not yet verified): ${company.description ?? "none"}`,
    company.discoveryNotes ? `- Notes from discovery: ${company.discoveryNotes}` : null,
  ].filter((line): line is string => line !== null);

  const retryBlock = retry
    ? `\nYour previous response did not match the required output format. Fix this and try again:\n${retry.previousError}\n`
    : "";

  return `
You are the Pre-Screening Agent for a small-business sales-opportunity pipeline. Your only job
is a cheap, fast classification of ONE already-discovered company, so that an expensive deep
research pass is only spent on companies worth it.

Company:
${companyLines.join("\n")}

Use WebFetch to load the homepage at the website above. If you can, also check an about/
services/contact page linked from the homepage.

Classify this company as one of:
- "DISCARD": the website is dead, parked, unreachable, clearly not a real operating business,
  or is obviously the wrong kind of business for this pipeline — a deeper research pass would
  be wasted here.
- "MAYBE": the site loads and looks like a real business, but there isn't enough here to
  confidently discard or confidently advance it.
- "PROMISING": the site loads, looks like a real, active small/medium business, and nothing you
  found rules it out — worth spending a deeper research pass on.

Return a JSON object: { "classification": "...", "reasons": ["...", ...] }.

${PRESCREEN_INTEGRITY_RULES}
${retryBlock}`.trim();
}

export interface RunPrescreenAgentInput {
  company: PrescreenCompanyInput;
}

export interface RunPrescreenAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runPrescreenAgent(
  input: RunPrescreenAgentInput,
  overrides: RunPrescreenAgentOverrides = {},
): Promise<StructuredAgentResult<PrescreenOutput>> {
  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("fast"),
    tools: ["WebFetch"],
    jsonSchema: prescreenJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 3 * 60 * 1000,
    schema: prescreenOutputSchema,
    buildPrompt: (retry) => buildPrescreenPrompt({ company: input.company }, retry),
  });
}
