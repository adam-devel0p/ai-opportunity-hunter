# Agent contracts

Every Claude invocation goes through `src/agents/claudeClient.ts` (ADR-0001) and returns JSON
validated against a Zod schema before anything touches the database (spec §54). If validation
fails, the wrapper retries once with the validation error appended to the prompt, then marks
the work item `FAILED` with the error recorded — it never persists unvalidated output.

Each agent below is deliberately given the **minimum** context it needs (spec §53): a
company's deep-research call never sees other companies' data, the skeptic sees the research
+ proposal but not the analysis agent's own confidence framing (fresh-context critique, spec
§33).

Shapes below are illustrative Zod-schema pseudocode, not final — the implementing phase
should treat these as the contract to hit, refine exact field types as needed, and record the
real schema in `src/agents/schemas/`.

## 1. Discovery Agent (Phase 3)

**Input:** campaign criteria (geography, industry, size range, keywords, hypothesis),
list of already-known domains for this campaign (for dedupe hinting, not exhaustive).

**Output:**
```ts
z.object({
  companies: z.array(z.object({
    name: z.string(),
    website: z.string().url(),
    country: z.string(),
    industry: z.string(),
    description: z.string(),
    sizeEstimate: z.string().nullable(),
    reasonToScreen: z.string(),
  })),
})
```
Constraint enforced in the prompt + spot-checked: never invent a company/URL (spec §14).

## 2. Pre-Screening Agent (Phase 4)

**Input:** company record + a handful of fetched pages (homepage, services/about/contact
if reachable).

**Output:**
```ts
z.object({
  classification: z.enum(["DISCARD", "MAYBE", "PROMISING"]),
  reasons: z.array(z.string()),
})
```

## 3. Deep Research Agent (Phase 5)

**Input:** company record only. Given `WebSearch`/`WebFetch` tools and free rein to decide
which sources to check (spec §19); the ADR-0004 hook captures every fetch as a `Source` row
independent of what the agent reports.

**Output:**
```ts
z.object({
  evidence: z.array(z.object({
    claim: z.string(),
    classification: z.enum(["FACT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"]),
    supportingExcerpt: z.string(),
    sourceUrl: z.string().url(),
    confidence: z.number().min(0).max(1),
  })),
  candidateProblems: z.array(z.string()),  // raw material for the Opportunity Analysis Agent
})
```
System prompt hard-codes the research integrity rules from spec §24 verbatim (do not invent
X, do not claim absence of a system merely because it isn't publicly visible, etc.) — these
are not negotiable per-call instructions, they're baked into the prompt template itself.

## 4. Opportunity Analysis Agent (Phase 6)

**Input:** one company's evidence items (FACT/INFERENCE/HYPOTHESIS/UNKNOWN) + candidate
problems from Deep Research. Never sees other companies.

**Output:**
```ts
z.object({
  problemTitle: z.string(),
  problemDescription: z.string(),
  problemCategory: z.string(),
  economicImpact: z.string(),
  impactAssumptions: z.array(z.object({ assumption: z.string(), isKnown: z.boolean() })),
  affectedRole: z.string(),
  proposedSolution: z.string(),
  implementationStrategy: z.string(),
  dependencies: z.array(z.string()),
  risks: z.array(z.string()),
  existingAlternatives: z.array(z.string()),
  estimatedDurationDays: z.number(),
  suggestedPriceMin: z.number(),
  suggestedPriceMax: z.number(),
  recurringRevenuePossibility: z.string().nullable(),
  demoConcept: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  validationQuestion: z.string(),
})
```
Raw score (spec §30) is **not** produced by Claude — `src/lib/scoring.ts` computes it
deterministically from this output + the linked evidence. Claude does not self-score.

## 5. Skeptical Verification Agent (Phase 7)

**Input:** the opportunity + its evidence, in a fresh context (no access to the Opportunity
Analysis Agent's own reasoning/confidence, spec §33).

**Output:**
```ts
z.object({
  result: z.enum(["KEEP", "REJECT"]),
  adjustedConfidence: z.number().min(0).max(1),
  weaknesses: z.array(z.string()),
  unsupportedAssumptions: z.array(z.string()),
  missingInformation: z.array(z.string()),
  dealkillers: z.array(z.string()),
})
```
Prompt explicitly instructs the model to try to disprove the opportunity (spec §33 question
list embedded verbatim) and to be biased toward REJECT on mediocre cases.

## 6. Offer Builder (Phase 8)

**Input:** opportunity + evaluation (only if `verifierResult === "KEEP"` and gating passed,
spec §32).

**Output:**
```ts
z.object({
  scope: z.string(),
  expectedOutcome: z.string(),
  keyAssumptions: z.array(z.string()),
  durationEstimate: z.string(),
  price: z.number(),
  recurringPrice: z.number().nullable(),
  exclusions: z.string(),
  validationNeeded: z.string(),
  demoConcept: z.string(),
  whyCommerciallyAttractive: z.string(),
})
```
Post-generation deterministic lint: reject/regenerate if `scope` matches a vague-offer
blocklist (e.g. bare "AI automation services") per spec §34's explicit bad example.

## 7. Contact Research Agent (Phase 9)

**Input:** company + opportunity's `affectedRole`. Only invoked after gating passes (spec
§37 — never spend research budget on contacts for weak opportunities).

**Output:**
```ts
z.object({
  name: z.string(),
  role: z.string(),
  source: z.string(),
  profileUrl: z.string().url().nullable(),
  email: z.string().email().nullable(),
  emailSource: z.string().nullable(),
  emailConfidence: z.enum(["PUBLICLY_LISTED", "VERIFIED", "GUESSED", "UNKNOWN"]),
})
```

## 8. Outreach Writer (Phase 10)

**Input:** opportunity + offer + contact. 60-130 words (spec §39), enforced by a
deterministic post-generation check that regenerates on violation rather than trusting the
model's word count.

**Output:**
```ts
z.object({
  subject: z.string(),
  body: z.string(),
})
```
Deterministic post-checks (spec §40): banned marketing-phrase list, word count range, and a
truthfulness heuristic (any sentence implying certainty — "you spend hours on X" — must trace
to a FACT-classified evidence item, not just an INFERENCE/HYPOTHESIS one; hedged phrasing
like "if... is still done manually" is required when the underlying evidence is only
INFERENCE/HYPOTHESIS).

## Cross-cutting rules for every agent

- Every call records `taskType`, `model`, `promptVersion`, `timestamp`, `companyId`,
  structured output, final status, and errors (spec §82) — implemented once in
  `claudeClient.ts`, not per-agent.
- No agent is given "all previously researched companies" or a DB dump as context (spec §53).
- Chain-of-thought is never persisted, only structured outputs and evidence (spec §82).
