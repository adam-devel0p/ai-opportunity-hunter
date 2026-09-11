# Database schema (implemented in Phase 1)

SQLite, Drizzle ORM. Implemented as `src/db/schema.ts`, migrated with `drizzle-kit` into
`drizzle/*.sql` (committed — these are the real migration history, not build output). This doc
is the fast-reference version; the `.ts` file is the source of truth if they ever disagree.

Conventions: every table has `id` (text, `crypto.randomUUID()` — no extra cuid dependency
needed for a single-process local app), `createdAt`/`updatedAt` (unix-ms timestamps, set at
insert time; nothing yet auto-bumps `updatedAt` on update — callers pass it explicitly, since
no update code exists before Phase 2+). Enums are implemented as Drizzle's `text(col, {
enum: [...] })`, which gives a TS string-literal union on every read/write; this was judged
sufficient on its own (DB-level `CHECK` constraints were considered and skipped as redundant
belt-and-suspenders for a single-writer local app where the TS layer is the only writer).
The DB is opened with `journal_mode = WAL` and `foreign_keys = ON` (`src/db/client.ts`).

## `companies`

Identity + lifecycle for a discovered business (spec §14, §56).

| column | type | notes |
|---|---|---|
| id | text pk | |
| name | text | canonical name |
| normalizedDomain | text, unique | see normalization rules below |
| website | text | original URL as discovered |
| country | text | |
| region | text | nullable |
| industry | text | |
| businessType | text | nullable |
| sizeEstimate | text | nullable, free text ("10-20 employees") |
| sizeConfidence | enum | `FACT \| INFERENCE \| UNKNOWN` |
| language | text | nullable |
| description | text | |
| firstDiscoveredAt | timestamp | |
| lastDiscoveredAt | timestamp | updated if rediscovered |
| lastResearchedAt | timestamp | nullable |
| nextEligibleResearchAt | timestamp | nullable — re-research window, spec §60 |
| sourceCampaignId | text fk → discovery_campaigns.id | |
| lifecycleStatus | enum | `DISCOVERED \| PRESCREEN_PENDING \| PRESCREENED \| RESEARCH_PENDING \| RESEARCHED \| NO_OPPORTUNITY \| DISCARDED \| EXCLUDED` — the company-level portion of spec §90's flow only. See "Splitting spec §90 across tables" below. |
| exclusionReason | text | nullable |
| doNotContact | boolean | default false — spec §65 |
| notes | text | nullable, operator-editable |

**Domain normalization** (spec §17, implemented as a pure function in `src/lib/normalize.ts`,
unit-tested in Phase 1): lowercase host, strip `www.`, strip protocol, strip trailing slash,
strip query string/fragment for the identity key (the original `website` value is preserved
verbatim for display/click-through). `normalizedDomain` is the dedupe key with a unique index.

## `discovery_campaigns`

Spec §15.

| column | type | notes |
|---|---|---|
| id | text pk | |
| name | text | |
| criteria | json | geography, industry, size range, keywords, hypothesis |
| status | enum | `ENABLED \| PAUSED \| DISABLED \| BLACKLISTED` |
| priority | integer | operator-settable |
| createdBy | enum | `MANUAL \| CLAUDE_SUGGESTED` (Claude-suggested is a later phase; column exists from day one so it doesn't need a migration later) |
| notes | text | nullable |

## `sources`

A public source page/document actually fetched (spec §57, populated by the ADR-0004 hook).

| column | type | notes |
|---|---|---|
| id | text pk | |
| companyId | text fk | nullable — some sources aren't company-specific (e.g. a directory page) |
| url | text | |
| title | text | nullable |
| retrievedAt | timestamp | |
| fetchedByTaskId | text fk → work_items.id | which task fetched it |
| freshnessState | enum | `FRESH \| STALE \| UNAVAILABLE` — derived, see below |

Freshness is derived deterministically from `retrievedAt` vs a configurable threshold
(`src/lib/config.ts`), not asked of Claude.

## `evidence_items`

Spec §22, §57.

| column | type | notes |
|---|---|---|
| id | text pk | |
| companyId | text fk | |
| opportunityId | text fk | nullable — evidence can exist before an opportunity is formed |
| sourceId | text fk → sources.id | |
| claim | text | |
| classification | enum | `FACT \| INFERENCE \| HYPOTHESIS \| UNKNOWN` |
| supportingExcerpt | text | |
| confidence | real | 0-1 |
| generatedByTaskId | text fk → work_items.id | |
| generatedByPromptVersion | text | spec §81/§82 |

## `opportunities`

Spec §26, §58.

| column | type | notes |
|---|---|---|
| id | text pk | |
| companyId | text fk | |
| problemTitle | text | |
| problemDescription | text | |
| problemCategory | text | free text, seeded from a category list but not constrained to it (spec §25) |
| economicImpact | text | |
| impactAssumptions | json | `{assumption: string, isKnown: boolean}[]` — explicit known-vs-assumption list, spec §29 (Phase 6) |
| affectedRole | text | |
| proposedSolution | text | |
| implementationStrategy | text | |
| dependencies | json | text[] |
| risks | json | text[] |
| existingAlternatives | json | text[] — possible existing alternatives (spec §26), added Phase 6 |
| estimatedDurationDays | real | |
| suggestedPriceMin | integer | cents (Opportunity Analysis Agent expresses prices in whole currency units; the handler converts to cents at persist time, Phase 6) |
| suggestedPriceMax | integer | cents |
| recurringRevenuePossibility | text | nullable |
| demoConcept | text | nullable |
| confidence | real | |
| validationQuestion | text | nullable — proposed validation question (spec §26), added Phase 6 |
| status | enum | `OPPORTUNITY_IDENTIFIED \| VERIFICATION_PENDING \| VERIFIER_REJECTED \| VERIFIED \| OFFER_READY \| CONTACT_RESEARCH \| OUTREACH_READY \| SENT` — the opportunity-level portion of spec §90's flow. Terminates at `SENT`; see below. |
| operatorFeedback | text | nullable |
| rejectionReason | enum | nullable — `WEAK_EVIDENCE \| BAD_PROBLEM \| WOULDNT_BUY \| TOO_DIFFICULT \| TOO_SMALL \| TOO_LARGE \| ALREADY_SOLVED \| POOR_CONTACT \| BAD_PRICE \| REGULATORY_RISK \| GENERIC_IDEA \| NOT_INTERESTING \| OTHER` (spec §46, verbatim) |

Facts/inferences/hypotheses/unknowns for an opportunity are **not** duplicated columns — they
are the `evidence_items` rows linked via `opportunityId`, filtered by `classification`. One
source of truth, per spec §21's "never silently convert" rule (there's nowhere else for the
classification to drift out of sync).

**Splitting spec §90 across tables:** the spec's single conceptual state chain (DISCOVERED →
... → WON/LOST) spans three different entities with different lifetimes — a company can exist
with no opportunity yet, and after an opportunity is sent, its ongoing reply/interest/meeting
history is really a sequence of *events*, not a single current state. Rather than one giant
enum duplicated (and liable to drift) across tables, the chain is split at natural ownership
boundaries: `companies.lifecycleStatus` owns discovery-through-research, `opportunities.status`
owns formation-through-send, and everything after a draft is sent
(`SENT \| REPLIED \| NO_REPLY \| INTERESTED \| NOT_INTERESTED \| MEETING \| WON \| LOST`) is
recorded as `outreach_outcomes.event` rows — an append-only event log, not a current-status
column, since the spec explicitly wants outcome *history* preserved for the Phase 13 feedback
loop (§47), not just a latest value. Spec §90 itself says "exact implementation statuses may
differ," which is the license this split relies on.

## `opportunity_evaluations`

Scoring + verification, spec §26/§30/§31/§33. Component ranges, `rawScore`, and
`adjustedScore` are produced by `src/lib/scoring.ts` — pure functions, never a Claude-supplied
number (§30's "scoring components must remain visible" requirement, and PLAN.md §11's rule
that arithmetic is always deterministic code). Penalty reasons/amounts are the
`PENALTY_CATALOG` in that same module (10 named reasons from spec §31, whose exact point
values weren't specified by the source spec — "may be determined in implementation
planning" — so they were chosen in Phase 1 and recorded in ADR-0008).

| column | type | notes |
|---|---|---|
| id | text pk | |
| opportunityId | text fk | |
| evidenceStrength | integer | 0-20 |
| painSeverity | integer | 0-15 |
| economicImpactScore | integer | 0-15 |
| deliverability | integer | 0-15 |
| purchaseLikelihood | integer | 0-10 |
| speedToValue | integer | 0-5 |
| reachability | integer | 0-5 |
| demonstrability | integer | 0-5 |
| repeatability | integer | 0-5 |
| urgency | integer | 0-5 |
| rawScore | integer | sum, computed deterministically (`src/lib/scoring.ts`), not by Claude |
| penalties | json | array of `{reason, amount}` |
| adjustedScore | integer | rawScore − penalties, clamped 0-100 |
| verifierResult | enum | `KEEP \| REJECT` nullable until verified |
| verifierConfidence | real | nullable |
| verifierWeaknesses | json | text[] |
| verifierUnsupportedAssumptions | json | text[] |
| verifierMissingInfo | json | text[] |
| verifierDealkillers | json | text[] |

## `offers`

Spec §34.

| column | type | notes |
|---|---|---|
| id | text pk | |
| opportunityId | text fk | |
| scope | text | |
| expectedOutcome | text | |
| keyAssumptions | json | text[] |
| durationEstimate | text | |
| price | integer | cents |
| recurringPrice | integer | nullable, cents |
| exclusions | text | |
| validationNeeded | text | |
| demoConcept | text | |
| priceBand | enum | `MICRO_FIX \| SMALL_AUTOMATION \| WORKFLOW_IMPLEMENTATION \| LARGER_IMPLEMENTATION` |

## `contacts`

Spec §37-38.

| column | type | notes |
|---|---|---|
| id | text pk | |
| companyId | text fk | |
| name | text | |
| role | text | |
| source | text | |
| profileUrl | text | nullable |
| email | text | nullable |
| emailSource | text | nullable |
| emailConfidence | enum | `PUBLICLY_LISTED \| VERIFIED \| GUESSED \| UNKNOWN` |
| doNotContact | boolean | default false, spec §65 |

Enforcement note (spec §38 "never represent a guessed email as verified"): this is enforced
at the query/serialization layer, not just the UI — any code path rendering a "verified"
badge must read `emailConfidence` directly, and there is a unit test in Phase 9 asserting no
code path can display `VERIFIED` styling for a `GUESSED` row.

## `outreach_drafts`

Spec §39.

| column | type | notes |
|---|---|---|
| id | text pk | |
| opportunityId | text fk | |
| contactId | text fk | |
| subject | text | |
| body | text | |
| wordCount | integer | computed |
| promptVersion | text | |
| status | enum | `DRAFT \| REVIEWED \| SENT_MANUALLY` |

## `outreach_outcomes`

Spec §41/§45/§47.

| column | type | notes |
|---|---|---|
| id | text pk | |
| outreachDraftId | text fk | |
| event | enum | `SENT \| REPLIED \| NO_REPLY \| INTERESTED \| NOT_INTERESTED \| MEETING \| WON \| LOST` |
| note | text | nullable |
| occurredAt | timestamp | |

## `work_items`

The queue, spec §48-49.

| column | type | notes |
|---|---|---|
| id | text pk | |
| taskType | enum | `DISCOVER \| PRESCREEN \| RESEARCH \| ANALYZE \| VERIFY \| BUILD_OFFER \| FIND_CONTACT \| WRITE_OUTREACH \| REFRESH_EVIDENCE` |
| entityId | text | company/opportunity id this task operates on |
| status | enum | `PENDING \| RUNNING \| COMPLETED \| FAILED \| DEFERRED \| RETRYABLE \| CANCELLED` |
| priority | integer | derived from taskType per spec §49 default ordering, operator/campaign-adjustable |
| attempts | integer | default 0 |
| lastError | text | nullable |
| runAfter | timestamp | nullable — backoff / re-research scheduling |
| startedAt | timestamp | nullable — used for stuck-RUNNING crash recovery, spec §67 |
| completedAt | timestamp | nullable |

## `system_config`

Spec §70, key-value with typed accessors in `src/lib/config.ts`. Holds: autonomous
mode on/off, country/industry allowlists, size range, score threshold, model aliases,
discovery volume, research depth, min confidence, pricing bands, re-research interval,
max simultaneous work, daily limits.

## `prompt_versions`

Spec §81-82. Tracks which prompt template text produced which output, so quality can be
compared over time.

| column | type | notes |
|---|---|---|
| id | text pk | e.g. `deep-research@3` |
| agentType | text | |
| version | integer | |
| template | text | the actual prompt text at that version, for audit |
| createdAt | timestamp | |
