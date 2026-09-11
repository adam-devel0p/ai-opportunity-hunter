/**
 * Wiring for a `BUILD_OFFER` work item (spec §34, PLAN.md Phase 8): loads the opportunity a
 * `BUILD_OFFER` item targets (`entityId` is an opportunity id — set by `verifyHandler.ts`, which
 * only ever enqueues this task type on a gate pass, so this handler never needs to re-check
 * `opportunities.status` itself), its `opportunity_evaluations` row (score/verifier confidence,
 * given to the agent as context per docs/AGENT_CONTRACTS.md §6), and the owning company, then
 * runs the Offer Builder Agent.
 *
 * Two deterministic checks run on every generated offer before it's ever persisted:
 * - `src/lib/offerLint.ts`'s vague-offer blocklist (spec §34) — a match regenerates once (a
 *   second Claude call with the lint's reason appended as feedback), and a second consecutive
 *   match fails the task rather than persisting a vague offer.
 * - `src/lib/pricing.ts`'s band evaluation (spec §35) — never blocks, but an out-of-band price
 *   always gets a recorded justification: the agent's own `priceJustification` if it gave one, or
 *   a deterministic fallback note if it didn't (see ADR-0015 part 2).
 *
 * On success, the opportunity collapses `VERIFIED -> OFFER_READY -> CONTACT_RESEARCH` in one
 * write (same "only the final status is durably interesting" pattern as `prescreenHandler.ts`/
 * `analyzeHandler.ts`, ADR-0011 part 5 / ADR-0013 part 3) and a `FIND_CONTACT` work item is
 * enqueued (Phase 9's agent, same "each handler wires the next stage's queue" pattern as every
 * earlier handler).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, offers, opportunities, opportunityEvaluations, workItems } from "../db/schema.js";
import {
  runOfferBuilderAgent,
  type OfferBuilderOpportunityInput,
  type OfferBuilderOutput,
  type RunOfferBuilderAgentInput,
} from "../agents/offerBuilderAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { lintOfferScope, type OfferLintResult } from "../lib/offerLint.js";
import {
  DEFAULT_PRICE_BANDS,
  DEFAULT_RECURRING_SUPPORT_RANGE,
  evaluateOfferPricing,
  formatPricingBandGuide,
  type OfferPricingResult,
  type PriceBandConfig,
  type PriceBandName,
  type PriceRange,
} from "../lib/pricing.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  transitionOpportunityStatus,
  transitionWorkItemStatus,
  type OpportunityStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

export interface BuildOfferWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The opportunities id this task builds an offer for (same convention as VERIFY, set by
   * verifyHandler.ts). */
  entityId: string;
  attempts: number;
}

export interface RunBuildOfferTaskOptions {
  db: Db;
  workItem: BuildOfferWorkItemContext;
  now?: Date;
  /** Injectable for tests; defaults to the real `runOfferBuilderAgent` (invokes Claude for real). */
  runOfferBuilder?: (
    input: RunOfferBuilderAgentInput,
  ) => Promise<StructuredAgentResult<OfferBuilderOutput>>;
  /** Overrides spec §35's pricing bands; defaults to `DEFAULT_PRICE_BANDS`. */
  priceBands?: Record<PriceBandName, PriceBandConfig>;
  /** Overrides spec §35's ongoing-support range; defaults to `DEFAULT_RECURRING_SUPPORT_RANGE`. */
  recurringRange?: PriceRange;
}

