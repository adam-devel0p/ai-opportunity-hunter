# AI Opportunity Hunter — Implementation Plan

Source spec: [idea-requirements.md](idea-requirements.md) (101 numbered sections; referenced
below as §N). This plan answers the 20 planning questions in its §101 and breaks
implementation into phases, each sized for one independent Claude Code session. It does not
implement anything — see [docs/PHASES.md](docs/PHASES.md) for execution status.

---

## 1. Restated understanding of the product

A single-operator system that runs, mostly unattended, on the operator's own Mac. It walks a
pipeline — discover real businesses → cheaply screen them → deeply research the promising
ones with evidence graded FACT/INFERENCE/HYPOTHESIS/UNKNOWN → identify a plausible,
economically meaningful problem → have a second, skeptical Claude pass try to kill the idea →
only for survivors, build a concrete priced offer, find a real decision-maker, and draft one
honest cold email. Nothing is sent automatically. The operator reviews an opportunity's full
evidence trail in a dashboard, decides, sends manually, and records the outcome, which feeds
back into which industries/problem types get more discovery attention later.

The product's real output is not lead volume — it's a small number of opportunities the
operator would independently trust enough to act on. Everything in this plan is in service of
that: cheap filtering funnels scarce Claude usage toward only the companies worth the expense
(§13), and every claim in the system carries provenance so trust doesn't have to be taken on
faith (§85).

The hardest constraint shaping the architecture is not technical capability, it's **billing
safety**: the system must never silently spend pay-as-you-go API money when the operator
believes they're using their flat-rate subscription (§10, §78). This is treated as a
first-class architectural concern, not an afterthought — see §3 and ADR-0001 below.

## 2. Ambiguous technical decisions

Resolved with recommendations, recorded as ADRs in [docs/DECISIONS.md](docs/DECISIONS.md) so
later sessions don't re-litigate them:

| Decision | Recommendation | ADR |
|---|---|---|
| How to invoke Claude programmatically under subscription billing | CLI subprocess (`claude -p`), never the Agent SDK library, never forward `ANTHROPIC_API_KEY` | ADR-0001 |
| ORM | Drizzle + better-sqlite3 | ADR-0002 |
| Monorepo vs single app | Single Next.js app, folder-separated | ADR-0003 |
| How evidence provenance gets captured reliably | `PostToolUse` hook on WebFetch/WebSearch, not model self-report | ADR-0004 |
| Test framework | Vitest | ADR-0005 |
| Model selection | Config-driven tier→alias map, not hardcoded IDs | ADR-0006 |

These are recommendations the operator can override, but a fresh session should treat them as
settled unless the operator says otherwise, to avoid each phase re-deciding the stack.

## 3. Verified: current Anthropic-supported mechanism for subscription-backed non-interactive use

Checked against Anthropic's live documentation and help center in September 2026 (full
reasoning and links in ADR-0001):

