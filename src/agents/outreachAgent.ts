/**
 * Outreach Writer (docs/AGENT_CONTRACTS.md §8, spec §39-40). Writes one primary cold outreach
 * email for a strong, verified opportunity that already has a concrete priced offer and a
 * researched contact — reachable only via a `WRITE_OUTREACH` work item, which
 * `contactHandler.ts` enqueues unconditionally on every completed contact search, so this agent
 * is never invoked for an opportunity that hasn't already survived Skeptical Verification and
 * gotten both an offer and a contact.
 *
 * Uses only what's already known about the opportunity/offer/contact — no tools, same reasoning
 * as Offer Builder (ADR-0015): this is writing/judgment over already-gathered material, nothing
 * left to fetch or search. The model's own word count / marketing-language / truthfulness
 * self-report is never trusted directly — `src/lib/outreachLint.ts` re-checks all three
 * deterministically before anything is persisted (spec §96/§97).
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";

export const outreachOutputSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export type OutreachAgentOutput = z.infer<typeof outreachOutputSchema>;

/**
 * Hand-mirrored JSON Schema (ADR-0007's `--json-schema` first line of defense), same convention
 * as every other agent's schema file.
 */
export const outreachJsonSchema = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
} as const;

export interface OutreachAgentCompanyInput {
  name: string;
}

/** Only the factual/proposal content useful for writing to a stranger — no score, no
 * confidence, no penalty reasons (those are internal pipeline judgments, not something the
 * recipient should ever see echoed back). */
export interface OutreachAgentOpportunityInput {
  problemTitle: string;
  problemDescription: string;
  proposedSolution: string;
  affectedRole: string | null;
}

export interface OutreachAgentOfferInput {
  scope: string;
  expectedOutcome: string;
  demoConcept: string | null;
}

export interface OutreachAgentContactInput {
  name: string;
  role: string | null;
  /** From `src/lib/contactDisplay.ts` — never the raw `emailConfidence` enum, so this agent
   * can't accidentally treat a GUESSED contact as confirmed (spec §38). */
  isPreferredForInitialOutreach: boolean;
}

export interface OutreachAgentEvidenceInput {
  claim: string;
  classification: "FACT" | "INFERENCE" | "HYPOTHESIS" | "UNKNOWN";
}

export interface BuildOutreachPromptInput {
  company: OutreachAgentCompanyInput;
  opportunity: OutreachAgentOpportunityInput;
  offer: OutreachAgentOfferInput;
  contact: OutreachAgentContactInput;
  evidence: OutreachAgentEvidenceInput[];
}

const OUTREACH_INTEGRITY_RULES = `
Truthfulness rules (spec §40) — these are not negotiable, follow them exactly:
- Never fabricate customer references, previous implementations, testimonials, case studies,
  metrics, or savings figures.
- Never say "I built a demo" or imply one exists — you may only describe a demo CONCEPT
  (something that could be shown), never claim it has actually been built.
- Do not state an assumption as if it were a confirmed fact. If a claim about this company's
  internal process is only an inference from evidence (not something directly confirmed), hedge
  it honestly:
  BAD: "I noticed your team spends hours doing X."
  GOOD: "I noticed candidates are currently directed to submit their CVs by email. If the first
  sorting step is still being done manually, I think there may be an easy automation
  opportunity."
- Ground the email in a genuine, specific observation from the evidence below — never a generic
  observation that could apply to any business in this industry.
`.trim();

const OUTREACH_STYLE_RULES = `
Style rules (spec §39):
- Approximately 60-130 words in the body.
- Reference a genuine company-specific observation.
- Describe the possible problem without pretending unverified assumptions are facts.
- Propose a specific solution and communicate the likely benefit.
- Use simple, plain language. Make a low-friction call to action (e.g. "Worth a look?").
- Sound like one competent individual writing a short personal note, not an AI agency or a mass
  campaign.
- Avoid exaggerated marketing language (e.g. "revolutionary AI solution", "transform your
  business with cutting-edge AI", "unlock the power of AI") and generic mass-email openers (e.g.
  "Dear Sir/Madam", "To whom it may concern").
- Sign off with the placeholder "[Your name]" — the operator signs the actual email themselves
  before sending (spec §41: they review and may edit every draft before it ever goes out).
`.trim();

