import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import type { Db } from "./client.js";
import {
  companies,
  contacts,
  discoveryCampaigns,
  evidenceItems,
  offers,
  opportunities,
  opportunityEvaluations,
  outreachDrafts,
  outreachOutcomes,
  promptVersions,
  sources,
  systemConfig,
  workItems,
} from "./schema.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-db-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("apply cleanly against a fresh database file", () => {
    // beforeEach already ran the migration; a query against every table
    // confirms the tables actually exist.
    expect(db.select().from(companies).all()).toEqual([]);
    expect(db.select().from(workItems).all()).toEqual([]);
  });
});

describe("insert/read round trips", () => {
  it("discovery_campaigns", () => {
    const [row] = db
      .insert(discoveryCampaigns)
      .values({
        name: "UK recruitment agencies",
        criteria: { geography: ["UK"], industry: ["recruitment"] },
        status: "ENABLED",
        createdBy: "MANUAL",
      })
      .returning()
      .all();
    expect(row?.name).toBe("UK recruitment agencies");
    expect(row?.criteria).toEqual({
      geography: ["UK"],
      industry: ["recruitment"],
    });

    const found = db
      .select()
      .from(discoveryCampaigns)
      .where(eq(discoveryCampaigns.id, row!.id))
      .get();
    expect(found?.status).toBe("ENABLED");
  });

  it("companies, and rejects a duplicate normalizedDomain", () => {
    const [campaign] = db
      .insert(discoveryCampaigns)
      .values({
        name: "campaign",
        criteria: {},
        status: "ENABLED",
        createdBy: "MANUAL",
      })
      .returning()
      .all();

    const [company] = db
      .insert(companies)
      .values({
        name: "Acme Ltd",
        normalizedDomain: "acme.example",
        website: "https://www.acme.example/",
        lifecycleStatus: "DISCOVERED",
        sourceCampaignId: campaign!.id,
      })
      .returning()
      .all();
    expect(company?.normalizedDomain).toBe("acme.example");
    expect(company?.doNotContact).toBe(false);

    expect(() =>
      db
        .insert(companies)
        .values({
          name: "Acme Ltd (duplicate)",
          normalizedDomain: "acme.example",
          website: "https://acme.example/about",
          lifecycleStatus: "DISCOVERED",
        })
        .run(),
    ).toThrow();
  });

  it("full downstream chain: opportunity, source, evidence, evaluation, offer, contact, outreach draft/outcome", () => {
    const [company] = db
      .insert(companies)
      .values({
        name: "Acme Ltd",
        normalizedDomain: "acme2.example",
        website: "https://acme2.example",
        lifecycleStatus: "RESEARCHED",
      })
      .returning()
      .all();

    const [workItem] = db
      .insert(workItems)
      .values({
        taskType: "RESEARCH",
        entityId: company!.id,
        status: "COMPLETED",
        priority: 10,
      })
      .returning()
      .all();

    const [opportunity] = db
      .insert(opportunities)
      .values({
        companyId: company!.id,
        problemTitle: "Manual intake process",
        problemDescription: "Leads are logged by hand into a spreadsheet.",
        problemCategory: "manual-data-entry",
        proposedSolution: "Automate intake with a simple form + webhook.",
        status: "OPPORTUNITY_IDENTIFIED",
        impactAssumptions: ["2 staff", "5h/week"],
        dependencies: [],
        risks: ["Owner may resist changing existing process"],
      })
      .returning()
      .all();
    expect(opportunity?.impactAssumptions).toEqual(["2 staff", "5h/week"]);

    const [source] = db
      .insert(sources)
      .values({
        companyId: company!.id,
        url: "https://acme2.example/about",
        title: "About Acme",
        fetchedByTaskId: workItem!.id,
        freshnessState: "FRESH",
      })
      .returning()
      .all();

    const [evidence] = db
      .insert(evidenceItems)
      .values({
        companyId: company!.id,
        opportunityId: opportunity!.id,
        sourceId: source!.id,
        claim: "The about page mentions a 5-person operations team.",
        classification: "FACT",
        confidence: 0.9,
        generatedByTaskId: workItem!.id,
      })
      .returning()
      .all();
    expect(evidence?.sourceId).toBe(source!.id);

    const [evaluation] = db
      .insert(opportunityEvaluations)
      .values({
        opportunityId: opportunity!.id,
        evidenceStrength: 15,
        painSeverity: 10,
        economicImpactScore: 10,
        deliverability: 12,
        purchaseLikelihood: 7,
        speedToValue: 3,
        reachability: 4,
        demonstrability: 3,
        repeatability: 2,
        urgency: 3,
        rawScore: 69,
        penalties: [{ reason: "LONG_IMPLEMENTATION_CYCLE", amount: 5 }],
        adjustedScore: 64,
      })
      .returning()
      .all();
    expect(evaluation?.penalties).toEqual([
      { reason: "LONG_IMPLEMENTATION_CYCLE", amount: 5 },
    ]);

    const [offer] = db
      .insert(offers)
      .values({
        opportunityId: opportunity!.id,
        scope: "Build a webhook-based intake form",
        expectedOutcome: "Eliminate manual re-typing of lead data",
        price: 120000,
        priceBand: "SMALL_AUTOMATION",
      })
      .returning()
      .all();

    const [contact] = db
      .insert(contacts)
      .values({
        companyId: company!.id,
        name: "Jamie Smith",
        role: "Operations Manager",
        emailConfidence: "PUBLICLY_LISTED",
        email: "jamie@acme2.example",
      })
      .returning()
      .all();

    const [draft] = db
      .insert(outreachDrafts)
      .values({
        opportunityId: opportunity!.id,
        contactId: contact!.id,
        subject: "Quick question about your lead intake",
        body: "Hi Jamie, ...",
        wordCount: 42,
        status: "DRAFT",
      })
      .returning()
      .all();

    const [outcome] = db
      .insert(outreachOutcomes)
      .values({
        outreachDraftId: draft!.id,
        event: "SENT",
      })
      .returning()
      .all();

    expect(offer?.priceBand).toBe("SMALL_AUTOMATION");
    expect(contact?.emailConfidence).toBe("PUBLICLY_LISTED");
    expect(draft?.status).toBe("DRAFT");
    expect(outcome?.event).toBe("SENT");
  });

  it("system_config", () => {
    db.insert(systemConfig)
      .values({ key: "autonomousMode", value: false })
      .run();
    const row = db
      .select()
      .from(systemConfig)
      .where(eq(systemConfig.key, "autonomousMode"))
      .get();
    expect(row?.value).toBe(false);
  });

  it("prompt_versions", () => {
    const [row] = db
      .insert(promptVersions)
      .values({
        id: `deep-research@${randomUUID()}`,
        agentType: "deep-research",
        version: 1,
        template: "Research this company...",
      })
      .returning()
      .all();
    expect(row?.agentType).toBe("deep-research");
  });
});
