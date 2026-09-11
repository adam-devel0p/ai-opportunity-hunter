import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  discoveryCampaigns,
  offers,
  opportunities,
  opportunityEvaluations,
  outreachDrafts,
  outreachOutcomes,
} from "../db/schema.js";
import {
  computeAverageStat,
  computeRateStat,
  getOverallOutcomeMetrics,
  getPerformanceByDimension,
} from "./outcomeAnalytics.js";

let dir: string;
let db: Db;
let companyCounter: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-outcome-analytics-test-"));
  db = runMigrations(path.join(dir, "test.db"));
  companyCounter = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedCompany(overrides?: Partial<typeof companies.$inferInsert>) {
  companyCounter += 1;
  const [company] = db
    .insert(companies)
    .values({
      name: `Company ${companyCounter}`,
      normalizedDomain: `company-${companyCounter}.example`,
      website: `https://company-${companyCounter}.example`,
      country: "UK",
      industry: "veterinary",
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
      problemTitle: "Slow intake",
      problemDescription: "Manual intake process.",
      problemCategory: "operations",
      proposedSolution: "Automate intake.",
      status: "SENT",
      ...overrides,
    })
    .returning()
    .all();
  return opportunity!;
}

function seedEvaluation(opportunityId: string, adjustedScore: number) {
  db.insert(opportunityEvaluations)
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
      rawScore: adjustedScore,
      penalties: [],
      adjustedScore,
    })
    .run();
}

function seedOffer(opportunityId: string, priceBand: (typeof offers.$inferSelect)["priceBand"]) {
  db.insert(offers)
    .values({
      opportunityId,
      scope: "Automate intake.",
      expectedOutcome: "Faster intake.",
      price: 100000,
      priceBand,
    })
    .run();
}

/** Seeds a company -> opportunity -> sent outreach draft, with optional outcome events beyond
 * SENT. Returns the draft id. */
function seedSentOutreach(options: {
  industry?: string | null;
  country?: string | null;
  problemCategory?: string;
  priceBand?: (typeof offers.$inferSelect)["priceBand"];
  campaignId?: string | null;
  adjustedScore?: number;
  events?: (typeof outreachOutcomes.$inferSelect)["event"][];
}) {
  const company = seedCompany({
    industry: options.industry === undefined ? "veterinary" : options.industry,
    country: options.country === undefined ? "UK" : options.country,
    sourceCampaignId: options.campaignId === undefined ? null : options.campaignId,
  });
  const opportunity = seedOpportunity(company.id, {
    problemCategory: options.problemCategory ?? "operations",
  });
  if (options.adjustedScore != null) seedEvaluation(opportunity.id, options.adjustedScore);
  seedOffer(opportunity.id, options.priceBand ?? "SMALL_AUTOMATION");

  const [contact] = db
    .insert(contacts)
    .values({ companyId: company.id, name: "Jane Doe", emailConfidence: "PUBLICLY_LISTED" })
    .returning()
    .all();

  const [draft] = db
    .insert(outreachDrafts)
    .values({
      opportunityId: opportunity.id,
      contactId: contact!.id,
      subject: "Quick idea",
      body: "Hi Jane, ...",
      wordCount: 80,
      status: "SENT_MANUALLY",
    })
    .returning()
    .all();

  db.insert(outreachOutcomes).values({ outreachDraftId: draft!.id, event: "SENT" }).run();
  for (const event of options.events ?? []) {
    db.insert(outreachOutcomes).values({ outreachDraftId: draft!.id, event }).run();
  }

  return draft!.id;
}

describe("computeRateStat", () => {
  it("reports null rate and unreliable for a zero denominator", () => {
    const stat = computeRateStat(0, 0, 5);
    expect(stat.rate).toBeNull();
    expect(stat.reliable).toBe(false);
  });

  it("flags a tiny-sample 100% rate as unreliable", () => {
    const stat = computeRateStat(1, 1, 5);
    expect(stat.rate).toBe(1);
    expect(stat.reliable).toBe(false);
  });

  it("flags a rate as reliable once the denominator reaches the threshold", () => {
    const stat = computeRateStat(2, 5, 5);
    expect(stat.rate).toBe(0.4);
    expect(stat.reliable).toBe(true);
  });
});

describe("computeAverageStat", () => {
  it("reports null average for no values", () => {
    const stat = computeAverageStat([], 5);
    expect(stat.average).toBeNull();
    expect(stat.reliable).toBe(false);
  });

  it("computes the mean and flags reliability by sample size", () => {
    expect(computeAverageStat([10, 20], 5)).toMatchObject({ average: 15, sampleSize: 2, reliable: false });
    expect(computeAverageStat([10, 20, 30, 40, 50], 5)).toMatchObject({
      average: 30,
      sampleSize: 5,
      reliable: true,
    });
  });
});

