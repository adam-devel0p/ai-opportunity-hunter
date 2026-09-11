# Phase 14 — Operational hardening

**Completed:** 2026-09-11

## What was built

No new Claude-invoking agent this phase — everything below is deterministic TypeScript, per
PLAN.md's "Claude only where judgment is genuinely required" split.

- **Exclusion system (spec §61).** New `exclusion_rules` table (`DOMAIN | INDUSTRY | COUNTRY`,
  `value`, nullable `reason` — `drizzle/0003_broad_inhumans.sql`), a pure matcher
  (`src/pipeline/exclusionCheck.ts`), and a DB-wired wrapper
  (`src/lib/exclusions.ts`: `addExclusionRule`/`removeExclusionRule`/`listExclusionRules`/
  `checkExclusion`). Enforced at two points: `discoverHandler.ts` (new candidates get inserted
  straight at `EXCLUDED` instead of `PRESCREEN_PENDING`, no `PRESCREEN` item created; an
  already-known company is re-checked on rediscovery too) and, authoritatively,
  `prescreenHandler.ts` (checked live, right before every Claude call, so a rule added after
  discovery still takes effect). Permanent single-company exclusion reuses the existing
  `companies.lifecycleStatus = "EXCLUDED"` transition plus a new
  `dashboardActions.excludeCompany` (also cancels this company's own pending
  PRESCREEN/RESEARCH work items).
- **DO_NOT_CONTACT enforcement (spec §64-65).** `src/lib/doNotContact.ts`'s `isDoNotContact` is
  the single predicate `contactHandler.ts` (skips enqueueing `WRITE_OUTREACH` when the company or
  contact is DNC — the acceptance-criteria requirement) and `outreachHandler.ts` (a defensive
  re-check right before calling Claude, for an item already queued before DNC was set) both call.
  A prior contact for the same company/email already marked DNC has that flag inherited onto a
  freshly-found contact row. New `dashboardActions.setCompanyDoNotContact`/
  `setContactDoNotContact` operator actions.
