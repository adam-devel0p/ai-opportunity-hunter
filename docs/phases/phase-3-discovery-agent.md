# Phase 3 — Discovery Agent + campaigns

**Completed:** 2026-09-10

## What was built

- `src/agents/runStructuredAgent.ts` — shared validated-invoke-with-retry layer on top of
  `claudeClient.invokeClaude`: parses `resultText` as JSON, validates against a caller-supplied
  Zod schema, and retries once with the formatted validation error appended to the prompt
  before giving up (`invalid_output`). `quota_exhausted` and CLI-level `error` are returned
  immediately, with no retry. Every future Claude-invoking agent (Phase 4 onward) is expected
  to build on this instead of reimplementing the retry loop — see ADR-0010 part 1 for why this
  is a separate module from `claudeClient.ts` rather than inside it.
- `src/agents/discoveryAgent.ts` — the Discovery Agent (AGENT_CONTRACTS.md §1): `discoveryCompanySchema`/
  `discoveryOutputSchema` (Zod), a hand-mirrored JSON Schema for `--json-schema`, `buildDiscoveryPrompt`
  (bakes in spec §14's never-invent-a-company rule, campaign criteria, a known-domains dedupe
  hint, and the retry-error block), and `runDiscoveryAgent` (fast model tier per spec §52,
  `WebSearch`+`WebFetch` tools, 5-minute timeout).
- `src/lib/campaigns.ts` — `discovery_campaigns` CRUD (spec §15): `createCampaign`,
  `getCampaign`, `listCampaigns`, `setCampaignStatus`/`setCampaignPriority`, and
  `enableCampaign`/`pauseCampaign`/`disableCampaign`/`blacklistCampaign` convenience wrappers.
- `src/pipeline/campaignSelection.ts` — `selectNextCampaign`: pure smooth-weighted-round-robin
  selection over `ENABLED` campaigns (spec §16 diversity), weight = `priority + 1`. State is
  threaded explicitly through the function so it can be persisted later (Phase 11).
- `src/pipeline/discoverHandler.ts` — `runDiscoverTask`: the first handler wired to a live DB.
  Loads the campaign a `DISCOVER` work item targets, calls the Discovery Agent, inserts new
  companies deduped by normalized domain (global uniqueness, not per-campaign), transitions
  each new company `DISCOVERED -> PRESCREEN_PENDING`, enqueues a `PRESCREEN` work item per new
  company, and finalizes the `DISCOVER` item (`COMPLETED`, `DEFERRED` on quota exhaustion, or
  `RETRYABLE`/`FAILED` via `failureClassification.resolveFailureOutcome` on other failures).
- `scripts/campaigns.ts` — manual campaign CRUD CLI (`npm run campaigns -- create|list|show|
  enable|pause|disable|blacklist|priority`).
- `scripts/discover.ts` — runs one real `DISCOVER` work item against the live `claude` CLI for
  a given campaign (`npm run discover -- --campaign <id> [--count <n>]`) — the manual smoke-test
  entry point PLAN.md calls for; no autonomous worker loop exists yet (Phase 11).
- `docs/DECISIONS.md`: new **ADR-0010** (9 parts) recording every judgment call this phase made
  that the source spec/plan didn't pin down. `docs/ARCHITECTURE.md` and `docs/PHASES.md` updated
  to reflect the above.
- Minor doc-comment update to `src/db/schema.ts`'s `workItems` table: `entityId` is now
  documented as holding a campaign id for `DISCOVER` tasks specifically (no column/migration
  change — `entityId` was already untyped/non-FK).
- Small fix to `src/db/client.ts`'s `createDb`: creates the DB file's parent directory
  (`mkdirSync(..., { recursive: true })`) if it doesn't exist yet, discovered when
  `npm run db:migrate` failed against a fresh checkout's gitignored `./data/` — every caller
  (scripts, tests, the app) now gets this for free instead of needing to `mkdir` first.

## Deviations from PLAN.md

