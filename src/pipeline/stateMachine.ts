/**
 * Deterministic lifecycle transition functions for spec §90's state flow.
 *
 * Per ADR-0008 part 2, the spec's single conceptual chain is split across
 * three independently-owned enums (`companies.lifecycleStatus`,
 * `opportunities.status`, `work_items.status`), so each gets its own
 * transition table and validator here rather than one shared function.
 * Claude's structured output is never a direct writer of any of these
 * statuses — a caller always goes through one of these functions, which
 * throws on an invalid transition instead of silently accepting it.
 */

import type { companies, opportunities, workItems } from "../db/schema.js";

export type CompanyLifecycleStatus =
  (typeof companies.$inferSelect)["lifecycleStatus"];
export type OpportunityStatus = (typeof opportunities.$inferSelect)["status"];
export type WorkItemStatus = (typeof workItems.$inferSelect)["status"];

export class InvalidTransitionError extends Error {
  constructor(
    public readonly chain: "company" | "opportunity" | "workItem",
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid ${chain} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// --- company lifecycle (spec §90, discovery through research) ------------

export const COMPANY_LIFECYCLE_TRANSITIONS: Record<
  CompanyLifecycleStatus,
  readonly CompanyLifecycleStatus[]
> = {
  // Prescreen can discard immediately (e.g. dead/parked site, or a
  // deterministic freshness check that short-circuits before ever calling
  // Claude — spec §60/PLAN.md Phase 4) without ever reaching PRESCREENED.
  DISCOVERED: ["PRESCREEN_PENDING", "DISCARDED"],
  PRESCREEN_PENDING: ["PRESCREENED", "DISCARDED"],
  PRESCREENED: ["RESEARCH_PENDING", "DISCARDED"],
  RESEARCH_PENDING: ["RESEARCHED", "DISCARDED"],
  RESEARCHED: ["NO_OPPORTUNITY"],
  NO_OPPORTUNITY: [],
  DISCARDED: [],
  EXCLUDED: [],
};

/**
 * `EXCLUDED` is an operator-driven escape hatch (spec §61 blacklist/exclusion
 * system), not a normal pipeline progression step — it can be reached from
 * any other status at any time, so it's handled as a special case here
 * rather than duplicated into every row of the table above (which would
 * make the table's actual pipeline shape harder to read and easy to let
 * drift out of sync).
 */
export function transitionCompanyLifecycle(
  current: CompanyLifecycleStatus,
  next: CompanyLifecycleStatus,
): CompanyLifecycleStatus {
  if (next === "EXCLUDED" && current !== "EXCLUDED") {
    return next;
  }
  const allowed = COMPANY_LIFECYCLE_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidTransitionError("company", current, next);
  }
  return next;
}

// --- opportunity status (spec §90, formation through send) ---------------

export const OPPORTUNITY_STATUS_TRANSITIONS: Record<
  OpportunityStatus,
  readonly OpportunityStatus[]
> = {
  OPPORTUNITY_IDENTIFIED: ["VERIFICATION_PENDING"],
  VERIFICATION_PENDING: ["VERIFIED", "VERIFIER_REJECTED"],
  VERIFIER_REJECTED: [],
  VERIFIED: ["OFFER_READY"],
  OFFER_READY: ["CONTACT_RESEARCH"],
  CONTACT_RESEARCH: ["OUTREACH_READY"],
  OUTREACH_READY: ["SENT"],
  // What happens after a draft is sent (REPLIED/INTERESTED/MEETING/WON/...)
  // is recorded exclusively as `outreach_outcomes.event` rows (ADR-0008
  // part 2) — SENT is terminal for this column.
  SENT: [],
};

export function transitionOpportunityStatus(
  current: OpportunityStatus,
  next: OpportunityStatus,
): OpportunityStatus {
  const allowed = OPPORTUNITY_STATUS_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidTransitionError("opportunity", current, next);
  }
  return next;
}

// --- work item status (spec §48, the queue) -------------------------------

export const WORK_ITEM_STATUS_TRANSITIONS: Record<
  WorkItemStatus,
  readonly WorkItemStatus[]
> = {
  PENDING: ["RUNNING", "CANCELLED"],
  // A failed attempt can land back on RETRYABLE (backoff, try again) or
  // DEFERRED (e.g. quota exhausted mid-task — resume later), or terminate
  // at COMPLETED/FAILED.
  RUNNING: ["COMPLETED", "FAILED", "RETRYABLE", "DEFERRED"],
  // The worker picks these back up directly (straight to RUNNING) rather
  // than routing back through PENDING — there's nothing PENDING would add.
  RETRYABLE: ["RUNNING", "CANCELLED"],
  DEFERRED: ["RUNNING", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function transitionWorkItemStatus(
  current: WorkItemStatus,
  next: WorkItemStatus,
): WorkItemStatus {
  const allowed = WORK_ITEM_STATUS_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidTransitionError("workItem", current, next);
  }
  return next;
}
