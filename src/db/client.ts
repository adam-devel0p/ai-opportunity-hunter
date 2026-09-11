import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export function createDb(path: string) {
  // better-sqlite3 refuses to create a DB file in a directory that doesn't exist yet (e.g. a
  // fresh checkout's gitignored `./data/`) — create it rather than making every caller
  // remember to `mkdir` first.
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Phase 5: the ADR-0004 PostToolUse hook opens its own short-lived connection to this same
  // file from a separate process per WebFetch call, so concurrent writers are now a real
  // scenario (not just this app's own single-writer assumption from ADR-0008 part 3). WAL
  // allows concurrent readers/writers, but a second writer still hits SQLITE_BUSY immediately
  // without a busy handler — this gives any writer up to 5s to wait out a lock instead.
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
