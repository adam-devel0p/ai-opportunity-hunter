import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/appDb";
import { getOpportunityDetail, type EvidenceWithSource } from "../../../lib/dashboardQueries";
import { toContactDisplay } from "../../../lib/contactDisplay";
import {
  approveOpportunityAction,
  markDraftReviewedAction,
  markSentManuallyAction,
  recordOutreachOutcomeAction,
  rejectOpportunityAction,
} from "../../actions/opportunities";
import { formatCents, formatDateTime } from "../../format";

export const dynamic = "force-dynamic";

const REJECTION_REASONS = [
  "WEAK_EVIDENCE",
  "BAD_PROBLEM",
  "WOULDNT_BUY",
  "TOO_DIFFICULT",
  "TOO_SMALL",
  "TOO_LARGE",
  "ALREADY_SOLVED",
  "POOR_CONTACT",
  "BAD_PRICE",
  "REGULATORY_RISK",
  "GENERIC_IDEA",
  "NOT_INTERESTING",
  "OTHER",
] as const;

const OUTCOME_EVENTS = [
  ["REPLIED", "Got Reply"],
  ["NO_REPLY", "No Reply"],
  ["INTERESTED", "Interested"],
  ["NOT_INTERESTED", "Not Interested"],
  ["MEETING", "Meeting"],
  ["WON", "Won"],
  ["LOST", "Lost"],
] as const;

