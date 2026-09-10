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
