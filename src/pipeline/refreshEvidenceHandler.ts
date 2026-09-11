/**
 * Wiring for a `REFRESH_EVIDENCE` work item (spec §60, PLAN.md Phase 14 — the handler
 * `worker.ts` stubbed out as "no handler yet, Phase 14 scope"). Re-runs the Deep Research Agent
 * for a company already past initial research (`RESEARCHED` or `NO_OPPORTUNITY`), so evidence
 * that may have gone stale — "website changes, company grows, new vacancies appear, previous
 * software disappears, major company event occurs" (spec §60) — gets a fresh pass once its
 * re-research eligibility window (`companies.nextEligibleResearchAt`) has passed.
 *
 * This intentionally reuses `researchHandler.ts`'s exact evidence-persistence rule
 * (`src/pipeline/researchEvidence.ts`: only an evidence item whose sourceUrl matches a `sources`
 * row the ADR-0004 hook actually recorded for *this* task is trusted) rather than duplicating it.
 * Unlike `researchHandler.ts`, this does NOT transition `companies.lifecycleStatus` — there is no
 * `RESEARCHED -> RESEARCHED` self-loop in `stateMachine.ts`'s transition table, and a refresh
 * doesn't change which stage the company is at, only what's known about it — but it does update
 * `lastResearchedAt`/`nextEligibleResearchAt` (so the window resets) and enqueues a fresh
 * `ANALYZE` item, since new evidence may change the opportunity landscape (a company that
 * previously landed on `NO_OPPORTUNITY` might now have one, or an existing opportunity's evidence
 * base may have grown).
 *
 * A `REFRESH_EVIDENCE` work item's `entityId` holds a *company* id, same convention as
 * `PRESCREEN`/`RESEARCH`.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, workItems } from "../db/schema.js";
import {
  runDeepResearchAgent,
  type DeepResearchOutput,
  type RunDeepResearchAgentInput,
} from "../agents/deepResearchAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { computeNextEligibleResearchAt } from "../lib/researchFreshness.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import { persistVerifiedEvidence } from "./researchEvidence.js";
import { transitionWorkItemStatus, type WorkItemStatus } from "./stateMachine.js";

const REFRESHABLE_LIFECYCLE_STATUSES = ["RESEARCHED", "NO_OPPORTUNITY"] as const;

export interface RefreshEvidenceWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The companies id this task refreshes evidence for. */
  entityId: string;
  attempts: number;
}

export interface RunRefreshEvidenceTaskOptions {
  db: Db;
  workItem: RefreshEvidenceWorkItemContext;
  /** Path to the live SQLite DB file — required so the ADR-0004 hook subprocess can open its own
   * connection to the same file, same as `researchHandler.ts`. */
  dbPath: string;
  now?: Date;
  /** Injectable for tests; defaults to the real `runDeepResearchAgent` (invokes Claude for real). */
  runDeepResearch?: (
    input: RunDeepResearchAgentInput,
  ) => Promise<StructuredAgentResult<DeepResearchOutput>>;
  /** Overrides the spec §60 re-research freshness window; defaults to
   * `DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS`. */
  reResearchWindowMs?: number;
}

export interface RefreshEvidenceTaskOutcome {
  workItemStatus: WorkItemStatus;
  insertedEvidenceCount?: number;
  droppedUnverifiedEvidenceCount?: number;
  candidateProblems?: string[];
  createdAnalyzeWorkItemId?: string | null;
  costUsd?: number | null;
  error?: string;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

export async function runRefreshEvidenceTask(
  options: RunRefreshEvidenceTaskOptions,
): Promise<RefreshEvidenceTaskOutcome> {
  const { db, workItem, dbPath } = options;
  const now = options.now ?? new Date();

  const company = db
    .select()
    .from(companies)
    .where(eq(companies.id, workItem.entityId))
    .get();
  if (!company) {
    throw new Error(
      `REFRESH_EVIDENCE work item ${workItem.id} references unknown company ${workItem.entityId}`,
    );
  }
  if (!REFRESHABLE_LIFECYCLE_STATUSES.includes(company.lifecycleStatus as "RESEARCHED" | "NO_OPPORTUNITY")) {
    throw new Error(
      `REFRESH_EVIDENCE work item ${workItem.id} targets company ${company.id}, which is at ` +
        `lifecycle status ${company.lifecycleStatus}, not RESEARCHED/NO_OPPORTUNITY`,
    );
  }

  const runDeepResearch = options.runDeepResearch ?? runDeepResearchAgent;
  const result = await runDeepResearch({
    company: {
      name: company.name,
      website: company.website,
      country: company.country,
      region: company.region,
      industry: company.industry,
      businessType: company.businessType,
      sizeEstimate: company.sizeEstimate,
      description: company.description,
      priorNotes: company.notes,
    },
    dbPath,
    companyId: company.id,
    taskId: workItem.id,
  });

  if (result.status === "quota_exhausted") {
    const nextStatus = transitionWorkItemStatus(workItem.status, "DEFERRED");
    db.update(workItems)
      .set({ status: nextStatus, lastError: result.message, updatedAt: now })
      .where(eq(workItems.id, workItem.id))
      .run();
    return { workItemStatus: nextStatus, error: result.message };
  }

  if (result.status !== "success") {
    const failureOutcome = resolveFailureOutcome(
      { errorMessage: result.message, attempts: workItem.attempts + 1 },
      now,
    );
    db.update(workItems)
      .set({
        status: failureOutcome.status,
        attempts: workItem.attempts + 1,
        lastError: result.message,
        runAfter: failureOutcome.runAfter,
        updatedAt: now,
      })
      .where(eq(workItems.id, workItem.id))
      .run();
    return { workItemStatus: failureOutcome.status, error: result.message };
  }

  const { evidence, candidateProblems } = result.data;

  const { insertedEvidenceCount, droppedUnverifiedEvidenceCount } = persistVerifiedEvidence(
    db,
    company.id,
    workItem.id,
    evidence,
  );

  const noteLines = [
    `Evidence refresh: ${insertedEvidenceCount} new evidence item(s) recorded` +
      (droppedUnverifiedEvidenceCount > 0
        ? `, ${droppedUnverifiedEvidenceCount} dropped (sourceUrl not independently verified as fetched)`
        : "") +
      ".",
    candidateProblems.length > 0
      ? `Refresh candidate problems: ${candidateProblems.join("; ")}`
      : null,
  ].filter((line): line is string => line !== null);

  db.update(companies)
    .set({
      lastResearchedAt: now,
      nextEligibleResearchAt: computeNextEligibleResearchAt(now, options.reResearchWindowMs),
      notes: appendNote(company.notes, noteLines.join("\n")),
      updatedAt: now,
    })
    .where(eq(companies.id, company.id))
    .run();

  const [analyzeItem] = db
    .insert(workItems)
    .values({
      taskType: "ANALYZE",
      entityId: company.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.ANALYZE,
    })
    .returning()
    .all();

  const completedStatus = transitionWorkItemStatus(workItem.status, "COMPLETED");
  db.update(workItems)
    .set({ status: completedStatus, completedAt: now, updatedAt: now })
    .where(eq(workItems.id, workItem.id))
    .run();

  return {
    workItemStatus: completedStatus,
    insertedEvidenceCount,
    droppedUnverifiedEvidenceCount,
    candidateProblems,
    createdAnalyzeWorkItemId: analyzeItem?.id ?? null,
    costUsd: result.costUsd,
  };
}
