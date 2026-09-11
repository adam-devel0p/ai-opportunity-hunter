import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { createDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import { companies } from "../db/schema.js";
import { backupDatabase, restoreDatabase } from "./backup.js";

let dir: string;
let dbPath: string;
let backupPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-backup-test-"));
  dbPath = path.join(dir, "aoh.db");
  backupPath = path.join(dir, "backups", "aoh-backup.db");
  db = runMigrations(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedCompany(db: Db, name: string) {
  db.insert(companies)
    .values({
      name,
      normalizedDomain: `${name.toLowerCase().replace(/\s+/g, "-")}.example`,
      website: `https://${name.toLowerCase().replace(/\s+/g, "-")}.example`,
      lifecycleStatus: "DISCOVERED",
    })
    .run();
}

describe("backupDatabase", () => {
  it("throws when the source file doesn't exist", async () => {
    await expect(backupDatabase(path.join(dir, "nope.db"), backupPath)).rejects.toThrow(/No database file/);
  });

  it("creates a backup file containing the same data as the live DB", async () => {
    seedCompany(db, "Acme Vet Clinic");
    await backupDatabase(dbPath, backupPath);

    expect(existsSync(backupPath)).toBe(true);
    const backupDb = createDb(backupPath);
    const rows = backupDb.select().from(companies).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Acme Vet Clinic");
  });
});

describe("restoreDatabase / round-trip", () => {
  it("throws when the backup file doesn't exist", () => {
    expect(() => restoreDatabase(path.join(dir, "nope.db"), dbPath)).toThrow(/No backup file/);
  });

  it("backs up, corrupts/deletes the live DB, restores, and verifies data matches", async () => {
    seedCompany(db, "Acme Vet Clinic");
    seedCompany(db, "Northgate Recruitment");
    const before = db.select().from(companies).all().map((c) => c.name).sort();

    await backupDatabase(dbPath, backupPath);

    // Simulate the live DB being lost/corrupted.
    rmSync(dbPath);
    writeFileSync(dbPath, "not a real sqlite file");

    restoreDatabase(backupPath, dbPath);

    const restoredDb = createDb(dbPath);
    const after = restoredDb.select().from(companies).all().map((c) => c.name).sort();
    expect(after).toEqual(before);

    const restoredCompany = restoredDb
      .select()
      .from(companies)
      .where(eq(companies.normalizedDomain, "acme-vet-clinic.example"))
      .get();
    expect(restoredCompany?.name).toBe("Acme Vet Clinic");
  });
});
