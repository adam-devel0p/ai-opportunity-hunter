import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import {
  addExclusionRule,
  checkExclusion,
  listExclusionRules,
  removeExclusionRule,
} from "./exclusions.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-exclusions-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("addExclusionRule", () => {
  it("normalizes a DOMAIN rule's value the same way as companies.normalizedDomain", () => {
    const rule = addExclusionRule(db, { type: "DOMAIN", value: "https://www.Excluded.Example/about" });
    expect(rule.value).toBe("excluded.example");
  });

  it("trims but does not lowercase an INDUSTRY/COUNTRY rule's value", () => {
    const rule = addExclusionRule(db, { type: "INDUSTRY", value: "  Gambling  " });
    expect(rule.value).toBe("Gambling");
  });
});

describe("listExclusionRules / removeExclusionRule", () => {
  it("round-trips created rules and removal", () => {
    const a = addExclusionRule(db, { type: "COUNTRY", value: "RU" });
    const b = addExclusionRule(db, { type: "INDUSTRY", value: "gambling" });
    expect(listExclusionRules(db).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    removeExclusionRule(db, a.id);
    expect(listExclusionRules(db).map((r) => r.id)).toEqual([b.id]);
  });
});

describe("checkExclusion", () => {
  it("reflects rules added after construction (always reads live)", () => {
    const candidate = { normalizedDomain: "acme.example", industry: "veterinary", country: "DE" };
    expect(checkExclusion(db, candidate).excluded).toBe(false);

    addExclusionRule(db, { type: "COUNTRY", value: "DE", reason: "No EU presence yet." });
    const result = checkExclusion(db, candidate);
    expect(result.excluded).toBe(true);
    expect(result.reason).toContain("No EU presence yet.");
  });
});
