/**
 * Runs real VERIFY work items against the live `claude` CLI (PLAN.md Phase 7's manual
 * smoke-test entry point — no worker loop exists yet, that's Phase 11).
 *
 * Usage:
 *   npm run verify -- --opportunity <opportunity-id>   (run one specific opportunity's VERIFY item)
 *   npm run verify -- --all [--limit <n>]                 (run every PENDING VERIFY item, oldest first)
 *
 * For each targeted opportunity, runs its VERIFY work_item via src/pipeline/verifyHandler.ts
 * (which invokes the real Skeptical Verification Agent, runs the spec §32 gate, updates the
 * opportunity_evaluations row, transitions the opportunity to VERIFIED/VERIFIER_REJECTED, and
 * enqueues BUILD_OFFER on a pass), and prints a summary per opportunity.
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { opportunities, workItems } from "../src/db/schema.js";
import { runVerifyTask } from "../src/pipeline/verifyHandler.js";

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
          eq(workItems.taskType, "VERIFY"),
          eq(workItems.entityId, flags.opportunity),
          eq(workItems.status, "PENDING"),
        ),
      )
      .all();
    if (pendingItems.length === 0) {
      console.error(`No PENDING VERIFY work item for opportunity ${flags.opportunity}`);
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
      .filter((item) => item.taskType === "VERIFY")
      .slice(0, limit);
    if (pendingItems.length === 0) {
      console.log("No PENDING VERIFY work items found.");
      return;
    }
  } else {
    console.error("Usage: npm run verify -- --opportunity <opportunity-id> | --all [--limit <n>]");
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
    console.log(`\nVerifying "${opportunity?.problemTitle ?? item.entityId}" (${item.entityId})...`);

    const outcome = await runVerifyTask({
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
    if (outcome.verifierResult) {
      console.log(`  Skeptic result: ${outcome.verifierResult}`);
      console.log(`  Risk category: ${outcome.riskCategory}`);
      console.log(
        `  Gate: ${outcome.gatePassed ? "PASSED" : "FAILED"}` +
          (outcome.gateReasons?.length ? ` — ${outcome.gateReasons.join("; ")}` : ""),
      );
      console.log(`  Opportunity status: ${outcome.opportunityStatus}`);
    }
    if (outcome.createdBuildOfferWorkItemId) {
      console.log(`  BUILD_OFFER work item created: ${outcome.createdBuildOfferWorkItemId}`);
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
