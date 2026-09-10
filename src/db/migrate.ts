import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb } from "./client.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

/** Runs all pending Drizzle migrations against the DB file at `path`. */
export function runMigrations(dbPath: string) {
  const db = createDb(dbPath);
  migrate(db, { migrationsFolder });
  return db;
}
