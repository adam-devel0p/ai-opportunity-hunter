# Phase 9 — Contact Research Agent

**Completed:** 2026-09-11

## What was built

- `src/agents/contactAgent.ts` — the Contact Research Agent (AGENT_CONTRACTS.md §7):
  `contactOutputSchema` (Zod — `name`, `role`, `source`, `profileUrl` (nullable URL), `email`
  (nullable), `emailSource` (nullable), `emailConfidence` (`PUBLICLY_LISTED | VERIFIED | GUESSED |
  UNKNOWN`), with a `superRefine` structurally coupling `email`/`emailConfidence` — `null` email
  requires `"UNKNOWN"` confidence and vice versa), a hand-mirrored JSON Schema,
  `buildContactPrompt` (embeds spec §37's preferred-contact-roles list verbatim and
  never-invent-a-person/email integrity rules covering all four confidence states), and
  `runContactAgent` (fast model tier, `WebSearch`+`WebFetch` tools).
- `src/lib/contactDisplay.ts` — the data-access-layer enforcement of spec §38's hard rule:
  `toContactDisplay` (pure) computes `isVerifiedEmail` as literally `emailConfidence ===
  "VERIFIED"` and `isPreferredForInitialOutreach` as `PUBLICLY_LISTED || VERIFIED`; `getContactDisplay`
  is the same thing as a real DB read by contact id, for whichever later phase first needs one.
- `src/pipeline/contactHandler.ts` — `runFindContactTask`: the seventh live-DB-wired task
  handler. Loads the opportunity a `FIND_CONTACT` item targets (`entityId` is an opportunity id,
  same convention as `VERIFY`/`BUILD_OFFER`, set by `offerHandler.ts` which enqueues this task
  type unconditionally on every successful offer) and the owning company; runs the Contact
  Research Agent with the opportunity's `problemTitle`/`problemDescription`/`affectedRole` as
  targeting context; persists exactly one `contacts` row regardless of the email confidence found;
  computes its outcome's `isVerifiedEmail`/`isPreferredForInitialOutreach` via
  `contactDisplay.ts` rather than reading `emailConfidence` inline; collapses the opportunity
  `CONTACT_RESEARCH -> OUTREACH_READY` in one write; appends a summary line to `companies.notes`;
  and enqueues a `WRITE_OUTREACH` work item for Phase 10. Quota exhaustion/other failures handled
  the same way as every earlier handler.
- `scripts/contact.ts` — manual smoke-test entry point: `npm run contact -- --opportunity <id>`
  for one opportunity, or `--all [--limit <n>]` for every `PENDING` `FIND_CONTACT` item. Not run
  live this phase — see "Testing performed" below.
- `docs/AGENT_CONTRACTS.md` §7 updated to the real, final input/output shape and the
  post-generation enforcement. `docs/ARCHITECTURE.md` and `docs/PHASES.md` updated to reflect the
  above.
- `docs/DECISIONS.md`: new **ADR-0016** (6 parts) recording this phase's judgment calls.
- `package.json`: new `"contact": "tsx scripts/contact.ts"` script, same convention as `offer`.

## Deviations from PLAN.md

None from PLAN.md's stated Phase 9 scope. One thing PLAN.md/AGENT_CONTRACTS.md left implicit and
this phase had to resolve: the illustrative output contract has no discriminator for "no specific
named individual found" (only `name: z.string()`, required). Rather than add one, the prompt
instructs the agent to return the correct role/title as `name` in that case — a deliberate design
choice, not an oversight, documented in ADR-0016 part 3.

## Testing performed

**Unit/fixture tests** — 3 new test files, using mocked `invokeClaude`/`runContactAgent` or a
real temp SQLite DB via `runMigrations` (same conventions as Phases 3-8; no real CLI invoked in
automated tests):

