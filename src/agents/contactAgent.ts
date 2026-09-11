/**
 * Contact Research Agent (docs/AGENT_CONTRACTS.md §7, spec §37-38). Finds the real person most
 * likely to own a gated opportunity's problem, once contact research is actually worth spending
 * on — reachable only via a `FIND_CONTACT` work item, which `offerHandler.ts` enqueues on every
 * successful offer, so this agent is never invoked for an opportunity that hasn't already survived
 * Skeptical Verification and gotten a concrete offer (spec §37 — "do not waste research capacity
 * finding employees for businesses with no credible sales opportunity").
 *
 * Uses the "fast" model tier (ADR-0016 part 1): this is bounded identity extraction via
 * WebSearch/WebFetch — the same shape of task as Discovery (find a real, verifiable entity, never
 * invent one) — not open-ended reasoning over gathered evidence.
 */

import { z } from "zod";
import { resolveModelAlias } from "../config/models.js";
import { runStructuredAgent, type StructuredAgentResult } from "./runStructuredAgent.js";

export const contactOutputSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    source: z.string(),
    profileUrl: z.string().url().nullable(),
    email: z.string().email().nullable(),
    emailSource: z.string().nullable(),
    emailConfidence: z.enum(["PUBLICLY_LISTED", "VERIFIED", "GUESSED", "UNKNOWN"]),
  })
  .superRefine((data, ctx) => {
    // Structural half of spec §38's hard rule (the other half is
    // src/lib/contactDisplay.ts, enforced at the data-access layer): a confidence label only
    // means something when there's an actual email it describes, and vice versa.
    if (data.email === null && data.emailConfidence !== "UNKNOWN") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emailConfidence"],
        message: 'emailConfidence must be "UNKNOWN" when email is null',
      });
    }
    if (data.email !== null && data.emailConfidence === "UNKNOWN") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emailConfidence"],
        message: 'emailConfidence must not be "UNKNOWN" when an email is present',
      });
    }
  });

export type ContactAgentOutput = z.infer<typeof contactOutputSchema>;

/**
 * Hand-mirrored JSON Schema for `contactOutputSchema` (ADR-0007 — a first line of defense only;
 * Zod validation via `runStructuredAgent` remains the source of truth, including the
 * email/emailConfidence coupling above, which `--json-schema` alone cannot express).
 */
export const contactJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    role: { type: "string" },
    source: { type: "string" },
    profileUrl: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    emailSource: { type: ["string", "null"] },
    emailConfidence: {
      type: "string",
      enum: ["PUBLICLY_LISTED", "VERIFIED", "GUESSED", "UNKNOWN"],
    },
  },
  required: ["name", "role", "source", "profileUrl", "email", "emailSource", "emailConfidence"],
} as const;

/** Spec §37's own list of preferred contact roles, verbatim — not exhaustive, but a strong prior
 * for "who most likely owns this problem." */
const PREFERRED_CONTACT_ROLES = [
  "owner",
  "founder",
  "managing director",
  "operations director",
  "head of operations",
  "relevant department head",
  "commercial director",
  "technical owner",
  "practice manager",
  "recruitment director",
  "customer service lead",
];

const CONTACT_INTEGRITY_RULES = `
Contact research integrity rules — these are not negotiable, follow them exactly:
- Never invent a person's name. Only report a specific named individual if you found genuine
  evidence of them (a team/about page, a public profile, a press mention, a business registry
  filing, etc.) via WebSearch/WebFetch.
- If you cannot find a specific named individual who plausibly owns this problem, do not make
  one up. Instead return the correct role/title to target as "name" (e.g. "Practice Manager"),
  put the same title in "role", and explain in "source" that no specific name was found — this is
  a valid, expected outcome, not a failure.
- Never invent an email address. Only report "email" when you found real evidence of it.
- Classify email confidence honestly:
  - "PUBLICLY_LISTED": the email literally appears on a page you fetched.
  - "VERIFIED": you independently confirmed this exact address through more than one credible,
    consistent source — not just a plausible-looking guess.
  - "GUESSED": you inferred the address from a naming pattern (e.g. firstname@domain) without
    directly confirming it. Never mark a guessed address VERIFIED or PUBLICLY_LISTED just because
    the pattern seems likely.
  - "UNKNOWN": no usable email found. Set "email" and "emailSource" to null.
- Never represent a guessed email as verified or publicly listed. An operator will act on your
  confidence label directly — a wrong label here means a cold email sent to a guessed address as
  if it were confirmed.
`.trim();

