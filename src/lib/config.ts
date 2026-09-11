/**
 * Minimal typed accessor over `system_config` (spec §70/§71). DATABASE_SCHEMA.md lists a long
 * eventual key set (autonomous mode, country/industry allowlists, score threshold, pricing
 * bands, ...), but building a general settings layer for all of them is explicitly Phase 14
 * scope (PLAN.md: "a config UI beyond autonomous on/off"). This module only implements the two
 * keys Phase 11 actually needs to read/write every worker cycle: autonomous mode on/off (spec
 * §71 pause/resume) and the persisted campaign-selection round-robin state (ADR-0010 part 2's
 * forward pointer — "can be persisted ... across separate process invocations once Phase 11's
 * worker loop exists"). Every other `system_config` key remains unwritten, same as every prior
 * phase (ADR-0010 part 8, ADR-0012 part 7, ADR-0014 part 5, ADR-0015 part 1).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { systemConfig } from "../db/schema.js";
import {
  INITIAL_CAMPAIGN_SELECTION_STATE,
  type CampaignSelectionState,
} from "../pipeline/campaignSelection.js";

const AUTONOMOUS_MODE_KEY = "autonomousMode";
const CAMPAIGN_SELECTION_STATE_KEY = "campaignSelectionState";

function readConfigValue(db: Db, key: string): unknown {
  const row = db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .get();
  return row?.value;
}

function writeConfigValue(db: Db, key: string, value: unknown, now: Date): void {
  db.insert(systemConfig)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/**
 * Defaults to `false` (paused) when unset — a fresh install must never start spending Claude
 * usage autonomously until the operator explicitly opts in, same "never the default" posture as
 * ADR-0001's stance on paid API fallback.
 */
export function getAutonomousMode(db: Db): boolean {
  return readConfigValue(db, AUTONOMOUS_MODE_KEY) === true;
}

export function setAutonomousMode(
  db: Db,
  enabled: boolean,
  now: Date = new Date(),
): void {
  writeConfigValue(db, AUTONOMOUS_MODE_KEY, enabled, now);
}

/**
 * Round-robin weights threaded through `selectNextCampaign` (spec §16). Falls back to the
 * initial (empty) state if unset or if a stored value doesn't look like the expected shape —
 * campaign selection degrades gracefully to "start the round-robin over" rather than throwing on
 * a corrupt/foreign value in this key.
 */
export function getCampaignSelectionState(db: Db): CampaignSelectionState {
  const value = readConfigValue(db, CAMPAIGN_SELECTION_STATE_KEY);
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (weight) => typeof weight === "number",
    )
  ) {
    return value as CampaignSelectionState;
  }
  return INITIAL_CAMPAIGN_SELECTION_STATE;
}

export function setCampaignSelectionState(
  db: Db,
  state: CampaignSelectionState,
  now: Date = new Date(),
): void {
  writeConfigValue(db, CAMPAIGN_SELECTION_STATE_KEY, state, now);
}
