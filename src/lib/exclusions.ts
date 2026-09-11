/**
 * `exclusion_rules` CRUD (spec §61) plus `checkExclusion`, the DB-wired wrapper around
 * `src/pipeline/exclusionCheck.ts`'s pure matcher that `discoverHandler.ts`/`prescreenHandler.ts`
 * actually call. Loads every rule on each check (same "acceptable at this app's scale" tradeoff
 * as `outcomeAnalytics.ts`, ADR-0020 part 4) rather than querying per rule type.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { exclusionRules } from "../db/schema.js";
import { normalizeDomain } from "./normalize.js";
import {
  checkExclusionRules,
  type ExclusionCandidate,
  type ExclusionCheckResult,
  type ExclusionRule,
} from "../pipeline/exclusionCheck.js";

export type ExclusionRuleType = (typeof exclusionRules.$inferSelect)["type"];
export type ExclusionRuleRow = typeof exclusionRules.$inferSelect;

export interface CreateExclusionRuleInput {
  type: ExclusionRuleType;
  /** A raw URL/domain for `DOMAIN` rules (normalized the same way as `companies.normalizedDomain`);
   * free text for `INDUSTRY`/`COUNTRY`. */
  value: string;
  reason?: string | null;
}

function normalizeRuleValue(type: ExclusionRuleType, value: string): string {
  return type === "DOMAIN" ? normalizeDomain(value) : value.trim();
}

export function addExclusionRule(
  db: Db,
  input: CreateExclusionRuleInput,
  now: Date = new Date(),
): ExclusionRuleRow {
  const [row] = db
    .insert(exclusionRules)
    .values({
      type: input.type,
      value: normalizeRuleValue(input.type, input.value),
      reason: input.reason ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all();
  if (!row) throw new Error("addExclusionRule: insert returned no row");
  return row;
}

export function removeExclusionRule(db: Db, id: string): void {
  db.delete(exclusionRules).where(eq(exclusionRules.id, id)).run();
}

export function listExclusionRules(db: Db): ExclusionRuleRow[] {
  return db.select().from(exclusionRules).all();
}

/** Loads every rule fresh and runs the pure matcher — the one enforcement entry point
 * `discoverHandler.ts`/`prescreenHandler.ts` call so the rule can't drift between call sites. */
export function checkExclusion(db: Db, candidate: ExclusionCandidate): ExclusionCheckResult {
  const rules: ExclusionRule[] = listExclusionRules(db).map((row) => ({
    id: row.id,
    type: row.type,
    value: row.value,
    reason: row.reason,
  }));
  return checkExclusionRules(rules, candidate);
}
