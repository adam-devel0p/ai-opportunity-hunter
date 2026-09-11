/**
 * Database backup/restore CLI (spec §80).
 *
 * Usage:
 *   npm run backup -- create [--out <path>]     (default: ./data/backups/aoh-<timestamp>.db)
 *   npm run backup -- restore <path> [--target <dbPath>]
 */

import { backupDatabase, restoreDatabase } from "../src/lib/backup.js";

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

function defaultBackupPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `./data/backups/aoh-${timestamp}.db`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";

  switch (command) {
    case "create": {
      const flags = parseFlags(rest);
      const out = flags.out ?? defaultBackupPath();
      await backupDatabase(dbPath, out);
      console.log(`Backed up ${dbPath} -> ${out}`);
      return;
    }
    case "restore": {
      const backupPath = rest[0];
      const flags = parseFlags(rest);
      if (!backupPath) {
        console.error("Usage: backup restore <path> [--target <dbPath>]");
        process.exitCode = 1;
        return;
      }
      const target = flags.target ?? dbPath;
      console.log(
        `Restoring ${backupPath} -> ${target}. Make sure the worker/dashboard aren't running against this DB.`,
      );
      restoreDatabase(backupPath, target);
      console.log("Restore complete.");
      return;
    }
    default: {
      console.error("Usage: backup <create|restore> [...]");
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
