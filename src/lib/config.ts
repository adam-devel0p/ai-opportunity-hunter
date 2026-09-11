/**
 * Typed accessor over `system_config` (spec §70/§71). DATABASE_SCHEMA.md lists a long eventual
 * key set (autonomous mode, country/industry allowlists, score threshold, pricing bands, ...).
 * Phase 11 implemented the two keys the worker loop needs every cycle: autonomous mode on/off
 * (spec §71 pause/resume) and the persisted campaign-selection round-robin state (ADR-0010 part
 * 2's forward pointer). Phase 14 (spec §70 "a config UI beyond autonomous on/off") adds two more:
 * the spec §32 strong-opportunity gate's threshold/floor/high-risk policy (already fully
 * parameterized in `opportunityGate.ts` since Phase 7 — this just wires a live value in instead
 * of always using the code-constant default) and the spec §60 re-research freshness window
 * (`researchFreshness.ts`). Every other `system_config` key from DATABASE_SCHEMA.md's list
 * remains unwritten (see ADR-0021 for why: rewiring pricing bands, discovery volume, etc.
 * mid-phase would touch already-tested Phase 1/6/8 internals for no acceptance-criteria benefit).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { systemConfig } from "../db/schema.js";
import {
  INITIAL_CAMPAIGN_SELECTION_STATE,
  type CampaignSelectionState,
} from "../pipeline/campaignSelection.js";
import {
  DEFAULT_OPPORTUNITY_GATE_CONFIG,
  type OpportunityGateConfig,
} from "./opportunityGate.js";
import { DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS } from "./researchFreshness.js";

const AUTONOMOUS_MODE_KEY = "autonomousMode";
const CAMPAIGN_SELECTION_STATE_KEY = "campaignSelectionState";
const OPPORTUNITY_GATE_CONFIG_KEY = "opportunityGateConfig";
const RE_RESEARCH_WINDOW_MS_KEY = "reResearchWindowMs";

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

function isValidGateConfig(value: unknown): value is OpportunityGateConfig {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).scoreThreshold === "number" &&
    typeof (value as Record<string, unknown>).evidenceStrengthFloor === "number" &&
    typeof (value as Record<string, unknown>).allowHighRisk === "boolean"
  );
}

/** Spec §32's gate threshold/floor/high-risk policy (`opportunityGate.ts`), operator-configurable
 * per spec §70. Falls back to `DEFAULT_OPPORTUNITY_GATE_CONFIG` if unset or malformed. */
export function getOpportunityGateConfig(db: Db): OpportunityGateConfig {
  const value = readConfigValue(db, OPPORTUNITY_GATE_CONFIG_KEY);
  return isValidGateConfig(value) ? value : DEFAULT_OPPORTUNITY_GATE_CONFIG;
}

export function setOpportunityGateConfig(
  db: Db,
  config: OpportunityGateConfig,
  now: Date = new Date(),
): void {
  writeConfigValue(db, OPPORTUNITY_GATE_CONFIG_KEY, config, now);
}

/** Spec §60's re-research freshness window (`researchFreshness.ts`), operator-configurable per
 * spec §70/§70's "re-research interval". Falls back to `DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS` if
 * unset or not a positive number. */
export function getReResearchWindowMs(db: Db): number {
  const value = readConfigValue(db, RE_RESEARCH_WINDOW_MS_KEY);
  return typeof value === "number" && value > 0 ? value : DEFAULT_RESEARCH_FRESHNESS_WINDOW_MS;
}

export function setReResearchWindowMs(db: Db, windowMs: number, now: Date = new Date()): void {
  writeConfigValue(db, RE_RESEARCH_WINDOW_MS_KEY, windowMs, now);
}
