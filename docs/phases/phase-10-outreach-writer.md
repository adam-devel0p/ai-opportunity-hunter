# Phase 10 — Outreach Writer

**Completed:** 2026-09-11

## What was built

- `src/agents/outreachAgent.ts` — the Outreach Writer (AGENT_CONTRACTS.md §8): `outreachOutputSchema`
  (Zod — `{ subject, body }`), a hand-mirrored JSON Schema, `buildOutreachPrompt` (embeds spec
  §39's style rules and spec §40's bad/good truthfulness examples verbatim, warns the model when
  the contact isn't preferred for initial outreach per spec §38, and signs off with a literal
  `"[Your name]"` placeholder), and `runOutreachAgent` (reasoning model tier, no tools). Supports
  a `regenerationReason` input distinct from the schema-validation retry, used by the handler's
  deterministic-lint regeneration.
- `src/lib/outreachLint.ts` — three independent deterministic checks (spec §39-40):
  `checkOutreachWordCount` (60-130 words), `checkOutreachBannedPhrases` (spec §39's exact
  hype-marketing examples plus close variants, and generic-mass-email openers), and
  `checkOutreachTruthfulness` (a structural approximation of spec §40's fact-grounding
  requirement — unhedged confident-assertion phrasing only fails the check when the opportunity's
  evidence has zero FACT-classified items). `lintOutreachDraft` combines all three and aggregates
  every failing reason at once.
- `src/pipeline/outreachHandler.ts` — `runWriteOutreachTask`: the eighth and final live-DB-wired
  handler of the core pipeline. Loads the opportunity a `WRITE_OUTREACH` item targets (`entityId`
  is an opportunity id, same convention as `VERIFY`/`BUILD_OFFER`/`FIND_CONTACT`, set by
  `contactHandler.ts`), its `offers` row, its linked evidence, and the company's most recent
  `contacts` row; runs the Outreach Writer; regenerates once on a lint failure, fails the task on
  a second consecutive failure without persisting a draft. On success, persists one
  `outreach_drafts` row at `status: "DRAFT"` and appends a summary to `companies.notes` — but
  deliberately does **not** transition `opportunities.status` or enqueue further work, since
  actually sending mail is a manual operator action (spec §41), not this handler's job.
- `scripts/outreach.ts` — manual smoke-test entry point: `npm run outreach -- --opportunity <id>`
  for one opportunity, or `--all [--limit <n>]` for every `PENDING` `WRITE_OUTREACH` item; prints
  the generated subject/body. Not run live this phase — see "Testing performed" below.
- `docs/AGENT_CONTRACTS.md` §8 updated to the real, final input/output shape and the
  post-generation enforcement. `docs/ARCHITECTURE.md` and `docs/PHASES.md` updated to reflect the
  above.
- `docs/DECISIONS.md`: new **ADR-0017** (7 parts) recording this phase's judgment calls.
- `package.json`: new `"outreach": "tsx scripts/outreach.ts"` script, same convention as `contact`.

## Deviations from PLAN.md

None from PLAN.md's stated Phase 10 scope. Two things PLAN.md/AGENT_CONTRACTS.md left implicit
that this phase had to resolve (both documented in ADR-0017, not oversights):

1. Spec §40's truthfulness check is described as tying confident phrasing to FACT-classified
   evidence, but nothing in the spec or PLAN specifies *how* to link a specific sentence to a
   specific evidence item without an LLM judge (which would defeat the point of a deterministic
   check). This phase implements the coarser, still-meaningful approximation PLAN.md's own
   "assert structural properties, not exact wording" framing calls for — see ADR-0017 part 3.
2. Spec §87's example email signs with a real name ("Mario"), but no `system_config`/env-var
   carries the operator's identity anywhere in this codebase. Rather than invent one (which would
   itself be a kind of fabrication), the agent signs off with a literal `"[Your name]"`
   placeholder that the operator fills in during their mandatory pre-send review — see ADR-0017
   part 4.

## Testing performed

**Unit/fixture tests** — 3 new test files, using mocked `invokeClaude`/`runOutreachAgent` or a
real temp SQLite DB via `runMigrations` (same conventions as Phases 3-9; no real CLI invoked in
automated tests):

- `src/lib/outreachLint.test.ts` — `countWords` on messy whitespace; `checkOutreachWordCount` at
  both boundaries and outside them; `checkOutreachBannedPhrases` against spec §39's exact banned
  examples (case-insensitively, checking the subject too) and generic-mass-email openers, passing
  on ordinary copy; `checkOutreachTruthfulness` against spec §40's own bad example (rejected with
  no FACT evidence), spec §40's own good example (accepted even with no FACT evidence, since it's
  properly hedged), the same unhedged bad example accepted once a FACT evidence item exists, and
  plain copy with no confident-assertion phrasing at all; `lintOutreachDraft` aggregating multiple
  simultaneous failures and passing a fully compliant draft.
