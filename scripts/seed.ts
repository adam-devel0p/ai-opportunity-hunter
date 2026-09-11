/**
 * Seed/test mode CLI (spec §99): "provide several known company URLs manually. Run them through
 * screening, research, analysis, verification, offer creation." Useful for tuning prompts against
 * known companies without waiting on live autonomous discovery.
 *
 * Usage:
 *   npm run seed -- add --urls https://a.example,https://b.example
 *     (insert companies at PRESCREEN_PENDING + enqueue PRESCREEN items, then stop — drive them
 *     through with the per-stage scripts, e.g. `npm run prescreen -- --all`, same as any other
 *     discovered company)
 *
 *   npm run seed -- run --urls https://a.example,https://b.example [--stop-after PRESCREEN|RESEARCH|ANALYZE|VERIFY|BUILD_OFFER]
 *     (seed AND immediately drive each company through screening -> research -> analysis ->
 *     verification -> offer creation in-process, real `claude` CLI calls, printing a trail per
 *     stage — stops early for a given company on DISCARD/exclusion/gate failure/task failure,
 *     since there's nothing further to run once that happens)
 *
 * `--urls` accepts a comma-separated list; `--file <path>` reads one URL per line instead
 * (blank lines and lines starting with # are ignored).
 */

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { workItems } from "../src/db/schema.js";
import { seedCompanyForTesting, type SeedCompanyOutcome } from "../src/lib/seedCompanies.js";
import { runPrescreenTask } from "../src/pipeline/prescreenHandler.js";
import { runResearchTask } from "../src/pipeline/researchHandler.js";
import { runAnalyzeTask } from "../src/pipeline/analyzeHandler.js";
import { runVerifyTask } from "../src/pipeline/verifyHandler.js";
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

function loadUrls(flags: Record<string, string>): string[] {
  if (flags.urls) {
    return flags.urls.split(",").map((u) => u.trim()).filter(Boolean);
  }
  if (flags.file) {
    return readFileSync(flags.file, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  }
  return [];
}

const STAGE_ORDER = ["PRESCREEN", "RESEARCH", "ANALYZE", "VERIFY", "BUILD_OFFER"] as const;
type Stage = (typeof STAGE_ORDER)[number];

function startWorkItem(db: Db, id: string, entityId: string, attempts: number, now = new Date()) {
  db.update(workItems).set({ status: "RUNNING", startedAt: now, updatedAt: now }).where(eq(workItems.id, id)).run();
  return { id, status: "RUNNING" as const, entityId, attempts };
}

async function driveCompany(db: Db, dbPath: string, companyId: string, prescreenItemId: string, stopAfter: Stage) {
  const item = startWorkItem(db, prescreenItemId, companyId, 0);
  console.log(`  [PRESCREEN] running...`);
  const prescreen = await runPrescreenTask({ db, workItem: item });
  console.log(`  [PRESCREEN] ${prescreen.workItemStatus}${prescreen.excluded ? " (EXCLUDED)" : prescreen.classification ? ` — ${prescreen.classification}` : ""}`);
  if (prescreen.excluded || prescreen.classification === "DISCARD" || !prescreen.createdResearchWorkItemId) {
    return;
  }
  if (stopAfter === "PRESCREEN") return;

  const researchItem = startWorkItem(db, prescreen.createdResearchWorkItemId, companyId, 0);
  console.log(`  [RESEARCH] running...`);
  const research = await runResearchTask({ db, dbPath, workItem: researchItem });
  console.log(`  [RESEARCH] ${research.workItemStatus} — ${research.insertedEvidenceCount ?? 0} evidence item(s)`);
  if (research.workItemStatus !== "COMPLETED" || !research.createdAnalyzeWorkItemId) return;
  if (stopAfter === "RESEARCH") return;

  const analyzeItem = startWorkItem(db, research.createdAnalyzeWorkItemId, companyId, 0);
  console.log(`  [ANALYZE] running...`);
  const analyze = await runAnalyzeTask({ db, workItem: analyzeItem });
  console.log(`  [ANALYZE] ${analyze.workItemStatus}${analyze.opportunityId ? ` — opportunity ${analyze.opportunityId}` : ""}`);
  if (analyze.workItemStatus !== "COMPLETED" || !analyze.createdVerifyWorkItemId || !analyze.opportunityId) return;
  if (stopAfter === "ANALYZE") return;

  const verifyItem = startWorkItem(db, analyze.createdVerifyWorkItemId, analyze.opportunityId, 0);
  console.log(`  [VERIFY] running...`);
  const verify = await runVerifyTask({ db, workItem: verifyItem });
  console.log(`  [VERIFY] ${verify.workItemStatus} — gate ${verify.gatePassed ? "PASSED" : "FAILED"}${verify.gateReasons?.length ? `: ${verify.gateReasons.join("; ")}` : ""}`);
  if (verify.workItemStatus !== "COMPLETED" || !verify.createdBuildOfferWorkItemId) return;
  if (stopAfter === "VERIFY") return;

  const offerItem = startWorkItem(db, verify.createdBuildOfferWorkItemId, analyze.opportunityId, 0);
  console.log(`  [BUILD_OFFER] running...`);
  const offer = await runBuildOfferTask({ db, workItem: offerItem });
  console.log(`  [BUILD_OFFER] ${offer.workItemStatus}${offer.offerId ? ` — offer ${offer.offerId}` : ""}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);

  if (command !== "add" && command !== "run") {
    console.error("Usage: npm run seed -- <add|run> --urls <url,url,...> | --file <path> [--stop-after STAGE]");
    process.exitCode = 1;
    return;
  }

  const urls = loadUrls(flags);
  if (urls.length === 0) {
    console.error("No URLs given — pass --urls a,b,c or --file <path>.");
    process.exitCode = 1;
    return;
  }

  const stopAfter = (flags["stop-after"] as Stage | undefined) ?? "BUILD_OFFER";
  if (!STAGE_ORDER.includes(stopAfter)) {
    console.error(`--stop-after must be one of: ${STAGE_ORDER.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  for (const url of urls) {
    console.log(`\n${url}`);
    const outcome: SeedCompanyOutcome = seedCompanyForTesting(db, { website: url });
    if (outcome.kind === "already-progressed") {
      console.log(`  Already past screening (lifecycleStatus=${outcome.lifecycleStatus}) — use the per-stage scripts to continue it.`);
      continue;
    }
    console.log(`  Company ${outcome.companyId}, PRESCREEN item ${outcome.workItemId} (${outcome.kind}).`);
    if (command === "add") continue;

    await driveCompany(db, dbPath, outcome.companyId, outcome.workItemId, stopAfter);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
