import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, contacts, opportunities, outreachDrafts, outreachOutcomes, workItems } from "../db/schema.js";
import { TASK_TYPE_PRIORITY } from "../pipeline/priority.js";
import {
  approveOpportunity,
  excludeCompany,
  markDraftReviewed,
  markSentManually,
  recordOutreachOutcome,
  rejectOpportunity,
  requestManualResearch,
  setCompanyDoNotContact,
  setContactDoNotContact,
} from "./dashboardActions.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-dashboard-actions-test-"));
  db = runMigrations(path.join(dir, "test.db"));
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
      lifecycleStatus: "RESEARCHED",
      ...overrides,
    })
    .returning()
    .all();
  return company!;
}

function seedOpportunity(companyId: string, overrides?: Partial<typeof opportunities.$inferInsert>) {
  const [opportunity] = db
    .insert(opportunities)
    .values({
      companyId,
      problemTitle: "Slow applicant screening",
      problemDescription: "Recruiters manually check every application.",
      problemCategory: "recruitment operations",
      proposedSolution: "Automated applicant intake workflow.",
      status: "VERIFICATION_PENDING",
      ...overrides,
    })
    .returning()
    .all();
  return opportunity!;
}

function seedContact(companyId: string) {
  const [contact] = db
    .insert(contacts)
    .values({ companyId, name: "Jane Doe", emailConfidence: "PUBLICLY_LISTED" })
    .returning()
    .all();
  return contact!;
}

function seedDraft(opportunityId: string, contactId: string, overrides?: Partial<typeof outreachDrafts.$inferInsert>) {
  const [draft] = db
    .insert(outreachDrafts)
    .values({
      opportunityId,
      contactId,
      subject: "Quick idea",
      body: "Hi Jane, ...",
      wordCount: 80,
      status: "DRAFT",
      ...overrides,
    })
    .returning()
    .all();
  return draft!;
}

describe("approveOpportunity / rejectOpportunity", () => {
  it("sets operatorVerdict to APPROVED and appends an optional note", () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    approveOpportunity(db, opportunity.id, "Looks solid.");
    const row = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(row?.operatorVerdict).toBe("APPROVED");
    expect(row?.operatorFeedback).toBe("Looks solid.");
  });

  it("sets operatorVerdict to REJECTED with a rejection reason", () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    rejectOpportunity(db, opportunity.id, "TOO_SMALL", "Not worth the effort.");
    const row = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(row?.operatorVerdict).toBe("REJECTED");
    expect(row?.rejectionReason).toBe("TOO_SMALL");
    expect(row?.operatorFeedback).toBe("Not worth the effort.");
  });

  it("throws for an unknown opportunity id", () => {
    expect(() => approveOpportunity(db, "nope")).toThrow();
  });
});

describe("markDraftReviewed / markSentManually", () => {
  it("marks a draft REVIEWED without touching the opportunity status", () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, { status: "OUTREACH_READY" });
    const contact = seedContact(company.id);
    const draft = seedDraft(opportunity.id, contact.id);

    markDraftReviewed(db, draft.id);
    const row = db.select().from(outreachDrafts).where(eq(outreachDrafts.id, draft.id)).get();
    expect(row?.status).toBe("REVIEWED");
    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("OUTREACH_READY");
  });

  it("marks SENT_MANUALLY, transitions the opportunity to SENT, and records a SENT event", () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, { status: "OUTREACH_READY" });
    const contact = seedContact(company.id);
    const draft = seedDraft(opportunity.id, contact.id, { status: "REVIEWED" });

    markSentManually(db, draft.id);

    const row = db.select().from(outreachDrafts).where(eq(outreachDrafts.id, draft.id)).get();
    expect(row?.status).toBe("SENT_MANUALLY");
    const opp = db.select().from(opportunities).where(eq(opportunities.id, opportunity.id)).get();
    expect(opp?.status).toBe("SENT");
    const outcomes = db
      .select()
      .from(outreachOutcomes)
      .where(eq(outreachOutcomes.outreachDraftId, draft.id))
      .all();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.event).toBe("SENT");
  });

  it("throws if the opportunity isn't in OUTREACH_READY (invalid transition)", () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, { status: "VERIFIED" });
    const contact = seedContact(company.id);
    const draft = seedDraft(opportunity.id, contact.id);
    expect(() => markSentManually(db, draft.id)).toThrow();
  });
});

