import { describe, expect, it } from "vitest";
import {
  INITIAL_CAMPAIGN_SELECTION_STATE,
  selectNextCampaign,
  type CampaignSelectionState,
  type SelectableCampaign,
} from "./campaignSelection.js";

function campaign(
  overrides: Partial<SelectableCampaign> & { id: string },
): SelectableCampaign {
  return { status: "ENABLED", priority: 0, ...overrides };
}

function runMany(
  campaigns: readonly SelectableCampaign[],
  iterations: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  let state: CampaignSelectionState = INITIAL_CAMPAIGN_SELECTION_STATE;
  for (let i = 0; i < iterations; i++) {
    const result = selectNextCampaign(campaigns, state);
    if (!result) continue;
    counts[result.campaign.id] = (counts[result.campaign.id] ?? 0) + 1;
    state = result.state;
  }
  return counts;
}

describe("selectNextCampaign", () => {
  it("returns undefined when no campaign is ENABLED", () => {
    const campaigns = [
      campaign({ id: "a", status: "PAUSED" }),
      campaign({ id: "b", status: "DISABLED" }),
      campaign({ id: "c", status: "BLACKLISTED" }),
    ];
    expect(selectNextCampaign(campaigns)).toBeUndefined();
  });

  it("only ever selects ENABLED campaigns", () => {
    const campaigns = [
      campaign({ id: "a", status: "PAUSED" }),
      campaign({ id: "b", status: "ENABLED" }),
    ];
    const counts = runMany(campaigns, 20);
    expect(counts.a).toBeUndefined();
    expect(counts.b).toBe(20);
  });

  it("distributes evenly across equal-priority campaigns over many iterations", () => {
    const campaigns = [
      campaign({ id: "a" }),
      campaign({ id: "b" }),
      campaign({ id: "c" }),
    ];
    const counts = runMany(campaigns, 300);
    expect(counts.a).toBe(100);
    expect(counts.b).toBe(100);
    expect(counts.c).toBe(100);
  });

  it("weights selection frequency proportionally to priority", () => {
    // weight = priority + 1, so priority 0 -> weight 1, priority 9 -> weight 10.
    const campaigns = [campaign({ id: "low", priority: 0 }), campaign({ id: "high", priority: 9 })];
    const counts = runMany(campaigns, 110); // 110 = 10 full cycles of totalWeight 11
    expect(counts.low).toBe(10);
    expect(counts.high).toBe(100);
  });

  it("never starves a zero-priority campaign even alongside a much higher-priority one", () => {
    const campaigns = [campaign({ id: "low", priority: 0 }), campaign({ id: "high", priority: 99 })];
    const counts = runMany(campaigns, 1000);
    expect(counts.low).toBeGreaterThan(0);
  });

  it("is deterministic given the same campaigns and starting state", () => {
    const campaigns = [campaign({ id: "a", priority: 2 }), campaign({ id: "b", priority: 5 })];
    const first = runMany(campaigns, 50);
    const second = runMany(campaigns, 50);
    expect(first).toEqual(second);
  });

  it("threads selection state across separate calls, not just within one loop", () => {
    const campaigns = [campaign({ id: "a" }), campaign({ id: "b" })];
    const first = selectNextCampaign(campaigns);
    expect(first).toBeDefined();
    const second = selectNextCampaign(campaigns, first!.state);
    expect(second).toBeDefined();
    // Equal weights, empty start: the two picks must differ (round robin, not repetition).
    expect(second!.campaign.id).not.toBe(first!.campaign.id);
  });
});
