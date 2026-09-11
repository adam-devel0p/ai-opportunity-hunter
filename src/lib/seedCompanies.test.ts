import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, workItems } from "../db/schema.js";
import { seedCompanyForTesting } from "./seedCompanies.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-seed-companies-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("seedCompanyForTesting", () => {
  it("inserts a new company at PRESCREEN_PENDING and enqueues a PRESCREEN item", () => {
    const outcome = seedCompanyForTesting(db, {
      website: "https://acme-vet.example",
      name: "Acme Vet Clinic",
      industry: "veterinary",
      country: "US",
    });

    expect(outcome.kind).toBe("queued");
    if (outcome.kind !== "queued") throw new Error("unreachable");

    const company = db.select().from(companies).where(eq(companies.id, outcome.companyId)).get();
    expect(company?.name).toBe("Acme Vet Clinic");
    expect(company?.lifecycleStatus).toBe("PRESCREEN_PENDING");
    expect(company?.sourceCampaignId).toBeNull();
    expect(company?.notes).toContain("Seeded for pipeline/prompt testing");

    const item = db.select().from(workItems).where(eq(workItems.id, outcome.workItemId)).get();
    expect(item?.taskType).toBe("PRESCREEN");
    expect(item?.entityId).toBe(outcome.companyId);
    expect(item?.status).toBe("PENDING");
  });

  it("falls back to the normalized domain as the name when none is given", () => {
    const outcome = seedCompanyForTesting(db, { website: "https://no-name.example" });
    if (outcome.kind !== "queued") throw new Error("unreachable");
    const company = db.select().from(companies).where(eq(companies.id, outcome.companyId)).get();
    expect(company?.name).toBe("no-name.example");
  });

  it("is idempotent for a domain already PRESCREEN_PENDING with a PENDING item: reports already-queued", () => {
    const first = seedCompanyForTesting(db, { website: "https://acme-vet.example" });
    const second = seedCompanyForTesting(db, { website: "https://acme-vet.example" });
    expect(second).toEqual({ kind: "already-queued", companyId: (first as { companyId: string }).companyId, workItemId: (first as { workItemId: string }).workItemId });
    expect(db.select().from(workItems).all()).toHaveLength(1);
  });

  it("reports already-progressed for a domain already past PRESCREEN_PENDING", () => {
    db.insert(companies)
      .values({
        name: "Already Researched Co",
        normalizedDomain: "already-researched.example",
        website: "https://already-researched.example",
        lifecycleStatus: "RESEARCHED",
      })
      .run();

    const outcome = seedCompanyForTesting(db, { website: "https://already-researched.example" });
    expect(outcome.kind).toBe("already-progressed");
    if (outcome.kind !== "already-progressed") throw new Error("unreachable");
    expect(outcome.lifecycleStatus).toBe("RESEARCHED");
    expect(db.select().from(workItems).all()).toHaveLength(0);
  });
});
