/**
 * Wiring for a `PRESCREEN` work item (spec §18, PLAN.md Phase 4): loads the company a
 * `PRESCREEN` item targets, short-circuits deterministically without ever calling Claude if the
 * company is inside its re-research freshness window (spec §60 — `companies.nextEligibleResearchAt`),
 * otherwise runs the Pre-Screening Agent and acts on its classification: `DISCARD` transitions
 * the company to `DISCARDED` with reasons recorded and does not re-queue anything; `MAYBE`/
 * `PROMISING` transition the company through `PRESCREENED -> RESEARCH_PENDING` and enqueue a
 * `RESEARCH` work item (see ADR-0011 for why `MAYBE` is treated the same as `PROMISING` here).
 *
 * A `PRESCREEN` work item's `entityId` holds a *company* id, matching DATABASE_SCHEMA.md's
 * default (unlike `DISCOVER`, which holds a campaign id — see ADR-0010 part 3).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, workItems } from "../db/schema.js";
import {
  runPrescreenAgent,
  type PrescreenOutput,
  type RunPrescreenAgentInput,
} from "../agents/prescreenAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  transitionCompanyLifecycle,
  transitionWorkItemStatus,
  type CompanyLifecycleStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

export interface PrescreenWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The companies id this task screens. */
  entityId: string;
  attempts: number;
}

export interface RunPrescreenTaskOptions {
  db: Db;
  workItem: PrescreenWorkItemContext;
  now?: Date;
  /** Injectable for tests; defaults to the real `runPrescreenAgent` (invokes Claude for real). */
  runPrescreen?: (
    input: RunPrescreenAgentInput,
  ) => Promise<StructuredAgentResult<PrescreenOutput>>;
}

export interface PrescreenTaskOutcome {
  workItemStatus: WorkItemStatus;
  classification?: "DISCARD" | "MAYBE" | "PROMISING";
  companyLifecycleStatus?: CompanyLifecycleStatus;
  createdResearchWorkItemId?: string | null;
  costUsd?: number | null;
  error?: string;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

export async function runPrescreenTask(
  options: RunPrescreenTaskOptions,
): Promise<PrescreenTaskOutcome> {
  const { db, workItem } = options;
  const now = options.now ?? new Date();

  const company = db
    .select()
    .from(companies)
    .where(eq(companies.id, workItem.entityId))
    .get();
  if (!company) {
    throw new Error(
      `PRESCREEN work item ${workItem.id} references unknown company ${workItem.entityId}`,
    );
  }

  // Deterministic freshness check (spec §60): if this company was already researched recently
  // and isn't eligible again yet, discard it before ever spending a Claude call — saved for a
  // manual re-prescreen/"research this company now" (§72) entry point hitting an ineligible
  // company, since the normal DISCOVER->PRESCREEN flow never produces this for a fresh company.
  if (company.nextEligibleResearchAt && company.nextEligibleResearchAt.getTime() > now.getTime()) {
    const reason = `Not eligible for research again until ${company.nextEligibleResearchAt.toISOString()}${
      company.lastResearchedAt ? ` (last researched ${company.lastResearchedAt.toISOString()})` : ""
    }.`;
    const nextLifecycle = transitionCompanyLifecycle(company.lifecycleStatus, "DISCARDED");
    db.update(companies)
      .set({
        lifecycleStatus: nextLifecycle,
        notes: appendNote(company.notes, `Prescreen (DISCARD, no Claude call): ${reason}`),
        updatedAt: now,
      })
      .where(eq(companies.id, company.id))
      .run();

    const completedStatus = transitionWorkItemStatus(workItem.status, "COMPLETED");
    db.update(workItems)
      .set({ status: completedStatus, completedAt: now, updatedAt: now })
      .where(eq(workItems.id, workItem.id))
      .run();

    return {
      workItemStatus: completedStatus,
      classification: "DISCARD",
      companyLifecycleStatus: nextLifecycle,
      createdResearchWorkItemId: null,
    };
  }

  const runPrescreen = options.runPrescreen ?? runPrescreenAgent;
  const result = await runPrescreen({
    company: {
      name: company.name,
      website: company.website,
      country: company.country,
      industry: company.industry,
      description: company.description,
      sizeEstimate: company.sizeEstimate,
      discoveryNotes: company.notes,
    },
  });

  if (result.status === "quota_exhausted") {
    // Not a task failure to retry — retrying immediately can't help. Park it DEFERRED without
    // burning a retry attempt, same as discoverHandler.ts (ADR-0010 part 5).
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

  const { classification, reasons } = result.data;
  const reasonsText = reasons.length > 0 ? reasons.join("; ") : "(no reasons given)";

  if (classification === "DISCARD") {
    const nextLifecycle = transitionCompanyLifecycle(company.lifecycleStatus, "DISCARDED");
    db.update(companies)
      .set({
        lifecycleStatus: nextLifecycle,
        notes: appendNote(company.notes, `Prescreen (DISCARD): ${reasonsText}`),
        updatedAt: now,
      })
      .where(eq(companies.id, company.id))
      .run();

    const completedStatus = transitionWorkItemStatus(workItem.status, "COMPLETED");
    db.update(workItems)
      .set({ status: completedStatus, completedAt: now, updatedAt: now })
      .where(eq(workItems.id, workItem.id))
      .run();

    return {
      workItemStatus: completedStatus,
      classification,
      companyLifecycleStatus: nextLifecycle,
      createdResearchWorkItemId: null,
      costUsd: result.costUsd,
    };
  }

  // MAYBE and PROMISING both proceed to research — see ADR-0011: a cheap fast-tier pass is not
  // trusted to permanently kill a genuinely uncertain opportunity on its own.
  const prescreenedStatus = transitionCompanyLifecycle(company.lifecycleStatus, "PRESCREENED");
  const nextLifecycle = transitionCompanyLifecycle(prescreenedStatus, "RESEARCH_PENDING");
  db.update(companies)
    .set({
      lifecycleStatus: nextLifecycle,
      notes: appendNote(company.notes, `Prescreen (${classification}): ${reasonsText}`),
      updatedAt: now,
    })
    .where(eq(companies.id, company.id))
    .run();

  const [researchItem] = db
    .insert(workItems)
    .values({
      taskType: "RESEARCH",
      entityId: company.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.RESEARCH,
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
    classification,
    companyLifecycleStatus: nextLifecycle,
    createdResearchWorkItemId: researchItem?.id ?? null,
    costUsd: result.costUsd,
  };
}
