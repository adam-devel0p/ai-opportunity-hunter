import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { systemConfig } from "../db/schema.js";
import {
  getAutonomousMode,
  setAutonomousMode,
  getCampaignSelectionState,
  setCampaignSelectionState,
  getOpportunityGateConfig,
  setOpportunityGateConfig,
  getReResearchWindowMs,
  setReResearchWindowMs,
} from "./config.js";
import { DEFAULT_OPPORTUNITY_GATE_CONFIG } from "./opportunityGate.js";
import { DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS } from "./researchFreshness.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-config-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("autonomous mode", () => {
  it("defaults to false (paused) when unset", () => {
    expect(getAutonomousMode(db)).toBe(false);
  });

  it("persists enable/disable across reads", () => {
    setAutonomousMode(db, true);
    expect(getAutonomousMode(db)).toBe(true);

    setAutonomousMode(db, false);
    expect(getAutonomousMode(db)).toBe(false);
  });

  it("upserts rather than erroring on a second write", () => {
    setAutonomousMode(db, true);
    setAutonomousMode(db, true);
    expect(getAutonomousMode(db)).toBe(true);
  });
});

describe("campaign selection state", () => {
  it("defaults to the initial (empty) state when unset", () => {
    expect(getCampaignSelectionState(db)).toEqual({});
  });

  it("round-trips a real state object", () => {
    setCampaignSelectionState(db, { "campaign-a": 3, "campaign-b": -1 });
    expect(getCampaignSelectionState(db)).toEqual({ "campaign-a": 3, "campaign-b": -1 });
  });

  it("falls back to the initial state for a malformed stored value", () => {
    setAutonomousMode(db, true); // seed an unrelated row first, sanity check isolation
    // Simulate a corrupt/foreign value in this key by writing directly, bypassing the
    // module's own (well-typed) setter.
    db.insert(systemConfig)
      .values({ key: "campaignSelectionState", value: "not-an-object", updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemConfig.key,
        set: { value: "not-an-object", updatedAt: new Date() },
      })
      .run();

    expect(getCampaignSelectionState(db)).toEqual({});
    expect(getAutonomousMode(db)).toBe(true);
  });
});

describe("opportunity gate config", () => {
  it("defaults to DEFAULT_OPPORTUNITY_GATE_CONFIG when unset", () => {
    expect(getOpportunityGateConfig(db)).toEqual(DEFAULT_OPPORTUNITY_GATE_CONFIG);
  });

  it("round-trips a custom config", () => {
    const custom = { scoreThreshold: 80, evidenceStrengthFloor: 12, allowHighRisk: true };
    setOpportunityGateConfig(db, custom);
    expect(getOpportunityGateConfig(db)).toEqual(custom);
  });

  it("falls back to the default for a malformed stored value", () => {
    db.insert(systemConfig)
      .values({ key: "opportunityGateConfig", value: { scoreThreshold: "not-a-number" }, updatedAt: new Date() })
      .run();
    expect(getOpportunityGateConfig(db)).toEqual(DEFAULT_OPPORTUNITY_GATE_CONFIG);
  });
});

describe("re-research window", () => {
  it("defaults to DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS when unset", () => {
    expect(getReResearchWindowMs(db)).toBe(DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS);
  });

  it("round-trips a custom value", () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    setReResearchWindowMs(db, oneDayMs);
    expect(getReResearchWindowMs(db)).toBe(oneDayMs);
  });

  it("falls back to the default for a non-positive stored value", () => {
    setReResearchWindowMs(db, -5);
    expect(getReResearchWindowMs(db)).toBe(DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS);
  });
});
