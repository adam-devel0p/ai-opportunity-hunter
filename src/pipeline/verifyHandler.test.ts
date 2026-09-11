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
import type { RunSkepticAgentInput, SkepticOutput } from "../agents/skepticAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import { runVerifyTask, type VerifyWorkItemContext } from "./verifyHandler.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-verify-test-"));
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
      problemTitle: "Enquiry response-capacity friction",
      problemDescription:
        "Reviews suggest response delays; actual volume and existing automation are unknown.",
      problemCategory: "customer enquiry handling",
      economicImpact: "Potential reduction in delayed-response complaints, exact size unknown.",
      impactAssumptions: [
        { assumption: "FAQ promises replies within two business days.", isKnown: true },
      ],
      affectedRole: "front desk / reception",
      proposedSolution: "Automated enquiry classification and first-response drafting.",
      implementationStrategy: "Integrate with the existing contact form and email inbox.",
      dependencies: [],
      risks: [],
      existingAlternatives: [],
      estimatedDurationDays: 5,
      suggestedPriceMin: 60000,
      suggestedPriceMax: 150000,
      recurringRevenuePossibility: null,
      demoConcept: null,
      confidence: 0.45,
      validationQuestion: "Determine whether additional evidence supports significant enquiry volume.",
      status: "VERIFICATION_PENDING",
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
      rawScore: 55,
      penalties: [],
      adjustedScore: 55,
      ...overrides,
    })
    .returning()
    .all();
  return evaluation!;
}

function seedRunningWorkItem(opportunityId: string, attempts = 0): VerifyWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "VERIFY",
      entityId: opportunityId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.VERIFY,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: opportunityId, attempts };
}

function seedEvidence(
  companyId: string,
  opportunityId: string,
  claim: string,
  classification: "FACT" | "INFERENCE" | "HYPOTHESIS" | "UNKNOWN",
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
      opportunityId,
      sourceId: source!.id,
      claim,
      classification,
      supportingExcerpt: claim,
      confidence: 0.7,
    })
    .run();
}

function success(data: SkepticOutput): StructuredAgentResult<SkepticOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.02, durationMs: 1500 };
}

