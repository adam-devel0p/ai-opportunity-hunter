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
import { runResearchTask, type ResearchWorkItemContext } from "./researchHandler.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-research-test-"));
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
      notes: "Discovery reason: likely manual appointment scheduling.",
      lifecycleStatus: "RESEARCH_PENDING",
      ...overrides,
    })
    .returning()
    .all();
  return company!;
}

function seedRunningWorkItem(companyId: string, attempts = 0): ResearchWorkItemContext {
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "RESEARCH",
      entityId: companyId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.RESEARCH,
      attempts,
      startedAt: new Date(),
    })
    .returning()
    .all();
  return { id: item!.id, status: "RUNNING", entityId: companyId, attempts };
}

/** Simulates the ADR-0004 hook having already recorded a fetched page during this task. */
function seedSource(taskId: string, companyId: string, url: string, httpStatus = 200) {
  const [source] = db
    .insert(sources)
    .values({
      companyId,
      url,
      fetchedByTaskId: taskId,
      freshnessState: httpStatus >= 200 && httpStatus < 300 ? "FRESH" : "UNAVAILABLE",
    })
    .returning()
    .all();
  return source!;
}

function success(data: DeepResearchOutput): StructuredAgentResult<DeepResearchOutput> {
  return { status: "success", data, attempts: 1, costUsd: 0.05, durationMs: 3000 };
}

