/**
 * Retryable-vs-non-retryable failure classification (spec §66) and the
 * retry backoff schedule that goes with it. Every task-level failure this
 * app can hit (usage limit, malformed output, network/DNS errors, rate
 * limiting, a changed/inaccessible page, database lock, agent timeout) is
 * transient by nature, so the default is RETRYABLE; only patterns that
 * indicate retrying can't possibly help, or an item that has already
 * exhausted its retry budget, classify as NON_RETRYABLE.
 */

import { transitionWorkItemStatus } from "./stateMachine.js";

export type FailureClassification = "RETRYABLE" | "NON_RETRYABLE";

/**
 * Retries are pointless here: the request itself is fundamentally invalid,
 * not transiently unavailable, so classified NON_RETRYABLE regardless of
 * how many attempts remain.
 */
const NON_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /invalid (state )?transition/i,
  /unauthorized|forbidden|\b401\b|\b403\b/i,
  /not found|\b404\b/i,
];

const RETRYABLE_PATTERNS: readonly RegExp[] = [
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/,
  /\bdns\b/i,
  /network/i,
  /rate.?limit|\b429\b/i,
  /database is locked|SQLITE_BUSY/i,
  /timeout|timed out/i,
  /usage limit|quota/i,
  /unavailable/i,
];

/**
 * Matches AGENT_CONTRACTS.md's "one retry, then FAILED" rule: a task that
 * has already used up its retry budget is terminal no matter what the
 * underlying error was.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

export function classifyFailure(input: {
  errorMessage: string;
  attempts: number;
  maxAttempts?: number;
}): FailureClassification {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (input.attempts >= maxAttempts) {
    return "NON_RETRYABLE";
  }
  if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(input.errorMessage))) {
    return "NON_RETRYABLE";
  }
  if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(input.errorMessage))) {
    return "RETRYABLE";
  }
  // Unrecognized failure text: assume transient rather than giving up, per
  // §66's framing that autonomous processing must assume failures happen
  // and most listed causes are transient.
  return "RETRYABLE";
}

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/** Exponential backoff (1m, 2m, 4m, ... capped at 1h) keyed off the attempt count. */
export function computeRetryBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

export interface FailureOutcome {
  status: "RETRYABLE" | "FAILED";
  runAfter: Date | null;
}

/** Combines classification + backoff into the work-item update a failed task's handler should apply. */
export function resolveFailureOutcome(
  input: {
    errorMessage: string;
    attempts: number;
    maxAttempts?: number;
  },
  now: Date = new Date(),
): FailureOutcome {
  const classification = classifyFailure(input);
  if (classification === "NON_RETRYABLE") {
    transitionWorkItemStatus("RUNNING", "FAILED");
    return { status: "FAILED", runAfter: null };
  }
  transitionWorkItemStatus("RUNNING", "RETRYABLE");
  return {
    status: "RETRYABLE",
    runAfter: new Date(now.getTime() + computeRetryBackoffMs(input.attempts)),
  };
}
