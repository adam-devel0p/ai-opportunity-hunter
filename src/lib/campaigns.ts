/**
 * `discovery_campaigns` CRUD (spec §15). Manual only for now — operator-configured via
 * `scripts/campaigns.ts`; Claude-suggested campaign generation is explicitly deferred (the
 * `createdBy` column already distinguishes `MANUAL`/`CLAUDE_SUGGESTED` so no later migration
 * is needed, but nothing in this phase ever writes `CLAUDE_SUGGESTED`).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  discoveryCampaigns,
  type DiscoveryCampaignCriteria,
} from "../db/schema.js";

export type DiscoveryCampaignStatus =
  (typeof discoveryCampaigns.$inferSelect)["status"];
export type DiscoveryCampaign = typeof discoveryCampaigns.$inferSelect;

export interface CreateCampaignInput {
  name: string;
  criteria: DiscoveryCampaignCriteria;
  priority?: number;
  notes?: string | null;
}

/** New campaigns start `ENABLED` — an operator who just configured one clearly wants it to run. */
export function createCampaign(db: Db, input: CreateCampaignInput): DiscoveryCampaign {
  const [row] = db
    .insert(discoveryCampaigns)
    .values({
      name: input.name,
      criteria: input.criteria,
      status: "ENABLED",
      priority: input.priority ?? 0,
      createdBy: "MANUAL",
      notes: input.notes ?? null,
    })
    .returning()
    .all();
  if (!row) {
    throw new Error("createCampaign: insert returned no row");
  }
  return row;
}

export function getCampaign(db: Db, id: string): DiscoveryCampaign | undefined {
  return db
    .select()
    .from(discoveryCampaigns)
    .where(eq(discoveryCampaigns.id, id))
    .get();
}

export function listCampaigns(
  db: Db,
  filter?: { status?: DiscoveryCampaignStatus },
): DiscoveryCampaign[] {
  const rows = db.select().from(discoveryCampaigns).all();
  if (!filter?.status) {
    return rows;
  }
  return rows.filter((row) => row.status === filter.status);
}

function requireCampaign(db: Db, id: string): DiscoveryCampaign {
  const campaign = getCampaign(db, id);
  if (!campaign) {
    throw new Error(`No discovery campaign with id ${id}`);
  }
  return campaign;
}

/**
 * Covers the operator's enable/disable/pause/blacklist actions (spec §15) — all four are
 * reversible operator toggles on the same column, not a pipeline-stage progression, so unlike
 * `src/pipeline/stateMachine.ts`'s enums there's no restricted transition table here: any
 * status can move to any other at the operator's discretion.
 */
export function setCampaignStatus(
  db: Db,
  id: string,
  status: DiscoveryCampaignStatus,
): DiscoveryCampaign {
  requireCampaign(db, id);
  const [row] = db
    .update(discoveryCampaigns)
    .set({ status, updatedAt: new Date() })
    .where(eq(discoveryCampaigns.id, id))
    .returning()
    .all();
  if (!row) {
    throw new Error(`setCampaignStatus: update returned no row for ${id}`);
  }
  return row;
}

export function setCampaignPriority(db: Db, id: string, priority: number): DiscoveryCampaign {
  requireCampaign(db, id);
  const [row] = db
    .update(discoveryCampaigns)
    .set({ priority, updatedAt: new Date() })
    .where(eq(discoveryCampaigns.id, id))
    .returning()
    .all();
  if (!row) {
    throw new Error(`setCampaignPriority: update returned no row for ${id}`);
  }
  return row;
}

export const enableCampaign = (db: Db, id: string) => setCampaignStatus(db, id, "ENABLED");
export const pauseCampaign = (db: Db, id: string) => setCampaignStatus(db, id, "PAUSED");
export const disableCampaign = (db: Db, id: string) => setCampaignStatus(db, id, "DISABLED");
export const blacklistCampaign = (db: Db, id: string) => setCampaignStatus(db, id, "BLACKLISTED");
