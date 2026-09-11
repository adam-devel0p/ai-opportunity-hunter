/**
 * Exclusion rule CLI (spec §61 — company/domain/industry/country blacklist).
 *
 * Usage:
 *   npm run exclusions -- add --type DOMAIN --value example.com [--reason "..."]
 *   npm run exclusions -- add --type INDUSTRY --value gambling [--reason "..."]
 *   npm run exclusions -- add --type COUNTRY --value RU [--reason "..."]
 *   npm run exclusions -- list
 *   npm run exclusions -- remove <id>
 *   npm run exclusions -- exclude-company <company-id> [--reason "..."]
 *   npm run exclusions -- do-not-contact <company-id> [--on|--off]
 */

import { createDb } from "../src/db/client.js";
import { addExclusionRule, listExclusionRules, removeExclusionRule } from "../src/lib/exclusions.js";
import { excludeCompany, setCompanyDoNotContact } from "../src/lib/dashboardActions.js";
import type { ExclusionRuleType } from "../src/lib/exclusions.js";

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
  const [command, ...rest] = process.argv.slice(2);
  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);

  switch (command) {
    case "add": {
      const flags = parseFlags(rest);
      const type = flags.type as ExclusionRuleType | undefined;
      if (!type || !["DOMAIN", "INDUSTRY", "COUNTRY"].includes(type) || !flags.value) {
        console.error("Usage: exclusions add --type DOMAIN|INDUSTRY|COUNTRY --value <value> [--reason <text>]");
        process.exitCode = 1;
        return;
      }
      const rule = addExclusionRule(db, { type, value: flags.value, reason: flags.reason ?? null });
      console.log(`Added rule ${rule.id}: ${rule.type} "${rule.value}"${rule.reason ? ` (${rule.reason})` : ""}`);
      return;
    }
    case "list": {
      const rules = listExclusionRules(db);
      if (rules.length === 0) {
        console.log("No exclusion rules.");
        return;
      }
      for (const rule of rules) {
        console.log(`${rule.id}  [${rule.type}]  ${rule.value}${rule.reason ? ` — ${rule.reason}` : ""}`);
      }
      return;
    }
    case "remove": {
      const id = rest[0];
      if (!id) {
        console.error("Usage: exclusions remove <id>");
        process.exitCode = 1;
        return;
      }
      removeExclusionRule(db, id);
      console.log(`Removed rule ${id}.`);
      return;
    }
    case "exclude-company": {
      const id = rest[0];
      const flags = parseFlags(rest);
      if (!id) {
        console.error("Usage: exclusions exclude-company <company-id> [--reason <text>]");
        process.exitCode = 1;
        return;
      }
      excludeCompany(db, id, flags.reason);
      console.log(`Company ${id} excluded.`);
      return;
    }
    case "do-not-contact": {
      const id = rest[0];
      const flags = parseFlags(rest);
      if (!id) {
        console.error("Usage: exclusions do-not-contact <company-id> [--on|--off]");
        process.exitCode = 1;
        return;
      }
      const enable = flags.off !== "true";
      setCompanyDoNotContact(db, id, enable);
      console.log(`Company ${id} DO_NOT_CONTACT set to ${enable}.`);
      return;
    }
    default: {
      console.error(
        "Usage: exclusions <add|list|remove|exclude-company|do-not-contact> [...]",
      );
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
