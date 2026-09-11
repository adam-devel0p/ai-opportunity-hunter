/**
 * CSV/JSON export (spec §79: "the system must not lock valuable research entirely inside the
 * UI"). Covers every entity type the spec names — companies, opportunities, contacts, outreach
 * (drafts), outcomes — as one bundle read straight off the live tables, no derived/joined view.
 */

import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  opportunities,
  outreachDrafts,
  outreachOutcomes,
} from "../db/schema.js";

export interface ExportBundle {
  companies: (typeof companies.$inferSelect)[];
  opportunities: (typeof opportunities.$inferSelect)[];
  contacts: (typeof contacts.$inferSelect)[];
  outreachDrafts: (typeof outreachDrafts.$inferSelect)[];
  outreachOutcomes: (typeof outreachOutcomes.$inferSelect)[];
}

export const EXPORT_ENTITIES = [
  "companies",
  "opportunities",
  "contacts",
  "outreachDrafts",
  "outreachOutcomes",
] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];

export function buildExportBundle(db: Db): ExportBundle {
  return {
    companies: db.select().from(companies).all(),
    opportunities: db.select().from(opportunities).all(),
    contacts: db.select().from(contacts).all(),
    outreachDrafts: db.select().from(outreachDrafts).all(),
    outreachOutcomes: db.select().from(outreachOutcomes).all(),
  };
}

/** JSON export: the full bundle, as-is (Date columns serialize to ISO strings via JSON.stringify's
 * default Date#toJSON, JSON arrays/objects stay structured — nothing CSV's flat-row shape would
 * otherwise force us to stringify). */
export function bundleToJson(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Flat CSV for one entity's rows — nested JSON columns (e.g. `opportunities.risks`) are
 * serialized inline as a quoted JSON string rather than split into extra columns, same "one row
 * per record" simplicity spec §79 asks for ("CSV and/or JSON is sufficient"). */
export function rowsToCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  return lines.join("\n");
}

export function exportEntityCsv(bundle: ExportBundle, entity: ExportEntity): string {
  return rowsToCsv(bundle[entity] as unknown as Record<string, unknown>[]);
}
