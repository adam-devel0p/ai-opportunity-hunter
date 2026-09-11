/**
 * Wiring for a `WRITE_OUTREACH` work item (spec §39-41, PLAN.md Phase 10): loads the opportunity
 * a `WRITE_OUTREACH` item targets (`entityId` is an opportunity id, same convention as
 * `VERIFY`/`BUILD_OFFER`/`FIND_CONTACT` — set by `contactHandler.ts`, which enqueues this task
 * type unconditionally on every completed contact search, so this handler trusts that without
 * re-checking `opportunities.status`), its `offers` row, its linked evidence, and the company's
 * most recent `contacts` row (there is no direct opportunity->contact column; contacts are keyed
 * by company, per `contactHandler.ts`'s own docstring), then runs the Outreach Writer.
 *
 * Two deterministic checks run on every generated draft before it's ever persisted
 * (`src/lib/outreachLint.ts`, spec §39-40): word count (60-130 words), a banned-marketing-phrase
 * /generic-mass-email-phrase blocklist, and a truthfulness heuristic. A failing check triggers
 * exactly one regeneration (a second Claude call with the lint's reasons appended as feedback,
 * same "one regeneration then fail" pattern as `offerHandler.ts`'s vague-offer lint) — a second
 * consecutive failure fails the task rather than persisting a non-compliant draft.
 *
 * On success, exactly one `outreach_drafts` row is persisted at `status: "DRAFT"`. Unlike every
 * earlier handler, this one does NOT transition `opportunities.status` — `OUTREACH_READY ->
 * SENT` is an operator action (spec §41/§45: the operator reviews, may edit, and manually sends),
 * not something generating a draft should do automatically. No further work item is enqueued —
 * this is the last automated pipeline stage; what happens next (review, edit, manual send,
 * recording the outcome) is Phase 12/13 territory.
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  evidenceItems,
  offers,
  opportunities,
  outreachDrafts,
  workItems,
} from "../db/schema.js";
import {
  runOutreachAgent,
  type OutreachAgentOutput,
  type RunOutreachAgentInput,
} from "../agents/outreachAgent.js";
import type { StructuredAgentResult } from "../agents/runStructuredAgent.js";
import { toContactDisplay } from "../lib/contactDisplay.js";
import { lintOutreachDraft, type OutreachLintResult } from "../lib/outreachLint.js";
import { resolveFailureOutcome } from "./failureClassification.js";
import { transitionWorkItemStatus, type WorkItemStatus } from "./stateMachine.js";

export interface WriteOutreachWorkItemContext {
  id: string;
  /** Must be "RUNNING" — the caller (worker/CLI) transitions the item to RUNNING before calling this. */
  status: "RUNNING";
  /** The opportunities id this task writes outreach for (same convention as VERIFY/BUILD_OFFER/
   * FIND_CONTACT, set by contactHandler.ts). */
  entityId: string;
  attempts: number;
}

export interface RunWriteOutreachTaskOptions {
  db: Db;
  workItem: WriteOutreachWorkItemContext;
  now?: Date;
  /** Injectable for tests; defaults to the real `runOutreachAgent` (invokes Claude for real). */
  runOutreach?: (
    input: RunOutreachAgentInput,
  ) => Promise<StructuredAgentResult<OutreachAgentOutput>>;
}

