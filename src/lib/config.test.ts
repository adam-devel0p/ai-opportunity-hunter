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
} from "./config.js";

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
