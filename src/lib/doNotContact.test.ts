import { describe, expect, it } from "vitest";
import { isDoNotContact } from "./doNotContact.js";

describe("isDoNotContact", () => {
  it("is false when neither the company nor the contact is flagged", () => {
    expect(isDoNotContact({ companyDoNotContact: false, contactDoNotContact: false })).toBe(false);
  });

  it("is true when the company is flagged", () => {
    expect(isDoNotContact({ companyDoNotContact: true, contactDoNotContact: false })).toBe(true);
  });

  it("is true when the contact is flagged", () => {
    expect(isDoNotContact({ companyDoNotContact: false, contactDoNotContact: true })).toBe(true);
  });

  it("is true when both are flagged", () => {
    expect(isDoNotContact({ companyDoNotContact: true, contactDoNotContact: true })).toBe(true);
  });
});