- `src/agents/contactAgent.test.ts` — prompt includes company/opportunity content and spec §37's
  preferred-roles list; embeds the never-invent-a-name/email integrity rules; includes a
  schema-validation retry block. Schema accepts a well-formed `PUBLICLY_LISTED` output and a
  well-formed `UNKNOWN` output with a null email; accepts `GUESSED`/`VERIFIED` with a non-null
  email; **rejects a null email paired with a non-`UNKNOWN` confidence and a non-null email paired
  with `UNKNOWN`** (the schema-level half of spec §38's coupling); rejects an invalid email string.
  `runContactAgent` calls `invokeClaude` with the fast tier and `WebSearch`+`WebFetch` tools.
- `src/lib/contactDisplay.test.ts` (the Phase 9 acceptance-criterion test) — `toContactDisplay`
  never marks a `GUESSED` row as verified or preferred regardless of what else it carries; marks
  `VERIFIED` as both, `PUBLICLY_LISTED` as preferred-but-not-verified, `UNKNOWN` as neither;
  preserves the original contact object. `getContactDisplay` round-trips through a real temp DB:
  **inserts a `GUESSED` contact row and asserts the read path cannot produce a verified
  representation of it** (`isVerifiedEmail` false) — the literal PLAN.md acceptance criterion,
  verified against a real persisted row, not just a fixture object. Also covers an unknown contact
  id returning `undefined`.
- `src/pipeline/contactHandler.test.ts` — unknown opportunity id throws; a `PUBLICLY_LISTED`
  contact is persisted, the opportunity transitions to `OUTREACH_READY`, and exactly one
  `WRITE_OUTREACH` item is enqueued at the right priority; **a `GUESSED` email still forms a
  contact and advances the opportunity, but the outcome and `companies.notes` never claim it's
  verified**; an `UNKNOWN` (no named individual, no email) result still forms a contact and
  advances the opportunity; `quota_exhausted` → `DEFERRED` without mutating the opportunity or
  touching attempts; non-quota failure → `RETRYABLE` with backoff; exhausted attempts → `FAILED`.

Actual output:

```
npm run build     → tsc, no errors
npm run lint      → eslint ., no errors or warnings
npm test          → Test Files  35 passed (35); Tests  316 passed (316)
```

**No live manual smoke test this phase.** PLAN.md's Phase 9 acceptance criteria ask for one
"against a few real gated opportunities from earlier phases," but Phase 7's live smoke test left
all 8 real veterinary-clinic opportunities carried through from Phases 3-7 `VERIFIER_REJECTED` —
none passed the gate — so there is no live `VERIFIED`/`OFFER_READY`/`CONTACT_RESEARCH` opportunity
with a real `PENDING` `FIND_CONTACT` item to run `scripts/contact.ts` against, without first
re-running fresh discovery/prescreen/research/analyze/verify/offer for a new company, which is out
of this phase's own scope (same blocker Phase 8 already documented, ADR-0015 part 5). Confirmed
via a direct query against the live `data/aoh.db`: all 8 `opportunities` rows are still
`VERIFIER_REJECTED`, and no `BUILD_OFFER`/`FIND_CONTACT` work item has ever existed.
`scripts/contact.ts` exists (same shape as `scripts/offer.ts`) and is ready for the next real
`OFFER_READY`/`CONTACT_RESEARCH` opportunity, whenever one exists.

## New decisions

- **ADR-0016** (new, 6 parts): model tier (`"fast"`, `WebSearch`+`WebFetch`) and why it differs
  from Opportunity Analysis/Skeptical Verification/Offer Builder's reasoning tier; the
  `email`/`emailConfidence` schema coupling; the no-named-individual-found design (return the
  role/title as `name`, not a sentinel); `contactDisplay.ts` as the dedicated, tested data-access
  enforcement of spec §38's hard rule; the single-write `CONTACT_RESEARCH -> OUTREACH_READY`
  collapse + `WRITE_OUTREACH` enqueue; the deferred live smoke test. See `docs/DECISIONS.md`.

## Known limitations / follow-ups

- `scripts/contact.ts` has not been exercised against the real `claude` CLI. The next session that
  gets a fresh company through the whole pipeline to a real `OFFER_READY`/`CONTACT_RESEARCH`
  opportunity should run `npm run contact -- --opportunity <id>` at least once and spot-check the
  result (is the person genuinely plausible and real, is the email-confidence label honest, does a
  `GUESSED` or `UNKNOWN` result actually read as uncertain rather than confident) before trusting
  this phase's prompt design the way Phase 5's live evidence-quality check validated Deep Research.
- The operator's claude.ai/console billing confirmation remains outstanding for any future live
  run of this phase's agent (no cost was incurred this phase since nothing ran live).
- `companies.notes` now carries an eighth kind of free-text content (Phase 9's `"Contact: ..."`
  line) — same open item flagged since ADR-0010 part 7; still no dedicated structured columns for
  any pipeline stage's audit-trail summary.
- `contactDisplay.ts`'s `getContactDisplay` (the DB-read form) has no live caller yet beyond its
  own tests — `contactHandler.ts` uses the pure `toContactDisplay` directly on the row it just
  inserted. Forward-looking for Phase 10/12, same pattern as `riskCategory.ts` ahead of Phase 7.
- No `system_config`/`prompt_versions` writes yet, same as every prior phase — still deferred to a
  later general config-accessor pass.
- `contacts.doNotContact` (spec §65) is untouched by this phase — always inserted at its schema
  default (`false`). Enforcing it in outreach generation is explicitly Phase 14 scope.

## Next phase

`docs/PHASES.md` now points to **Phase 10 — Outreach Writer** as current, with Phase 9 marked
done. Phase 10 should read `docs/AGENT_CONTRACTS.md` §8 and PLAN.md's Phase 10 section, and picks
up `WRITE_OUTREACH` work items this phase enqueues (`entityId` is an opportunity id, same
convention as `VERIFY`/`BUILD_OFFER`/`FIND_CONTACT`) — it will need to look up the opportunity's
company's most recent `contacts` row itself (no direct `opportunityId` column on `contacts`; the
link is via `companies.id`). As with Phase 8/9, there is currently no live opportunity sitting at
`OUTREACH_READY` with a real `PENDING` `WRITE_OUTREACH` item — Phase 10 will likely also rely on
fixture tests unless a fresh company is run through the full pipeline first. Phase 10 should read
contacts through `src/lib/contactDisplay.ts`, not `contacts.emailConfidence` directly, when
deciding how to phrase or gate outreach around email confidence (spec §38's "initial outreach
should strongly prefer publicly listed or independently verified addresses").
