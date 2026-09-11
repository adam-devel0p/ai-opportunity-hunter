import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  evidenceItems,
  offers,
  opportunities,
  opportunityEvaluations,
  outreachDrafts,
  sources,
} from "../db/schema.js";
import {
  getCompanyDetail,
  getOpportunityDetail,
  getSummaryMetrics,
  listCompanies,
  listOpportunities,
} from "./dashboardQueries.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-dashboard-queries-test-"));
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
      country: "UK",
      industry: "recruitment",
      description: "A small independent recruitment agency.",
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

describe("getSummaryMetrics", () => {
  it("counts each metric per its own definition", () => {
    const discovered = seedCompany({ lifecycleStatus: "DISCOVERED" });
    seedCompany({
      normalizedDomain: "b.example",
      website: "https://b.example",
      lifecycleStatus: "RESEARCH_PENDING",
    });
    const researched = seedCompany({
      normalizedDomain: "c.example",
      website: "https://c.example",
      lifecycleStatus: "RESEARCHED",
    });

    const strongOpp = seedOpportunity(researched.id, { status: "OFFER_READY" });
    seedOpportunity(researched.id, {
      problemTitle: "second",
      status: "VERIFIER_REJECTED",
    });
    void discovered;
    void strongOpp;

    const metrics = getSummaryMetrics(db);
    expect(metrics.companiesDiscovered).toBe(3);
    expect(metrics.companiesScreened).toBe(2); // RESEARCH_PENDING + RESEARCHED
    expect(metrics.companiesAwaitingResearch).toBe(1);
    expect(metrics.companiesResearched).toBe(1);
    expect(metrics.opportunitiesGenerated).toBe(2);
    expect(metrics.opportunitiesRejected).toBe(1);
    expect(metrics.strongOpportunities).toBe(1);
  });

  it("counts an operator-rejected opportunity as rejected even if the pipeline verified it", () => {
    const company = seedCompany();
    seedOpportunity(company.id, { status: "VERIFIED", operatorVerdict: "REJECTED" });
    const metrics = getSummaryMetrics(db);
    expect(metrics.opportunitiesRejected).toBe(1);
  });
});

describe("listOpportunities", () => {
  it("joins company + evaluation and supports search/status/score filters", () => {
    const companyA = seedCompany();
    const companyB = seedCompany({
      name: "Bramble Vets",
      normalizedDomain: "bramble-vets.example",
      website: "https://bramble-vets.example",
      industry: "veterinary",
      country: "US",
    });
    const oppA = seedOpportunity(companyA.id, { status: "VERIFIED" });
    seedEvaluation(oppA.id, { adjustedScore: 80 });
    const oppB = seedOpportunity(companyB.id, {
      problemTitle: "Appointment no-shows",
      status: "VERIFICATION_PENDING",
    });
    seedEvaluation(oppB.id, { adjustedScore: 40 });

    expect(listOpportunities(db)).toHaveLength(2);
    expect(listOpportunities(db, { status: "VERIFIED" })).toHaveLength(1);
    expect(listOpportunities(db, { minScore: 60 }).map((o) => o.id)).toEqual([oppA.id]);
    expect(listOpportunities(db, { industry: "veterinary" }).map((o) => o.id)).toEqual([oppB.id]);
    expect(listOpportunities(db, { search: "bramble" }).map((o) => o.id)).toEqual([oppB.id]);
    expect(listOpportunities(db, { search: "bramble-vets.example" }).map((o) => o.id)).toEqual([
      oppB.id,
    ]);
  });
});

describe("getOpportunityDetail", () => {
  it("returns undefined for an unknown id", () => {
    expect(getOpportunityDetail(db, "does-not-exist")).toBeUndefined();
  });

  it("assembles the full evidence trail, offer, contact, and outreach draft", () => {
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id, { status: "OUTREACH_READY" });
    seedEvaluation(opportunity.id, { verifierResult: "KEEP" });

    const [source] = db
      .insert(sources)
      .values({ companyId: company.id, url: "https://northgate-recruitment.example/careers", freshnessState: "FRESH" })
      .returning()
      .all();
    db.insert(evidenceItems)
      .values({
        companyId: company.id,
        opportunityId: opportunity.id,
        sourceId: source!.id,
        claim: "The careers page lists 12 open roles.",
        classification: "FACT",
        confidence: 0.9,
      })
      .run();

    db.insert(offers)
      .values({
        opportunityId: opportunity.id,
        scope: "Automate intake.",
        expectedOutcome: "Faster screening.",
        price: 140000,
        priceBand: "WORKFLOW_IMPLEMENTATION",
      })
      .run();

    db.insert(contacts)
      .values({
        companyId: company.id,
        name: "Jane Doe",
        emailConfidence: "PUBLICLY_LISTED",
      })
      .run();

    db.insert(outreachDrafts)
      .values({
        opportunityId: opportunity.id,
        contactId: db.select().from(contacts).all()[0]!.id,
        subject: "Quick idea for your applicant screening",
        body: "Hi Jane, ...",
        wordCount: 80,
        status: "DRAFT",
      })
      .run();

    const detail = getOpportunityDetail(db, opportunity.id);
    expect(detail?.company.id).toBe(company.id);
    expect(detail?.evaluation?.verifierResult).toBe("KEEP");
    expect(detail?.evidence).toHaveLength(1);
    expect(detail?.evidence[0]?.sourceUrl).toBe("https://northgate-recruitment.example/careers");
    expect(detail?.offer?.price).toBe(140000);
    expect(detail?.contact?.name).toBe("Jane Doe");
    expect(detail?.outreachDraft?.subject).toContain("Quick idea");
  });
});

describe("getCompanyDetail", () => {
  it("returns undefined for an unknown id", () => {
    expect(getCompanyDetail(db, "does-not-exist")).toBeUndefined();
  });

  it("returns the company plus its opportunities, newest first", () => {
    const company = seedCompany();
    seedOpportunity(company.id, { problemTitle: "first", createdAt: new Date(2026, 0, 1) });
    const second = seedOpportunity(company.id, {
      problemTitle: "second",
      createdAt: new Date(2026, 0, 2),
    });

    const detail = getCompanyDetail(db, company.id);
    expect(detail?.company.id).toBe(company.id);
    expect(detail?.opportunities[0]?.id).toBe(second.id);
    expect(detail?.opportunities).toHaveLength(2);
  });
});

describe("listCompanies", () => {
  it("filters by lifecycle status and search", () => {
    seedCompany({ lifecycleStatus: "DISCOVERED" });
    seedCompany({
      name: "Bramble Vets",
      normalizedDomain: "bramble-vets.example",
      website: "https://bramble-vets.example",
      lifecycleStatus: "RESEARCHED",
    });

    expect(listCompanies(db)).toHaveLength(2);
    expect(listCompanies(db, { lifecycleStatus: "RESEARCHED" })).toHaveLength(1);
    expect(listCompanies(db, { search: "bramble" })).toHaveLength(1);
  });
});
