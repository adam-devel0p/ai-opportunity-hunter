import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, discoveryCampaigns, workItems } from "../db/schema.js";
import { addExclusionRule } from "../lib/exclusions.js";
import type {
  DiscoveryOutput,
  RunDiscoveryAgentInput,
} from "../agents/discoveryAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  runDiscoverTask,
  type DiscoverWorkItemContext,
} from "./discoverHandler.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-discover-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedCampaign(overrides?: { name?: string }) {
  const [campaign] = db
    .insert(discoveryCampaigns)
    .values({
      name: overrides?.name ?? "UK recruitment agencies",
      criteria: { geography: ["UK"] },
      status: "ENABLED",
      createdBy: "MANUAL",
    })
    .returning()
    .all();
  return campaign!;
}

function seedRunningWorkItem(campaignId: string): DiscoverWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "DISCOVER",
      entityId: campaignId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.DISCOVER,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: campaignId, attempts: 0 };
}

function success(data: DiscoveryOutput): StructuredAgentResult<DiscoveryOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.05, durationMs: 1000 };
}

describe("runDiscoverTask", () => {
  it("throws for a DISCOVER item whose entityId isn't a known campaign", async () => {
    const workItem: DiscoverWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-campaign",
      attempts: 0,
    };
    await expect(
      runDiscoverTask({ db, workItem, runDiscovery: async () => success({ companies: [] }) }),
    ).rejects.toThrow(/unknown campaign/);
  });

  it("inserts new companies, skips duplicates by normalized domain, and enqueues PRESCREEN only for new ones", async () => {
    const campaign = seedCampaign();

    const [existingCompany] = db
      .insert(companies)
      .values({
        name: "Already Known Ltd",
        normalizedDomain: "already-known.example",
        website: "https://already-known.example",
        lifecycleStatus: "RESEARCHED",
        sourceCampaignId: campaign.id,
      })
      .returning()
      .all();

    const workItem = seedRunningWorkItem(campaign.id);

    const canned: DiscoveryOutput = {
      companies: [
        {
          name: "Already Known Ltd",
          website: "https://www.already-known.example/about",
          country: "UK",
          industry: "recruitment",
          description: "dup",
          sizeEstimate: null,
          reasonToScreen: "dup",
        },
        {
          name: "Fresh Recruiters Ltd",
          website: "https://fresh-recruiters.example",
          country: "UK",
          industry: "recruitment",
          description: "A small recruitment agency.",
          sizeEstimate: "5-20 employees",
          reasonToScreen: "Looks like manual candidate screening.",
        },
      ],
    };

    const runDiscovery = vi.fn(async (_input: RunDiscoveryAgentInput) => success(canned));
    const outcome = await runDiscoverTask({ db, workItem, runDiscovery });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.insertedCompanyIds).toHaveLength(1);
    expect(outcome.skippedDuplicateDomains).toEqual(["already-known.example"]);
    expect(outcome.createdPrescreenWorkItemIds).toHaveLength(1);

    const allCompanies = db.select().from(companies).all();
    expect(allCompanies).toHaveLength(2);

    const freshCompany = allCompanies.find((c) => c.normalizedDomain === "fresh-recruiters.example");
    expect(freshCompany).toBeDefined();
    expect(freshCompany?.lifecycleStatus).toBe("PRESCREEN_PENDING");
    expect(freshCompany?.sourceCampaignId).toBe(campaign.id);
    expect(freshCompany?.notes).toContain("manual candidate screening");

    const prescreenItems = db
      .select()
      .from(workItems)
      .where(eq(workItems.taskType, "PRESCREEN"))
      .all();
    expect(prescreenItems).toHaveLength(1);
    expect(prescreenItems[0]?.entityId).toBe(freshCompany!.id);
    expect(prescreenItems[0]?.status).toBe("PENDING");
    expect(prescreenItems[0]?.priority).toBe(TASK_TYPE_PRIORITY.PRESCREEN);

    const finishedDiscoverItem = db
      .select()
      .from(workItems)
      .where(eq(workItems.id, workItem.id))
      .get();
    expect(finishedDiscoverItem?.status).toBe("COMPLETED");
    expect(finishedDiscoverItem?.completedAt).not.toBeNull();

    // The duplicate's lastDiscoveredAt got bumped, not a second company row.
    const dupRow = db
      .select()
      .from(companies)
      .where(eq(companies.id, existingCompany!.id))
      .get();
    expect(dupRow?.normalizedDomain).toBe("already-known.example");

    // The known-domains hint passed to the agent should include the pre-existing company.
    expect(runDiscovery.mock.calls[0]?.[0]?.knownDomains).toContain("already-known.example");
  });

  it("passes quota_exhausted through as DEFERRED, without inserting anything or counting a failed attempt", async () => {
    const campaign = seedCampaign();
    const workItem = seedRunningWorkItem(campaign.id);

    const outcome = await runDiscoverTask({
      db,
      workItem,
      runDiscovery: async () => ({
        status: "quota_exhausted",
        message: "You've hit your weekly limit.",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("DEFERRED");
    expect(outcome.insertedCompanyIds).toEqual([]);
    expect(db.select().from(companies).all()).toHaveLength(0);

    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("DEFERRED");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toContain("weekly limit");
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const campaign = seedCampaign();
    const workItem = seedRunningWorkItem(campaign.id);

    const outcome = await runDiscoverTask({
      db,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runDiscovery: async () => ({
        status: "invalid_output",
        message: "Model output did not match the expected schema.",
        attempts: 2,
      }),
    });

    expect(outcome.workItemStatus).toBe("RETRYABLE");

    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("RETRYABLE");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("did not match");
    expect(row?.runAfter?.getTime()).toBeGreaterThan(new Date("2026-06-01T00:00:00Z").getTime());
  });

  it("marks the item NON_RETRYABLE -> FAILED once attempts are exhausted", async () => {
    const campaign = seedCampaign();
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "DISCOVER",
        entityId: campaign.id,
        status: "RUNNING",
        priority: TASK_TYPE_PRIORITY.DISCOVER,
        attempts: 2,
        startedAt: new Date(),
      })
      .returning()
      .all();
    const workItem: DiscoverWorkItemContext = {
      id: item!.id,
      status: "RUNNING",
      entityId: campaign.id,
      attempts: 2,
    };

    const outcome = await runDiscoverTask({
      db,
      workItem,
      runDiscovery: async () => ({
        status: "error",
        message: "claude CLI exited with code 1",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("FAILED");
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("FAILED");
    expect(row?.attempts).toBe(3);
  });

  it("inserts a newly-discovered company straight at EXCLUDED when it matches a domain rule, without enqueueing PRESCREEN", async () => {
    const campaign = seedCampaign();
    addExclusionRule(db, { type: "DOMAIN", value: "blocked.example", reason: "Operator blacklisted this site." });
    const workItem = seedRunningWorkItem(campaign.id);

    const outcome = await runDiscoverTask({
      db,
      workItem,
      runDiscovery: async () =>
        success({
          companies: [
            {
              name: "Blocked Co",
              website: "https://blocked.example",
              country: "UK",
              industry: "recruitment",
              description: "n/a",
              sizeEstimate: null,
              reasonToScreen: "n/a",
            },
          ],
        }),
    });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.insertedCompanyIds).toEqual([]);
    expect(outcome.excludedCompanyIds).toHaveLength(1);

    const company = db.select().from(companies).where(eq(companies.normalizedDomain, "blocked.example")).get();
    expect(company?.lifecycleStatus).toBe("EXCLUDED");
    expect(company?.exclusionReason).toContain("Operator blacklisted this site.");

    expect(db.select().from(workItems).where(eq(workItems.taskType, "PRESCREEN")).all()).toHaveLength(0);
  });

  it("inserts a newly-discovered company straight at EXCLUDED when it matches an industry/country rule", async () => {
    const campaign = seedCampaign();
    addExclusionRule(db, { type: "COUNTRY", value: "RU" });
    const workItem = seedRunningWorkItem(campaign.id);

    const outcome = await runDiscoverTask({
      db,
      workItem,
      runDiscovery: async () =>
        success({
          companies: [
            {
              name: "Moscow Co",
              website: "https://moscow-co.example",
              country: "RU",
              industry: "recruitment",
              description: "n/a",
              sizeEstimate: null,
              reasonToScreen: "n/a",
            },
          ],
        }),
    });

    expect(outcome.excludedCompanyIds).toHaveLength(1);
    const company = db.select().from(companies).where(eq(companies.normalizedDomain, "moscow-co.example")).get();
    expect(company?.lifecycleStatus).toBe("EXCLUDED");
  });

  it("retroactively excludes an already-known company on rediscovery once a matching rule exists", async () => {
    const campaign = seedCampaign();
    const [existingCompany] = db
      .insert(companies)
      .values({
        name: "Gambling Co",
        normalizedDomain: "gambling-co.example",
        website: "https://gambling-co.example",
        industry: "gambling",
        lifecycleStatus: "PRESCREEN_PENDING",
        sourceCampaignId: campaign.id,
      })
      .returning()
      .all();
    addExclusionRule(db, { type: "INDUSTRY", value: "gambling" });
    const workItem = seedRunningWorkItem(campaign.id);

    await runDiscoverTask({
      db,
      workItem,
      runDiscovery: async () =>
        success({
          companies: [
            {
              name: "Gambling Co",
              website: "https://gambling-co.example",
              country: "UK",
              industry: "gambling",
              description: "n/a",
              sizeEstimate: null,
              reasonToScreen: "n/a",
            },
          ],
        }),
    });

    const row = db.select().from(companies).where(eq(companies.id, existingCompany!.id)).get();
    expect(row?.lifecycleStatus).toBe("EXCLUDED");
  });

  it("handles a discovery result with zero companies without error", async () => {
    const campaign = seedCampaign();
    const workItem = seedRunningWorkItem(campaign.id);

    const outcome = await runDiscoverTask({
      db,
      workItem,
      runDiscovery: async () => success({ companies: [] }),
    });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.insertedCompanyIds).toEqual([]);
    expect(outcome.createdPrescreenWorkItemIds).toEqual([]);
  });
});
