/**
 * Enforces spec §38's hard rule — "the system must NEVER represent a guessed email as verified"
 * — at the data-access layer, not merely by trusting every future read path (Phase 10's Outreach
 * Writer, the Phase 12 dashboard) to check `emailConfidence` correctly on its own. `toContactDisplay`
 * is the one function any such read path should build on instead of reading `contacts.email`/
 * `emailConfidence` directly: `isVerifiedEmail` can only ever be true when `emailConfidence` is
 * literally `"VERIFIED"`, by construction, so there is no code path where a `GUESSED` (or any
 * other non-`VERIFIED`) row can be rendered as verified.
 *
 * `isPreferredForInitialOutreach` gives the same treatment to spec §38's softer preference
 * ("initial outreach should strongly prefer publicly listed or independently verified
 * addresses") — true for `PUBLICLY_LISTED`/`VERIFIED`, false for `GUESSED`/`UNKNOWN`.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contacts } from "../db/schema.js";

export type EmailConfidence = (typeof contacts.$inferSelect)["emailConfidence"];

export interface ContactEmailFields {
  email: string | null;
  emailConfidence: EmailConfidence;
}

export interface ContactDisplay<T extends ContactEmailFields = ContactEmailFields> {
  contact: T;
  isVerifiedEmail: boolean;
  isPreferredForInitialOutreach: boolean;
}

export function toContactDisplay<T extends ContactEmailFields>(contact: T): ContactDisplay<T> {
  return {
    contact,
    isVerifiedEmail: contact.emailConfidence === "VERIFIED",
    isPreferredForInitialOutreach:
      contact.emailConfidence === "VERIFIED" || contact.emailConfidence === "PUBLICLY_LISTED",
  };
}

/** The one read path a later phase should call instead of `db.select().from(contacts)...` when
 * it needs a display-safe representation of a single contact. */
export function getContactDisplay(
  db: Db,
  contactId: string,
): ContactDisplay<typeof contacts.$inferSelect> | undefined {
  const row = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  return row ? toContactDisplay(row) : undefined;
}
