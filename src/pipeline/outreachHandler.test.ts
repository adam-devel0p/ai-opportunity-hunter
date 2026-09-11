import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  evidenceItems,
  offers,
  opportunities,
  outreachDrafts,
  sources,
  workItems,
} from "../db/schema.js";
import type { OutreachAgentOutput, RunOutreachAgentInput } from "../agents/outreachAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import { runWriteOutreachTask, type WriteOutreachWorkItemContext } from "./outreachHandler.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-outreach-handler-test-"));
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
      status: "OUTREACH_READY",
      ...overrides,
    })
    .returning()
    .all();
  return opportunity!;
}

function seedOffer(opportunityId: string, overrides?: Partial<typeof offers.$inferInsert>) {
  const [offer] = db
    .insert(offers)
    .values({
      opportunityId,
      scope:
        "Automated applicant intake workflow that extracts candidate details, checks them against role requirements, and creates a structured recruiter review queue.",
      expectedOutcome: "Recruiters review a structured queue instead of raw applications.",
      keyAssumptions: [],
      durationEstimate: "2 days",
      price: 140000,
      recurringPrice: null,
      exclusions: "Does not include ATS replacement.",
      validationNeeded: "Confirm export format.",
      demoConcept: "A sample dashboard showing three anonymized applications.",
      priceBand: "WORKFLOW_IMPLEMENTATION",
      ...overrides,
    })
    .returning()
    .all();
  return offer!;
}

function seedContact(companyId: string, overrides?: Partial<typeof contacts.$inferInsert>) {
  const [contact] = db
    .insert(contacts)
    .values({
      companyId,
      name: "Jane Doe",
      role: "Recruitment Director",
      source: "Fetched from the company's team page.",
      profileUrl: "https://northgate-recruitment.example/team/jane-doe",
      email: "jane.doe@northgate-recruitment.example",
      emailSource: "Listed on the team page.",
      emailConfidence: "PUBLICLY_LISTED",
      ...overrides,
    })
    .returning()
    .all();
  return contact!;
}

function seedEvidence(
  companyId: string,
  opportunityId: string,
  claim: string,
  classification: "FACT" | "INFERENCE" | "HYPOTHESIS" | "UNKNOWN",
) {
  const [source] = db
    .insert(sources)
    .values({ companyId, url: "https://northgate-recruitment.example/careers", freshnessState: "FRESH" })
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

function seedRunningWorkItem(opportunityId: string, attempts = 0): WriteOutreachWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "WRITE_OUTREACH",
      entityId: opportunityId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.WRITE_OUTREACH,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: opportunityId, attempts };
}

function success(data: OutreachAgentOutput): StructuredAgentResult<OutreachAgentOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.02, durationMs: 1800 };
}

const compliantBody =
  "Hi Jane, I was looking through Northgate's recruitment process and noticed you currently " +
  "advertise several open roles with candidates applying through a general contact form. If " +
  "the first sorting step is still being done manually, I think there may be a fairly simple " +
  "automation opportunity there. I could build a workflow that extracts candidate details and " +
  "gives the recruiter a structured review. Worth a look?";

const validDraft: OutreachAgentOutput = {
  subject: "Candidate intake at Northgate",
  body: compliantBody,
};

const vagueDraft: OutreachAgentOutput = {
  subject: "Revolutionary AI for you",
  body: "Too short to pass the word count floor.",
};

