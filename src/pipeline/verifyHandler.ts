/**
 * Wiring for a `VERIFY` work item (spec §32-33, PLAN.md Phase 7): loads the opportunity a
 * `VERIFY` item targets — the first task type whose `entityId` is an opportunity id, not a
 * company id (set by `analyzeHandler.ts`) — plus its `opportunity_evaluations` row (Phase 6's
 * score) and the evidence linked to it, then runs the Skeptical Verification Agent with a fresh
 * context that never includes the Opportunity Analysis Agent's own confidence/score judgments
 * (spec §33).
 *
 * The Skeptic's KEEP/REJECT is one input to a deterministic gate
 * (`src/lib/opportunityGate.ts`, spec §32) alongside the already-computed adjusted score, an
 * evidence-strength floor, and a deterministic risk-category classification
 * (`src/lib/riskCategory.ts`, spec §8). Passing the gate transitions the opportunity to
 * `VERIFIED` and enqueues `BUILD_OFFER` (Phase 8's agent, same "each handler wires the next
 * stage's queue" pattern as every prior phase — see ADR-0012 part 5). Failing the gate for *any*
 * of its reasons — not just an explicit skeptic REJECT — transitions the opportunity to
 * `VERIFIER_REJECTED` and enqueues nothing further (see ADR-0014).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  companies,
  evidenceItems,
  opportunities,
  opportunityEvaluations,
  sources,
  workItems,
} from "../db/schema.js";
import {
  runSkepticAgent,
  type RunSkepticAgentInput,
  type SkepticEvidenceInput,
  type SkepticOpportunityInput,
  type SkepticOutput,
} from "../agents/skepticAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { classifyOpportunityRisk, type RiskCategory } from "../lib/riskCategory.js";
import {
  DEFAULT_OPPORTUNITY_GATE_CONFIG,
  evaluateOpportunityGate,
  type OpportunityGateConfig,
} from "../lib/opportunityGate.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  transitionOpportunityStatus,
  transitionWorkItemStatus,
  type OpportunityStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

export interface VerifyWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The opportunities id this task verifies (not a company id — see module docstring). */
  entityId: string;
  attempts: number;
}

export interface RunVerifyTaskOptions {
  db: Db;
  workItem: VerifyWorkItemContext;
  now?: Date;
  /** Injectable for tests; defaults to the real `runSkepticAgent` (invokes Claude for real). */
  runSkeptic?: (
    input: RunSkepticAgentInput,
  ) => Promise<StructuredAgentResult<SkepticOutput>>;
  /** Overrides the spec §32 gate's threshold/floor/high-risk policy; defaults to
   * `DEFAULT_OPPORTUNITY_GATE_CONFIG`. */
  gateConfig?: OpportunityGateConfig;
}

