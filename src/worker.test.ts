import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./db/migrate.js";
import type { Db } from "./db/client.js";
import { companies, discoveryCampaigns, workItems } from "./db/schema.js";
import { setAutonomousMode } from "./lib/config.js";
import { TASK_TYPE_PRIORITY } from "./pipeline/priority.js";
import { invokeClaude } from "./agents/claudeClient.js";
import {
  recoverStuckWorkItems,
  ensureDiscoveryWork,
  ensureRefreshEvidenceWork,
  runWorkerCycle,
  runWorker,
  DEFAULT_STUCK_RUNNING_TIMEOUT_MS,
} from "./worker.js";

vi.mock("./agents/claudeClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agents/claudeClient.js")>();
  return { ...actual, invokeClaude: vi.fn() };
});

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-worker-test-"));
  db = runMigrations(path.join(dir, "test.db"));
  vi.mocked(invokeClaude).mockReset();
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
      notes: null,
      lifecycleStatus: "PRESCREEN_PENDING",
      ...overrides,
    })
    .returning()
    .all();
  return company!;
}

function seedCampaign(overrides?: Partial<typeof discoveryCampaigns.$inferInsert>) {
  const [campaign] = db
    .insert(discoveryCampaigns)
    .values({
      name: "UK recruitment agencies",
      criteria: { geography: ["UK"] },
      status: "ENABLED",
      createdBy: "MANUAL",
      ...overrides,
    })
    .returning()
    .all();
  return campaign!;
}

function successResult(resultObj: unknown) {
  return {
    status: "success" as const,
    resultText: JSON.stringify(resultObj),
    raw: {},
    costUsd: 0.01,
    durationMs: 100,
  };
}

const quotaExhaustedResult = {
  status: "quota_exhausted" as const,
  message: "You've hit your weekly limit.",
};

describe("recoverStuckWorkItems", () => {
  it("resets a RUNNING item stuck past the timeout to RETRYABLE", () => {
    const company = seedCompany();
    const staleStart = new Date(Date.now() - DEFAULT_STUCK_RUNNING_TIMEOUT_MS - 1000);
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "RUNNING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
        startedAt: staleStart,
      })
      .returning()
      .all();

    const recovered = recoverStuckWorkItems(db);
    expect(recovered).toBe(1);

    const updated = db.select().from(workItems).where(eq(workItems.id, item!.id)).get();
    expect(updated?.status).toBe("RETRYABLE");
  });

  it("leaves a RUNNING item within the timeout alone", () => {
    const company = seedCompany();
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "RUNNING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
        startedAt: new Date(),
      })
      .returning()
      .all();

    const recovered = recoverStuckWorkItems(db);
    expect(recovered).toBe(0);

    const updated = db.select().from(workItems).where(eq(workItems.id, item!.id)).get();
    expect(updated?.status).toBe("RUNNING");
  });
});