describe("recordOutreachOutcome", () => {
  it("appends an event with an optional note", () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, { status: "SENT" });
    const contact = seedContact(company.id);
    const draft = seedDraft(opportunity.id, contact.id, { status: "SENT_MANUALLY" });

    recordOutreachOutcome(db, draft.id, "REPLIED");
    recordOutreachOutcome(db, draft.id, "INTERESTED", "Wants a call next week.");

    const outcomes = db
      .select()
      .from(outreachOutcomes)
      .where(eq(outreachOutcomes.outreachDraftId, draft.id))
      .all();
    expect(outcomes.map((o) => o.event)).toEqual(["REPLIED", "INTERESTED"]);
    expect(outcomes[1]?.note).toBe("Wants a call next week.");
  });
});

describe("requestManualResearch", () => {
  it("creates a new company at RESEARCH_PENDING and enqueues a RESEARCH work item", () => {
    const outcome = requestManualResearch(db, {
      website: "https://acme-plumbing.example",
      name: "Acme Plumbing",
    });
    expect(outcome.kind).toBe("queued");
    const company = db
      .select()
      .from(companies)
      .where(eq(companies.normalizedDomain, "acme-plumbing.example"))
      .get();
    expect(company?.lifecycleStatus).toBe("RESEARCH_PENDING");
    expect(company?.name).toBe("Acme Plumbing");

    const items = db.select().from(workItems).where(eq(workItems.entityId, company!.id)).all();
    expect(items).toHaveLength(1);
    expect(items[0]?.taskType).toBe("RESEARCH");
    expect(items[0]?.status).toBe("PENDING");
  });

  it("falls back to the normalized domain as the name when none is given", () => {
    const outcome = requestManualResearch(db, { website: "https://acme-plumbing.example" });
    expect(outcome.kind).toBe("queued");
    const company = db.select().from(companies).where(eq(companies.id, (outcome as { companyId: string }).companyId)).get();
    expect(company?.name).toBe("acme-plumbing.example");
  });

  it("does not duplicate a RESEARCH item for a company already queued", () => {
    const first = requestManualResearch(db, { website: "https://acme-plumbing.example" });
    const second = requestManualResearch(db, { website: "https://acme-plumbing.example" });
    expect(second.kind).toBe("already-queued");
    expect((second as { workItemId: string }).workItemId).toBe(
      (first as { workItemId: string }).workItemId,
    );
    const items = db
      .select()
      .from(workItems)
      .where(eq(workItems.entityId, (first as { companyId: string }).companyId))
      .all();
    expect(items).toHaveLength(1);
  });

  it("reports already-progressed for a company past RESEARCH_PENDING instead of re-enqueueing", () => {
    seedCompany({
      normalizedDomain: "acme-plumbing.example",
      website: "https://acme-plumbing.example",
      lifecycleStatus: "RESEARCHED",
    });
    const outcome = requestManualResearch(db, { website: "https://acme-plumbing.example" });
    expect(outcome).toMatchObject({ kind: "already-progressed", lifecycleStatus: "RESEARCHED" });
  });
});

describe("excludeCompany", () => {
  it("sets lifecycleStatus EXCLUDED and records the reason", () => {
    const company = seedCompany({ lifecycleStatus: "PRESCREEN_PENDING" });
    excludeCompany(db, company.id, "Operator asked never to be contacted again.");

    const updated = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updated?.lifecycleStatus).toBe("EXCLUDED");
    expect(updated?.exclusionReason).toBe("Operator asked never to be contacted again.");
  });

  it("cancels this company's own not-yet-run PRESCREEN/RESEARCH work items", () => {
    const company = seedCompany({ lifecycleStatus: "PRESCREEN_PENDING" });
    db.insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .run();

    excludeCompany(db, company.id);

    const items = db.select().from(workItems).where(eq(workItems.entityId, company.id)).all();
    expect(items[0]?.status).toBe("CANCELLED");
  });

  it("throws for an unknown company id", () => {
    expect(() => excludeCompany(db, "no-such-company")).toThrow(/No company/);
  });
});

describe("setCompanyDoNotContact / setContactDoNotContact", () => {
  it("toggles a company's DO_NOT_CONTACT flag", () => {
    const company = seedCompany();
    setCompanyDoNotContact(db, company.id, true);
    expect(db.select().from(companies).where(eq(companies.id, company.id)).get()?.doNotContact).toBe(true);

    setCompanyDoNotContact(db, company.id, false);
    expect(db.select().from(companies).where(eq(companies.id, company.id)).get()?.doNotContact).toBe(false);
  });

  it("toggles a specific contact's DO_NOT_CONTACT flag", () => {
    const company = seedCompany();
    const contact = seedContact(company.id);
    setContactDoNotContact(db, contact.id, true);
    expect(db.select().from(contacts).where(eq(contacts.id, contact.id)).get()?.doNotContact).toBe(true);
  });

  it("throws for an unknown contact id", () => {
    expect(() => setContactDoNotContact(db, "no-such-contact", true)).toThrow(/No contact/);
  });
});