export interface VerifyTaskOutcome {
  workItemStatus: WorkItemStatus;
  opportunityStatus?: OpportunityStatus;
  verifierResult?: "KEEP" | "REJECT";
  gatePassed?: boolean;
  gateReasons?: string[];
  riskCategory?: RiskCategory;
  createdBuildOfferWorkItemId?: string | null;
  costUsd?: number | null;
  error?: string;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

export async function runVerifyTask(
  options: RunVerifyTaskOptions,
): Promise<VerifyTaskOutcome> {
  const { db, workItem } = options;
  const now = options.now ?? new Date();

  const opportunity = db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, workItem.entityId))
    .get();
  if (!opportunity) {
    throw new Error(
      `VERIFY work item ${workItem.id} references unknown opportunity ${workItem.entityId}`,
    );
  }

  const evaluation = db
    .select()
    .from(opportunityEvaluations)
    .where(eq(opportunityEvaluations.opportunityId, opportunity.id))
    .get();
  if (!evaluation) {
    throw new Error(
      `Opportunity ${opportunity.id} has no opportunity_evaluations row (Phase 6 should have created one)`,
    );
  }

  const company = db
    .select()
    .from(companies)
    .where(eq(companies.id, opportunity.companyId))
    .get();
  if (!company) {
    throw new Error(
      `Opportunity ${opportunity.id} references unknown company ${opportunity.companyId}`,
    );
  }

  const evidenceRows = db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.opportunityId, opportunity.id))
    .all();
  const sourceRows = db
    .select()
    .from(sources)
    .where(eq(sources.companyId, company.id))
    .all();
  const sourceById = new Map(sourceRows.map((s) => [s.id, s]));

  const evidence: SkepticEvidenceInput[] = evidenceRows.map((item) => ({
    claim: item.claim,
    classification: item.classification,
    supportingExcerpt: item.supportingExcerpt,
    sourceUrl: sourceById.get(item.sourceId)?.url ?? null,
  }));

  // Deliberately omits opportunity.confidence and the score components/penalty reasons — those
  // are the Opportunity Analysis Agent's own judgment, not fresh-context material (spec §33).
  const opportunityInput: SkepticOpportunityInput = {
    problemTitle: opportunity.problemTitle,
    problemDescription: opportunity.problemDescription,
    problemCategory: opportunity.problemCategory,
    economicImpact: opportunity.economicImpact,
    impactAssumptions: opportunity.impactAssumptions ?? [],
    affectedRole: opportunity.affectedRole,
    proposedSolution: opportunity.proposedSolution,
    implementationStrategy: opportunity.implementationStrategy,
    dependencies: opportunity.dependencies ?? [],
    risks: opportunity.risks ?? [],
    existingAlternatives: opportunity.existingAlternatives ?? [],
    estimatedDurationDays: opportunity.estimatedDurationDays,
    suggestedPriceMin:
      opportunity.suggestedPriceMin != null ? opportunity.suggestedPriceMin / 100 : null,
    suggestedPriceMax:
      opportunity.suggestedPriceMax != null ? opportunity.suggestedPriceMax / 100 : null,
    recurringRevenuePossibility: opportunity.recurringRevenuePossibility,
    validationQuestion: opportunity.validationQuestion,
    company: {
      name: company.name,
      industry: company.industry,
      country: company.country,
      sizeEstimate: company.sizeEstimate,
    },
  };

  const runSkeptic = options.runSkeptic ?? runSkepticAgent;
  const result = await runSkeptic({ opportunity: opportunityInput, evidence });

  if (result.status === "quota_exhausted") {
    // Not a task failure to retry — retrying immediately can't help. Park it DEFERRED without
    // burning a retry attempt, same as every earlier handler (ADR-0010 part 5).
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

  const output = result.data;
  const risk = classifyOpportunityRisk({
    problemCategory: opportunity.problemCategory,
    problemDescription: opportunity.problemDescription,
    proposedSolution: opportunity.proposedSolution,
    implementationStrategy: opportunity.implementationStrategy,
  });

  const gateConfig = options.gateConfig ?? DEFAULT_OPPORTUNITY_GATE_CONFIG;
  const gate = evaluateOpportunityGate(
    {
      verifierResult: output.result,
      adjustedScore: evaluation.adjustedScore,
      evidenceStrength: evaluation.evidenceStrength,
      riskCategory: risk.riskCategory,
    },
    gateConfig,
  );

  db.update(opportunityEvaluations)
    .set({
      verifierResult: output.result,
      verifierConfidence: output.adjustedConfidence,
      verifierWeaknesses: output.weaknesses,
      verifierUnsupportedAssumptions: output.unsupportedAssumptions,
      verifierMissingInfo: output.missingInformation,
      verifierDealkillers: output.dealkillers,
    })
    .where(eq(opportunityEvaluations.opportunityId, opportunity.id))
    .run();

  const nextOpportunityStatus = transitionOpportunityStatus(
    "VERIFICATION_PENDING",
    gate.pass ? "VERIFIED" : "VERIFIER_REJECTED",
  );
  db.update(opportunities)
    .set({ status: nextOpportunityStatus, updatedAt: now })
    .where(eq(opportunities.id, opportunity.id))
    .run();

  const noteLine =
    `Verification: skeptic ${output.result} (confidence ${output.adjustedConfidence}), ` +
    `gate ${gate.pass ? "PASSED" : "FAILED"}` +
    (gate.reasons.length > 0 ? ` — ${gate.reasons.join("; ")}` : "") +
    (risk.matchedReasons.length > 0 ? ` [risk: ${risk.matchedReasons.join(", ")}]` : "") +
    ".";
  db.update(companies)
    .set({ notes: appendNote(company.notes, noteLine), updatedAt: now })
    .where(eq(companies.id, company.id))
    .run();

  let createdBuildOfferWorkItemId: string | null = null;
  if (gate.pass) {
    const [buildOfferItem] = db
      .insert(workItems)
      .values({
        taskType: "BUILD_OFFER",
        entityId: opportunity.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.BUILD_OFFER,
      })
      .returning()
      .all();
    createdBuildOfferWorkItemId = buildOfferItem?.id ?? null;
  }

  const completedStatus = transitionWorkItemStatus(workItem.status, "COMPLETED");
  db.update(workItems)
    .set({ status: completedStatus, completedAt: now, updatedAt: now })
    .where(eq(workItems.id, workItem.id))
    .run();

  return {
    workItemStatus: completedStatus,
    opportunityStatus: nextOpportunityStatus,
    verifierResult: output.result,
    gatePassed: gate.pass,
    gateReasons: gate.reasons,
    riskCategory: risk.riskCategory,
    createdBuildOfferWorkItemId,
    costUsd: result.costUsd,
  };
}
