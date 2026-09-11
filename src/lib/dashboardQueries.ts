/**
 * Read-side queries for the Phase 12 dashboard (spec §42-44, §73). Plain functions over a `Db`,
 * not React/Next-specific, so they're unit-testable the same way as every other `src/lib` module
 * and reusable from both server components and Playwright fixture seeding.
 *
 * Aggregates are computed in plain TypeScript over `.all()` results rather than SQL `COUNT`/`JOIN`
 * queries — this is a single-operator local app with row counts in the hundreds/thousands, not a
 * scale where that matters, and it keeps every metric's definition readable in one place instead
 * of scattered across hand-written SQL (same "ordinary deterministic TypeScript" philosophy as
 * `src/lib/scoring.ts`).
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  companies,
  contacts,
  evidenceItems,
  offers,
  opportunities,
  opportunityEvaluations,
  outreachDrafts,
  outreachOutcomes,
  sources,
} from "../db/schema.js";

// --- summary metrics (spec §42) -------------------------------------------

export interface SummaryMetrics {
  companiesDiscovered: number;
  companiesScreened: number;
  companiesAwaitingResearch: number;
  companiesResearched: number;
  opportunitiesGenerated: number;
  opportunitiesRejected: number;
  strongOpportunities: number;
  outreachDraftsReady: number;
  manuallySentOutreach: number;
  replies: number;
  interestedReplies: number;
  meetings: number;
  wonDeals: number;
  lostDeals: number;
}

/** Statuses reached only by an opportunity that survived the spec §32 strong-opportunity gate. */
const STRONG_OPPORTUNITY_STATUSES = new Set([
  "VERIFIED",
  "OFFER_READY",
  "CONTACT_RESEARCH",
  "OUTREACH_READY",
  "SENT",
]);

const UNSCREENED_LIFECYCLE_STATUSES = new Set(["DISCOVERED", "PRESCREEN_PENDING"]);

export function getSummaryMetrics(db: Db): SummaryMetrics {
  const allCompanies = db.select().from(companies).all();
  const allOpportunities = db.select().from(opportunities).all();
  const allDrafts = db.select().from(outreachDrafts).all();
  const allOutcomes = db.select().from(outreachOutcomes).all();

  const countOutcomeEvents = (event: (typeof outreachOutcomes.$inferSelect)["event"]) =>
    allOutcomes.filter((o) => o.event === event).length;

  return {
    companiesDiscovered: allCompanies.length,
    companiesScreened: allCompanies.filter(
      (c) => !UNSCREENED_LIFECYCLE_STATUSES.has(c.lifecycleStatus),
    ).length,
    companiesAwaitingResearch: allCompanies.filter((c) => c.lifecycleStatus === "RESEARCH_PENDING")
      .length,
    companiesResearched: allCompanies.filter((c) => c.lifecycleStatus === "RESEARCHED").length,
    opportunitiesGenerated: allOpportunities.length,
    opportunitiesRejected: allOpportunities.filter(
      (o) => o.status === "VERIFIER_REJECTED" || o.operatorVerdict === "REJECTED",
    ).length,
    strongOpportunities: allOpportunities.filter((o) => STRONG_OPPORTUNITY_STATUSES.has(o.status))
      .length,
    outreachDraftsReady: allDrafts.filter((d) => d.status === "DRAFT" || d.status === "REVIEWED")
      .length,
    manuallySentOutreach: allDrafts.filter((d) => d.status === "SENT_MANUALLY").length,
    replies: countOutcomeEvents("REPLIED"),
    interestedReplies: countOutcomeEvents("INTERESTED"),
    meetings: countOutcomeEvents("MEETING"),
    wonDeals: countOutcomeEvents("WON"),
    lostDeals: countOutcomeEvents("LOST"),
  };
}

// --- opportunity list (spec §43, §73 basic filtering) ----------------------

export interface OpportunityListFilters {
  status?: (typeof opportunities.$inferSelect)["status"];
  verifierResult?: "KEEP" | "REJECT";
  minScore?: number;
  industry?: string;
  country?: string;
  /** Matches against company name or website (spec §73's "company/domain lookup"). */
  search?: string;
}

export interface OpportunityListRow {
  id: string;
  problemTitle: string;
  problemCategory: string;
  status: (typeof opportunities.$inferSelect)["status"];
  operatorVerdict: (typeof opportunities.$inferSelect)["operatorVerdict"];
  adjustedScore: number | null;
  verifierResult: "KEEP" | "REJECT" | null;
  companyId: string;
  companyName: string;
  companyWebsite: string;
  companyCountry: string | null;
  companyIndustry: string | null;
  createdAt: Date;
}

export function listOpportunities(
  db: Db,
  filters: OpportunityListFilters = {},
): OpportunityListRow[] {
  const rows = db
    .select({
      opportunity: opportunities,
      company: companies,
      evaluation: opportunityEvaluations,
    })
    .from(opportunities)
    .innerJoin(companies, eq(opportunities.companyId, companies.id))
    .leftJoin(opportunityEvaluations, eq(opportunityEvaluations.opportunityId, opportunities.id))
    .orderBy(desc(opportunities.createdAt))
    .all();

  const search = filters.search?.trim().toLowerCase();

  return rows
    .filter(({ opportunity, company, evaluation }) => {
      if (filters.status && opportunity.status !== filters.status) return false;
      if (filters.verifierResult && evaluation?.verifierResult !== filters.verifierResult)
        return false;
      if (filters.minScore != null && (evaluation?.adjustedScore ?? -1) < filters.minScore)
        return false;
      if (filters.industry && company.industry !== filters.industry) return false;
      if (filters.country && company.country !== filters.country) return false;
      if (
        search &&
        !company.name.toLowerCase().includes(search) &&
        !company.website.toLowerCase().includes(search) &&
        !company.normalizedDomain.toLowerCase().includes(search)
      )
        return false;
      return true;
    })
    .map(({ opportunity, company, evaluation }) => ({
      id: opportunity.id,
      problemTitle: opportunity.problemTitle,
      problemCategory: opportunity.problemCategory,
      status: opportunity.status,
      operatorVerdict: opportunity.operatorVerdict,
      adjustedScore: evaluation?.adjustedScore ?? null,
      verifierResult: evaluation?.verifierResult ?? null,
      companyId: company.id,
      companyName: company.name,
      companyWebsite: company.website,
      companyCountry: company.country,
      companyIndustry: company.industry,
      createdAt: opportunity.createdAt,
    }));
}

