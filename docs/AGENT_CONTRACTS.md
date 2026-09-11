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

**Input** (as actually implemented, `src/agents/offerBuilderAgent.ts`): the opportunity's factual
content (problem/solution/implementation/dependencies/risks/existing alternatives/estimated
duration/Phase 6's suggested price range/recurring-revenue note/demo-concept note) plus its
`opportunity_evaluations.adjustedScore`/`verifierConfidence` as context, and minimal company
context — only reachable via a `BUILD_OFFER` work item, which `verifyHandler.ts` enqueues
exclusively on a spec §32 gate pass, so this agent is never invoked for an opportunity that hasn't
survived Skeptical Verification.

**Output:**
```ts
z.object({
  scope: z.string(),
  expectedOutcome: z.string(),
  keyAssumptions: z.array(z.string()),
  durationEstimate: z.string(),
  // Whole currency units (matches the Opportunity Analysis Agent's convention, ADR-0013 part 5)
  // — the handler converts to cents at persist time.
  price: z.number().positive(),
  recurringPrice: z.number().positive().nullable(), // null, never 0, when there is none
  exclusions: z.string(),
  validationNeeded: z.string(),
  demoConcept: z.string(),
  whyCommerciallyAttractive: z.string(),
  // Not in this contract's original illustrative draft — added Phase 8 (ADR-0015 part 2) so an
  // out-of-band price (per src/lib/pricing.ts) carries a real, model-supplied reason.
  priceJustification: z.string().nullable(),
})
```

**Post-generation deterministic checks (`src/pipeline/offerHandler.ts`):**
- **Vague-offer lint** (`src/lib/offerLint.ts`, spec §34): `scope` is checked against a
  known-vague-phrase blocklist (spec §34's own "AI automation services." bad example plus close
  variants) and a minimum word-count floor. A match triggers exactly one regeneration (a second
  Claude call with the lint's reason appended as feedback, distinct from
  `runStructuredAgent`'s own schema-validation retry); a second consecutive match fails the work
  item rather than persisting a vague offer (ADR-0015 part 3).
- **Pricing band check** (`src/lib/pricing.ts`, spec §35): `price` is checked against the band
  resolved from `estimatedDurationDays` (`MICRO_FIX | SMALL_AUTOMATION | WORKFLOW_IMPLEMENTATION |
  LARGER_IMPLEMENTATION`, configurable, code-constant defaults — ADR-0015 part 1). Unlike the
  vague-offer lint, this never blocks persistence — it only ensures a justification is always
  recorded (the agent's own `priceJustification`, or a deterministic fallback note) whenever the
  price falls outside its band (ADR-0015 part 2).

On success, the opportunity collapses `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH` in one write
and a `FIND_CONTACT` work item is enqueued (Phase 9's agent, ADR-0015 part 4).

## 7. Contact Research Agent (Phase 9)

**Input** (as actually implemented, `src/agents/contactAgent.ts`): the company's identity fields
(`name`/`website`/`industry`/`country`/`sizeEstimate`) plus the opportunity's
`problemTitle`/`problemDescription`/`affectedRole` — only reachable via a `FIND_CONTACT` work
item, which `offerHandler.ts` enqueues unconditionally on every successful offer, so this agent is
never invoked for an opportunity that hasn't already survived Skeptical Verification and gotten a
concrete offer (spec §37 — "do not waste research capacity finding employees for businesses with
no credible sales opportunity"). Uses the `"fast"` model tier (ADR-0016 part 1: bounded identity
extraction via web tools, the same shape of task as Discovery, not open-ended reasoning) and
`WebSearch`+`WebFetch` tools.

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
A `superRefine` structurally couples `email`/`emailConfidence` (ADR-0016 part 2): `email: null`
requires `emailConfidence: "UNKNOWN"` and vice versa — a confidence label only means something
when there's an actual email it describes. When no specific named individual can be found, the
agent is instructed to return the correct role/title as `name` (e.g. `"Practice Manager"`) rather
than inventing a person — a valid, expected outcome, not a failure (ADR-0016 part 3).

**Post-generation enforcement (`src/lib/contactDisplay.ts`, spec §38's hard rule):**
`toContactDisplay`/`getContactDisplay` are the one read path any later phase (Outreach Writer,
the dashboard) should use instead of reading `contacts.emailConfidence` directly — `isVerifiedEmail`
is only ever true when `emailConfidence === "VERIFIED"`, by construction, so there is no code path
where a `GUESSED` row can be rendered as verified (ADR-0016 part 4). `isPreferredForInitialOutreach`
gives the same treatment to spec §38's softer preference (true for `PUBLICLY_LISTED`/`VERIFIED`).

Every completed `FIND_CONTACT` task forms exactly one `contacts` row regardless of the email
confidence found (same "form the record, let a read path judge it" pattern as Opportunity
Analysis, ADR-0013 part 2). On success, the opportunity transitions
`CONTACT_RESEARCH -> OUTREACH_READY` and a `WRITE_OUTREACH` work item is enqueued (Phase 10's
agent, ADR-0016 part 5).

## 8. Outreach Writer (Phase 10)

**Input** (as actually implemented, `src/agents/outreachAgent.ts`): the opportunity's
recipient-facing content only (`problemTitle`/`problemDescription`/`proposedSolution`/
`affectedRole` — deliberately no score, confidence, or penalty reasons, since those are internal
pipeline judgments, not something a recipient should ever see echoed back), the offer's
`scope`/`expectedOutcome`/`demoConcept`, the contact's `name`/`role`/
`isPreferredForInitialOutreach` (from `src/lib/contactDisplay.ts`, never the raw
`emailConfidence` enum — spec §38), and the opportunity's linked evidence (`claim` +
`classification`, for grounding and for the truthfulness check below) — only reachable via a
`WRITE_OUTREACH` work item, which `contactHandler.ts` enqueues unconditionally on every completed
contact search, so this agent is never invoked for an opportunity that hasn't already survived
Skeptical Verification and gotten both a priced offer and a contact. Uses the `"reasoning"` model
tier (ADR-0017 part 1: writing/judgment over already-gathered material, same reasoning as Offer
Builder) and no tools.

**Output:**
```ts
z.object({
  subject: z.string(),
  body: z.string(),
})
```

**Post-generation deterministic checks (`src/lib/outreachLint.ts`, run by
`src/pipeline/outreachHandler.ts`):**
- **Word count** (spec §39): the body must be 60-130 words.
- **Banned-phrase blocklist** (spec §39): spec's own exaggerated-marketing examples
  ("revolutionary AI solution", "transform your business with cutting-edge AI", "unlock the
  power of AI") plus close variants, and a small set of generic-mass-email openers ("Dear
  Sir/Madam", "To Whom It May Concern").
- **Truthfulness heuristic** (spec §40, ADR-0017 part 3): a structural approximation, not real
  claim-to-evidence tracing — any sentence matching a confident-assertion pattern modeled on spec
  §40's own bad example ("I noticed your team spends hours doing X") with no hedge word in the
  same sentence (modeled on spec §40's own good example's "if... is still being done manually, I
  think there may be...") fails the check, but only when the opportunity's evidence contains no
  FACT-classified item at all — if even one FACT exists, unhedged confident phrasing is allowed
  through.

A match on any check triggers exactly one regeneration (a second Claude call with every failing
reason appended as feedback, same "one regeneration then fail" pattern as `offerHandler.ts`'s
vague-offer lint, ADR-0015 part 3); a second consecutive failure fails the work item without
persisting a draft.

The agent signs off with a literal `"[Your name]"` placeholder rather than a configured operator
name (ADR-0017 part 4 — no such config exists yet, and the operator edits every draft before
sending regardless, per spec §41).

On success, exactly one `outreach_drafts` row is persisted at `status: "DRAFT"`. Unlike every
earlier stage, this handler does **not** transition `opportunities.status` and enqueues no
further work item (ADR-0017 part 5) — `OUTREACH_READY -> SENT` only happens when the operator
actually sends the email (spec §41/§45, a manual action, Phase 12/13 territory), never
automatically on draft generation. This is the last automated pipeline stage.

## Cross-cutting rules for every agent

- Every call records `taskType`, `model`, `promptVersion`, `timestamp`, `companyId`,
  structured output, final status, and errors (spec §82) — implemented once in
  `claudeClient.ts`, not per-agent.
- No agent is given "all previously researched companies" or a DB dump as context (spec §53).
- Chain-of-thought is never persisted, only structured outputs and evidence (spec §82).