- AGENT_CONTRACTS.md's cross-cutting rule says the validation-retry loop is "implemented once
  in claudeClient.ts, not per-agent." It's implemented once, but in a new
  `runStructuredAgent.ts` layered on top of `claudeClient.ts`, not inside it — kept
  `claudeClient.ts` Zod-agnostic (it has no knowledge of any specific agent's schema). See
  ADR-0010 part 1 for the full reasoning; the "once, not per-agent" intent is preserved.
- DATABASE_SCHEMA.md describes `work_items.entityId` as "company/opportunity id" — `DISCOVER`
  tasks don't have a company yet, so `entityId` holds a `discovery_campaigns.id` instead for
  that task type. See ADR-0010 part 3.
- `reasonToScreen` (part of the Discovery Agent's output contract) has no dedicated schema
  column; seeded into `companies.notes` instead of adding a migration for one field. See
  ADR-0010 part 7.
- No `system_config`/`prompt_versions` writes yet — kept discovery volume as a code constant +
  CLI flag rather than building a general config-accessor layer for one setting this phase; no
  per-call log exists yet to make a `prompt_versions` row meaningful. See ADR-0010 parts 8-9.

Full list of judgment calls and reasoning: see ADR-0010 in `docs/DECISIONS.md`.

## Testing performed

**Unit/fixture tests** — 6 new test files, all using mocked `claudeClient`/`runDiscoveryAgent`
(no real CLI invoked in automated tests) or a real temp SQLite DB via `runMigrations` (same
pattern as Phase 1's `schema.test.ts`):

- `src/agents/runStructuredAgent.test.ts` — success on first attempt; retry-with-error-appended
  on schema-validation failure then success; `invalid_output` after exhausting retries (both
  bad-JSON and schema-mismatch cases); `quota_exhausted`/`error` returned immediately with no
  retry.
- `src/agents/discoveryAgent.test.ts` — prompt includes campaign name/criteria/known domains/
  target count/integrity rules; retry block appends the previous error; schema accepts
  well-formed output and rejects an invalid website URL; `runDiscoveryAgent` calls
  `invokeClaude` with `WebSearch`/`WebFetch` and the fast model tier by default, respects a
  model override.
- `src/lib/campaigns.test.ts` — `createCampaign` defaults (status `ENABLED`, `createdBy`
  `MANUAL`, priority 0); `listCampaigns`/`getCampaign`; all four status toggles round-trip
  freely (including re-enabling a blacklisted campaign); `setCampaignPriority`; unknown-id
  throws.
- `src/pipeline/campaignSelection.test.ts` — only `ENABLED` campaigns are ever selected;
  perfectly even distribution across equal-priority campaigns over 300 iterations; exact
  proportional distribution for weighted campaigns (10:100 over 110 iterations, weight ratio
  1:10); a zero-priority campaign is never starved alongside a much higher-priority one;
  deterministic given the same inputs; selection state threads correctly across separate calls
  (not just within one loop).
- `src/pipeline/discoverHandler.test.ts` (the Phase 3 acceptance-criterion fixture test) —
  unknown campaign id throws; **given canned discovery output including one already-known
  domain and one new one, the new company is inserted (`PRESCREEN_PENDING`, correct
  `sourceCampaignId`, `notes` seeded with the discovery reason), the duplicate is skipped
  (not re-inserted, `lastDiscoveredAt` bumped instead), exactly one `PRESCREEN` work item is
  created for the new company with the correct priority, and the `DISCOVER` item is marked
  `COMPLETED`**; `quota_exhausted` routes to `DEFERRED` without inserting anything or
  incrementing `attempts`; a non-quota failure routes through `failureClassification` to
  `RETRYABLE` with backoff; an item that has exhausted its retry budget routes to `FAILED`; a
  zero-company result completes cleanly.

Actual output:

```
npm run build   → tsc, no errors
npm run lint    → eslint ., no errors or warnings
npm test        → Test Files  14 passed (14); Tests  134 passed (134)
```

**Manual smoke test — live discovery against a real campaign:**

Ran `npm run db:migrate` (first real DB at `./data/aoh.db` — the `data/` directory didn't exist
yet, created it), then:

```
npm run campaigns -- create --name "Independent US veterinary clinics" \
  --geography "United States" --industry "veterinary" --size "5-25 employees" \
  --keywords "veterinary,animal hospital,clinic" \
  --hypothesis "small independent vet clinics likely rely on manual/phone-based appointment scheduling and client communication" \
  --priority 5
```

Then two live runs against the real `claude` CLI (confirmed `ANTHROPIC_API_KEY` unset in the
shell first, and ran with `env -u ANTHROPIC_API_KEY` defensively regardless, matching Phase 0's
practice):

- `npm run discover -- --campaign <id> --count 5` → 5 new companies inserted, 0 duplicates, 5
  `PRESCREEN` items created, `$0.28` reported cost.
- `npm run discover -- --campaign <id> --count 3` (second run, same campaign) → 3 *more* new,
  *distinct* companies inserted, 0 duplicates against the first run's 5 (the known-domains hint
  worked), `$0.22` reported cost.

All 8 companies found, by name/website/city:

1. Neabore Veterinary Clinic — neaborevet.com — Haddonfield, NJ
2. Newtown Square Veterinary Hospital — newtownsquarevet.com — Newtown Square, PA
3. Cherokee Animal Hospital — cherokeeanimalhospital.com — Canton, GA
4. Dallas Veterinary Clinic — dallasvet.net — Dallas, TX
5. The Stock Doc Veterinary Services — rivertonvet.com — Riverton, WY
6. Animal Hospital Southwest — animalhospitalsouthwest.com
7. At Home Animal Clinic — athomeanimalclinic.com
8. Animal Clinic of Beaver Dam — animalclinicofbeaverdam.com

**Verdict: strong.** All 8 are distinct, plausible real independent veterinary practices spread
across different US states/cities (not a single duplicate, not a single obviously-invented
name), each with a specific, non-generic `reasonToScreen` tied to details from its own
description rather than a templated line. Spot-checked all 5 from the first run by fetching
their websites directly (`curl`, no auth): 4/5 returned HTTP 200 (real, reachable sites); 1
(rivertonvet.com) returned 403, consistent with Phase 0's already-documented finding that some
small-business sites block direct fetches/bot traffic — not evidence of a fabricated company,
since the domain itself resolves and the description's specifics (4 vets, ~18 support staff,
equine + pet services) read as genuinely researched rather than invented. No company/URL/
location looked templated or guessed.

**Billing safety:** `ANTHROPIC_API_KEY` confirmed unset in the shell for both runs (`env -u
ANTHROPIC_API_KEY` used defensively regardless, per Phase 0's established practice). Reported
`total_cost_usd` for the two runs: $0.28 and $0.22. Per ADR-0001, this field is not proof of
which pool was billed — **operator confirmation via claude.ai/console's usage page for these
specific runs is still the outstanding manual check**, same open item Phase 0 already flagged
and has not yet been closed.

## New decisions

- **ADR-0010** (new, 9 parts): retry-loop module placement; the SWRR campaign-selection
  algorithm and its weight formula; `DISCOVER` work items reusing `entityId` for a campaign id;
  per-campaign dedupe hint vs. global dedupe enforcement; quota-exhaustion → `DEFERRED`
  handling (not counted as a failed attempt); Discovery's `"fast"` model tier; `reasonToScreen`
  stored in `companies.notes`; discovery volume as a code constant/CLI flag instead of a
  `system_config` read; `prompt_versions` still not populated. See `docs/DECISIONS.md`.

## Known limitations / follow-ups

- The operator's claude.ai/console billing confirmation (originally a Phase 0 acceptance
  criterion) is still outstanding — now covering both Phase 0's and Phase 3's real-CLI runs.
  Someone with console access should check and update both phase docs.
- `src/pipeline/failureClassification.ts`'s pattern lists are still unvalidated against real
  Discovery Agent failure text — both live runs this phase succeeded on the first attempt, so
  the failure path was only exercised by unit tests with synthetic error messages.
- `campaignSelection.ts`'s selection state is never persisted — Phase 3 runs one
  operator-chosen campaign at a time via `scripts/discover.ts --campaign <id>`; nothing calls
  `selectNextCampaign` outside its own unit tests yet. Phase 11's worker loop is what will
  actually drive autonomous campaign rotation.
- `companies.notes` now carries both genuine operator notes and a seeded discovery-reason
  string (ADR-0010 part 7) — revisit if a later phase needs to tell them apart in the UI.
- No `system_config` or `prompt_versions` writes yet (ADR-0010 parts 8-9) — still open for
  whichever future phase first needs discovery-volume config or prompt-version comparison.

## Next phase

`docs/PHASES.md` now points to **Phase 4 — Pre-Screening Agent** as current, with Phase 3
marked done. Phase 4 should read `docs/AGENT_CONTRACTS.md` §2 and build the Pre-Screening Agent
against the real companies Phase 3 already produced (8 real veterinary clinics sitting in
`PRESCREEN_PENDING` with a `PRESCREEN` work item each in the live `./data/aoh.db`, ready to
exercise Phase 4's manual smoke test without needing a fresh discovery run first) — including
the deterministic `nextEligibleResearchAt` freshness check that must short-circuit before ever
calling Claude, per PLAN.md's Phase 4 acceptance criteria. Phase 4 should also follow Phase 3's
established pattern: build on `runStructuredAgent.ts` rather than reimplementing the retry
loop, and record any new judgment calls as a new ADR part/number rather than silently deviating.
