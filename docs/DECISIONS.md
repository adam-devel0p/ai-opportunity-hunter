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

## ADR-0017: Phase 10 (Outreach Writer) judgment calls

**Status:** Accepted (Phase 10).

**Decision, part 1 — Outreach Writer uses the `"reasoning"` model tier, no tools:** Same
reasoning as Offer Builder (ADR-0015) and Skeptical Verification (ADR-0014): writing a
persuasive-but-honest email from already-gathered opportunity/offer/contact content is judgment
over existing material, not a fetch/search task. `runOutreachAgent` defaults to
`resolveModelAlias("reasoning")` (currently `sonnet`) with `tools: []`.

**Decision, part 2 — spec §39-40's post-generation checks are implemented as three independent
deterministic functions in a new `src/lib/outreachLint.ts`, combined by `lintOutreachDraft`, not
folded into the handler inline:** Same shape as `offerLint.ts` (ADR-0015 part 3) — word count
(60-130 words, spec §39), a banned-phrase blocklist (spec §39's exact examples —
"revolutionary AI solution", "transform your business with cutting-edge AI", "unlock the power of
AI" — plus close variants, and a small set of generic-mass-email openers), and a truthfulness
heuristic (spec §40). Each is independently unit-tested; `lintOutreachDraft` aggregates every
failing reason, not just the first, mirroring `opportunityGate.ts`'s "collect every failing
reason" pattern (ADR-0014 part 2) rather than `offerLint.ts`'s short-circuit-on-first-match, since
a regeneration prompt benefits from seeing all the problems at once, not just one at a time.

**Decision, part 3 — the truthfulness heuristic is a structural approximation, not real
claim-to-evidence tracing:** AGENT_CONTRACTS.md/PLAN.md's Phase 10 section describes the
truthfulness check as tying "confident-sounding phrasing" to FACT-classified evidence, but linking
a *specific* sentence to a *specific* evidence item deterministically (without an LLM judge, which
would defeat the point of a deterministic check) isn't achievable with pattern matching alone.
`checkOutreachTruthfulness` instead implements the coarser, still-meaningful rule PLAN.md's own
"assert structural properties, not exact wording" framing calls for: split the body into
sentences; if any sentence matches a small set of confident-assertion patterns modeled directly on
spec §40's own bad example ("I noticed your team spends hours doing X") with no hedge word in the
same sentence (modeled on spec §40's own good example's "if... is still being done manually, I
think there may be..."), and the opportunity's evidence contains **no FACT-classified item at
all**, the check fails. If even one FACT item exists, unhedged confident phrasing is allowed
through — this doesn't verify that specific confident sentence traces to that specific fact, only
that confident phrasing never appears when the opportunity has zero FACT-strength grounding to
justify any confidence at all. Same category of "keyword/phrase heuristic, not real NLP, expect to
extend patterns as real drafts are checked against it" as `riskCategory.ts` (ADR-0014 part 4).

**Decision, part 4 — the agent signs off with a literal `"[Your name]"` placeholder, not a
configured operator name:** Spec §87's example email signs with a real first name ("Mario"), but
no `system_config`/env-var carries the operator's own name anywhere in the codebase yet, and
inventing one would be exactly the kind of fabricated personalization spec §40 exists to forbid —
just about the sender instead of the recipient. Since spec §41 already requires the operator to
open, review, and possibly edit every draft before it's ever sent, a literal placeholder is the
lowest-risk choice: it costs the operator one edit per email and adds no risk of a wrong or
fabricated name going out. Revisit only if a later phase (most likely the Phase 12 dashboard, or a
`system_config` operator-profile addition) gives the pipeline a real place to read the operator's
name from.

**Decision, part 5 — `WRITE_OUTREACH`'s handler does NOT transition `opportunities.status`, and
enqueues no further work item:** Every prior handler collapsed the opportunity to the next
lifecycle status in one write and enqueued the next stage's work item (ADR-0011 part 5 onward).
This phase breaks that pattern deliberately: `OUTREACH_READY -> SENT` (the only transition
`stateMachine.ts` allows from here) means the operator actually sent the email (spec §41/§45 — a
manual action), which generating a draft has not done. Persisting an `outreach_drafts` row at
`status: "DRAFT"` and leaving `opportunities.status` at `OUTREACH_READY` keeps the state machine
honest: nothing in this codebase should ever claim `SENT` on the pipeline's own initiative.
Recording an actual send (and moving to `SENT`) is Phase 12 (dashboard action) / Phase 13
(outcome event) territory, not this handler's job.

**Decision, part 6 — contacts are looked up by company (most recent row), not by a direct
opportunity link:** `contacts` has no `opportunityId` column (spec §37-38's schema keys it by
`companyId` only, since one company can in principle have multiple contacts over time). This
handler orders by `contacts.createdAt` descending and takes the first row — safe because
`contactHandler.ts` (Phase 9) only ever inserts one contact per `FIND_CONTACT` task, immediately
before enqueueing this task's `WRITE_OUTREACH` item, so the most recent contact row for the
opportunity's company is always the one Phase 9 just found for this exact opportunity. Documented
here rather than added as a schema FK because retrofitting one is out of this phase's scope and
the current single-opportunity-in-flight-per-company reality makes it unambiguous in practice.

**Decision, part 7 — no live manual smoke test this phase:** Same blocker as Phases 8-9 (ADR-0015
part 5, ADR-0016 part 6) — confirmed again for this phase: querying the live `data/aoh.db` shows
all 8 real veterinary-clinic opportunities carried through from Phases 3-7 are still
`VERIFIER_REJECTED`; no `offers` or `contacts` row has ever existed. There is no live
`OUTREACH_READY` opportunity with a real `PENDING` `WRITE_OUTREACH` item to run
`scripts/outreach.ts` against, and PLAN.md's Phase 10 acceptance criteria's "operator reads 3-5
generated drafts against real opportunities from earlier phases" cannot be honestly satisfied
without either fabricating fixture data as if it were real, or spending real Claude usage on a
fresh discovery-through-offer/contact run, which is outside this phase's stated scope. Fixture
tests (`outreachAgent.test.ts`, `outreachLint.test.ts`, `outreachHandler.test.ts`) cover the
acceptance criteria's structural checks instead, same as Phase 8/9.

**Consequences:** Phase 11 (the worker loop) is what will actually drive `WRITE_OUTREACH` items
end-to-end autonomously; Phase 12 (dashboard) is where an operator will actually read/edit/mark a
draft sent, which is also where `opportunities.status -> SENT` and the outcome-tracking spec §45
actions belong. Whichever session first gets a real company through the whole pipeline to a live
`OUTREACH_READY` opportunity should run `npm run outreach -- --opportunity <id>` and read the
draft against spec §87's stated qualities (specific, truthful, short, human, low pressure,
problem-focused, not AI-hype) before trusting this phase's prompt/lint design the way Phase 5's
live evidence-quality check validated Deep Research — same "verify live behavior once real data
exists" pattern flagged since ADR-0015 part 5.

---

## ADR-0018: Phase 11 (Autonomous scheduler/worker) judgment calls

**Status:** Accepted (Phase 11).

**Decision, part 1 — `DEFERRED` is reused, unchanged, as the worker-level "quota exhausted"
signal; no new field is added to any handler's outcome type:** Every handler since Phase 3
already transitions its work item to `DEFERRED` for exactly one reason — a `quota_exhausted`
result from `claudeClient` (ADR-0010 part 5, reused verbatim in every later phase's ADR) — and
never for anything else. `src/worker.ts`'s `runWorkerCycle` relies on this existing convention
directly (`quotaExhausted: outcome.workItemStatus === "DEFERRED"`) rather than asking all eight
handlers to also return an explicit `quotaExhausted` boolean. This is a deliberate reuse of an
established invariant, not a coincidence — if a future phase ever introduces a handler that sets
`DEFERRED` for a different reason, this detection breaks silently, so that invariant is now
load-bearing and should be called out in that phase's own ADR if it changes.

**Decision, part 2 — quota backoff lives in the worker process's own in-memory state, not on the
`work_item` row:** ADR-0010 part 5 deliberately left a `DEFERRED` item's `runAfter` null, "since
no scheduler exists yet to interpret it — Phase 11's worker loop owns deciding when a
quota-deferred item should actually resume." `runWorker` owns this now: a consecutive-exhaustion
counter (reset by any non-quota-exhausted cycle) drives an exponential backoff
(`DEFAULT_QUOTA_BACKOFF_BASE_MS` = 30 min, doubling, capped at `DEFAULT_QUOTA_BACKOFF_MAX_MS` =
4h — spec §51's "start at e.g. 30 min, capped"), and the loop simply doesn't run another cycle
until that backoff elapses. The `DEFERRED` item itself stays immediately "eligible" by
`priority.ts`'s own rules the whole time; what actually prevents hammering Claude is that nothing
calls `runWorkerCycle` again until the sleep resolves. This keeps the per-item state machine and
`isEligibleNow` untouched from Phase 2 and puts the actual scheduling policy where PLAN.md §12
always said it belonged — the worker loop, not the queue.

**Decision, part 3 — every handler dispatch is wrapped in try/catch inside `runWorkerCycle`, not
inside each handler:** PLAN.md's architecture section 8 states "each task handler is wrapped so
one failure never takes down the loop (§66)," but no prior phase had a real loop to do the
wrapping — each handler already returns a typed failure outcome for a `claudeClient`-reported
failure, but several (e.g. `discoverHandler.ts` on an unknown campaign id) still `throw` a plain
`Error` for a referential-integrity problem, which would otherwise crash an actual long-running
process. `runWorkerCycle` catches any such throw and routes it through the exact same
`resolveFailureOutcome` classification (attempts/backoff/RETRYABLE-vs-FAILED) a handler-reported
failure gets, persisting the same shape of `work_items` update either way. This is the first
phase where that PLAN.md sentence is literally true rather than aspirational.

**Decision, part 4 — a minimal `src/lib/config.ts` is added now, scoped to exactly the two keys
this phase needs, not a general `system_config` settings layer:** Same "reasoned starting point,
not the general accessor DATABASE_SCHEMA.md eventually wants" posture as ADR-0010 part 8/ADR-0012
part 7/ADR-0014 part 5/ADR-0015 part 1 — but unlike those, PLAN.md's Phase 11 acceptance criteria
explicitly require "`system_config`-driven pause/resume checked every cycle," so this phase does
add the smallest accessor that satisfies it: `getAutonomousMode`/`setAutonomousMode` (spec §71)
and `getCampaignSelectionState`/`setCampaignSelectionState` (the SWRR round-robin weights,
persisted so campaign diversity holds across worker restarts, not just within one process's
lifetime — the forward pointer left in ADR-0010 part 2). Every other `system_config` key
DATABASE_SCHEMA.md lists (score threshold, pricing bands, country/industry allowlists, ...)
remains unwritten; Phase 14 owns the general config UI.

**Decision, part 5 — autonomous mode defaults to `false` (paused) when the `system_config` row
doesn't exist yet:** A fresh checkout/fresh DB must never start spending Claude usage
autonomously without the operator explicitly opting in — same "never the default" posture
ADR-0001 takes toward paid API fallback. The operator must run
`npm run autonomous -- --enable` at least once before the worker does anything beyond log
`paused` every idle cycle.

**Decision, part 6 — the worker itself creates `DISCOVER` work items (spec §16), capped at one
in flight at a time, since nothing upstream of Discovery ever enqueues it automatically:** Every
other task type is created by the handler that finishes the stage before it (`discoverHandler.ts`
enqueues `PRESCREEN`, `prescreenHandler.ts` enqueues `RESEARCH`, and so on) — Discovery has no
upstream stage, so without new wiring the queue would run dry the moment the operator's earlier
manual `scripts/discover.ts` runs finished. `ensureDiscoveryWork` (called at the top of every
cycle, before selecting the next item, and skipped while paused) checks for any `DISCOVER` item
not already in a terminal status and, if none exists, picks the next campaign via the Phase 3
`selectNextCampaign` SWRR algorithm and enqueues one. Capped at one in flight rather than keeping
several queued: spec §49 already ranks `DISCOVER` lowest of all nine task types, so piling up
several would only ever matter once the queue is otherwise completely empty anyway, and one
in-flight item is simpler to reason about than a target queue depth.

**Decision, part 7 — `RunResearchTaskOptions`'s required `dbPath` is threaded through the generic
`TaskHandler` type as a fourth parameter every handler receives but only `RESEARCH`'s wrapper
uses:** `researchHandler.ts` (Phase 5) needs the live DB file path so the ADR-0004 hook subprocess
can open its own connection — the one handler whose options shape doesn't exactly match the other
seven's `{db, workItem, now}`. Rather than special-casing `RESEARCH` in the dispatch logic (an
`if (taskType === "RESEARCH")` branch bypassing the shared `TaskHandler` map), `TaskHandler`'s
type signature gains a `dbPath: string` fourth parameter that every entry in `TASK_HANDLERS`
structurally satisfies (TypeScript permits a function with fewer declared parameters to satisfy a
wider function type — the other seven handlers' closures simply don't mention it), keeping the
dispatch itself uniform.

**Decision, part 8 — `REFRESH_EVIDENCE` items fail deterministically rather than crashing the
loop, since no handler exists yet and nothing currently creates one:** `work_items.taskType`'s
enum includes `REFRESH_EVIDENCE` since Phase 1, but it's explicitly Phase 14 scope (spec §60
re-research) and no code path anywhere creates one — `TASK_HANDLERS` needs an exhaustive entry
for TypeScript's `Record<TaskType, TaskHandler>` regardless, so this branch should be unreachable
in live operation. It transitions the item straight to `FAILED` with a clear `lastError` instead
of throwing, consistent with part 3's "one failure never takes down the loop" — if this ever does
fire, it's a visible, debuggable signal that something upstream started creating
`REFRESH_EVIDENCE` items before Phase 14 built the handler for them, not a process crash.

**Decision, part 9 — no live multi-hour autonomous run was performed this phase; a zero-cost
paused-mode smoke test was run instead against the real project DB:** PLAN.md's Phase 11
acceptance criteria ask for "operator starts the worker for a real multi-hour stretch" — genuinely
running autonomous mode for hours would spend real Claude subscription usage against the
project's actual campaigns/companies without the operator having asked for that run in this
session, so it's left for the operator to do deliberately (documented here as an open item, same
category as Phases 8-10's deferred live smoke tests). What *was* verified live: `npm run worker`
against the real `./data/aoh.db` starts, correctly reports `paused` every idle cycle (autonomous
mode is off by default per part 5), and shuts down cleanly on `SIGINT` — proving the process
wiring itself works end-to-end without spending any usage. The integration tests in
`src/worker.test.ts` (mocked `claudeClient`, real handlers, real temp DB) cover the acceptance
criteria's quota-exhaustion-backoff-then-resume and crash-recovery-then-continue scenarios that
don't require spending real Claude usage to verify.

**Decision, part 10 — an example `launchd` plist is provided as a `.example` file the operator
must copy and edit, not auto-installed:** `launchd/com.aiopportunityhunter.worker.plist.example`
has placeholder absolute paths (`/ABSOLUTE/PATH/TO/...`) the operator must fill in for their own
machine — a plist with real paths hardcoded for this development machine would be actively wrong
on the operator's own setup, and installing/loading a `launchd` job is itself the kind of
persistent, machine-wide side effect this project's own safety posture says should be a
deliberate operator action, not something a phase's code does automatically.

---

## ADR-0019: Phase 12 (Dashboard MVP) judgment calls

**Status:** Accepted (Phase 12).

**Decision, part 1 — the tsconfig is split in two, and both `next dev`/`next build` are pinned to
webpack via `--webpack`, not Turbopack:** `tsconfig.backend.json` (renamed from the pre-Phase-12
`tsconfig.json`, `include` narrowed to exclude `src/app`) keeps every earlier phase's
`moduleResolution: "NodeNext"` setup — which *requires* relative imports to spell the literal
`.js` extension of their emitted file (e.g. `from "../db/schema.js"` for a `.ts` source), a
convention all ~100 existing backend files already follow and this phase does not touch. A new
root `tsconfig.json`, owned by Next (it auto-edits fields like `jsx` on every run), covers
`src/app` with `moduleResolution: "bundler"`. The two can't be merged: Next's own bundler doesn't
resolve a `.js`-suffixed specifier to a `.ts` file by default, so `src/app`'s server
components/actions — which necessarily import shared modules like `src/lib/dashboardQueries.ts`
that themselves import `../db/schema.js` — failed to build under Next's default bundler
(confirmed empirically: `next build` with Turbopack, the Next 16 default, fails with "Module not
found" on every such import). `experimental.extensionAlias` (`next.config.ts`) fixes this, but
only for webpack — Turbopack doesn't read it as of Next 16.3.4 — so `dev`/`build`/`build:dashboard`
all pass `--webpack` explicitly rather than relying on whatever the default happens to be. This is
the smaller, safer change versus the alternative (dropping `.js` extensions repo-wide and
switching backend module resolution away from NodeNext, which `tsx`/plain `node dist/worker.js`
both still need for their own ESM resolution) — revisit if Turbopack later grows equivalent
extension-alias support and the `--webpack` pin can be dropped.

**Decision, part 2 — `eslint-plugin-react` is skipped; only `eslint-plugin-react-hooks` is
added, scoped to `src/app/**`:** `eslint-plugin-react`'s latest release (7.37.5) declares a peer
range of `eslint@^3 || ... || ^9.7`, not covering the `eslint@^10.10.0` this repo already pinned
before Phase 12 — installing it produces an `ERESOLVE` conflict. `eslint-plugin-react-hooks`
already supports `^10.0.0`. Given the dashboard is mostly server components (no client-side state,
no custom hooks beyond what a handful of `"use client"` islands might someday need), the rules
`eslint-plugin-react` would add on top (`jsx-uses-vars`, prop-types, etc.) matter far less than
`rules-of-hooks`/`exhaustive-deps` — and React 19's automatic JSX runtime means there's no `import
React` for `jsx-uses-vars`-style rules to even need. Revisit once `eslint-plugin-react` publishes
a release with a wider peer range.

**Decision, part 3 — `opportunities` gains a new `operatorVerdict` column
(`PENDING | APPROVED | REJECTED`, default `PENDING`), separate from `status`:** Spec §45's
"Approve / Good Opportunity" and "Reject / Bad Opportunity" are the *operator's* verdict, which
spec §92 explicitly says should eventually override "Claude's subjective opinion about opportunity
quality" — conflating it with `opportunities.status` (which tracks the *pipeline's* own automatic
progression: `VERIFIED`/`VERIFIER_REJECTED` reflect what the Skeptical Verification Agent decided,
not what the operator decided) would make it impossible to represent an operator overriding a
`VERIFIED` opportunity as not worth pursuing, or approving one despite `VERIFIER_REJECTED`.
`rejectionReason` (spec §46) already existed as an unused column reserved for exactly this
dashboard phase; only `operatorVerdict` needed adding. `getSummaryMetrics`'s "opportunities
rejected" count is `status === "VERIFIER_REJECTED" OR operatorVerdict === "REJECTED"` (either kind
of rejection counts), while "strong opportunities" counts pipeline `status` alone (gate-passing is
a pipeline fact, independent of the operator's own read on it).

**Decision, part 4 — run history / the activity feed (spec §69) is derived from `work_items` at
read time, not a new event-log table:** Adding a dedicated append-only events table would require
every one of the eight existing pipeline handlers to also write to it — a whole-codebase change
for a feature this phase can satisfy by reading data those handlers *already* persist.
`src/lib/activity.ts`'s `getRecentActivity` queries completed/failed/deferred `work_items` rows
(already timestamped by every handler) and, per task type, joins the entity `entityId` points at
(company for `PRESCREEN`/`RESEARCH`/`ANALYZE`, opportunity for
`VERIFY`/`BUILD_OFFER`/`FIND_CONTACT`/`WRITE_OUTREACH`, per DATABASE_SCHEMA.md's existing
convention) to build a human-readable line. `DISCOVER` is the one type expanded into multiple feed
entries (one per company whose `firstDiscoveredAt` falls inside that specific work item's
start/completion window) to match spec §69's own example, which shows one line per discovered
company rather than one line per campaign run. The tradeoff: this reports each stage's *current*
state (e.g. a `PRESCREEN` entry shows the company's current `lifecycleStatus`), not a frozen
historical snapshot — acceptable today because nothing yet re-runs an earlier stage for a company
that has moved past it (same assumption ADR-0013 part 7 already documents for `ANALYZE`). Revisit
if `REFRESH_EVIDENCE` (Phase 14) or spec §59's opportunity-dedup ever makes that assumption false.

**Decision, part 5 — manual research entry (spec §72) skips discovery/pre-screening and inserts
the company directly at `RESEARCH_PENDING`, and refuses to re-enqueue `RESEARCH` for a company
already past that stage:** The operator naming a company directly is itself the vetting step
discovery+pre-screening exist to approximate cheaply (spec §13), so repeating them would only
spend extra Claude usage for no benefit — same reasoning `discoverHandler.ts` already uses to
insert new companies straight at `PRESCREEN_PENDING` rather than `DISCOVERED`. For a domain that
already exists, `requestManualResearch` deliberately does *not* force a company already past
`RESEARCH_PENDING` back through `RESEARCH` — `researchHandler.ts` assumes (and
`stateMachine.transitionCompanyLifecycle` enforces) that a `RESEARCH` item's target company is at
`RESEARCH_PENDING`; re-enqueueing for e.g. a `RESEARCHED` company would just fail the task on an
invalid transition. Re-research is spec §60/`REFRESH_EVIDENCE` territory, explicitly Phase 14
scope (ADR-0018 part 8) — this action reports the company's current state (`"already-progressed"`)
instead, so the operator can go look at its existing opportunity rather than silently no-op'ing or
crashing a work item.

**Decision, part 6 — spec §85's six trust labels are populated from existing fields, not a new
agent output:** No agent from Phases 6-10 was asked for text specifically labeled "why Claude
likes this" or "what to verify before contacting them" — adding that now would mean re-prompting
every agent, out of scope for a phase PLAN.md scopes as UI-only. Instead: WHY CLAUDE LIKES THIS
shows `economicImpact`/`problemDescription` plus the top-3 highest-scoring
`opportunity_evaluations` components; WHY THE SKEPTIC MIGHT REJECT IT shows
`verifierDealkillers`/`verifierWeaknesses`; WHAT WE KNOW/INFER/DON'T KNOW map onto the existing
evidence classifications (`FACT`; `INFERENCE` ∪ `HYPOTHESIS`, since both are non-fact reasoning
from the operator's trust perspective even though the evidence list itself keeps them visually
distinct per spec §44; `UNKNOWN`); WHAT TO VERIFY combines `validationQuestion` with
`verifierMissingInfo` (both are, definitionally, things nobody has confirmed yet). All of this
already existed on the `opportunities`/`opportunity_evaluations` rows — this decision is purely
about which existing field answers which trust question, not new persistence.

**Decision, part 7 — "Sent Manually" and outcome-event recording are two separate write paths,
and `SENT` can only ever be written by the former:** `markSentManually` is the one function that
transitions `opportunities.status` (`OUTREACH_READY -> SENT`, the real spec §41/§90 transition)
*and* inserts the `SENT` `outreach_outcomes` event, atomically from the caller's perspective —
because a `SENT` event without the matching status transition (or vice versa) would leave the two
tables disagreeing about whether the opportunity was actually sent. `recordOutreachOutcome`'s
event type (`RecordableOutreachEvent`) is `outreach_outcomes.event` minus `"SENT"` specifically to
make that split enforceable at the type level, not just by convention.

**Decision, part 8 — filtering (spec §73) is scoped to what PLAN.md's Phase 12 explicitly lists
as in-scope, not the full eventual filter set:** PLAN.md's Phase 12 section says "filtering/search
polish beyond basics" is explicitly deferred. `listOpportunities`/`listCompanies` support
status/verifier-result/min-score/industry/country/search and lifecycle-status/search respectively
— plain GET-query-param forms needing no client JS. Campaign/date-range/reply-status filtering
(also listed in spec §73) and any client-side polish (auto-submit on change, saved filter presets)
are left for a later pass.

**Decision, part 9 — Playwright's fixture DB is seeded with direct inserts
(`scripts/seedE2eFixture.ts`), never by invoking the real `claude` CLI:** Same reasoning as every
earlier phase's fixture-based agent tests (PLAN.md §13) — these tests exercise the dashboard UI
(can the operator view evidence, click Approve, toggle autonomous mode, submit the manual-research
form) rather than agent judgment quality, so there is nothing to gain and real subscription usage
to lose by running the actual pipeline. The seed script inserts one full-pipeline scenario
(company through an `OUTREACH_READY` opportunity with a `DRAFT` outreach draft) directly via
Drizzle, mirroring the fixture-building style every `src/pipeline/*.test.ts` file already uses.
Tests run `test.describe.serial` against one shared seeded DB (`playwright.config.ts`'s
`webServer` re-seeds a fresh file on every `npm run test:e2e` invocation) rather than isolating
each test's own DB, since Playwright's `webServer` starts exactly one `next dev` process per run —
later tests are written to tolerate (and in one case, deliberately undo) earlier tests' mutations
to the same seeded opportunity.

**Decision, part 10 — no dashboard control was added for spec §8's high-risk gate override or
`system_config`'s general key set (score threshold, pricing bands, country/industry allowlists,
...):** ARCHITECTURE.md flagged the per-opportunity `allowHighRisk` override as "a later phase (the
Phase 12 dashboard, most likely)" territory, but PLAN.md's actual Phase 12 "Build" list only
specifies "autonomous mode + pause/resume toggle... writing to `system_config`" — a general config
UI is explicitly named as Phase 14 scope ("a config UI beyond autonomous on/off"). Adding either
now would be scope creep beyond what this phase's acceptance criteria ask for; both remain open
items.

