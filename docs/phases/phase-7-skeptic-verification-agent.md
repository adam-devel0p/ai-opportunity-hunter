# Phase 7 — Skeptical Verification Agent + strong-opportunity gating

**Completed:** 2026-09-11

## What was built

- `src/agents/skepticAgent.ts` — the Skeptical Verification Agent (AGENT_CONTRACTS.md §5):
  `skepticOutputSchema` (Zod: `result` KEEP/REJECT, `adjustedConfidence`, `weaknesses`,
  `unsupportedAssumptions`, `missingInformation`, `dealkillers`), a hand-mirrored JSON Schema,
  `buildSkepticPrompt` (embeds spec §33's 16-question list verbatim, instructs the model that its
  job is to find reasons the opportunity is bad — not improve it — and to be biased toward REJECT
  on mediocre cases), and `runSkepticAgent` (reasoning model tier, no tools). Its input type
  (`SkepticOpportunityInput`) structurally has no field for the Opportunity Analysis Agent's
  `confidence`, `scoreComponents`, or `penaltyReasons` — fresh-context enforcement by type shape,
  not just prompt wording (ADR-0014 part 1).
- `src/lib/riskCategory.ts` — `classifyOpportunityRisk` (spec §8): a deterministic keyword/phrase
  heuristic, one pattern per spec §8 high-risk domain, matched against the opportunity's
  `problemCategory`/`problemDescription`/`proposedSolution`/`implementationStrategy` text —
  deliberately never `companies.industry` alone, since spec §8's own example (clinic
  appointment-intake automation is fine, clinic diagnosis automation is not — same industry)
  rules that out. Two patterns require a same-*sentence* medical-context word
  (`requiresContext`, checked via a rough sentence splitter) after a live false positive (below)
  showed a whole-document co-occurrence check was too loose.
- `src/lib/opportunityGate.ts` — `evaluateOpportunityGate` (spec §32): the deterministic
  strong-opportunity gate combining `verifierResult`, `adjustedScore` vs. a configurable
  threshold (default 75), `evidenceStrength` vs. a configurable floor (default 10), and
  `riskCategory` vs. an operator opt-in (default: high-risk excluded). Any one failing check
  fails the whole gate; every failing reason is collected, not just the first. Pure function, no
  DB, no Claude call.
