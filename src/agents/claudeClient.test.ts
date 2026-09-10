import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSanitizedEnv,
  detectQuotaExhaustion,
  invokeClaude,
  warnIfApiKeyPresent,
} from "./claudeClient.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("buildSanitizedEnv", () => {
  it("strips ANTHROPIC_API_KEY even when set in the parent env", () => {
    const parentEnv = { ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/usr/bin", HOME: "/home/x" };
    const sanitized = buildSanitizedEnv(parentEnv);
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/x");
  });

  it("does not mutate the input env object", () => {
    const parentEnv = { ANTHROPIC_API_KEY: "sk-ant-secret" };
    buildSanitizedEnv(parentEnv);
    expect(parentEnv.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
  });

  it("is a no-op when ANTHROPIC_API_KEY is already absent", () => {
    const parentEnv = { PATH: "/usr/bin" };
    const sanitized = buildSanitizedEnv(parentEnv);
    expect(sanitized).toEqual({ PATH: "/usr/bin" });
  });
});

describe("warnIfApiKeyPresent", () => {
  it("logs a warning when ANTHROPIC_API_KEY is set", () => {
    const log = vi.fn();
    warnIfApiKeyPresent({ ANTHROPIC_API_KEY: "sk-ant-secret" }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("ANTHROPIC_API_KEY");
  });

  it("does not log when ANTHROPIC_API_KEY is absent", () => {
    const log = vi.fn();
    warnIfApiKeyPresent({}, log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("detectQuotaExhaustion", () => {
  const cases: Array<[string, string]> = [
    ["session limit", "You've hit your session limit. Try again later."],
    ["weekly limit", "You've hit your weekly limit for Claude Code."],
    ["rate_limit_error", '{"type":"error","error":{"type":"rate_limit_error"}}'],
    ["bare 429", "Request failed with status code 429"],
    ["usage limit reached", "Usage limit reached for this session."],
  ];

  it.each(cases)("detects exhaustion from %s", (_label, stderr) => {
    expect(detectQuotaExhaustion({ stderr, exitCode: 1 })).toBe(true);
  });

  it("returns false for ordinary error output", () => {
    expect(
      detectQuotaExhaustion({ stderr: "Error: network timeout", exitCode: 1 }),
    ).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(detectQuotaExhaustion({ stderr: "", exitCode: 0 })).toBe(false);
  });

  it("also checks stdout, not just stderr", () => {
    expect(
      detectQuotaExhaustion({
        stderr: "",
        stdout: "You've hit your weekly limit.",
        exitCode: 1,
      }),
    ).toBe(true);
  });
});

describe("invokeClaude", () => {
  it("never forwards ANTHROPIC_API_KEY to the spawned child, even if set in process.env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-never-appear");
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({ prompt: "hello", model: "sonnet", tools: [] });

    fakeChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ result: "hi", is_error: false })),
    );
    fakeChild.emit("close", 0);
    await resultPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnOptions = vi.mocked(spawn).mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(spawnOptions.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("passes --tools and --allowedTools with the same explicit list, plus --permission-prompts none", async () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({
      prompt: "research this company",
      model: "sonnet",
      tools: ["WebSearch", "WebFetch"],
    });

    fakeChild.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", is_error: false })));
    fakeChild.emit("close", 0);
    await resultPromise;

    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "--tools",
        "WebSearch,WebFetch",
        "--allowedTools",
        "WebSearch,WebFetch",
        "--permission-prompts",
        "none",
      ]),
    );
  });

  it("resolves with status success and parsed fields on valid JSON + exit 0", async () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({ prompt: "hi", model: "sonnet", tools: [] });
    fakeChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          result: "the answer",
          is_error: false,
          total_cost_usd: 0.0123,
          duration_ms: 4200,
        }),
      ),
    );
    fakeChild.emit("close", 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: "success",
      resultText: "the answer",
      costUsd: 0.0123,
      durationMs: 4200,
    });
  });

  it("resolves with status invalid_json when stdout is not parseable JSON", async () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({ prompt: "hi", model: "sonnet", tools: [] });
    fakeChild.stdout.emit("data", Buffer.from("not json at all"));
    fakeChild.emit("close", 0);

    const result = await resultPromise;
    expect(result.status).toBe("invalid_json");
  });

  it("resolves with status quota_exhausted when stderr matches a known usage-limit phrase", async () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({ prompt: "hi", model: "sonnet", tools: [] });
    fakeChild.stderr.emit("data", Buffer.from("You've hit your weekly limit."));
    fakeChild.emit("close", 1);

    const result = await resultPromise;
    expect(result.status).toBe("quota_exhausted");
  });

  it("resolves with status error on a non-zero exit that isn't quota-related", async () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({ prompt: "hi", model: "sonnet", tools: [] });
    fakeChild.stderr.emit("data", Buffer.from("Error: something else broke"));
    fakeChild.emit("close", 1);

    const result = await resultPromise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.exitCode).toBe(1);
    }
  });

  it("resolves with status error when the CLI reports is_error true in valid JSON", async () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({ prompt: "hi", model: "sonnet", tools: [] });
    fakeChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ result: "something went wrong", is_error: true })),
    );
    fakeChild.emit("close", 0);

    const result = await resultPromise;
    expect(result.status).toBe("error");
  });

  it("resolves with status error if the CLI binary fails to spawn", async () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = invokeClaude({ prompt: "hi", model: "sonnet", tools: [] });
    fakeChild.emit("error", new Error("ENOENT"));

    const result = await resultPromise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("ENOENT");
    }
  });
});