describe("runResearchTask", () => {
  it("throws for a RESEARCH item whose entityId isn't a known company", async () => {
    const workItem: ResearchWorkItemContext = {
      id: "wi-1",
      status: "RUNNING",
      entityId: "no-such-company",
      attempts: 0,
    };
    await expect(
      runResearchTask({
        db,
        dbPath,
        workItem,
        runDeepResearch: async () => success({ evidence: [], candidateProblems: [] }),
      }),
    ).rejects.toThrow(/unknown company/);
  });

  it("a strong candidate with multiple FACTs from distinct sources: all persisted with correct source links, company RESEARCHED, ANALYZE enqueued", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);
    seedSource(workItem.id, company.id, "https://acme-vet.example/about");
    seedSource(workItem.id, company.id, "https://acme-vet.example/careers");

    const runDeepResearch = vi.fn(async (_input: RunDeepResearchAgentInput) =>
      success({
        evidence: [
          {
            claim: "The clinic has 4 named veterinarians on staff.",
            classification: "FACT",
            supportingExcerpt: "Our team: Dr. A, Dr. B, Dr. C, Dr. D",
            sourceUrl: "https://acme-vet.example/about",
            confidence: 0.95,
          },
          {
            claim: "The clinic is hiring a full-time receptionist as of this posting.",
            classification: "FACT",
            supportingExcerpt: "Now hiring: Front Desk Receptionist",
            sourceUrl: "https://acme-vet.example/careers",
            confidence: 0.9,
          },
        ],
        candidateProblems: ["Manual appointment scheduling", "Front-desk overload"],
      }),
    );

    const now = new Date("2026-06-01T00:00:00Z");
    const outcome = await runResearchTask({ db, dbPath, workItem, runDeepResearch, now });

    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.companyLifecycleStatus).toBe("RESEARCHED");
    expect(outcome.insertedEvidenceCount).toBe(2);
    expect(outcome.droppedUnverifiedEvidenceCount).toBe(0);
    expect(outcome.candidateProblems).toEqual(["Manual appointment scheduling", "Front-desk overload"]);
    expect(outcome.createdAnalyzeWorkItemId).toBeTruthy();

    const persistedEvidence = db.select().from(evidenceItems).all();
    expect(persistedEvidence).toHaveLength(2);
    const sourceUrls = persistedEvidence.map((e) => {
      const source = db.select().from(sources).where(eq(sources.id, e.sourceId)).get();
      return source?.url;
    });
    expect(new Set(sourceUrls)).toEqual(
      new Set(["https://acme-vet.example/about", "https://acme-vet.example/careers"]),
    );
    // Provenance is structural: every persisted evidence item has a real source with a retrievedAt.
    for (const e of persistedEvidence) {
      const source = db.select().from(sources).where(eq(sources.id, e.sourceId)).get();
      expect(source).toBeTruthy();
      expect(source?.retrievedAt).toBeInstanceOf(Date);
    }

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("RESEARCHED");
    expect(updatedCompany?.lastResearchedAt?.getTime()).toBe(now.getTime());
    expect(updatedCompany?.nextEligibleResearchAt?.getTime()).toBe(
      computeNextEligibleResearchAt(now).getTime(),
    );
    expect(updatedCompany?.notes).toContain("2 evidence item(s) recorded");
    expect(updatedCompany?.notes).toContain("Research candidate problems: Manual appointment scheduling; Front-desk overload");

    const analyzeItems = db.select().from(workItems).where(eq(workItems.taskType, "ANALYZE")).all();
    expect(analyzeItems).toHaveLength(1);
    expect(analyzeItems[0]?.entityId).toBe(company.id);
    expect(analyzeItems[0]?.priority).toBe(TASK_TYPE_PRIORITY.ANALYZE);
  });

  it("a bare brochure site producing mostly UNKNOWN/HYPOTHESIS: classifications are persisted honestly, not upgraded", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);
    seedSource(workItem.id, company.id, "https://acme-vet.example");

    const runDeepResearch = vi.fn(async () =>
      success({
        evidence: [
          {
            claim: "Actual weekly appointment volume is unknown.",
            classification: "UNKNOWN",
            supportingExcerpt: "Homepage has no volume or booking-count information.",
            sourceUrl: "https://acme-vet.example",
            confidence: 0.3,
          },
          {
            claim: "The clinic may schedule appointments by phone only.",
            classification: "HYPOTHESIS",
            supportingExcerpt: "No online booking widget found on the homepage.",
            sourceUrl: "https://acme-vet.example",
            confidence: 0.4,
          },
        ],
        candidateProblems: [],
      }),
    );

    const outcome = await runResearchTask({ db, dbPath, workItem, runDeepResearch });

    expect(outcome.insertedEvidenceCount).toBe(2);
    const persisted = db.select().from(evidenceItems).all();
    expect(persisted.map((e) => e.classification).sort()).toEqual(["HYPOTHESIS", "UNKNOWN"]);
  });

  it("drops an evidence item whose sourceUrl was never actually fetched (per the hook), without persisting it", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);
    seedSource(workItem.id, company.id, "https://acme-vet.example/about");

    const runDeepResearch = vi.fn(async () =>
      success({
        evidence: [
          {
            claim: "The clinic processes 200 invoices per month.",
            classification: "FACT",
            supportingExcerpt: "made up",
            // Never actually fetched via WebFetch during this task (no matching hook-recorded source).
            sourceUrl: "https://acme-vet.example/never-fetched",
            confidence: 0.99,
          },
        ],
        candidateProblems: [],
      }),
    );

    const outcome = await runResearchTask({ db, dbPath, workItem, runDeepResearch });

    expect(outcome.insertedEvidenceCount).toBe(0);
    expect(outcome.droppedUnverifiedEvidenceCount).toBe(1);
    expect(db.select().from(evidenceItems).all()).toHaveLength(0);
    // Task still succeeds and the company still advances — thin/no evidence is a valid outcome
    // for Phase 6 to judge, not a reason to block the pipeline.
    expect(outcome.workItemStatus).toBe("COMPLETED");
    expect(outcome.companyLifecycleStatus).toBe("RESEARCHED");

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.notes).toContain("1 dropped (sourceUrl not independently verified as fetched)");
  });

  it("tolerates a trailing-slash-only mismatch between the cited sourceUrl and the recorded source", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);
    seedSource(workItem.id, company.id, "https://acme-vet.example/about/");

    const runDeepResearch = vi.fn(async () =>
      success({
        evidence: [
          {
            claim: "x",
            classification: "FACT",
            supportingExcerpt: "x",
            sourceUrl: "https://acme-vet.example/about",
            confidence: 0.8,
          },
        ],
        candidateProblems: [],
      }),
    );

    const outcome = await runResearchTask({ db, dbPath, workItem, runDeepResearch });
    expect(outcome.insertedEvidenceCount).toBe(1);
    expect(outcome.droppedUnverifiedEvidenceCount).toBe(0);
  });

  it("passes quota_exhausted through as DEFERRED, without touching company lifecycle or counting a failed attempt", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runResearchTask({
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
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.status).toBe("DEFERRED");
    expect(row?.attempts).toBe(0);

    const updatedCompany = db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(updatedCompany?.lifecycleStatus).toBe("RESEARCH_PENDING");
  });

  it("routes a non-quota failure through failure classification (RETRYABLE with backoff)", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id);

    const outcome = await runResearchTask({
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
    expect(row?.runAfter?.getTime()).toBeGreaterThan(new Date("2026-06-01T00:00:00Z").getTime());
  });

  it("marks the item FAILED once attempts are exhausted", async () => {
    const company = seedCompany();
    const workItem = seedRunningWorkItem(company.id, 2);

    const outcome = await runResearchTask({
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
    const row = db.select().from(workItems).where(eq(workItems.id, workItem.id)).get();
    expect(row?.attempts).toBe(3);
  });
});