- `src/pipeline/verifyHandler.ts` — `runVerifyTask`: the fifth live-DB-wired task handler. Loads
  the opportunity a `VERIFY` work item targets (`entityId` is an opportunity id — the first task
  type where that's true), its `opportunity_evaluations` row, its linked evidence, and the owning
  company; runs the Skeptical Verification Agent with the fresh-context input; classifies risk;
  evaluates the gate; persists the skeptic's output into `opportunity_evaluations.verifier*`;
  transitions the opportunity to `VERIFIED` or `VERIFIER_REJECTED` in one write; appends a
  full-reasons summary (skeptic result + confidence, gate pass/fail + every reason, risk match)
  to `companies.notes`; and, only on a gate pass, enqueues a `BUILD_OFFER` work item. Quota
  exhaustion/other failures handled the same way as every earlier handler.
- `scripts/verify.ts` — manual smoke-test entry point: `npm run verify -- --opportunity <id>` for
  one opportunity, or `--all [--limit <n>]` for every `PENDING` `VERIFY` item.
- `docs/AGENT_CONTRACTS.md` §5 updated to the real, final input/output shape and the gating
  summary. `docs/ARCHITECTURE.md` and `docs/PHASES.md` updated to reflect the above.
- `docs/DECISIONS.md`: new **ADR-0014** (6 parts) recording this phase's judgment calls.

## Deviations from PLAN.md

None from PLAN.md's stated Phase 7 scope. One judgment call PLAN.md left implicit: the
`opportunities.status` enum (built Phase 1) only has `VERIFIED`/`VERIFIER_REJECTED` after
`VERIFICATION_PENDING` — there's no third value for "the skeptic said KEEP but the gate still
failed on score/evidence/risk." `VERIFIER_REJECTED` is reused for every gate failure, not only an
explicit skeptic REJECT, with the specific reason(s) always recorded in
`opportunity_evaluations.verifier*` (the skeptic's real output) and `companies.notes` (every gate
reason, which can include reasons the skeptic itself never raised). See ADR-0014 part 3.

## Testing performed

**Unit/fixture tests** — 4 new test files, using mocked `invokeClaude`/`runSkepticAgent` or a
real temp SQLite DB via `runMigrations` (same conventions as Phases 3-6; no real CLI invoked in
automated tests):

- `src/lib/riskCategory.test.ts` — generic automation is `STANDARD`; spec §8's own two contrasting
  examples (clinic appointment-intake automation `STANDARD`, automated patient diagnosis
  `HIGH_RISK`); credit-scoring and surveillance automation `HIGH_RISK`; industry alone (a law
  firm) doesn't trigger `HIGH_RISK` when the actual proposed solution is benign; multiple domains
  can match at once; and a regression test for the real "technical SEO diagnostic" false positive
  this phase's live smoke test caught (see below).
- `src/lib/opportunityGate.test.ts` (the Phase 7 acceptance-criterion gating-function tests) —
  a strong KEEP/high-score/standard-risk opportunity passes; REJECT alone fails even with a
  90/100 score and max evidence strength; score below threshold fails even on KEEP; exactly-at-
  threshold passes (`>=`, not strictly greater); thin evidence strength fails even with a passing
  score; `HIGH_RISK` fails by default even with every other check passing; a custom
  `allowHighRisk: true` config lets a `HIGH_RISK` opportunity through; every failing reason is
  collected at once (4 simultaneous failures asserted); a custom threshold/floor config is
  respected.
- `src/agents/skepticAgent.test.ts` — prompt includes the opportunity's content but never a
  `confidence`/`scoreComponents`/`penaltyReasons` field; evidence grouped by classification;
  handles zero evidence honestly; embeds the spec §33 question list verbatim; states the "not to
  improve the pitch" / "biased toward REJECT" instructions; appends the retry block; schema
  accepts well-formed output and rejects an out-of-range confidence or invalid `result` value;
  `runSkepticAgent` calls `invokeClaude` with no tools and the reasoning tier by default, respects
  a model override.
- `src/pipeline/verifyHandler.test.ts` (the Phase 7 acceptance-criterion fixture tests) — unknown
  opportunity id throws; **§88's bad-opportunity example carried through Phase 6**: mocked
  skeptic REJECTs, and the test seeds an artificially high adjusted score (90) specifically to
  prove REJECT alone fails gating regardless of score, per the acceptance criterion's own
  wording; **a borderline-but-thin opportunity** (mostly HYPOTHESIS/UNKNOWN evidence): mocked
  skeptic REJECTs even at a score (76) that's above threshold on its own, and the evidence-floor
  check independently fails too; **a §89-style strong, well-evidenced opportunity**: KEEP + score
  above threshold + standard risk passes, transitions to `VERIFIED`, enqueues exactly one
  `BUILD_OFFER` item at the right priority; **a high-risk-domain opportunity** (automated patient
  diagnosis) fails gating by default even with KEEP and a 90/100 score; **spec §8's own
  appointment-intake example** does NOT get flagged high-risk despite the same (healthcare)
  industry; a custom `gateConfig` (operator opt-in for high risk) is respected; `quota_exhausted`
  → `DEFERRED` without mutating the opportunity or touching attempts; non-quota failure →
  `RETRYABLE` with backoff; exhausted attempts → `FAILED`.

Actual output:

```
npm run build     → tsc, no errors
npm run lint      → eslint ., no errors or warnings
npm test          → Test Files  28 passed (28); Tests  255 passed (255)
```

**Manual smoke test — live verification against real opportunities:**

PLAN.md's Phase 7 acceptance criteria don't require a live run (same as Phase 6), but the 8 real
veterinary-clinic opportunities from Phases 3-6 were already sitting `VERIFICATION_PENDING` with
a `PENDING` `VERIFY` item, so ran it anyway before calling the phase done: confirmed
`ANTHROPIC_API_KEY` unset, then `npm run verify -- --all`.

**Result: all 8 succeeded and all 8 were REJECTed.** Every opportunity's skeptic `result` was
`REJECT` with low `adjustedConfidence` (0.10-0.22) — consistent with spec §33's "biased toward
rejecting mediocre opportunities" and with Phase 6's own completion doc, which already noted all
8 real opportunities scored 0-37/100, well below the ~75 gating threshold. Gate failure reasons
matched expectations: every opportunity failed on the explicit skeptic REJECT and the score
threshold; several also failed the evidence-strength floor (`evidenceStrength` 8-13, floor 10);
two were additionally flagged `HIGH_RISK` (see below). All 8 opportunities transitioned to
`VERIFIER_REJECTED`; zero `BUILD_OFFER` items were created (correctly — nothing passed). Total
reported cost: ~$0.83 across all 8 (~$0.10/opportunity — cheaper than Phase 6's Analysis calls,
consistent with a smaller, tool-free prompt).

**Live false positive caught and fixed mid-phase:** one opportunity ("Unverified bot-blocking...
may also block search-engine crawlers," a technical SEO/crawlability audit) was initially flagged
`HIGH_RISK` for "medical diagnosis" — the risk classifier's `diagnos\w*` pattern matched the
generic phrase "technical...diagnostic" with no medical content at all. The classifier's first-
draft fix (require a medical-context word to co-occur *anywhere in the document*) didn't fully
work either: the same opportunity's evidence text separately mentioned an unrelated "patient
portal," which satisfied a whole-document co-occurrence check despite being unrelated to the
"diagnostic" match. The real fix requires the diagnos/prescrib word and a medical-context word to
appear in the *same* rough sentence (`requiresContext`, checked per-sentence). Re-ran the
classifier against both real opportunities after the fix: the false positive is gone (now
`STANDARD`); a second, genuinely defensible match on a different opportunity (an intake-form
categorization opportunity whose proposed solution explicitly includes a "records request"
category, matching "highly sensitive regulated personal information") correctly still flags
`HIGH_RISK` — kept as intentional conservative behavior per ADR-0014 part 4, since a false
positive here only requires operator review, not an unrecoverable rejection. A regression test
for the fixed false positive was added to `riskCategory.test.ts`.

Note: the initial `--all` run (before the fix) already persisted `VERIFIER_REJECTED` for all 8
opportunities, including the one later found to have a spurious `HIGH_RISK` tag in its
`companies.notes` line — that opportunity's final `VERIFIER_REJECTED` status is unaffected by the
fix (it also failed on score and evidence-strength independently), so no re-run or data
correction was needed; only the notes line's risk annotation for that one company is now stale
relative to the fixed classifier. Flagged here for transparency, not corrected in the live DB (a
free-text audit-trail line, not load-bearing state).

**Billing safety:** `ANTHROPIC_API_KEY` confirmed unset in the shell before the run. Reported
`total_cost_usd` summed to ~$0.83 across all 8 opportunities. Per ADR-0001, this field is not
proof of which pool was billed — the operator's claude.ai/console usage-page confirmation remains
the same outstanding manual check flagged by every prior phase's live run.

## New decisions

- **ADR-0014** (new, 6 parts): the skeptic's input structurally omits the Analysis Agent's
  confidence/score judgments; the gate's four checks are independent and every failing reason is
  collected; `VERIFIER_REJECTED` is reused for every gate failure, not only an explicit REJECT;
  risk classification is a deterministic text heuristic (never `companies.industry` alone), with
  a same-sentence-proximity requirement added mid-phase after a real false positive; gate
  configuration defaults are code constants, not `system_config`; `BUILD_OFFER` is enqueued on a
  pass regardless of whether Phase 8 exists yet. See `docs/DECISIONS.md`.

## Known limitations / follow-ups

- The operator's claude.ai/console billing confirmation is still outstanding — now covering
  Phases 0, 3, 4, 5, 6, and 7's real-CLI runs.
- `src/lib/riskCategory.ts` is a keyword/phrase heuristic, not real NLP. It already needed one
  correction mid-phase from live data; expect more patterns/refinements once a wider variety of
  real opportunities (not just veterinary clinics) are classified against it.
- `DEFAULT_OPPORTUNITY_GATE_CONFIG`'s three constants (threshold 75, evidence floor 10,
  `allowHighRisk: false`) remain reasoned starting points, not empirically tuned — this phase's
  live run (all 8 real opportunities failing, none borderline-close to the threshold) doesn't
  exercise the threshold's precise value in a way that would validate or challenge it.
- No per-opportunity operator override for a `HIGH_RISK` classification exists yet — only a
  global `gateConfig.allowHighRisk` code-level flag. Spec §8's "unless explicitly reviewed by the
  operator" implies a real per-opportunity review action, which needs a dashboard (Phase 12) or
  at least a CLI flag to be practically usable.
- No `system_config`/`prompt_versions` writes yet, same as Phases 3-6 — still deferred.
- `companies.notes` now carries a sixth kind of content (the Phase 7 `"Verification: ..."` line)
  — same open item flagged since ADR-0010 part 7.

## Next phase

`docs/PHASES.md` now points to **Phase 8 — Offer Builder + pricing** as current, with Phase 7
marked done. Phase 8 should read `docs/AGENT_CONTRACTS.md` §6 and PLAN.md's Phase 8 section. All
8 real veterinary-clinic opportunities from Phases 3-7 are now `VERIFIER_REJECTED` (correctly, per
this phase's live run), so Phase 8 will need either a fresh discovery/prescreen/research/analyze/
verify run against new real companies to get a `VERIFIED` opportunity with a live `BUILD_OFFER`
item to test against, or can rely entirely on fixture tests (a mocked pipeline can produce a
`VERIFIED` opportunity directly, same as Phase 6/7's approach for their own fixtures) if a live
smoke test isn't required by PLAN.md's Phase 8 acceptance criteria.