export interface BuildOfferTaskOutcome {
  workItemStatus: WorkItemStatus;
  opportunityStatus?: OpportunityStatus;
  offerId?: string;
  priceBand?: PriceBandName;
  priceInBand?: boolean;
  regenerated?: boolean;
  createdFindContactWorkItemId?: string | null;
  costUsd?: number | null;
  error?: string;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

/** Deterministic fallback used only when the price falls outside its resolved band and the agent
 * didn't supply its own `priceJustification` — always records *something*, never silently drops
 * an out-of-band price without an explanation (PLAN.md's Phase 8 acceptance criteria). */
function fallbackPriceJustification(
  price: number,
  pricing: OfferPricingResult,
  bands: Record<PriceBandName, PriceBandConfig>,
): string {
  const range = bands[pricing.band].price;
  return (
    `Price ${price} falls outside the standard ${pricing.band} band (${range.min}-${range.max}) ` +
    `for this offer's estimated duration; the agent did not provide a justification.`
  );
}

export async function runBuildOfferTask(
  options: RunBuildOfferTaskOptions,
): Promise<BuildOfferTaskOutcome> {
  const { db, workItem } = options;
  const now = options.now ?? new Date();
  const priceBands = options.priceBands ?? DEFAULT_PRICE_BANDS;
  const recurringRange = options.recurringRange ?? DEFAULT_RECURRING_SUPPORT_RANGE;

  const opportunity = db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, workItem.entityId))
    .get();
  if (!opportunity) {
    throw new Error(
      `BUILD_OFFER work item ${workItem.id} references unknown opportunity ${workItem.entityId}`,
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

  const opportunityInput: OfferBuilderOpportunityInput = {
    problemTitle: opportunity.problemTitle,
    problemDescription: opportunity.problemDescription,
    problemCategory: opportunity.problemCategory,
    economicImpact: opportunity.economicImpact,
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
    demoConcept: opportunity.demoConcept,
    adjustedScore: evaluation.adjustedScore,
    verifierConfidence: evaluation.verifierConfidence,
    company: {
      name: company.name,
      industry: company.industry,
      country: company.country,
      sizeEstimate: company.sizeEstimate,
    },
  };
  const pricingBandGuide = formatPricingBandGuide(priceBands, recurringRange);

  const runOfferBuilder = options.runOfferBuilder ?? runOfferBuilderAgent;

  function handleNonSuccess(
    result: Extract<
      StructuredAgentResult<OfferBuilderOutput>,
      { status: "quota_exhausted" | "error" | "invalid_output" }
    >,
  ): BuildOfferTaskOutcome {
    if (result.status === "quota_exhausted") {
      const nextStatus = transitionWorkItemStatus(workItem.status, "DEFERRED");
      db.update(workItems)
        .set({ status: nextStatus, lastError: result.message, updatedAt: now })
        .where(eq(workItems.id, workItem.id))
        .run();
      return { workItemStatus: nextStatus, error: result.message };
    }
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

  let result = await runOfferBuilder({ opportunity: opportunityInput, pricingBandGuide });
  if (result.status !== "success") {
    return handleNonSuccess(result);
  }

  let output = result.data;
  let lint: OfferLintResult = lintOfferScope(output.scope);
  let regenerated = false;

  if (lint.vague) {
    regenerated = true;
    const retryResult = await runOfferBuilder({
      opportunity: opportunityInput,
      pricingBandGuide,
      regenerationReason: lint.reason,
    });
    if (retryResult.status !== "success") {
      return handleNonSuccess(retryResult);
    }
    output = retryResult.data;
    lint = lintOfferScope(output.scope);
    result = retryResult;
  }

  if (lint.vague) {
    const message = `Offer scope was still vague after one regeneration: ${lint.reason}`;
    const failureOutcome = resolveFailureOutcome(
      { errorMessage: message, attempts: workItem.attempts + 1 },
      now,
    );
    db.update(workItems)
      .set({
        status: failureOutcome.status,
        attempts: workItem.attempts + 1,
        lastError: message,
        runAfter: failureOutcome.runAfter,
        updatedAt: now,
      })
      .where(eq(workItems.id, workItem.id))
      .run();
    return { workItemStatus: failureOutcome.status, error: message, regenerated };
  }

  const pricing = evaluateOfferPricing(
    {
      durationDays: opportunity.estimatedDurationDays,
      price: output.price,
      recurringPrice: output.recurringPrice,
    },
    priceBands,
    recurringRange,
  );
  const priceJustification =
    !pricing.priceInBand
      ? (output.priceJustification ?? fallbackPriceJustification(output.price, pricing, priceBands))
      : null;

  const [offer] = db
    .insert(offers)
    .values({
      opportunityId: opportunity.id,
      scope: output.scope,
      expectedOutcome: output.expectedOutcome,
      keyAssumptions: output.keyAssumptions,
      durationEstimate: output.durationEstimate,
      // Agent expresses prices in whole currency units; the DB column is cents (same convention
      // as opportunities.suggestedPriceMin/Max, ADR-0013 part 5).
      price: Math.round(output.price * 100),
      recurringPrice: output.recurringPrice != null ? Math.round(output.recurringPrice * 100) : null,
      exclusions: output.exclusions,
      validationNeeded: output.validationNeeded,
      demoConcept: output.demoConcept,
      priceBand: pricing.band,
    })
    .returning()
    .all();
  if (!offer) {
    throw new Error("Failed to insert offer row");
  }

  // Same "validate the whole hop chain, persist only the final status" pattern as
  // prescreenHandler.ts (ADR-0011 part 5) / analyzeHandler.ts (ADR-0013 part 3) — this handler
  // both builds the offer and immediately enqueues FIND_CONTACT, so there's no window where a
  // durably-visible OFFER_READY row matters on its own.
  transitionOpportunityStatus("VERIFIED", "OFFER_READY");
  const opportunityStatus = transitionOpportunityStatus("OFFER_READY", "CONTACT_RESEARCH");
  db.update(opportunities)
    .set({ status: opportunityStatus, updatedAt: now })
    .where(eq(opportunities.id, opportunity.id))
    .run();

  const noteLine =
    `Offer: "${output.scope}" — ${pricing.band} (${output.price}` +
    (output.recurringPrice != null ? ` + ${output.recurringPrice}/mo` : "") +
    `)` +
    (!pricing.priceInBand ? ` [price outside standard band: ${priceJustification}]` : "") +
    (regenerated ? " (regenerated once after failing the vague-offer lint)" : "") +
    ".";
  db.update(companies)
    .set({ notes: appendNote(company.notes, noteLine), updatedAt: now })
    .where(eq(companies.id, company.id))
    .run();

  const [findContactItem] = db
    .insert(workItems)
    .values({
      taskType: "FIND_CONTACT",
      entityId: opportunity.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.FIND_CONTACT,
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
    opportunityStatus,
    offerId: offer.id,
    priceBand: pricing.band,
    priceInBand: pricing.priceInBand,
    regenerated,
    createdFindContactWorkItemId: findContactItem?.id ?? null,
    costUsd: result.costUsd,
  };
}