// --- opportunity detail (spec §43-44, §85) --------------------------------

export interface EvidenceWithSource {
  id: string;
  claim: string;
  classification: (typeof evidenceItems.$inferSelect)["classification"];
  supportingExcerpt: string | null;
  confidence: number;
  sourceUrl: string | null;
  sourceRetrievedAt: Date | null;
  sourceFreshness: (typeof sources.$inferSelect)["freshnessState"] | null;
}

export interface OpportunityDetail {
  opportunity: typeof opportunities.$inferSelect;
  company: typeof companies.$inferSelect;
  evaluation: typeof opportunityEvaluations.$inferSelect | null;
  evidence: EvidenceWithSource[];
  offer: typeof offers.$inferSelect | null;
  contact: typeof contacts.$inferSelect | null;
  outreachDraft: typeof outreachDrafts.$inferSelect | null;
  outreachOutcomes: (typeof outreachOutcomes.$inferSelect)[];
}

export function getOpportunityDetail(db: Db, opportunityId: string): OpportunityDetail | undefined {
  const opportunity = db.select().from(opportunities).where(eq(opportunities.id, opportunityId)).get();
  if (!opportunity) return undefined;

  const company = db.select().from(companies).where(eq(companies.id, opportunity.companyId)).get();
  if (!company) return undefined;

  const evaluation = db
    .select()
    .from(opportunityEvaluations)
    .where(eq(opportunityEvaluations.opportunityId, opportunityId))
    .get();

  const evidenceRows = db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.opportunityId, opportunityId))
    .all();
  const sourceRows = db.select().from(sources).where(eq(sources.companyId, company.id)).all();
  const sourceById = new Map(sourceRows.map((s) => [s.id, s]));

  const evidence: EvidenceWithSource[] = evidenceRows.map((item) => {
    const source = sourceById.get(item.sourceId);
    return {
      id: item.id,
      claim: item.claim,
      classification: item.classification,
      supportingExcerpt: item.supportingExcerpt,
      confidence: item.confidence,
      sourceUrl: source?.url ?? null,
      sourceRetrievedAt: source?.retrievedAt ?? null,
      sourceFreshness: source?.freshnessState ?? null,
    };
  });

  const offer = db.select().from(offers).where(eq(offers.opportunityId, opportunityId)).get();

  const contact = db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, company.id))
    .orderBy(desc(contacts.createdAt))
    .get();

  const outreachDraft = db
    .select()
    .from(outreachDrafts)
    .where(eq(outreachDrafts.opportunityId, opportunityId))
    .orderBy(desc(outreachDrafts.createdAt))
    .get();

  const outcomes = outreachDraft
    ? db
        .select()
        .from(outreachOutcomes)
        .where(eq(outreachOutcomes.outreachDraftId, outreachDraft.id))
        .orderBy(desc(outreachOutcomes.occurredAt))
        .all()
    : [];

  return {
    opportunity,
    company,
    evaluation: evaluation ?? null,
    evidence,
    offer: offer ?? null,
    contact: contact ?? null,
    outreachDraft: outreachDraft ?? null,
    outreachOutcomes: outcomes,
  };
}

// --- companies (spec §72 manual research, §73 lookup) ----------------------

export interface CompanyListFilters {
  lifecycleStatus?: (typeof companies.$inferSelect)["lifecycleStatus"];
  search?: string;
}

export function listCompanies(db: Db, filters: CompanyListFilters = {}) {
  const rows = db.select().from(companies).orderBy(desc(companies.lastDiscoveredAt)).all();
  const search = filters.search?.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.lifecycleStatus && row.lifecycleStatus !== filters.lifecycleStatus) return false;
    if (
      search &&
      !row.name.toLowerCase().includes(search) &&
      !row.website.toLowerCase().includes(search) &&
      !row.normalizedDomain.toLowerCase().includes(search)
    )
      return false;
    return true;
  });
}

export function getCompanyByNormalizedDomain(db: Db, normalizedDomain: string) {
  return db.select().from(companies).where(eq(companies.normalizedDomain, normalizedDomain)).get();
}

export interface CompanyDetail {
  company: typeof companies.$inferSelect;
  opportunities: { id: string; problemTitle: string; status: (typeof opportunities.$inferSelect)["status"] }[];
}

export function getCompanyDetail(db: Db, id: string): CompanyDetail | undefined {
  const company = db.select().from(companies).where(eq(companies.id, id)).get();
  if (!company) return undefined;
  const opps = db
    .select({ id: opportunities.id, problemTitle: opportunities.problemTitle, status: opportunities.status })
    .from(opportunities)
    .where(eq(opportunities.companyId, id))
    .orderBy(desc(opportunities.createdAt))
    .all();
  return { company, opportunities: opps };
}
