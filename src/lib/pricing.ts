/**
 * Deterministic pricing bands (spec §35). Pure functions only — the Offer Builder Agent proposes
 * a price in whole currency units (same convention as the Opportunity Analysis Agent, ADR-0013
 * part 5); this module is the only thing that decides which band an offer falls into and whether
 * its price is actually within that band's configured range. "The system must not blindly
 * maximize price" (spec §35) is enforced by keeping the band ranges themselves the deterministic
 * ceiling/floor, not something Claude can talk its way around.
 */

export const PRICE_BAND_NAMES = [
  "MICRO_FIX",
  "SMALL_AUTOMATION",
  "WORKFLOW_IMPLEMENTATION",
  "LARGER_IMPLEMENTATION",
] as const;

export type PriceBandName = (typeof PRICE_BAND_NAMES)[number];

export interface PriceRange {
  min: number;
  max: number;
}

export interface PriceBandConfig {
  /** Inclusive price range, whole currency units (e.g. EUR), matching how the Offer Builder
   * Agent (and Phase 6's Opportunity Analysis Agent) expresses prices. */
  price: PriceRange;
  /** Inclusive typical-duration range in days this band is meant to match (spec §35's
   * "approximately X hours/days" guidance, translated to non-overlapping cutoffs — see
   * ADR-0015 for why the boundaries were chosen where they were). */
  durationDays: PriceRange;
}

/**
 * Spec §35's suggested starting bands. Configurable per the spec's own text ("these numbers
 * should be configurable") — every function below takes an optional `bands` override rather than
 * hardcoding these as the only possible values, same pattern as
 * `src/lib/opportunityGate.ts`'s `gateConfig` parameter (no general `system_config` accessor
 * layer exists yet, per ADR-0010 part 8/ADR-0012 part 7/ADR-0014 part 5 — this is the same
 * reasoned-starting-point-as-a-function-parameter pattern, not a new one).
 */
export const DEFAULT_PRICE_BANDS: Record<PriceBandName, PriceBandConfig> = {
  MICRO_FIX: { price: { min: 150, max: 400 }, durationDays: { min: 0, max: 0.5 } },
  SMALL_AUTOMATION: { price: { min: 400, max: 900 }, durationDays: { min: 0.5, max: 1 } },
  WORKFLOW_IMPLEMENTATION: { price: { min: 900, max: 2000 }, durationDays: { min: 1, max: 3 } },
  LARGER_IMPLEMENTATION: { price: { min: 2000, max: 5000 }, durationDays: { min: 3, max: 7 } },
};

/** Spec §35's "Optional Ongoing Support" band — monthly, evaluated independently of the
 * one-off price bands above since it's a separate field (`offers.recurringPrice`). */
export const DEFAULT_RECURRING_SUPPORT_RANGE: PriceRange = { min: 50, max: 500 };

function resolveByDuration(
  days: number,
  bands: Record<PriceBandName, PriceBandConfig>,
): PriceBandName {
  for (const name of PRICE_BAND_NAMES) {
    if (days <= bands[name].durationDays.max) {
      return name;
    }
  }
  // Above every band's max (>7 days by default) — clamp to the largest band rather than
  // inventing a fifth one.
  return PRICE_BAND_NAMES[PRICE_BAND_NAMES.length - 1]!;
}

function resolveByPrice(
  price: number,
  bands: Record<PriceBandName, PriceBandConfig>,
): PriceBandName {
  for (const name of PRICE_BAND_NAMES) {
    if (price <= bands[name].price.max) {
      return name;
    }
  }
  return PRICE_BAND_NAMES[PRICE_BAND_NAMES.length - 1]!;
}

/**
 * Picks the band an offer belongs to. Duration is the primary signal (spec §35 defines each band
 * by effort first, price second) — price is only used as a fallback when duration isn't known,
 * which shouldn't happen in practice once Phase 6 has run (`estimatedDurationDays` is a required
 * agent output) but keeps this function total rather than throwing on a null.
 */
export function resolvePriceBand(
  input: { durationDays: number | null; price: number },
  bands: Record<PriceBandName, PriceBandConfig> = DEFAULT_PRICE_BANDS,
): PriceBandName {
  return input.durationDays != null
    ? resolveByDuration(input.durationDays, bands)
    : resolveByPrice(input.price, bands);
}

export interface OfferPricingInput {
  durationDays: number | null;
  price: number;
  recurringPrice: number | null;
}

export interface OfferPricingResult {
  band: PriceBandName;
  /** Whether `price` actually falls within the resolved band's configured range — per PLAN.md's
   * Phase 8 acceptance criteria, a price outside this range isn't rejected, but the handler must
   * record an explicit justification when it happens (`src/pipeline/offerHandler.ts`). */
  priceInBand: boolean;
  /** `null` when no recurring price was proposed at all (the common case — spec §35 frames
   * recurring revenue as justified only "where genuine ongoing value/cost exists"). */
  recurringInRange: boolean | null;
}

/** Full deterministic pricing evaluation: band selection + in-band checks. Pure, no DB, no
 * Claude call — mirrors `src/lib/opportunityGate.ts`'s shape. */
export function evaluateOfferPricing(
  input: OfferPricingInput,
  bands: Record<PriceBandName, PriceBandConfig> = DEFAULT_PRICE_BANDS,
  recurringRange: PriceRange = DEFAULT_RECURRING_SUPPORT_RANGE,
): OfferPricingResult {
  const band = resolvePriceBand(input, bands);
  const range = bands[band].price;
  const priceInBand = input.price >= range.min && input.price <= range.max;
  const recurringInRange =
    input.recurringPrice == null
      ? null
      : input.recurringPrice >= recurringRange.min &&
        input.recurringPrice <= recurringRange.max;
  return { band, priceInBand, recurringInRange };
}

/** Human-readable pricing band table for the Offer Builder Agent's prompt (spec §35's bands,
 * whatever config is actually in effect — never hardcoded prose duplicating the numbers above). */
export function formatPricingBandGuide(
  bands: Record<PriceBandName, PriceBandConfig> = DEFAULT_PRICE_BANDS,
  recurringRange: PriceRange = DEFAULT_RECURRING_SUPPORT_RANGE,
): string {
  const bandLines = PRICE_BAND_NAMES.map((name) => {
    const config = bands[name];
    return `- ${name}: ${config.price.min}-${config.price.max}, roughly ${config.durationDays.min}-${config.durationDays.max} day(s)`;
  });
  return [
    ...bandLines,
    `- Optional ongoing support (recurringPrice, only where genuinely justified): ${recurringRange.min}-${recurringRange.max}/month`,
  ].join("\n");
}
