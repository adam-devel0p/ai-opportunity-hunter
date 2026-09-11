/**
 * Operator-action write paths for the Phase 12 dashboard (spec §45-46, §72). Plain functions over
 * a `Db`, kept separate from the Next.js "use server" files under `src/app/` so the actual DB
 * logic is unit-testable the same way as every pipeline handler, without needing a running Next
 * server — the `src/app/**\/actions.ts` files are thin wrappers that just call these.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  opportunities,
  outreachDrafts,
  outreachOutcomes,
  workItems,
} from "../db/schema.js";
import { normalizeDomain } from "./normalize.js";
import { TASK_TYPE_PRIORITY } from "../pipeline/priority.js";
import {
  transitionCompanyLifecycle,
  transitionOpportunityStatus,
  transitionWorkItemStatus,
} from "../pipeline/stateMachine.js";

export type RejectionReason = NonNullable<
  (typeof opportunities.$inferSelect)["rejectionReason"]
>;

function requireOpportunity(db: Db, id: string) {
  const opportunity = db.select().from(opportunities).where(eq(opportunities.id, id)).get();
  if (!opportunity) throw new Error(`No opportunity with id ${id}`);
  return opportunity;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

/** Spec §45 "Approve / Good Opportunity" — the operator's own verdict, independent of the
 * pipeline's own VERIFIED/VERIFIER_REJECTED (see ADR-0019). */
export function approveOpportunity(
  db: Db,
  opportunityId: string,
  note?: string,
  now: Date = new Date(),
): void {
  const opportunity = requireOpportunity(db, opportunityId);
  db.update(opportunities)
    .set({
      operatorVerdict: "APPROVED",
      operatorFeedback: note ? appendNote(opportunity.operatorFeedback, note) : opportunity.operatorFeedback,
      updatedAt: now,
    })
    .where(eq(opportunities.id, opportunityId))
    .run();
}

/** Spec §45 "Reject / Bad Opportunity" + §46's rejection-reason picker. */
export function rejectOpportunity(
  db: Db,
  opportunityId: string,
  reason: RejectionReason,
  note?: string,
  now: Date = new Date(),
): void {
  const opportunity = requireOpportunity(db, opportunityId);
  db.update(opportunities)
    .set({
      operatorVerdict: "REJECTED",
      rejectionReason: reason,
      operatorFeedback: note ? appendNote(opportunity.operatorFeedback, note) : opportunity.operatorFeedback,
      updatedAt: now,
    })
    .where(eq(opportunities.id, opportunityId))
    .run();
}

function requireDraft(db: Db, outreachDraftId: string) {
  const draft = db.select().from(outreachDrafts).where(eq(outreachDrafts.id, outreachDraftId)).get();
  if (!draft) throw new Error(`No outreach draft with id ${outreachDraftId}`);
  return draft;
}

/** Spec §45 "Draft Reviewed" — the operator has read the draft (may have edited it outside this
 * system before sending). No state-machine table exists for `outreach_drafts.status` (Phase 10
 * never built one; this is a simple 3-value forward-only progression), so this is a direct
 * update, not a `transitionX` call. */
export function markDraftReviewed(db: Db, outreachDraftId: string, now: Date = new Date()): void {
  requireDraft(db, outreachDraftId);
  db.update(outreachDrafts)
    .set({ status: "REVIEWED", updatedAt: now })
    .where(eq(outreachDrafts.id, outreachDraftId))
    .run();
}

/** Spec §45 "Sent Manually" — the one place `OUTREACH_READY -> SENT` (spec §41/§90) actually
 * happens, since sending is always a manual operator action, never automatic (spec §94). Also
 * records the `SENT` outreach_outcomes event, spec §47's outcome-history requirement. */
export function markSentManually(db: Db, outreachDraftId: string, now: Date = new Date()): void {
  const draft = requireDraft(db, outreachDraftId);
  const opportunity = requireOpportunity(db, draft.opportunityId);

  db.update(outreachDrafts)
    .set({ status: "SENT_MANUALLY", updatedAt: now })
    .where(eq(outreachDrafts.id, outreachDraftId))
    .run();

  const nextStatus = transitionOpportunityStatus(opportunity.status, "SENT");
  db.update(opportunities)
    .set({ status: nextStatus, updatedAt: now })
    .where(eq(opportunities.id, opportunity.id))
    .run();

  db.insert(outreachOutcomes)
    .values({ outreachDraftId, event: "SENT", occurredAt: now })
    .run();
}

/** Spec §45's remaining outcome actions (Got Reply / No Reply / Interested / Not Interested /
 * Meeting / Won / Lost) — each just an append-only `outreach_outcomes` event (spec §47 wants
 * outcome *history*, not a single current-status column, per DATABASE_SCHEMA.md). `SENT` is
 * deliberately excluded here; it only ever comes from `markSentManually`, which also drives the
 * opportunity-status transition that event is coupled to. */
export type RecordableOutreachEvent = Exclude<
  (typeof outreachOutcomes.$inferSelect)["event"],
  "SENT"
>;

export function recordOutreachOutcome(
  db: Db,
  outreachDraftId: string,
  event: RecordableOutreachEvent,
  note?: string,
  now: Date = new Date(),
): void {
  requireDraft(db, outreachDraftId);
  db.insert(outreachOutcomes)
    .values({ outreachDraftId, event, note: note ?? null, occurredAt: now })
    .run();
}

// --- manual research entry (spec §72) --------------------------------------

export interface RequestManualResearchInput {
  website: string;
  name?: string;
}

export type ManualResearchOutcome =
  | { kind: "queued"; companyId: string; workItemId: string }
  | { kind: "already-queued"; companyId: string; workItemId: string }
  | { kind: "already-progressed"; companyId: string; lifecycleStatus: string };

