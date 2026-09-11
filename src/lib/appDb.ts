/**
 * Shared DB connection for the Next.js dashboard (Phase 12). Server components and server actions
 * both need a `Db` handle; opening a fresh `better-sqlite3` connection per request would be wasteful
 * and, under Next's dev-mode hot module reloading, would leak file handles across reloads. Cached
 * on `globalThis` (the same pattern the wider Next.js ecosystem uses for e.g. Prisma clients) so a
 * dev-server reload reuses the existing connection instead of opening a new one every time this
 * module re-evaluates.
 *
 * `AOH_DB_PATH` defaults to `./data/aoh.db`, same convention as `src/worker.ts`'s `main()` and
 * every `scripts/*.ts` CLI entry point.
 */

import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";

const globalForDb = globalThis as unknown as { aohDb?: Db };

export function getDb(): Db {
  if (!globalForDb.aohDb) {
    const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
    globalForDb.aohDb = createDb(dbPath);
  }
  return globalForDb.aohDb;
}