**Consequences:** Phase 12 (dashboard) is where autonomous mode's pause/resume gets a real
toggle UI (spec §71) instead of `scripts/autonomous.ts`, and where `src/lib/config.ts` most likely
grows into the general settings accessor DATABASE_SCHEMA.md describes. The operator should run a
real multi-hour `npm run worker` session (with autonomous mode enabled) at least once and inspect
`work_items`/`companies.notes`/logs afterward, per part 9 above, before fully trusting this
phase's scheduling/backoff design against real usage patterns.

---

## ADR-0020: Phase 13 (Feedback loop & outcome analytics) judgment calls

**Status:** Accepted (Phase 13).

**Decision, part 1 — no new tables or columns; analytics are computed entirely from existing
`outreach_outcomes`/`outreach_drafts`/`opportunities`/`companies`/`offers`/`discovery_campaigns`
rows:** Phase 12 (ADR-0019) already built the full outcome-recording write path
(`dashboardActions.recordOutreachOutcome`/`markSentManually`) and the `outreach_outcomes` table
spec §47 needs for outcome *history* (append-only events, not a single current-status column).
Phase 13's job is purely the read side — aggregating what's already persisted — so no migration
was needed this phase, unlike most earlier phases.

**Decision, part 2 — "sent" is defined as "this draft has a `SENT` outreach_outcomes event", not
"`outreach_drafts.status === 'SENT_MANUALLY'`":** The two are written atomically together by
`markSentManually` and are equivalent in practice today, but the event is the more semantically
direct denominator for every rate (`REPLIED`/`INTERESTED`/`MEETING`/`WON` are all events on the
same table) — reading one source of truth for "was this actually sent" avoids a future drift bug
if `outreach_drafts.status` ever gains a value that doesn't imply a `SENT` event (or vice versa).

