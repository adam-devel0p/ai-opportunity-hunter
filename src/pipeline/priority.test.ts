import { describe, expect, it } from "vitest";
import {
  TASK_TYPE_PRIORITY,
  isEligibleNow,
  selectNextWorkItem,
  type QueueableWorkItem,
  type TaskType,
} from "./priority.js";

function item(
  overrides: Partial<QueueableWorkItem> & { taskType: TaskType },
): QueueableWorkItem {
  return {
    id: overrides.taskType,
    status: "PENDING",
    priority: TASK_TYPE_PRIORITY[overrides.taskType],
    runAfter: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("TASK_TYPE_PRIORITY", () => {
  it("matches spec §49's explicit ordering: VERIFY > BUILD_OFFER > FIND_CONTACT > WRITE_OUTREACH > RESEARCH > PRESCREEN > DISCOVER", () => {
    expect(TASK_TYPE_PRIORITY.VERIFY).toBeGreaterThan(
      TASK_TYPE_PRIORITY.BUILD_OFFER,
    );
    expect(TASK_TYPE_PRIORITY.BUILD_OFFER).toBeGreaterThan(
      TASK_TYPE_PRIORITY.FIND_CONTACT,
    );
    expect(TASK_TYPE_PRIORITY.FIND_CONTACT).toBeGreaterThan(
      TASK_TYPE_PRIORITY.WRITE_OUTREACH,
    );
    expect(TASK_TYPE_PRIORITY.WRITE_OUTREACH).toBeGreaterThan(
      TASK_TYPE_PRIORITY.RESEARCH,
    );
    expect(TASK_TYPE_PRIORITY.RESEARCH).toBeGreaterThan(
      TASK_TYPE_PRIORITY.PRESCREEN,
    );
    expect(TASK_TYPE_PRIORITY.PRESCREEN).toBeGreaterThan(
      TASK_TYPE_PRIORITY.DISCOVER,
    );
  });

  it("places ANALYZE between WRITE_OUTREACH and RESEARCH, and REFRESH_EVIDENCE between RESEARCH and PRESCREEN", () => {
    expect(TASK_TYPE_PRIORITY.WRITE_OUTREACH).toBeGreaterThan(
      TASK_TYPE_PRIORITY.ANALYZE,
    );
    expect(TASK_TYPE_PRIORITY.ANALYZE).toBeGreaterThan(
      TASK_TYPE_PRIORITY.RESEARCH,
    );
    expect(TASK_TYPE_PRIORITY.RESEARCH).toBeGreaterThan(
      TASK_TYPE_PRIORITY.REFRESH_EVIDENCE,
    );
    expect(TASK_TYPE_PRIORITY.REFRESH_EVIDENCE).toBeGreaterThan(
      TASK_TYPE_PRIORITY.PRESCREEN,
    );
  });

  it("DISCOVER is the lowest-priority task type", () => {
    const lowest = Math.min(...Object.values(TASK_TYPE_PRIORITY));
    expect(TASK_TYPE_PRIORITY.DISCOVER).toBe(lowest);
  });
});

describe("isEligibleNow", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("PENDING with no runAfter is eligible", () => {
    expect(isEligibleNow(item({ taskType: "DISCOVER" }), now)).toBe(true);
  });

  it("RUNNING/COMPLETED/FAILED/CANCELLED are never eligible", () => {
    for (const status of [
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ] as const) {
      expect(
        isEligibleNow(item({ taskType: "DISCOVER", status }), now),
      ).toBe(false);
    }
  });

  it("RETRYABLE/DEFERRED with a future runAfter is not yet eligible", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(
      isEligibleNow(
        item({ taskType: "RESEARCH", status: "RETRYABLE", runAfter: future }),
        now,
      ),
    ).toBe(false);
    expect(
      isEligibleNow(
        item({ taskType: "RESEARCH", status: "DEFERRED", runAfter: future }),
        now,
      ),
    ).toBe(false);
  });

  it("RETRYABLE/DEFERRED with a past runAfter is eligible", () => {
    const past = new Date(now.getTime() - 60_000);
    expect(
      isEligibleNow(
        item({ taskType: "RESEARCH", status: "RETRYABLE", runAfter: past }),
        now,
      ),
    ).toBe(true);
  });
});

describe("selectNextWorkItem", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("returns undefined for an empty or all-ineligible queue", () => {
    expect(selectNextWorkItem([], now)).toBeUndefined();
    expect(
      selectNextWorkItem(
        [item({ taskType: "DISCOVER", status: "RUNNING" })],
        now,
      ),
    ).toBeUndefined();
  });

  it("a pending VERIFY task for a strong opportunity is selected before a pending DISCOVER task", () => {
    const verify = item({ taskType: "VERIFY" });
    const discover = item({ taskType: "DISCOVER" });
    expect(selectNextWorkItem([discover, verify], now)).toBe(verify);
  });

  it("selects across the full ordering regardless of array position", () => {
    const items = (
      ["DISCOVER", "WRITE_OUTREACH", "PRESCREEN", "VERIFY", "RESEARCH"] as const
    ).map((taskType) => item({ taskType }));
    expect(selectNextWorkItem(items, now)?.id).toBe("VERIFY");
  });

  it("breaks ties by createdAt ascending (oldest first)", () => {
    const older = item({
      taskType: "RESEARCH",
      id: "older",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = item({
      taskType: "RESEARCH",
      id: "newer",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(selectNextWorkItem([newer, older], now)).toBe(older);
  });

  it("ignores ineligible items even when they'd otherwise win on priority", () => {
    const runningVerify = item({ taskType: "VERIFY", status: "RUNNING" });
    const pendingDiscover = item({ taskType: "DISCOVER" });
    expect(selectNextWorkItem([runningVerify, pendingDiscover], now)).toBe(
      pendingDiscover,
    );
  });
});
