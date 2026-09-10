/**
 * Runs a real DISCOVER work item for one campaign against the live `claude` CLI (PLAN.md
 * Phase 3's manual smoke test entry point — no worker loop exists yet, that's Phase 11).
 *
 * Usage: npm run discover -- --campaign <campaign-id> [--count <n>]
 *
 * Creates a DISCOVER work_item, runs it via src/pipeline/discoverHandler.ts (which invokes the
 * real Discovery Agent, persists new companies deduped by normalized domain, and enqueues
 * PRESCREEN work items), and prints a summary.
 */

import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { discoveryCampaigns, workItems } from "../src/db/schema.js";
import { runDiscoverTask } from "../src/pipeline/discoverHandler.js";
import { TASK_TYPE_PRIORITY } from "../src/pipeline/priority.js";

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
      }
    }
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.campaign) {
    console.error("Usage: npm run discover -- --campaign <campaign-id> [--count <n>]");
    process.exitCode = 1;
    return;
  }

  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);

  const campaign = db
    .select()
    .from(discoveryCampaigns)
    .where(eq(discoveryCampaigns.id, flags.campaign))
    .get();
  if (!campaign) {
    console.error(`No campaign with id ${flags.campaign}`);
    process.exitCode = 1;
    return;
  }
  if (campaign.status !== "ENABLED") {
    console.warn(`Warning: campaign "${campaign.name}" is ${campaign.status}, not ENABLED.`);
  }

  const now = new Date();
  const [item] = db
    .insert(workItems)
    .values({
      taskType: "DISCOVER",
      entityId: campaign.id,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.DISCOVER,
      startedAt: now,
    })
    .returning()
    .all();
  if (!item) {
    throw new Error("Failed to create DISCOVER work item");
  }

  console.log(`Running discovery for campaign "${campaign.name}" (${campaign.id})...`);

  const outcome = await runDiscoverTask({
    db,
    workItem: { id: item.id, status: "RUNNING", entityId: campaign.id, attempts: item.attempts },
    targetCount: flags.count ? Number(flags.count) : undefined,
  });

  console.log(`\nWork item status: ${outcome.workItemStatus}`);
  if (outcome.error) {
    console.log(`Error: ${outcome.error}`);
  }
  console.log(`New companies inserted: ${outcome.insertedCompanyIds.length}`);
  console.log(`Duplicates skipped: ${outcome.skippedDuplicateDomains.length}`);
  console.log(`PRESCREEN work items created: ${outcome.createdPrescreenWorkItemIds.length}`);
  if (outcome.costUsd != null) {
    console.log(
      `(cost: $${outcome.costUsd} — check claude.ai/console usage page to confirm this billed to subscription, not API credits)`,
    );
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
