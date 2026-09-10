import { describe, expect, it } from "vitest";
import {
  DEFAULT_STUCK_RUNNING_TIMEOUT_MS,
  findStuckRunningItems,
  planStuckWorkItemRecovery,
  type RecoverableWorkItem,
} from "./crashRecovery.js";

const now = new Date("2026-06-01T12:00:00Z");

function runningItem(
  id: string,
  startedAt: Date | null,
): RecoverableWorkItem {
  return { id, status: "RUNNING", startedAt };
}

describe("findStuckRunningItems", () => {
  it("a RUNNING item started well past the timeout is stuck", () => {
    const stuck = runningItem(
      "stuck",
      new Date(now.getTime() - DEFAULT_STUCK_RUNNING_TIMEOUT_MS - 1000),
    );
    expect(findStuckRunningItems([stuck], now)).toEqual([stuck]);
  });

  it("a RUNNING item started just within the timeout is left alone", () => {
    const fresh = runningItem(
      "fresh",
      new Date(now.getTime() - DEFAULT_STUCK_RUNNING_TIMEOUT_MS + 1000),
    );
    expect(findStuckRunningItems([fresh], now)).toEqual([]);
  });

  it("non-RUNNING items are never considered stuck, however old", () => {
    const oldButCompleted: RecoverableWorkItem = {
      id: "done",
      status: "COMPLETED",
      startedAt: new Date(now.getTime() - 10 * DEFAULT_STUCK_RUNNING_TIMEOUT_MS),
    };
    expect(findStuckRunningItems([oldButCompleted], now)).toEqual([]);
  });

  it("a RUNNING item with no startedAt is left alone rather than guessed at", () => {
    const noStart = runningItem("no-start", null);
    expect(findStuckRunningItems([noStart], now)).toEqual([]);
  });

  it("respects a custom timeout", () => {
    const item = runningItem("borderline", new Date(now.getTime() - 5000));
    expect(findStuckRunningItems([item], now, 10_000)).toEqual([]);
    expect(findStuckRunningItems([item], now, 1000)).toEqual([item]);
  });
});

describe("planStuckWorkItemRecovery", () => {
  it("stuck items are planned to reset to RETRYABLE via the validated transition", () => {
    const stuck = runningItem(
      "stuck",
      new Date(now.getTime() - DEFAULT_STUCK_RUNNING_TIMEOUT_MS - 1000),
    );
    expect(planStuckWorkItemRecovery([stuck], now)).toEqual([
      { id: "stuck", nextStatus: "RETRYABLE" },
    ]);
  });

  it("no plan entries for items that aren't stuck", () => {
    const fresh = runningItem("fresh", now);
    expect(planStuckWorkItemRecovery([fresh], now)).toEqual([]);
  });
});
