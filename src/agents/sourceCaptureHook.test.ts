import { describe, expect, it } from "vitest";
import {
  SOURCE_CAPTURE_HOOK_ENV,
  buildSourceCaptureHookEnv,
  buildSourceCaptureHookSettings,
  extractWebFetchEvent,
} from "./sourceCaptureHook.js";

describe("buildSourceCaptureHookEnv", () => {
  it("maps context fields to the shared env var names", () => {
    const env = buildSourceCaptureHookEnv({
      dbPath: "/tmp/aoh-test.db",
      companyId: "company-1",
      taskId: "wi-1",
    });
    expect(env[SOURCE_CAPTURE_HOOK_ENV.DB_PATH]).toBe("/tmp/aoh-test.db");
    expect(env[SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]).toBe("company-1");
    expect(env[SOURCE_CAPTURE_HOOK_ENV.TASK_ID]).toBe("wi-1");
  });
});

describe("buildSourceCaptureHookSettings", () => {
  it("registers a PostToolUse hook matching only WebFetch, in exec form (command + args)", () => {
    const settings = buildSourceCaptureHookSettings() as {
      hooks: {
        PostToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string; args: string[] }>;
        }>;
      };
    };
    const postToolUse = settings.hooks.PostToolUse;
    expect(postToolUse).toHaveLength(1);
    expect(postToolUse[0]?.matcher).toBe("WebFetch");
    expect(postToolUse[0]?.hooks).toHaveLength(1);
    const hook = postToolUse[0]?.hooks[0];
    expect(hook?.type).toBe("command");
    expect(hook?.command).toMatch(/node_modules[/\\]\.bin[/\\]tsx$/);
    expect(hook?.args).toHaveLength(1);
    expect(hook?.args[0]).toMatch(/captureSourceHook\.ts$/);
  });
});

describe("extractWebFetchEvent", () => {
  it("extracts url and http status from a well-formed WebFetch PostToolUse payload", () => {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://acme.example/about", prompt: "extract team size" },
      tool_response: {
        url: "https://acme.example/about",
        code: 200,
        codeText: "OK",
        result: "some extracted text",
        bytes: 1234,
        durationMs: 500,
      },
    });
    expect(extractWebFetchEvent(payload)).toEqual({
      url: "https://acme.example/about",
      httpStatus: 200,
    });
  });

  it("prefers tool_response.url over tool_input.url (redirect case)", () => {
    const payload = JSON.stringify({
      tool_name: "WebFetch",
      tool_input: { url: "https://acme.example/old-page" },
      tool_response: { url: "https://acme.example/new-page", code: 200 },
    });
    expect(extractWebFetchEvent(payload)?.url).toBe("https://acme.example/new-page");
  });

  it("falls back to tool_input.url when tool_response has none", () => {
    const payload = JSON.stringify({
      tool_name: "WebFetch",
      tool_input: { url: "https://acme.example/about" },
      tool_response: { code: 500 },
    });
    expect(extractWebFetchEvent(payload)).toEqual({
      url: "https://acme.example/about",
      httpStatus: 500,
    });
  });

  it("returns null for a non-WebFetch tool (e.g. WebSearch)", () => {
    const payload = JSON.stringify({
      tool_name: "WebSearch",
      tool_input: { query: "acme ltd reviews" },
      tool_response: { query: "acme ltd reviews", results: [] },
    });
    expect(extractWebFetchEvent(payload)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractWebFetchEvent("not json")).toBeNull();
  });

  it("returns null when no url can be found anywhere", () => {
    const payload = JSON.stringify({ tool_name: "WebFetch", tool_input: {}, tool_response: {} });
    expect(extractWebFetchEvent(payload)).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(extractWebFetchEvent("42")).toBeNull();
    expect(extractWebFetchEvent("null")).toBeNull();
  });
});
