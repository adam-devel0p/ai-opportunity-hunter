/**
 * Diversity-aware discovery campaign selection (spec §16): the system should not spend all
 * discovery capacity on one sector just because it was discovered/configured first. Before
 * real outcome data exists to justify weighting by performance, this is implemented as a
 * smooth weighted round-robin (the same algorithm nginx uses for weighted load balancing) over
 * enabled campaigns, weighted by each campaign's operator-set `priority` (spec §49's "operator/
 * campaign-adjustable" priority). This guarantees, over any window of `totalWeight`
 * consecutive selections, every enabled campaign is picked exactly its own weight's share of
 * the time — proportional to priority, but never starved to zero, and never dominated by
 * picking the same highest-priority campaign every single time (which naive "always pick
 * max priority" selection would do, defeating §16's diversity requirement).
 */

export interface SelectableCampaign {
  id: string;
  status: "ENABLED" | "PAUSED" | "DISABLED" | "BLACKLISTED";
  priority: number;
}

/** Opaque, per-campaign running-weight state threaded between selections. */
export type CampaignSelectionState = Readonly<Record<string, number>>;

export const INITIAL_CAMPAIGN_SELECTION_STATE: CampaignSelectionState = {};

/**
 * `priority` is operator-settable and may be 0 (or, in theory, negative). Clamped to a floor
 * of 1 so every enabled campaign always gets *some* share of discovery runs rather than being
 * starved entirely by an unset/zero priority — diversity is the point of this module.
 */
function effectiveWeight(priority: number): number {
  return Math.max(1, priority + 1);
}

export interface CampaignSelectionResult<T extends SelectableCampaign> {
  campaign: T;
  state: CampaignSelectionState;
}

/**
 * Pure smooth-weighted-round-robin selection over `campaigns`, filtered to `ENABLED` ones.
 * Returns `undefined` when nothing is enabled. Callers thread `state` from one call's result
 * into the next call's input to keep the round-robin going across separate selections (e.g.
 * separate CLI invocations backed by a persisted `system_config` row).
 */
export function selectNextCampaign<T extends SelectableCampaign>(
  campaigns: readonly T[],
  state: CampaignSelectionState = INITIAL_CAMPAIGN_SELECTION_STATE,
): CampaignSelectionResult<T> | undefined {
  const enabled = campaigns.filter((campaign) => campaign.status === "ENABLED");
  if (enabled.length === 0) {
    return undefined;
  }

  const nextState: Record<string, number> = { ...state };
  let totalWeight = 0;
  let best: T | undefined;
  let bestCurrentWeight = -Infinity;

  for (const campaign of enabled) {
    const weight = effectiveWeight(campaign.priority);
    totalWeight += weight;
    const currentWeight = (nextState[campaign.id] ?? 0) + weight;
    nextState[campaign.id] = currentWeight;
    if (currentWeight > bestCurrentWeight) {
      bestCurrentWeight = currentWeight;
      best = campaign;
    }
  }

  // `best` is always defined here: `enabled` is non-empty, so the loop runs at least once.
  const selected = best as T;
  nextState[selected.id] = (nextState[selected.id] ?? 0) - totalWeight;

  return { campaign: selected, state: nextState };
}
