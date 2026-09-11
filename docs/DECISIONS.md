# Decision log

Append-only. Add a new ADR when a phase makes a non-obvious technical call; never edit old
entries except to add a "Superseded by ADR-000N" note.

---

## ADR-0001: Invoke Claude via the Claude Code CLI subprocess, not the Agent SDK library, and never forward `ANTHROPIC_API_KEY`

**Status:** Accepted (verify again before Phase 0 starts — this space has moved multiple
times in 2026; see "Verification history" below).

**Decision:** The system invokes Claude exclusively by spawning the `claude` CLI binary in
non-interactive mode (`claude -p "<prompt>" --output-format json`, with `--model` and
`--allowedTools` set explicitly per call) as a Node.js child process, authenticated through
the operator's own `claude login` OAuth session (their existing Pro/Max/Team subscription).
It does **not** use the `@anthropic-ai/claude-agent-sdk` library, and it never sets or
forwards `ANTHROPIC_API_KEY` into the child process environment.

**Why:**

- As of this writing (Sept 2026), Anthropic's Agent SDK overview page states: *"Unless
  previously approved, Anthropic does not allow third party developers to offer claude.ai
  login or rate limits for their products, including agents built on the Claude Agent SDK.
  Use the API key authentication methods described in the Quickstart instead."* That
  guidance is aimed at products distributed to other end users, but it signals that
  Anthropic's supported story for the *SDK library* is API-key auth, not OAuth. This project
  is single-user and never distributed, but there's no unambiguous, low-risk way to read that
  note as clearing OAuth-in-the-SDK for this case.
- By contrast, the Claude Code CLI's non-interactive mode (`claude -p`) is explicitly designed
  for the operator to drive their *own* logged-in session non-interactively, and Anthropic's
  help center (`support.claude.com`, "Use the Claude Agent SDK with your Claude plan") states
  plainly that "Agent SDK, `claude -p`, and third-party app usage still draw from your
  subscription's usage limits" (as of the June 2026 pause — see verification history).
  Driving the CLI binary the operator already uses interactively, with the same OAuth
  credentials, is the lowest-risk way to guarantee subscription billing rather than API
  billing.
