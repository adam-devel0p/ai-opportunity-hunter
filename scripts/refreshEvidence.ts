/**
 * Runs real REFRESH_EVIDENCE work items against the live `claude` CLI (spec §60 re-research,
 * PLAN.md Phase 14's manual smoke-test entry point — `worker.ts`'s `ensureRefreshEvidenceWork`
 * is the autonomous path; this is the manual one, same relationship `scripts/research.ts` has to
 * the RESEARCH stage).
 *
 * Usage:
 *   npm run refresh-evidence -- --company <company-id>   (run one specific company's item)
 *   npm run refresh-evidence -- --all [--limit <n>]        (run every PENDING item, oldest first)
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { companies, workItems } from "../src/db/schema.js";
import { runRefreshEvidenceTask } from "../src/pipeline/refreshEvidenceHandler.js";

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
          eq(workItems.taskType, "REFRESH_EVIDENCE"),
          eq(workItems.entityId, flags.company),
          eq(workItems.status, "PENDING"),
        ),
      )
      .all();
    if (pendingItems.length === 0) {
      console.error(`No PENDING REFRESH_EVIDENCE work item for company ${flags.company}`);
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
      .filter((item) => item.taskType === "REFRESH_EVIDENCE")
      .slice(0, limit);
    if (pendingItems.length === 0) {
      console.log("No PENDING REFRESH_EVIDENCE work items found.");
      return;
    }
  } else {
    console.error("Usage: npm run refresh-evidence -- --company <company-id> | --all [--limit <n>]");
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
    console.log(`\nRefreshing evidence for "${company?.name ?? item.entityId}" (${item.entityId})...`);

    const outcome = await runRefreshEvidenceTask({
      db,
      dbPath,
      workItem: { id: item.id, status: "RUNNING", entityId: item.entityId, attempts: item.attempts },
    });

    console.log(`  Work item status: ${outcome.workItemStatus}`);
    if (outcome.error) console.log(`  Error: ${outcome.error}`);
    if (outcome.insertedEvidenceCount !== undefined) {
      console.log(
        `  Evidence: ${outcome.insertedEvidenceCount} inserted, ${outcome.droppedUnverifiedEvidenceCount ?? 0} dropped.`,
      );
    }
    if (outcome.createdAnalyzeWorkItemId) {
      console.log(`  ANALYZE work item created: ${outcome.createdAnalyzeWorkItemId}`);
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
