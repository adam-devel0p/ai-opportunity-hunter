import { describe, expect, it } from "vitest";
import { classifyOpportunityRisk } from "./riskCategory.js";

describe("classifyOpportunityRisk", () => {
  it("classifies a generic automation opportunity as STANDARD", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "customer enquiry handling",
      problemDescription: "Enquiries sit in a shared inbox and go unanswered for days.",
      proposedSolution: "Automated enquiry classification and first-response drafting.",
      implementationStrategy: "Integrate with the existing contact form and email inbox.",
    });
    expect(result.riskCategory).toBe("STANDARD");
    expect(result.matchedReasons).toEqual([]);
  });

  it("classifies an appointment-intake automation for a clinic as STANDARD (spec §8's own example)", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "appointment scheduling",
      problemDescription: "Front desk staff spend significant time manually booking appointments by phone.",
      proposedSolution: "Automate appointment intake and scheduling via an online booking flow.",
      implementationStrategy: "Integrate with the clinic's existing calendar system.",
    });
    expect(result.riskCategory).toBe("STANDARD");
  });

  it("classifies automated patient diagnosis as HIGH_RISK (spec §8's own contrasting example)", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "clinical triage",
      problemDescription: "Patients describe symptoms via an intake form.",
      proposedSolution: "Automatically diagnose the patient's condition from their reported symptoms.",
      implementationStrategy: null,
    });
    expect(result.riskCategory).toBe("HIGH_RISK");
    expect(result.matchedReasons).toContain("medical diagnosis / treatment recommendation");
  });

  it("classifies credit scoring automation as HIGH_RISK", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "loan processing",
      problemDescription: "Loan officers manually review applications.",
      proposedSolution: "Automate credit scoring and approval decisions for loan applications.",
      implementationStrategy: null,
    });
    expect(result.riskCategory).toBe("HIGH_RISK");
    expect(result.matchedReasons).toContain("credit decisions");
  });

  it("classifies surveillance tooling as HIGH_RISK", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "security",
      problemDescription: "The warehouse has no automated monitoring.",
      proposedSolution: "Deploy automated surveillance of the warehouse floor with alerting.",
      implementationStrategy: null,
    });
    expect(result.riskCategory).toBe("HIGH_RISK");
  });

  it("does not flag HIGH_RISK from industry alone when the proposed solution itself is benign", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "administrative overhead",
      problemDescription: "A law firm's intake coordinator manually re-types client contact details.",
      proposedSolution: "Auto-fill a client intake form from an uploaded business card photo.",
      implementationStrategy: null,
    });
    expect(result.riskCategory).toBe("STANDARD");
  });

  it("does not flag a generic technical/SEO 'diagnostic' audit as medical HIGH_RISK (real false positive observed in Phase 7's live smoke test)", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "technical SEO / search-visibility audit",
      problemDescription:
        "Every automated fetch attempt against the site returned HTTP 403 Forbidden.",
      proposedSolution:
        "A short technical crawlability and local-SEO diagnostic: check Google Search Console coverage/crawl-stats for the domain.",
      implementationStrategy:
        "Lead with a free or very low-cost diagnostic as the wedge, producing a short findings report.",
    });
    expect(result.riskCategory).toBe("STANDARD");
  });

  it("matches multiple domains when several are present", () => {
    const result = classifyOpportunityRisk({
      problemCategory: "underwriting",
      problemDescription: "Insurance underwriting decisions are made manually using health records.",
      proposedSolution: "Automate insurance underwriting using applicant health records.",
      implementationStrategy: null,
    });
    expect(result.riskCategory).toBe("HIGH_RISK");
    expect(result.matchedReasons.length).toBeGreaterThan(1);
  });
});
