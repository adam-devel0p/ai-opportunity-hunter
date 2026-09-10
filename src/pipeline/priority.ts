/**
 * Deterministic work-item priority ordering (spec §49). Claude quota should
 * be spent according to commercial value: finishing verification/offers/
 * contacts/outreach for opportunities already in flight outranks starting
 * fresh discovery, since abandoning near-finished work wastes quota already
 * spent on it.
 *
 * `TASK_TYPE_PRIORITY` is the base priority assigned to a `work_items` row
 * at creation time (per DATABASE_SCHEMA.md: "derived from taskType per spec
 * §49 default ordering, operator/campaign-adjustable" — callers may still
 * override the stored `priority` value per item; this module only supplies
 * the default and the selection logic over whatever priority values are
 * actually stored). Higher number = more urgent.
 */

import type { workItems } from "../db/schema.js";

export type TaskType = (typeof workItems.$inferSelect)["taskType"];
export type WorkItemStatus = (typeof workItems.$inferSelect)["status"];

/**
 * Spec §49 gives an explicit 7-item ordering (VERIFY > BUILD_OFFER >
 * FIND_CONTACT > WRITE_OUTREACH > RESEARCH > PRESCREEN > DISCOVER) but the
 * task-type enum has two more members it doesn't mention: `ANALYZE` and
 * `REFRESH_EVIDENCE`. Placed here as a judgment call (documented in
 * ADR-0009):
 *
 * - `ANALYZE` turns completed research into a scored opportunity — like
 *   VERIFY/BUILD_OFFER/FIND_CONTACT/WRITE_OUTREACH, it progresses work that
 *   already has research investment sunk into it, so it outranks starting
 *   RESEARCH on a new company, but it hasn't cleared verification yet, so it
 *   sits below WRITE_OUTREACH.
 * - `REFRESH_EVIDENCE` keeps already-researched companies' evidence current
 *   (spec §60) rather than surfacing new value, so it's ranked just below
 *   fresh RESEARCH — worth doing, but never at the expense of researching a
 *   promising company for the first time.
 */
export const TASK_TYPE_PRIORITY: Record<TaskType, number> = {
  VERIFY: 90,
  BUILD_OFFER: 80,
  FIND_CONTACT: 70,
  WRITE_OUTREACH: 60,
  ANALYZE: 50,
  RESEARCH: 40,
  REFRESH_EVIDENCE: 30,
  PRESCREEN: 20,
  DISCOVER: 10,
};

/** Statuses a worker may currently pick up and run. */
const ELIGIBLE_STATUSES: readonly WorkItemStatus[] = [
  "PENDING",
  "RETRYABLE",
  "DEFERRED",
];

export interface QueueableWorkItem {
  id: string;
  status: WorkItemStatus;
  priority: number;
  runAfter: Date | null;
  createdAt: Date;
}

/** A queued/retryable/deferred item is only pickable once its backoff/scheduling delay has passed. */
export function isEligibleNow(
  item: QueueableWorkItem,
  now: Date = new Date(),
): boolean {
  if (!ELIGIBLE_STATUSES.includes(item.status)) {
    return false;
  }
  if (item.runAfter !== null && item.runAfter.getTime() > now.getTime()) {
    return false;
  }
  return true;
}

/**
 * Selects the single highest-priority eligible item from queue contents
 * (spec §49). Ties break by `createdAt` ascending (oldest first, i.e. FIFO
 * within the same priority tier) so selection is fully deterministic.
 * Returns `undefined` when nothing is eligible right now.
 */
export function selectNextWorkItem<T extends QueueableWorkItem>(
  items: readonly T[],
  now: Date = new Date(),
): T | undefined {
  const eligible = items.filter((item) => isEligibleNow(item, now));
  if (eligible.length === 0) {
    return undefined;
  }
  return eligible.reduce((best, item) => {
    if (item.priority !== best.priority) {
      return item.priority > best.priority ? item : best;
    }
    return item.createdAt.getTime() < best.createdAt.getTime() ? item : best;
  });
}
