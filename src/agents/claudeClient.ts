/**
 * The only place in this codebase that spawns the `claude` CLI (ADR-0001).
 *
 * Billing safety is structural, not a warning: `buildSanitizedEnv` always strips
 * `ANTHROPIC_API_KEY` from the child process environment, regardless of what the parent
 * shell has set, so every Claude call this app makes bills to the operator's own
 * subscription via their `claude login` OAuth session, never to pay-as-you-go API credits.
 *
 * Tool restriction requires BOTH `--tools` (defines which tools exist at all for this call)
 * and `--allowedTools` (pre-approves them so a non-interactive session doesn't just get an
 * auto-denial with no one to answer the prompt). This was confirmed empirically during the
 * Phase 0 spike: `--tools` alone still denies at the permission-approval step, and denial
 * makes the model quietly answer from training-data recall dressed up as fact instead of
 * reporting the tool as unavailable — exactly the fabrication failure mode spec §24 forbids.
 * `--permission-prompts none` is a defense-in-depth backstop so anything unexpected is
 * auto-denied rather than hanging waiting for a human who isn't there.
 */

import { spawn } from "node:child_process";

const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";

const QUOTA_EXHAUSTION_PATTERNS: RegExp[] = [
  /you'?ve hit your session limit/i,
  /you'?ve hit your weekly limit/i,
  /usage limit reached/i,
  /rate_limit_error/i,
  /\b429\b/,
];

export interface ClaudeInvocationOptions {
  /** The user prompt sent to `claude -p`. */
  prompt: string;
  /** A `--model` alias, e.g. "sonnet", "opus", "haiku" — see src/config/models.ts. */
  model: string;
  /**
   * Exact set of tools this call may use, e.g. ["WebSearch", "WebFetch"]. Pass an empty
   * array for calls that need no tools at all (most agents past the research stage).
   * There is no "use the CLI's defaults" option — every call states its tools explicitly.
   */
  tools: string[];
  cwd?: string;
  /**
   * Optional JSON Schema passed as `--json-schema`, confirmed during the Phase 0 spike to
   * constrain the CLI's `result` field to schema-conformant JSON (no markdown fences, no
   * prose commentary) even for tool-using calls. This is a first line of defense, not a
   * replacement for validating the parsed result against the calling agent's Zod schema
   * (per docs/AGENT_CONTRACTS.md) — a schema-shaped-but-wrong value can still pass it.
   */
  jsonSchema?: Record<string, unknown>;
  /** Kills the subprocess and resolves with status "error" if exceeded. */
  timeoutMs?: number;
  /**
   * Extra settings merged via `--settings <json>` (e.g. the ADR-0004 PostToolUse hook
   * registration used by the Deep Research Agent, Phase 5). Absent by default — most agents
   * need no settings beyond the explicit `--tools`/`--allowedTools` restriction.
   */
  settings?: Record<string, unknown>;
  /**
   * Extra env vars merged into the sanitized child env, on top of `buildSanitizedEnv()`'s
   * clone of `process.env` — e.g. context (DB path, task id) a `--settings`-registered hook
   * subprocess needs, since a hook runs as its own OS process and can't share in-memory state
   * with this one. `ANTHROPIC_API_KEY` is still always stripped even if present here.
   */
  extraEnv?: NodeJS.ProcessEnv;
  /** Escape hatch for flags not otherwise modeled here. */
  extraArgs?: string[];
  /** Override the binary name/path — used by tests. */
  claudeBin?: string;
}

export type ClaudeInvocationResult =
  | {
      status: "success";
      resultText: string;
      raw: Record<string, unknown>;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { status: "quota_exhausted"; message: string }
  | { status: "invalid_json"; message: string; stdout: string }
  | { status: "error"; message: string; stderr: string; exitCode: number | null };

/**
 * Returns a copy of `parentEnv` with `ANTHROPIC_API_KEY` removed. Never mutates its input.
 */
export function buildSanitizedEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...parentEnv };
  delete sanitized[ANTHROPIC_API_KEY_VAR];
  return sanitized;
}

