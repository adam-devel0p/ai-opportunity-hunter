import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import type { Db } from "../../src/db/client.js";
import { companies, sources, workItems } from "../../src/db/schema.js";
import { SOURCE_CAPTURE_HOOK_ENV } from "../../src/agents/sourceCaptureHook.js";
import { TASK_TYPE_PRIORITY } from "../../src/pipeline/priority.js";
import { runCaptureSourceHook } from "./captureSourceHook.js";

let dir: string;
let db: Db;
let companyId: string;
let taskId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoh-capture-hook-test-"));
  db = runMigrations(path.join(dir, "test.db"));

  const [company] = db
    .insert(companies)
    .values({
      name: "Acme Ltd",
      normalizedDomain: "acme.example",
      website: "https://acme.example",
      lifecycleStatus: "RESEARCH_PENDING",
    })
    .returning()
    .all();
  companyId = company!.id;

  const [workItem] = db
    .insert(workItems)
    .values({
      taskType: "RESEARCH",
      entityId: companyId,
      status: "RUNNING",
      priority: TASK_TYPE_PRIORITY.RESEARCH,
    })
    .returning()
    .all();
  taskId = workItem!.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function webFetchPayload(url: string, code: number, responseUrl = url): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "WebFetch",
    tool_input: { url, prompt: "extract team size" },
    tool_response: { url: responseUrl, code, codeText: "OK", result: "...", bytes: 100 },
  });
}

describe("runCaptureSourceHook", () => {
  it("inserts a sources row for a successful WebFetch event", () => {
    runCaptureSourceHook({
      rawPayload: webFetchPayload("https://acme.example/about", 200),
      env: {
        [SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]: companyId,
        [SOURCE_CAPTURE_HOOK_ENV.TASK_ID]: taskId,
      },
      db,
    });

    const rows = db.select().from(sources).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(companyId);
    expect(rows[0]?.fetchedByTaskId).toBe(taskId);
    expect(rows[0]?.url).toBe("https://acme.example/about");
    expect(rows[0]?.freshnessState).toBe("FRESH");
    expect(rows[0]?.retrievedAt).toBeInstanceOf(Date);
  });

  it("records UNAVAILABLE freshness for a failed fetch (non-2xx status)", () => {
    runCaptureSourceHook({
      rawPayload: webFetchPayload("https://acme.example/dead-page", 404),
      env: {
        [SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]: companyId,
        [SOURCE_CAPTURE_HOOK_ENV.TASK_ID]: taskId,
      },
      db,
    });

    const row = db.select().from(sources).where(eq(sources.url, "https://acme.example/dead-page")).get();
    expect(row?.freshnessState).toBe("UNAVAILABLE");
  });

  it("does nothing for a non-WebFetch tool event", () => {
    runCaptureSourceHook({
      rawPayload: JSON.stringify({ tool_name: "WebSearch", tool_input: {}, tool_response: {} }),
      env: {
        [SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]: companyId,
        [SOURCE_CAPTURE_HOOK_ENV.TASK_ID]: taskId,
      },
      db,
    });
    expect(db.select().from(sources).all()).toHaveLength(0);
  });

  it("does nothing when the required env vars are missing (e.g. hook invoked outside a research call)", () => {
    runCaptureSourceHook({
      rawPayload: webFetchPayload("https://acme.example/about", 200),
      env: {},
      db,
    });
    expect(db.select().from(sources).all()).toHaveLength(0);
  });

  it("does nothing for malformed stdin payloads", () => {
    runCaptureSourceHook({
      rawPayload: "not json",
      env: {
        [SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]: companyId,
        [SOURCE_CAPTURE_HOOK_ENV.TASK_ID]: taskId,
      },
      db,
    });
    expect(db.select().from(sources).all()).toHaveLength(0);
  });

  it("records each WebFetch call as its own row, including a redirect producing two events for two URLs", () => {
    runCaptureSourceHook({
      rawPayload: webFetchPayload("https://acme.example/old", 200, "https://acme.example/old"),
      env: {
        [SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]: companyId,
        [SOURCE_CAPTURE_HOOK_ENV.TASK_ID]: taskId,
      },
      db,
    });
    runCaptureSourceHook({
      rawPayload: webFetchPayload("https://acme.example/old", 200, "https://acme.example/new"),
      env: {
        [SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]: companyId,
        [SOURCE_CAPTURE_HOOK_ENV.TASK_ID]: taskId,
      },
      db,
    });

    const rows = db.select().from(sources).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.url).sort()).toEqual([
      "https://acme.example/new",
      "https://acme.example/old",
    ]);
  });
});