function formatEvidence(evidence: OutreachAgentEvidenceInput[]): string {
  if (evidence.length === 0) return "No evidence recorded.";
  return evidence
    .map((item) => `- [${item.classification}] ${item.claim}`)
    .join("\n");
}

export function buildOutreachPrompt(
  input: BuildOutreachPromptInput,
  regeneration?: { reason: string },
  retry?: { previousError: string },
): string {
  const { company, opportunity, offer, contact, evidence } = input;

  const contactLine = contact.isPreferredForInitialOutreach
    ? `${contact.name}${contact.role ? ` (${contact.role})` : ""}`
    : `${contact.name}${contact.role ? ` (${contact.role})` : ""} — note: this contact's email is not confirmed/publicly listed, so do not write as if you're certain this reaches the right inbox`;

  const regenerationBlock = regeneration
    ? `\nYour previous draft was rejected by a deterministic quality check before it ever reached the operator. Fix this specific problem and write a genuinely different draft:\n${regeneration.reason}\n`
    : "";
  const retryBlock = retry
    ? `\nYour previous response did not match the required output format. Fix this and try again:\n${retry.previousError}\n`
    : "";

  return `
You are the Outreach Writer for a small-business sales-opportunity pipeline. A separate process
has already researched this company, formed and verified an opportunity, priced a concrete
offer, and found a contact. Your only job is to write ONE short, honest cold outreach email.

Company: ${company.name}

Opportunity:
- Problem: ${opportunity.problemTitle}
- Description: ${opportunity.problemDescription}
- Affected role: ${opportunity.affectedRole ?? "unknown"}
- Proposed solution: ${opportunity.proposedSolution}

Offer already built:
- Scope: ${offer.scope}
- Expected outcome: ${offer.expectedOutcome}
- Demo concept (a possible demo idea — has NOT been built): ${offer.demoConcept ?? "none"}

Contact to address: ${contactLine}

Evidence gathered about this company (only material actually found — ground your specific
observation in this, never invent a detail not listed here):
${formatEvidence(evidence)}

${OUTREACH_STYLE_RULES}

${OUTREACH_INTEGRITY_RULES}
${regenerationBlock}${retryBlock}
Return a single JSON object with exactly these fields: "subject" (short, specific, no hype) and
"body" (the full email body, greeting through sign-off, addressed to ${contact.name}).
`.trim();
}

export interface RunOutreachAgentInput {
  company: OutreachAgentCompanyInput;
  opportunity: OutreachAgentOpportunityInput;
  offer: OutreachAgentOfferInput;
  contact: OutreachAgentContactInput;
  evidence: OutreachAgentEvidenceInput[];
  /** Set by the handler when re-invoking after a deterministic lint failure (spec §39-40) —
   * distinct from `runStructuredAgent`'s own schema-validation retry, since this is a
   * business-logic quality check, not a shape failure. */
  regenerationReason?: string;
}

export interface RunOutreachAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runOutreachAgent(
  input: RunOutreachAgentInput,
  overrides: RunOutreachAgentOverrides = {},
): Promise<StructuredAgentResult<OutreachAgentOutput>> {
  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("reasoning"),
    tools: [],
    jsonSchema: outreachJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 5 * 60 * 1000,
    schema: outreachOutputSchema,
    buildPrompt: (retry) =>
      buildOutreachPrompt(
        {
          company: input.company,
          opportunity: input.opportunity,
          offer: input.offer,
          contact: input.contact,
          evidence: input.evidence,
        },
        input.regenerationReason ? { reason: input.regenerationReason } : undefined,
        retry,
      ),
  });
}
