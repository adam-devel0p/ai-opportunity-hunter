/**
 * Shared "invoke Claude, validate structured output, retry once with the validation error
 * appended" wrapper (docs/AGENT_CONTRACTS.md's cross-cutting rule: output is "validated
 * against a Zod schema before anything touches the database... If validation fails, the
 * wrapper retries once with the validation error appended to the prompt, then marks the work
 * item FAILED"). Built here as a schema-aware layer on top of `claudeClient.ts` rather than
 * inside it, so `claudeClient` stays a thin, Zod-agnostic process wrapper — see ADR-0010 for
 * why this is a separate module instead of literally living inside claudeClient.ts (the
 * contract's intent, one shared implementation instead of one per agent, is preserved either
 * way). Every agent from Phase 3 onward builds on this instead of reimplementing the retry
 * loop.
 */

import type { z } from "zod";
import {
  invokeClaude,
  type ClaudeInvocationOptions,
} from "./claudeClient.js";

export interface StructuredAgentOptions<T> extends Omit<ClaudeInvocationOptions, "prompt"> {
  /** Builds the prompt; called again on retry with the previous validation error. */
  buildPrompt: (retry?: { previousError: string }) => string;
  schema: z.ZodType<T>;
  /** Total attempts including the first (default 2 — "one retry", per AGENT_CONTRACTS.md). */
  maxAttempts?: number;
}

export type StructuredAgentResult<T> =
  | {
      status: "success";
      data: T;
      attempts: number;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { status: "quota_exhausted"; message: string; attempts: number }
  | { status: "invalid_output"; message: string; attempts: number }
  | { status: "error"; message: string; attempts: number };

/**
 * Only a failure to produce schema-valid JSON is retried (a fresh prompt with the error
 * appended can plausibly fix that). `quota_exhausted` and `error` (CLI/process failure) are
 * returned immediately — retrying those without the caller's involvement (backoff, in
 * particular) can't help and would just spend quota twice for nothing.
 */
export async function runStructuredAgent<T>(
  options: StructuredAgentOptions<T>,
): Promise<StructuredAgentResult<T>> {
  const maxAttempts = options.maxAttempts ?? 2;
  let previousError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = options.buildPrompt(
      previousError ? { previousError } : undefined,
    );
    const result = await invokeClaude({ ...options, prompt });

    if (result.status === "quota_exhausted") {
      return { status: "quota_exhausted", message: result.message, attempts: attempt };
    }
    if (result.status === "error") {
      return { status: "error", message: result.message, attempts: attempt };
    }

    if (result.status === "invalid_json") {
      previousError = result.message;
      if (attempt === maxAttempts) {
        return { status: "invalid_output", message: previousError, attempts: attempt };
      }
      continue;
    }

    // result.status === "success": schema-shape validation is still ours to do —
    // `--json-schema` (if passed) is a first line of defense only, per ADR-0007.
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.resultText);
    } catch (err) {
      previousError = `Result was not valid JSON: ${(err as Error).message}`;
      if (attempt === maxAttempts) {
        return { status: "invalid_output", message: previousError, attempts: attempt };
      }
      continue;
    }

    const validation = options.schema.safeParse(parsed);
    if (!validation.success) {
      previousError = JSON.stringify(validation.error.format());
      if (attempt === maxAttempts) {
        return { status: "invalid_output", message: previousError, attempts: attempt };
      }
      continue;
    }

    return {
      status: "success",
      data: validation.data,
      attempts: attempt,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    };
  }

  /* istanbul ignore next -- the loop above always returns by the final attempt */
  throw new Error("runStructuredAgent: exhausted attempts without returning");
}
