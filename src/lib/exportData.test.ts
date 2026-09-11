import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, contacts, opportunities, outreachDrafts, outreachOutcomes } from "../db/schema.js";
import {
  EXPORT_ENTITIES,
  buildExportBundle,
  bundleToJson,
  exportEntityCsv,
  rowsToCsv,
} from "./exportData.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-export-test-"));
  db = runMigrations(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedFullPipeline() {
  const [company] = db
    .insert(companies)
    .values({
      name: "Acme Vet Clinic",
      normalizedDomain: "acme-vet.example",
      website: "https://acme-vet.example",
      country: "US",
      industry: "veterinary",
      lifecycleStatus: "RESEARCHED",
      notes: 'Has a "quote" and, a comma\nand a newline.',
    })
    .returning()
    .all();

  const [opportunity] = db
    .insert(opportunities)
    .values({
      companyId: company!.id,
      problemTitle: "Manual appointment scheduling",
      problemDescription: "Staff manually track bookings in a spreadsheet.",
      problemCategory: "scheduling",
      impactAssumptions: [],
      proposedSolution: "Automated booking workflow.",
      dependencies: [],
      risks: ["Staff resistance to new tooling"],
      existingAlternatives: [],
      status: "OUTREACH_READY",
    })
    .returning()
    .all();

  const [contact] = db
    .insert(contacts)
    .values({
      companyId: company!.id,
      name: "Jane Doe",
      emailConfidence: "PUBLICLY_LISTED",
      email: "jane@acme-vet.example",
    })
    .returning()
    .all();

  const [draft] = db
    .insert(outreachDrafts)
    .values({
      opportunityId: opportunity!.id,
      contactId: contact!.id,
      subject: "Quick idea for Acme Vet",
      body: "Hi Jane, ...",
      wordCount: 80,
      status: "SENT_MANUALLY",
    })
    .returning()
    .all();

  db.insert(outreachOutcomes)
    .values({ outreachDraftId: draft!.id, event: "SENT" })
    .run();

  return { company: company!, opportunity: opportunity!, contact: contact!, draft: draft! };
}

describe("buildExportBundle", () => {
  it("covers every entity type spec §79 names", () => {
    expect(EXPORT_ENTITIES).toEqual([
      "companies",
      "opportunities",
      "contacts",
      "outreachDrafts",
      "outreachOutcomes",
    ]);
  });

  it("returns every seeded record for every entity, with correct spot-check field values", () => {
    const seeded = seedFullPipeline();
    const bundle = buildExportBundle(db);

    expect(bundle.companies).toHaveLength(1);
    expect(bundle.companies[0]?.id).toBe(seeded.company.id);
    expect(bundle.companies[0]?.name).toBe("Acme Vet Clinic");

    expect(bundle.opportunities).toHaveLength(1);
    expect(bundle.opportunities[0]?.problemTitle).toBe("Manual appointment scheduling");

    expect(bundle.contacts).toHaveLength(1);
    expect(bundle.contacts[0]?.email).toBe("jane@acme-vet.example");

    expect(bundle.outreachDrafts).toHaveLength(1);
    expect(bundle.outreachDrafts[0]?.subject).toBe("Quick idea for Acme Vet");

    expect(bundle.outreachOutcomes).toHaveLength(1);
    expect(bundle.outreachOutcomes[0]?.event).toBe("SENT");
  });

  it("returns empty arrays (not throwing) for an empty database", () => {
    const bundle = buildExportBundle(db);
    for (const entity of EXPORT_ENTITIES) {
      expect(bundle[entity]).toEqual([]);
    }
  });
});

describe("bundleToJson", () => {
  it("round-trips every entity's row count through JSON", () => {
    seedFullPipeline();
    const bundle = buildExportBundle(db);
    const parsed = JSON.parse(bundleToJson(bundle));
    for (const entity of EXPORT_ENTITIES) {
      expect(parsed[entity]).toHaveLength(bundle[entity].length);
    }
  });
});

describe("rowsToCsv / exportEntityCsv", () => {
  it("returns an empty string for no rows", () => {
    expect(rowsToCsv([])).toBe("");
  });

  it("quotes and escapes commas, quotes, and newlines", () => {
    seedFullPipeline();
    const bundle = buildExportBundle(db);
    const csv = exportEntityCsv(bundle, "companies");
    const lines = csv.split("\n");
    expect(lines[0]).toContain("name");
    // The notes field contains a quote, a comma, and a newline — all must be safely embedded in
    // one quoted CSV field without breaking row/column structure.
    expect(csv).toContain('""quote""');
    const dataLines = csv.split("\n").length;
    // 1 header line + however many physical lines the embedded newline inside the quoted field
    // produces (embedded newlines are legal inside a quoted CSV field, so this is >= 2).
    expect(dataLines).toBeGreaterThanOrEqual(2);
  });

  it("serializes a JSON array column inline rather than dropping it", () => {
    seedFullPipeline();
    const bundle = buildExportBundle(db);
    const csv = exportEntityCsv(bundle, "opportunities");
    expect(csv).toContain("Staff resistance to new tooling");
  });

  it("produces a CSV for every entity type without throwing", () => {
    seedFullPipeline();
    const bundle = buildExportBundle(db);
    for (const entity of EXPORT_ENTITIES) {
      expect(() => exportEntityCsv(bundle, entity)).not.toThrow();
    }
  });
});
