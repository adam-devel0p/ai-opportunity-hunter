/**
 * Phase 0 spike: prove that `claudeClient` + the CLI's WebSearch/WebFetch tools can produce
 * credible, evidence-graded research for a real company (PLAN.md Phase 0, risk #2).
 *
 * Usage: npm run spike:research -- <company-url>
 *
 * This is deliberately a throwaway script, not a Phase 5 deliverable: no persistence, no
 * Source-row provenance hook (ADR-0004, built when the DB exists), no retry-on-validation-
 * failure loop (AGENT_CONTRACTS.md's real contract does one retry with the Zod error appended
 * — skipped here since this is a one-shot manual check, not a production task handler).
 */

import { resolveModelAlias } from "../src/config/models.js";
import { invokeClaude } from "../src/agents/claudeClient.js";
import {
  deepResearchSpikeJsonSchema,
  deepResearchSpikeSchema,
} from "../src/agents/schemas/deepResearchSpike.js";

const RESEARCH_INTEGRITY_RULES = `
Research integrity rules — these are not negotiable, follow them exactly:
- Do not invent facts.
- Do not invent quotes.
- Do not invent employee counts.
- Do not invent revenue.
- Do not invent technologies.
- Do not invent customer volumes.
- Do not invent staff workload.
- Do not invent emails.
- Do not claim that something is manual merely because automation is not visible.
- Do not claim a business lacks a system merely because the system is not publicly visible.
- Do not claim a financial loss unless there is supporting evidence.
- When information cannot be established, record it as UNKNOWN rather than guessing.
- If a tool call is denied or fails, say so and record UNKNOWN — never fall back to answering
  from general/training-data knowledge and presenting it as if it came from this company's own
  public sources.
`.trim();

function buildPrompt(companyUrl: string): string {
  return `
You are researching one real company for a sales-opportunity pipeline. Your job is to find
evidence of a plausible, economically meaningful BUSINESS PROBLEM this company might have —
not to look for "where could we add AI." The eventual fix might be AI, ordinary software,
automation, integration, a script, better workflow, an existing SaaS product, or nothing at
all. You are gathering evidence about the business, not pitching a technology.

Company to research: ${companyUrl}

Use WebSearch and WebFetch to investigate this company's public-facing website and any other
public sources you can find (news, job listings, review sites, etc. — your judgment on what's
worth checking). Then produce a JSON object with:

- "evidence": an array of evidence items. Each item has:
  - "claim": one specific statement about the company.
  - "classification": one of FACT, INFERENCE, HYPOTHESIS, or UNKNOWN.
    - FACT: directly supported by a public source you actually fetched.
    - INFERENCE: a reasonable conclusion from one or more facts, not directly stated anywhere.
    - HYPOTHESIS: a possibility worth validating with the company, not yet grounded in facts.
    - UNKNOWN: something necessary to judge the opportunity, but not established by your
      research. Use this liberally rather than guessing.
  - "supportingExcerpt": a short excerpt or paraphrase from the source backing this claim (for
    UNKNOWN items, briefly say what you looked for and didn't find).
  - "sourceUrl": the exact URL you fetched that supports this claim.
  - "confidence": your confidence in this specific claim, 0 to 1.
- "candidateProblems": an array of short strings — raw, unrefined possible business problems
  suggested by the evidence above (this is not your final analysis, just candidates for a
  later, separate step to evaluate).

Produce at least 5 evidence items, and include at least one FACT and at least one UNKNOWN.

${RESEARCH_INTEGRITY_RULES}
`.trim();
}

async function main() {
  const companyUrl = process.argv[2];
  if (!companyUrl) {
    console.error("Usage: npm run spike:research -- <company-url>");
    process.exitCode = 1;
    return;
  }

  try {
    new URL(companyUrl);
  } catch {
    console.error(`Not a valid URL: ${companyUrl}`);
    process.exitCode = 1;
    return;
  }

  const model = resolveModelAlias("reasoning");
  console.error(`Researching ${companyUrl} with model alias "${model}"...`);

  const result = await invokeClaude({
    prompt: buildPrompt(companyUrl),
    model,
    tools: ["WebSearch", "WebFetch"],
    jsonSchema: deepResearchSpikeJsonSchema,
    timeoutMs: 5 * 60 * 1000,
  });

  switch (result.status) {
    case "quota_exhausted": {
      console.error("Claude usage limit reached:");
      console.error(result.message);
      process.exitCode = 2;
      return;
    }
    case "invalid_json": {
      console.error(result.message);
      console.error("--- raw stdout ---");
      console.error(result.stdout);
      process.exitCode = 1;
      return;
    }
    case "error": {
      console.error(result.message);
      if (result.stderr) {
        console.error("--- stderr ---");
        console.error(result.stderr);
      }
      process.exitCode = 1;
      return;
    }
    case "success": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.resultText);
      } catch (err) {
        console.error(`Model output was not valid JSON: ${(err as Error).message}`);
        console.error("--- raw result text ---");
        console.error(result.resultText);
        process.exitCode = 1;
        return;
      }

      const validation = deepResearchSpikeSchema.safeParse(parsed);
      if (!validation.success) {
        console.error("Model output did not match the expected schema:");
        console.error(validation.error.format());
        console.error("--- raw parsed output ---");
        console.error(JSON.stringify(parsed, null, 2));
        process.exitCode = 1;
        return;
      }

      console.log(JSON.stringify(validation.data, null, 2));
      console.error(
        `\n(cost: $${result.costUsd ?? "unknown"}, duration: ${result.durationMs ?? "unknown"}ms — ` +
          "check claude.ai/console usage page to confirm this billed to your subscription, not API credits)",
      );
      return;
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