**Decision, part 3 — every rate is `{numerator, denominator, rate, reliable}`, never a bare
percentage, and every average is `{average, sampleSize, reliable}`:** Spec §74's explicit
"avoid misleading metrics when sample sizes are tiny" requirement means a component that only
gets the final percentage can't apply that guard itself. `DEFAULT_MIN_SAMPLE_SIZE = 5` (a
code-constant default, same "config as an optional parameter" pattern as `opportunityGate.ts`/
`pricing.ts`) is a judgment call, not from the spec — small enough that a genuinely useful
signal isn't hidden for long, large enough that a 1-of-1 or 2-of-3 rate is never presented as
reliable. The dashboard renders a "low sample" badge next to any rate below the threshold rather
than hiding the number outright — spec §74 says "avoid misleading", not "hide small-sample data",
and an operator with only 3 outreach attempts still benefits from seeing the raw numbers as long
as they're clearly hedged.

**Decision, part 4 — "performance by X" (industry/country/problem category/campaign/price band)
is one parameterized function (`getPerformanceByDimension(db, dimension)`) over a shared
per-sent-draft record, not five separate queries:** All five breakdowns in spec §47/§74 are the
same shape (group sent outreach by one field, compute the same five stats per group) — a single
`SentOutreachRecord` gathered once per call and grouped by whichever dimension the caller asks
for keeps the five metric definitions from drifting relative to each other, at the cost of always
computing all five DB reads even when only one dimension is requested (acceptable at this app's
scale, same tradeoff `dashboardQueries.ts` already made). Missing/null dimension values fall back
to a stable label (`"Unknown"`, or `"Manual / no campaign"` for campaign specifically, since a
manually-entered company via spec §72 has no `sourceCampaignId` by design) rather than being
dropped from the breakdown — an operator should be able to see "how many of my sent emails have
no industry recorded" as its own row, not have it silently vanish.