- `src/agents/outreachAgent.test.ts` — prompt includes company/opportunity/offer/contact content
  and the evidence list with classifications; embeds spec §40's bad/good examples and spec §39's
  banned-phrase examples plus the never-claim-a-demo-exists rule verbatim; warns the model when
  the contact isn't preferred for initial outreach; includes a regeneration block distinct from
  the schema-validation retry block. Schema accepts a well-formed `{subject, body}` and rejects a
  missing body. `runOutreachAgent` calls `invokeClaude` with the reasoning tier and no tools.
- `src/pipeline/outreachHandler.test.ts` — unknown opportunity id throws; missing `offers` row
  throws; missing `contacts` row throws; a compliant draft is persisted with the opportunity left
  at `OUTREACH_READY` and no further work item created; a lint failure triggers exactly one
  regeneration with the failing reasons passed through, and the company note records the
  regeneration; a draft still failing after regeneration fails the task without persisting
  anything; `quota_exhausted` → `DEFERRED` without counting an attempt; non-quota failure →
  `RETRYABLE` with backoff; exhausted attempts → `FAILED`.

Actual output:

```
npm run build     → tsc, no errors
npm run lint      → eslint ., no errors or warnings
npm test          → Test Files  38 passed (38); Tests  350 passed (350)
```

**No live manual smoke test this phase.** PLAN.md's Phase 10 acceptance criteria ask for the
operator to read 3-5 generated drafts against real opportunities from earlier phases — but
querying the live `data/aoh.db` confirms all 8 real veterinary-clinic opportunities carried
through from Phases 3-7 are still `VERIFIER_REJECTED`, and no `offers` or `contacts` row has ever
existed. There is no live `OUTREACH_READY` opportunity with a real `PENDING` `WRITE_OUTREACH`
item to run `scripts/outreach.ts` against, without first re-running fresh
discovery/prescreen/research/analyze/verify/offer/contact for a new company, which is out of this
phase's own scope — same blocker Phases 8 and 9 already documented (ADR-0015 part 5, ADR-0016
part 6). `scripts/outreach.ts` exists (same shape as `scripts/contact.ts`) and is ready for the
next real `OUTREACH_READY` opportunity, whenever one exists.

## New decisions

- **ADR-0017** (new, 7 parts): model tier (`"reasoning"`, no tools) and why; the three
  independent deterministic-check modules and their "collect every reason" aggregation (unlike
  `offerLint.ts`'s short-circuit); the truthfulness heuristic's structural-approximation design
  and its limits; the `"[Your name]"` sign-off placeholder and why no fabricated name was used
  instead; the deliberate no-status-transition/no-enqueue behavior (this is the first handler
  that doesn't collapse the opportunity to a new status); the company-keyed contact lookup (no
  `opportunityId` column on `contacts`); and the deferred live smoke test. See
  `docs/DECISIONS.md`.

## Known limitations / follow-ups

- `scripts/outreach.ts` has not been exercised against the real `claude` CLI. The next session
  that gets a fresh company through the whole pipeline to a real `OUTREACH_READY` opportunity
  should run `npm run outreach -- --opportunity <id>` at least once and read the draft against
  spec §87's stated qualities (specific, truthful, short, human, low pressure, problem-focused,
  not AI-hype) before trusting this phase's prompt/lint design the way Phase 5's live
  evidence-quality check validated Deep Research.
- The truthfulness heuristic (`src/lib/outreachLint.ts`) only checks "does any FACT-classified
  evidence item exist at all," not "does a FACT actually support this specific sentence" — a
  coarser check than the spec's stated intent, chosen because exact claim-to-evidence tracing
  isn't achievable with deterministic pattern matching alone (see ADR-0017 part 3). Expect to
  extend its pattern lists as real drafts are checked against it, same as `riskCategory.ts`.
  Same open item flagged since ADR-0010 part 7.
- No `system_config`/`prompt_versions` writes yet, same as every prior phase.
- The operator's claude.ai/console billing confirmation remains outstanding for any future live
  run of this phase's agent (no cost was incurred this phase since nothing ran live).
- `OUTREACH_READY -> SENT` and `outreach_outcomes` recording have no code path yet — this
  handler deliberately stops at a `DRAFT` row. That's Phase 12 (dashboard action, marking a draft
  sent) and Phase 13 (outcome analytics) territory.

## Next phase

`docs/PHASES.md` now points to **Phase 11 — Autonomous scheduler/worker** as current, with Phase
10 marked done. Phase 11 should read PLAN.md's Phase 11 section: it builds `src/worker.ts`, the
long-running loop that wires every handler from Phases 3-10 (`DISCOVER` through `WRITE_OUTREACH`)
into continuous, quota-aware, pause/resume-able autonomous operation via `src/pipeline/priority.ts`'s
`selectNextWorkItem` and `src/pipeline/crashRecovery.ts`'s stuck-`RUNNING` reset (both already
built in Phase 2, never wired to a live loop until now). There is currently no live opportunity
past `VERIFIER_REJECTED` in the database — the worker's first real end-to-end run may still need
a fresh company to actually prove out the whole chain, same caveat every phase since Phase 8 has
carried forward.
