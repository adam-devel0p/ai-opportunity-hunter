/**
 * Manual discovery-campaign CRUD CLI (spec §15 — "the system should initially support manually
 * configured campaigns"; PLAN.md Phase 3 explicitly defers a real UI, "campaigns configured via
 * a seed script/CLI for now").
 *
 * Usage:
 *   npm run campaigns -- create --name "UK recruitment agencies" \
 *     --geography UK --industry recruitment --size "5-50 employees" \
 *     --keywords staffing,recruitment --hypothesis "manual candidate screening" --priority 5
 *   npm run campaigns -- list [--status ENABLED|PAUSED|DISABLED|BLACKLISTED]
 *   npm run campaigns -- show <id>
 *   npm run campaigns -- enable <id>
 *   npm run campaigns -- pause <id>
 *   npm run campaigns -- disable <id>
 *   npm run campaigns -- blacklist <id>
 *   npm run campaigns -- priority <id> <number>
 */

import { createDb } from "../src/db/client.js";
import type { DiscoveryCampaignCriteria } from "../src/db/schema.js";
import {
  blacklistCampaign,
  createCampaign,
  disableCampaign,
  enableCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  setCampaignPriority,
  type DiscoveryCampaignStatus,
} from "../src/lib/campaigns.js";

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

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function printCampaign(c: { id: string; name: string; status: string; priority: number; createdBy: string; criteria: unknown }) {
  console.log(
    `${c.id}  [${c.status}]  priority=${c.priority}  ${c.name} (${c.createdBy})\n  criteria: ${JSON.stringify(c.criteria)}`,
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);

  switch (command) {
    case "create": {
      const flags = parseFlags(rest);
      if (!flags.name) {
        console.error("Usage: campaigns create --name <name> [--geography a,b] [--industry a,b] [--size <range>] [--keywords a,b] [--hypothesis <text>] [--priority <n>] [--notes <text>]");
        process.exitCode = 1;
        return;
      }
      const criteria: DiscoveryCampaignCriteria = {
        geography: splitList(flags.geography),
        industry: splitList(flags.industry),
        sizeRange: flags.size,
        keywords: splitList(flags.keywords),
        hypothesis: flags.hypothesis,
      };
      const campaign = createCampaign(db, {
        name: flags.name,
        criteria,
        priority: flags.priority ? Number(flags.priority) : undefined,
        notes: flags.notes ?? null,
      });
      console.log("Created campaign:");
      printCampaign(campaign);
      return;
    }
    case "list": {
      const flags = parseFlags(rest);
      const status = flags.status as DiscoveryCampaignStatus | undefined;
      const campaigns = listCampaigns(db, status ? { status } : undefined);
      if (campaigns.length === 0) {
        console.log("No campaigns found.");
        return;
      }
      campaigns.forEach(printCampaign);
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) {
        console.error("Usage: campaigns show <id>");
        process.exitCode = 1;
        return;
      }
      const campaign = getCampaign(db, id);
      if (!campaign) {
        console.error(`No campaign with id ${id}`);
        process.exitCode = 1;
        return;
      }
      printCampaign(campaign);
      return;
    }
    case "enable":
    case "pause":
    case "disable":
    case "blacklist": {
      const id = rest[0];
      if (!id) {
        console.error(`Usage: campaigns ${command} <id>`);
        process.exitCode = 1;
        return;
      }
      const fn = { enable: enableCampaign, pause: pauseCampaign, disable: disableCampaign, blacklist: blacklistCampaign }[command];
      const campaign = fn(db, id);
      printCampaign(campaign);
      return;
    }
    case "priority": {
      const [id, value] = rest;
      if (!id || value === undefined) {
        console.error("Usage: campaigns priority <id> <number>");
        process.exitCode = 1;
        return;
      }
      const campaign = setCampaignPriority(db, id, Number(value));
      printCampaign(campaign);
      return;
    }
    default: {
      console.error(
        "Usage: campaigns <create|list|show|enable|pause|disable|blacklist|priority> [...]",
      );
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
