import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runStructuredAgent } from "./runStructuredAgent.js";
import { invokeClaude } from "./claudeClient.js";

vi.mock("./claudeClient.js", () => ({
  invokeClaude: vi.fn(),
}));

const schema = z.object({ ok: z.boolean() });

function baseOptions(buildPrompt: (retry?: { previousError: string }) => string) {
  return {
    model: "sonnet",
    tools: [] as string[],
    schema,
    buildPrompt,
  };
}

describe("runStructuredAgent", () => {
  it("returns success on the first attempt when output validates", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ ok: true }),
      raw: {},
      costUsd: 0.01,
      durationMs: 100,
    });

    const buildPrompt = vi.fn(() => "prompt");
    const result = await runStructuredAgent(baseOptions(buildPrompt));

    expect(result).toEqual({
      status: "success",
      data: { ok: true },
      attempts: 1,
      costUsd: 0.01,
      durationMs: 100,
    });
    expect(buildPrompt).toHaveBeenCalledTimes(1);
    expect(buildPrompt).toHaveBeenCalledWith(undefined);
  });

  it("retries once with the validation error appended when schema validation fails, then succeeds", async () => {
    vi.mocked(invokeClaude)
      .mockResolvedValueOnce({
        status: "success",
        resultText: JSON.stringify({ ok: "not a boolean" }),
        raw: {},
        costUsd: null,
        durationMs: null,
      })
      .mockResolvedValueOnce({
        status: "success",
        resultText: JSON.stringify({ ok: true }),
        raw: {},
        costUsd: null,
        durationMs: null,
      });

    const buildPrompt = vi.fn((_retry?: { previousError: string }) => "prompt");
    const result = await runStructuredAgent(baseOptions(buildPrompt));

    expect(result.status).toBe("success");
    expect(result.attempts).toBe(2);
    expect(buildPrompt).toHaveBeenCalledTimes(2);
    expect(buildPrompt).toHaveBeenNthCalledWith(1, undefined);
    const secondCallArg = buildPrompt.mock.calls[1]?.[0];
    expect(secondCallArg?.previousError).toBeDefined();
  });

  it("returns invalid_output after exhausting retries on repeated schema-validation failure", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: JSON.stringify({ ok: "nope" }),
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    const result = await runStructuredAgent(baseOptions(() => "prompt"));
    expect(result.status).toBe("invalid_output");
    expect(result.attempts).toBe(2);
  });

  it("returns invalid_output after exhausting retries on unparseable JSON", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "success",
      resultText: "not json",
      raw: {},
      costUsd: null,
      durationMs: null,
    });

    const result = await runStructuredAgent(baseOptions(() => "prompt"));
    expect(result.status).toBe("invalid_output");
    expect(result.attempts).toBe(2);
  });

  it("returns quota_exhausted immediately, with no retry", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "quota_exhausted",
      message: "You've hit your weekly limit.",
    });

    const buildPrompt = vi.fn(() => "prompt");
    const result = await runStructuredAgent(baseOptions(buildPrompt));

    expect(result).toEqual({
      status: "quota_exhausted",
      message: "You've hit your weekly limit.",
      attempts: 1,
    });
    expect(buildPrompt).toHaveBeenCalledTimes(1);
  });

  it("returns error immediately, with no retry", async () => {
    vi.mocked(invokeClaude).mockResolvedValue({
      status: "error",
      message: "claude CLI exited with code 1",
      stderr: "",
      exitCode: 1,
    });

    const buildPrompt = vi.fn(() => "prompt");
    const result = await runStructuredAgent(baseOptions(buildPrompt));

    expect(result.status).toBe("error");
    expect(buildPrompt).toHaveBeenCalledTimes(1);
  });
});
