/**
 * Runs real BUILD_OFFER work items against the live `claude` CLI (PLAN.md Phase 8's manual
 * smoke-test entry point — no worker loop exists yet, that's Phase 11).
 *
 * Usage:
 *   npm run offer -- --opportunity <opportunity-id>   (run one specific opportunity's BUILD_OFFER item)
 *   npm run offer -- --all [--limit <n>]                 (run every PENDING BUILD_OFFER item, oldest first)
 *
 * For each targeted opportunity, runs its BUILD_OFFER work_item via
 * src/pipeline/offerHandler.ts (which invokes the real Offer Builder Agent, runs the spec §34
 * vague-offer lint and the spec §35 pricing-band check, persists an `offers` row, transitions the
 * opportunity to CONTACT_RESEARCH, and enqueues FIND_CONTACT), and prints a summary per opportunity.
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { opportunities, workItems } from "../src/db/schema.js";
import { runBuildOfferTask } from "../src/pipeline/offerHandler.js";

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
          eq(workItems.taskType, "BUILD_OFFER"),
          eq(workItems.entityId, flags.opportunity),
          eq(workItems.status, "PENDING"),
        ),
      )
      .all();
    if (pendingItems.length === 0) {
      console.error(`No PENDING BUILD_OFFER work item for opportunity ${flags.opportunity}`);
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
      .filter((item) => item.taskType === "BUILD_OFFER")
      .slice(0, limit);
    if (pendingItems.length === 0) {
      console.log("No PENDING BUILD_OFFER work items found.");
      return;
    }
  } else {
    console.error("Usage: npm run offer -- --opportunity <opportunity-id> | --all [--limit <n>]");
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
    console.log(`\nBuilding offer for "${opportunity?.problemTitle ?? item.entityId}" (${item.entityId})...`);

    const outcome = await runBuildOfferTask({
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
    if (outcome.offerId) {
      console.log(`  Offer id: ${outcome.offerId}`);
      console.log(`  Price band: ${outcome.priceBand} (in band: ${outcome.priceInBand})`);
      console.log(`  Regenerated after vague-offer lint: ${outcome.regenerated}`);
      console.log(`  Opportunity status: ${outcome.opportunityStatus}`);
    }
    if (outcome.createdFindContactWorkItemId) {
      console.log(`  FIND_CONTACT work item created: ${outcome.createdFindContactWorkItemId}`);
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
