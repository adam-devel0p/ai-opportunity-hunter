/**
 * Data export CLI (spec §79 — companies, opportunities, contacts, outreach, outcomes).
 *
 * Usage:
 *   npm run export -- --format json [--out <file>]           (default: ./data/exports/export-<timestamp>.json)
 *   npm run export -- --format csv [--out <dir>]              (default: ./data/exports/export-<timestamp>/, one file per entity)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "../src/db/client.js";
import {
  EXPORT_ENTITIES,
  buildExportBundle,
  bundleToJson,
  exportEntityCsv,
} from "../src/lib/exportData.js";

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);
  const bundle = buildExportBundle(db);

  if (flags.format === "csv") {
    const outDir = flags.out ?? `./data/exports/export-${timestamp()}`;
    mkdirSync(outDir, { recursive: true });
    for (const entity of EXPORT_ENTITIES) {
      const csv = exportEntityCsv(bundle, entity);
      const filePath = path.join(outDir, `${entity}.csv`);
      writeFileSync(filePath, csv);
      console.log(`${entity}: ${bundle[entity].length} row(s) -> ${filePath}`);
    }
    return;
  }

  if (flags.format === "json" || !flags.format) {
    const outFile = flags.out ?? `./data/exports/export-${timestamp()}.json`;
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, bundleToJson(bundle));
    for (const entity of EXPORT_ENTITIES) {
      console.log(`${entity}: ${bundle[entity].length} row(s)`);
    }
    console.log(`Exported -> ${outFile}`);
    return;
  }

  console.error("Usage: export --format json|csv [--out <path>]");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
