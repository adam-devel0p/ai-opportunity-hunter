import { describe, expect, it } from "vitest";
import {
  COMPANY_LIFECYCLE_TRANSITIONS,
  InvalidTransitionError,
  OPPORTUNITY_STATUS_TRANSITIONS,
  WORK_ITEM_STATUS_TRANSITIONS,
  transitionCompanyLifecycle,
  transitionOpportunityStatus,
  transitionWorkItemStatus,
  type CompanyLifecycleStatus,
  type OpportunityStatus,
  type WorkItemStatus,
} from "./stateMachine.js";

describe("company lifecycle transitions", () => {
  it("allows every transition declared in the table", () => {
    for (const [from, tos] of Object.entries(COMPANY_LIFECYCLE_TRANSITIONS)) {
      for (const to of tos) {
        expect(
          transitionCompanyLifecycle(from as CompanyLifecycleStatus, to),
        ).toBe(to);
      }
    }
  });

  it("allows EXCLUDED from any non-EXCLUDED state (spec §61 operator override)", () => {
    const allStates = Object.keys(
      COMPANY_LIFECYCLE_TRANSITIONS,
    ) as CompanyLifecycleStatus[];
    for (const from of allStates) {
      if (from === "EXCLUDED") continue;
      expect(transitionCompanyLifecycle(from, "EXCLUDED")).toBe("EXCLUDED");
    }
  });

  it("rejects EXCLUDED -> EXCLUDED (already terminal, not a real transition)", () => {
    expect(() => transitionCompanyLifecycle("EXCLUDED", "EXCLUDED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects skipping stages (DISCOVERED -> RESEARCHED)", () => {
    expect(() =>
      transitionCompanyLifecycle("DISCOVERED", "RESEARCHED"),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects a cross-chain status that was never a valid company state (DISCOVERED -> WON)", () => {
    expect(() =>
      transitionCompanyLifecycle(
        "DISCOVERED",
        "WON" as CompanyLifecycleStatus,
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects any transition out of a terminal state", () => {
    for (const terminal of ["NO_OPPORTUNITY", "DISCARDED"] as const) {
      expect(() =>
        transitionCompanyLifecycle(terminal, "DISCOVERED"),
      ).toThrow(InvalidTransitionError);
    }
  });
});

describe("opportunity status transitions", () => {
  it("allows every transition declared in the table", () => {
    for (const [from, tos] of Object.entries(OPPORTUNITY_STATUS_TRANSITIONS)) {
      for (const to of tos) {
        expect(
          transitionOpportunityStatus(from as OpportunityStatus, to),
        ).toBe(to);
      }
    }
  });

  it("rejects skipping stages (OPPORTUNITY_IDENTIFIED -> VERIFIED)", () => {
    expect(() =>
      transitionOpportunityStatus("OPPORTUNITY_IDENTIFIED", "VERIFIED"),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects moving out of terminal statuses (VERIFIER_REJECTED, SENT)", () => {
    expect(() =>
      transitionOpportunityStatus("VERIFIER_REJECTED", "VERIFICATION_PENDING"),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      transitionOpportunityStatus("SENT", "OUTREACH_READY"),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects a company-chain status that was never a valid opportunity state (OPPORTUNITY_IDENTIFIED -> DISCOVERED)", () => {
    expect(() =>
      transitionOpportunityStatus(
        "OPPORTUNITY_IDENTIFIED",
        "DISCOVERED" as OpportunityStatus,
      ),
    ).toThrow(InvalidTransitionError);
  });
});

describe("work item status transitions", () => {
  it("allows every transition declared in the table", () => {
    for (const [from, tos] of Object.entries(WORK_ITEM_STATUS_TRANSITIONS)) {
      for (const to of tos) {
        expect(transitionWorkItemStatus(from as WorkItemStatus, to)).toBe(to);
      }
    }
  });

  it("rejects PENDING -> COMPLETED (must go through RUNNING)", () => {
    expect(() => transitionWorkItemStatus("PENDING", "COMPLETED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects any transition out of terminal statuses", () => {
    for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      expect(() => transitionWorkItemStatus(terminal, "PENDING")).toThrow(
        InvalidTransitionError,
      );
    }
  });
});
