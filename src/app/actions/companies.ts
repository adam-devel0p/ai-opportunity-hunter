"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "../../lib/appDb";
import { requestManualResearch } from "../../lib/dashboardActions";

/** Spec §72 "Research this company now" — the manual entry point into the same pipeline every
 * other company goes through, starting at RESEARCH (see dashboardActions.ts's docstring for why
 * discovery/pre-screening are skipped for a manually-named company). */
export async function requestManualResearchAction(formData: FormData): Promise<void> {
  const website = formData.get("website");
  if (typeof website !== "string" || website.trim().length === 0) {
    throw new Error("A website URL is required");
  }
  const nameValue = formData.get("name");
  const name = typeof nameValue === "string" && nameValue.trim().length > 0 ? nameValue : undefined;

  const outcome = requestManualResearch(getDb(), { website: website.trim(), name });
  revalidatePath("/companies");
  revalidatePath("/");
  redirect(`/companies/${outcome.companyId}?queued=${outcome.kind}`);
}
