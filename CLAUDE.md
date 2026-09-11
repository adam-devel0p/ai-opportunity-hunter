# AI Opportunity Hunter — orientation for Claude Code sessions

Read this file first. It exists so a brand-new Claude Code session, with no memory of prior
sessions, can pick up exactly where the last one left off.

## What this project is

A local-first, single-user system that autonomously discovers real small/medium businesses,
researches them, finds evidence-backed problems they plausibly have, and turns the strongest
findings into concrete, human-reviewed sales opportunities (research → offer → contact →
draft email). The operator reviews everything and sends outreach manually. Full product
requirements: [idea-requirements.md](idea-requirements.md) (source spec, do not edit).

## Where to look, in order

1. **[docs/PHASES.md](docs/PHASES.md)** — which phase is done, which is next, current status.
   Always check this first.
2. **[PLAN.md](PLAN.md)** — the full implementation plan: architecture, phase breakdown,
   acceptance criteria per phase, what's explicitly out of scope for each phase.
3. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — current state of the actual codebase
   (updated at the end of every phase). This reflects what's *built*, not what's *planned*.
4. **[docs/DECISIONS.md](docs/DECISIONS.md)** — append-only log of non-obvious technical
   decisions and why they were made. Check before re-litigating something already decided.
5. **[docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)** — schema reference, kept in sync
   with `src/db/schema.ts` once Phase 1 exists.
6. **[docs/AGENT_CONTRACTS.md](docs/AGENT_CONTRACTS.md)** — the structured input/output
   contract for every Claude-invoking agent.
7. **[docs/phases/](docs/phases/)** — one file per completed phase, written by the session
   that implemented it, documenting exactly what was built, how it was tested, and any
   deviations from the plan. Use `docs/phases/TEMPLATE.md` as the format.

## Working rules for every phase

- Implement **one phase only**, per [PLAN.md](PLAN.md). Do not start the next phase's scope
  even if it seems convenient.
- Leave the repo in a working, fully tested state at the end of the phase: `npm run build`,
  `npm run lint`, `npm test` must all pass.
- Write both unit tests (deterministic logic) and the fixture/integration tests called for in
  the phase's acceptance criteria (agent behavior against representative scenarios).
- Do **not** `git push` — the operator handles that. Local commits are fine if the operator
  has initialized git; otherwise just leave the working tree in a good state.
- At the end of the phase: write `docs/phases/phase-N-<slug>.md`, update
  `docs/PHASES.md` (mark the phase done, name the next one), and update
  `docs/ARCHITECTURE.md` to reflect what now actually exists.
- Never make `ANTHROPIC_API_KEY`-based pay-as-you-go billing reachable without an explicit,
  separate operator opt-in flag. This is a hard constraint — see
  [docs/DECISIONS.md](docs/DECISIONS.md) ADR-0001.
- Claude is used only where judgment is genuinely required (research, inference, drafting).
  State transitions, deduplication, scoring arithmetic, scheduling, and validation are
  ordinary deterministic TypeScript. See PLAN.md "Core engineering philosophy."

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