describe("ensureDiscoveryWork", () => {
  it("does nothing when there are no enabled campaigns", () => {
    const createdId = ensureDiscoveryWork(db);
    expect(createdId).toBeNull();
    expect(db.select().from(workItems).all()).toHaveLength(0);
  });

  it("enqueues a DISCOVER item for the selected campaign when none is in flight", () => {
    const campaign = seedCampaign();
    const createdId = ensureDiscoveryWork(db);
    expect(createdId).not.toBeNull();

    const items = db.select().from(workItems).all();
    expect(items).toHaveLength(1);
    expect(items[0]?.taskType).toBe("DISCOVER");
    expect(items[0]?.entityId).toBe(campaign.id);
    expect(items[0]?.priority).toBe(TASK_TYPE_PRIORITY.DISCOVER);
  });

  it("does not create a second DISCOVER item while one is already in flight", () => {
    seedCampaign();
    const first = ensureDiscoveryWork(db);
    expect(first).not.toBeNull();

    const second = ensureDiscoveryWork(db);
    expect(second).toBeNull();
    expect(db.select().from(workItems).all()).toHaveLength(1);
  });

  it("creates a new DISCOVER item again once the prior one reaches a terminal status", () => {
    seedCampaign();
    const first = ensureDiscoveryWork(db);
    db.update(workItems)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(eq(workItems.id, first!))
      .run();

    const second = ensureDiscoveryWork(db);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe("ensureRefreshEvidenceWork", () => {
  it("does nothing when no company is eligible", () => {
    seedCompany({ lifecycleStatus: "RESEARCHED", nextEligibleResearchAt: new Date(Date.now() + 100_000) });
    const created = ensureRefreshEvidenceWork(db);
    expect(created).toEqual([]);
  });

  it("enqueues REFRESH_EVIDENCE for a RESEARCHED company past its eligibility window", () => {
    const company = seedCompany({
      lifecycleStatus: "RESEARCHED",
      nextEligibleResearchAt: new Date(Date.now() - 1000),
    });
    const created = ensureRefreshEvidenceWork(db);
    expect(created).toHaveLength(1);

    const items = db.select().from(workItems).all();
    expect(items).toHaveLength(1);
    expect(items[0]?.taskType).toBe("REFRESH_EVIDENCE");
    expect(items[0]?.entityId).toBe(company.id);
    expect(items[0]?.priority).toBe(TASK_TYPE_PRIORITY.REFRESH_EVIDENCE);
  });

  it("also considers a NO_OPPORTUNITY company eligible", () => {
    seedCompany({
      lifecycleStatus: "NO_OPPORTUNITY",
      nextEligibleResearchAt: new Date(Date.now() - 1000),
    });
    expect(ensureRefreshEvidenceWork(db)).toHaveLength(1);
  });

  it("ignores a company with no nextEligibleResearchAt set", () => {
    seedCompany({ lifecycleStatus: "RESEARCHED", nextEligibleResearchAt: null });
    expect(ensureRefreshEvidenceWork(db)).toEqual([]);
  });

  it("does not double-enqueue while a REFRESH_EVIDENCE item is already in flight for a company", () => {
    const company = seedCompany({
      lifecycleStatus: "RESEARCHED",
      nextEligibleResearchAt: new Date(Date.now() - 1000),
    });
    const first = ensureRefreshEvidenceWork(db);
    expect(first).toHaveLength(1);

    const second = ensureRefreshEvidenceWork(db);
    expect(second).toEqual([]);
    expect(
      db.select().from(workItems).where(eq(workItems.entityId, company.id)).all(),
    ).toHaveLength(1);
  });

  it("caps how many it enqueues per call at the batch size", () => {
    for (let i = 0; i < 5; i++) {
      seedCompany({
        normalizedDomain: `eligible-${i}.example`,
        website: `https://eligible-${i}.example`,
        lifecycleStatus: "RESEARCHED",
        nextEligibleResearchAt: new Date(Date.now() - 1000),
      });
    }
    const created = ensureRefreshEvidenceWork(db, new Date(), 2);
    expect(created).toHaveLength(2);
  });
});

describe("runWorkerCycle", () => {
  it("returns paused when autonomous mode is off (the default)", async () => {
    const result = await runWorkerCycle({ db });
    expect(result).toEqual({ kind: "paused" });
  });

  it("returns idle when autonomous mode is on but nothing is eligible", async () => {
    setAutonomousMode(db, true);
    const result = await runWorkerCycle({ db });
    expect(result.kind).toBe("idle");
  });

  it("runs the highest-priority eligible item via the real handler map", async () => {
    setAutonomousMode(db, true);
    const company = seedCompany();
    db.insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .run();

    vi.mocked(invokeClaude).mockResolvedValueOnce(
      successResult({ classification: "DISCARD", reasons: ["Site is parked."] }),
    );

    const result = await runWorkerCycle({ db });
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") throw new Error("unreachable");
    expect(result.taskType).toBe("PRESCREEN");
    expect(result.workItemStatus).toBe("COMPLETED");
    expect(result.quotaExhausted).toBe(false);

    const updatedCompany = db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .get();
    expect(updatedCompany?.lifecycleStatus).toBe("DISCARDED");
  });

  it("prefers an injected handler override over the real handler map", async () => {
    setAutonomousMode(db, true);
    const company = seedCompany();
    db.insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .run();

    const fakeHandler = vi.fn().mockResolvedValue({ workItemStatus: "COMPLETED" as const });
    const result = await runWorkerCycle({ db, handlers: { PRESCREEN: fakeHandler } });

    expect(fakeHandler).toHaveBeenCalledTimes(1);
    expect(invokeClaude).not.toHaveBeenCalled();
    expect(result.kind).toBe("ran");
  });

  it("marks a DEFERRED outcome (quota exhaustion) without throwing", async () => {
    setAutonomousMode(db, true);
    const company = seedCompany();
    db.insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .run();

    vi.mocked(invokeClaude).mockResolvedValueOnce(quotaExhaustedResult);

    const result = await runWorkerCycle({ db });
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") throw new Error("unreachable");
    expect(result.workItemStatus).toBe("DEFERRED");
    expect(result.quotaExhausted).toBe(true);
  });

  it("catches a handler that throws and routes it through failure classification instead of propagating", async () => {
    setAutonomousMode(db, true);
    const company = seedCompany();
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .returning()
      .all();

    const throwingHandler = vi.fn().mockRejectedValue(new Error("boom: unexpected failure"));

    const result = await runWorkerCycle({ db, handlers: { PRESCREEN: throwingHandler } });
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") throw new Error("unreachable");
    expect(result.workItemStatus).toBe("RETRYABLE");
    expect(result.error).toContain("boom");

    const updated = db.select().from(workItems).where(eq(workItems.id, item!.id)).get();
    expect(updated?.status).toBe("RETRYABLE");
    expect(updated?.attempts).toBe(1);
    expect(updated?.runAfter).not.toBeNull();
  });
});

describe("runWorker (integration)", () => {
  it("stops issuing new calls on quota exhaustion, backs off, then resumes the same item without duplicating or losing work", async () => {
    setAutonomousMode(db, true);

    const promisingCompany = seedCompany();
    const [prescreenItem] = db
      .insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: promisingCompany.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .returning()
      .all();

    // A lower-priority DISCOVER item referencing a campaign that doesn't exist — never actually
    // selected in this test (PRESCREEN always outranks it, spec §49), so its would-be failure
    // never fires. Present purely to prove priority ordering holds across a mixed queue.
    const [discoverItem] = db
      .insert(workItems)
      .values({
        taskType: "DISCOVER",
        entityId: "nonexistent-campaign-id",
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.DISCOVER,
      })
      .returning()
      .all();

    vi.mocked(invokeClaude)
      .mockResolvedValueOnce(quotaExhaustedResult)
      .mockResolvedValueOnce(
        successResult({ classification: "PROMISING", reasons: ["Looks like a real, active clinic."] }),
      );

    const sleep = vi.fn().mockResolvedValue(undefined);
    const cycles: Array<{ kind: string }> = [];

    await runWorker({
      db,
      maxCycles: 2,
      sleep,
      quotaBackoffBaseMs: 1000,
      idlePollIntervalMs: 500,
      onCycle: (result) => cycles.push(result),
    });

    // Cycle 1: quota-exhausted on the PRESCREEN item -> DEFERRED, backoff sleep called.
    // Cycle 2: same item picked back up (still the highest-priority eligible item) and succeeds.
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ kind: "ran", workItemStatus: "DEFERRED" });
    expect(cycles[1]).toMatchObject({ kind: "ran", workItemStatus: "COMPLETED" });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);

    expect(invokeClaude).toHaveBeenCalledTimes(2);

    // No duplicate PRESCREEN work item was created — still exactly the one seeded row, now COMPLETED.
    const prescreenRows = db
      .select()
      .from(workItems)
      .where(eq(workItems.taskType, "PRESCREEN"))
      .all();
    expect(prescreenRows).toHaveLength(1);
    expect(prescreenRows[0]?.id).toBe(prescreenItem!.id);
    expect(prescreenRows[0]?.status).toBe("COMPLETED");

    // The lower-priority DISCOVER item was never touched.
    const discoverRow = db
      .select()
      .from(workItems)
      .where(eq(workItems.id, discoverItem!.id))
      .get();
    expect(discoverRow?.status).toBe("PENDING");

    // Real downstream progress happened: PROMISING enqueues a RESEARCH item for the company.
    const researchRows = db
      .select()
      .from(workItems)
      .where(eq(workItems.taskType, "RESEARCH"))
      .all();
    expect(researchRows).toHaveLength(1);
  });

  it("recovers a crashed (stuck RUNNING) item at startup and continues processing it", async () => {
    setAutonomousMode(db, true);
    const company = seedCompany();
    const staleStart = new Date(Date.now() - DEFAULT_STUCK_RUNNING_TIMEOUT_MS - 1000);
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: company.id,
        status: "RUNNING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
        startedAt: staleStart,
      })
      .returning()
      .all();

    vi.mocked(invokeClaude).mockResolvedValueOnce(
      successResult({ classification: "DISCARD", reasons: ["Dead site."] }),
    );

    const cycles: Array<{ kind: string }> = [];
    await runWorker({
      db,
      maxCycles: 1,
      sleep: vi.fn().mockResolvedValue(undefined),
      onCycle: (result) => cycles.push(result),
    });

    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ kind: "ran", workItemStatus: "COMPLETED" });

    const updated = db.select().from(workItems).where(eq(workItems.id, item!.id)).get();
    expect(updated?.status).toBe("COMPLETED");
  });

  it("takes effect within one cycle when autonomous mode is toggled off mid-run", async () => {
    setAutonomousMode(db, false);
    const cycles: Array<{ kind: string }> = [];

    await runWorker({
      db,
      maxCycles: 1,
      sleep: vi.fn().mockResolvedValue(undefined),
      onCycle: (result) => cycles.push(result),
    });

    expect(cycles).toEqual([{ kind: "paused" }]);
    expect(invokeClaude).not.toHaveBeenCalled();
  });
});
