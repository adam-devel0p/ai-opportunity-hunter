import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  computeRetryBackoffMs,
  resolveFailureOutcome,
} from "./failureClassification.js";

describe("classifyFailure", () => {
  const transientMessages = [
    "getaddrinfo ENOTFOUND example.com",
    "DNS lookup failed",
    "network error while fetching page",
    "rate limit exceeded, please retry",
    "HTTP 429 Too Many Requests",
    "database is locked",
    "SQLITE_BUSY: database is locked",
    "request timed out after 30000ms",
    "You've hit your usage limit for this session",
    "the site is temporarily unavailable",
  ];

  it.each(transientMessages)(
    "classifies %s as RETRYABLE when attempts are under the max",
    (errorMessage) => {
      expect(classifyFailure({ errorMessage, attempts: 0 })).toBe(
        "RETRYABLE",
      );
    },
  );

  it("classifies an unrecognized error as RETRYABLE by default (spec §66: most causes are transient)", () => {
    expect(
      classifyFailure({ errorMessage: "something odd happened", attempts: 0 }),
    ).toBe("RETRYABLE");
  });

  const permanentMessages = [
    "invalid state transition: SENT -> DISCOVERED",
    "401 Unauthorized",
    "403 Forbidden",
    "404 Not Found",
  ];

  it.each(permanentMessages)(
    "classifies %s as NON_RETRYABLE regardless of attempts",
    (errorMessage) => {
      expect(classifyFailure({ errorMessage, attempts: 0 })).toBe(
        "NON_RETRYABLE",
      );
    },
  );

  it("classifies as NON_RETRYABLE once attempts reach maxAttempts, even for an otherwise-transient cause", () => {
    expect(
      classifyFailure({
        errorMessage: "request timed out",
        attempts: 3,
        maxAttempts: 3,
      }),
    ).toBe("NON_RETRYABLE");
  });

  it("stays RETRYABLE while attempts remain under maxAttempts", () => {
    expect(
      classifyFailure({
        errorMessage: "request timed out",
        attempts: 2,
        maxAttempts: 3,
      }),
    ).toBe("RETRYABLE");
  });
});

describe("computeRetryBackoffMs", () => {
  it("doubles each attempt starting at 1 minute", () => {
    expect(computeRetryBackoffMs(1)).toBe(60_000);
    expect(computeRetryBackoffMs(2)).toBe(120_000);
    expect(computeRetryBackoffMs(3)).toBe(240_000);
  });

  it("caps at 1 hour", () => {
    expect(computeRetryBackoffMs(20)).toBe(60 * 60_000);
  });
});

describe("resolveFailureOutcome", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("RETRYABLE outcome sets a future runAfter based on backoff", () => {
    const outcome = resolveFailureOutcome(
      { errorMessage: "network error", attempts: 1 },
      now,
    );
    expect(outcome.status).toBe("RETRYABLE");
    expect(outcome.runAfter?.getTime()).toBe(now.getTime() + 60_000);
  });

  it("NON_RETRYABLE outcome has no runAfter", () => {
    const outcome = resolveFailureOutcome(
      { errorMessage: "404 Not Found", attempts: 0 },
      now,
    );
    expect(outcome).toEqual({ status: "FAILED", runAfter: null });
  });

  it("exhausted retries produce FAILED even for a transient cause", () => {
    const outcome = resolveFailureOutcome(
      { errorMessage: "network error", attempts: 3, maxAttempts: 3 },
      now,
    );
    expect(outcome.status).toBe("FAILED");
  });
});
