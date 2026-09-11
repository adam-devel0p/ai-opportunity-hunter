/**
 * Simple SQLite backup/restore (spec §80: "for local SQLite this can initially be extremely
 * simple"). Uses better-sqlite3's own `.backup()` API rather than a plain file copy for the
 * backup direction — the live DB runs in WAL mode (`db/client.ts`), where the on-disk main file
 * alone can be missing recently-committed data still sitting in the `-wal` file; `.backup()`
 * produces a single consistent snapshot file regardless of journal mode or concurrent writers
 * (the ADR-0004 hook subprocess included).
 *
 * Restore is a plain file copy — deliberately not wrapped in any "safety" that pretends to check
 * whether the live DB is currently open elsewhere (the worker, the dashboard, a hook subprocess);
 * the operator is responsible for stopping those first, same trust boundary as every other
 * destructive local-file operation this app doesn't attempt to guard against.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export async function backupDatabase(sourcePath: string, destPath: string): Promise<void> {
  if (!existsSync(sourcePath)) {
    throw new Error(`No database file at ${sourcePath}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  const source = new Database(sourcePath, { readonly: true });
  try {
    await source.backup(destPath);
  } finally {
    source.close();
  }
}

/** Overwrites `targetPath` with the contents of `backupPath`, and removes any stale WAL/SHM
 * sidecar files next to the target so the restored file is read cleanly on next open (a leftover
 * `-wal` from the file that used to live at `targetPath` would otherwise get replayed on top of
 * the restored snapshot). */
export function restoreDatabase(backupPath: string, targetPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`No backup file at ${backupPath}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(backupPath, targetPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${targetPath}${suffix}`;
    if (existsSync(sidecar)) {
      rmSync(sidecar);
    }
  }
}
