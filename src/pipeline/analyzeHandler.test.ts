import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import {
  companies,
  evidenceItems,
  opportunities,
  opportunityEvaluations,
  sources,
  workItems,
} from "../db/schema.js";
import type {
  OpportunityAnalysisOutput,
  RunOpportunityAnalysisAgentInput,
} from "../agents/opportunityAnalysisAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import {
  buildPenalties,
  calculateAdjustedScore,
  calculateRawScore,
} from "../lib/scoring.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import { runAnalyzeTask, type AnalyzeWorkItemContext } from "./analyzeHandler.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-analyze-test-"));
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
      name: "Acme Vet Clinic",
      normalizedDomain: "acme-vet.example",
      website: "https://acme-vet.example",
      country: "US",
      industry: "veterinary",
      description: "A small independent veterinary clinic.",
      sizeEstimate: "5-20 employees",
      notes: "Research candidate problems: manual enquiry triage.",
      lifecycleStatus: "RESEARCHED",
      ...overrides,
    })
    .returning()
    .all();
  return company!;
}

function seedRunningWorkItem(companyId: string, attempts = 0): AnalyzeWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "ANALYZE",
      entityId: companyId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.ANALYZE,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: companyId, attempts };
}

function seedEvidence(
  companyId: string,
  claim: string,
  classification: "FACT" | "INFERENCE" | "HYPOTHESIS" | "UNKNOWN",
  confidence: number,
  url = "https://acme-vet.example/contact",
) {
  const [source] = db
    .insert(sources)
    .values({ companyId, url, freshnessState: "FRESH" })
    .returning()
    .all();
  db.insert(evidenceItems)
    .values({
      companyId,
      sourceId: source!.id,
      claim,
      classification,
      supportingExcerpt: claim,
      confidence,
    })
    .run();
}

function success(data: OpportunityAnalysisOutput): StructuredAgentResult<OpportunityAnalysisOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.03, durationMs: 2000 };
}

const baseOutputFields = {
  affectedRole: "front desk / reception",
  proposedSolution: "Automated enquiry classification and first-response drafting.",
  implementationStrategy: "Integrate with the existing contact form and email inbox.",
  dependencies: [] as string[],
  risks: [] as string[],
  existingAlternatives: [] as string[],
  estimatedDurationDays: 5,
  recurringRevenuePossibility: null,
  demoConcept: null,
};

