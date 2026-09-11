/**
 * Wiring for a `FIND_CONTACT` work item (spec §37-38, PLAN.md Phase 9): loads the opportunity a
 * `FIND_CONTACT` item targets (`entityId` is an opportunity id — set by `offerHandler.ts`, which
 * enqueues this task type unconditionally on every successful offer, so this handler never needs
 * to re-check `opportunities.status` itself) and the owning company, then runs the Contact
 * Research Agent with the opportunity's `affectedRole` as its main targeting signal (spec §37 —
 * "the system should identify the person most likely to own the pain/problem").
 *
 * Every completed FIND_CONTACT task forms exactly one `contacts` row, regardless of how
 * confident the found email is — same "form the record, let a later stage/read-path judge it"
 * pattern as `analyzeHandler.ts` (ADR-0013 part 2). Spec §38's "never represent a guessed email
 * as verified" hard rule is enforced structurally by `src/lib/contactDisplay.ts`, the one read
 * path a later phase (Outreach Writer, the dashboard) should use instead of reading
 * `contacts.emailConfidence` directly — this handler already exercises it when composing its
 * outcome/notes rather than reading the raw column.
 *
 * On success, the opportunity transitions `CONTACT_RESEARCH -> OUTREACH_READY` and a
 * `WRITE_OUTREACH` work item is enqueued (Phase 10's agent, same "each handler wires the next
 * stage's queue regardless of whether that stage's agent is built yet" pattern as every earlier
 * handler).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, contacts, opportunities, workItems } from "../db/schema.js";
import {
  runContactAgent,
  type ContactAgentOutput,
  type RunContactAgentInput,
} from "../agents/contactAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { toContactDisplay } from "../lib/contactDisplay.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { TASK_TYPE_PRIORITY } from "./priority.js";
import {
  transitionOpportunityStatus,
  transitionWorkItemStatus,
  type OpportunityStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

export interface FindContactWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The opportunities id this task finds a contact for (same convention as VERIFY/BUILD_OFFER,
   * set by offerHandler.ts). */
  entityId: string;
  attempts: number;
}

export interface RunFindContactTaskOptions {
  db: Db;
  workItem: FindContactWorkItemContext;
  now?: Date;
  /** Injectable for tests; defaults to the real `runContactAgent` (invokes Claude for real). */
  runContact?: (
    input: RunContactAgentInput,
  ) => Promise<StructuredAgentResult<ContactAgentOutput>>;
}

export interface FindContactTaskOutcome {
  workItemStatus: WorkItemStatus;
  opportunityStatus?: OpportunityStatus;
  contactId?: string;
  emailConfidence?: ContactAgentOutput["emailConfidence"];
  isVerifiedEmail?: boolean;
  isPreferredForInitialOutreach?: boolean;
  createdWriteOutreachWorkItemId?: string | null;
  costUsd?: number | null;
  error?: string;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

export async function runFindContactTask(
  options: RunFindContactTaskOptions,
): Promise<FindContactTaskOutcome> {
  const { db, workItem } = options;
  const now = options.now ?? new Date();

  const opportunity = db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, workItem.entityId))
    .get();
  if (!opportunity) {
    throw new Error(
      `FIND_CONTACT work item ${workItem.id} references unknown opportunity ${workItem.entityId}`,
    );
  }

  const company = db
    .select()
    .from(companies)
    .where(eq(companies.id, opportunity.companyId))
    .get();
  if (!company) {
    throw new Error(
      `Opportunity ${opportunity.id} references unknown company ${opportunity.companyId}`,
    );
  }

  const runContact = options.runContact ?? runContactAgent;

  function handleNonSuccess(
    result: Extract<
      StructuredAgentResult<ContactAgentOutput>,
      { status: "quota_exhausted" | "error" | "invalid_output" }
    >,
  ): FindContactTaskOutcome {
    if (result.status === "quota_exhausted") {
      const nextStatus = transitionWorkItemStatus(workItem.status, "DEFERRED");
      db.update(workItems)
        .set({ status: nextStatus, lastError: result.message, updatedAt: now })
        .where(eq(workItems.id, workItem.id))
        .run();
      return { workItemStatus: nextStatus, error: result.message };
    }
    const failureOutcome = resolveFailureOutcome(
      { errorMessage: result.message, attempts: workItem.attempts + 1 },
      now,
    );
    db.update(workItems)
      .set({
        status: failureOutcome.status,
        attempts: workItem.attempts + 1,
        lastError: result.message,
        runAfter: failureOutcome.runAfter,
        updatedAt: now,
      })
      .where(eq(workItems.id, workItem.id))
      .run();
    return { workItemStatus: failureOutcome.status, error: result.message };
  }

  const result = await runContact({
    company: {
      name: company.name,
      website: company.website,
      industry: company.industry,
      country: company.country,
      sizeEstimate: company.sizeEstimate,
    },
    opportunity: {
      problemTitle: opportunity.problemTitle,
      problemDescription: opportunity.problemDescription,
      affectedRole: opportunity.affectedRole,
    },
  });

  if (result.status !== "success") {
    return handleNonSuccess(result);
  }

  const output = result.data;

  const [contact] = db
    .insert(contacts)
    .values({
      companyId: company.id,
      name: output.name,
      role: output.role,
      source: output.source,
      profileUrl: output.profileUrl,
      email: output.email,
      emailSource: output.emailSource,
      emailConfidence: output.emailConfidence,
    })
    .returning()
    .all();
  if (!contact) {
    throw new Error("Failed to insert contact row");
  }

  const display = toContactDisplay(contact);

  // Same "validate the hop, persist only the final status" pattern as prescreenHandler.ts
  // (ADR-0011 part 5) / analyzeHandler.ts (ADR-0013 part 3) / offerHandler.ts (ADR-0015 part 4).
  const opportunityStatus = transitionOpportunityStatus("CONTACT_RESEARCH", "OUTREACH_READY");
  db.update(opportunities)
    .set({ status: opportunityStatus, updatedAt: now })
    .where(eq(opportunities.id, opportunity.id))
    .run();

  const noteLine =
    `Contact: ${output.name}${output.role ? ` (${output.role})` : ""} — email confidence: ` +
    `${output.emailConfidence}${output.email ? ` (${output.email})` : ""}.`;
  db.update(companies)
    .set({ notes: appendNote(company.notes, noteLine), updatedAt: now })
    .where(eq(companies.id, company.id))
    .run();

  const [writeOutreachItem] = db
    .insert(workItems)
    .values({
      taskType: "WRITE_OUTREACH",
      entityId: opportunity.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.WRITE_OUTREACH,
    })
    .returning()
    .all();

  const completedStatus = transitionWorkItemStatus(workItem.status, "COMPLETED");
  db.update(workItems)
    .set({ status: completedStatus, completedAt: now, updatedAt: now })
    .where(eq(workItems.id, workItem.id))
    .run();

  return {
    workItemStatus: completedStatus,
    opportunityStatus,
    contactId: contact.id,
    emailConfidence: output.emailConfidence,
    isVerifiedEmail: display.isVerifiedEmail,
    isPreferredForInitialOutreach: display.isPreferredForInitialOutreach,
    createdWriteOutreachWorkItemId: writeOutreachItem?.id ?? null,
    costUsd: result.costUsd,
  };
}