- `claude -p` (Claude Code's non-interactive/headless mode), authenticated via the operator's
  own `claude login` OAuth session, currently draws from the same subscription usage pool as
  interactive use. Anthropic announced a split into a separate metered "Agent SDK credit"
  pool effective June 15, 2026, then **paused it on that date** — as of now nothing has
  changed. This has moved before and may move again; re-verify at the start of Phase 0.
- The Agent SDK's own documentation currently tells third-party developers to authenticate
  with an API key rather than claude.ai/OAuth login. To stay unambiguously on the safe,
  subscription-billed side of that line, this project drives Claude via the CLI binary
  directly (the operator's own already-logged-in tool) rather than embedding the SDK library.
- **Anything that sets `ANTHROPIC_API_KEY` in the environment a Claude invocation runs in
  will bill to the API, silently, regardless of subscription status.** This has already
  caused a real four-figure billing incident for another user
  (`anthropics/claude-code#37686`). The wrapper built in Phase 0 must construct the child
  process environment explicitly (never inherit `ANTHROPIC_API_KEY` from the parent shell)
  and must warn loudly if it detects that variable set anywhere in the parent environment.
- There is no documented, stable, programmatic "percentage of quota remaining" signal.
  Usage-limit exhaustion surfaces as CLI stderr text ("You've hit your session limit",
  "You've hit your weekly limit") or as a 429/`rate_limit_error`. The scheduler treats these
  as an opaque "exhausted, back off" signal (§50/§51) rather than trying to predict quota.

## 4. Smallest sensible architecture

```
Operator's Mac
├── Next.js dashboard (apps entry: src/app)      — read/review/act on opportunities
├── Worker process (src/worker.ts)               — autonomous pipeline loop
│     both read/write the same SQLite file
├── SQLite (better-sqlite3, WAL mode)             — the long-term memory (§9)
└── claude CLI subprocess, spawned per task        — the only thing that costs Claude usage
```

No queue infra, no message broker, no separate services, no Docker requirement, no ORM
runtime binary. The "queue" is a SQLite table (`work_items`) polled by the worker loop. The
dashboard and worker are two entry points into one codebase (ADR-0003), so a phase that
touches shared logic (scoring, schema, agents) only has to be written once.

## 5. Project/package structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Target folder layout" — kept there since
that file is the living reflection of what's actually built, updated every phase.

## 6. Initial database schema

See [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) — full table-by-table design covering
all entities from §55-58, implemented in Phase 1.

## 7. Structured agent contracts

See [docs/AGENT_CONTRACTS.md](docs/AGENT_CONTRACTS.md) — input/output schema per agent, and
the cross-cutting rules (minimum context, validated output, no chain-of-thought persistence).

## 8. State machine / work queue

`work_items` table (§48, schema in DATABASE_SCHEMA.md). Task types map 1:1 to pipeline stages
(§9). Statuses: `PENDING, RUNNING, COMPLETED, FAILED, DEFERRED, RETRYABLE, CANCELLED`.
Company/Opportunity lifecycle statuses (§90) are separate columns driven by deterministic
transition functions in `src/pipeline/stateMachine.ts` — Claude's structured output is input
to a transition function, never a direct writer of status. Priority ordering follows §49's
list top-to-bottom (finish verification of strong opportunities > offers > contacts > outreach
> deep research > pre-screen > discovery), implemented as a deterministic sort, fully
unit-testable without any Claude call.

Crash recovery (§67): on worker startup, any `work_item` in `RUNNING` with `startedAt` older
than a configurable timeout is reset to `RETRYABLE`. Each task handler is wrapped so one
failure never takes down the loop (§66) — failures are caught, classified retryable/not, and
logged (§68).

## 9. How Claude agents are invoked

`src/agents/claudeClient.ts` (built Phase 0, used by every later phase): spawns
`claude -p <prompt> --output-format json --model <alias> --allowedTools <tools>` with an
explicit, sanitized environment. Structured output is validated against the calling agent's
Zod schema; one retry with the validation error appended on failure, then `FAILED`. Usage-
limit text/exit codes are detected and surfaced as a typed `QuotaExhausted` result rather than
thrown as a generic error, so the scheduler (Phase 11) can back off instead of crashing.
Every invocation is logged with task type, model, prompt version, timestamp, entity id,
output, and status (§82) via a thin wrapper around inserts into `work_items` /
`prompt_versions`.

## 10. How web research works

The `claude` CLI's built-in `WebSearch`/`WebFetch` tools are enabled for research-oriented
agent calls (Discovery, Pre-Screening, Deep Research); the model decides what to look at
per-company rather than the app hardcoding a fixed page list (§19). A `PostToolUse` hook
(ADR-0004) deterministically records every fetch as a `Source` row with URL, title, and
retrieval timestamp — this is what makes evidence provenance reliable rather than dependent on
the model faithfully self-reporting. Request etiquette (§62) — no aggressive re-fetching, no
auth bypass, no CAPTCHA defeat, respect for site restrictions — is stated in the system prompt
for research agents and, where practical, enforced by not re-fetching a URL already recorded
as a fresh `Source` for that company within the freshness window.

## 11. How evidence/provenance is represented

`evidence_items` rows, each linked to exactly one `sources` row and classified
FACT/INFERENCE/HYPOTHESIS/UNKNOWN (§21-22, schema in DATABASE_SCHEMA.md). Facts/inferences/
hypotheses/unknowns shown on an opportunity's dashboard card are queried from this one table
filtered by classification — never duplicated into separate opportunity-level fields — so
there is no code path where a classification can silently drift (§21's core requirement).
Freshness (§23) is derived from `retrievedAt` vs a configurable threshold, computed
deterministically, not asked of Claude.

## 12. Scheduler and subscription-limit behavior

`src/worker.ts` (Phase 11): loop while autonomous mode is enabled (`system_config`, checked
each iteration so pause/resume, §71, takes effect within one cycle) — pick the highest-
priority eligible `work_item`, run its handler, persist, repeat. On `QuotaExhausted`: stop
issuing new Claude calls, persist state as-is, sleep with backoff (start at e.g. 30 min,
capped), re-check on wake. No tight retry loop, no automatic API-key fallback ever (§51/§78 —
this is not configurable via env var alone; enabling paid fallback requires a deliberate,
separately-documented operator action, not built in early phases at all). Designed to run as
a plain long-lived `node` process the operator starts, with an example macOS `launchd` plist
provided as a convenience for "run while the laptop is awake" (§11), not a hard dependency.

## 13. Testing strategy

Two categories, both required every phase (§98):

**Deterministic logic** — plain Vitest unit tests, no Claude involved: domain normalization/
dedupe, scoring arithmetic, state transitions, priority ordering, failure/retry
classification, config loading, DB round-trips.

**Agent-involving logic** — fixture-based tests against a mocked `claudeClient` (deterministic
canned responses, so CI never calls the real CLI or spends quota) covering the representative
scenarios in §98: strong real opportunity, weak generic opportunity, insufficient evidence,
already-solved problem, duplicate company, missing website, misleading evidence,
regulated/high-risk solution, guessed contact email. §88's "contact form → assumed chatbot"
bad example and §89's "correct reasoning" example are used verbatim as fixtures where the
relevant agent exists (Opportunity Analysis, Phase 6).

**Manual verification** — some acceptance criteria in early phases (0, 3, 5) require the
operator to run the real CLI against real companies and judge output quality, since "is this
opportunity actually credible" is not something an automated assertion can fully answer.
These are called out explicitly per phase below and must be documented in the phase's
completion doc (what was run, what the operator observed), not skipped.

Every phase's session runs `npm run build && npm run lint && npm test` before considering the
phase done, and reports the actual pass/fail output in its completion doc.

## 14. Next.js dashboard architecture

Deferred to Phase 12 deliberately (§101.20 — validate research quality before UI polish).
Server components read directly from SQLite via Drizzle (no REST/tRPC layer needed for a
single local process); operator actions (approve/reject/mark sent/etc., §45) are Next.js
server actions that write directly to the DB. Before Phase 12 exists, earlier phases are
verified via test output and small CLI dump scripts (`scripts/`), not a UI — this is
intentional, not a gap.

## 15-19. Phase breakdown, acceptance criteria, exclusions, and early risks

See the phase list below. Each phase states: objective, what it explicitly does NOT build,
and acceptance criteria (§101.17). Risks that need early validation are folded into Phase 0,
which exists specifically to de-risk the two things the whole product depends on before any
other code is written (§101.19-20):

1. **Billing safety actually holds** — `claude -p` invoked from a Node child process, with a
   sanitized environment, really does bill to the subscription and not the API.
2. **Claude can actually produce credible, evidence-graded research** — given a real company
   URL and web tools, it can produce FACT/INFERENCE/HYPOTHESIS/UNKNOWN output that a human
   would find genuinely careful rather than confidently invented. If this fails, no amount of
   pipeline/UI engineering downstream matters, so it's tested first, manually, before Phase 1
   even begins building persistence.

---

### Phase 0 — Foundations & Claude-invocation spike

**Objective:** Prove the two risks above before investing in anything else. Stand up the repo
skeleton and the one module every later phase depends on: `claudeClient.ts`.

**Build:**
- `package.json`, TypeScript config, ESLint, Vitest, `.gitignore` (exclude `.env`, `*.db`,
  `node_modules`).
- `src/agents/claudeClient.ts`: spawns `claude -p` with explicit sanitized env (never forwards
  `ANTHROPIC_API_KEY`), `--output-format json`, configurable `--model` alias, configurable
  `--allowedTools`. Parses stdout as JSON; detects usage-limit exhaustion from stderr/exit
  code and returns a typed result rather than throwing.
- `src/config/models.ts`: tier→alias map read from env, per ADR-0006. Confirm current valid
  `--model` values against `claude --help`/docs and record them in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- `scripts/spike-research.ts`: takes a company URL on the command line, invokes Claude (with
  WebSearch/WebFetch tools enabled) with a research prompt asking for FACT/INFERENCE/
  HYPOTHESIS/UNKNOWN structured evidence (draft version of the Phase 5 contract — doesn't need
  to be final), prints the result.
- Seed [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) with the real, confirmed folder layout and
  model aliases as they're actually implemented.

**Explicitly NOT built:** database, dashboard, worker/scheduler, discovery/pre-screening
agents, scoring, contact research, outreach. This phase produces exactly one working spike
script and the reusable client it's built on.

**Acceptance criteria:**
- Unit tests: environment sanitization (assert `ANTHROPIC_API_KEY` is never present in the
  spawned child's env even if set in `process.env` during the test), usage-limit-string
  detection against fixture stderr samples, JSON parse/validation failure handling.
- `scripts/spike-research.ts` run against at least 3 real, distinct small businesses chosen by
  the operator produces schema-valid output with at least one FACT, at least one clearly
  labeled UNKNOWN, and no fabricated-sounding specifics (operator judgment call, documented in
  the phase completion doc with the actual companies and a short verdict per company).
- Operator manually confirms (via their claude.ai/console usage page) that running the spike
  billed against subscription usage, not API credits — documented in the completion doc and
  cross-referenced from ADR-0001 if anything about the mechanism needed correcting.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 1 — Data layer & domain model

**Objective:** Persistent SQLite schema for every entity in
[docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md), plus the deterministic domain logic that
doesn't need Claude at all: URL/domain normalization + dedupe (§17), and the opportunity
scoring calculator (§30-31) as a pure function (not wired to real opportunities yet — just
correct and tested against the spec's scoring table).

**Explicitly NOT built:** any agent orchestration, work queue processing, worker loop, UI.

**Acceptance criteria:**
- `drizzle-kit` migration runs clean against a fresh DB file; basic insert/read round-trip
  test for every table.
- Unit tests: normalization collapses `https://www.example.com`, `http://example.com/`,
  `https://example.com/about?ref=x` to the same `normalizedDomain`, while preserving distinct
  `website` values; dedupe correctly refuses a second insert with the same normalized domain.
- Unit tests: scoring calculator matches the §30 component ranges and produces the documented
  example-style output (evidence strength, pain severity, etc. summing correctly, penalties
  from §31 subtracting correctly, clamped 0-100).
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 2 — Work queue & state machine

**Objective:** `work_items` processing primitives and the company/opportunity lifecycle state
machine (§90), fully deterministic, no Claude calls — task handlers are stubs/fixtures for now.

**Build:** priority selection (§49 ordering) as a pure function over queue contents; lifecycle
transition functions (`src/pipeline/stateMachine.ts`) with an explicit set of valid
transitions (attempting an invalid transition throws, doesn't silently succeed); retry/backoff
counters and retryable-vs-non-retryable failure classification (§66); crash recovery
(stuck-`RUNNING`-item reset) as a function run at worker startup.

**Explicitly NOT built:** real agent handlers, the actual `worker.ts` loop/process (that's
Phase 11 — this phase builds the primitives it will use), UI.

**Acceptance criteria:**
- Unit tests covering every valid transition in the §90 lifecycle and rejecting at least the
  obviously-invalid ones (e.g. `DISCOVERED → WON`).
- Unit tests for priority ordering across a mixed queue (verify, e.g., a pending `VERIFY` task
  for a high-scoring opportunity is selected before a `DISCOVER` task).
- Unit tests for crash recovery: a fixture `work_item` stuck `RUNNING` past the timeout gets
  reset to `RETRYABLE`; one within the timeout is left alone.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 3 — Discovery Agent + campaigns

**Objective:** Real companies in the database via manually-configured campaigns (§15), using
`claudeClient` + web tools, wired into the Phase 1/2 persistence and queue.

**Build:** `discovery_campaigns` CRUD (manual only — no Claude-suggested campaigns yet, §15
explicitly defers that); Discovery Agent per the AGENT_CONTRACTS.md §1 contract; diversity-
aware campaign selection (§16) as a simple deterministic weighted-round-robin over enabled
campaigns; wiring so a completed `DISCOVER` task inserts new (deduped) companies and enqueues
`PRESCREEN` work items for them.

**Explicitly NOT built:** autonomous campaign generation, pre-screening/research agents
(next phases), any UI (campaigns configured via a seed script/CLI for now).

**Acceptance criteria:**
- Fixture test (mocked `claudeClient`): given canned discovery output, correct companies are
  inserted, duplicates by normalized domain are rejected, `PRESCREEN` work items are created.
- Unit tests for campaign diversity selection distributing across enabled campaigns roughly
  evenly over many iterations, respecting priority weighting.
- Manual smoke test: operator configures one real campaign (e.g. "UK recruitment agencies,
  5-50 employees") and runs discovery live against it; documented in the phase completion doc
  with the real companies found and a judgment on whether they're real, distinct, and roughly
  on-target (§14 "must never invent company names/URLs").
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 4 — Pre-Screening Agent

**Objective:** Cheap classification of discovered companies (§18) so deep research is spent
only on promising ones (§13).

**Build:** Pre-Screening Agent per AGENT_CONTRACTS.md §2; lifecycle wiring
(`DISCOVERED → PRESCREENED`, with `DISCARD` outcomes recorded with reason and not re-queued,
`PROMISING` outcomes enqueueing `RESEARCH`).

**Explicitly NOT built:** deep research itself, scoring, any UI.

**Acceptance criteria:**
- Fixture tests: strong candidate → `PROMISING`; clearly dead/parked website → `DISCARD` with
  reason; already-researched-recently company → `DISCARD` with reason (freshness check is
  deterministic, not asked of Claude — verify the agent handler checks
  `nextEligibleResearchAt` before even calling Claude, saving the call entirely).
- Manual smoke test against real companies produced by Phase 3, documented in the completion
  doc.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 5 — Deep Research Agent + evidence model

**Objective:** The most important agent in the system (§19). Multi-source, dynamically-chosen
research producing properly classified, provenance-backed evidence.

**Build:** Deep Research Agent per AGENT_CONTRACTS.md §3; the ADR-0004 `PostToolUse` hook
wiring so every fetch becomes a `Source` row automatically; research-integrity rules (§24)
baked verbatim into the system prompt; lifecycle wiring to `RESEARCHED`.

**Explicitly NOT built:** opportunity formation/scoring (that's Phase 6 — this phase only
produces evidence, deliberately kept separate so research quality can be evaluated in
isolation first, per §101.20).

**Acceptance criteria:**
- Fixture tests: a company with genuinely strong public signals produces multiple FACTs with
  distinct sources; a company with a bare brochure site produces mostly UNKNOWNs and few/no
  HYPOTHESES presented as anything stronger; a deliberately misleading-evidence fixture (e.g.
  a stale/outdated page) is still classified honestly rather than upgraded to FACT.
- Unit test asserting every persisted `evidence_item` has a linked `sources` row with a
  `retrievedAt` timestamp (provenance is structurally required, not optional).
- Manual review: operator runs real research against 5-10 companies from earlier phases and
  spot-checks a sample of FACT claims against the actual source page, documenting in the
  completion doc whether anything was fabricated or overstated. This is the single most
  important manual check in the whole plan — if it fails, stop and revise the prompt/hook
  design before continuing to Phase 6.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 6 — Opportunity Analysis Agent + scoring wiring

**Objective:** Turn Phase 5's evidence into scored `Opportunity` records (§26-31), wiring in
the Phase 1 scoring calculator for real.

**Build:** Opportunity Analysis Agent per AGENT_CONTRACTS.md §4; problem-category seed list
(§25, non-restrictive — schema stores free text); ROI/impact-assumption structure (§29) with
explicit known-vs-assumption separation; wiring `opportunity_evaluations.rawScore` /
`adjustedScore` from `src/lib/scoring.ts` against the agent's output + linked evidence, never
from a Claude-provided number.

**Explicitly NOT built:** skeptical verification, offers, contacts, outreach, UI.

**Acceptance criteria:**
- Fixture test using §88's bad-opportunity example (contact form → assumed high volume/manual
  processing/chatbot fix) as input evidence: the resulting opportunity must not present the
  unsupported claims as FACT, and its deterministic score must land low enough to fail the
  Phase 7 gating threshold once that exists (documented expectation now, verified for real in
  Phase 7).
- Fixture test using §89's "correct reasoning" style evidence: opportunity forms with properly
  separated facts/inferences/unknowns and a sensible `validationQuestion`.
- Unit tests confirming the score stored in the DB always matches `scoring.ts`'s output for
  that evaluation's component values, never a model-supplied number.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 7 — Skeptical Verification Agent + strong-opportunity gating

**Objective:** A fresh-context adversarial pass (§33) and the deterministic gate (§32) that
decides what's allowed to reach the dashboard as a Strong Opportunity.

**Build:** Skeptic Agent per AGENT_CONTRACTS.md §5, invoked with only the opportunity +
evidence (not the analysis agent's confidence framing); gating function combining verifier
result, adjusted score (default threshold ~75/100, configurable per §32), evidence-score
floor, and risk category (§8 high-risk domains reduce/exclude by default).

**Explicitly NOT built:** offers, contacts, outreach, UI.

**Acceptance criteria:**
- Fixture test: §88's bad-opportunity example, carried through Phase 6, is `REJECT`ed by the
  skeptic and fails gating regardless.
- Fixture test: a borderline-but-thin opportunity (evidence mostly HYPOTHESIS, no strong FACT)
  is rejected or scored down — confirms the "biased toward rejecting mediocre opportunities"
  requirement (§33) isn't just aspirational prompt text.
- Unit tests for the gating function directly (threshold, risk-category interaction) fully
  independent of any Claude call.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 8 — Offer Builder + pricing

**Objective:** Concrete, priced offers (§34) for gated opportunities only.

**Build:** Offer Builder per AGENT_CONTRACTS.md §6; configurable pricing bands (§35) in
`system_config`; deterministic vague-offer lint (reject/regenerate on a blocklist match, e.g.
bare "AI automation services").

**Explicitly NOT built:** contact research, outreach, automatic demo generation (§36 —
description only, never claims a demo exists), UI.

**Acceptance criteria:**
- Fixture test: a vague generated offer is caught by the lint and triggers regeneration (mock
  the second call).
- Unit tests: price falls within the configured band matching the opportunity's estimated
  duration, or an explicit justification is recorded when it doesn't.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 9 — Contact Research Agent

**Objective:** Decision-maker discovery (§37), only for gated+offered opportunities.

**Build:** Contact Agent per AGENT_CONTRACTS.md §7; email confidence classification
(`PUBLICLY_LISTED / VERIFIED / GUESSED / UNKNOWN`) enforced at the data-access layer so no
code path can render a `GUESSED` email as `VERIFIED` (§38 hard rule).

**Explicitly NOT built:** outreach drafting, UI.

**Acceptance criteria:**
- Unit test asserting the serialization/query layer cannot produce a "verified" representation
  for a row whose `emailConfidence` is `GUESSED` (test this at the data layer, not just by
  eyeballing a UI that doesn't exist yet).
- Fixture tests covering each confidence state.
- Manual smoke test against a few real gated opportunities from earlier phases.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 10 — Outreach Writer

**Objective:** One truthful, concise draft email per strong opportunity + contact (§39-40).

**Build:** Outreach Writer per AGENT_CONTRACTS.md §8; deterministic post-generation checks:
word count (60-130 words), banned marketing-phrase list, and a truthfulness heuristic tying
confident-sounding phrasing to FACT-classified evidence (hedged phrasing required when only
INFERENCE/HYPOTHESIS backs a claim).

**Explicitly NOT built:** sending (never — §41 is permanent for this whole project, not just
early phases), UI beyond what's needed to inspect a draft via script/test output.

**Acceptance criteria:**
- Automated tests: banned-phrase list rejects §39's example bad phrases ("revolutionary AI
  solution", etc.); word-count violation triggers regeneration.
- Fixture test modeled on §87's example: given similar evidence, output is in the right tone/
  length ballpark (this is necessarily a soft check — assert structural properties, not exact
  wording).
- Manual review: operator reads 3-5 generated drafts against real opportunities from earlier
  phases and judges against §87's stated qualities (specific, truthful, short, human, low
  pressure, problem-focused, not AI-hype) — documented verdict per draft in the completion doc.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 11 — Autonomous scheduler / worker

**Objective:** `src/worker.ts`, the actual long-running autonomous loop (§50), wiring
everything from Phases 2-10 into continuous operation with quota-aware backoff (§51) and
pause/resume (§71).

**Build:** the loop itself; `QuotaExhausted` handling with backoff/sleep, never automatic
API-key fallback; `system_config`-driven pause/resume checked every cycle; example macOS
`launchd` plist.

**Explicitly NOT built:** UI (pause/resume is toggled via a config script/CLI flag until
Phase 12 gives it a dashboard control).

**Acceptance criteria:**
- Integration test: a queue seeded with mixed-priority fixture work items, run through the
  loop with a mocked `claudeClient` that simulates a `QuotaExhausted` result partway through —
  assert the loop stops issuing new calls, persists partial state correctly, and (with time
  mocked forward) resumes afterward without duplicating or losing work.
- Integration test: simulated crash (kill mid-task) followed by restart correctly recovers via
  Phase 2's stuck-`RUNNING` reset and continues.
- Manual run: operator starts the worker for a real multi-hour stretch and confirms (via logs/
  `work_items` inspection) it behaved sensibly — documented in the completion doc.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 12 — Dashboard MVP

**Objective:** The Next.js UI (§42-46, §69, §71-73) — the first phase where the operator gets
a real interface instead of scripts/DB inspection.

**Build:** summary metrics view; opportunity list + full opportunity card (§43) with evidence
UX (§44 — claim/type/source/date/confidence, clickable source links, WHY CLAUDE LIKES THIS /
WHY THE SKEPTIC MIGHT REJECT IT / WHAT WE KNOW-INFER-DON'T KNOW / WHAT TO VERIFY per §85);
operator action buttons (§45) with rejection-reason picker (§46); run history/activity feed
(§69); autonomous mode + pause/resume toggle (§71) writing to `system_config`; manual
"research this company now" entry point (§72) that enqueues the same pipeline Phase 3-10 use.

**Explicitly NOT built:** filtering/search polish beyond basics (§73 can extend later),
outcome analytics dashboards (Phase 13), config UI beyond autonomous on/off (Phase 14).

**Acceptance criteria:**
- Playwright smoke tests for: viewing an opportunity's full evidence trail, approve/reject
  with reason, marking sent, toggling autonomous mode, manual company entry triggering a real
  (mocked in test) pipeline run.
- Manual UX walkthrough by the operator against the full §95 scenario end-to-end using data
  produced by earlier phases; documented pass/fail per step in the completion doc — this is
  effectively the §91 "MVP success test" checkpoint.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 13 — Feedback loop & outcome analytics

**Objective:** Outcome tracking and the simple statistical feedback loop (§47, §74) — no ML.

**Build:** outcome event recording wired to dashboard actions from Phase 12;
aggregate-by-dimension queries (industry, country, price band, problem category, campaign);
small-sample-size guarding so a 1-of-1 "100% reply rate" isn't presented as meaningful (§74).

**Acceptance criteria:**
- Unit tests for aggregate calculations, including the small-sample-size guard behavior.
- `npm run build && npm run lint && npm test` all pass.

---

### Phase 14 — Operational hardening

**Objective:** The remaining operator-safety and data-stewardship requirements that don't
block the core loop but are needed before trusting the system with real, ongoing use: company/
domain/industry/country exclusion (§61), `DO_NOT_CONTACT` enforcement in outreach generation
(§65), re-research eligibility windows (§60), CSV/JSON export (§79), DB backup/restore (§80),
a config UI beyond autonomous on/off (§70), the seed/test-mode CLI for running known companies
through the pipeline without live discovery (§99), logging/observability polish (§68), and a
pass over secret handling (§77 — confirm nothing sensitive is logged or committed).

**Acceptance criteria:**
- Unit tests: exclusion rules are respected by discovery/pre-screening (excluded
  company/domain/industry/country never re-enters the queue); `DO_NOT_CONTACT` contacts never
  get a new `WRITE_OUTREACH` task; re-research windows correctly gate eligibility.
- Backup/restore round-trip test (backup, corrupt/delete the live DB, restore, verify data
  matches).
- Export completeness test (every entity type covered, spot-check a few real records).
- `npm run build && npm run lint && npm test` all pass.

---

## Deferred beyond these phases (explicitly not planned in detail yet)

Per spec, these are real future capabilities but are intentionally left unplanned until the
above prove the core loop works and produces real outcomes: Claude-suggested/autonomous
campaign generation (§15 later half), periodic Claude-driven strategy review and reallocation
recommendations (§75, requires operator approval by design), recurring-pattern/productized-
service detection across many companies (§76), automatic demo generation (§36 later
possibility), and any migration off SQLite/local-only (§11 — architecture doesn't block this,
nothing here should make it harder later, but nothing is built for it now).

## Core engineering philosophy (applies to every phase)

Simple, observable, recoverable, testable, typed, modular, local-first, structured — over
clever, distributed, opaque, overengineered (§96). Claude is used only for genuinely
judgment-requiring reasoning (is this friction meaningful? who owns this problem? what price
seems sensible?); everything else — state transitions, deduplication, scheduling,
persistence, validation, sorting, filtering, retries, configuration, score arithmetic, UI
behavior — is ordinary deterministic TypeScript (§97). When in doubt about which side of that
line something falls on, deterministic code wins.
