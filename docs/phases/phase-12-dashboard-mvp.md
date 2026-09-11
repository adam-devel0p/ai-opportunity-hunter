# Phase 12 — Dashboard MVP

**Completed:** 2026-09-11

## What was built

- A Next.js (App Router) dashboard under `src/app`, the first UI this project has (spec
  §42-46, §69, §71-73, §85; PLAN.md §14/ADR-0003 — one app, server components reading Drizzle
  directly, server actions writing directly, no REST/tRPC layer):
  - `src/app/page.tsx` — the dashboard home: spec §42's 14 summary metrics, the spec §71
    autonomous mode pause/resume toggle, and the spec §69 run-history/activity feed.
  - `src/app/opportunities/page.tsx` — the opportunity list with basic filters (status, verifier
    result, min score, industry, country, company/domain search — spec §73's basics, per
    PLAN.md's explicit "filtering polish beyond basics" deferral).
  - `src/app/opportunities/[id]/page.tsx` — the full opportunity card (spec §43): company/
    website/country/industry/size, score, verifier decision, problem, evidence, economic impact,
    proposed solution, implementation estimate, price, recurring revenue, demo concept, risks,
    skeptical reviewer findings, suggested decision-maker, contact evidence, draft email, source
    links — plus the spec §44 evidence UX (claim/type/source/retrieval date/confidence, clickable
    source links, grouped Facts/Inferences-Hypotheses/Unknowns) and the spec §85 human-trust
    panel (WHY CLAUDE LIKES THIS / WHY THE SKEPTIC MIGHT REJECT IT / WHAT WE KNOW-INFER-DON'T
    KNOW / WHAT TO VERIFY, mapped from existing fields — see ADR-0019 part 6) — and the spec §45
    operator-action forms (Approve/Reject with spec §46's reason picker, Draft Reviewed, Sent
    Manually, and the remaining outcome events with optional notes).
  - `src/app/companies/page.tsx` / `src/app/companies/[id]/page.tsx` — a companies list (search +
    lifecycle-status filter) and detail page, mainly to give the manual-research flow somewhere
    to land and to support spec §73's company/domain lookup.
  - `src/app/companies/new/page.tsx` — spec §72's manual "research this company now" entry point.
  - `src/app/actions/{autonomous,opportunities,companies}.ts` — thin `"use server"` wrappers over
    the plain functions below; all page forms use function-reference `action={...}` (no client
    JS needed anywhere in this phase).
  - `src/app/globals.css` / `format.ts` — a small hand-written stylesheet (light/dark via
    `prefers-color-scheme`) and display-formatting helpers; no UI framework dependency added.
- New plain, DB-only, unit-tested modules under `src/lib` (the actual logic; the `src/app`
  files above are wiring):
  - `dashboardQueries.ts` — `getSummaryMetrics`, `listOpportunities`, `getOpportunityDetail`,
    `listCompanies`, `getCompanyDetail`, `getCompanyByNormalizedDomain`.
  - `dashboardActions.ts` — `approveOpportunity`, `rejectOpportunity`, `markDraftReviewed`,
    `markSentManually` (the one path that actually drives `OUTREACH_READY -> SENT`, spec
    §41/§90), `recordOutreachOutcome`, `requestManualResearch` (spec §72).
  - `activity.ts` — `getRecentActivity`, spec §69's feed derived from `work_items` at read time
    (see ADR-0019 part 4 for why no new event-log table was added).
  - `appDb.ts` — a `globalThis`-cached `Db` singleton for the Next.js process.
- `src/db/schema.ts` gained `opportunities.operatorVerdict`
  (`PENDING | APPROVED | REJECTED`, default `PENDING`) — the operator's own verdict, distinct
  from the pipeline's own `status` (ADR-0019 part 3) — with migration
  `drizzle/0002_marvelous_celestials.sql`.
- Playwright: `playwright.config.ts`, `e2e/dashboard.spec.ts` (7 serial smoke tests covering the
  full acceptance-criteria list below), and `scripts/seedE2eFixture.ts` (a direct-insert fixture
  seed script — never invokes the real `claude` CLI, see ADR-0019 part 9).
- Tooling changes to support all of the above:
  - `next`, `react`, `react-dom` (deps); `@types/react`, `@types/react-dom`,
    `eslint-plugin-react-hooks`, `@playwright/test` (devDeps).
  - `tsconfig.json` (pre-existing backend config) renamed to `tsconfig.backend.json`
    (`include` narrowed to exclude `src/app`); a new Next-owned `tsconfig.json` covers `src/app`.
    See ADR-0019 part 1 for why these can't be merged and why `next dev`/`next build` are pinned
    to `--webpack` (`next.config.ts`'s `experimental.extensionAlias` lets Next's bundler resolve
    the backend's required `.js`-suffixed relative imports to their `.ts` sources — Turbopack,
    the Next 16 default, doesn't honor that option yet).
  - `eslint.config.js` gained JSX parsing + `eslint-plugin-react-hooks`, scoped to
    `src/app/**` (ADR-0019 part 2 explains why full `eslint-plugin-react` was skipped).
  - `package.json` scripts: `dev`, `build` (now `build:worker` + `build:dashboard`), `start`,
    `typecheck` (both tsconfigs), `test:e2e`.
  - `.gitignore` gained Playwright's `playwright-report/`/`test-results/`/`e2e/.tmp/` and
    `*.tsbuildinfo`.

## Deviations from PLAN.md

- Added one schema column (`opportunities.operatorVerdict`) that PLAN.md's Phase 12 text didn't
  explicitly call out, to make spec §45's Approve/Reject representable at all — see ADR-0019
  part 3 for why `status`/`rejectionReason` alone weren't sufficient.
- Everything else matches PLAN.md's Phase 12 "Build" list; the explicit exclusions (filtering
  polish beyond basics, outcome analytics dashboards, config UI beyond autonomous on/off) were
  respected — see ADR-0019 parts 8 and 10.

## Testing performed

- Unit/fixture tests (Vitest, real temp SQLite DB per test, same pattern as every earlier
  phase's `src/lib`/`src/pipeline` tests): `dashboardQueries.test.ts` (14 tests),
  `dashboardActions.test.ts` (13 tests), `activity.test.ts` (4 tests) — 31 new tests.
  `npm test` — 394 passed (43 files), including all pre-existing suites.
- `npm run build` — `build:worker` (`tsc -p tsconfig.backend.json`) and `build:dashboard`
  (`next build --webpack`) both pass; `next build`'s route summary confirms all 7 pages compile.
- `npm run lint` — clean (0 errors) across the whole repo including `src/app`.
- `npm run typecheck` — clean under both `tsconfig.backend.json` and `tsconfig.json`.
- Playwright (`npm run test:e2e`, real Chromium against a real `next dev --webpack` server and a
  seeded fixture DB): 7/7 passed —
  1. dashboard shows summary metrics and the autonomous-mode toggle round-trips PAUSED/RUNNING;
  2. the opportunity list links through to the seeded opportunity;
  3. the opportunity detail page renders the full evidence trail (facts/inferences/unknowns,
     clickable source link) and the spec §85 trust sections;
  4. Approve sets `operatorVerdict: APPROVED`;
  5. Reject with a reason sets `REJECTED` (then re-approves, so later tests aren't affected);
  6. Draft Reviewed → Sent Manually drives the real `OUTREACH_READY -> SENT` transition, then an
     outcome (`INTERESTED`) is recorded;
  7. manual company entry (spec §72) creates a company at `RESEARCH_PENDING` with a real
     `RESEARCH` work item enqueued, landing on its detail page with a "queued" message.
- Manual verification: ran `next dev --webpack` against a real (throwaway) DB and hit every page
  with `curl` before writing the Playwright suite; the Playwright run above is the "used the
  feature in a browser" verification this project's working rules ask for (Chromium, not a
  manual click-through, but exercising the same rendered pages and real server actions).

## New decisions

- ADR-0019 (`docs/DECISIONS.md`) — ten judgment calls: the tsconfig split + webpack pin, skipping
  `eslint-plugin-react`, the `operatorVerdict` column, deriving the activity feed from
  `work_items` instead of a new event table, manual research's discovery/pre-screen skip +
  already-progressed handling, mapping spec §85's trust labels onto existing fields, the
  Sent-Manually/outcome-event split, filtering scope, the Playwright fixture-seeding approach,
  and the two features deliberately left out (per-opportunity high-risk override, general config
  UI).

## Known limitations / follow-ups

- No per-opportunity override for spec §8's high-risk gate exclusion exists yet — only the
  existing code-level `gateConfig.allowHighRisk` (global, Phase 7). Still an open item.
- `system_config`'s general key set (score threshold, pricing bands, country/industry allowlists,
  discovery volume, ...) remains unwritten; only `autonomousMode`/`campaignSelectionState`
  (Phase 11) exist. Phase 14 owns the general config UI per PLAN.md.
- Filtering is basic (per-field exact/threshold matches via GET query params); no saved filters,
  no date-range/campaign/reply-status filters yet (spec §73's fuller list), no client-side
  auto-submit polish.
- The activity feed reports each stage's *current* entity state, not a frozen historical
  snapshot (ADR-0019 part 4) — fine today, but would need revisiting if a future phase lets a
  company/opportunity cycle back through an earlier stage.
- No real end-to-end dashboard walkthrough against live pipeline data exists yet — every real
  opportunity produced by Phases 3-11's live smoke tests was `VERIFIER_REJECTED` (Phase 7-10's
  known limitation), so there has never been a real `VERIFIED`/`OUTREACH_READY` opportunity to
  view in this dashboard. The Playwright suite's seeded fixture stands in for that; the operator
  should do a real walkthrough (spec §91's MVP success test) once a real opportunity clears
  verification, and this is also PLAN.md's own Phase 12 acceptance criterion ("manual UX
  walkthrough by the operator against the full §95 scenario end-to-end using data produced by
  earlier phases") — not performed this session since no such data exists yet.
- Next.js dev/build are pinned to webpack (ADR-0019 part 1); if a future `next` upgrade adds
  Turbopack support for `extensionAlias` (or an equivalent), the `--webpack` flags in
  `package.json` can likely be dropped.

## Next phase

`docs/PHASES.md` now points to **Phase 13 — Feedback loop & outcome analytics** (spec §47, §74):
aggregate-by-dimension outcome analytics, wired to the `outreach_outcomes` events this phase's
dashboard actions already write, with small-sample-size guarding. The dashboard's outcome
recording (`recordOutreachOutcome`, `markSentManually`) is the data source Phase 13 aggregates —
no further plumbing should be needed on that side.
