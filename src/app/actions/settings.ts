"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "../../lib/appDb";
import { addExclusionRule, removeExclusionRule, type ExclusionRuleType } from "../../lib/exclusions";
import {
  getOpportunityGateConfig,
  setOpportunityGateConfig,
  setReResearchWindowMs,
} from "../../lib/config";
import { backupDatabase } from "../../lib/backup";

function requireString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

/** Spec §61: add a DOMAIN/INDUSTRY/COUNTRY exclusion rule. */
export async function addExclusionRuleAction(formData: FormData): Promise<void> {
  const type = requireString(formData, "type") as ExclusionRuleType;
  const value = requireString(formData, "value");
  const reasonValue = formData.get("reason");
  const reason = typeof reasonValue === "string" && reasonValue.trim().length > 0 ? reasonValue.trim() : null;

  addExclusionRule(getDb(), { type, value, reason });
  revalidatePath("/settings");
}

export async function removeExclusionRuleAction(formData: FormData): Promise<void> {
  const id = requireString(formData, "id");
  removeExclusionRule(getDb(), id);
  revalidatePath("/settings");
}

/** Spec §70/§32: the strong-opportunity gate's threshold/floor/high-risk policy. */
export async function updateOpportunityGateConfigAction(formData: FormData): Promise<void> {
  const db = getDb();
  const current = getOpportunityGateConfig(db);
  const scoreThresholdRaw = formData.get("scoreThreshold");
  const evidenceStrengthFloorRaw = formData.get("evidenceStrengthFloor");
  setOpportunityGateConfig(db, {
    scoreThreshold:
      typeof scoreThresholdRaw === "string" && scoreThresholdRaw !== ""
        ? Number(scoreThresholdRaw)
        : current.scoreThreshold,
    evidenceStrengthFloor:
      typeof evidenceStrengthFloorRaw === "string" && evidenceStrengthFloorRaw !== ""
        ? Number(evidenceStrengthFloorRaw)
        : current.evidenceStrengthFloor,
    allowHighRisk: formData.get("allowHighRisk") === "on",
  });
  revalidatePath("/settings");
}

/** Spec §60/§70: the re-research freshness window, given in days for operator convenience. */
export async function updateReResearchWindowAction(formData: FormData): Promise<void> {
  const days = requireString(formData, "windowDays");
  setReResearchWindowMs(getDb(), Number(days) * 24 * 60 * 60 * 1000);
  revalidatePath("/settings");
}

/** Spec §80: a one-click backup from the dashboard. */
export async function createBackupAction(): Promise<void> {
  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `./data/backups/aoh-${timestamp}.db`;
  await backupDatabase(dbPath, outPath);
  redirect(`/settings?backup=${encodeURIComponent(outPath)}`);
}
