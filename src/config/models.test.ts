import { describe, expect, it } from "vitest";
import { resolveModelAlias } from "./models.js";

describe("resolveModelAlias", () => {
  it("returns the default alias for each tier when no override is set", () => {
    expect(resolveModelAlias("fast", {})).toBe("haiku");
    expect(resolveModelAlias("reasoning", {})).toBe("sonnet");
  });

  it("honors an env override for the matching tier", () => {
    expect(resolveModelAlias("reasoning", { AOH_MODEL_REASONING: "opus" })).toBe("opus");
  });

  it("ignores a blank override and falls back to the default", () => {
    expect(resolveModelAlias("fast", { AOH_MODEL_FAST: "   " })).toBe("haiku");
  });

  it("does not cross-apply an override meant for a different tier", () => {
    expect(resolveModelAlias("fast", { AOH_MODEL_REASONING: "opus" })).toBe("haiku");
  });
});
