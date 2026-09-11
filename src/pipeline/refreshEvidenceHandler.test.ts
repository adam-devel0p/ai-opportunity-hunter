import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, evidenceItems, sources, workItems } from "../db/schema.js";
import type { DeepResearchOutput, RunDeepResearchAgentInput } from "../agents/deepResearchAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { computeNextEligibleResearchAt } from "../lib/researchFreshness.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  runRefreshEvidenceTask,
  type RefreshEvidenceWorkItemContext,
} from "./refreshEvidenceHandler.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-refresh-evidence-test-"));
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
      lastResearchedAt: new Date("2026-01-01T00:00:00Z"),
      nextEligibleResearchAt: new Date("2026-04-01T00:00:00Z"),
      ...overrides,
    })
    .returning()
    .all();
  return company!;
}

function seedRunningWorkItem(companyId: string, attempts = 0): RefreshEvidenceWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "REFRESH_EVIDENCE",
      entityId: companyId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.REFRESH_EVIDENCE,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: companyId, attempts };
}

function seedSource(taskId: string, companyId: string, url: string) {
  const [source] = db
    .insert(sources)
    .values({ companyId, url, fetchedByTaskId: taskId, freshnessState: "FRESH" })
    .returning()
    .all();
  return source!;
}

function success(data: DeepResearchOutput): StructuredAgentResult<DeepResearchOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.04, durationMs: 2500 };
}

describe("runRefreshEvidenceTask", () => {
  it("throws for a REFRESH_EVIDENCE item whose entityId isn't a known company", async () => {
    const workItem: RefreshEvidenceWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-company",
      attempts: 0,
    };
    await expect(
      runRefreshEvidenceTask({
        db,
        dbPath,
        workItem,
        runDeepResearch: async () => success({ evidence: [], candidateProblems: [] }),
      }),
    ).rejects.toThrow(/unknown company/);
  });

  it("throws when the targeted company isn't RESEARCHED or NO_OPPORTUNITY", async () => {
    const company = seedCompany({ lifecycleStatus: "RESEARCH_PENDING" });
    const workItem = seedRunningWorkItem(company.id);
    await expect(
      runRefreshEvidenceTask({
        db,
        dbPath,
        workItem,
        runDeepResearch: async () => success({ evidence: [], candidateProblems: [] }),
      }),
    ).rejects.toThrow(/RESEARCH_PENDING/);
  });

  it("persists new verified evidence, resets the freshness window, and enqueues ANALYZE, without changing lifecycleStatus", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);
    seedSource(workItem.id, company.id, "https://acme-vet.example/careers");

    const runDeepResearch = vi.fn(async (_input: RunDeepResearchAgentInput) =>
      success({
        evidence: [
          {
            claim: "The clinic is now hiring two additional vet techs.",
            classification: "FACT",
            supportingExcerpt: "Now hiring: 2x Veterinary Technician",
            sourceUrl: "https://acme-vet.example/careers",
            confidence: 0.9,
          },
        ],
        candidateProblems: ["Growing staff, onboarding overhead"],
      }),
    );

    const now = new Date("2026-06-01T00:00:00Z");
    const outcome = await runRefreshEvidenceTask({ db, dbPath, workItem, runDeepResearch, now });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.insertedEvidenceCount).toBe(1);
    expect(outcome.droppedUnverifiedEvidenceCount).toBe(0);
    expect(outcome.createdAnalyzeWorkItemId).toBeTruthy();

    const persisted = db.select().from(evidenceItems).all();
    expect(persisted).toHaveLength(1);

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("RESEARCHED");
    expect(updatedCompany?.lastResearchedAt?.getTime()).toBe(now.getTime());
    expect(updatedCompany?.nextEligibleResearchAt?.getTime()).toBe(
      computeNextEligibleResearchAt(now).getTime(),
    );
    expect(updatedCompany?.notes).toContain("Evidence refresh: 1 new evidence item(s) recorded");

    const analyzeItems = db.select().from(workItems).where(eq(workItems.taskType, "ANALYZE")).all();
    expect(analyzeItems).toHaveLength(1);
    expect(analyzeItems[0]?.entityId).toBe(company.id);
  });

  it("allows refreshing a company that previously landed on NO_OPPORTUNITY", async () => {
    const company = seedCompany({ lifecycleStatus: "NO_OPPORTUNITY" });
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runRefreshEvidenceTask({
      db,
      dbPath,
      workItem,
      runDeepResearch: async () => success({ evidence: [], candidateProblems: [] }),
    });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("NO_OPPORTUNITY");
  });

  it("respects a custom re-research window", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);
    const now = new Date("2026-06-01T00:00:00Z");
    const oneDayMs = 24 * 60 * 60 * 1000;

    await runRefreshEvidenceTask({
      db,
      dbPath,
      workItem,
      now,
      reResearchWindowMs: oneDayMs,
      runDeepResearch: async () => success({ evidence: [], candidateProblems: [] }),
    });

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.nextEligibleResearchAt?.getTime()).toBe(now.getTime() + oneDayMs);
  });

  it("drops an evidence item whose sourceUrl was never actually fetched", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runRefreshEvidenceTask({
      db,
      dbPath,
      workItem,
      runDeepResearch: async () =>
        success({
          evidence: [
            {
              claim: "made up",
              classification: "FACT",
              supportingExcerpt: "made up",
              sourceUrl: "https://acme-vet.example/never-fetched",
              confidence: 0.9,
            },
          ],
          candidateProblems: [],
        }),
    });

    expect(outcome.insertedEvidenceCount).toBe(0);
    expect(outcome.droppedUnverifiedEvidenceCount).toBe(1);
    expect(db.select().from(evidenceItems).all()).toHaveLength(0);
  });

  it("passes quota_exhausted through as DEFERRED, without touching the company", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runRefreshEvidenceTask({
      db,
      dbPath,
      workItem,
      runDeepResearch: async () => ({
        status: "quota_exhausted",
        message: "You've hit your weekly limit.",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("DEFERRED");
    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lastResearchedAt?.getTime()).toBe(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runRefreshEvidenceTask({
      db,
      dbPath,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runDeepResearch: async () => ({
        status: "invalid_output",
        message: "Model output did not match the expected schema.",
        attempts: 2,
      }),
    });

    expect(outcome.workItemStatus).toBe("RETRYABLE");
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.attempts).toBe(1);
  });

  it("marks the item FAILED once attempts are exhausted", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id, 2);

    const outcome = await runRefreshEvidenceTask({
      db,
      dbPath,
      workItem,
      runDeepResearch: async () => ({
        status: "error",
        message: "claude CLI exited with code 1",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("FAILED");
  });
});
