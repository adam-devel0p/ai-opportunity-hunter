/**
 * Wiring for a `RESEARCH` work item (spec §19, PLAN.md Phase 5): loads the company a `RESEARCH`
 * item targets, runs the Deep Research Agent, and persists its evidence — but only for evidence
 * items whose `sourceUrl` matches a `sources` row the ADR-0004 hook actually recorded for this
 * task. An evidence item citing a URL the hook never saw fetched is dropped rather than
 * persisted with a fabricated/unverifiable source, since `evidence_items.sourceId` is a
 * required FK (provenance is structural, not optional, per PLAN.md's Phase 5 acceptance
 * criteria) and the whole point of the hook (ADR-0004) is not trusting the model's own claim of
 * what it fetched.
 *
 * A `RESEARCH` work item's `entityId` holds a *company* id, matching DATABASE_SCHEMA.md's
 * default (like `PRESCREEN`, unlike `DISCOVER` — see ADR-0010 part 3 / ADR-0011).
 *
 * On success, the company transitions `RESEARCH_PENDING -> RESEARCHED`, `lastResearchedAt` /
 * `nextEligibleResearchAt` are set deterministically (`src/lib/researchFreshness.ts`, spec
 * §60), and an `ANALYZE` work item is enqueued — Phase 6 owns the Opportunity Analysis Agent
 * itself, but queuing its input is this handler's job, same pattern as `discoverHandler.ts`
 * enqueueing `PRESCREEN` and `prescreenHandler.ts` enqueueing `RESEARCH` (see ADR-0012).
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
import {
  transitionCompanyLifecycle,
  transitionWorkItemStatus,
  type CompanyLifecycleStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

export interface ResearchWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The companies id this task researches. */
  entityId: string;
  attempts: number;
}

export interface RunResearchTaskOptions {
  db: Db;
  workItem: ResearchWorkItemContext;
  /** Path to the live SQLite DB file — required so the ADR-0004 hook subprocess (a separate OS
   * process spawned by the `claude` CLI) can open its own connection to the same file. */
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

export interface ResearchTaskOutcome {
  workItemStatus: WorkItemStatus;
  companyLifecycleStatus?: CompanyLifecycleStatus;
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

export async function runResearchTask(
  options: RunResearchTaskOptions,
): Promise<ResearchTaskOutcome> {
  const { db, workItem, dbPath } = options;
  const now = options.now ?? new Date();

  const company = db
    .select()
    .from(companies)
    .where(eq(companies.id, workItem.entityId))
    .get();
  if (!company) {
    throw new Error(
      `RESEARCH work item ${workItem.id} references unknown company ${workItem.entityId}`,
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
    // Not a task failure to retry — retrying immediately can't help. Park it DEFERRED without
    // burning a retry attempt, same as discoverHandler.ts/prescreenHandler.ts (ADR-0010 part 5).
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
    `Research: ${insertedEvidenceCount} evidence item(s) recorded` +
      (droppedUnverifiedEvidenceCount > 0
        ? `, ${droppedUnverifiedEvidenceCount} dropped (sourceUrl not independently verified as fetched)`
        : "") +
      ".",
    candidateProblems.length > 0
      ? `Research candidate problems: ${candidateProblems.join("; ")}`
      : null,
  ].filter((line): line is string => line !== null);

  const nextLifecycle = transitionCompanyLifecycle(company.lifecycleStatus, "RESEARCHED");
  db.update(companies)
    .set({
      lifecycleStatus: nextLifecycle,
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
    companyLifecycleStatus: nextLifecycle,
    insertedEvidenceCount,
    droppedUnverifiedEvidenceCount,
    candidateProblems,
    createdAnalyzeWorkItemId: analyzeItem?.id ?? null,
    costUsd: result.costUsd,
  };
}