**Decision, part 5 — `averageOpportunityScore` (spec §74's "average opportunity score") is
computed over every scored opportunity, not just ones with outreach sent, while
`scoreVsResponse` is computed only over sent ones:** These answer different questions — the
former is a pipeline-quality signal (are the opportunities Phase 6 is generating any good at
all?), the latter is specifically "do higher-scored opportunities get replies more often?", which
is only measurable for opportunities that actually reached outreach. Conflating them would make
the first number meaningless once real usage produces far more scored opportunities than sent
outreach (the expected steady state, per every earlier phase's funnel).

**Decision, part 6 — analytics live at a new `/analytics` dashboard route (plain server
component, five stacked tables + a metrics-grid header), not a client-side tabbed view:** Spec
§74 lists the same "show simple metrics" framing Phase 12's summary tiles already use, and this
is a single-operator local app with a handful of dimension values at realistic scale — a
client-side tab/filter UI would add `"use client"` state management for a problem stacked
sections solve for free. Revisit only if a later phase's real usage shows the page has grown
unwieldy to scroll.

**Consequences:** Spec §75 (autonomous strategy improvement — Claude periodically reviewing this
same data and recommending discovery-allocation changes) and §76 (recurring-pattern detection
across companies) remain explicitly out of scope, per PLAN.md's "Deferred beyond these phases"
list — this phase only produces the statistics a human or a future Claude pass would consume, it
does not consume them itself. No live real-world outreach data exists yet (every opportunity
produced by Phases 3-11's live smoke tests was `VERIFIER_REJECTED`, same blocker ADR-0015/16/17
already documented), so `/analytics` has only ever been exercised against seeded fixture data
this phase; a real read of it is still pending the first real `SENT` outreach draft.

---
