import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, workItems } from "../db/schema.js";
import type { PrescreenOutput, RunPrescreenAgentInput } from "../agents/prescreenAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { addExclusionRule } from "../lib/exclusions.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import { runPrescreenTask, type PrescreenWorkItemContext } from "./prescreenHandler.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-prescreen-test-"));
  db = runMigrations(path.join(dir, "test.db"));
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
      notes: "Discovery reason: likely manual appointment scheduling.",
      lifecycleStatus: "PRESCREEN_PENDING",
      ...overrides,
    })
    .returning()
    .all();
  return company!;
}

function seedRunningWorkItem(companyId: string, attempts = 0): PrescreenWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "PRESCREEN",
      entityId: companyId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.PRESCREEN,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: companyId, attempts };
}

function success(data: PrescreenOutput): StructuredAgentResult<PrescreenOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.01, durationMs: 500 };
}

describe("runPrescreenTask", () => {
  it("throws for a PRESCREEN item whose entityId isn't a known company", async () => {
    const workItem: PrescreenWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-company",
      attempts: 0,
    };
    await expect(
      runPrescreenTask({
        db,
        workItem,
        runPrescreen: async () => success({ classification: "PROMISING", reasons: ["x"] }),
      }),
    ).rejects.toThrow(/unknown company/);
  });

  it("classifies a strong candidate as PROMISING: PRESCREENED -> RESEARCH_PENDING, RESEARCH item enqueued", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const runPrescreen = vi.fn(async (_input: RunPrescreenAgentInput) =>
      success({
        classification: "PROMISING",
        reasons: ["Live site, real small business, clear manual booking workflow."],
      }),
    );

    const outcome = await runPrescreenTask({ db, workItem, runPrescreen });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.classification).toBe("PROMISING");
    expect(outcome.companyLifecycleStatus).toBe("RESEARCH_PENDING");
    expect(outcome.createdResearchWorkItemId).toBeTruthy();

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("RESEARCH_PENDING");
    expect(updatedCompany?.notes).toContain("Prescreen (PROMISING)");
    expect(updatedCompany?.notes).toContain("Discovery reason");

    const researchItems = db.select().from(workItems).where(eq(workItems.taskType, "RESEARCH")).all();
    expect(researchItems).toHaveLength(1);
    expect(researchItems[0]?.entityId).toBe(company.id);
    expect(researchItems[0]?.status).toBe("PENDING");
    expect(researchItems[0]?.priority).toBe(TASK_TYPE_PRIORITY.RESEARCH);

    expect(runPrescreen).toHaveBeenCalledTimes(1);
  });

  it("treats MAYBE the same as PROMISING (still proceeds to research)", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runPrescreenTask({
      db,
      workItem,
      runPrescreen: async () =>
        success({ classification: "MAYBE", reasons: ["Unclear if manual or already automated."] }),
    });

    expect(outcome.classification).toBe("MAYBE");
    expect(outcome.companyLifecycleStatus).toBe("RESEARCH_PENDING");
    expect(outcome.createdResearchWorkItemId).toBeTruthy();
  });

  it("classifies a dead/parked site as DISCARD: company DISCARDED, no RESEARCH item, reasons recorded", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runPrescreenTask({
      db,
      workItem,
      runPrescreen: async () =>
        success({ classification: "DISCARD", reasons: ["Website did not load (connection timed out)."] }),
    });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.classification).toBe("DISCARD");
    expect(outcome.companyLifecycleStatus).toBe("DISCARDED");
    expect(outcome.createdResearchWorkItemId).toBeNull();

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("DISCARDED");
    expect(updatedCompany?.notes).toContain("Prescreen (DISCARD)");
    expect(updatedCompany?.notes).toContain("connection timed out");

    expect(db.select().from(workItems).where(eq(workItems.taskType, "RESEARCH")).all()).toHaveLength(0);
  });

  it("excludes a company matching a live exclusion rule, without calling Claude, even if the rule was added after this company was discovered", async () => {
    const company = seedCompany({ industry: "gambling" });
    const workItem = seedRunningWorkItem(company.id);
    // Rule added *after* the company already exists and its PRESCREEN item was enqueued — this
    // is exactly the retroactive case discoverHandler.ts's own check can't catch on its own.
    addExclusionRule(db, { type: "INDUSTRY", value: "gambling", reason: "Regulated industry, skip." });

    const runPrescreen = vi.fn(async (_input: RunPrescreenAgentInput) =>
      success({ classification: "PROMISING", reasons: ["should never be called"] }),
    );

    const outcome = await runPrescreenTask({ db, workItem, runPrescreen });

    expect(runPrescreen).not.toHaveBeenCalled();
    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.excluded).toBe(true);
    expect(outcome.companyLifecycleStatus).toBe("EXCLUDED");
    expect(outcome.createdResearchWorkItemId).toBeNull();

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("EXCLUDED");
    expect(updatedCompany?.exclusionReason).toContain("Regulated industry, skip.");

    expect(db.select().from(workItems).where(eq(workItems.taskType, "RESEARCH")).all()).toHaveLength(0);
  });

  it("discards an already-researched-recently company via the deterministic freshness check, without calling Claude", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const company = seedCompany({ nextEligibleResearchAt: future, lastResearchedAt: past });
    const workItem = seedRunningWorkItem(company.id);

    const runPrescreen = vi.fn(async (_input: RunPrescreenAgentInput) =>
      success({ classification: "PROMISING", reasons: ["should never be called"] }),
    );

    const outcome = await runPrescreenTask({ db, workItem, runPrescreen });

    expect(runPrescreen).not.toHaveBeenCalled();
    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.classification).toBe("DISCARD");
    expect(outcome.companyLifecycleStatus).toBe("DISCARDED");

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("DISCARDED");
    expect(updatedCompany?.notes).toContain("no Claude call");
  });

  it("passes quota_exhausted through as DEFERRED, without touching company lifecycle or counting a failed attempt", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runPrescreenTask({
      db,
      workItem,
      runPrescreen: async () => ({
        status: "quota_exhausted",
        message: "You've hit your weekly limit.",
        attempts: 1,
      }),
    });

    expect(outcome.workItemStatus).toBe("DEFERRED");

    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("DEFERRED");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toContain("weekly limit");

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("PRESCREEN_PENDING");
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runPrescreenTask({
      db,
      workItem,
      now: new Date("2026-06-01T00:00:00Z"),
      runPrescreen: async () => ({
        status: "invalid_output",
        message: "Model output did not match the expected schema.",
        attempts: 2,
      }),
    });

    expect(outcome.workItemStatus).toBe("RETRYABLE");

    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("RETRYABLE");
    expect(row?.attempts).toBe(1);
    expect(row?.runAfter?.getTime()).toBeGreaterThan(new Date("2026-06-01T00:00:00Z").getTime());
  });

  it("marks the item FAILED once attempts are exhausted", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id, 2);

    const outcome = await runPrescreenTask({
      db,
      workItem,
      runPrescreen: async () => ({
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
});