describe("runAnalyzeTask", () => {
  it("throws for an ANALYZE item whose entityId isn't a known company", async () => {
    const workItem: AnalyzeWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-company",
      attempts: 0,
    };
    await expect(
      runAnalyzeTask({
        db,
        workItem,
        runOpportunityAnalysis: async () =>
          success({
            ...baseOutputFields,
            problemTitle: "x",
            problemDescription: "x",
            problemCategory: "x",
            economicImpact: "x",
            impactAssumptions: [],
            suggestedPriceMin: 500,
            suggestedPriceMax: 1000,
            confidence: 0.5,
            validationQuestion: "x",
            scoreComponents: {
              evidenceStrength: 0,
              painSeverity: 0,
              economicImpactScore: 0,
              deliverability: 0,
              purchaseLikelihood: 0,
              speedToValue: 0,
              reachability: 0,
              demonstrability: 0,
              repeatability: 0,
              urgency: 0,
            },
            penaltyReasons: [],
          }),
      }),
    ).rejects.toThrow(/unknown company/);
  });

  it("§88 bad-opportunity example: a bare contact-form fact, honestly scored low, lands below the Phase 7 gating threshold (~75)", async () => {
    const company = seedCompany();
    seedEvidence(
      company.id,
      "Website sends enquiries through a general contact form.",
      "FACT",
      0.9,
    );
    const workItem = seedRunningWorkItem(company.id);

    const scoreComponents = {
      evidenceStrength: 3,
      painSeverity: 4,
      economicImpactScore: 3,
      deliverability: 8,
      purchaseLikelihood: 3,
      speedToValue: 2,
      reachability: 2,
      demonstrability: 2,
      repeatability: 1,
      urgency: 1,
    };
    const runOpportunityAnalysis = vi.fn(async (_input: RunOpportunityAnalysisAgentInput) =>
      success({
        ...baseOutputFields,
        problemTitle: "Possible enquiry handling friction (unconfirmed)",
        problemDescription:
          "The company has a general contact form (FACT). Volume, manual processing, and " +
          "urgency are not established by current evidence.",
        problemCategory: "customer enquiry handling",
        economicImpact: "Cannot be estimated with any confidence from current evidence.",
        impactAssumptions: [
          { assumption: "Company has a general contact form.", isKnown: true },
          {
            assumption: "Enquiries may take meaningful staff time to process (unconfirmed).",
            isKnown: false,
          },
        ],
        suggestedPriceMin: 500,
        suggestedPriceMax: 800,
        confidence: 0.15,
        validationQuestion: "Does the company actually receive a meaningful volume of enquiries?",
        scoreComponents,
        penaltyReasons: ["WEAK_SPECULATIVE_EVIDENCE"],
      }),
    );

    const outcome = await runAnalyzeTask({ db, workItem, runOpportunityAnalysis });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.adjustedScore).toBeLessThan(75);
    expect(outcome.penalties).toEqual([{ reason: "WEAK_SPECULATIVE_EVIDENCE", amount: 15 }]);

    const opp = db.select().from(opportunities).where(eq(opportunities.id, outcome.opportunityId!)).get();
    expect(opp?.impactAssumptions).toEqual([
      { assumption: "Company has a general contact form.", isKnown: true },
      {
        assumption: "Enquiries may take meaningful staff time to process (unconfirmed).",
        isKnown: false,
      },
    ]);
    // The unsupported claim is never persisted as a bare known fact.
    expect(opp?.impactAssumptions?.[1]?.isKnown).toBe(false);
  });

  it("§89 correct-reasoning example: facts/inferences/unknowns/hypothesis form an opportunity with a sensible validation question", async () => {
    const company = seedCompany();
    seedEvidence(company.id, "Website sends enquiries through a general form.", "FACT", 0.9);
    seedEvidence(company.id, "FAQ promises replies within two business days.", "FACT", 0.9);
    seedEvidence(
      company.id,
      "Several customer reviews mention difficulty getting timely responses.",
      "FACT",
      0.7,
    );
    seedEvidence(
      company.id,
      "The business may experience enquiry triage or response-capacity problems.",
      "INFERENCE",
      0.6,
    );
    seedEvidence(company.id, "Actual incoming volume.", "UNKNOWN", 0.1);
    seedEvidence(company.id, "Existing internal CRM automation.", "UNKNOWN", 0.1);
    seedEvidence(
      company.id,
      "Automated classification and first-response assistance could reduce response time.",
      "HYPOTHESIS",
      0.4,
    );
    const workItem = seedRunningWorkItem(company.id);

    const runOpportunityAnalysis = vi.fn(async () =>
      success({
        ...baseOutputFields,
        problemTitle: "Enquiry response-capacity friction",
        problemDescription:
          "Reviews suggest response delays; the FAQ's 2-day promise is a known target, but " +
          "actual volume and existing automation are unknown.",
        problemCategory: "customer enquiry handling",
        economicImpact: "Potential reduction in delayed-response complaints, exact size unknown.",
        impactAssumptions: [
          { assumption: "FAQ promises replies within two business days.", isKnown: true },
          { assumption: "Reviews mention difficulty getting timely responses.", isKnown: true },
          { assumption: "Assume moderate weekly enquiry volume.", isKnown: false },
        ],
        suggestedPriceMin: 600,
        suggestedPriceMax: 1500,
        confidence: 0.45,
        validationQuestion:
          "Determine whether additional evidence supports significant enquiry volume or operational friction.",
        scoreComponents: {
          evidenceStrength: 12,
          painSeverity: 9,
          economicImpactScore: 6,
          deliverability: 10,
          purchaseLikelihood: 5,
          speedToValue: 3,
          reachability: 3,
          demonstrability: 3,
          repeatability: 2,
          urgency: 2,
        },
        penaltyReasons: [],
      }),
    );

    const outcome = await runAnalyzeTask({ db, workItem, runOpportunityAnalysis });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    const opp = db.select().from(opportunities).where(eq(opportunities.id, outcome.opportunityId!)).get();
    expect(opp?.validationQuestion).toBe(
      "Determine whether additional evidence supports significant enquiry volume or operational friction.",
    );
    expect(opp?.status).toBe("VERIFICATION_PENDING");
    expect(opp?.impactAssumptions).toHaveLength(3);
    expect(opp?.impactAssumptions?.filter((a) => a.isKnown)).toHaveLength(2);

    // All 7 evidence items get linked to the new opportunity.
    const linkedEvidence = db
      .select()
      .from(evidenceItems)
      .where(eq(evidenceItems.opportunityId, opp!.id))
      .all();
    expect(linkedEvidence).toHaveLength(7);

    const verifyItems = db.select().from(workItems).where(eq(workItems.taskType, "VERIFY")).all();
    expect(verifyItems).toHaveLength(1);
    expect(verifyItems[0]?.entityId).toBe(opp!.id);
    expect(verifyItems[0]?.priority).toBe(TASK_TYPE_PRIORITY.VERIFY);
  });

  it("still forms an opportunity honestly when a company has zero evidence items (insufficient evidence is a valid outcome)", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const runOpportunityAnalysis = vi.fn(async (input: RunOpportunityAnalysisAgentInput) => {
      expect(input.evidence).toEqual([]);
      return success({
        ...baseOutputFields,
        problemTitle: "Insufficient evidence to identify a credible opportunity",
        problemDescription: "No evidence was gathered; nothing can be honestly claimed yet.",
        problemCategory: "unknown",
        economicImpact: "Unknown — no evidence available.",
        impactAssumptions: [],
        suggestedPriceMin: 0,
        suggestedPriceMax: 0,
        confidence: 0.05,
        validationQuestion: "Re-research this company once its website is reachable.",
        scoreComponents: {
          evidenceStrength: 0,
          painSeverity: 0,
          economicImpactScore: 0,
          deliverability: 0,
          purchaseLikelihood: 0,
          speedToValue: 0,
          reachability: 0,
          demonstrability: 0,
          repeatability: 0,
          urgency: 0,
        },
        penaltyReasons: ["WEAK_SPECULATIVE_EVIDENCE"],
      });
    });

    const outcome = await runAnalyzeTask({ db, workItem, runOpportunityAnalysis });
    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.adjustedScore).toBe(0);
    expect(outcome.opportunityId).toBeTruthy();
  });

  it("the persisted score always matches scoring.ts's deterministic output for the given components/penalties, never a model-supplied number", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const scoreComponents = {
      evidenceStrength: 18,
      painSeverity: 14,
      economicImpactScore: 13,
      deliverability: 14,
      purchaseLikelihood: 9,
      speedToValue: 4,
      reachability: 4,
      demonstrability: 4,
      repeatability: 4,
      urgency: 4,
    };
    const penaltyReasons = ["LONG_IMPLEMENTATION_CYCLE"] as const;

    const runOpportunityAnalysis = vi.fn(async () =>
      success({
        ...baseOutputFields,
        problemTitle: "Strong opportunity",
        problemDescription: "Well-evidenced problem.",
        problemCategory: "booking",
        economicImpact: "Meaningful, evidenced impact.",
        impactAssumptions: [{ assumption: "Known fact.", isKnown: true }],
        suggestedPriceMin: 1000,
        suggestedPriceMax: 2000,
        confidence: 0.85,
        validationQuestion: "Confirm final scope with the operator.",
        scoreComponents,
        penaltyReasons: [...penaltyReasons],
      }),
    );

    const outcome = await runAnalyzeTask({ db, workItem, runOpportunityAnalysis });

    const expectedRaw = calculateRawScore(scoreComponents);
    const expectedPenalties = buildPenalties([...penaltyReasons]);
    const expectedAdjusted = calculateAdjustedScore(expectedRaw, expectedPenalties);

    expect(outcome.rawScore).toBe(expectedRaw);
    expect(outcome.adjustedScore).toBe(expectedAdjusted);

    const evalRow = db
      .select()
      .from(opportunityEvaluations)
      .where(eq(opportunityEvaluations.opportunityId, outcome.opportunityId!))
      .get();
    expect(evalRow?.rawScore).toBe(expectedRaw);
    expect(evalRow?.adjustedScore).toBe(expectedAdjusted);
    expect(evalRow?.penalties).toEqual(expectedPenalties);
  });

  it("converts suggested prices from whole currency units to cents", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const runOpportunityAnalysis = vi.fn(async () =>
      success({
        ...baseOutputFields,
        problemTitle: "x",
        problemDescription: "x",
        problemCategory: "x",
        economicImpact: "x",
        impactAssumptions: [],
        suggestedPriceMin: 750,
        suggestedPriceMax: 1250,
        confidence: 0.5,
        validationQuestion: "x",
        scoreComponents: {
          evidenceStrength: 5,
          painSeverity: 5,
          economicImpactScore: 5,
          deliverability: 5,
          purchaseLikelihood: 5,
          speedToValue: 2,
          reachability: 2,
          demonstrability: 2,
          repeatability: 2,
          urgency: 2,
        },
        penaltyReasons: [],
      }),
    );

    const outcome = await runAnalyzeTask({ db, workItem, runOpportunityAnalysis });
    const opp = db.select().from(opportunities).where(eq(opportunities.id, outcome.opportunityId!)).get();
    expect(opp?.suggestedPriceMin).toBe(75000);
    expect(opp?.suggestedPriceMax).toBe(125000);
  });

  it("passes quota_exhausted through as DEFERRED, without creating an opportunity or counting a failed attempt", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runAnalyzeTask({
      db,
      workItem,
      runOpportunityAnalysis: async () => ({
        status: "quota_exhausted",
        message: "You've hit your weekly limit.",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("DEFERRED");
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("DEFERRED");
    expect(row?.attempts).toBe(0);
    expect(db.select().from(opportunities).all()).toHaveLength(0);
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runAnalyzeTask({
      db,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runOpportunityAnalysis: async () => ({
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
    const workItem = seedRunningWorkItem(company.id, 2);

    const outcome = await runAnalyzeTask({
      db,
      workItem,
      runOpportunityAnalysis: async () => ({
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
