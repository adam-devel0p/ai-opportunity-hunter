import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_BANDS,
  DEFAULT_RECURRING_SUPPORT_RANGE,
  evaluateOfferPricing,
  formatPricingBandGuide,
  resolvePriceBand,
} from "./pricing.js";

describe("resolvePriceBand", () => {
  it("picks MICRO_FIX for a few-hours estimate", () => {
    expect(resolvePriceBand({ durationDays: 0.25, price: 250 })).toBe("MICRO_FIX");
  });

  it("picks SMALL_AUTOMATION for a half-day to one-day estimate", () => {
    expect(resolvePriceBand({ durationDays: 0.75, price: 600 })).toBe("SMALL_AUTOMATION");
  });

  it("picks WORKFLOW_IMPLEMENTATION for a one-to-three-day estimate", () => {
    expect(resolvePriceBand({ durationDays: 2, price: 1500 })).toBe("WORKFLOW_IMPLEMENTATION");
  });

  it("picks LARGER_IMPLEMENTATION for a three-to-seven-day estimate", () => {
    expect(resolvePriceBand({ durationDays: 5, price: 3500 })).toBe("LARGER_IMPLEMENTATION");
  });

  it("clamps anything above the largest band's duration to LARGER_IMPLEMENTATION", () => {
    expect(resolvePriceBand({ durationDays: 30, price: 8000 })).toBe("LARGER_IMPLEMENTATION");
  });

  it("falls back to resolving by price when duration is null", () => {
    expect(resolvePriceBand({ durationDays: null, price: 300 })).toBe("MICRO_FIX");
    expect(resolvePriceBand({ durationDays: null, price: 1800 })).toBe("WORKFLOW_IMPLEMENTATION");
  });

  it("respects a custom bands config", () => {
    const customBands = {
      ...DEFAULT_PRICE_BANDS,
      MICRO_FIX: { price: { min: 100, max: 200 }, durationDays: { min: 0, max: 2 } },
    };
    expect(resolvePriceBand({ durationDays: 1.5, price: 150 }, customBands)).toBe("MICRO_FIX");
  });
});

describe("evaluateOfferPricing", () => {
  it("reports priceInBand true when the price falls within the resolved band's range", () => {
    const result = evaluateOfferPricing({ durationDays: 2, price: 1500, recurringPrice: null });
    expect(result.band).toBe("WORKFLOW_IMPLEMENTATION");
    expect(result.priceInBand).toBe(true);
    expect(result.recurringInRange).toBeNull();
  });

  it("reports priceInBand false when the price falls outside the resolved band's range", () => {
    // Duration says WORKFLOW_IMPLEMENTATION (900-2000), but price is priced like a larger job.
    const result = evaluateOfferPricing({ durationDays: 2, price: 4000, recurringPrice: null });
    expect(result.band).toBe("WORKFLOW_IMPLEMENTATION");
    expect(result.priceInBand).toBe(false);
  });

  it("evaluates recurringPrice against the ongoing-support range independently", () => {
    const inRange = evaluateOfferPricing({ durationDays: 2, price: 1500, recurringPrice: 150 });
    expect(inRange.recurringInRange).toBe(true);

    const outOfRange = evaluateOfferPricing({ durationDays: 2, price: 1500, recurringPrice: 5000 });
    expect(outOfRange.recurringInRange).toBe(false);
  });

  it("respects a custom recurring range", () => {
    const result = evaluateOfferPricing(
      { durationDays: 2, price: 1500, recurringPrice: 25 },
      DEFAULT_PRICE_BANDS,
      { min: 10, max: 30 },
    );
    expect(result.recurringInRange).toBe(true);
  });
});

describe("formatPricingBandGuide", () => {
  it("mentions every band name and the recurring-support range", () => {
    const guide = formatPricingBandGuide();
    for (const name of Object.keys(DEFAULT_PRICE_BANDS)) {
      expect(guide).toContain(name);
    }
    expect(guide).toContain(`${DEFAULT_RECURRING_SUPPORT_RANGE.min}-${DEFAULT_RECURRING_SUPPORT_RANGE.max}`);
  });
});
