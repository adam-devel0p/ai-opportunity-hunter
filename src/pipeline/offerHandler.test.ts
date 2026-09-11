import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, offers, opportunities, opportunityEvaluations, workItems } from "../db/schema.js";
import type { OfferBuilderOutput, RunOfferBuilderAgentInput } from "../agents/offerBuilderAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import { runBuildOfferTask, type BuildOfferWorkItemContext } from "./offerHandler.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-offer-test-"));
  dbPath = path.join(dir, "test.db");
  db = runMigrations(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedCompany(overrides?: Partial<typeof companies.$inferInsert>) {
  const [company] = db
    .insert(companies)
    .values({
      name: "Northgate Recruitment",
      normalizedDomain: "northgate-recruitment.example",
      website: "https://northgate-recruitment.example",
      country: "UK",
      industry: "recruitment",
      description: "A small independent recruitment agency.",
      sizeEstimate: "10-20 employees",
      lifecycleStatus: "RESEARCHED",
      ...overrides,
    })
    .returning()
    .all();
  return company!;
}

function seedOpportunity(
  companyId: string,
  overrides?: Partial<typeof opportunities.$inferInsert>,
) {
  const [opportunity] = db
    .insert(opportunities)
    .values({
      companyId,
      problemTitle: "Slow applicant screening",
      problemDescription: "Recruiters manually check every application against role requirements.",
      problemCategory: "recruitment operations",
      economicImpact: "Estimated 5 hours/week of recruiter time on manual screening.",
      impactAssumptions: [],
      affectedRole: "recruitment director",
      proposedSolution: "Automated applicant intake and requirement-matching workflow.",
      implementationStrategy: "Integrate with the existing application form and ATS export.",
      dependencies: [],
      risks: [],
      existingAlternatives: [],
      estimatedDurationDays: 2,
      suggestedPriceMin: 90000,
      suggestedPriceMax: 180000,
      recurringRevenuePossibility: null,
      demoConcept: null,
      confidence: 0.7,
      validationQuestion: "Confirm the exact ATS export format.",
      status: "VERIFIED",
      ...overrides,
    })
    .returning()
    .all();
  return opportunity!;
}

function seedEvaluation(
  opportunityId: string,
  overrides?: Partial<typeof opportunityEvaluations.$inferInsert>,
) {
  const [evaluation] = db
    .insert(opportunityEvaluations)
    .values({
      opportunityId,
      evidenceStrength: 15,
      painSeverity: 10,
      economicImpactScore: 10,
      deliverability: 12,
      purchaseLikelihood: 7,
      speedToValue: 4,
      reachability: 4,
      demonstrability: 4,
      repeatability: 3,
      urgency: 3,
      rawScore: 72,
      penalties: [],
      adjustedScore: 72,
      verifierResult: "KEEP",
      verifierConfidence: 0.7,
      ...overrides,
    })
    .returning()
    .all();
  return evaluation!;
}

function seedRunningWorkItem(opportunityId: string, attempts = 0): BuildOfferWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "BUILD_OFFER",
      entityId: opportunityId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.BUILD_OFFER,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: opportunityId, attempts };
}

function success(data: OfferBuilderOutput): StructuredAgentResult<OfferBuilderOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.03, durationMs: 2000 };
}

const validOffer: OfferBuilderOutput = {
  scope:
    "Automated applicant intake workflow that extracts candidate details, checks them against role requirements, and creates a structured recruiter review queue.",
  expectedOutcome: "Recruiters review a structured queue instead of raw applications.",
  keyAssumptions: ["ATS export format stays stable"],
  durationEstimate: "2 days",
  price: 1400,
  recurringPrice: null,
  exclusions: "Does not include ATS replacement or migration.",
  validationNeeded: "Confirm export format with the recruitment director.",
  demoConcept: "A sample dashboard showing three anonymized applications processed end to end.",
  whyCommerciallyAttractive: "Directly reduces recruiter hours on a recurring weekly task.",
  priceJustification: null,
};

const vagueOffer: OfferBuilderOutput = {
  ...validOffer,
  scope: "AI automation services.",
};

