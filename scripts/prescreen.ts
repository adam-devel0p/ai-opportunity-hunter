/**
 * Runs real PRESCREEN work items against the live `claude` CLI (PLAN.md Phase 4's manual smoke
 * test entry point — no worker loop exists yet, that's Phase 11).
 *
 * Usage:
 *   npm run prescreen -- --company <company-id>   (run one specific company's PRESCREEN item)
 *   npm run prescreen -- --all [--limit <n>]        (run every PENDING PRESCREEN item, oldest first)
 *
 * For each targeted company, creates/reuses its PRESCREEN work_item, runs it via
 * src/pipeline/prescreenHandler.ts (which invokes the real Pre-Screening Agent, applies the
 * deterministic freshness short-circuit, updates the company's lifecycle, and enqueues a
 * RESEARCH work item on MAYBE/PROMISING), and prints a summary per company.
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { companies, workItems } from "../src/db/schema.js";
import { runPrescreenTask } from "../src/pipeline/prescreenHandler.js";

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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);

  let pendingItems;
  if (flags.company) {
    pendingItems = db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.taskType, "PRESCREEN"),
          eq(workItems.entityId, flags.company),
          eq(workItems.status, "PENDING"),
        ),
      )
      .all();
    if (pendingItems.length === 0) {
      console.error(`No PENDING PRESCREEN work item for company ${flags.company}`);
      process.exitCode = 1;
      return;
    }
  } else if (flags.all) {
    const limit = flags.limit ? Number(flags.limit) : undefined;
    pendingItems = db
      .select()
      .from(workItems)
      .where(eq(workItems.status, "PENDING"))
      .all()
      .filter((item) => item.taskType === "PRESCREEN")
      .slice(0, limit);
    if (pendingItems.length === 0) {
      console.log("No PENDING PRESCREEN work items found.");
      return;
    }
  } else {
    console.error("Usage: npm run prescreen -- --company <company-id> | --all [--limit <n>]");
    process.exitCode = 1;
    return;
  }

  for (const item of pendingItems) {
    const now = new Date();
    db.update(workItems)
      .set({ status: "RUNNING", startedAt: now, updatedAt: now })
      .where(eq(workItems.id, item.id))
      .run();

    const company = db.select().from(companies).where(eq(companies.id, item.entityId)).get();
    console.log(`\nPre-screening "${company?.name ?? item.entityId}" (${item.entityId})...`);

    const outcome = await runPrescreenTask({
      db,
      workItem: {
        id: item.id,
        status: "RUNNING",
        entityId: item.entityId,
        attempts: item.attempts,
      },
    });

    console.log(`  Work item status: ${outcome.workItemStatus}`);
    if (outcome.error) {
      console.log(`  Error: ${outcome.error}`);
    }
    if (outcome.classification) {
      console.log(`  Classification: ${outcome.classification} -> ${outcome.companyLifecycleStatus}`);
    }
    if (outcome.createdResearchWorkItemId) {
      console.log(`  RESEARCH work item created: ${outcome.createdResearchWorkItemId}`);
    }
    if (outcome.costUsd != null) {
      console.log(
        `  (cost: $${outcome.costUsd} — check claude.ai/console usage page to confirm this billed to subscription, not API credits)`,
      );
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
