/**
 * Seed/test mode (spec §99): "provide several known company URLs manually. Run them through
 * screening, research, analysis, verification, offer creation." Unlike manual research (spec
 * §72, `dashboardActions.requestManualResearch`), which deliberately skips PRESCREEN since the
 * operator naming a specific company has already effectively vetted it, seed mode's whole point
 * is exercising the *entire* pipeline including screening — this is for testing/tuning prompts
 * against known companies, not for fast-tracking a company the operator already trusts.
 *
 * This mirrors `discoverHandler.ts`'s own per-candidate insert logic (dedupe by
 * `normalizedDomain`, insert at `PRESCREEN_PENDING`, enqueue a `PRESCREEN` item) but is driven by
 * a fixed CLI-supplied list instead of the Discovery Agent's output, with no `discovery_campaigns`
 * row involved (`sourceCampaignId` stays null — it's nullable for exactly this reason).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, workItems } from "../db/schema.js";
import { normalizeDomain } from "./normalize.js";
import { TASK_TYPE_PRIORITY } from "../pipeline/priority.js";
import { transitionCompanyLifecycle } from "../pipeline/stateMachine.js";

export interface SeedCompanyInput {
  website: string;
  name?: string;
  industry?: string;
  country?: string;
}

export type SeedCompanyOutcome =
  | { kind: "queued"; companyId: string; workItemId: string }
  | { kind: "already-queued"; companyId: string; workItemId: string }
  | { kind: "already-progressed"; companyId: string; lifecycleStatus: string };

export function seedCompanyForTesting(
  db: Db,
  input: SeedCompanyInput,
  now: Date = new Date(),
): SeedCompanyOutcome {
  const normalizedDomain = normalizeDomain(input.website);
  const existing = db
    .select()
    .from(companies)
    .where(eq(companies.normalizedDomain, normalizedDomain))
    .get();

  if (existing) {
    if (existing.lifecycleStatus !== "PRESCREEN_PENDING") {
      return {
        kind: "already-progressed",
        companyId: existing.id,
        lifecycleStatus: existing.lifecycleStatus,
      };
    }
    const pendingItem = db
      .select()
      .from(workItems)
      .where(eq(workItems.entityId, existing.id))
      .all()
      .find(
        (item) =>
          item.taskType === "PRESCREEN" &&
          (item.status === "PENDING" || item.status === "RUNNING" || item.status === "RETRYABLE" ||
            item.status === "DEFERRED"),
      );
    if (pendingItem) {
      return { kind: "already-queued", companyId: existing.id, workItemId: pendingItem.id };
    }
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "PRESCREEN",
        entityId: existing.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.PRESCREEN,
      })
      .returning()
      .all();
    if (!item) throw new Error("seedCompanyForTesting: failed to enqueue PRESCREEN work item");
    return { kind: "queued", companyId: existing.id, workItemId: item.id };
  }

  const [company] = db
    .insert(companies)
    .values({
      name: input.name?.trim() || normalizedDomain,
      normalizedDomain,
      website: input.website,
      industry: input.industry ?? null,
      country: input.country ?? null,
      lifecycleStatus: "DISCOVERED",
      notes: "Seeded for pipeline/prompt testing (spec §99), not discovered autonomously.",
      firstDiscoveredAt: now,
      lastDiscoveredAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all();
  if (!company) throw new Error("seedCompanyForTesting: failed to insert company");

  const nextLifecycle = transitionCompanyLifecycle("DISCOVERED", "PRESCREEN_PENDING");
  db.update(companies)
    .set({ lifecycleStatus: nextLifecycle, updatedAt: now })
    .where(eq(companies.id, company.id))
    .run();

  const [item] = db
    .insert(workItems)
    .values({
      taskType: "PRESCREEN",
      entityId: company.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.PRESCREEN,
    })
    .returning()
    .all();
  if (!item) throw new Error("seedCompanyForTesting: failed to enqueue PRESCREEN work item");

  return { kind: "queued", companyId: company.id, workItemId: item.id };
}