describe("runBuildOfferTask", () => {
  it("throws for a BUILD_OFFER item whose entityId isn't a known opportunity", async () => {
    const workItem: BuildOfferWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-opportunity",
      attempts: 0,
    };
    await expect(
      runBuildOfferTask({ db, workItem, runOfferBuilder: async () => success(validOffer) }),
    ).rejects.toThrow(/unknown opportunity/);
  });

  it("builds and persists a valid offer, transitions the opportunity, and enqueues FIND_CONTACT", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const runOfferBuilder = vi.fn(async (_input: RunOfferBuilderAgentInput) => success(validOffer));

    const outcome = await runBuildOfferTask({ db, workItem, runOfferBuilder });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.regenerated).toBe(false);
    expect(outcome.priceBand).toBe("WORKFLOW_IMPLEMENTATION");
    expect(outcome.priceInBand).toBe(true);
    expect(outcome.opportunityStatus).toBe("CONTACT_RESEARCH");
    expect(outcome.createdFindContactWorkItemId).toBeTruthy();
    expect(runOfferBuilder).toHaveBeenCalledTimes(1);

    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("CONTACT_RESEARCH");

    const offerRow = db.select().from(offers).where(eq(offers.opportunityId, opportunity.id)).get();
    expect(offerRow?.scope).toBe(validOffer.scope);
    expect(offerRow?.price).toBe(140000); // whole units -> cents
    expect(offerRow?.priceBand).toBe("WORKFLOW_IMPLEMENTATION");

    const findContactItems = db
      .select()
      .from(workItems)
      .where(eq(workItems.taskType, "FIND_CONTACT"))
      .all();
    expect(findContactItems).toHaveLength(1);
    expect(findContactItems[0]?.entityId).toBe(opportunity.id);
    expect(findContactItems[0]?.priority).toBe(TASK_TYPE_PRIORITY.FIND_CONTACT);
  });

  it("regenerates once when the first offer's scope is caught by the vague-offer lint", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const runOfferBuilder = vi
      .fn<(input: RunOfferBuilderAgentInput) => Promise<StructuredAgentResult<OfferBuilderOutput>>>()
      .mockResolvedValueOnce(success(vagueOffer))
      .mockResolvedValueOnce(success(validOffer));

    const outcome = await runBuildOfferTask({ db, workItem, runOfferBuilder });

    expect(runOfferBuilder).toHaveBeenCalledTimes(2);
    expect(runOfferBuilder.mock.calls[1]?.[0].regenerationReason).toMatch(/blocklist/);
    expect(outcome.regenerated).toBe(true);
    expect(outcome.workItemStatus).toBe("COMPLETED");

    const offerRow = db.select().from(offers).where(eq(offers.opportunityId, opportunity.id)).get();
    expect(offerRow?.scope).toBe(validOffer.scope);

    const company_ = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(company_?.notes).toMatch(/regenerated once/);
  });

  it("fails the task if the offer is still vague after one regeneration, without persisting an offer", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const runOfferBuilder = vi.fn(async () => success(vagueOffer));

    const outcome = await runBuildOfferTask({ db, workItem, runOfferBuilder });

    expect(runOfferBuilder).toHaveBeenCalledTimes(2);
    expect(outcome.workItemStatus).not.toBe("COMPLETED");
    expect(outcome.error).toMatch(/still vague/);

    const offerRow = db.select().from(offers).where(eq(offers.opportunityId, opportunity.id)).get();
    expect(offerRow).toBeUndefined();

    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("VERIFIED");
  });

  it("records a justification (from the agent) when the price falls outside its resolved band", async () => {
    const company = seedCompany();
    // Duration says WORKFLOW_IMPLEMENTATION (900-2000), but price is way above that band.
    const opportunity = seedOpportunity(company.id, { estimatedDurationDays: 2 });
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const expensiveOffer: OfferBuilderOutput = {
      ...validOffer,
      price: 4500,
      priceJustification: "Unusually broad scope covering three separate integrations.",
    };
    const runOfferBuilder = vi.fn(async () => success(expensiveOffer));

    const outcome = await runBuildOfferTask({ db, workItem, runOfferBuilder });

    expect(outcome.priceInBand).toBe(false);
    expect(outcome.priceBand).toBe("WORKFLOW_IMPLEMENTATION");

    const company_ = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(company_?.notes).toContain("Unusually broad scope covering three separate integrations.");
  });

  it("records a deterministic fallback justification when the price is out of band and the agent gave none", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, { estimatedDurationDays: 2 });
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const expensiveOfferNoJustification: OfferBuilderOutput = {
      ...validOffer,
      price: 4500,
      priceJustification: null,
    };
    const runOfferBuilder = vi.fn(async () => success(expensiveOfferNoJustification));

    const outcome = await runBuildOfferTask({ db, workItem, runOfferBuilder });

    expect(outcome.priceInBand).toBe(false);
    const company_ = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(company_?.notes).toMatch(/did not provide a justification/);
  });

  it("passes quota_exhausted through as DEFERRED, without mutating the opportunity or counting a failed attempt", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runBuildOfferTask({
      db,
      workItem,
      runOfferBuilder: async () => ({
        status: "quota_exhausted",
        message: "You've hit your weekly limit.",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("DEFERRED");
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("DEFERRED");
    expect(row?.attempts).toBe(0);

    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("VERIFIED");
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runBuildOfferTask({
      db,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runOfferBuilder: async () => ({
        status: "invalid_output",
        message: "Model output did not match the expected schema.",
        attempts: 2,
      }),
    });

    expect(outcome.workItemStatus).toBe("RETRYABLE");
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.attempts).toBe(1);
    expect(row?.runAfter?.getTime()).toBeGreaterThan(new Date("2026-06-01T00:00:00Z").getTime());
  });

  it("marks the item FAILED once attempts are exhausted", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id, 2);

    const outcome = await runBuildOfferTask({
      db,
      workItem,
      runOfferBuilder: async () => ({
        status: "error",
        message: "claude CLI exited with code 1",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("FAILED");
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.attempts).toBe(3);
  });
});
