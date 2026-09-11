import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, contacts, opportunities, workItems } from "../db/schema.js";
import type { ContactAgentOutput, RunContactAgentInput } from "../agents/contactAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import { runFindContactTask, type FindContactWorkItemContext } from "./contactHandler.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-contact-handler-test-"));
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
      status: "CONTACT_RESEARCH",
      ...overrides,
    })
    .returning()
    .all();
  return opportunity!;
}

function seedRunningWorkItem(opportunityId: string, attempts = 0): FindContactWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "FIND_CONTACT",
      entityId: opportunityId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.FIND_CONTACT,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: opportunityId, attempts };
}

function success(data: ContactAgentOutput): StructuredAgentResult<ContactAgentOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.01, durationMs: 1500 };
}

const publiclyListedContact: ContactAgentOutput = {
  name: "Jane Doe",
  role: "Recruitment Director",
  source: "Fetched from the company's team page.",
  profileUrl: "https://northgate-recruitment.example/team/jane-doe",
  email: "jane.doe@northgate-recruitment.example",
  emailSource: "Listed on the team page.",
  emailConfidence: "PUBLICLY_LISTED",
};

const guessedContact: ContactAgentOutput = {
  ...publiclyListedContact,
  emailSource: "Inferred from a firstname.lastname@domain pattern.",
  emailConfidence: "GUESSED",
};

const unknownContact: ContactAgentOutput = {
  name: "Recruitment Director",
  role: "Recruitment Director",
  source: "No specific named individual found; targeting the role directly.",
  profileUrl: null,
  email: null,
  emailSource: null,
  emailConfidence: "UNKNOWN",
};

describe("runFindContactTask", () => {
  it("throws for a FIND_CONTACT item whose entityId isn't a known opportunity", async () => {
    const workItem: FindContactWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-opportunity",
      attempts: 0,
    };
    await expect(
      runFindContactTask({ db, workItem, runContact: async () => success(unknownContact) }),
    ).rejects.toThrow(/unknown opportunity/);
  });

  it("persists a contact, transitions the opportunity, and enqueues WRITE_OUTREACH", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const runContact = vi.fn(async (_input: RunContactAgentInput) => success(publiclyListedContact));

    const outcome = await runFindContactTask({ db, workItem, runContact });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.opportunityStatus).toBe("OUTREACH_READY");
    expect(outcome.emailConfidence).toBe("PUBLICLY_LISTED");
    expect(outcome.isVerifiedEmail).toBe(false);
    expect(outcome.isPreferredForInitialOutreach).toBe(true);
    expect(outcome.createdWriteOutreachWorkItemId).toBeTruthy();
    expect(runContact).toHaveBeenCalledTimes(1);

    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("OUTREACH_READY");

    const contactRow = db.select().from(contacts).where(eq(contacts.companyId, company.id)).get();
    expect(contactRow?.name).toBe("Jane Doe");
    expect(contactRow?.emailConfidence).toBe("PUBLICLY_LISTED");

    const writeOutreachItems = db
      .select()
      .from(workItems)
      .where(eq(workItems.taskType, "WRITE_OUTREACH"))
      .all();
    expect(writeOutreachItems).toHaveLength(1);
    expect(writeOutreachItems[0]?.entityId).toBe(opportunity.id);
    expect(writeOutreachItems[0]?.priority).toBe(TASK_TYPE_PRIORITY.WRITE_OUTREACH);
  });

  it("still forms a contact and advances the opportunity for a GUESSED email, but never as verified", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runFindContactTask({
      db,
      workItem,
      runContact: async () => success(guessedContact),
    });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.emailConfidence).toBe("GUESSED");
    expect(outcome.isVerifiedEmail).toBe(false);
    expect(outcome.isPreferredForInitialOutreach).toBe(false);

    const contactRow = db.select().from(contacts).where(eq(contacts.companyId, company.id)).get();
    expect(contactRow?.emailConfidence).toBe("GUESSED");

    const company_ = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(company_?.notes).toMatch(/GUESSED/);
  });

  it("still forms a contact when no named individual or email is found (UNKNOWN)", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runFindContactTask({
      db,
      workItem,
      runContact: async () => success(unknownContact),
    });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.emailConfidence).toBe("UNKNOWN");
    expect(outcome.opportunityStatus).toBe("OUTREACH_READY");

    const contactRow = db.select().from(contacts).where(eq(contacts.companyId, company.id)).get();
    expect(contactRow?.email).toBeNull();
  });

  it("passes quota_exhausted through as DEFERRED, without mutating the opportunity or counting a failed attempt", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runFindContactTask({
      db,
      workItem,
      runContact: async () => ({
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
    expect(opp?.status).toBe("CONTACT_RESEARCH");
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    const workItem = seedRunningWorkItem(opportunity.id);

    const outcome = await runFindContactTask({
      db,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runContact: async () => ({
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
    const workItem = seedRunningWorkItem(opportunity.id, 2);

    const outcome = await runFindContactTask({
      db,
      workItem,
      runContact: async () => ({
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
