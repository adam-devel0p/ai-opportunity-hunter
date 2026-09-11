/**
 * Runs real ANALYZE work items against the live `claude` CLI (PLAN.md Phase 6's manual
 * smoke-test entry point — no worker loop exists yet, that's Phase 11).
 *
 * Usage:
 *   npm run analyze -- --company <company-id>   (run one specific company's ANALYZE item)
 *   npm run analyze -- --all [--limit <n>]         (run every PENDING ANALYZE item, oldest first)
 *
 * For each targeted company, runs its ANALYZE work_item via src/pipeline/analyzeHandler.ts
 * (which invokes the real Opportunity Analysis Agent, wires the Phase 1 scoring calculator,
 * persists an opportunity + evaluation, links evidence, and enqueues a VERIFY work item), and
 * prints a summary per company.
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { companies, workItems } from "../src/db/schema.js";
import { runAnalyzeTask } from "../src/pipeline/analyzeHandler.js";

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
          eq(workItems.taskType, "ANALYZE"),
          eq(workItems.entityId, flags.company),
          eq(workItems.status, "PENDING"),
        ),
      )
      .all();
    if (pendingItems.length === 0) {
      console.error(`No PENDING ANALYZE work item for company ${flags.company}`);
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
      .filter((item) => item.taskType === "ANALYZE")
      .slice(0, limit);
    if (pendingItems.length === 0) {
      console.log("No PENDING ANALYZE work items found.");
      return;
    }
  } else {
    console.error("Usage: npm run analyze -- --company <company-id> | --all [--limit <n>]");
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
    console.log(`\nAnalyzing "${company?.name ?? item.entityId}" (${item.entityId})...`);

    const outcome = await runAnalyzeTask({
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
    if (outcome.opportunityId) {
      console.log(`  Opportunity created: ${outcome.opportunityId} (status: ${outcome.opportunityStatus})`);
      console.log(
        `  Score: raw ${outcome.rawScore}/100, adjusted ${outcome.adjustedScore}/100` +
          (outcome.penalties?.length ? ` (penalties: ${outcome.penalties.map((p) => p.reason).join(", ")})` : ""),
      );
      console.log(`  Evidence linked: ${outcome.linkedEvidenceCount}`);
    }
    if (outcome.createdVerifyWorkItemId) {
      console.log(`  VERIFY work item created: ${outcome.createdVerifyWorkItemId}`);
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