describe("getOverallOutcomeMetrics", () => {
  it("returns zeroed/null stats when nothing has been sent yet", () => {
    const metrics = getOverallOutcomeMetrics(db);
    expect(metrics.sentCount).toBe(0);
    expect(metrics.replyRate).toMatchObject({ rate: null, reliable: false });
  });

  it("computes reply/positive/meeting/win rates from outcome events, ignoring un-sent drafts", () => {
    seedSentOutreach({ adjustedScore: 80, events: ["REPLIED", "INTERESTED", "MEETING", "WON"] });
    seedSentOutreach({ adjustedScore: 40, events: ["NO_REPLY"] });

    // A draft that was never sent (no SENT event) must not count toward the denominator.
    const company = seedCompany();
    const opportunity = seedOpportunity(company.id);
    const [contact] = db
      .insert(contacts)
      .values({ companyId: company.id, name: "Unsent Contact", emailConfidence: "GUESSED" })
      .returning()
      .all();
    db.insert(outreachDrafts)
      .values({
        opportunityId: opportunity.id,
        contactId: contact!.id,
        subject: "Draft only",
        body: "...",
        wordCount: 80,
        status: "DRAFT",
      })
      .run();

    const metrics = getOverallOutcomeMetrics(db, 5);
    expect(metrics.sentCount).toBe(2);
    expect(metrics.replyRate).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5, reliable: false });
    expect(metrics.positiveReplyRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(metrics.meetingRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(metrics.winRate).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it("splits average score by replied vs. not-replied for score-vs-response", () => {
    seedSentOutreach({ adjustedScore: 90, events: ["REPLIED"] });
    seedSentOutreach({ adjustedScore: 70, events: ["REPLIED"] });
    seedSentOutreach({ adjustedScore: 20, events: ["NO_REPLY"] });

    const metrics = getOverallOutcomeMetrics(db);
    expect(metrics.scoreVsResponse.repliedAverageScore.average).toBe(80);
    expect(metrics.scoreVsResponse.notRepliedAverageScore.average).toBe(20);
    // averageOpportunityScore covers every scored opportunity, not just sent ones.
    expect(metrics.averageOpportunityScore.sampleSize).toBe(3);
  });
});

describe("getPerformanceByDimension", () => {
  it("groups by industry and computes per-group rates", () => {
    seedSentOutreach({ industry: "veterinary", events: ["REPLIED"] });
    seedSentOutreach({ industry: "veterinary", events: [] });
    seedSentOutreach({ industry: "recruitment", events: ["REPLIED", "WON"] });

    const rows = getPerformanceByDimension(db, "industry", 5);
    const vet = rows.find((r) => r.dimensionValue === "veterinary");
    const recruitment = rows.find((r) => r.dimensionValue === "recruitment");

    expect(vet).toMatchObject({ sentCount: 2 });
    expect(vet?.replyRate.rate).toBe(0.5);
    expect(recruitment).toMatchObject({ sentCount: 1 });
    expect(recruitment?.winRate.rate).toBe(1);
    expect(recruitment?.winRate.reliable).toBe(false);
  });

  it("falls back to a stable Unknown/Manual label when the dimension value is missing", () => {
    seedSentOutreach({ industry: null, country: null });

    const industryRows = getPerformanceByDimension(db, "industry");
    expect(industryRows[0]?.dimensionValue).toBe("Unknown");

    const campaignRows = getPerformanceByDimension(db, "campaign");
    expect(campaignRows[0]?.dimensionValue).toBe("Manual / no campaign");
  });

  it("attributes performance to the sourcing campaign", () => {
    const [campaign] = db
      .insert(discoveryCampaigns)
      .values({
        name: "Vet clinics UK",
        criteria: { industry: ["veterinary"] },
        status: "ENABLED",
        createdBy: "MANUAL",
      })
      .returning()
      .all();

    seedSentOutreach({ campaignId: campaign!.id, events: ["REPLIED"] });
    seedSentOutreach({ campaignId: undefined, events: [] });

    const rows = getPerformanceByDimension(db, "campaign");
    expect(rows.find((r) => r.dimensionValue === "Vet clinics UK")?.sentCount).toBe(1);
    expect(rows.find((r) => r.dimensionValue === "Manual / no campaign")?.sentCount).toBe(1);
  });

  it("groups by price band", () => {
    seedSentOutreach({ priceBand: "MICRO_FIX", events: ["REPLIED"] });
    seedSentOutreach({ priceBand: "LARGER_IMPLEMENTATION", events: [] });

    const rows = getPerformanceByDimension(db, "priceBand");
    expect(rows.find((r) => r.dimensionValue === "MICRO_FIX")?.replyRate.rate).toBe(1);
    expect(rows.find((r) => r.dimensionValue === "LARGER_IMPLEMENTATION")?.replyRate.rate).toBe(0);
  });

  it("sorts groups by sent count, descending", () => {
    seedSentOutreach({ problemCategory: "small" });
    seedSentOutreach({ problemCategory: "big" });
    seedSentOutreach({ problemCategory: "big" });

    const rows = getPerformanceByDimension(db, "problemCategory");
    expect(rows.map((r) => r.dimensionValue)).toEqual(["big", "small"]);
  });
});
