/**
 * Deterministic exclusion matcher (spec §61). Pure — never touches the DB or Claude — so it's
 * unit-testable the same way as `src/pipeline/priority.ts`/`stateMachine.ts`. `src/lib/exclusions.ts`
 * is the DB-wired caller: it loads the live `exclusion_rules` rows and hands them to this function.
 *
 * Matching is exact (case-insensitive), not substring/fuzzy — an industry/country rule of "UK"
 * should not also silently catch "UK & Ireland" or similar near-misses an operator didn't
 * actually ask to exclude. Domain values are expected to already be normalized (same identity
 * key as `companies.normalizedDomain`), matched exactly.
 */

export interface ExclusionRule {
  id: string;
  type: "DOMAIN" | "INDUSTRY" | "COUNTRY";
  value: string;
  reason: string | null;
}

export interface ExclusionCandidate {
  normalizedDomain: string;
  industry?: string | null;
  country?: string | null;
}

export interface ExclusionCheckResult {
  excluded: boolean;
  /** Present only when `excluded` is true — a human-readable reason combining the rule's own
   * `reason` (if any) with which field/value matched. */
  reason?: string;
  rule?: ExclusionRule;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function describeMatch(rule: ExclusionRule, field: string): string {
  const suffix = rule.reason ? `: ${rule.reason}` : "";
  return `Excluded by operator rule (${field} "${rule.value}")${suffix}.`;
}

export function checkExclusionRules(
  rules: readonly ExclusionRule[],
  candidate: ExclusionCandidate,
): ExclusionCheckResult {
  const domain = normalize(candidate.normalizedDomain);
  const industry = candidate.industry ? normalize(candidate.industry) : null;
  const country = candidate.country ? normalize(candidate.country) : null;

  for (const rule of rules) {
    const ruleValue = normalize(rule.value);
    if (rule.type === "DOMAIN" && ruleValue === domain) {
      return { excluded: true, reason: describeMatch(rule, "domain"), rule };
    }
    if (rule.type === "INDUSTRY" && industry !== null && ruleValue === industry) {
      return { excluded: true, reason: describeMatch(rule, "industry"), rule };
    }
    if (rule.type === "COUNTRY" && country !== null && ruleValue === country) {
      return { excluded: true, reason: describeMatch(rule, "country"), rule };
    }
  }

  return { excluded: false };
}
