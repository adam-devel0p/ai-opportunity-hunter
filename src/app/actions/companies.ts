"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "../../lib/appDb";
import {
  excludeCompany,
  requestManualResearch,
  setCompanyDoNotContact,
} from "../../lib/dashboardActions";

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

/** Spec §61 "exclude company permanently". */
export async function excludeCompanyAction(formData: FormData): Promise<void> {
  const companyId = formData.get("companyId");
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new Error("companyId is required");
  }
  const reasonValue = formData.get("reason");
  const reason = typeof reasonValue === "string" && reasonValue.trim().length > 0 ? reasonValue.trim() : undefined;

  excludeCompany(getDb(), companyId, reason);
  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/companies");
}

/** Spec §65 DO_NOT_CONTACT toggle, company-wide. */
export async function setCompanyDoNotContactAction(formData: FormData): Promise<void> {
  const companyId = formData.get("companyId");
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new Error("companyId is required");
  }
  const doNotContact = formData.get("doNotContact") === "true";

  setCompanyDoNotContact(getDb(), companyId, doNotContact);
  revalidatePath(`/companies/${companyId}`);
}
