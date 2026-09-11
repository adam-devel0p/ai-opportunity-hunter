/**
 * Runs real WRITE_OUTREACH work items against the live `claude` CLI (PLAN.md Phase 10's manual
 * smoke-test entry point — no worker loop exists yet, that's Phase 11).
 *
 * Usage:
 *   npm run outreach -- --opportunity <opportunity-id>   (run one specific opportunity's WRITE_OUTREACH item)
 *   npm run outreach -- --all [--limit <n>]              (run every PENDING WRITE_OUTREACH item, oldest first)
 *
 * For each targeted opportunity, runs its WRITE_OUTREACH work_item via
 * src/pipeline/outreachHandler.ts (which invokes the real Outreach Writer, persists an
 * `outreach_drafts` row, and leaves the opportunity at OUTREACH_READY for manual review/send),
 * and prints the draft per opportunity.
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { opportunities, outreachDrafts, workItems } from "../src/db/schema.js";
import { runWriteOutreachTask } from "../src/pipeline/outreachHandler.js";

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
          eq(workItems.taskType, "WRITE_OUTREACH"),
          eq(workItems.entityId, flags.opportunity),
          eq(workItems.status, "PENDING"),
        ),
      )
      .all();
    if (pendingItems.length === 0) {
      console.error(`No PENDING WRITE_OUTREACH work item for opportunity ${flags.opportunity}`);
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
      .filter((item) => item.taskType === "WRITE_OUTREACH")
      .slice(0, limit);
    if (pendingItems.length === 0) {
      console.log("No PENDING WRITE_OUTREACH work items found.");
      return;
    }
  } else {
    console.error("Usage: npm run outreach -- --opportunity <opportunity-id> | --all [--limit <n>]");
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
    console.log(`\nWriting outreach for "${opportunity?.problemTitle ?? item.entityId}" (${item.entityId})...`);

    const outcome = await runWriteOutreachTask({
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
    if (outcome.outreachDraftId) {
      const draft = db
        .select()
        .from(outreachDrafts)
        .where(eq(outreachDrafts.id, outcome.outreachDraftId))
        .get();
      console.log(`  Draft id: ${outcome.outreachDraftId} (${outcome.wordCount} words)`);
      console.log(`  Regenerated: ${outcome.regenerated}`);
      console.log(`  Subject: ${draft?.subject}`);
      console.log(`  Body:\n${draft?.body}`);
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
