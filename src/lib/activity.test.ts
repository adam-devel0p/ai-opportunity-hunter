import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import {
  companies,
  discoveryCampaigns,
  offers,
  opportunities,
  opportunityEvaluations,
  workItems,
} from "../db/schema.js";
import { getRecentActivity } from "./activity.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-activity-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getRecentActivity", () => {
  it("expands a completed DISCOVER item into one entry per company found in its time window", () => {
    const [campaign] = db
      .insert(discoveryCampaigns)
      .values({ name: "UK vets", criteria: {}, status: "ENABLED", createdBy: "MANUAL" })
      .returning()
      .all();

    const start = new Date("2026-01-01T10:00:00Z");
    const end = new Date("2026-01-01T10:05:00Z");
    db.insert(companies)
      .values({
        name: "Bramble Vets",
        normalizedDomain: "bramble-vets.example",
        website: "https://bramble-vets.example",
        lifecycleStatus: "DISCOVERED",
        sourceCampaignId: campaign!.id,
        firstDiscoveredAt: end,
        lastDiscoveredAt: end,
      })
      .run();
    db.insert(workItems)
      .values({
        taskType: "DISCOVER",
        entityId: campaign!.id,
        status: "COMPLETED",
        priority: 10,
        startedAt: start,
        completedAt: end,
        updatedAt: end,
      })
      .run();

    const activity = getRecentActivity(db);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.message).toBe('Discovered Bramble Vets (campaign "UK vets")');
  });

  it("reports a failed DISCOVER item with its error, not a per-company message", () => {
    const [campaign] = db
      .insert(discoveryCampaigns)
      .values({ name: "UK vets", criteria: {}, status: "ENABLED", createdBy: "MANUAL" })
      .returning()
      .all();
    db.insert(workItems)
      .values({
        taskType: "DISCOVER",
        entityId: campaign!.id,
        status: "FAILED",
        priority: 10,
        lastError: "boom",
      })
      .run();

    const activity = getRecentActivity(db);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.level).toBe("warning");
    expect(activity[0]?.message).toContain("boom");
  });

  it("describes VERIFY/BUILD_OFFER completions using the linked opportunity/company/evaluation", () => {
    const [company] = db
      .insert(companies)
      .values({
        name: "Northgate Recruitment",
        normalizedDomain: "northgate-recruitment.example",
        website: "https://northgate-recruitment.example",
        lifecycleStatus: "RESEARCHED",
      })
      .returning()
      .all();
    const [opportunity] = db
      .insert(opportunities)
      .values({
        companyId: company!.id,
        problemTitle: "Slow applicant screening",
        problemDescription: "desc",
        problemCategory: "recruitment",
        proposedSolution: "solution",
        status: "VERIFIED",
      })
      .returning()
      .all();
    db.insert(opportunityEvaluations)
      .values({
        opportunityId: opportunity!.id,
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
        adjustedScore: 87,
        verifierResult: "KEEP",
      })
      .run();
    db.insert(workItems)
      .values({
        taskType: "VERIFY",
        entityId: opportunity!.id,
        status: "COMPLETED",
        priority: 90,
        completedAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      })
      .run();

    db.insert(offers)
      .values({
        opportunityId: opportunity!.id,
        scope: "scope",
        expectedOutcome: "outcome",
        price: 140000,
        priceBand: "WORKFLOW_IMPLEMENTATION",
      })
      .run();
    db.insert(workItems)
      .values({
        taskType: "BUILD_OFFER",
        entityId: opportunity!.id,
        status: "COMPLETED",
        priority: 80,
        completedAt: new Date("2026-01-02T01:00:00Z"),
        updatedAt: new Date("2026-01-02T01:00:00Z"),
      })
      .run();

    const activity = getRecentActivity(db);
    expect(activity[0]?.message).toContain("Offer built");
    expect(activity[0]?.message).toContain("$1400");
    expect(activity[1]?.message).toBe(
      'Verifier KEEP for "Slow applicant screening" (Northgate Recruitment), adjusted score 87',
    );
  });

  it("is capped by limit and sorted newest first", () => {
    const [campaign] = db
      .insert(discoveryCampaigns)
      .values({ name: "UK vets", criteria: {}, status: "ENABLED", createdBy: "MANUAL" })
      .returning()
      .all();
    for (let i = 0; i < 5; i++) {
      db.insert(workItems)
        .values({
          taskType: "DISCOVER",
          entityId: campaign!.id,
          status: "FAILED",
          priority: 10,
          lastError: `error ${i}`,
          updatedAt: new Date(2026, 0, 1, i),
        })
        .run();
    }
    const activity = getRecentActivity(db, 3);
    expect(activity).toHaveLength(3);
    expect(activity[0]?.message).toContain("error 4");
  });
});
