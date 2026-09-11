import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import type { Db } from "../db/client.js";
import { companies, contacts } from "../db/schema.js";
import { getContactDisplay, toContactDisplay, type ContactEmailFields } from "./contactDisplay.js";

describe("toContactDisplay", () => {
  const base: ContactEmailFields = { email: null, emailConfidence: "UNKNOWN" };

  it("never marks a GUESSED row as verified or preferred, regardless of what else it carries", () => {
    const display = toContactDisplay({
      ...base,
      email: "jane@example.com",
      emailConfidence: "GUESSED",
    });
    expect(display.isVerifiedEmail).toBe(false);
    expect(display.isPreferredForInitialOutreach).toBe(false);
  });

  it("marks a VERIFIED row as both verified and preferred", () => {
    const display = toContactDisplay({
      ...base,
      email: "jane@example.com",
      emailConfidence: "VERIFIED",
    });
    expect(display.isVerifiedEmail).toBe(true);
    expect(display.isPreferredForInitialOutreach).toBe(true);
  });

  it("marks a PUBLICLY_LISTED row as preferred but not verified", () => {
    const display = toContactDisplay({
      ...base,
      email: "jane@example.com",
      emailConfidence: "PUBLICLY_LISTED",
    });
    expect(display.isVerifiedEmail).toBe(false);
    expect(display.isPreferredForInitialOutreach).toBe(true);
  });

  it("marks an UNKNOWN row as neither verified nor preferred", () => {
    const display = toContactDisplay(base);
    expect(display.isVerifiedEmail).toBe(false);
    expect(display.isPreferredForInitialOutreach).toBe(false);
  });

  it("preserves the original contact fields alongside the derived flags", () => {
    const contact = { ...base, email: "jane@example.com", emailConfidence: "GUESSED" as const };
    const display = toContactDisplay(contact);
    expect(display.contact).toBe(contact);
  });
});

describe("getContactDisplay (live DB round trip)", () => {
  let dir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "aoh-contact-display-test-"));
    dbPath = path.join(dir, "test.db");
    db = runMigrations(dbPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("cannot produce a verified representation for a persisted GUESSED row", () => {
    const [company] = db
      .insert(companies)
      .values({
        name: "Northgate Recruitment",
        normalizedDomain: "northgate-recruitment.example",
        website: "https://northgate-recruitment.example",
        country: "UK",
        industry: "recruitment",
        description: "A small independent recruitment agency.",
        lifecycleStatus: "RESEARCHED",
      })
      .returning()
      .all();

    const [contact] = db
      .insert(contacts)
      .values({
        companyId: company!.id,
        name: "Jane Doe",
        role: "Recruitment Director",
        source: "Guessed from a firstname.lastname@domain pattern.",
        email: "jane.doe@northgate-recruitment.example",
        emailSource: "Inferred naming pattern, not confirmed.",
        emailConfidence: "GUESSED",
      })
      .returning()
      .all();

    const display = getContactDisplay(db, contact!.id);

    expect(display).toBeDefined();
    expect(display?.contact.emailConfidence).toBe("GUESSED");
    expect(display?.isVerifiedEmail).toBe(false);
    expect(display?.isPreferredForInitialOutreach).toBe(false);
  });

  it("returns undefined for an unknown contact id", () => {
    expect(getContactDisplay(db, "no-such-contact")).toBeUndefined();
  });
});
