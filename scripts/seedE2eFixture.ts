/**
 * Seeds a deterministic fixture scenario into `AOH_DB_PATH` for Playwright's dashboard smoke
 * tests (Phase 12 acceptance criteria — "viewing an opportunity's full evidence trail,
 * approve/reject with reason, marking sent, toggling autonomous mode, manual company entry").
 * Not a production script — it inserts rows directly, the same way `src/pipeline/*.test.ts`
 * fixtures do, rather than running the real (Claude-invoking) pipeline. Run via
 * `playwright.config.ts`'s `webServer` setup, never by an operator.
 */

import { runMigrations } from "../src/db/migrate.js";
import {
  companies,
  contacts,
  evidenceItems,
  offers,
  opportunities,
  opportunityEvaluations,
  outreachDrafts,
  sources,
} from "../src/db/schema.js";

const dbPath = process.env.AOH_DB_PATH;
if (!dbPath) {
  throw new Error("AOH_DB_PATH must be set");
}

const db = runMigrations(dbPath);

const [company] = db
  .insert(companies)
  .values({
    name: "Northgate Recruitment",
    normalizedDomain: "northgate-recruitment.example",
    website: "https://northgate-recruitment.example",
    country: "UK",
    industry: "recruitment",
    sizeEstimate: "10-20 employees",
    description: "A small independent recruitment agency.",
    lifecycleStatus: "RESEARCHED",
    notes: "Discovery reason: high applicant volume, manual screening.",
  })
  .returning()
  .all();
if (!company) throw new Error("seed: failed to insert company");

const [opportunity] = db
  .insert(opportunities)
  .values({
    companyId: company.id,
    problemTitle: "Slow applicant screening",
    problemDescription:
      "Recruiters manually check every application against role requirements, taking hours per posting.",
    problemCategory: "recruitment operations",
    economicImpact: "Estimated 5 hours/week of recruiter time spent on manual screening.",
    impactAssumptions: [
      { assumption: "5 hours/week spent screening", isKnown: true },
      { assumption: "recruiter time valued at $40/hour", isKnown: false },
    ],
    affectedRole: "recruitment director",
    proposedSolution: "Automated applicant intake and requirement-matching workflow.",
    implementationStrategy: "Integrate with the existing application form and ATS export.",
    dependencies: ["Access to the ATS export format"],
    risks: ["Recruiters may distrust automated shortlisting at first"],
    existingAlternatives: ["Hiring an additional screening coordinator"],
    estimatedDurationDays: 2,
    suggestedPriceMin: 90000,
    suggestedPriceMax: 180000,
    recurringRevenuePossibility: "Monthly support retainer for workflow tweaks.",
    demoConcept: "A sample dashboard showing three anonymized applications pre-screened.",
    confidence: 0.75,
    validationQuestion: "Confirm the exact ATS export format before building the integration.",
    status: "OUTREACH_READY",
  })
  .returning()
  .all();
if (!opportunity) throw new Error("seed: failed to insert opportunity");

db.insert(opportunityEvaluations)
  .values({
    opportunityId: opportunity.id,
    evidenceStrength: 16,
    painSeverity: 12,
    economicImpactScore: 11,
    deliverability: 12,
    purchaseLikelihood: 7,
    speedToValue: 4,
    reachability: 4,
    demonstrability: 4,
    repeatability: 3,
    urgency: 4,
    rawScore: 77,
    penalties: [],
    adjustedScore: 77,
    verifierResult: "KEEP",
    verifierConfidence: 0.72,
    verifierWeaknesses: ["Economic impact relies on an assumed hourly rate, not a confirmed one."],
    verifierUnsupportedAssumptions: ["Recruiter hourly rate of $40 is not sourced."],
    verifierMissingInfo: ["Confirm actual recruiter hourly cost.", "Confirm ATS export format."],
    verifierDealkillers: [],
  })
  .run();

const [source] = db
  .insert(sources)
  .values({
    companyId: company.id,
    url: "https://northgate-recruitment.example/careers",
    retrievedAt: new Date(),
    freshnessState: "FRESH",
  })
  .returning()
  .all();
if (!source) throw new Error("seed: failed to insert source");

db.insert(evidenceItems)
  .values([
    {
      companyId: company.id,
      opportunityId: opportunity.id,
      sourceId: source.id,
      claim: "The careers page lists 12 open roles as of the retrieval date.",
      classification: "FACT",
      supportingExcerpt: "We're hiring for 12 positions across three offices.",
      confidence: 0.95,
    },
    {
      companyId: company.id,
      opportunityId: opportunity.id,
      sourceId: source.id,
      claim: "With 12 open roles, screening volume is likely high enough to be a real time burden.",
      classification: "INFERENCE",
      supportingExcerpt: null,
      confidence: 0.6,
    },
    {
      companyId: company.id,
      opportunityId: opportunity.id,
      sourceId: source.id,
      claim: "Whether they already use any applicant-tracking automation is unknown.",
      classification: "UNKNOWN",
      supportingExcerpt: null,
      confidence: 0.5,
    },
  ])
  .run();

db.insert(offers)
  .values({
    opportunityId: opportunity.id,
    scope:
      "Automated applicant intake workflow that extracts candidate details, checks them against role requirements, and creates a structured recruiter review queue.",
    expectedOutcome: "Recruiters review a structured queue instead of raw applications.",
    keyAssumptions: ["ATS export can be scheduled or webhooked"],
    durationEstimate: "2 days",
    price: 140000,
    recurringPrice: 20000,
    exclusions: "Does not include ATS replacement.",
    validationNeeded: "Confirm export format.",
    demoConcept: "A sample dashboard showing three anonymized applications.",
    priceBand: "WORKFLOW_IMPLEMENTATION",
  })
  .run();

const [contact] = db
  .insert(contacts)
  .values({
    companyId: company.id,
    name: "Jane Doe",
    role: "Recruitment Director",
    source: "Listed on the company's team page.",
    profileUrl: "https://northgate-recruitment.example/team/jane-doe",
    email: "jane.doe@northgate-recruitment.example",
    emailSource: "Listed on the team page.",
    emailConfidence: "PUBLICLY_LISTED",
  })
  .returning()
  .all();
if (!contact) throw new Error("seed: failed to insert contact");

db.insert(outreachDrafts)
  .values({
    opportunityId: opportunity.id,
    contactId: contact.id,
    subject: "A quick idea for your applicant screening",
    body:
      "Hi Jane,\n\nI noticed Northgate has 12 open roles right now, which usually means a lot of " +
      "manual screening. We build a small workflow that checks incoming applications against your " +
      "role requirements automatically, so your team only reviews a shortlist.\n\n" +
      "Worth a quick look? Happy to share a sample dashboard.\n\n[Your name]",
    wordCount: 62,
    status: "DRAFT",
  })
  .run();

console.log(`Seeded company ${company.id}, opportunity ${opportunity.id}`);
