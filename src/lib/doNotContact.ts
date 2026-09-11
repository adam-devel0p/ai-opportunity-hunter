/**
 * Spec §64-65: a company or a specific contact can carry a permanent `DO_NOT_CONTACT` state.
 * Once set, autonomous processes must not generate new outreach for that contact unless the
 * operator explicitly reverses it. This is the single predicate both `contactHandler.ts` (skip
 * enqueueing `WRITE_OUTREACH`) and `outreachHandler.ts` (defensive re-check right before
 * generating a draft) call, so the rule can't drift between the two enforcement sites — same
 * "one enforced check" pattern as `contactDisplay.ts`'s `isVerifiedEmail`.
 */

export interface DoNotContactCheckInput {
  companyDoNotContact: boolean;
  contactDoNotContact: boolean;
}

export function isDoNotContact(input: DoNotContactCheckInput): boolean {
  return input.companyDoNotContact || input.contactDoNotContact;
}
