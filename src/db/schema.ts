import { randomUUID } from "node:crypto";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());
const timestamp = (column: string) =>
  integer(column, { mode: "timestamp_ms" });
const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date());

// --- discovery_campaigns -----------------------------------------------

export interface DiscoveryCampaignCriteria {
  geography?: string[];
  industry?: string[];
  sizeRange?: string;
  keywords?: string[];
  hypothesis?: string;
}

export const discoveryCampaigns = sqliteTable("discovery_campaigns", {
  id: id(),
  name: text("name").notNull(),
  criteria: text("criteria", { mode: "json" })
    .notNull()
    .$type<DiscoveryCampaignCriteria>(),
  status: text("status", {
    enum: ["ENABLED", "PAUSED", "DISABLED", "BLACKLISTED"],
  }).notNull(),
  priority: integer("priority").notNull().default(0),
  createdBy: text("created_by", {
    enum: ["MANUAL", "CLAUDE_SUGGESTED"],
  }).notNull(),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- work_items ----------------------------------------------------------
// No FK dependencies of its own (entityId is a polymorphic id, not a strict
// foreign key per DATABASE_SCHEMA.md), so it's safe to declare before the
// tables that reference it (sources, evidence_items). Usually a company or
// opportunity id, per DATABASE_SCHEMA.md — except DISCOVER tasks, which
// don't have a company yet and instead hold a discovery_campaigns id (see
// ADR-0010 and src/pipeline/discoverHandler.ts).

export const workItems = sqliteTable("work_items", {
  id: id(),
  taskType: text("task_type", {
    enum: [
      "DISCOVER",
      "PRESCREEN",
      "RESEARCH",
      "ANALYZE",
      "VERIFY",
      "BUILD_OFFER",
      "FIND_CONTACT",
      "WRITE_OUTREACH",
      "REFRESH_EVIDENCE",
    ],
  }).notNull(),
  entityId: text("entity_id").notNull(),
  status: text("status", {
    enum: [
      "PENDING",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "DEFERRED",
      "RETRYABLE",
      "CANCELLED",
    ],
  }).notNull(),
  priority: integer("priority").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  runAfter: timestamp("run_after"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- companies -------------------------------------------------------------

export const companies = sqliteTable("companies", {
  id: id(),
  name: text("name").notNull(),
  normalizedDomain: text("normalized_domain").notNull().unique(),
  website: text("website").notNull(),
  country: text("country"),
  region: text("region"),
  industry: text("industry"),
  businessType: text("business_type"),
  sizeEstimate: text("size_estimate"),
  sizeConfidence: text("size_confidence", {
    enum: ["FACT", "INFERENCE", "UNKNOWN"],
  }),
  language: text("language"),
  description: text("description"),
  firstDiscoveredAt: timestamp("first_discovered_at")
    .notNull()
    .$defaultFn(() => new Date()),
  lastDiscoveredAt: timestamp("last_discovered_at")
    .notNull()
    .$defaultFn(() => new Date()),
  lastResearchedAt: timestamp("last_researched_at"),
  nextEligibleResearchAt: timestamp("next_eligible_research_at"),
  sourceCampaignId: text("source_campaign_id").references(
    () => discoveryCampaigns.id,
  ),
  // Company-level portion of the spec §90 flow only (discovery through
  // research). Opportunity-specific stages (verification/offer/contact/
  // outreach) live on `opportunities.status` instead, once an opportunity
  // exists — see DATABASE_SCHEMA.md for why the flow is split at that
  // boundary rather than duplicated across both tables.
  lifecycleStatus: text("lifecycle_status", {
    enum: [
      "DISCOVERED",
      "PRESCREEN_PENDING",
      "PRESCREENED",
      "RESEARCH_PENDING",
      "RESEARCHED",
      "NO_OPPORTUNITY",
      "DISCARDED",
      "EXCLUDED",
    ],
  }).notNull(),
  exclusionReason: text("exclusion_reason"),
  doNotContact: integer("do_not_contact", { mode: "boolean" })
    .notNull()
    .default(false),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- opportunities -----------------------------------------------------

export const opportunities = sqliteTable("opportunities", {
  id: id(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  problemTitle: text("problem_title").notNull(),
  problemDescription: text("problem_description").notNull(),
  problemCategory: text("problem_category").notNull(),
  economicImpact: text("economic_impact"),
  impactAssumptions: text("impact_assumptions", { mode: "json" }).$type<
    string[]
  >(),
  affectedRole: text("affected_role"),
  proposedSolution: text("proposed_solution").notNull(),
  implementationStrategy: text("implementation_strategy"),
  dependencies: text("dependencies", { mode: "json" }).$type<string[]>(),
  risks: text("risks", { mode: "json" }).$type<string[]>(),
  estimatedDurationDays: real("estimated_duration_days"),
  suggestedPriceMin: integer("suggested_price_min"),
  suggestedPriceMax: integer("suggested_price_max"),
  recurringRevenuePossibility: text("recurring_revenue_possibility"),
  demoConcept: text("demo_concept"),
  confidence: real("confidence"),
  // Opportunity-specific portion of the spec §90 flow, from formation
  // through handing off to outreach. Terminates at SENT: what happens after
  // an outreach draft is sent (REPLIED/INTERESTED/MEETING/WON/LOST/...) is
  // tracked exclusively by `outreach_outcomes.event`, not duplicated here.
  status: text("status", {
    enum: [
      "OPPORTUNITY_IDENTIFIED",
      "VERIFICATION_PENDING",
      "VERIFIER_REJECTED",
      "VERIFIED",
      "OFFER_READY",
      "CONTACT_RESEARCH",
      "OUTREACH_READY",
      "SENT",
    ],
  }).notNull(),
  operatorFeedback: text("operator_feedback"),
  rejectionReason: text("rejection_reason", {
    enum: [
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
    ],
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- sources -------------------------------------------------------------

export const sources = sqliteTable("sources", {
  id: id(),
  companyId: text("company_id").references(() => companies.id),
  url: text("url").notNull(),
  title: text("title"),
  retrievedAt: timestamp("retrieved_at")
    .notNull()
    .$defaultFn(() => new Date()),
  fetchedByTaskId: text("fetched_by_task_id").references(() => workItems.id),
  freshnessState: text("freshness_state", {
    enum: ["FRESH", "STALE", "UNAVAILABLE"],
  }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- evidence_items ------------------------------------------------------

export const evidenceItems = sqliteTable("evidence_items", {
  id: id(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  opportunityId: text("opportunity_id").references(() => opportunities.id),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id),
  claim: text("claim").notNull(),
  classification: text("classification", {
    enum: ["FACT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"],
  }).notNull(),
  supportingExcerpt: text("supporting_excerpt"),
  confidence: real("confidence").notNull(),
  generatedByTaskId: text("generated_by_task_id").references(
    () => workItems.id,
  ),
  generatedByPromptVersion: text("generated_by_prompt_version"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- opportunity_evaluations ----------------------------------------------

export interface Penalty {
  reason: string;
  amount: number;
}

export const opportunityEvaluations = sqliteTable("opportunity_evaluations", {
  id: id(),
  opportunityId: text("opportunity_id")
    .notNull()
    .references(() => opportunities.id),
  evidenceStrength: integer("evidence_strength").notNull(),
  painSeverity: integer("pain_severity").notNull(),
  economicImpactScore: integer("economic_impact_score").notNull(),
  deliverability: integer("deliverability").notNull(),
  purchaseLikelihood: integer("purchase_likelihood").notNull(),
  speedToValue: integer("speed_to_value").notNull(),
  reachability: integer("reachability").notNull(),
  demonstrability: integer("demonstrability").notNull(),
  repeatability: integer("repeatability").notNull(),
  urgency: integer("urgency").notNull(),
  rawScore: integer("raw_score").notNull(),
  penalties: text("penalties", { mode: "json" })
    .notNull()
    .$type<Penalty[]>(),
  adjustedScore: integer("adjusted_score").notNull(),
  verifierResult: text("verifier_result", { enum: ["KEEP", "REJECT"] }),
  verifierConfidence: real("verifier_confidence"),
  verifierWeaknesses: text("verifier_weaknesses", {
    mode: "json",
  }).$type<string[]>(),
  verifierUnsupportedAssumptions: text("verifier_unsupported_assumptions", {
    mode: "json",
  }).$type<string[]>(),
  verifierMissingInfo: text("verifier_missing_info", {
    mode: "json",
  }).$type<string[]>(),
  verifierDealkillers: text("verifier_dealkillers", {
    mode: "json",
  }).$type<string[]>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- offers ----------------------------------------------------------------

export const offers = sqliteTable("offers", {
  id: id(),
  opportunityId: text("opportunity_id")
    .notNull()
    .references(() => opportunities.id),
  scope: text("scope").notNull(),
  expectedOutcome: text("expected_outcome").notNull(),
  keyAssumptions: text("key_assumptions", { mode: "json" }).$type<string[]>(),
  durationEstimate: text("duration_estimate"),
  price: integer("price").notNull(),
  recurringPrice: integer("recurring_price"),
  exclusions: text("exclusions"),
  validationNeeded: text("validation_needed"),
  demoConcept: text("demo_concept"),
  priceBand: text("price_band", {
    enum: [
      "MICRO_FIX",
      "SMALL_AUTOMATION",
      "WORKFLOW_IMPLEMENTATION",
      "LARGER_IMPLEMENTATION",
    ],
  }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- contacts ----------------------------------------------------------

export const contacts = sqliteTable("contacts", {
  id: id(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  name: text("name").notNull(),
  role: text("role"),
  source: text("source"),
  profileUrl: text("profile_url"),
  email: text("email"),
  emailSource: text("email_source"),
  emailConfidence: text("email_confidence", {
    enum: ["PUBLICLY_LISTED", "VERIFIED", "GUESSED", "UNKNOWN"],
  }).notNull(),
  doNotContact: integer("do_not_contact", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- outreach_drafts -----------------------------------------------------

export const outreachDrafts = sqliteTable("outreach_drafts", {
  id: id(),
  opportunityId: text("opportunity_id")
    .notNull()
    .references(() => opportunities.id),
  contactId: text("contact_id")
    .notNull()
    .references(() => contacts.id),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  wordCount: integer("word_count").notNull(),
  promptVersion: text("prompt_version"),
  status: text("status", {
    enum: ["DRAFT", "REVIEWED", "SENT_MANUALLY"],
  }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- outreach_outcomes ---------------------------------------------------

export const outreachOutcomes = sqliteTable("outreach_outcomes", {
  id: id(),
  outreachDraftId: text("outreach_draft_id")
    .notNull()
    .references(() => outreachDrafts.id),
  event: text("event", {
    enum: [
      "SENT",
      "REPLIED",
      "NO_REPLY",
      "INTERESTED",
      "NOT_INTERESTED",
      "MEETING",
      "WON",
      "LOST",
    ],
  }).notNull(),
  note: text("note"),
  occurredAt: timestamp("occurred_at")
    .notNull()
    .$defaultFn(() => new Date()),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- system_config -----------------------------------------------------

export const systemConfig = sqliteTable("system_config", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<unknown>(),
  updatedAt: updatedAt(),
});

// --- prompt_versions -----------------------------------------------------

export const promptVersions = sqliteTable("prompt_versions", {
  id: text("id").primaryKey(),
  agentType: text("agent_type").notNull(),
  version: integer("version").notNull(),
  template: text("template").notNull(),
  createdAt: createdAt(),
});