- The single most expensive failure mode this project must avoid (per spec §10/§51/§78) is
  silent API billing. A real incident (`anthropics/claude-code` issue #37686) shows this can
  happen — a Max subscriber lost $1,800+ in two days because `claude -p` picked up an
  `ANTHROPIC_API_KEY` set in the shell environment. The fix is structural, not a warning: the
  wrapper (`src/agents/claudeClient.ts`, built in Phase 0) spawns the subprocess with an
  explicit `env` object that never includes `ANTHROPIC_API_KEY`, regardless of what's set in
  the parent shell, and logs a loud warning at startup if it detects the variable is set in
  the parent process (so the operator knows to unset it, since its mere presence is a latent
  foot-gun for any *other* tool on the machine, even though this app itself won't forward it).
- The CLI also already ships the tool loop this project needs (web search/fetch, structured
  JSON output) without pulling in a separate library dependency.

**Verification history (re-check at the start of Phase 0):**

- Anthropic previously announced (effective June 15, 2026) that `claude -p` and Agent SDK
  usage would move to a separate "Agent SDK credit" pool capped at $200/month Sonnet-equivalent,
  no longer drawn from interactive subscription limits. This was **paused on the effective
  date** — as of the last check, nothing changed and usage still draws from the normal
  subscription pool. Anthropic has said a revised version may return with advance notice.
  **Before starting Phase 0, re-fetch `support.claude.com`'s "Use the Claude Agent SDK with
  your Claude plan" article and re-search for anything newer** — if the split has since gone
  live, this ADR's mechanism still works (it's still CLI + OAuth) but the cost/quota model
  changes and `docs/ARCHITECTURE.md` + the scheduler's backoff assumptions need updating.
- **Re-verified at the start of Phase 0 (September 2026):** re-fetched the support.claude.com
  article and re-searched for anything newer than the June 15 pause. Nothing has changed —
  Agent SDK / `claude -p` usage still draws from the normal Pro/Max/Team subscription pool.
  Anthropic has not given advance notice of a revised split taking effect. No changes needed
  to this ADR's mechanism. Separately confirmed empirically in Phase 0: a `claude -p
  --output-format json` call against this machine's own `claude login` session (no
  `ANTHROPIC_API_KEY` in the environment) runs successfully and returns a `total_cost_usd`
  figure in its JSON output — that field is present regardless of billing source (it looks
  like a list-price-equivalent usage estimate, not proof of which pool it drew from), so it is
  *not* sufficient on its own to confirm subscription billing. The operator still needs to
  check claude.ai/console's usage page directly, which is why that remains a manual Phase 0
  acceptance criterion below rather than something this ADR treats as auto-verified by the
  CLI's own output.

**Consequences:**

- No `ANTHROPIC_API_KEY` should ever be present in `.env` or committed config for normal
  operation. If the operator later *wants* pay-as-you-go fallback for burst capacity, that
  must be a deliberate, separately-flagged config path (`ALLOW_API_BILLING=true` or similar),
  never the default, per spec §78.
- Usage-limit detection has to be done by parsing CLI stderr/exit codes for known phrases
  ("You've hit your session limit", "You've hit your weekly limit", `rate_limit_error`, HTTP
  429) rather than a clean structured "quota remaining" API — there is no documented
  programmatic quota-percentage endpoint. Build the scheduler's backoff logic accordingly
  (see PLAN.md, Phase 11).
- Because everything goes through the CLI as a subprocess (not the SDK's typed streaming
  API), agent orchestration is call-and-response per task rather than a persistent
  in-process session — which fits this project's explicit requirement (spec §9) to avoid one
  giant persistent Claude conversation anyway.

---

## ADR-0002: Drizzle ORM over Prisma

**Status:** Accepted.

**Decision:** Use `drizzle-orm` + `better-sqlite3` + `drizzle-kit` for the database layer.

**Why:** No separate query-engine binary/process (Prisma ships a Rust engine binary per
platform, which is friction for a small local app and for `pkg`/`launchd`-style packaging
later). Drizzle's schema is plain TypeScript, migrations are readable SQL, and it maps
cleanly onto SQLite's actual feature set (Prisma's SQLite support is a thinner subset of what
it offers for Postgres). Either would satisfy the spec; this is a "no strong reason to
deviate from a sensible default" call, not a hard requirement.

---

## ADR-0003: Single Next.js app, not a workspace monorepo

**Status:** Accepted.

**Decision:** One `package.json`, one `tsconfig.json`, one `node_modules`. The dashboard
(`src/app`) and the autonomous worker (`src/worker.ts`) are two entry points into the same
codebase, not separate packages.

**Why:** This is a one-user local app. A pnpm/turborepo workspace buys isolation that matters
for teams shipping multiple deployables independently; here it only adds tooling overhead.
Folder boundaries (`src/db`, `src/agents`, `src/pipeline`, `src/lib`, `src/app`) give the same
separation of concerns without the workspace machinery. Revisit only if this ever needs to
ship as multiple independently-deployed services (not planned).

---

## ADR-0004: Evidence provenance captured via a Claude Code hook, not by asking Claude to self-report every source

**Status:** Accepted.

**Decision:** Register a `PostToolUse` hook (via the CLI's hook config, or the `--hooks`
option) on the `WebFetch`/`WebSearch` tools used during research-oriented agent calls. The
hook deterministically writes a `Source` row (URL, title if available, retrieved timestamp)
for every page the agent actually looks at. The agent's own structured output only needs to
reference which source(s) support which claim (by URL or an index the hook assigns) — it is
not trusted as the sole record of what was fetched.

**Why:** Spec §22/§23/§53 require reliable provenance (source URL, retrieval timestamp) for
every evidence item, and require that the operator be able to independently verify research
by clicking through. Relying on the model to remember and faithfully transcribe every URL it
visited into its final JSON is exactly the kind of "ask Claude to do something normal code
can reliably enforce" anti-pattern the spec itself warns against (§96/§97). A tool-use hook
is deterministic and can't omit or mis-transcribe a fetch.

---

## ADR-0005: Vitest over Jest

**Status:** Accepted. Native ESM/TS support without extra transform config, fast, good enough
ecosystem for this project's needs (unit tests, fixture-based agent tests with mocked
`claudeClient`). No hard requirement either way; picked for lower config overhead.

---

## ADR-0006: Model selection via config, not hardcoded model IDs

**Status:** Accepted.

**Decision:** `src/config/models.ts` maps logical tiers (`fast`, `reasoning`) to CLI model
aliases (e.g. `sonnet`, `opus`, `haiku` — whatever aliases `claude -p --model` accepts at
implementation time) read from environment/config, not hardcoded per call site. Spec §52
requires this explicitly. Confirm current valid `--model` alias values during Phase 0 (they
drift over time) and record them in `docs/ARCHITECTURE.md`, not in this ADR.

---

## ADR-0007: Tool restriction requires both `--tools` and `--allowedTools`, plus `--permission-prompts none`

**Status:** Accepted, based on empirical testing during the Phase 0 spike.

**Decision:** Every `claudeClient.invokeClaude()` call passes `--tools <exact list>`,
`--allowedTools <same exact list>`, and `--permission-prompts none`, all three together, never
just one or two of them. There is no "use the CLI's default tool set" call site anywhere in
this codebase — every call states its tools explicitly, even calls that need none (`--tools ""`).

**Why:** Before Phase 0, the plan (PLAN.md §9, AGENT_CONTRACTS.md) only mentioned
`--allowedTools` as the mechanism for restricting tool access per call. Empirical testing
during the Phase 0 spike found this assumption wrong in two distinct, non-obvious ways:

1. **`--allowedTools` alone does not restrict which tools exist.** It only pre-approves tools
   against the permission-prompt system; the full default Claude Code tool set (Bash, Edit,
   Write, Agent, Artifact, etc. — far more than any agent in this system should ever have) is
   still available underneath it. The flag that actually defines the available tool set is
   `--tools` (`""` to disable all tools, `"default"` for everything, or an explicit
   comma-separated list). Confirmed by spawning `claude -p` with only `--allowedTools ""` and
   asking it to run Bash — it happily executed a real shell command.
2. **`--tools` alone, without `--allowedTools` naming the same tools, still gets every tool use
   auto-denied** (correct — no human is present to answer a permission prompt in `-p` mode) —
   but critically, **on denial the model does not reliably say "I don't have that tool."** In
   testing, a denied `WebSearch`/`WebFetch` call caused the model to answer from its own
   training-data recall and present it as if it came from the target's public sources ("from
   my training data, I can tell you that Anthropic's official website has the main heading
   'Claude'"). This is exactly the fabrication failure mode spec §24 exists to prevent, and it
   happens silently unless the tool is both defined (`--tools`) and pre-approved
   (`--allowedTools`) so the call can actually execute instead of failing closed into a guess.

`--permission-prompts none` is added as defense-in-depth: even with `--tools` and
`--allowedTools` aligned, anything unexpected (a tool call outside the stated list, e.g. from a
prompt-injection attempt on a fetched page) is auto-denied rather than hanging forever waiting
for a permission answer that will never come in a non-interactive worker process.

**Consequences:**

- Every agent's contract (docs/AGENT_CONTRACTS.md) must state its exact tool list, and
  `claudeClient` has no implicit default — passing an empty `tools: []` is the explicit way to
  say "no tools," not an oversight.
- Because denial can still produce a confident-sounding fabricated answer if the *prompt*
  doesn't also forbid it, the research integrity rules (spec §24) must be stated in the system
  prompt of every tool-using agent regardless of the `--tools`/`--allowedTools` restriction —
  the flags stop the tool from firing, but only the prompt stops the model from guessing
  instead. Neither alone is sufficient; this is documented as a required prompt element in the
  Phase 5 (Deep Research) and any other web-tool-using agent's prompt template, not something
  the CLI flags fix by themselves.
- `--json-schema` (a separate flag, orthogonal to tool restriction) was also confirmed during
  the spike to constrain the CLI's `result` field to schema-conformant JSON — with no markdown
  fences or prose commentary — even for tool-using calls. `claudeClient` exposes this as an
  optional `jsonSchema` field on `ClaudeInvocationOptions`. It is a cheap first line of defense
  only; the calling agent's Zod schema (per AGENT_CONTRACTS.md) remains the source of truth,
  since a schema-shaped JSON value can still be semantically wrong.

---

## ADR-0008: Opportunity penalty point values, and splitting spec §90's status chain across three tables

**Status:** Accepted (Phase 1).

**Decision, part 1 — penalty amounts:** Spec §31 lists ten penalty *reasons* but explicitly
leaves exact point values to implementation. `src/lib/scoring.ts`'s `PENALTY_CATALOG` assigns:

| Reason | Points | Why this weight |
|---|---|---|
| `PROBLEM_ALREADY_SOLVED` | 20 | Undermines the opportunity's entire premise — the biggest single penalty. |
| `WEAK_SPECULATIVE_EVIDENCE`, `SIGNIFICANT_REGULATORY_RISK`, `COMPANY_FINANCIALLY_UNSUITABLE` | 15 | Each independently threatens whether the deal can close at all. |
| `COMMODITY_SOLUTION_AVAILABLE`, `LARGE_PROCUREMENT_BURDEN`, `UNCLEAR_BUYER`, `IMPLEMENTATION_DEPENDENCY_OUTSIDE_CONTROL`, `CROWDED_GENERIC_OFFER` | 10 | Meaningfully reduce attractiveness without necessarily killing the opportunity outright. |
| `LONG_IMPLEMENTATION_CYCLE` | 5 | A soft timing/effort concern, not a reason to reject on its own. |

Chosen so that a single severe penalty (e.g. "problem already solved") can plausibly drag a
strong-looking opportunity below the Phase 7 gating threshold (~75/100) on its own, while a
single mild penalty (long cycle) does not. Revisit once Phase 7 gating is live against real
data — these are a reasoned starting point, not empirically tuned.

**Decision, part 2 — splitting the §90 chain:** Spec §90 draws one conceptual state chain from
`DISCOVERED` through `WON/LOST`, but says explicitly that "exact implementation statuses may
differ." `companies`, `opportunities`, and `outreach_outcomes` have different lifetimes and
cardinalities (a company may never form an opportunity; an opportunity may be sent once but
accrue many outcome events afterward), so the chain is split at those boundaries rather than
stored as one column duplicated across tables:
- `companies.lifecycleStatus`: `DISCOVERED` → `RESEARCHED` (or `NO_OPPORTUNITY`/`DISCARDED`/`EXCLUDED`).
- `opportunities.status`: `OPPORTUNITY_IDENTIFIED` → `SENT`.
- `outreach_outcomes.event`: an append-only log (`SENT \| REPLIED \| NO_REPLY \| INTERESTED \|
  NOT_INTERESTED \| MEETING \| WON \| LOST`), not a status column — Phase 13's feedback loop
  (§47) needs the full history, not just the latest event, so a mutable "current status" field
  would be the wrong shape even before considering drift risk.

**Decision, part 3 — enums as `text(..., { enum: [...] })`, no DB-level `CHECK`:** Considered
adding explicit SQL `CHECK` constraints (drizzle-orm's `check()` helper) on every enum column
for defense-in-depth. Skipped: this is a single-writer local app where `src/db/schema.ts`'s TS
types are the only thing that ever writes to the DB (no external tool, no multi-service
writers), so a `CHECK` constraint would duplicate what the type system already guarantees at
every call site, with no realistic path for a stray raw value to reach the DB. Revisit only if
a later phase adds a write path that bypasses Drizzle's typed API (none currently planned).

**Consequences:** Phase 6 (Opportunity Analysis) and Phase 7 (Skeptical Verification) should
treat `PENALTY_CATALOG`'s values as adjustable, not fixed — flag in that phase's completion doc
if real opportunities suggest the weights are off. Phase 2's state machine
(`src/pipeline/stateMachine.ts`) must implement transitions for all three enums as separate,
independently-validated chains, not one shared transition function.

---

## ADR-0009: Phase 2 queue/state-machine judgment calls not pinned down by the source spec

**Status:** Accepted (Phase 2).

**Decision, part 1 — priority weights for `ANALYZE` and `REFRESH_EVIDENCE`:** Spec §49 gives an
explicit 7-item priority ordering but the `work_items.taskType` enum has two members it never
mentions. `src/pipeline/priority.ts`'s `TASK_TYPE_PRIORITY` places them as:

- `ANALYZE` between `WRITE_OUTREACH` and `RESEARCH` — it turns already-gathered research into a
  scored opportunity, so (like verify/offer/contact/outreach) it progresses work with sunk
  research investment rather than starting fresh, but it hasn't cleared verification yet.
- `REFRESH_EVIDENCE` between `RESEARCH` and `PRESCREEN` — keeping existing evidence current
  (spec §60) is worth doing but should never crowd out researching a promising company for the
  first time.

Chosen so a full priority-ordering test can assert the whole 9-item sequence, not just the
7 spec explicitly names. Revisit once Phase 6+ show whether refreshing evidence for an
active opportunity should actually outrank fresh `RESEARCH` on a new company.

**Decision, part 2 — work item transition graph:** `RETRYABLE` and `DEFERRED` both transition
straight back to `RUNNING` (not through `PENDING`) since nothing meaningful happens in
`PENDING` that isn't already captured by the item's stored `priority`/`runAfter`. Both, plus
`PENDING`, can transition to `CANCELLED` (operator/exclusion cancels queued-but-not-yet-running
work); `RUNNING` cannot go directly to `CANCELLED` — a genuinely stuck `RUNNING` item is first
recovered to `RETRYABLE` by crash recovery (spec §67), which can then be cancelled, rather than
inventing a second, overlapping "cancel while running" path.

**Decision, part 3 — company lifecycle `DISCARDED` vs `EXCLUDED`:** `DISCARDED` is reachable
only from the normal discovery→research pipeline stages (`DISCOVERED` through
`RESEARCH_PENDING`) — it represents a pipeline-stage judgment (dead site, already covered
recently, etc., per PLAN.md Phase 4). `EXCLUDED` is handled as a special case reachable from any
other non-`EXCLUDED` status, since spec §61's blacklist/exclusion system is an operator action
that can happen at any point in a company's life, not a pipeline outcome — encoding it as a
special case avoids repeating it in every row of `COMPANY_LIFECYCLE_TRANSITIONS` (and the drift
risk that repetition would carry) while keeping the table itself an accurate picture of the
actual pipeline shape.

**Decision, part 4 — failure classification defaults and backoff schedule:** Spec §66 lists
failure causes without saying which are retryable; nearly all of them (usage limits, DNS,
network, rate limiting, page/source issues, DB lock, timeouts) are transient, so
`src/pipeline/failureClassification.ts`'s `classifyFailure` defaults unrecognized errors to
`RETRYABLE` and only pattern-matches a short explicit list (`401`/`403`/`404`, "invalid state
transition") as `NON_RETRYABLE`, plus treats an item that has exhausted `DEFAULT_MAX_ATTEMPTS`
(3, matching AGENT_CONTRACTS.md's "one retry, then FAILED" framing generalized to non-Claude
failures) as `NON_RETRYABLE` regardless of cause. Retry backoff is exponential starting at 1
minute, doubling, capped at 1 hour (`computeRetryBackoffMs`) — a separate, shorter schedule than
PLAN.md §12's quota-exhaustion backoff (30 min+, Phase 11), since a single task retry and a
quota-exhausted scheduler-wide pause are different situations with different acceptable delays.

**Decision, part 5 — stuck-`RUNNING` timeout:** `DEFAULT_STUCK_RUNNING_TIMEOUT_MS` = 30 minutes.
No single agent call in this system is expected to run anywhere near that long; picked
generously so crash recovery never recovers a task that's merely slow rather than actually
abandoned. Revisit if a later phase's real agent calls (e.g. Deep Research with many web fetches)
turn out to routinely run longer.

**Consequences:** These are all reasoned starting points, not empirically tuned — flag in a
later phase's completion doc if real usage suggests any of them are off, same as ADR-0008's
penalty values.

---

## ADR-0010: Phase 3 (Discovery Agent + campaigns) judgment calls

**Status:** Accepted (Phase 3).

**Decision, part 1 — the validation-retry loop lives in a new `runStructuredAgent.ts`, not
inside `claudeClient.ts`:** AGENT_CONTRACTS.md's cross-cutting rules say the "one retry with
the validation error appended, then FAILED" behavior is "implemented once in claudeClient.ts,
not per-agent." Phase 3 implements the *behavior* that sentence is actually protecting (one
shared implementation, not one per agent) but in a separate module
(`src/agents/runStructuredAgent.ts`) layered on top of `claudeClient.invokeClaude`, not inside
`claudeClient.ts` itself. Reason: `claudeClient.ts` is deliberately Zod-agnostic — it spawns a
process and returns raw text/JSON, with no knowledge of any specific agent's schema. Validating
against a `z.ZodType<T>` and re-prompting with the formatted validation error is schema-aware
logic that belongs one layer up. Every agent (Discovery now; Pre-Screening/Deep
Research/Opportunity Analysis/... in later phases) calls `runStructuredAgent`, so the "once, not
per-agent" requirement holds in spirit even though the file boundary differs from the literal
text.

**Decision, part 2 — campaign selection algorithm (spec §16 diversity):**
`src/pipeline/campaignSelection.ts` implements smooth weighted round-robin (the algorithm nginx
uses for weighted load balancing) over `ENABLED` campaigns, weight = `priority + 1` (floored at
1 so a zero/default-priority campaign is never starved to zero picks). Chosen over "always pick
highest priority" because that would defeat §16's explicit "don't spend all capacity on one
sector" requirement — SWRR guarantees every enabled campaign gets picked its proportional share
within any window of `totalWeight` selections, never letting one campaign dominate every single
pick even when it has the highest priority. State (`CampaignSelectionState`) is threaded
explicitly through the pure function rather than held internally, so it can be persisted
(e.g. a `system_config` row) across separate process invocations once Phase 11's worker loop
exists; Phase 3 itself doesn't wire that persistence since campaigns are still run one at a time
via `scripts/discover.ts --campaign <id>`, not autonomously.

**Decision, part 3 — `DISCOVER` work items store a campaign id in `entityId`:**
DATABASE_SCHEMA.md describes `work_items.entityId` as "company/opportunity id this task operates
on," and `schema.ts`'s comment (pre-Phase-3) said the same. A `DISCOVER` task doesn't have a
company yet — it's what creates them — so its only sensible `entityId` is the
`discovery_campaigns.id` driving it. `entityId`'s polymorphism is extended to include campaign
ids for this one task type (documented in both this ADR and an updated `schema.ts` comment) 
rather than adding a separate, mostly-unused column — `entityId` was already untyped/non-FK for
exactly this kind of polymorphism.

**Decision, part 4 — dedupe: per-campaign hint, global enforcement:** The Discovery Agent's
"known domains" hint (AGENT_CONTRACTS.md §1) is scoped to companies already discovered *by this
campaign* (matches the contract's literal wording and keeps the prompt short), but the actual
insert-time dedupe check in `discoverHandler.ts` is global, keyed on
`companies.normalizedDomain`'s unique constraint — a business discovered by campaign A and later
suggested again by campaign B is still not re-inserted, since a company's identity isn't
campaign-scoped. On a rediscovery hit, the existing row's `lastDiscoveredAt` is bumped and no
second `PRESCREEN` work item is created; re-triggering the pipeline for an already-processed
company is spec §60's re-research eligibility window, explicitly Phase 14 scope, not Phase 3's.

**Decision, part 5 — quota exhaustion transitions a `DISCOVER` item to `DEFERRED`, not
`RETRYABLE`:** Unlike a validation or CLI failure (routed through
`failureClassification.resolveFailureOutcome`, which increments `attempts` and applies
backoff), a `quota_exhausted` result doesn't consume a retry attempt — retrying immediately
can't help, and counting it against `DEFAULT_MAX_ATTEMPTS` would let a single quota exhaustion
event prematurely exhaust a task's real retry budget. `RUNNING -> DEFERRED` (already a valid
transition in `stateMachine.ts`, explicitly commented as "quota exhausted mid-task — resume
later") is used instead, with `runAfter` left null since no scheduler exists yet to interpret
it — Phase 11's worker loop owns deciding when a quota-deferred item should actually resume.

**Decision, part 6 — Discovery uses the `"fast"` model tier:** Spec §52 explicitly lists
"discovery" under its lower-cost/faster-model example column. `runDiscoveryAgent` defaults to
`resolveModelAlias("fast")` (currently `haiku`), overridable per call.

**Decision, part 7 — `reasonToScreen` is stored in `companies.notes`, not a new column:** The
Discovery Agent's output contract (AGENT_CONTRACTS.md §1) includes `reasonToScreen`, but
DATABASE_SCHEMA.md's `companies` table has no dedicated field for it. Rather than add a
single-purpose migration for one Phase-3-only string, it's seeded into the existing
operator-editable `notes` column (prefixed `"Discovery reason: "`) at insert time. This is a
deliberate reuse, not silent repurposing — flagged here and in `discoverHandler.ts` — and
should be revisited if a later phase (e.g. the Phase 12 dashboard) wants to display discovery
rationale separately from operator notes.

**Decision, part 8 — discovery volume is a code constant + CLI flag, not a `system_config`
read:** DATABASE_SCHEMA.md lists "discovery volume" among `system_config`'s intended keys, but
no typed config-accessor module (`src/lib/config.ts`) exists yet — it's referenced in
DATABASE_SCHEMA.md as a forward pointer for whichever phase first needs it, and building that
general accessor layer prematurely, for one setting, is out of Phase 3's scope (PLAN.md
explicitly assigns "a config UI beyond autonomous on/off" to Phase 14).
`DEFAULT_DISCOVERY_TARGET_COUNT = 8` in `discoveryAgent.ts`, overridable via
`runDiscoveryAgent`'s `targetCount` or `scripts/discover.ts --count`.

**Decision, part 9 — `prompt_versions` is still not populated:** Phase 3 is the first phase to
make real Claude calls against the live DB, but no row is written to `prompt_versions` for the
Discovery Agent's template. Doing so usefully would require a per-call log linking a specific
invocation's output back to a template version and entity — a facility that doesn't exist yet
(work_items captures task-level provenance — taskType, entityId, status, attempts, lastError,
timestamps — but not a link to a prompt-template id). Flagged as an open item, same category as
Phase 0's original "known limitation" note on this.

**Consequences:** Every later phase's agent (Pre-Screening, Deep Research, Opportunity
Analysis, Skeptical Verification, Offer Builder, Contact Research, Outreach Writer) should build
on `runStructuredAgent.ts` rather than reimplementing the retry loop, and should follow the same
per-task-type judgment-call pattern here (document scope decisions in a new ADR part rather than
silently deviating) when the source spec doesn't pin something down.

---

## ADR-0011: Phase 4 (Pre-Screening Agent) judgment calls

**Status:** Accepted (Phase 4).

**Decision, part 1 — `MAYBE` is treated the same as `PROMISING`:** AGENT_CONTRACTS.md §2's
output enum has three values (`DISCARD | MAYBE | PROMISING`), but PLAN.md's Phase 4 build text
only describes two outcomes ("`DISCARD` outcomes recorded with reason and not re-queued,
`PROMISING` outcomes enqueueing `RESEARCH`"), leaving `MAYBE` unaddressed.
`src/pipeline/prescreenHandler.ts` routes `MAYBE` through the exact same path as `PROMISING`
(company transitions to `RESEARCH_PENDING`, a `RESEARCH` work item is enqueued). Reasoning: this
is a cheap, fast-tier (`haiku`), single-pass classification with no deep verification behind it;
treating genuine uncertainty as a reason to permanently kill a company (the same as `DISCARD`)
risks silently discarding real opportunities on a shallow signal, which is a worse failure mode
than spending one more Deep Research call to actually resolve the uncertainty. Only `DISCARD` —
reserved for cases the agent is confident about (dead site, wrong business type entirely) — halts
the pipeline. Revisit if real usage shows `MAYBE` firing so often that it defeats the cost-saving
purpose of pre-screening in the first place (spec §13).

**Decision, part 2 — tools: `WebFetch` only, no `WebSearch`:** Unlike Discovery
(`WebSearch`+`WebFetch`) and the planned Deep Research agent, the Pre-Screening Agent gets only
`WebFetch`. AGENT_CONTRACTS.md §2's input is explicitly scoped to "a handful of fetched pages"
for a company whose website is already known from Discovery — there is nothing to *search* for,
only pages to *fetch* — and keeping the tool list minimal keeps this step cheap, which is its
entire purpose (spec §13/§18).

**Decision, part 3 — the `nextEligibleResearchAt` freshness short-circuit is implemented even
though nothing in the current pipeline can yet produce a `PRESCREEN` item for a company where
it fires:** PLAN.md's Phase 4 acceptance criteria explicitly requires this deterministic check
("verify the agent handler checks `nextEligibleResearchAt` before even calling Claude, saving
the call entirely"), tested via a fixture. Today, a `PRESCREEN` work item is only ever created by
`discoverHandler.ts` for a brand-new company (`nextEligibleResearchAt` is always null at that
point), so this branch is currently unreachable from the live pipeline — it exists as a
forward-looking guard for whichever later phase first creates a `PRESCREEN` item against an
already-researched company (e.g. a Phase 12 §72 "research this company now" manual trigger, or a
future re-discovery-triggers-re-prescreen path). Implemented now rather than deferred, per the
explicit acceptance criterion; the company's lifecycle is transitioned to `DISCARDED` via the
same `transitionCompanyLifecycle` call used for a real Claude-classified `DISCARD`, so this path
can only ever run against a company whose current status still allows that transition (if it
doesn't — e.g. an already-`RESEARCHED` company somehow got a `PRESCREEN` item — the resulting
`InvalidTransitionError` is a legitimate signal of a bug upstream, not something to swallow here).

**Decision, part 4 — pre-screen classification + reasons are recorded in `companies.notes`, same
convention as `reasonToScreen` (ADR-0010 part 7):** No dedicated schema column exists for
pre-screen output. Rather than add one for a single phase's free-text summary, the classification
and joined reasons are appended as a new line to the existing `notes` field (`"Prescreen
(PROMISING): reason1; reason2"`), preserving whatever was already there (the Discovery reason,
and potentially a prior phase's own line later). Revisit alongside ADR-0010 part 7 if a later
phase (e.g. the Phase 12 dashboard) needs these distinguished as structured fields rather than
one free-text audit trail.

**Decision, part 5 — a `MAYBE`/`PROMISING` result validates the full
`PRESCREEN_PENDING -> PRESCREENED -> RESEARCH_PENDING` chain but persists only the final state in
one DB write:** Unlike `DISCOVER`'s `DISCOVERED -> PRESCREEN_PENDING` hop (a single transition
persisted because the company then sits waiting for a separate worker pick-up of its `PRESCREEN`
item), this handler both classifies *and* immediately enqueues the next (`RESEARCH`) work item in
the same call — there's no window where a durably-visible `PRESCREENED` state matters on its own.
Both transition functions are still called (so an invalid hop in the state table would still
throw, same safety guarantee as a two-write version), but only the final `RESEARCH_PENDING`
value is written to the row, avoiding a pointless intermediate `UPDATE`.

