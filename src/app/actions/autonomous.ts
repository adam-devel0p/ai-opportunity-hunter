"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../../lib/appDb";
import { getAutonomousMode, setAutonomousMode } from "../../lib/config";

/** Spec §71 pause/resume — a plain form action, no client JS needed. */
export async function toggleAutonomousMode(): Promise<void> {
  const db = getDb();
  const current = getAutonomousMode(db);
  setAutonomousMode(db, !current);
  revalidatePath("/");
}
