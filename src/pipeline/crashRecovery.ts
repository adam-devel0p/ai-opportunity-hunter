/**
 * Crash recovery (spec §67): a `work_item` left `RUNNING` because the
 * process died (crash, laptop sleep, kill -9) must not stay locked forever.
 * This module only builds the deterministic primitive — PLAN.md Phase 11's
 * `worker.ts` is what actually calls it once, at startup, before entering
 * the main loop.
 */

import { transitionWorkItemStatus, type WorkItemStatus } from "./stateMachine.js";

/**
 * A `RUNNING` item older than this (measured from `startedAt`) is assumed
 * abandoned by a dead process rather than genuinely still in flight. No
 * single agent call in this system is expected to run anywhere near this
 * long; picked generously to avoid recovering a task that's merely slow
 * (judgment call — see ADR-0009).
 */
export const DEFAULT_STUCK_RUNNING_TIMEOUT_MS = 30 * 60_000;

export interface RecoverableWorkItem {
  id: string;
  status: WorkItemStatus;
  startedAt: Date | null;
}

/** Pure filter: which `RUNNING` items are old enough to count as stuck. */
export function findStuckRunningItems<T extends RecoverableWorkItem>(
  items: readonly T[],
  now: Date = new Date(),
  timeoutMs: number = DEFAULT_STUCK_RUNNING_TIMEOUT_MS,
): T[] {
  return items.filter((item) => {
    if (item.status !== "RUNNING") {
      return false;
    }
    // No `startedAt` shouldn't happen for a RUNNING row, but with nothing to
    // measure a stall against, leave it alone rather than guess.
    if (item.startedAt === null) {
      return false;
    }
    return now.getTime() - item.startedAt.getTime() > timeoutMs;
  });
}

export interface WorkItemRecoveryPlan {
  id: string;
  nextStatus: WorkItemStatus;
}

/**
 * Stuck items get reset to `RETRYABLE` (via the validated state-machine
 * transition, not a raw status write) so the normal retry/backoff path
 * picks them back up rather than leaving the company/opportunity they
 * belong to permanently blocked.
 */
export function planStuckWorkItemRecovery<T extends RecoverableWorkItem>(
  items: readonly T[],
  now: Date = new Date(),
  timeoutMs: number = DEFAULT_STUCK_RUNNING_TIMEOUT_MS,
): WorkItemRecoveryPlan[] {
  return findStuckRunningItems(items, now, timeoutMs).map((item) => ({
    id: item.id,
    nextStatus: transitionWorkItemStatus(item.status, "RETRYABLE"),
  }));
}
