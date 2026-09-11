"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../../lib/appDb";
import {
  approveOpportunity,
  markDraftReviewed,
  markSentManually,
  recordOutreachOutcome,
  rejectOpportunity,
  type RecordableOutreachEvent,
  type RejectionReason,
} from "../../lib/dashboardActions";

function requireField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required field "${name}"`);
  }
  return value;
}

function optionalField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Spec §45 "Approve / Good Opportunity". */
export async function approveOpportunityAction(formData: FormData): Promise<void> {
  const opportunityId = requireField(formData, "opportunityId");
  approveOpportunity(getDb(), opportunityId, optionalField(formData, "note"));
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath("/opportunities");
  revalidatePath("/");
}

/** Spec §45 "Reject / Bad Opportunity" + §46's rejection-reason picker. */
export async function rejectOpportunityAction(formData: FormData): Promise<void> {
  const opportunityId = requireField(formData, "opportunityId");
  const reason = requireField(formData, "reason") as RejectionReason;
  rejectOpportunity(getDb(), opportunityId, reason, optionalField(formData, "note"));
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath("/opportunities");
  revalidatePath("/");
}

/** Spec §45 "Draft Reviewed". */
export async function markDraftReviewedAction(formData: FormData): Promise<void> {
  const opportunityId = requireField(formData, "opportunityId");
  const outreachDraftId = requireField(formData, "outreachDraftId");
  markDraftReviewed(getDb(), outreachDraftId);
  revalidatePath(`/opportunities/${opportunityId}`);
}

/** Spec §45 "Sent Manually" — drives the real OUTREACH_READY -> SENT transition. */
export async function markSentManuallyAction(formData: FormData): Promise<void> {
  const opportunityId = requireField(formData, "opportunityId");
  const outreachDraftId = requireField(formData, "outreachDraftId");
  markSentManually(getDb(), outreachDraftId);
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath("/opportunities");
  revalidatePath("/");
}

/** Spec §45's remaining outcome events (Got Reply / No Reply / Interested / Not Interested /
 * Meeting / Won / Lost), each with an optional note. */
export async function recordOutreachOutcomeAction(formData: FormData): Promise<void> {
  const opportunityId = requireField(formData, "opportunityId");
  const outreachDraftId = requireField(formData, "outreachDraftId");
  const event = requireField(formData, "event") as RecordableOutreachEvent;
  recordOutreachOutcome(getDb(), outreachDraftId, event, optionalField(formData, "note"));
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath("/");
}
