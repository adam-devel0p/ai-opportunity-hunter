import { describe, expect, it } from "vitest";
import {
  checkOutreachBannedPhrases,
  checkOutreachTruthfulness,
  checkOutreachWordCount,
  countWords,
  lintOutreachDraft,
  MAX_OUTREACH_WORD_COUNT,
  MIN_OUTREACH_WORD_COUNT,
  type OutreachEvidenceInput,
} from "./outreachLint.js";

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

describe("countWords", () => {
  it("counts whitespace-separated words, ignoring extra whitespace", () => {
    expect(countWords("  one   two\nthree  ")).toBe(3);
  });
});

describe("checkOutreachWordCount", () => {
  it("rejects a body shorter than the minimum", () => {
    const result = checkOutreachWordCount(words(MIN_OUTREACH_WORD_COUNT - 1));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/60-130/);
  });

  it("rejects a body longer than the maximum", () => {
    const result = checkOutreachWordCount(words(MAX_OUTREACH_WORD_COUNT + 1));
    expect(result.valid).toBe(false);
  });

  it("accepts a body at the minimum boundary", () => {
    expect(checkOutreachWordCount(words(MIN_OUTREACH_WORD_COUNT)).valid).toBe(true);
  });

  it("accepts a body at the maximum boundary", () => {
    expect(checkOutreachWordCount(words(MAX_OUTREACH_WORD_COUNT)).valid).toBe(true);
  });
});

describe("checkOutreachBannedPhrases", () => {
  it("catches spec §39's exact banned-phrase examples", () => {
    expect(checkOutreachBannedPhrases("Subject", "Our revolutionary AI solution can help.").valid).toBe(
      false,
    );
    expect(
      checkOutreachBannedPhrases("Subject", "We can transform your business with cutting-edge AI.").valid,
    ).toBe(false);
    expect(checkOutreachBannedPhrases("Subject", "Unlock the power of AI today.").valid).toBe(false);
  });

  it("is case-insensitive and checks the subject too", () => {
    expect(checkOutreachBannedPhrases("REVOLUTIONARY AI for you", "Hi there.").valid).toBe(false);
  });

  it("catches generic mass-email openers", () => {
    expect(checkOutreachBannedPhrases("Subject", "Dear Sir/Madam, we would like to help.").valid).toBe(
      false,
    );
    expect(checkOutreachBannedPhrases("Subject", "To Whom It May Concern, ...").valid).toBe(false);
  });

  it("passes ordinary, non-hyped copy", () => {
    expect(
      checkOutreachBannedPhrases(
        "Candidate intake at ABC",
        "Hi Sarah, I was looking through ABC's recruitment process and noticed a few things.",
      ).valid,
    ).toBe(true);
  });
});

describe("checkOutreachTruthfulness", () => {
  const noFactEvidence: OutreachEvidenceInput[] = [
    { classification: "INFERENCE" },
    { classification: "HYPOTHESIS" },
  ];
  const withFactEvidence: OutreachEvidenceInput[] = [{ classification: "FACT" }];

  it("rejects spec §40's exact bad example when there's no FACT evidence", () => {
    const result = checkOutreachTruthfulness(
      "I noticed your team spends hours doing manual CV sorting.",
      noFactEvidence,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/spends hours/i);
  });

  it("accepts spec §40's exact good example even with no FACT evidence (properly hedged)", () => {
    const result = checkOutreachTruthfulness(
      "I noticed candidates are currently directed to submit their CVs by email. If the first sorting step is still being done manually, I think there may be an easy automation opportunity.",
      noFactEvidence,
    );
    expect(result.valid).toBe(true);
  });

  it("allows a confident, unhedged claim when at least one FACT evidence item exists", () => {
    const result = checkOutreachTruthfulness(
      "I noticed your team spends hours doing manual CV sorting.",
      withFactEvidence,
    );
    expect(result.valid).toBe(true);
  });

  it("passes plain copy with no confident-assertion phrasing at all", () => {
    const result = checkOutreachTruthfulness(
      "Worth a look? Happy to share more details whenever convenient.",
      noFactEvidence,
    );
    expect(result.valid).toBe(true);
  });
});

describe("lintOutreachDraft", () => {
  it("aggregates every failing reason at once", () => {
    const result = lintOutreachDraft(
      { subject: "Revolutionary AI", body: "Too short." },
      [{ classification: "HYPOTHESIS" }],
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("passes a compliant draft", () => {
    const body =
      "Hi Sarah, I was looking through ABC's recruitment process and noticed you currently advertise " +
      "a number of roles with candidates submitting their details through your application form. If " +
      "your recruiters are still doing much of the first-pass CV sorting manually, I think there may " +
      "be a fairly simple automation opportunity there. I could build a workflow that extracts the " +
      "relevant candidate information and gives the recruiter a structured review. Worth a look?";
    const result = lintOutreachDraft(
      { subject: "Candidate intake at ABC", body },
      [{ classification: "INFERENCE" }],
    );
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