/**
 * Spec §72: the operator enters a company/domain and asks for "research this company now" — the
 * new company should proceed through the same pipeline every other company goes through, starting
 * from research (not discovery/pre-screening, since the operator has already effectively vetted it
 * by naming it directly). A brand-new company is inserted straight at `RESEARCH_PENDING` (the same
 * "insert directly at the right lifecycle stage" pattern `discoverHandler.ts` uses for
 * `PRESCREEN_PENDING`), with a `RESEARCH` work item enqueued immediately.
 *
 * If the domain already exists, this deliberately does NOT force it back through research —
 * `REFRESH_EVIDENCE` (spec §60 re-research) is Phase 14 scope and `researchHandler.ts` assumes a
 * company is at `RESEARCH_PENDING` when a `RESEARCH` item targets it, so re-enqueueing for a
 * company already past that stage would just fail the task on an invalid state transition. Instead
 * this reports the company's current state so the operator can decide what to do (e.g. look at its
 * existing opportunity) — see ADR-0019.
 */
export function requestManualResearch(
  db: Db,
  input: RequestManualResearchInput,
  now: Date = new Date(),
): ManualResearchOutcome {
  const normalizedDomain = normalizeDomain(input.website);
  const existing = db
    .select()
    .from(companies)
    .where(eq(companies.normalizedDomain, normalizedDomain))
    .get();

  if (existing) {
    if (existing.lifecycleStatus !== "RESEARCH_PENDING") {
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
          item.taskType === "RESEARCH" &&
          (item.status === "PENDING" || item.status === "RUNNING" || item.status === "RETRYABLE" ||
            item.status === "DEFERRED"),
      );
    if (pendingItem) {
      return { kind: "already-queued", companyId: existing.id, workItemId: pendingItem.id };
    }
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "RESEARCH",
        entityId: existing.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.RESEARCH,
      })
      .returning()
      .all();
    if (!item) throw new Error("requestManualResearch: failed to enqueue RESEARCH work item");
    return { kind: "queued", companyId: existing.id, workItemId: item.id };
  }

  const [company] = db
    .insert(companies)
    .values({
      name: input.name?.trim() || normalizedDomain,
      normalizedDomain,
      website: input.website,
      lifecycleStatus: "RESEARCH_PENDING",
      notes: "Manually entered by operator for immediate research (spec §72).",
      firstDiscoveredAt: now,
      lastDiscoveredAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all();
  if (!company) throw new Error("requestManualResearch: failed to insert company");

  const [item] = db
    .insert(workItems)
    .values({
      taskType: "RESEARCH",
      entityId: company.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.RESEARCH,
    })
    .returning()
    .all();
  if (!item) throw new Error("requestManualResearch: failed to enqueue RESEARCH work item");

  return { kind: "queued", companyId: company.id, workItemId: item.id };
}

// --- exclusion / DO_NOT_CONTACT operator actions (spec §61, §64-65) --------

function requireCompany(db: Db, id: string) {
  const company = db.select().from(companies).where(eq(companies.id, id)).get();
  if (!company) throw new Error(`No company with id ${id}`);
  return company;
}

const CANCELLABLE_WORK_ITEM_STATUSES = ["PENDING", "RETRYABLE", "DEFERRED"] as const;

/**
 * Spec §61 "exclude company permanently" — sets `lifecycleStatus = EXCLUDED` (the special-case
 * transition `stateMachine.ts` allows from any status) and cancels this company's own not-yet-run
 * `PRESCREEN`/`RESEARCH` work items, so nothing already queued for it runs after the operator has
 * explicitly excluded it. Deliberately scoped to company-stage work only — an opportunity already
 * deep in verification/offer/contact/outreach is left for the operator's existing
 * approve/reject flow rather than silently cascade-cancelled (see ADR-0021).
 */
export function excludeCompany(
  db: Db,
  companyId: string,
  reason?: string,
  now: Date = new Date(),
): void {
  const company = requireCompany(db, companyId);
  const nextLifecycle = transitionCompanyLifecycle(company.lifecycleStatus, "EXCLUDED");
  db.update(companies)
    .set({ lifecycleStatus: nextLifecycle, exclusionReason: reason ?? null, updatedAt: now })
    .where(eq(companies.id, companyId))
    .run();

  const items = db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.entityId, companyId),
        inArray(workItems.taskType, ["PRESCREEN", "RESEARCH"]),
      ),
    )
    .all()
    .filter((item) => (CANCELLABLE_WORK_ITEM_STATUSES as readonly string[]).includes(item.status));
  for (const item of items) {
    const cancelled = transitionWorkItemStatus(item.status, "CANCELLED");
    db.update(workItems).set({ status: cancelled, updatedAt: now }).where(eq(workItems.id, item.id)).run();
  }
}

/** Spec §65: a company-wide DO_NOT_CONTACT toggle, reversible by the operator. */
export function setCompanyDoNotContact(
  db: Db,
  companyId: string,
  doNotContact: boolean,
  now: Date = new Date(),
): void {
  requireCompany(db, companyId);
  db.update(companies).set({ doNotContact, updatedAt: now }).where(eq(companies.id, companyId)).run();
}

/** Spec §65: a per-contact DO_NOT_CONTACT toggle, reversible by the operator. */
export function setContactDoNotContact(
  db: Db,
  contactId: string,
  doNotContact: boolean,
  now: Date = new Date(),
): void {
  const contact = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) throw new Error(`No contact with id ${contactId}`);
  db.update(contacts).set({ doNotContact, updatedAt: now }).where(eq(contacts.id, contactId)).run();
}
