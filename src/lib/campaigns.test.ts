import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import {
  blacklistCampaign,
  createCampaign,
  disableCampaign,
  enableCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  setCampaignPriority,
} from "./campaigns.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-campaigns-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createCampaign", () => {
  it("creates an ENABLED, MANUAL campaign with the given criteria", () => {
    const campaign = createCampaign(db, {
      name: "UK recruitment agencies",
      criteria: { geography: ["UK"], industry: ["recruitment"], sizeRange: "5-50 employees" },
      priority: 5,
    });
    expect(campaign.status).toBe("ENABLED");
    expect(campaign.createdBy).toBe("MANUAL");
    expect(campaign.priority).toBe(5);
    expect(campaign.criteria).toEqual({
      geography: ["UK"],
      industry: ["recruitment"],
      sizeRange: "5-50 employees",
    });
  });

  it("defaults priority to 0 when not given", () => {
    const campaign = createCampaign(db, { name: "test", criteria: {} });
    expect(campaign.priority).toBe(0);
  });
});

describe("listCampaigns / getCampaign", () => {
  it("lists all campaigns, optionally filtered by status", () => {
    const a = createCampaign(db, { name: "a", criteria: {} });
    createCampaign(db, { name: "b", criteria: {} });
    pauseCampaign(db, a.id);

    expect(listCampaigns(db)).toHaveLength(2);
    expect(listCampaigns(db, { status: "PAUSED" })).toHaveLength(1);
    expect(listCampaigns(db, { status: "ENABLED" })).toHaveLength(1);
  });

  it("getCampaign returns undefined for an unknown id", () => {
    expect(getCampaign(db, "does-not-exist")).toBeUndefined();
  });
});

describe("operator status toggles", () => {
  it("enable/pause/disable/blacklist all update the status column freely", () => {
    const campaign = createCampaign(db, { name: "test", criteria: {} });
    expect(pauseCampaign(db, campaign.id).status).toBe("PAUSED");
    expect(enableCampaign(db, campaign.id).status).toBe("ENABLED");
    expect(disableCampaign(db, campaign.id).status).toBe("DISABLED");
    expect(blacklistCampaign(db, campaign.id).status).toBe("BLACKLISTED");
    // blacklist isn't a dead end — the operator can still re-enable later.
    expect(enableCampaign(db, campaign.id).status).toBe("ENABLED");
  });

  it("throws for an unknown campaign id", () => {
    expect(() => pauseCampaign(db, "does-not-exist")).toThrow();
  });
});

describe("setCampaignPriority", () => {
  it("updates priority", () => {
    const campaign = createCampaign(db, { name: "test", criteria: {} });
    expect(setCampaignPriority(db, campaign.id, 9).priority).toBe(9);
  });
});