function EvidenceGroup({ title, items }: { title: string; items: EvidenceWithSource[] }) {
  if (items.length === 0) {
    return (
      <div>
        <h3>{title}</h3>
        <p className="empty-state">None recorded.</p>
      </div>
    );
  }
  return (
    <div>
      <h3>
        {title} ({items.length})
      </h3>
      <div className="evidence-list">
        {items.map((item) => (
          <div className="evidence-item" key={item.id}>
            <div>{item.claim}</div>
            {item.supportingExcerpt && (
              <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
                &ldquo;{item.supportingExcerpt}&rdquo;
              </div>
            )}
            <div className="evidence-item__meta">
              <span className="badge badge--neutral">{item.classification}</span>
              <span>Confidence {Math.round(item.confidence * 100)}%</span>
              {item.sourceRetrievedAt && <span>Retrieved {formatDateTime(item.sourceRetrievedAt)}</span>}
              {item.sourceUrl && (
                <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                  Source
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const detail = getOpportunityDetail(db, id);
  if (!detail) notFound();

  const { opportunity, company, evaluation, evidence, offer, contact, outreachDraft, outreachOutcomes } =
    detail;

  const facts = evidence.filter((e) => e.classification === "FACT");
  const inferences = evidence.filter(
    (e) => e.classification === "INFERENCE" || e.classification === "HYPOTHESIS",
  );
  const unknowns = evidence.filter((e) => e.classification === "UNKNOWN");
  const sourceLinks = Array.from(new Set(evidence.map((e) => e.sourceUrl).filter(Boolean))) as string[];

  const contactDisplay = contact ? toContactDisplay(contact) : null;

  const scoreComponents = evaluation
    ? [
        ["Evidence strength", evaluation.evidenceStrength, 20],
        ["Pain severity", evaluation.painSeverity, 15],
        ["Economic impact", evaluation.economicImpactScore, 15],
        ["Deliverability", evaluation.deliverability, 15],
        ["Purchase likelihood", evaluation.purchaseLikelihood, 10],
        ["Speed to value", evaluation.speedToValue, 5],
        ["Reachability", evaluation.reachability, 5],
        ["Demonstrability", evaluation.demonstrability, 5],
        ["Repeatability", evaluation.repeatability, 5],
        ["Urgency", evaluation.urgency, 5],
      ]
    : [];

  const verifyBadge =
    evaluation?.verifierResult === "KEEP"
      ? "badge badge--good"
      : evaluation?.verifierResult === "REJECT"
        ? "badge badge--bad"
        : "badge badge--neutral";

  const canRecordOutcomes = outreachDraft != null;

  return (
    <>
      <div className="page-header">
        <h1>{opportunity.problemTitle}</h1>
        <p>
          <Link href={`/companies/${company.id}`}>{company.name}</Link> ·{" "}
          <a href={company.website} target="_blank" rel="noreferrer">
            {company.website}
          </a>{" "}
          · {company.country ?? "unknown country"} · {company.industry ?? "unknown industry"}
          {company.sizeEstimate ? ` · ${company.sizeEstimate}` : ""}
        </p>
      </div>

      <div className="card">
        <div className="action-row" style={{ marginBottom: 10 }}>
          <span className="badge badge--neutral">{opportunity.status}</span>
          <span className={verifyBadge}>Verifier: {evaluation?.verifierResult ?? "pending"}</span>
          <span className="badge badge--neutral">Score: {evaluation?.adjustedScore ?? "—"}/100</span>
          <span
            className={
              opportunity.operatorVerdict === "APPROVED"
                ? "badge badge--good"
                : opportunity.operatorVerdict === "REJECTED"
                  ? "badge badge--bad"
                  : "badge badge--neutral"
            }
          >
            Operator: {opportunity.operatorVerdict}
          </span>
        </div>

        <div className="action-row">
          <form action={approveOpportunityAction} className="action-row">
            <input type="hidden" name="opportunityId" value={opportunity.id} />
            <input type="text" name="note" placeholder="Optional note" />
            <button type="submit" className="primary">
              Approve / Good Opportunity
            </button>
          </form>
          <form action={rejectOpportunityAction} className="action-row">
            <input type="hidden" name="opportunityId" value={opportunity.id} />
            <select name="reason" required defaultValue="">
              <option value="" disabled>
                Rejection reason…
              </option>
              {REJECTION_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason.replaceAll("_", " ").toLowerCase()}
                </option>
              ))}
            </select>
            <input type="text" name="note" placeholder="Optional note" />
            <button type="submit" className="danger">
              Reject / Bad Opportunity
            </button>
          </form>
        </div>
        {opportunity.operatorFeedback && (
          <p style={{ marginTop: 10, color: "var(--text-muted)" }}>
            Operator notes: {opportunity.operatorFeedback}
          </p>
        )}
      </div>

      <h2>Human trust (spec §85)</h2>
      <div className="trust-grid">
        <div className="card">
          <h3>Why Claude likes this</h3>
          <p>{opportunity.economicImpact ?? opportunity.problemDescription}</p>
          {scoreComponents.length > 0 && (
            <ul>
              {scoreComponents
                .slice()
                .sort((a, b) => (b[1] as number) - (a[1] as number))
                .slice(0, 3)
                .map(([label, value, max]) => (
                  <li key={label as string}>
                    {label}: {value}/{max}
                  </li>
                ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3>Why the skeptic might reject it</h3>
          {evaluation && (evaluation.verifierWeaknesses?.length || evaluation.verifierDealkillers?.length) ? (
            <ul>
              {[...(evaluation.verifierDealkillers ?? []), ...(evaluation.verifierWeaknesses ?? [])].map(
                (reason, i) => (
                  <li key={i}>{reason}</li>
                ),
              )}
            </ul>
          ) : (
            <p className="empty-state">No weaknesses recorded.</p>
          )}
        </div>
        <div className="card">
          <h3>What we know / infer / don&apos;t know</h3>
          <p>
            {facts.length} fact(s), {inferences.length} inference(s)/hypothesis(es), {unknowns.length} unknown(s).
          </p>
        </div>
        <div className="card">
          <h3>What to verify before contacting them</h3>
          <ul>
            {opportunity.validationQuestion && <li>{opportunity.validationQuestion}</li>}
            {(evaluation?.verifierMissingInfo ?? []).map((item, i) => (
              <li key={i}>{item}</li>
            ))}
            {!opportunity.validationQuestion && !(evaluation?.verifierMissingInfo ?? []).length && (
              <li className="empty-state" style={{ listStyle: "none" }}>
                Nothing flagged.
              </li>
            )}
          </ul>
        </div>
      </div>

      <h2>Problem &amp; solution</h2>
      <div className="card">
        <p>{opportunity.problemDescription}</p>
        <p>
          <strong>Proposed solution:</strong> {opportunity.proposedSolution}
        </p>
        {opportunity.implementationStrategy && (
          <p>
            <strong>Implementation:</strong> {opportunity.implementationStrategy}
          </p>
        )}
        <p>
          <strong>Estimated duration:</strong> {opportunity.estimatedDurationDays ?? "—"} day(s) ·{" "}
          <strong>Suggested price:</strong> {formatCents(opportunity.suggestedPriceMin)}–
          {formatCents(opportunity.suggestedPriceMax)}
          {opportunity.recurringRevenuePossibility
            ? ` · Recurring: ${opportunity.recurringRevenuePossibility}`
            : ""}
        </p>
        {opportunity.demoConcept && (
          <p>
            <strong>Demo concept:</strong> {opportunity.demoConcept}
          </p>
        )}
        {(opportunity.risks ?? []).length > 0 && (
          <p>
            <strong>Risks:</strong> {(opportunity.risks ?? []).join("; ")}
          </p>
        )}
        {(opportunity.existingAlternatives ?? []).length > 0 && (
          <p>
            <strong>Existing alternatives:</strong> {(opportunity.existingAlternatives ?? []).join("; ")}
          </p>
        )}
      </div>

      {offer && (
        <>
          <h2>Offer</h2>
          <div className="card">
            <p>{offer.scope}</p>
            <p>
              <strong>Expected outcome:</strong> {offer.expectedOutcome}
            </p>
            <p>
              <strong>Price:</strong> {formatCents(offer.price)}
              {offer.recurringPrice ? ` + ${formatCents(offer.recurringPrice)}/mo` : ""} ·{" "}
              <strong>Band:</strong> {offer.priceBand} · <strong>Duration:</strong>{" "}
              {offer.durationEstimate ?? "—"}
            </p>
          </div>
        </>
      )}

      <h2>Evidence (spec §44)</h2>
      <EvidenceGroup title="Facts" items={facts} />
      <EvidenceGroup title="Inferences / hypotheses" items={inferences} />
      <EvidenceGroup title="Unknowns" items={unknowns} />

      {contact && contactDisplay && (
        <>
          <h2>Suggested decision-maker</h2>
          <div className="card">
            <p>
              {contact.name}
              {contact.role ? ` — ${contact.role}` : ""}
            </p>
            {contact.email && (
              <p>
                {contact.email}{" "}
                <span
                  className={
                    contactDisplay.isVerifiedEmail ? "badge badge--good" : "badge badge--warn"
                  }
                >
                  {contactDisplay.isVerifiedEmail ? "verified" : contact.emailConfidence.toLowerCase()}
                </span>
              </p>
            )}
            {contact.source && <p style={{ color: "var(--text-muted)" }}>{contact.source}</p>}
            {contact.profileUrl && (
              <a href={contact.profileUrl} target="_blank" rel="noreferrer">
                Profile
              </a>
            )}
          </div>
        </>
      )}

      {outreachDraft && (
        <>
          <h2>Draft email</h2>
          <div className="card">
            <p>
              <strong>Subject:</strong> {outreachDraft.subject}
            </p>
            <p style={{ whiteSpace: "pre-wrap" }}>{outreachDraft.body}</p>
            <p style={{ color: "var(--text-muted)" }}>
              {outreachDraft.wordCount} words · status {outreachDraft.status}
            </p>
            <div className="action-row">
              {outreachDraft.status === "DRAFT" && (
                <form action={markDraftReviewedAction}>
                  <input type="hidden" name="opportunityId" value={opportunity.id} />
                  <input type="hidden" name="outreachDraftId" value={outreachDraft.id} />
                  <button type="submit">Mark Draft Reviewed</button>
                </form>
              )}
              {opportunity.status === "OUTREACH_READY" &&
                (outreachDraft.status === "DRAFT" || outreachDraft.status === "REVIEWED") && (
                  <form action={markSentManuallyAction}>
                    <input type="hidden" name="opportunityId" value={opportunity.id} />
                    <input type="hidden" name="outreachDraftId" value={outreachDraft.id} />
                    <button type="submit" className="primary">
                      Sent Manually
                    </button>
                  </form>
                )}
            </div>
          </div>

          <h2>Outcomes</h2>
          <div className="card">
            {canRecordOutcomes && (
              <form action={recordOutreachOutcomeAction} className="action-row" style={{ marginBottom: 12 }}>
                <input type="hidden" name="opportunityId" value={opportunity.id} />
                <input type="hidden" name="outreachDraftId" value={outreachDraft.id} />
                <select name="event" required defaultValue="">
                  <option value="" disabled>
                    Record outcome…
                  </option>
                  {OUTCOME_EVENTS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input type="text" name="note" placeholder="Optional note" />
                <button type="submit">Record</button>
              </form>
            )}
            {outreachOutcomes.length === 0 ? (
              <p className="empty-state">No outcomes recorded yet.</p>
            ) : (
              <ul className="activity-feed">
                {outreachOutcomes.map((event) => (
                  <li key={event.id}>
                    <time dateTime={event.occurredAt.toISOString()}>
                      {formatDateTime(event.occurredAt)}
                    </time>
                    <span>
                      {event.event}
                      {event.note ? ` — ${event.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {sourceLinks.length > 0 && (
        <>
          <h2>Sources</h2>
          <ul>
            {sourceLinks.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
