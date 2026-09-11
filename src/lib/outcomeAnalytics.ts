/**
 * Outcome-based aggregate analytics (spec §47, §74, Phase 13). Plain functions over a `Db`, same
 * "aggregate in TypeScript over `.all()` results" style as `dashboardQueries.ts` — this is a
 * single-operator local app, not a scale where hand-written SQL `GROUP BY` pulls its weight, and
 * keeping every metric's definition in one place is worth more than the query-count savings.
 *
 * Every rate/average here is reported alongside its sample size and a `reliable` flag (spec §74's
 * "avoid misleading metrics when sample sizes are tiny") — a 1-of-1 "100% reply rate" is real
 * arithmetic, but never meaningful, so callers (the dashboard) must be able to tell the two apart
 * and render tiny-sample numbers differently rather than silently trusting the rate.
 */

import type { Db } from "../db/client.js";
import {
  companies,
  discoveryCampaigns,
  offers,
  opportunities,
  opportunityEvaluations,
  outreachDrafts,
  outreachOutcomes,
} from "../db/schema.js";

export const DEFAULT_MIN_SAMPLE_SIZE = 5;

export interface RateStat {
  numerator: number;
  denominator: number;
  /** `null` when `denominator` is 0 — there is no rate to report, not a 0% rate. */
  rate: number | null;
  /** `denominator >= minSampleSize`. Callers should hedge the displayed rate when this is false. */
  reliable: boolean;
}

export interface AverageStat {
  average: number | null;
  sampleSize: number;
  reliable: boolean;
}

export function computeRateStat(
  numerator: number,
  denominator: number,
  minSampleSize: number = DEFAULT_MIN_SAMPLE_SIZE,
): RateStat {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
    reliable: denominator >= minSampleSize,
  };
}

export function computeAverageStat(
  values: number[],
  minSampleSize: number = DEFAULT_MIN_SAMPLE_SIZE,
): AverageStat {
  const sampleSize = values.length;
  return {
    average: sampleSize > 0 ? values.reduce((sum, v) => sum + v, 0) / sampleSize : null,
    sampleSize,
    reliable: sampleSize >= minSampleSize,
  };
}

// --- shared per-sent-draft record -----------------------------------------

interface SentOutreachRecord {
  opportunityId: string;
  companyIndustry: string | null;
  companyCountry: string | null;
  problemCategory: string;
  campaignName: string | null;
  priceBand: (typeof offers.$inferSelect)["priceBand"] | null;
  adjustedScore: number | null;
  replied: boolean;
  positive: boolean;
  meeting: boolean;
  won: boolean;
}

/** Every outreach draft that actually went out (has a `SENT` outcome event, recorded exclusively
 * by `dashboardActions.markSentManually` — spec §41/§45's manual-send requirement), joined against
 * everything a dimension breakdown or the overall metrics need. A draft that was only ever
 * generated/reviewed but never sent contributes to neither — there is no outcome to measure yet. */
function getSentOutreachRecords(db: Db): SentOutreachRecord[] {
  const drafts = db.select().from(outreachDrafts).all();
  const allOutcomes = db.select().from(outreachOutcomes).all();
  const allOpportunities = db.select().from(opportunities).all();
  const allCompanies = db.select().from(companies).all();
  const allEvaluations = db.select().from(opportunityEvaluations).all();
  const allOffers = db.select().from(offers).all();
  const allCampaigns = db.select().from(discoveryCampaigns).all();

  const outcomesByDraft = new Map<string, (typeof allOutcomes)>();
  for (const outcome of allOutcomes) {
    const list = outcomesByDraft.get(outcome.outreachDraftId) ?? [];
    list.push(outcome);
    outcomesByDraft.set(outcome.outreachDraftId, list);
  }

  const opportunityById = new Map(allOpportunities.map((o) => [o.id, o]));
  const companyById = new Map(allCompanies.map((c) => [c.id, c]));
  const evaluationByOpportunityId = new Map(allEvaluations.map((e) => [e.opportunityId, e]));
  const offerByOpportunityId = new Map(allOffers.map((o) => [o.opportunityId, o]));
  const campaignById = new Map(allCampaigns.map((c) => [c.id, c]));

  const records: SentOutreachRecord[] = [];
  for (const draft of drafts) {
    const draftOutcomes = outcomesByDraft.get(draft.id) ?? [];
    if (!draftOutcomes.some((o) => o.event === "SENT")) continue;

    const opportunity = opportunityById.get(draft.opportunityId);
    if (!opportunity) continue;
    const company = companyById.get(opportunity.companyId);
    const evaluation = evaluationByOpportunityId.get(opportunity.id);
    const offer = offerByOpportunityId.get(opportunity.id);
    const campaign = company?.sourceCampaignId
      ? campaignById.get(company.sourceCampaignId)
      : undefined;

    records.push({
      opportunityId: opportunity.id,
      companyIndustry: company?.industry ?? null,
      companyCountry: company?.country ?? null,
      problemCategory: opportunity.problemCategory,
      campaignName: campaign?.name ?? null,
      priceBand: offer?.priceBand ?? null,
      adjustedScore: evaluation?.adjustedScore ?? null,
      replied: draftOutcomes.some((o) => o.event === "REPLIED"),
      positive: draftOutcomes.some((o) => o.event === "INTERESTED"),
      meeting: draftOutcomes.some((o) => o.event === "MEETING"),
      won: draftOutcomes.some((o) => o.event === "WON"),
    });
  }
  return records;
}

