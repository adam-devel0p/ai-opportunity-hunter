/**
 * Runs real FIND_CONTACT work items against the live `claude` CLI (PLAN.md Phase 9's manual
 * smoke-test entry point — no worker loop exists yet, that's Phase 11).
 *
 * Usage:
 *   npm run contact -- --opportunity <opportunity-id>   (run one specific opportunity's FIND_CONTACT item)
 *   npm run contact -- --all [--limit <n>]                  (run every PENDING FIND_CONTACT item, oldest first)
 *
 * For each targeted opportunity, runs its FIND_CONTACT work_item via
 * src/pipeline/contactHandler.ts (which invokes the real Contact Research Agent, persists a
 * `contacts` row, transitions the opportunity to OUTREACH_READY, and enqueues WRITE_OUTREACH),
 * and prints a summary per opportunity.
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { opportunities, workItems } from "../src/db/schema.js";
import { runFindContactTask } from "../src/pipeline/contactHandler.js";

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
  if (flags.opportunity) {
    pendingItems = db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.taskType, "FIND_CONTACT"),
          eq(workItems.entityId, flags.opportunity),
          eq(workItems.status, "PENDING"),
        ),
      )
      .all();
    if (pendingItems.length === 0) {
      console.error(`No PENDING FIND_CONTACT work item for opportunity ${flags.opportunity}`);
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
      .filter((item) => item.taskType === "FIND_CONTACT")
      .slice(0, limit);
    if (pendingItems.length === 0) {
      console.log("No PENDING FIND_CONTACT work items found.");
      return;
    }
  } else {
    console.error("Usage: npm run contact -- --opportunity <opportunity-id> | --all [--limit <n>]");
    process.exitCode = 1;
    return;
  }

  for (const item of pendingItems) {
    const now = new Date();
    db.update(workItems)
      .set({ status: "RUNNING", startedAt: now, updatedAt: now })
      .where(eq(workItems.id, item.id))
      .run();

    const opportunity = db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, item.entityId))
      .get();
    console.log(`\nFinding contact for "${opportunity?.problemTitle ?? item.entityId}" (${item.entityId})...`);

    const outcome = await runFindContactTask({
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
    if (outcome.contactId) {
      console.log(`  Contact id: ${outcome.contactId}`);
      console.log(`  Email confidence: ${outcome.emailConfidence}`);
      console.log(`  Verified: ${outcome.isVerifiedEmail}, preferred for initial outreach: ${outcome.isPreferredForInitialOutreach}`);
      console.log(`  Opportunity status: ${outcome.opportunityStatus}`);
    }
    if (outcome.createdWriteOutreachWorkItemId) {
      console.log(`  WRITE_OUTREACH work item created: ${outcome.createdWriteOutreachWorkItemId}`);
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
