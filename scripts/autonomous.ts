/**
 * Toggles/reads `system_config`'s autonomous-mode flag (spec §71 pause/resume). PLAN.md's Phase
 * 11 explicitly keeps this a CLI/config-script control ("pause/resume is toggled via a config
 * script/CLI flag until Phase 12 gives it a dashboard control") — this is that script.
 *
 * Usage:
 *   npm run autonomous -- --status
 *   npm run autonomous -- --enable
 *   npm run autonomous -- --disable
 */

import { createDb } from "../src/db/client.js";
import { getAutonomousMode, setAutonomousMode } from "../src/lib/config.js";

function main() {
  const flag = process.argv.slice(2)[0];
  if (!flag || !["--status", "--enable", "--disable"].includes(flag)) {
    console.error("Usage: npm run autonomous -- --status | --enable | --disable");
    process.exitCode = 1;
    return;
  }

  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);

  if (flag === "--enable") {
    setAutonomousMode(db, true);
    console.log("Autonomous mode: ENABLED. The worker will pick this up within one cycle.");
    return;
  }
  if (flag === "--disable") {
    setAutonomousMode(db, false);
    console.log("Autonomous mode: DISABLED (paused). No state is lost — resume any time with --enable.");
    return;
  }

  console.log(`Autonomous mode: ${getAutonomousMode(db) ? "ENABLED" : "DISABLED"}`);
}

main();