describe("runWriteOutreachTask", () => {
  it("throws for a WRITE_OUTREACH item whose entityId isn't a known opportunity", async () => {
    const workItem: WriteOutreachWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-opportunity",
      attempts: 0,
    };
    await expect(
      runWriteOutreachTask({ db, workItem, runOutreach: async () => success(validDraft) }),
    ).rejects.toThrow(/unknown opportunity/);
  });

  it("throws when the opportunity has no offers row", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedContact(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    await expect(
      runWriteOutreachTask({ db, workItem, runOutreach: async () => success(validDraft) }),
    ).rejects.toThrow(/no offers row/);
  });

  it("throws when the company has no contacts row", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedOffer(opportunity.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    await expect(
      runWriteOutreachTask({ db, workItem, runOutreach: async () => success(validDraft) }),
    ).rejects.toThrow(/no contacts row/);
  });

  it("writes and persists a compliant draft, without transitioning the opportunity or enqueueing further work", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedOffer(opportunity.id);
    seedContact(company.id);
    seedEvidence(company.id, opportunity.id, "The careers page lists 6 open roles.", "FACT");
    const workItem = seedRunningWorkItem(opportunity.id);

    const runOutreach = vi.fn(async (_input: RunOutreachAgentInput) => success(validDraft));

    const outcome = await runWriteOutreachTask({ db, workItem, runOutreach });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.regenerated).toBe(false);
    expect(outcome.outreachDraftId).toBeTruthy();
    expect(runOutreach).toHaveBeenCalledTimes(1);

    const call = runOutreach.mock.calls[0]?.[0];
    expect(call?.contact.name).toBe("Jane Doe");
    expect(call?.contact.isPreferredForInitialOutreach).toBe(true);
    expect(call?.evidence).toContainEqual({
      claim: "The careers page lists 6 open roles.",
      classification: "FACT",
    });

    const draftRow = db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.opportunityId, opportunity.id))
      .get();
    expect(draftRow?.subject).toBe(validDraft.subject);
    expect(draftRow?.status).toBe("DRAFT");
    expect(draftRow?.contactId).toBeTruthy();

    // Opportunity status is left alone — sending is a manual operator action, not automatic.
    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("OUTREACH_READY");

    const laterWorkItems = db
      .select()
      .from(workItems)
      .where(eq(workItems.entityId, opportunity.id))
      .all()
      .filter((item) => item.taskType !== "WRITE_OUTREACH");
    expect(laterWorkItems).toHaveLength(0);
  });

  it("regenerates once when the first draft fails a deterministic check", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedOffer(opportunity.id);
    seedContact(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const runOutreach = vi
      .fn<(input: RunOutreachAgentInput) => Promise<StructuredAgentResult<OutreachAgentOutput>>>()
      .mockResolvedValueOnce(success(vagueDraft))
      .mockResolvedValueOnce(success(validDraft));

    const outcome = await runWriteOutreachTask({ db, workItem, runOutreach });

    expect(runOutreach).toHaveBeenCalledTimes(2);
    expect(runOutreach.mock.calls[1]?.[0].regenerationReason).toBeTruthy();
    expect(outcome.regenerated).toBe(true);
    expect(outcome.workItemStatus).toBe("COMPLETED");

    const draftRow = db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.opportunityId, opportunity.id))
      .get();
    expect(draftRow?.subject).toBe(validDraft.subject);

    const company_ = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(company_?.notes).toMatch(/regenerated once/);
  });

  it("fails the task if the draft still fails checks after one regeneration, without persisting a draft", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedOffer(opportunity.id);
    seedContact(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const runOutreach = vi.fn(async () => success(vagueDraft));

    const outcome = await runWriteOutreachTask({ db, workItem, runOutreach });

    expect(runOutreach).toHaveBeenCalledTimes(2);
    expect(outcome.workItemStatus).not.toBe("COMPLETED");
    expect(outcome.error).toMatch(/still failed/);

    const draftRow = db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.opportunityId, opportunity.id))
      .get();
    expect(draftRow).toBeUndefined();
  });

  it("passes quota_exhausted through as DEFERRED, without counting a failed attempt", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedOffer(opportunity.id);
    seedContact(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runWriteOutreachTask({
      db,
      workItem,
      runOutreach: async () => ({
        status: "quota_exhausted",
        message: "You've hit your weekly limit.",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("DEFERRED");
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("DEFERRED");
    expect(row?.attempts).toBe(0);
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    seedOffer(opportunity.id);
    seedContact(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runWriteOutreachTask({
      db,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runOutreach: async () => ({
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
    seedOffer(opportunity.id);
    seedContact(company.id);
    const workItem = seedRunningWorkItem(opportunity.id, 2);

    const outcome = await runWriteOutreachTask({
      db,
      workItem,
      runOutreach: async () => ({
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
