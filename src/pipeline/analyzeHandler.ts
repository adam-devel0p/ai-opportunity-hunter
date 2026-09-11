/**
 * Wiring for an `ANALYZE` work item (spec §26, PLAN.md Phase 6): loads the company an `ANALYZE`
 * item targets (same `entityId`-is-a-company-id convention as `PRESCREEN`/`RESEARCH`, per
 * `researchHandler.ts`'s enqueueing), loads its evidence, runs the Opportunity Analysis Agent,
 * and turns the result into a persisted `opportunities` + `opportunity_evaluations` row.
 *
 * The raw/adjusted score is never taken from the agent directly — `src/lib/scoring.ts`
 * deterministically sums the agent's ten score-component judgments and subtracts any flagged
 * penalties (spec §30: "Claude does not self-score"). Every `ANALYZE` task that reaches a
 * successful Claude call always forms exactly one opportunity, regardless of how strong or weak
 * it scores — rejecting weak opportunities is Phase 7's job (the Skeptical Verifier + gate), not
 * this handler's (see ADR-0013).
 */

import { and, eq, isNull } from "drizzle-orm";
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
  runOpportunityAnalysisAgent,
  type OpportunityAnalysisEvidenceInput,
  type OpportunityAnalysisOutput,
  type RunOpportunityAnalysisAgentInput,
} from "../agents/opportunityAnalysisAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { scoreOpportunity, type ScoreResult } from "../lib/scoring.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  transitionOpportunityStatus,
  transitionWorkItemStatus,
  type OpportunityStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

export interface AnalyzeWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The companies id this task analyzes. */
  entityId: string;
  attempts: number;
}

export interface RunAnalyzeTaskOptions {
  db: Db;
  workItem: AnalyzeWorkItemContext;
  now?: Date;
  /** Injectable for tests; defaults to the real `runOpportunityAnalysisAgent` (invokes Claude for real). */
  runOpportunityAnalysis?: (
    input: RunOpportunityAnalysisAgentInput,
  ) => Promise<StructuredAgentResult<OpportunityAnalysisOutput>>;
}