export interface ContactAgentCompanyInput {
  name: string;
  website: string;
  industry: string | null;
  country: string | null;
  sizeEstimate: string | null;
}

export interface ContactAgentOpportunityInput {
  problemTitle: string;
  problemDescription: string;
  affectedRole: string | null;
}

export interface BuildContactPromptInput {
  company: ContactAgentCompanyInput;
  opportunity: ContactAgentOpportunityInput;
}

export function buildContactPrompt(
  input: BuildContactPromptInput,
  retry?: { previousError: string },
): string {
  const { company, opportunity } = input;

  const companyLines = [
    `- Name: ${company.name}`,
    `- Website: ${company.website}`,
    `- Country: ${company.country ?? "unknown"}`,
    `- Industry: ${company.industry ?? "unknown"}`,
    `- Size estimate: ${company.sizeEstimate ?? "unknown"}`,
  ];

  const opportunityLines = [
    `- Problem: ${opportunity.problemTitle}`,
    `- Description: ${opportunity.problemDescription}`,
    `- Role already identified as affected by this problem: ${opportunity.affectedRole ?? "not identified"}`,
  ];

  const retryBlock = retry
    ? `\nYour previous response did not match the required output format. Fix this and try again:\n${retry.previousError}\n`
    : "";

  return `
You are the Contact Research Agent for a small-business sales-opportunity pipeline. This company
already has a verified, priced sales opportunity — your only job is to find the real person most
likely to own the problem below, so a human operator can reach out to them.

Company:
${companyLines.join("\n")}

Opportunity this contact is for:
${opportunityLines.join("\n")}

Use WebSearch and WebFetch to find the real decision-maker. Commonly useful sources: the
company's own team/about/contact pages, LinkedIn, business registries, local press. Preferred
roles, depending on the problem (not exhaustive — use judgment about who actually owns this
specific pain):
${PREFERRED_CONTACT_ROLES.map((role) => `- ${role}`).join("\n")}

Return a JSON object with exactly these fields: "name", "role", "source" (where/how you found
this — a page, a directory, a search result), "profileUrl" (a public profile URL if you found
one, else null), "email" (or null), "emailSource" (where the email came from, or null),
"emailConfidence" (one of "PUBLICLY_LISTED", "VERIFIED", "GUESSED", "UNKNOWN").

${CONTACT_INTEGRITY_RULES}
${retryBlock}`.trim();
}

export interface RunContactAgentInput {
  company: ContactAgentCompanyInput;
  opportunity: ContactAgentOpportunityInput;
}

export interface RunContactAgentOverrides {
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function runContactAgent(
  input: RunContactAgentInput,
  overrides: RunContactAgentOverrides = {},
): Promise<StructuredAgentResult<ContactAgentOutput>> {
  return runStructuredAgent({
    model: overrides.model ?? resolveModelAlias("fast"),
    tools: ["WebSearch", "WebFetch"],
    jsonSchema: contactJsonSchema,
    claudeBin: overrides.claudeBin,
    timeoutMs: overrides.timeoutMs ?? 5 * 60 * 1000,
    schema: contactOutputSchema,
    buildPrompt: (retry) =>
      buildContactPrompt({ company: input.company, opportunity: input.opportunity }, retry),
  });
}