export interface WriteOutreachTaskOutcome {
  workItemStatus: WorkItemStatus;
  outreachDraftId?: string;
  wordCount?: number;
  regenerated?: boolean;
  costUsd?: number | null;
  error?: string;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

export async function runWriteOutreachTask(
  options: RunWriteOutreachTaskOptions,
): Promise<WriteOutreachTaskOutcome> {
  const { db, workItem } = options;
  const now = options.now ?? new Date();

  const opportunity = db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, workItem.entityId))
    .get();
  if (!opportunity) {
    throw new Error(
      `WRITE_OUTREACH work item ${workItem.id} references unknown opportunity ${workItem.entityId}`,
    );
  }

  const offer = db.select().from(offers).where(eq(offers.opportunityId, opportunity.id)).get();
  if (!offer) {
    throw new Error(
      `Opportunity ${opportunity.id} has no offers row (Phase 8 should have created one)`,
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

  // Contacts are keyed by company, not opportunity (see contactHandler.ts's docstring) — the
  // most recently found one is the one this opportunity's FIND_CONTACT step just created.
  const contact = db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, company.id))
    .orderBy(desc(contacts.createdAt))
    .get();
  if (!contact) {
    throw new Error(
      `Company ${company.id} has no contacts row (Phase 9 should have created one before enqueueing WRITE_OUTREACH)`,
    );
  }

  const evidenceRows = db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.opportunityId, opportunity.id))
    .all();
  const evidence = evidenceRows.map((item) => ({
    claim: item.claim,
    classification: item.classification,
  }));

  const contactDisplay = toContactDisplay(contact);

  const agentInput: Omit<RunOutreachAgentInput, "regenerationReason"> = {
    company: { name: company.name },
    opportunity: {
      problemTitle: opportunity.problemTitle,
      problemDescription: opportunity.problemDescription,
      proposedSolution: opportunity.proposedSolution,
      affectedRole: opportunity.affectedRole,
    },
    offer: {
      scope: offer.scope,
      expectedOutcome: offer.expectedOutcome,
      demoConcept: offer.demoConcept,
    },
    contact: {
      name: contact.name,
      role: contact.role,
      isPreferredForInitialOutreach: contactDisplay.isPreferredForInitialOutreach,
    },
    evidence,
  };

  const runOutreach = options.runOutreach ?? runOutreachAgent;

  function handleNonSuccess(
    result: Extract<
      StructuredAgentResult<OutreachAgentOutput>,
      { status: "quota_exhausted" | "error" | "invalid_output" }
    >,
  ): WriteOutreachTaskOutcome {
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

  let result = await runOutreach(agentInput);
  if (result.status !== "success") {
    return handleNonSuccess(result);
  }

  let output = result.data;
  let lint: OutreachLintResult = lintOutreachDraft(output, evidence);
  let regenerated = false;

  if (!lint.valid) {
    regenerated = true;
    const retryResult = await runOutreach({
      ...agentInput,
      regenerationReason: lint.reasons.join(" "),
    });
    if (retryResult.status !== "success") {
      return handleNonSuccess(retryResult);
    }
    output = retryResult.data;
    lint = lintOutreachDraft(output, evidence);
    result = retryResult;
  }

  if (!lint.valid) {
    const message = `Outreach draft still failed deterministic checks after one regeneration: ${lint.reasons.join(" ")}`;
    const failureOutcome = resolveFailureOutcome(
      { errorMessage: message, attempts: workItem.attempts + 1 },
      now,
    );
    db.update(workItems)
      .set({
        status: failureOutcome.status,
        attempts: workItem.attempts + 1,
        lastError: message,
        runAfter: failureOutcome.runAfter,
        updatedAt: now,
      })
      .where(eq(workItems.id, workItem.id))
      .run();
    return { workItemStatus: failureOutcome.status, error: message, regenerated };
  }

  const [draft] = db
    .insert(outreachDrafts)
    .values({
      opportunityId: opportunity.id,
      contactId: contact.id,
      subject: output.subject,
      body: output.body,
      wordCount: lint.wordCount,
      status: "DRAFT",
    })
    .returning()
    .all();
  if (!draft) {
    throw new Error("Failed to insert outreach_drafts row");
  }

  const noteLine =
    `Outreach: draft "${output.subject}" to ${contact.name} (${lint.wordCount} words)` +
    (regenerated ? " (regenerated once after failing deterministic checks)" : "") +
    ".";
  db.update(companies)
    .set({ notes: appendNote(company.notes, noteLine), updatedAt: now })
    .where(eq(companies.id, company.id))
    .run();

  const completedStatus = transitionWorkItemStatus(workItem.status, "COMPLETED");
  db.update(workItems)
    .set({ status: completedStatus, completedAt: now, updatedAt: now })
    .where(eq(workItems.id, workItem.id))
    .run();

  return {
    workItemStatus: completedStatus,
    outreachDraftId: draft.id,
    wordCount: lint.wordCount,
    regenerated,
    costUsd: result.costUsd,
  };
}
