/**
 * Model tier -> `claude -p --model` alias mapping (ADR-0006, spec §52).
 *
 * Aliases are whatever `claude --model <alias>` currently accepts (confirmed against
 * `claude --help` at implementation time — see docs/ARCHITECTURE.md "Model alias
 * configuration" for the current confirmed values and re-verify there if this ever
 * looks stale). Overridable per tier via env vars so an operator can repoint a tier
 * without a code change.
 */

export type ModelTier = "fast" | "reasoning";

const DEFAULT_ALIASES: Record<ModelTier, string> = {
  fast: "haiku",
  reasoning: "sonnet",
};

const ENV_VAR_BY_TIER: Record<ModelTier, string> = {
  fast: "AOH_MODEL_FAST",
  reasoning: "AOH_MODEL_REASONING",
};

export function resolveModelAlias(
  tier: ModelTier,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[ENV_VAR_BY_TIER[tier]];
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return DEFAULT_ALIASES[tier];
}
