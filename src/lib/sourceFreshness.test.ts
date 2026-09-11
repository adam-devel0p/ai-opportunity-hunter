import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_FRESHNESS_THRESHOLD_MS,
  computeSourceFreshnessState,
} from "./sourceFreshness.js";

describe("computeSourceFreshnessState", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("is UNAVAILABLE when the fetch had no HTTP status", () => {
    expect(
      computeSourceFreshnessState({ httpStatus: null, retrievedAt: now, now }),
    ).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE for a non-2xx HTTP status", () => {
    expect(
      computeSourceFreshnessState({ httpStatus: 404, retrievedAt: now, now }),
    ).toBe("UNAVAILABLE");
    expect(
      computeSourceFreshnessState({ httpStatus: 500, retrievedAt: now, now }),
    ).toBe("UNAVAILABLE");
  });

  it("is FRESH for a 2xx status retrieved just now", () => {
    expect(
      computeSourceFreshnessState({ httpStatus: 200, retrievedAt: now, now }),
    ).toBe("FRESH");
  });

  it("is FRESH just under the threshold and STALE just over it", () => {
    const justUnder = new Date(now.getTime() - (DEFAULT_SOURCE_FRESHNESS_THRESHOLD_MS - 1000));
    const justOver = new Date(now.getTime() - (DEFAULT_SOURCE_FRESHNESS_THRESHOLD_MS + 1000));

    expect(
      computeSourceFreshnessState({ httpStatus: 200, retrievedAt: justUnder, now }),
    ).toBe("FRESH");
    expect(
      computeSourceFreshnessState({ httpStatus: 200, retrievedAt: justOver, now }),
    ).toBe("STALE");
  });

  it("respects a custom thresholdMs", () => {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    expect(
      computeSourceFreshnessState({
        httpStatus: 200,
        retrievedAt: oneHourAgo,
        now,
        thresholdMs: 30 * 60 * 1000,
      }),
    ).toBe("STALE");
  });
});
