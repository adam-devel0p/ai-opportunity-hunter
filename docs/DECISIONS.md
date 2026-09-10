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
