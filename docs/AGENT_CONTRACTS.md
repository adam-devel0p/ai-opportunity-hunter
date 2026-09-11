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

**Input:** one company's evidence items (FACT/INFERENCE/HYPOTHESIS/UNKNOWN, with their source
URLs) + free-text prior-stage notes (including Deep Research's candidate problems, per spec §26).
Never sees other companies.

**Output** (as actually implemented, `src/agents/opportunityAnalysisAgent.ts`):
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
  estimatedDurationDays: z.number().nonnegative(),
  // Whole currency units (e.g. 750 == EUR 750), not cents — the handler converts at persist time.
  suggestedPriceMin: z.number().nonnegative(),
  suggestedPriceMax: z.number().nonnegative(), // must be >= suggestedPriceMin
  recurringRevenuePossibility: z.string().nullable(),
  demoConcept: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  validationQuestion: z.string(),
  // The ten spec §30 scoring judgments — Claude's inputs to the formula, never the formula's
  // own output. Ranges/keys are derived programmatically from src/lib/scoring.ts so this
  // contract can't drift out of sync with what the deterministic scorer enforces.
  scoreComponents: z.object({
    evidenceStrength: z.number().int().min(0).max(20),
    painSeverity: z.number().int().min(0).max(15),
    economicImpactScore: z.number().int().min(0).max(15),
    deliverability: z.number().int().min(0).max(15),
    purchaseLikelihood: z.number().int().min(0).max(10),
    speedToValue: z.number().int().min(0).max(5),
    reachability: z.number().int().min(0).max(5),
    demonstrability: z.number().int().min(0).max(5),
    repeatability: z.number().int().min(0).max(5),
    urgency: z.number().int().min(0).max(5),
  }),
  // Spec §31's ten named reasons (src/lib/scoring.ts's PENALTY_CATALOG) — can be empty.
  penaltyReasons: z.array(z.enum([/* PENALTY_CATALOG keys */])),
})
```
Raw/adjusted score (spec §30) are **not** produced by Claude — `src/lib/scoring.ts` sums
`scoreComponents` and subtracts `penaltyReasons`' catalog amounts deterministically. Claude
supplies the judgment inputs to the formula, never the formula's own output (and even if it did
emit a `rawScore`/`adjustedScore` field, the non-strict Zod schema silently drops unknown keys,
so there's no code path where a Claude-supplied number could reach the database). Uses the
`"reasoning"` model tier and no tools — see ADR-0013.

## 5. Skeptical Verification Agent (Phase 7)

**Input** (as actually implemented, `src/agents/skepticAgent.ts`): the opportunity's factual
content (`problemTitle`/`problemDescription`/`problemCategory`/`economicImpact`/
`impactAssumptions`/`affectedRole`/`proposedSolution`/`implementationStrategy`/`dependencies`/
`risks`/`existingAlternatives`/`estimatedDurationDays`/`suggestedPriceMin`/`suggestedPriceMax`/
`recurringRevenuePossibility`/`validationQuestion`, plus minimal company context) and its linked
evidence — in a fresh context that deliberately omits the Opportunity Analysis Agent's own
`confidence`, `scoreComponents`, and `penaltyReasons` (spec §33's "no access to the Opportunity
Analysis Agent's own reasoning/confidence framing"; `src/pipeline/verifyHandler.ts` enforces this
structurally by simply never reading those fields into the skeptic's input type, not merely by
prompt instruction — see ADR-0014 part 1). Uses the `"reasoning"` model tier and no tools (same
reasoning as Opportunity Analysis, ADR-0013 part 4: this is judgment over already-gathered
material, nothing left to fetch or search).

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

**Gating (spec §32):** `result` is one of four independent inputs to the deterministic
`src/lib/opportunityGate.ts` (`verifierResult`, `opportunity_evaluations.adjustedScore` vs. a
~75/100 threshold, `evidenceStrength` vs. a floor, and a deterministic risk-category
classification from `src/lib/riskCategory.ts`, spec §8) — any one failing check fails the whole
gate (see ADR-0014 parts 2-4). A gate pass transitions the opportunity `VERIFICATION_PENDING ->
VERIFIED` and enqueues `BUILD_OFFER`; any failure (not only an explicit skeptic REJECT) goes to
`VERIFIER_REJECTED` (ADR-0014 part 3).

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
