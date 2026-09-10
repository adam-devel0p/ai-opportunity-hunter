/**
 * Wiring for a `DISCOVER` work item (spec §14-17): runs the Discovery Agent for the campaign
 * the item targets, persists newly-found companies (deduped by normalized domain), enqueues a
 * `PRESCREEN` work item for each new one, and finalizes the `DISCOVER` item itself. This is the
 * first phase where `src/pipeline/`'s pure primitives (state machine, priority, failure
 * classification) get wired to a live DB + `claudeClient` call, per PLAN.md Phase 3.
 *
 * A `DISCOVER` work item's `entityId` holds a *campaign* id, not a company/opportunity id —
 * extending `work_items.entityId`'s polymorphism (see the comment on `workItems` in
 * `src/db/schema.ts`) since discovery doesn't yet have a company to operate on. See ADR-0010.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, discoveryCampaigns, workItems } from "../db/schema.js";
import { normalizeDomain } from "../lib/normalize.js";
import {
  runDiscoveryAgent,
  type DiscoveryOutput,
  type RunDiscoveryAgentInput,
} from "../agents/discoveryAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  transitionCompanyLifecycle,
  transitionWorkItemStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

export interface DiscoverWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The discovery_campaigns id this task runs. */
  entityId: string;
  attempts: number;
}

export interface RunDiscoverTaskOptions {
  db: Db;
  workItem: DiscoverWorkItemContext;
  now?: Date;
  targetCount?: number;
  /** Injectable for tests; defaults to the real `runDiscoveryAgent` (invokes Claude for real). */
  runDiscovery?: (
    input: RunDiscoveryAgentInput,
  ) => Promise<StructuredAgentResult<DiscoveryOutput>>;
}

export interface DiscoverTaskOutcome {
  // Narrower than the full WorkItemStatus enum in practice (a DISCOVER item only ever lands on
  // one of these four from this handler) but typed as WorkItemStatus since the underlying
  // transitions are validated at runtime by transitionWorkItemStatus, not re-narrowed here.
  workItemStatus: WorkItemStatus;
  insertedCompanyIds: string[];
  skippedDuplicateDomains: string[];
  createdPrescreenWorkItemIds: string[];
  costUsd?: number | null;
  error?: string;
}

export async function runDiscoverTask(
  options: RunDiscoverTaskOptions,
): Promise<DiscoverTaskOutcome> {
  const { db, workItem } = options;
  const now = options.now ?? new Date();

  const campaign = db
    .select()
    .from(discoveryCampaigns)
    .where(eq(discoveryCampaigns.id, workItem.entityId))
    .get();
  if (!campaign) {
    throw new Error(
      `DISCOVER work item ${workItem.id} references unknown campaign ${workItem.entityId}`,
    );
  }

  // Dedupe hinting is scoped to this campaign's own known domains, per AGENT_CONTRACTS.md §1
  // ("list of already-known domains for this campaign, not exhaustive") — the real,
  // authoritative dedupe check below is global via `companies.normalizedDomain`'s unique
  // constraint, since the same business must never get two company rows regardless of which
  // campaign(s) discover it.
  const knownDomains = db
    .select({ normalizedDomain: companies.normalizedDomain })
    .from(companies)
    .where(eq(companies.sourceCampaignId, campaign.id))
    .all()
    .map((row) => row.normalizedDomain);

  const runDiscovery = options.runDiscovery ?? runDiscoveryAgent;
  const result = await runDiscovery({
    campaignName: campaign.name,
    criteria: campaign.criteria,
    knownDomains,
    targetCount: options.targetCount,
  });

  if (result.status === "quota_exhausted") {
    // Not a task failure to retry — retrying immediately can't help. Park it DEFERRED without
    // burning a retry attempt; a scheduler (Phase 11) or operator decides when to resume.
    const nextStatus = transitionWorkItemStatus(workItem.status, "DEFERRED");
    db.update(workItems)
      .set({ status: nextStatus, lastError: result.message, updatedAt: now })
      .where(eq(workItems.id, workItem.id))
      .run();
    return {
      workItemStatus: nextStatus,
      insertedCompanyIds: [],
      skippedDuplicateDomains: [],
      createdPrescreenWorkItemIds: [],
      error: result.message,
    };
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
    return {
      workItemStatus: failureOutcome.status,
      insertedCompanyIds: [],
      skippedDuplicateDomains: [],
      createdPrescreenWorkItemIds: [],
      error: result.message,
    };
  }

  const insertedCompanyIds: string[] = [];
  const skippedDuplicateDomains: string[] = [];
  const createdPrescreenWorkItemIds: string[] = [];

  for (const candidate of result.data.companies) {
    const normalizedDomain = normalizeDomain(candidate.website);

    const existing = db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.normalizedDomain, normalizedDomain))
      .get();

    if (existing) {
      skippedDuplicateDomains.push(normalizedDomain);
      db.update(companies)
        .set({ lastDiscoveredAt: now, updatedAt: now })
        .where(eq(companies.id, existing.id))
        .run();
      continue;
    }

    const [inserted] = db
      .insert(companies)
      .values({
        name: candidate.name,
        normalizedDomain,
        website: candidate.website,
        country: candidate.country,
        industry: candidate.industry,
        description: candidate.description,
        sizeEstimate: candidate.sizeEstimate,
        sizeConfidence: candidate.sizeEstimate ? "UNKNOWN" : null,
        // `reasonToScreen` has no dedicated column (DATABASE_SCHEMA.md's `companies` table
        // doesn't define one) — seeded into the operator-editable `notes` field rather than
        // adding a schema column for one discovery-time string. See ADR-0010.
        notes: `Discovery reason: ${candidate.reasonToScreen}`,
        sourceCampaignId: campaign.id,
        lifecycleStatus: "DISCOVERED",
      })
      .returning()
      .all();
    if (!inserted) {
      continue;
    }

    const nextLifecycle = transitionCompanyLifecycle("DISCOVERED", "PRESCREEN_PENDING");
    db.update(companies)
      .set({ lifecycleStatus: nextLifecycle, updatedAt: now })
      .where(eq(companies.id, inserted.id))
      .run();

    const [prescreenItem] = db
      .insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: inserted.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .returning()
      .all();

    insertedCompanyIds.push(inserted.id);
    if (prescreenItem) {
      createdPrescreenWorkItemIds.push(prescreenItem.id);
    }
  }

  const completedStatus = transitionWorkItemStatus(workItem.status, "COMPLETED");
  db.update(workItems)
    .set({ status: completedStatus, completedAt: now, updatedAt: now })
    .where(eq(workItems.id, workItem.id))
    .run();

  return {
    workItemStatus: completedStatus,
    insertedCompanyIds,
    skippedDuplicateDomains,
    createdPrescreenWorkItemIds,
    costUsd: result.costUsd,
  };
}