**Consequences:** Phase 5 (Deep Research) is the next handler to pick up `RESEARCH` work items
this phase's handler creates — it should read `companies.notes` if it wants pre-screen context,
though it isn't required to (the company record itself carries everything Deep Research's
contract needs). Same pattern as ADR-0010: document new judgment calls in a new ADR part rather
than silently deviating.

---

## ADR-0012: Phase 5 (Deep Research Agent + evidence model) judgment calls

**Status:** Accepted (Phase 5).

**Decision, part 1 — the ADR-0004 hook is delivered via `--settings` (exec form), registered
only on `WebFetch`, not `WebSearch`:** `claudeClient.ts` gained a `settings` option
(`--settings <json>`) and an `extraEnv` option (extra env vars merged into the sanitized child
env). `runDeepResearchAgent` uses these to register a `PostToolUse` hook
(`src/agents/sourceCaptureHook.ts`'s `buildSourceCaptureHookSettings`) whose `command`/`args`
point directly at `node_modules/.bin/tsx` and `scripts/hooks/captureSourceHook.ts` — the "exec
form" documented in Claude Code's hooks reference, chosen over a shell-string `command` so
absolute repo paths never need shell-quoting. The matcher is `"WebFetch"` only: confirmed
against the hooks/tools reference (and empirically, in this phase's live smoke test) that
`WebSearch`'s `tool_response` contains only result titles/URLs, never fetched page content —
recording a search-result URL as a `sources` row would misrepresent it as something actually
fetched when it wasn't. `--settings`-supplied hooks were confirmed (per the same reference) to
fire even without a project `.claude/settings.json`, and this repo has none, so there's no
merge-order ambiguity with a project-level hooks config to worry about yet.

**Decision, part 2 — hook context travels via env vars, not IPC:** A hook fires as an
independent OS process spawned by the `claude` binary itself, not a callback into this app's
Node process, so it has no access to the in-memory `Db` handle already open in
`researchHandler.ts`. `buildSourceCaptureHookEnv` passes `AOH_DB_PATH`/
`AOH_RESEARCH_COMPANY_ID`/`AOH_RESEARCH_TASK_ID` as env vars (shared constants in
`sourceCaptureHook.ts` so the two sides can't drift); the hook script opens its own short-lived
`createDb(dbPath)` connection per invocation. This is also why `src/db/client.ts` gained a
`busy_timeout = 5000` pragma this phase — multiple `WebFetch` calls in one research run can
each spawn a hook process that opens the same SQLite file concurrently, which is a genuinely new
scenario (ADR-0008 part 3's "single-writer local app" assumption no longer strictly holds for
this one table).

**Decision, part 3 — an evidence item's `sourceUrl` must match a hook-recorded `sources` row
for that task, or it's dropped, not persisted:** This is the actual enforcement mechanism behind
ADR-0004's stated principle ("the agent's own structured output is not trusted as the sole
record of what was fetched"). `researchHandler.ts` looks up `sources` rows with
`fetchedByTaskId = <this task>` and matches `evidence[].sourceUrl` against `sources.url`,
tolerating only a trailing-slash difference (`urlsMatch`) — anything else (a URL only seen in a
`WebSearch` result, a fabricated URL, a genuine typo) is silently excluded from what gets
persisted, since `evidence_items.sourceId` is a required FK and provenance is structural per
PLAN.md's Phase 5 acceptance criteria, not a soft preference. The count of dropped items is
still surfaced (`droppedUnverifiedEvidenceCount` in the handler's return value, and a note on
`companies.notes`) rather than silently swallowed, so a systematic mismatch is visible without
failing the whole task over what could just be legitimate URL-normalization noise. This path was
exercised for real, not just in fixtures, during this phase's live 8-company smoke test: 7 of 8
companies had every cited `sourceUrl` match a real fetch (0 dropped), but one company ("Animal
Hospital Southwest") had exactly 1 of 23 evidence items dropped — the mechanism catching a real
cited URL that didn't correspond to any page the hook actually recorded as fetched during that
task, which is precisely the scenario ADR-0004 exists to guard against.

**Decision, part 4 — Deep Research uses the `"reasoning"` model tier:** Spec §52 groups "deep
analysis" and "complex opportunity reasoning" under its more-capable-model column, and unlike
Discovery/Pre-Screening (narrow classification tasks explicitly named under the cheaper tier),
Deep Research has to dynamically decide what to investigate per company (spec §19) — the same
judgment call the Phase 0 spike already made (`resolveModelAlias("reasoning")`, i.e. `sonnet`).

**Decision, part 5 — the company transitions `RESEARCH_PENDING -> RESEARCHED` regardless of how
much evidence survives, and an `ANALYZE` work item is always enqueued on success:** A thin or
even zero-evidence result (every fetch failed, or every cited source was dropped) is itself a
valid, expected outcome — spec §98 explicitly lists "insufficient evidence" as a scenario Phase
6's agent must handle, not one Phase 5 should block on. `researchHandler.ts` enqueues `ANALYZE`
unconditionally whenever the Claude call itself succeeds, following the same "each handler wires
the next stage's queue" pattern as `discoverHandler.ts` (enqueues `PRESCREEN`) and
`prescreenHandler.ts` (enqueues `RESEARCH`) — PLAN.md's Phase 5 "explicitly NOT built" scope
covers the Opportunity Analysis *agent itself*, not queue wiring for it, and leaving researched
companies without a queued next step would just recreate the same backlog Phase 4's completion
doc avoided for Phase 5.

**Decision, part 6 — candidate problems and an evidence-count summary are recorded in
`companies.notes`, same convention as ADR-0010 part 7 / ADR-0011 part 4:** No dedicated schema
column exists for `candidateProblems` (AGENT_CONTRACTS.md §3 calls it "raw material for the
Opportunity Analysis Agent," which is free text, not a modeled entity). Appended as new lines
rather than adding a column for one phase's-worth of free text, continuing the existing
`companies.notes` audit-trail convention instead of diverging from it.

**Decision, part 7 — `nextEligibleResearchAt` uses a new deterministic 90-day default window
(`src/lib/researchFreshness.ts`), and `sources.freshnessState` uses a new deterministic 30-day
default threshold (`src/lib/sourceFreshness.ts`):** Spec §60 and DATABASE_SCHEMA.md both
explicitly leave these thresholds unspecified ("eventually configurable" / "the exact freshness
thresholds should be configurable or decided during implementation planning"). Same category of
placeholder as ADR-0008/0009's penalty values and timeouts — reasoned starting points, not
empirically tuned, revisit once Phase 14 (re-research eligibility) or real usage says otherwise.
`sourceFreshness.ts`'s `STALE` branch is written and unit-tested but unreachable from the one
live call site today (a source is always `retrievedAt = now` at insert time, so it's always
`FRESH` or `UNAVAILABLE` there) — same "implemented now, forward-looking" pattern as ADR-0011
part 3, for whichever later phase recomputes freshness for an existing row on read.

**Consequences:** Phase 6 (Opportunity Analysis) reads `evidence_items`/`sources` rows this
phase produces and should treat a company with few/no evidence items as a legitimate "insufficient
evidence" input, not an error state. Phase 14 (re-research eligibility, spec §60) is the natural
place to revisit both freshness constants and to actually exercise `sourceFreshness.ts`'s `STALE`
branch by recomputing freshness for existing rows on read.

---

## ADR-0013: Phase 6 (Opportunity Analysis Agent + scoring) judgment calls

**Status:** Accepted (Phase 6).

**Decision, part 1 — the agent supplies score components + penalty reasons; `scoring.ts` alone
computes the final numbers:** AGENT_CONTRACTS.md §4's original draft output had no scoring-related
fields at all, but spec §30's ten components ("evidence strength," "pain severity," etc.) and
§31's penalty reasons are themselves judgment calls requiring the evidence in context — exactly
the kind of reasoning Claude should do, per PLAN.md's "Core engineering philosophy" (Claude for
genuine judgment; arithmetic stays deterministic code). `opportunityAnalysisAgent.ts` therefore
adds `scoreComponents` (the ten integers, each range-checked by Zod) and `penaltyReasons` (an enum
array) to the output contract, and `analyzeHandler.ts` is the only thing that calls
`scoring.ts`'s `scoreOpportunity()` to turn them into `rawScore`/`adjustedScore` — "Claude does not
self-score" (AGENT_CONTRACTS.md's existing language) means the *final* number is never taken from
Claude, not that the underlying judgments can't be. The Zod schema's ranges/enum values are
derived programmatically from `SCORE_COMPONENT_RANGES`/`PENALTY_CATALOG` (`src/lib/scoring.ts`)
rather than hand-duplicated, so the agent's contract structurally cannot drift out of sync with
what the deterministic scorer enforces. As a side benefit of Zod's non-strict-by-default parsing,
even a hallucinated `rawScore`/`adjustedScore` field in the model's raw JSON is silently dropped
during validation — there is no code path where a Claude-supplied final score could reach the
database, even accidentally.

**Decision, part 2 — every completed `ANALYZE` task always forms exactly one opportunity,
regardless of score:** PLAN.md's Phase 6 acceptance criteria describe both the §88 bad-opportunity
fixture and the §89 correct-reasoning fixture as producing *opportunities* (one scoring low, one
scoring moderate/high) — neither is described as producing no record at all. `analyzeHandler.ts`
therefore never declines to form an opportunity; deciding an opportunity is too weak to pursue
further is Phase 7's job (the Skeptical Verifier + the gating threshold, spec §32), which already
has a dedicated `VERIFIER_REJECTED` status for exactly this. This also sidesteps a schema gap:
neither AGENT_CONTRACTS.md's draft nor the current output contract has any "no viable opportunity"
discriminator, and the `companies.lifecycleStatus` enum's `RESEARCHED -> NO_OPPORTUNITY` transition
(built in Phase 1/2, before this agent existed) is consequently never exercised by this phase —
left as a possible future use (e.g. an operator-manual dashboard action in Phase 12, or a later
phase's decision to add a real "no opportunity" agent output) rather than wired to anything now.
A company's `lifecycleStatus` itself is untouched by this handler — it already reached its
terminal `RESEARCHED` value in Phase 5, and forming an opportunity doesn't change it (ADR-0008
part 2: opportunity-stage progress lives on `opportunities.status`, not the company's column).

**Decision, part 3 — a formed opportunity is persisted straight at `VERIFICATION_PENDING`, not
`OPPORTUNITY_IDENTIFIED`, in one write:** Same reasoning and pattern as ADR-0011 part 5
(`prescreenHandler.ts`'s `PRESCREENED -> RESEARCH_PENDING` collapse) — this handler both forms the
opportunity *and* immediately enqueues its `VERIFY` work item in the same call, so there's no
window where a durably-visible `OPPORTUNITY_IDENTIFIED` row matters on its own.
`transitionOpportunityStatus("OPPORTUNITY_IDENTIFIED", "VERIFICATION_PENDING")` is still called
(so an invalid move would still throw), but only the final status is written.

**Decision, part 4 — the agent gets no tools and the `"reasoning"` model tier:** Unlike Discovery/
Pre-Screening/Deep Research, this agent only reasons over evidence Deep Research already gathered
— there is nothing left to fetch or search, so `tools: []` (ADR-0007 requires every call to state
its tools explicitly; there is no implicit default). Spec §52 groups "complex opportunity
reasoning" under the more-capable-model column, same tier choice as Deep Research (ADR-0012 part
4) and for the same reason: this is open-ended judgment (is this friction meaningful? what's a
sensible price?), not narrow classification.

**Decision, part 5 — prices are expressed in whole currency units by the agent, converted to
cents at persist time:** DATABASE_SCHEMA.md's `suggestedPriceMin`/`Max` columns are integer cents,
but asking a language model to reason in cents (spec §29's own ROI example uses whole-euro
figures) invites unit errors. The agent's Zod schema keeps `suggestedPriceMin`/`Max` as plain
nonnegative numbers in whole currency units; `analyzeHandler.ts` multiplies by 100 (rounded) when
inserting into the DB. A `superRefine` on the Zod schema also rejects `suggestedPriceMax <
suggestedPriceMin` as a cheap, deterministic sanity check before persistence.

**Decision, part 6 — `existingAlternatives` and `validationQuestion` columns added to
`opportunities`, and `impactAssumptions`'s stored type corrected to
`{assumption, isKnown}[]`:** AGENT_CONTRACTS.md's draft output already listed both fields (spec
§26 explicitly requires "possible existing alternatives" and a "proposed validation question"),
but Phase 1's schema never added dedicated columns for them, and `impactAssumptions` was typed as
a bare `string[]` — which cannot represent spec §29's core "known vs. assumption" requirement at
all. All three are genuine Phase 1 gaps, not new scope: two new nullable/json columns (migration
`0001_naive_mathemanic.sql`) and a TypeScript-only type correction on an already-JSON column (no
migration needed for that one). Evidence for a company is retroactively linked to its newly formed
opportunity (`evidence_items.opportunityId`, previously null) at analysis time, per
DATABASE_SCHEMA.md's stated dashboard query pattern ("filtered by classification" off of
`opportunityId`).

**Decision, part 7 — spec §59 (fuzzy duplicate-opportunity detection) is out of scope for this
phase:** PLAN.md's Phase 6 "Build" list doesn't mention it, and nothing in the current pipeline can
yet trigger the scenario it guards against (re-analyzing a company that already has a rejected
opportunity for essentially the same problem) — `REFRESH_EVIDENCE`/re-research wiring is Phase 14
scope, and today an `ANALYZE` item is only ever created once per company by `researchHandler.ts`.
Flagged here as a deliberate exclusion, same category as prior phases' forward-looking gaps.

**Consequences:** Phase 7 (Skeptical Verification) reads `opportunity_evaluations` rows this phase
produces and owns the actual `KEEP`/`REJECT` decision + gating threshold (~75/100) that ADR-0008's
penalty values were chosen against. Phase 12's dashboard will need `evidence_items.opportunityId`
(now populated) to render the WHAT WE KNOW/INFER/DON'T KNOW breakdown per spec §85.

---

## ADR-0014: Phase 7 (Skeptical Verification Agent + strong-opportunity gating) judgment calls

**Status:** Accepted (Phase 7).

**Decision, part 1 — the Skeptic Agent's input deliberately omits `confidence`,
`scoreComponents`, and `penaltyReasons`:** AGENT_CONTRACTS.md §5 requires "fresh context" —
access to "the research and proposal" but not "the Opportunity Analysis Agent's own
reasoning/confidence framing" (spec §33). `verifyHandler.ts` enforces this structurally, not by
prompt instruction alone: `SkepticOpportunityInput` (the type the handler actually builds from
the `opportunities` row) has no field for the analysis agent's `confidence`, and the score
components/penalty reasons live only in `opportunity_evaluations`, which the handler reads for
the *gate* but never forwards into the skeptic's prompt. The skeptic returns its own
`adjustedConfidence` independent of anything it was given.

**Decision, part 2 — the gate's "did the skeptic REJECT" check is orthogonal to and independent
of the score/evidence/risk checks, and any one failing reason fails the whole gate:**
`src/lib/opportunityGate.ts`'s `evaluateOpportunityGate` treats spec §32's four listed
requirements ("sufficient evidence score," "sufficient overall score," "acceptable
implementation risk," "skeptical reviewer returns KEEP") as four independent pass/fail checks,
not a weighted composite — a single failure is enough to reject, and all failing reasons are
collected (not just the first) so `companies.notes` and the CLI output can show the complete
picture. This directly enables the §88-fixture requirement ("REJECTed by the skeptic and fails
gating regardless [of score]") — the fixture test in `verifyHandler.test.ts` seeds an
artificially high adjusted score specifically to prove REJECT alone is sufficient to fail, not
merely correlated with a low score.

**Decision, part 3 — the opportunity-lifecycle binary (`VERIFIED`/`VERIFIER_REJECTED`) reuses
`VERIFIER_REJECTED` for every gate failure, not only an explicit skeptic REJECT:**
`opportunities.status`'s enum (built Phase 1) has no third "gate failed for a non-skeptic reason"
value — only `VERIFIED` and `VERIFIER_REJECTED` follow `VERIFICATION_PENDING`. Spec §32 frames
gating as one combined decision ("a prospect should only reach the dashboard as a Strong
Opportunity when it satisfies..."), so a KEEP that still fails on score, evidence floor, or risk
category is treated the same as an explicit REJECT for lifecycle purposes: `VERIFIER_REJECTED`,
with the specific reason(s) recorded in the `opportunity_evaluations.verifier*` columns (the
skeptic's real output) plus a `companies.notes` line listing every gate reason (which can name
score/evidence/risk failures the skeptic itself never flagged). An operator inspecting a
`VERIFIER_REJECTED` opportunity in a later dashboard phase should read the notes line, not assume
the skeptic literally said REJECT.

**Decision, part 4 — risk-category classification (spec §8) is a deterministic keyword/phrase
heuristic (`src/lib/riskCategory.ts`), not a Claude judgment:** PLAN.md's Phase 7 text frames the
gate as combining "risk category" alongside the already-deterministic score/evidence checks, and
its acceptance criteria explicitly ask for "unit tests for the gating function directly
(threshold, risk-category interaction) fully independent of any Claude call" — which requires
risk classification to be deterministic input, not itself a Claude call. Spec §8's own example
(clinic appointment-intake automation is fine; clinic diagnosis automation is not, same
industry) rules out classifying by `companies.industry` alone, so `classifyOpportunityRisk`
matches against the opportunity's `problemCategory`/`problemDescription`/`proposedSolution`/
`implementationStrategy` text instead, using one regex per spec §8 bullet. This is the same
"reasoned heuristic, not real NLP" category as `failureClassification.ts`'s error-text patterns
(ADR-0009 part 4) — expect false positives/negatives and more patterns needed as real
opportunities are classified against it.

Two of the classifier's patterns (`diagnos\w*`/`prescrib\w*`/etc.) needed a same-*sentence*
context requirement (`requiresContext`, checked per-sentence via `splitIntoSentences`, not
merely "appears anywhere in the document") after this phase's live smoke test caught a real
false positive: a "technical SEO diagnostic" audit opportunity was flagged `HIGH_RISK` for
"medical diagnosis" purely because the bare word "diagnostic" matched, with an unrelated mention
of a "patient portal" elsewhere in the same opportunity's evidence text satisfying a
whole-document co-occurrence check that was tried first and rejected as too loose. The fix
requires the diagnos/prescrib word and a medical-context word (patient/medical/clinical/
symptom/etc.) to appear in the *same* rough sentence. The design deliberately stays
conservative/over-inclusive elsewhere (e.g. `PenaltyReason`-style "medical records requests" in
an intake-categorization opportunity still flags `HIGH_RISK` per the "highly sensitive regulated
personal information" pattern, observed live against a real veterinary-clinic opportunity) — a
false positive here only routes the opportunity to require operator review (`allowHighRisk`
opt-in), not a silent, unrecoverable rejection, so erring toward flagging is the safer failure
mode per spec §8's "unless explicitly reviewed by the operator."

**Decision, part 5 — gate configuration (threshold/evidence-floor/high-risk policy) is a function
parameter with a code-constant default, not a `system_config` read:** Same pattern and reasoning
as ADR-0010 part 8 (discovery volume) and ADR-0012 part 7 (freshness windows) — no general
`system_config` accessor layer exists yet, and building one for this phase's three settings alone
is out of scope. `DEFAULT_OPPORTUNITY_GATE_CONFIG` in `src/lib/opportunityGate.ts` sets
`scoreThreshold: 75` (spec §32's stated initial target), `evidenceStrengthFloor: 10` (half of the
`evidenceStrength` component's 0-20 range — a reasoned starting point, not empirically tuned, same
category as ADR-0008/0009's other placeholder constants), and `allowHighRisk: false` (spec §8's
default-exclude policy). `runVerifyTask` accepts an optional `gateConfig` override so a later
phase's config-accessor layer or dashboard control can supply a live value without changing this
handler's signature.

**Decision, part 6 — `BUILD_OFFER` is enqueued on a gate pass, even though the Offer Builder
agent doesn't exist yet:** Same "each handler wires the next stage's queue, regardless of whether
that stage's agent is built yet" pattern as every prior phase (ADR-0012 part 5 for
`RESEARCH -> ANALYZE`, `analyzeHandler.ts` for `ANALYZE -> VERIFY`) — PLAN.md's Phase 7
"explicitly NOT built" scope covers the Offer Builder *agent*, not queue wiring for it.

**Consequences:** Phase 8 (Offer Builder) reads `opportunities` rows with status `VERIFIED` and
their linked `opportunity_evaluations.verifier*` fields, and picks up `BUILD_OFFER` work items
this phase enqueues. `DEFAULT_OPPORTUNITY_GATE_CONFIG`'s three constants and
`riskCategory.ts`'s pattern list remain reasoned starting points — flag in a later phase's
completion doc if real usage suggests they're off, same as ADR-0008/0009/0012's other
placeholders.

---

## ADR-0015: Phase 8 (Offer Builder + pricing) judgment calls

**Status:** Accepted (Phase 8).

**Decision, part 1 — pricing bands are a code-constant `src/lib/pricing.ts` config, not a
`system_config` read, with non-overlapping duration cutoffs chosen to resolve spec §35's
overlapping "approximately X" ranges:** PLAN.md's Phase 8 text says "configurable pricing bands
(§35) in `system_config`," but no general `system_config` accessor layer exists yet — same
category as ADR-0010 part 8 (discovery volume), ADR-0012 part 7 (freshness windows), and
ADR-0014 part 5 (gate config): a reasoned-starting-point-as-a-function-parameter, not a new
`system_config`-backed settings layer built for one phase's numbers alone.
`DEFAULT_PRICE_BANDS` is a plain object every relevant function (`resolvePriceBand`,
`evaluateOfferPricing`, `formatPricingBandGuide`) takes as an optional override parameter, same
shape as `opportunityGate.ts`'s `gateConfig`. Spec §35's duration guidance overlaps in prose
("Micro Fix: approximately several hours," "Small Automation: approximately half a day to one
day") — translated here into non-overlapping cutoffs (MICRO_FIX ≤0.5 days, SMALL_AUTOMATION
≤1 day, WORKFLOW_IMPLEMENTATION ≤3 days, LARGER_IMPLEMENTATION ≤7 days, clamped above that) so
`resolvePriceBand` always returns exactly one band for any duration rather than needing a
tie-breaking rule at read time.

**Decision, part 2 — an out-of-band price is never blocked, but always gets a recorded
justification; the Offer Builder Agent's contract gains a `priceJustification` field not in
AGENT_CONTRACTS.md's original illustrative draft:** PLAN.md's Phase 8 acceptance criteria state
"price falls within the configured band matching the opportunity's estimated duration, **or an
explicit justification is recorded when it doesn't**" — recorded, not rejected. Since only Claude
can meaningfully explain *why* a specific opportunity's price should deviate (unusually broad
scope, unusual delivery risk, premium urgency), `offerBuilderOutputSchema` adds a nullable
`priceJustification` field (same "extend the illustrative contract when the judgment genuinely
belongs to Claude" pattern as ADR-0013 part 1's `scoreComponents`/`penaltyReasons` addition to the
Opportunity Analysis Agent). `offerHandler.ts` computes the band deterministically and only reads
this field when the price actually falls outside it; when the agent left it null anyway, the
handler synthesizes a deterministic fallback note (`fallbackPriceJustification`) rather than
silently persisting an unexplained deviation — the record always exists, whether or not the model
supplied one. There is no dedicated `offers` schema column for this (same convention as
ADR-0010 part 7 / ADR-0011 part 4 / ADR-0012 part 6): the justification is folded into the
existing `companies.notes` audit-trail line for this offer, not a new migration for one phase's
free text.

**Decision, part 3 — the vague-offer lint (spec §34) is a blocklist of known-vague phrases plus a
minimum word-count floor, and a match regenerates the offer exactly once before failing the
task:** Spec §34 gives exactly one bad example ("AI automation services.") and one good example (a
full descriptive sentence) with no further specification of what "vague" means generally.
`src/lib/offerLint.ts`'s `lintOfferScope` combines an exact-phrase blocklist (the bad example plus
close variants naming a technology/category instead of a deliverable) with a
`MIN_SCOPE_WORD_COUNT` (8) floor, since a model could otherwise trivially dodge a fixed phrase
list with an equally vague one-liner the list doesn't happen to contain. `offerHandler.ts` treats
a lint failure as business-logic quality feedback, not a schema-validation failure — it calls
`runOfferBuilderAgent` a second time with the lint's `reason` threaded through a new
`regenerationReason` input (distinct from `runStructuredAgent`'s own internal
schema-validation retry, which stays untouched), mirroring the "one retry" precedent used
everywhere else in this app (AGENT_CONTRACTS.md's cross-cutting rule, `runStructuredAgent.ts`).
A second consecutive lint failure fails the work item via `failureClassification.ts` — no offer is
ever persisted for a scope that never became concrete — rather than looping indefinitely or
silently accepting a vague offer on the second try.

**Decision, part 4 — `BUILD_OFFER`'s handler collapses `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH`
into one write and enqueues `FIND_CONTACT`:** Same pattern as every prior phase's handler
(`prescreenHandler.ts`'s `PRESCREENED -> RESEARCH_PENDING` collapse, ADR-0011 part 5;
`analyzeHandler.ts`'s single-write `VERIFICATION_PENDING` persist, ADR-0013 part 3;
`verifyHandler.ts`'s `BUILD_OFFER` enqueue on gate pass, ADR-0014 part 6) — there's no window
where a durably-visible `OFFER_READY` row matters on its own since this handler both builds the
offer and immediately queues the next stage in the same call. Both transition-table hops are
still validated (an invalid move would still throw `InvalidTransitionError`), but only the final
`CONTACT_RESEARCH` value is written. `FIND_CONTACT` is enqueued unconditionally on a successful
offer, even though Phase 9's Contact Research Agent doesn't exist yet — "each handler wires the
next stage's queue regardless of whether that stage's agent is built" (ADR-0012 part 5,
ADR-0014 part 6).

**Decision, part 5 — no live manual smoke test was run this phase:** PLAN.md's Phase 8 acceptance
criteria list only fixture/unit tests, unlike Phases 0/3/5's explicit "run this against real
companies" requirement. Phase 7's completion doc already recorded that all 8 real
veterinary-clinic opportunities carried through from Phases 3-7 ended up `VERIFIER_REJECTED` (none
passed the gate), so there is no live `VERIFIED` opportunity with a real `PENDING` `BUILD_OFFER`
item to run `scripts/offer.ts` against without first re-running fresh discovery/research through
the whole pipeline for a new company — out of scope for this phase's own acceptance criteria.
`scripts/offer.ts` exists (same shape as `scripts/verify.ts`) and is ready for the next real
`VERIFIED` opportunity, whenever one exists.

**Consequences:** Phase 9 (Contact Research Agent) picks up `FIND_CONTACT` work items this phase
enqueues, for opportunities now sitting at `CONTACT_RESEARCH` with a persisted `offers` row.
`DEFAULT_PRICE_BANDS`' duration cutoffs and `MIN_SCOPE_WORD_COUNT` remain reasoned starting
points, not empirically tuned — flag in a later phase's completion doc if real offers suggest
they're off, same as every earlier phase's placeholder constants.

---

## ADR-0016: Phase 9 (Contact Research Agent) judgment calls

**Status:** Accepted (Phase 9).

**Decision, part 1 — Contact Research uses the `"fast"` model tier, with `WebSearch`+`WebFetch`
tools:** Spec §52 doesn't name contact research explicitly, but groups "simple extraction" under
the lower-cost/faster-model column and "complex opportunity reasoning" under the more-capable
column. Finding a real, verifiable named individual (or, failing that, the correct role to target)
is bounded identity extraction via web tools — the same shape of task as Discovery (find a real
entity, never invent one; spec §14's integrity requirement echoed here for people instead of
companies), not open-ended judgment over already-gathered evidence like Opportunity
Analysis/Skeptical Verification/Offer Builder. `runContactAgent` therefore defaults to
`resolveModelAlias("fast")` (currently `haiku`), same tier as Discovery/Pre-Screening, with both
`WebSearch` (to find the person/profile at all) and `WebFetch` (to confirm what a found page
actually says) — a superset of Pre-Screening's `WebFetch`-only tooling, since there is no single
known page to check the way Pre-Screening already has a homepage URL from Discovery.

**Decision, part 2 — the output schema structurally couples `email` and `emailConfidence`:**
AGENT_CONTRACTS.md §7's illustrative draft left `email`/`emailConfidence` as independently
nullable/enum fields with no stated relationship, but spec §38's four confidence states only make
sense paired with an actual email value — `"UNKNOWN"` describes the absence of one, the other
three describe some property *of* one. `contactOutputSchema`'s `superRefine`
(`src/agents/contactAgent.ts`) rejects `email: null` paired with anything but `"UNKNOWN"`, and
rejects a non-null `email` paired with `"UNKNOWN"` — a cheap, deterministic sanity check before
persistence, same pattern as `opportunityAnalysisAgent.ts`'s `suggestedPriceMax >=
suggestedPriceMin` check (ADR-0013 part 5) and `offerBuilderAgent.ts`'s
zero-vs-null-`recurringPrice` check (ADR-0015, `offerBuilderOutputSchema`).

**Decision, part 3 — when no specific named individual can be found, the agent returns the target
role/title as `name` rather than a "not found" sentinel:** AGENT_CONTRACTS.md §7's `name` field is
a required, non-nullable string, and PLAN.md's Phase 9 acceptance criteria only enumerate the four
*email*-confidence states as scenarios to cover — there is no "no contact found" discriminator
anywhere in the schema. Rather than add one for a case the contract doesn't model, the prompt
(`CONTACT_INTEGRITY_RULES` in `contactAgent.ts`) instructs the agent that failing to find a named
individual is a valid, expected outcome: return the correct role/title (from spec §37's preferred
list, embedded verbatim in the prompt) as both `name` and `role`, explain why in `source`, and set
`email`/`emailConfidence` to `null`/`"UNKNOWN"`. This keeps `contactHandler.ts` simple (it always
persists exactly one `contacts` row on a successful Claude call, never branching on "was a person
found") while staying honest — the row's own low-information content (identical `name`/`role`,
`emailConfidence: "UNKNOWN"`) is itself the signal to a later dashboard that this needs operator
attention, rather than a fabricated name filling the gap.

**Decision, part 4 — spec §38's hard rule ("never represent a guessed email as verified") is
enforced by a new `src/lib/contactDisplay.ts`, not left to a future dashboard's own discipline:**
PLAN.md's Phase 9 acceptance criteria explicitly require this tested "at the data layer, not just
by eyeballing a UI that doesn't exist yet." `toContactDisplay`/`getContactDisplay` compute
`isVerifiedEmail` as literally `emailConfidence === "VERIFIED"` and `isPreferredForInitialOutreach`
(spec §38's softer "should strongly prefer publicly listed or independently verified addresses")
as `PUBLICLY_LISTED || VERIFIED` — pure, no live call site forcing a caller through it yet (same
"implemented now, forward-looking" pattern as `riskCategory.ts` ahead of Phase 7's gate,
ADR-0012 part 7's `sourceFreshness.ts`), except that `contactHandler.ts` already exercises it for
real when composing its outcome, rather than reading `contacts.emailConfidence` inline. Any later
read path (Phase 10's Outreach Writer, the Phase 12 dashboard) should build on this module instead
of re-deriving the same check, so "never show GUESSED as VERIFIED" has exactly one implementation
to get right.

**Decision, part 5 — `FIND_CONTACT`'s handler transitions `CONTACT_RESEARCH -> OUTREACH_READY` in
one write and enqueues `WRITE_OUTREACH`, unconditionally on every successful Claude call:** Same
pattern as every prior phase's handler (`prescreenHandler.ts`'s single-write collapse, ADR-0011
part 5; `offerHandler.ts`'s `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH` collapse + `FIND_CONTACT`
enqueue, ADR-0015 part 4) — deciding an opportunity's contact is too weak to outreach to (e.g. a
persistent `UNKNOWN`/`GUESSED` result) is left to Phase 10 (which can read `emailConfidence`
through `contactDisplay.ts`) or a later dashboard action, not this handler. `WRITE_OUTREACH` is
enqueued even though Phase 10's Outreach Writer doesn't exist yet — "each handler wires the next
stage's queue regardless of whether that stage's agent is built" (ADR-0012 part 5 and every
handler since).

**Decision, part 6 — no live manual smoke test this phase:** Same blocker as Phase 8 (ADR-0015
part 5) — Phase 7's live smoke test left all 8 real veterinary-clinic opportunities
`VERIFIER_REJECTED`, so no opportunity has ever reached `VERIFIED`/`OFFER_READY`/`CONTACT_RESEARCH`
to run `scripts/contact.ts` against without first re-running fresh
discovery/prescreen/research/analyze/verify/offer for a new company, which is out of this phase's
own scope. PLAN.md's Phase 9 acceptance criteria do ask for a manual smoke test "against a few real
gated opportunities from earlier phases" — none exist yet, so this is deferred, same as Phase 8,
rather than manufactured by spending real Claude usage on a fresh pipeline run outside this
phase's stated scope.

**Consequences:** Phase 10 (Outreach Writer) reads `contacts` rows this phase produces — through
`contactDisplay.ts`, not the raw table — and picks up `WRITE_OUTREACH` work items this phase
enqueues. Whichever session first gets a real company through the whole pipeline to a live
`OUTREACH_READY` opportunity should run `npm run contact -- --opportunity <id>` (and, once it
exists, the Phase 10 equivalent) at least once and spot-check the result, same "verify live
behavior once real data exists" pattern flagged since ADR-0015 part 5.

---