/**
 * Loudly warns (once per call site) if the *parent* environment has ANTHROPIC_API_KEY set.
 * This app never forwards it, but its mere presence is a latent foot-gun for any other tool
 * run from the same shell — see ADR-0001 and anthropics/claude-code#37686.
 */
export function warnIfApiKeyPresent(
  parentEnv: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn,
): void {
  if (parentEnv[ANTHROPIC_API_KEY_VAR]) {
    log(
      [
        "",
        "!".repeat(78),
        "WARNING: ANTHROPIC_API_KEY is set in this shell's environment.",
        "AI Opportunity Hunter never forwards it to the `claude` CLI subprocess, so this",
        "app's own Claude calls still bill to your subscription. But its presence is a",
        "foot-gun for any OTHER tool run from this shell that reads it silently as",
        "pay-as-you-go API billing. Unset it if you don't need it:",
        "  unset ANTHROPIC_API_KEY",
        "!".repeat(78),
        "",
      ].join("\n"),
    );
  }
}

/**
 * Pure detection logic, split out from the process-spawning code so it can be unit tested
 * against fixture stderr/stdout samples without invoking the real CLI.
 */
export function detectQuotaExhaustion(input: {
  stderr: string;
  stdout?: string;
  exitCode: number | null;
}): boolean {
  const haystack = `${input.stderr}\n${input.stdout ?? ""}`;
  return QUOTA_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(haystack));
}

function buildArgs(options: ClaudeInvocationOptions): string[] {
  const toolList = options.tools.join(",");
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "json",
    "--model",
    options.model,
    "--tools",
    toolList,
    "--allowedTools",
    toolList,
    "--permission-prompts",
    "none",
  ];
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.settings) {
    args.push("--settings", JSON.stringify(options.settings));
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  return args;
}

export async function invokeClaude(
  options: ClaudeInvocationOptions,
): Promise<ClaudeInvocationResult> {
  warnIfApiKeyPresent();

  const env = { ...buildSanitizedEnv(), ...options.extraEnv };
  // Defensive: strip again in case a caller's extraEnv accidentally included it — the
  // structural guarantee (ADR-0001) must hold regardless of what any call site passes in.
  delete env[ANTHROPIC_API_KEY_VAR];
  const bin = options.claudeBin ?? "claude";
  const args = buildArgs(options);

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ClaudeInvocationResult) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(result);
    };

    const timeoutHandle = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish({
            status: "error",
            message: `claude invocation timed out after ${options.timeoutMs}ms`,
            stderr,
            exitCode: null,
          });
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      finish({
        status: "error",
        message: `failed to spawn claude CLI: ${err.message}`,
        stderr,
        exitCode: null,
      });
    });

    child.on("close", (exitCode) => {
      if (detectQuotaExhaustion({ stderr, stdout, exitCode })) {
        finish({
          status: "quota_exhausted",
          message: stderr.trim() || "Claude usage limit reached.",
        });
        return;
      }

      if (exitCode !== 0) {
        finish({
          status: "error",
          message: `claude CLI exited with code ${exitCode}`,
          stderr: stderr.trim(),
          exitCode,
        });
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      } catch (err) {
        finish({
          status: "invalid_json",
          message: `failed to parse claude CLI stdout as JSON: ${(err as Error).message}`,
          stdout,
        });
        return;
      }

      if (parsed.is_error === true) {
        finish({
          status: "error",
          message:
            typeof parsed.result === "string"
              ? parsed.result
              : "claude CLI reported is_error=true",
          stderr: stderr.trim(),
          exitCode,
        });
        return;
      }

      finish({
        status: "success",
        resultText: typeof parsed.result === "string" ? parsed.result : "",
        raw: parsed,
        costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
        durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : null,
      });
    });
  });
}