// --- overall outcome metrics (spec §74) -----------------------------------

export interface OverallOutcomeMetrics {
  sentCount: number;
  replyRate: RateStat;
  positiveReplyRate: RateStat;
  meetingRate: RateStat;
  winRate: RateStat;
  /** Across every scored opportunity, not just ones that got outreach sent — spec §74's "average
   * opportunity score" is a pipeline-quality metric, independent of outreach outcomes. */
  averageOpportunityScore: AverageStat;
  /** Spec §74's "score versus response" — do higher-scored opportunities actually reply more? */
  scoreVsResponse: {
    repliedAverageScore: AverageStat;
    notRepliedAverageScore: AverageStat;
  };
}

export function getOverallOutcomeMetrics(
  db: Db,
  minSampleSize: number = DEFAULT_MIN_SAMPLE_SIZE,
): OverallOutcomeMetrics {
  const records = getSentOutreachRecords(db);
  const sentCount = records.length;
  const replied = records.filter((r) => r.replied).length;
  const positive = records.filter((r) => r.positive).length;
  const meeting = records.filter((r) => r.meeting).length;
  const won = records.filter((r) => r.won).length;

  const allScores = db
    .select({ adjustedScore: opportunityEvaluations.adjustedScore })
    .from(opportunityEvaluations)
    .all()
    .map((row) => row.adjustedScore);

  const repliedScores = records
    .filter((r) => r.replied && r.adjustedScore != null)
    .map((r) => r.adjustedScore as number);
  const notRepliedScores = records
    .filter((r) => !r.replied && r.adjustedScore != null)
    .map((r) => r.adjustedScore as number);

  return {
    sentCount,
    replyRate: computeRateStat(replied, sentCount, minSampleSize),
    positiveReplyRate: computeRateStat(positive, sentCount, minSampleSize),
    meetingRate: computeRateStat(meeting, sentCount, minSampleSize),
    winRate: computeRateStat(won, sentCount, minSampleSize),
    averageOpportunityScore: computeAverageStat(allScores, minSampleSize),
    scoreVsResponse: {
      repliedAverageScore: computeAverageStat(repliedScores, minSampleSize),
      notRepliedAverageScore: computeAverageStat(notRepliedScores, minSampleSize),
    },
  };
}

// --- performance by dimension (spec §47, §74) -----------------------------

export type PerformanceDimension = "industry" | "country" | "problemCategory" | "campaign" | "priceBand";

export interface DimensionPerformanceRow {
  dimensionValue: string;
  sentCount: number;
  replyRate: RateStat;
  positiveReplyRate: RateStat;
  meetingRate: RateStat;
  winRate: RateStat;
  averageScore: AverageStat;
}

const UNKNOWN_DIMENSION_VALUE = "Unknown";
const UNKNOWN_CAMPAIGN_VALUE = "Manual / no campaign";

function dimensionValueOf(record: SentOutreachRecord, dimension: PerformanceDimension): string {
  switch (dimension) {
    case "industry":
      return record.companyIndustry ?? UNKNOWN_DIMENSION_VALUE;
    case "country":
      return record.companyCountry ?? UNKNOWN_DIMENSION_VALUE;
    case "problemCategory":
      return record.problemCategory;
    case "campaign":
      return record.campaignName ?? UNKNOWN_CAMPAIGN_VALUE;
    case "priceBand":
      return record.priceBand ?? UNKNOWN_DIMENSION_VALUE;
  }
}

function buildDimensionRow(
  dimensionValue: string,
  rows: SentOutreachRecord[],
  minSampleSize: number,
): DimensionPerformanceRow {
  const sentCount = rows.length;
  const replied = rows.filter((r) => r.replied).length;
  const positive = rows.filter((r) => r.positive).length;
  const meeting = rows.filter((r) => r.meeting).length;
  const won = rows.filter((r) => r.won).length;
  const scores = rows.filter((r) => r.adjustedScore != null).map((r) => r.adjustedScore as number);

  return {
    dimensionValue,
    sentCount,
    replyRate: computeRateStat(replied, sentCount, minSampleSize),
    positiveReplyRate: computeRateStat(positive, sentCount, minSampleSize),
    meetingRate: computeRateStat(meeting, sentCount, minSampleSize),
    winRate: computeRateStat(won, sentCount, minSampleSize),
    averageScore: computeAverageStat(scores, minSampleSize),
  };
}

/** Grouped by `dimension`, most-sent-first — spec §47's industry/country/price-band/problem-
 * category/campaign breakdowns and spec §74's "performance by X" metrics are the same query
 * parameterized on which field to group by. */
export function getPerformanceByDimension(
  db: Db,
  dimension: PerformanceDimension,
  minSampleSize: number = DEFAULT_MIN_SAMPLE_SIZE,
): DimensionPerformanceRow[] {
  const records = getSentOutreachRecords(db);
  const groups = new Map<string, SentOutreachRecord[]>();
  for (const record of records) {
    const key = dimensionValueOf(record, dimension);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([value, rows]) => buildDimensionRow(value, rows, minSampleSize))
    .sort((a, b) => b.sentCount - a.sentCount);
}