- **Re-research (spec §60), wired end to end.** `src/pipeline/refreshEvidenceHandler.ts` is the
  real `REFRESH_EVIDENCE` handler (`worker.ts` only had a deterministic-failure stub through Phase
  11-13) — re-runs the Deep Research Agent for a `RESEARCHED`/`NO_OPPORTUNITY` company, persists
  evidence via a shared `src/pipeline/researchEvidence.ts` (factored out of `researchHandler.ts`
  with no behavior change — that handler's own test suite passes untouched), resets
  `lastResearchedAt`/`nextEligibleResearchAt`, and enqueues a fresh `ANALYZE` item. A new
  `worker.ts` function, `ensureRefreshEvidenceWork`, tops this up every cycle (batch-capped at
  `DEFAULT_REFRESH_EVIDENCE_BATCH_SIZE = 3`).
- **Config UI beyond autonomous on/off (spec §70).** `src/lib/config.ts` gained
  `getOpportunityGateConfig`/`setOpportunityGateConfig` (wires a live value into the already-
  parameterized spec §32 gate, `worker.ts`'s `TASK_HANDLERS.VERIFY`) and
  `getReResearchWindowMs`/`setReResearchWindowMs` (same for `researchFreshness.ts`, read by both
  `RESEARCH` and `REFRESH_EVIDENCE` handlers). Both editable from a new `/settings` dashboard page.
- **Seed/test mode (spec §99).** `src/lib/seedCompanies.ts` + `scripts/seed.ts` — `add` inserts
  companies at `PRESCREEN_PENDING` from a URL list (mirrors `discoverHandler.ts`'s own
  per-candidate insert, `sourceCampaignId` null); `run` additionally drives each one through
  PRESCREEN -> RESEARCH -> ANALYZE -> VERIFY -> BUILD_OFFER in-process (real handler calls, real
  `claude` CLI, `--stop-after <STAGE>` to stop earlier), printing a trail and stopping a company
  early on DISCARD/exclusion/gate failure/task failure. Distinct from Phase 12's
  `requestManualResearch` (spec §72), which deliberately skips screening.
- **Backup/restore (spec §80).** `src/lib/backup.ts` (`backupDatabase` via `better-sqlite3`'s own
  `.backup()` API for a WAL-safe snapshot; `restoreDatabase` a plain file copy + stale
  `-wal`/`-shm` cleanup) + `scripts/backup.ts` CLI + a "Create backup now" button on `/settings`.
- **Data export (spec §79).** `src/lib/exportData.ts` (`buildExportBundle` over all five named
  entities, `bundleToJson`, `exportEntityCsv`) + `scripts/export.ts` CLI + `/api/export` route
  handler (`?format=json` full bundle, `?format=csv&entity=<name>` per entity) + download links on
  `/settings`.
- **Dashboard additions.** New `/settings` page (exclusion rules, gate config, re-research window,
  backup, export) with `src/app/actions/settings.ts`; new "Mark DO NOT CONTACT"/"Exclude company"
  buttons on `/companies/[id]` with two new actions in `src/app/actions/companies.ts`; a "Settings"
  nav link in `layout.tsx`.
- **Observability (spec §68) / secrets (spec §77).** One targeted fix: `src/lib/activity.ts` now
  gives a completed `REFRESH_EVIDENCE` item a proper "Evidence refreshed for X" info-level entry
  instead of the placeholder failure-only formatter. A secret-handling pass over every new module
  found nothing to fix — no new logging touches env vars/credentials; ADR-0001's
  `ANTHROPIC_API_KEY`-stripping machinery is untouched.

## Deviations from PLAN.md

None in scope — every acceptance-criteria item was built. Two scoping decisions worth flagging
(both recorded in ADR-0021): the `system_config` expansion is limited to the two keys actually
wired to something (the gate config and the re-research window), not the full
DATABASE_SCHEMA.md wishlist; and country/industry exclusion was built as the new `exclusion_rules`
table rather than a `system_config` allowlist key, since it needs to match companies that don't
exist yet.

## Testing performed

- **Unit/fixture tests** (8 new test files, 7 existing files extended):
  - `src/pipeline/exclusionCheck.test.ts` (7 tests) — pure matcher: exact case-insensitive
    matching per type, no substring matches, null-field handling, first-match-wins.
  - `src/lib/exclusions.test.ts` (5 tests) — CRUD round-trip, DOMAIN-value normalization,
    live-rules behavior.
  - `src/pipeline/discoverHandler.test.ts` (+3 tests) — a new candidate matching a domain or
    industry/country rule is inserted straight at `EXCLUDED` with no `PRESCREEN` item; an
    already-known company is retroactively excluded on rediscovery once a matching rule exists.
  - `src/pipeline/prescreenHandler.test.ts` (+1 test) — a rule added *after* a company was
    discovered and its `PRESCREEN` item enqueued still excludes it, without ever calling Claude —
    this is the acceptance criterion's exact scenario.
  - `src/lib/doNotContact.test.ts` (4 tests) — the predicate's four truth-table cases.
  - `src/pipeline/contactHandler.test.ts` (+2 tests) — company-level DNC skips enqueueing
    `WRITE_OUTREACH` while still recording the contact; a fresh contact row inherits DNC from a
    prior contact with the same company+email.
  - `src/pipeline/outreachHandler.test.ts` (+2 tests) — company-level and contact-level DNC both
    skip draft generation (COMPLETED, no Claude call, no `outreach_drafts` row).
  - `src/pipeline/refreshEvidenceHandler.test.ts` (9 tests) — unknown company throws, wrong
    lifecycle status throws, evidence persists and `ANALYZE` is enqueued without a lifecycle
    transition, `NO_OPPORTUNITY` companies are also eligible, custom re-research window is
    respected, unverified sourceUrl is dropped, quota/failure/exhausted-attempts paths.
  - `src/pipeline/researchHandler.test.ts` — unchanged, still 8/8 passing after the
    `researchEvidence.ts` extraction (proves the refactor is behavior-preserving).
  - `src/lib/config.test.ts` (+8 tests) — gate config and re-research window: defaults, round-trip,
    malformed/non-positive fallback.
  - `src/worker.test.ts` (+6 tests) — `ensureRefreshEvidenceWork`: no-op when nothing eligible,
    enqueues for `RESEARCHED`/`NO_OPPORTUNITY` past their window, ignores a null window, doesn't
    double-enqueue while one is in flight, respects the batch-size cap.
  - `src/lib/dashboardActions.test.ts` (+6 tests) — `excludeCompany` sets `EXCLUDED`+reason and
    cancels pending work items; `setCompanyDoNotContact`/`setContactDoNotContact` toggle and
    round-trip; unknown-id error paths.
  - `src/lib/backup.test.ts` (4 tests) — missing-source-file error, a real backup file containing
    the same data, missing-backup-file error, and the full round-trip acceptance-criteria scenario
    (seed data, back up, delete + corrupt the live DB file, restore, verify data matches).
  - `src/lib/exportData.test.ts` (8 tests) — every entity type present with correct field
    spot-checks (the export-completeness acceptance criterion), empty-DB handling, JSON round-trip,
    CSV comma/quote/newline escaping, nested-JSON-column inline serialization.
  - `src/lib/seedCompanies.test.ts` (4 tests) — fresh insert at `PRESCREEN_PENDING`, name fallback
    to domain, idempotent re-seed (`already-queued`), `already-progressed` for a company past
    screening.
  - `src/lib/activity.test.ts` (+1 test) — `REFRESH_EVIDENCE` renders as an info-level "Evidence
    refreshed for X" entry.
  - `npm test` (Vitest) — **51 test files, 474 tests, all pass** (`npx vitest run`).

- **Manual/CLI verification:**
  - `npm run typecheck`, `npm run lint`, `npm run build` — all clean (`tsc -p
    tsconfig.backend.json --noEmit false --outDir dist` and `next build --webpack` both succeed;
    `/settings` and `/api/export` appear in the build's route list).
  - Every new CLI script (`exclusions`, `backup`, `export`, `seed`) run for real against a freshly
    migrated (non-fixture) SQLite DB: added/listed/removed an exclusion rule; created a JSON
    export and a per-entity CSV export and inspected the output; created and restored a real
    backup; seeded a company via `seed add` and confirmed it landed at `PRESCREEN_PENDING` with a
    `PRESCREEN` item.
  - `npm run db:migrate` applied migration `0003` to the real project DB (`./data/aoh.db`),
    confirmed via `sqlite3 .tables` that `exclusion_rules` now exists alongside the other 13
    tables.
  - **Real browser verification** (per this session's standing instruction to test UI changes in
    a browser, not just typecheck them): a real `next dev --webpack` server against a freshly
    migrated DB, `curl`-verified every new/changed route returns 200 (`/settings`, `/companies`,
    `/companies/[id]`, `/api/export?format=json`, `/api/export?format=csv&entity=companies`), then
    2 new Playwright scenarios added to `e2e/dashboard.spec.ts` (run serially after the existing 7,
    reusing the "Acme Plumbing" company the manual-research test creates) actually clicking through
    DO_NOT_CONTACT toggle -> exclude company, and add-rule -> remove-rule -> gate-config-save on
    `/settings` — **9/9 Playwright scenarios pass** (`npx playwright test`).

## New decisions

[ADR-0021](../DECISIONS.md#adr-0021-phase-14-operational-hardening-judgment-calls) — the ten
judgment calls made this phase: the exclusion split between `exclusion_rules` and
`lifecycleStatus`/`EXCLUDED`; the two-enforcement-point pattern shared by exclusion and DNC;
why `REFRESH_EVIDENCE` never transitions `lifecycleStatus`; the deliberately narrow two-key
`system_config` expansion; seed mode's CLI-only scope; the backup/restore API choices; the export
shape; the `/settings` page's scope; and the observability/secret-handling pass's single targeted
fix.

## Known limitations / follow-ups

- Wiring `REFRESH_EVIDENCE` for real means a second `ANALYZE` pass can now form a second,
  differently-worded `opportunities` row for a problem an earlier pass already surfaced — spec
  §59's duplicate-opportunity-prevention gap (still unimplemented, ADR-0013 part 7) is no longer
  purely hypothetical. Not a regression introduced by a bug — this is the same "form the record,
  judge it downstream" pattern every earlier phase uses — but worth a dedicated follow-up phase if
  it produces confusing duplicate opportunities in practice.
- `DEFAULT_REFRESH_EVIDENCE_BATCH_SIZE = 3` is a reasoned starting point, not empirically tuned —
  no live multi-hour run has exercised a scenario with many companies simultaneously past their
  re-research window.
- The remaining `system_config` keys from DATABASE_SCHEMA.md's original wishlist (pricing bands,
  discovery volume, research depth, min confidence, max simultaneous work, daily limits, a
  country/industry allowlist distinct from `exclusion_rules`) remain unwired — a deliberate scope
  call (ADR-0021 part 5), not an oversight.
- `restoreDatabase` has no automated safeguard against restoring over a DB file the
  worker/dashboard currently has open, per spec §80's "extremely simple" framing — the operator
  must stop those processes first.
- No live run has exercised exclusion/DO_NOT_CONTACT/`REFRESH_EVIDENCE` against real autonomous
  `claude` CLI traffic — same blocker every phase since 8 has hit (no real company/opportunity has
  reached a state where these paths fire in practice). Verified via unit/fixture tests, real CLI
  smoke runs, and real-browser Playwright coverage instead (see "Testing performed").

## Next phase

PLAN.md has no Phase 15 — this was the last explicitly planned phase. `docs/PHASES.md` now
reflects Phase 14 as done with no next phase; see PLAN.md's "Deferred beyond these phases" section
for what a future session might tackle next (Claude-suggested campaigns, autonomous strategy
review per spec §75, recurring-pattern detection per spec §76, a SQLite migration path). Before
starting any of those, the operator should run a real multi-hour `npm run worker` session with
autonomous mode on and inspect the result — no phase since 7 has had a real opportunity clear
Skeptical Verification, so several of this phase's live-traffic-dependent paths (exclusion,
DO_NOT_CONTACT, REFRESH_EVIDENCE) remain unexercised against real Claude output.