export interface AnalyzeTaskOutcome {
  workItemStatus: WorkItemStatus;
  opportunityId?: string;
  opportunityStatus?: OpportunityStatus;
  rawScore?: number;
  adjustedScore?: number;
  penalties?: ScoreResult["penalties"];
  linkedEvidenceCount?: number;
  createdVerifyWorkItemId?: string | null;
  costUsd?: number | null;
  error?: string;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

export async function runAnalyzeTask(
  options: RunAnalyzeTaskOptions,
): Promise<AnalyzeTaskOutcome> {
  const { db, workItem } = options;
  const now = options.now ?? new Date();

  const company = db
    .select()
    .from(companies)
    .where(eq(companies.id, workItem.entityId))
    .get();
  if (!company) {
    throw new Error(
      `ANALYZE work item ${workItem.id} references unknown company ${workItem.entityId}`,
    );
  }

  const evidenceRows = db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.companyId, company.id))
    .all();
  const sourceRows = db
    .select()
    .from(sources)
    .where(eq(sources.companyId, company.id))
    .all();
  const sourceById = new Map(sourceRows.map((s) => [s.id, s]));

  const evidence: OpportunityAnalysisEvidenceInput[] = evidenceRows.map((item) => ({
    claim: item.claim,
    classification: item.classification,
    supportingExcerpt: item.supportingExcerpt,
    confidence: item.confidence,
    sourceUrl: sourceById.get(item.sourceId)?.url ?? null,
  }));

  const runOpportunityAnalysis =
    options.runOpportunityAnalysis ?? runOpportunityAnalysisAgent;
  const result = await runOpportunityAnalysis({
    company: {
      name: company.name,
      website: company.website,
      country: company.country,
      industry: company.industry,
      businessType: company.businessType,
      sizeEstimate: company.sizeEstimate,
      description: company.description,
      priorNotes: company.notes,
    },
    evidence,
  });

  if (result.status === "quota_exhausted") {
    // Not a task failure to retry — retrying immediately can't help. Park it DEFERRED without
    // burning a retry attempt, same as discoverHandler.ts/prescreenHandler.ts/researchHandler.ts
    // (ADR-0010 part 5).
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
  const score = scoreOpportunity(output.scoreComponents, output.penaltyReasons);

  // Forming an opportunity always progresses straight to VERIFICATION_PENDING in one write —
  // there's no window where a durably-visible OPPORTUNITY_IDENTIFIED state matters on its own,
  // same reasoning as prescreenHandler.ts's PRESCREENED->RESEARCH_PENDING collapse (ADR-0011
  // part 5). The transition function is still called so an invalid move would still throw.
  const opportunityStatus = transitionOpportunityStatus(
    "OPPORTUNITY_IDENTIFIED",
    "VERIFICATION_PENDING",
  );

  const [opportunity] = db
    .insert(opportunities)
    .values({
      companyId: company.id,
      problemTitle: output.problemTitle,
      problemDescription: output.problemDescription,
      problemCategory: output.problemCategory,
      economicImpact: output.economicImpact,
      impactAssumptions: output.impactAssumptions,
      affectedRole: output.affectedRole,
      proposedSolution: output.proposedSolution,
      implementationStrategy: output.implementationStrategy,
      dependencies: output.dependencies,
      risks: output.risks,
      existingAlternatives: output.existingAlternatives,
      estimatedDurationDays: output.estimatedDurationDays,
      // Agent expresses prices in whole currency units (e.g. 750 == EUR 750); the DB column is
      // cents, per DATABASE_SCHEMA.md.
      suggestedPriceMin: Math.round(output.suggestedPriceMin * 100),
      suggestedPriceMax: Math.round(output.suggestedPriceMax * 100),
      recurringRevenuePossibility: output.recurringRevenuePossibility,
      demoConcept: output.demoConcept,
      confidence: output.confidence,
      validationQuestion: output.validationQuestion,
      status: opportunityStatus,
    })
    .returning()
    .all();
  if (!opportunity) {
    throw new Error("Failed to insert opportunity row");
  }

  db.insert(opportunityEvaluations)
    .values({
      opportunityId: opportunity.id,
      evidenceStrength: output.scoreComponents.evidenceStrength,
      painSeverity: output.scoreComponents.painSeverity,
      economicImpactScore: output.scoreComponents.economicImpactScore,
      deliverability: output.scoreComponents.deliverability,
      purchaseLikelihood: output.scoreComponents.purchaseLikelihood,
      speedToValue: output.scoreComponents.speedToValue,
      reachability: output.scoreComponents.reachability,
      demonstrability: output.scoreComponents.demonstrability,
      repeatability: output.scoreComponents.repeatability,
      urgency: output.scoreComponents.urgency,
      rawScore: score.rawScore,
      penalties: score.penalties,
      adjustedScore: score.adjustedScore,
    })
    .run();

  // Link this company's not-yet-linked evidence to the opportunity it informed — the dashboard
  // (Phase 12) queries facts/inferences/hypotheses/unknowns for a card by opportunityId, per
  // DATABASE_SCHEMA.md.
  const linkResult = db
    .update(evidenceItems)
    .set({ opportunityId: opportunity.id, updatedAt: now })
    .where(
      and(eq(evidenceItems.companyId, company.id), isNull(evidenceItems.opportunityId)),
    )
    .run();

  const noteLine =
    `Analysis: opportunity "${output.problemTitle}" formed (category: ${output.problemCategory}), ` +
    `adjusted score ${score.adjustedScore}/100` +
    (score.penalties.length > 0
      ? ` (penalties: ${score.penalties.map((p) => p.reason).join(", ")})`
      : "") +
    ".";
  db.update(companies)
    .set({ notes: appendNote(company.notes, noteLine), updatedAt: now })
    .where(eq(companies.id, company.id))
    .run();

  const [verifyItem] = db
    .insert(workItems)
    .values({
      taskType: "VERIFY",
      entityId: opportunity.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.VERIFY,
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
    opportunityId: opportunity.id,
    opportunityStatus,
    rawScore: score.rawScore,
    adjustedScore: score.adjustedScore,
    penalties: score.penalties,
    linkedEvidenceCount: linkResult.changes,
    createdVerifyWorkItemId: verifyItem?.id ?? null,
    costUsd: result.costUsd,
  };
}
