/**
 * Run history / activity feed (spec §69). There is no dedicated event-log table — rather than add
 * one (and rely on every pipeline handler remembering to write to it, a whole-codebase change),
 * this derives a human-readable feed directly from `work_items` (already timestamped by every
 * handler on completion/failure) joined against whatever entity each task type's `entityId`
 * points at, per DATABASE_SCHEMA.md's per-task-type convention. See ADR-0019.
 *
 * This is a "what does the current state say happened" view, not a durable historical snapshot —
 * e.g. a PRESCREEN entry reports the company's *current* `lifecycleStatus`, which is accurate
 * today because nothing yet re-runs an earlier stage for a company that has moved past it
 * (matches the same assumption `analyzeHandler.ts`/ADR-0013 part 7 already documents).
 */

import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  discoveryCampaigns,
  offers,
  opportunities,
  opportunityEvaluations,
  outreachDrafts,
  workItems,
} from "../db/schema.js";
import type { TaskType, WorkItemStatus } from "../pipeline/priority.js";

export interface ActivityEntry {
  workItemId: string;
  taskType: TaskType;
  status: WorkItemStatus;
  timestamp: Date;
  message: string;
  level: "info" | "warning";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

const FINISHED_STATUSES: readonly WorkItemStatus[] = ["COMPLETED", "FAILED", "DEFERRED"];

/**
 * One `DISCOVER` work item can find several companies in a single Claude call — the spec's own
 * example activity feed has one line per discovered company, so this expands a single DISCOVER
 * item into that many entries by matching companies whose `firstDiscoveredAt` falls inside the
 * task's own start/completion window (the same `now` value the handler threads through both
 * writes, so this is an exact match in practice, not a heuristic).
 */
function describeDiscoverItem(
  db: Db,
  item: typeof workItems.$inferSelect,
): ActivityEntry[] {
  const campaign = db
    .select({ name: discoveryCampaigns.name })
    .from(discoveryCampaigns)
    .where(eq(discoveryCampaigns.id, item.entityId))
    .get();
  const campaignName = campaign?.name ?? `campaign ${item.entityId}`;

  if (item.status !== "COMPLETED") {
    return [
      {
        workItemId: item.id,
        taskType: item.taskType,
        status: item.status,
        timestamp: item.updatedAt,
        message: `Discovery run for "${campaignName}" ${item.status.toLowerCase()}${
          item.lastError ? `: ${item.lastError}` : ""
        }`,
        level: "warning",
      },
    ];
  }

  const windowStart = item.startedAt ?? item.createdAt;
  const windowEnd = item.completedAt ?? item.updatedAt;
  const discovered = db
    .select({ name: companies.name, firstDiscoveredAt: companies.firstDiscoveredAt })
    .from(companies)
    .where(eq(companies.sourceCampaignId, item.entityId))
    .all()
    .filter(
      (row) =>
        row.firstDiscoveredAt.getTime() >= windowStart.getTime() &&
        row.firstDiscoveredAt.getTime() <= windowEnd.getTime(),
    );

  if (discovered.length === 0) {
    return [
      {
        workItemId: item.id,
        taskType: item.taskType,
        status: item.status,
        timestamp: windowEnd,
        message: `Discovery run for "${campaignName}" completed (no new companies)`,
        level: "info",
      },
    ];
  }

  return discovered.map((row) => ({
    workItemId: item.id,
    taskType: item.taskType,
    status: item.status,
    timestamp: row.firstDiscoveredAt,
    message: `Discovered ${row.name} (campaign "${campaignName}")`,
    level: "info" as const,
  }));
}

function genericFailureMessage(item: typeof workItems.$inferSelect, subject: string): ActivityEntry {
  return {
    workItemId: item.id,
    taskType: item.taskType,
    status: item.status,
    timestamp: item.updatedAt,
    message: `${item.taskType} ${item.status.toLowerCase()} for ${subject}${
      item.lastError ? `: ${item.lastError}` : ""
    }`,
    level: "warning",
  };
}

function describeCompanyTaskItem(
  db: Db,
  item: typeof workItems.$inferSelect,
): ActivityEntry | null {
  const company = db
    .select()
    .from(companies)
    .where(eq(companies.id, item.entityId))
    .get();
  if (!company) return null;

  if (item.status !== "COMPLETED") {
    return genericFailureMessage(item, company.name);
  }

  const timestamp = item.completedAt ?? item.updatedAt;
  if (item.taskType === "PRESCREEN") {
    return {
      workItemId: item.id,
      taskType: item.taskType,
      status: item.status,
      timestamp,
      message: `${company.name} pre-screened → ${company.lifecycleStatus}`,
      level: "info",
    };
  }
  if (item.taskType === "RESEARCH") {
    return {
      workItemId: item.id,
      taskType: item.taskType,
      status: item.status,
      timestamp,
      message: `Deep research completed for ${company.name}`,
      level: "info",
    };
  }
  if (item.taskType === "REFRESH_EVIDENCE") {
    return {
      workItemId: item.id,
      taskType: item.taskType,
      status: item.status,
      timestamp,
      message: `Evidence refreshed for ${company.name}`,
      level: "info",
    };
  }
  // ANALYZE
  const opportunity = db
    .select({ problemTitle: opportunities.problemTitle })
    .from(opportunities)
    .where(eq(opportunities.companyId, company.id))
    .get();
  return {
    workItemId: item.id,
    taskType: item.taskType,
    status: item.status,
    timestamp,
    message: opportunity
      ? `Candidate opportunity "${opportunity.problemTitle}" generated for ${company.name}`
      : `Analysis completed for ${company.name}`,
    level: "info",
  };
}

function describeOpportunityTaskItem(
  db: Db,
  item: typeof workItems.$inferSelect,
): ActivityEntry | null {
  const opportunity = db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, item.entityId))
    .get();
  if (!opportunity) return null;
  const company = db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, opportunity.companyId))
    .get();
  const companyName = company?.name ?? "unknown company";

  if (item.status !== "COMPLETED") {
    return genericFailureMessage(item, `"${opportunity.problemTitle}" (${companyName})`);
  }

  const timestamp = item.completedAt ?? item.updatedAt;
  if (item.taskType === "VERIFY") {
    const evaluation = db
      .select({ verifierResult: opportunityEvaluations.verifierResult, adjustedScore: opportunityEvaluations.adjustedScore })
      .from(opportunityEvaluations)
      .where(eq(opportunityEvaluations.opportunityId, opportunity.id))
      .get();
    return {
      workItemId: item.id,
      taskType: item.taskType,
      status: item.status,
      timestamp,
      message: `Verifier ${evaluation?.verifierResult ?? "?"} for "${opportunity.problemTitle}" (${companyName}), adjusted score ${evaluation?.adjustedScore ?? "?"}`,
      level: "info",
    };
  }
  if (item.taskType === "BUILD_OFFER") {
    const offer = db
      .select({ price: offers.price })
      .from(offers)
      .where(eq(offers.opportunityId, opportunity.id))
      .get();
    return {
      workItemId: item.id,
      taskType: item.taskType,
      status: item.status,
      timestamp,
      message: `Offer built for "${opportunity.problemTitle}" (${companyName})${
        offer ? ` — ${formatCents(offer.price)}` : ""
      }`,
      level: "info",
    };
  }
  if (item.taskType === "FIND_CONTACT") {
    const contact = db
      .select({ name: contacts.name, role: contacts.role })
      .from(contacts)
      .where(eq(contacts.companyId, opportunity.companyId))
      .orderBy(desc(contacts.createdAt))
      .get();
    return {
      workItemId: item.id,
      taskType: item.taskType,
      status: item.status,
      timestamp,
      message: `Decision-maker found for ${companyName}${
        contact ? `: ${contact.name}${contact.role ? ` (${contact.role})` : ""}` : ""
      }`,
      level: "info",
    };
  }
  // WRITE_OUTREACH
  const draft = db
    .select({ subject: outreachDrafts.subject })
    .from(outreachDrafts)
    .where(eq(outreachDrafts.opportunityId, opportunity.id))
    .orderBy(desc(outreachDrafts.createdAt))
    .get();
  return {
    workItemId: item.id,
    taskType: item.taskType,
    status: item.status,
    timestamp,
    message: `Outreach draft written for ${companyName}${draft ? `: "${draft.subject}"` : ""}`,
    level: "info",
  };
}

/** Returns the most recent `limit` activity entries, newest first. */
export function getRecentActivity(db: Db, limit = 50): ActivityEntry[] {
  const items = db
    .select()
    .from(workItems)
    .where(inArray(workItems.status, FINISHED_STATUSES))
    .orderBy(desc(workItems.updatedAt))
    .limit(limit)
    .all();

  const entries: ActivityEntry[] = [];
  for (const item of items) {
    if (item.taskType === "DISCOVER") {
      entries.push(...describeDiscoverItem(db, item));
      continue;
    }
    const entry =
      item.taskType === "PRESCREEN" ||
      item.taskType === "RESEARCH" ||
      item.taskType === "ANALYZE" ||
      item.taskType === "REFRESH_EVIDENCE"
        ? describeCompanyTaskItem(db, item)
        : describeOpportunityTaskItem(db, item);
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return entries.slice(0, limit);
}