describe("runVerifyTask", () => {
  it("throws for a VERIFY item whose entityId isn't a known opportunity", async () => {
    const workItem: VerifyWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-opportunity",
      attempts: 0,
    };
    await expect(
      runVerifyTask({
        db,
        workItem,
        runSkeptic: async () =>
          success({
            result: "KEEP",
            adjustedConfidence: 0.5,
            weaknesses: [],
            unsupportedAssumptions: [],
            missingInformation: [],
            dealkillers: [],
          }),
      }),
    ).rejects.toThrow(/unknown opportunity/);
  });

  it("§88 bad-opportunity example carried through Phase 6 is REJECTed by the skeptic and fails gating regardless of score", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, {
      problemTitle: "Possible enquiry handling friction (unconfirmed)",
      problemDescription:
        "The company has a general contact form (FACT). Volume, manual processing, and urgency are not established by current evidence.",
      economicImpact: "Cannot be estimated with any confidence from current evidence.",
    });
    seedEvidence(
      company.id,
      opportunity.id,
      "Website sends enquiries through a general contact form.",
      "FACT",
    );
    // Deliberately scored high to prove REJECT alone fails the gate, not just a low score.
    seedEvaluation(opportunity.id, { evidenceStrength: 18, adjustedScore: 90, rawScore: 90 });
    const workItem = seedRunningWorkItem(opportunity.id);

    const runSkeptic = vi.fn(async (_input: RunSkepticAgentInput) =>
      success({
        result: "REJECT",
        adjustedConfidence: 0.1,
        weaknesses: [
          "High enquiry volume is asserted without evidence.",
          "Manual processing is unsupported.",
          "No evidence of urgency.",
        ],
        unsupportedAssumptions: [
          "The company processes hundreds of leads manually.",
          "A chatbot would solve the underlying problem.",
        ],
        missingInformation: ["Actual enquiry volume.", "Current handling process."],
        dealkillers: ["Economic value is entirely unknown."],
      }),
    );

    const outcome = await runVerifyTask({ db, workItem, runSkeptic });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.verifierResult).toBe("REJECT");
    expect(outcome.gatePassed).toBe(false);
    expect(outcome.gateReasons).toContain(
      "Skeptical reviewer returned REJECT, not KEEP.",
    );
    expect(outcome.opportunityStatus).toBe("VERIFIER_REJECTED");
    expect(outcome.createdBuildOfferWorkItemId).toBeNull();

    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("VERIFIER_REJECTED");

    const evalRow = db
      .select()
      .from(opportunityEvaluations)
      .where(eq(opportunityEvaluations.opportunityId, opportunity.id))
      .get();
    expect(evalRow?.verifierResult).toBe("REJECT");
    expect(evalRow?.verifierDealkillers).toEqual(["Economic value is entirely unknown."]);

    const buildOfferItems = db.select().from(workItems).where(eq(workItems.taskType, "BUILD_OFFER")).all();
    expect(buildOfferItems).toHaveLength(0);
  });

  it("a borderline-but-thin opportunity (mostly HYPOTHESIS, no strong FACT) is rejected — the skeptic's bias toward rejecting mediocre opportunities isn't just aspirational", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, {
      problemTitle: "Speculative workflow inefficiency",
      problemDescription: "It is plausible the company has some workflow inefficiency.",
    });
    seedEvidence(
      company.id,
      opportunity.id,
      "The business might benefit from better scheduling tools.",
      "HYPOTHESIS",
    );
    seedEvidence(company.id, opportunity.id, "Actual current process.", "UNKNOWN");
    // A borderline score just at/above threshold on its own — the skeptic's honest read of thin
    // evidence is what should sink it, not the score alone.
    seedEvaluation(opportunity.id, { evidenceStrength: 7, adjustedScore: 76, rawScore: 76 });
    const workItem = seedRunningWorkItem(opportunity.id);

    const runSkeptic = vi.fn(async () =>
      success({
        result: "REJECT",
        adjustedConfidence: 0.2,
        weaknesses: ["Evidence is almost entirely HYPOTHESIS/UNKNOWN, no direct FACT support."],
        unsupportedAssumptions: ["That any meaningful inefficiency exists at all."],
        missingInformation: ["Any concrete fact about current operations."],
        dealkillers: [],
      }),
    );

    const outcome = await runVerifyTask({ db, workItem, runSkeptic });

    expect(outcome.verifierResult).toBe("REJECT");
    expect(outcome.gatePassed).toBe(false);
    // Both the explicit REJECT and the evidence-strength floor should independently sink it.
    expect(outcome.gateReasons).toContain("Skeptical reviewer returned REJECT, not KEEP.");
    expect(outcome.gateReasons).toContain(
      "Evidence strength 7 is below the required floor of 10.",
    );
    expect(outcome.opportunityStatus).toBe("VERIFIER_REJECTED");
  });

  it("§89-style strong, well-evidenced opportunity passes: KEEP + score above threshold + standard risk -> VERIFIED, enqueues BUILD_OFFER", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvidence(company.id, opportunity.id, "Website sends enquiries through a general form.", "FACT");
    seedEvidence(company.id, opportunity.id, "FAQ promises replies within two business days.", "FACT");
    seedEvidence(
      company.id,
      opportunity.id,
      "Several customer reviews mention difficulty getting timely responses.",
      "FACT",
    );
    seedEvaluation(opportunity.id, { evidenceStrength: 18, adjustedScore: 87, rawScore: 87 });
    const workItem = seedRunningWorkItem(opportunity.id);

    const runSkeptic = vi.fn(async () =>
      success({
        result: "KEEP",
        adjustedConfidence: 0.75,
        weaknesses: ["Actual volume still unconfirmed."],
        unsupportedAssumptions: [],
        missingInformation: ["Exact weekly enquiry count."],
        dealkillers: [],
      }),
    );

    const outcome = await runVerifyTask({ db, workItem, runSkeptic });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.verifierResult).toBe("KEEP");
    expect(outcome.gatePassed).toBe(true);
    expect(outcome.gateReasons).toEqual([]);
    expect(outcome.opportunityStatus).toBe("VERIFIED");
    expect(outcome.createdBuildOfferWorkItemId).toBeTruthy();

    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("VERIFIED");

    const buildOfferItems = db.select().from(workItems).where(eq(workItems.taskType, "BUILD_OFFER")).all();
    expect(buildOfferItems).toHaveLength(1);
    expect(buildOfferItems[0]?.entityId).toBe(opportunity.id);
    expect(buildOfferItems[0]?.priority).toBe(TASK_TYPE_PRIORITY.BUILD_OFFER);
  });

  it("rejects a high-risk-domain opportunity by default even when the skeptic KEEPs and the score is strong", async () => {
    const company = seedCompany({ industry: "healthcare" });
    const opportunity = seedOpportunity(company.id, {
      problemTitle: "Faster patient triage",
      problemDescription: "Patients wait a long time for triage.",
      proposedSolution: "Automatically diagnose the patient's condition from reported symptoms.",
    });
    seedEvidence(company.id, opportunity.id, "Patients report long triage wait times.", "FACT");
    seedEvaluation(opportunity.id, { evidenceStrength: 18, adjustedScore: 90, rawScore: 90 });
    const workItem = seedRunningWorkItem(opportunity.id);

    const runSkeptic = vi.fn(async () =>
      success({
        result: "KEEP",
        adjustedConfidence: 0.7,
        weaknesses: [],
        unsupportedAssumptions: [],
        missingInformation: [],
        dealkillers: [],
      }),
    );

    const outcome = await runVerifyTask({ db, workItem, runSkeptic });

    expect(outcome.riskCategory).toBe("HIGH_RISK");
    expect(outcome.gatePassed).toBe(false);
    expect(outcome.gateReasons?.some((r) => r.includes("high-risk decision domain"))).toBe(true);
    expect(outcome.opportunityStatus).toBe("VERIFIER_REJECTED");
  });

  it("does not flag a healthcare company's appointment-intake automation as high risk (spec §8's own example)", async () => {
    const company = seedCompany({ industry: "healthcare" });
    const opportunity = seedOpportunity(company.id, {
      problemTitle: "Manual appointment booking",
      problemDescription: "Front desk staff spend significant time booking appointments by phone.",
      proposedSolution: "Automate appointment intake and scheduling via an online booking flow.",
    });
    seedEvidence(company.id, opportunity.id, "Front desk phone lines are frequently busy.", "FACT");
    seedEvaluation(opportunity.id, { evidenceStrength: 15, adjustedScore: 80, rawScore: 80 });
    const workItem = seedRunningWorkItem(opportunity.id);

    const runSkeptic = vi.fn(async () =>
      success({
        result: "KEEP",
        adjustedConfidence: 0.65,
        weaknesses: [],
        unsupportedAssumptions: [],
        missingInformation: [],
        dealkillers: [],
      }),
    );

    const outcome = await runVerifyTask({ db, workItem, runSkeptic });

    expect(outcome.riskCategory).toBe("STANDARD");
    expect(outcome.gatePassed).toBe(true);
    expect(outcome.opportunityStatus).toBe("VERIFIED");
  });

  it("a custom gateConfig (e.g. operator opt-in for high risk) is respected", async () => {
    const company = seedCompany({ industry: "healthcare" });
    const opportunity = seedOpportunity(company.id, {
      proposedSolution: "Automatically diagnose the patient's condition from reported symptoms.",
    });
    seedEvidence(company.id, opportunity.id, "Patients report long triage wait times.", "FACT");
    seedEvaluation(opportunity.id, { evidenceStrength: 18, adjustedScore: 90, rawScore: 90 });
    const workItem = seedRunningWorkItem(opportunity.id);

    const runSkeptic = vi.fn(async () =>
      success({
        result: "KEEP",
        adjustedConfidence: 0.7,
        weaknesses: [],
        unsupportedAssumptions: [],
        missingInformation: [],
        dealkillers: [],
      }),
    );

    const outcome = await runVerifyTask({
      db,
      workItem,
      runSkeptic,
      gateConfig: { scoreThreshold: 75, evidenceStrengthFloor: 10, allowHighRisk: true },
    });

    expect(outcome.gatePassed).toBe(true);
    expect(outcome.opportunityStatus).toBe("VERIFIED");
  });

  it("passes quota_exhausted through as DEFERRED, without mutating the opportunity or counting a failed attempt", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runVerifyTask({
      db,
      workItem,
      runSkeptic: async () => ({
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
    expect(opp?.status).toBe("VERIFICATION_PENDING");
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedEvaluation(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runVerifyTask({
      db,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runSkeptic: async () => ({
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

    const outcome = await runVerifyTask({
      db,
      workItem,
      runSkeptic: async () => ({
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
