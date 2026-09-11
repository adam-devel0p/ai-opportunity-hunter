/**
 * The ADR-0004 `PostToolUse` hook subprocess itself (Phase 5): registered on `WebFetch` only
 * via `buildSourceCaptureHookSettings` (src/agents/sourceCaptureHook.ts), spawned directly by
 * the `claude` CLI (not by this app's own Node process) once per `WebFetch` tool call the Deep
 * Research Agent makes. Reads the hook payload from stdin, and if it's a `WebFetch` event with
 * a usable URL, inserts a `sources` row — deterministically, independent of whatever the
 * agent's own structured output later claims it fetched.
 *
 * `PostToolUse` cannot block or alter the already-completed tool call (confirmed against the
 * Claude Code hooks reference), so this script only ever has a side effect (the DB write) and
 * never emits anything Claude would see — any failure here is swallowed (logged to stderr) and
 * the process always exits 0, since a hook problem must never surface as a confusing tool-call
 * failure to the agent it's silently observing.
 */

import type { Db } from "../../src/db/client.js";
import { createDb } from "../../src/db/client.js";
import { sources } from "../../src/db/schema.js";
import {
  SOURCE_CAPTURE_HOOK_ENV,
  extractWebFetchEvent,
} from "../../src/agents/sourceCaptureHook.js";
import { computeSourceFreshnessState } from "../../src/lib/sourceFreshness.js";

export interface RunCaptureSourceHookInput {
  rawPayload: string;
  env: NodeJS.ProcessEnv;
  db: Db;
  now?: Date;
}

/**
 * The testable core: given the hook's stdin payload, its env vars, and a `Db` handle, decides
 * whether a `sources` row should be written and writes it. Split out from `main()` so tests can
 * inject a temp DB and a literal payload string instead of going through real stdin/env/process
 * plumbing (same DI convention as `src/pipeline/*Handler.ts`).
 */
export function runCaptureSourceHook(input: RunCaptureSourceHookInput): void {
  const companyId = input.env[SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID];
  const taskId = input.env[SOURCE_CAPTURE_HOOK_ENV.TASK_ID];
  if (!companyId || !taskId) {
    return;
  }

  const event = extractWebFetchEvent(input.rawPayload);
  if (!event) {
    return;
  }

  const now = input.now ?? new Date();
  input.db
    .insert(sources)
    .values({
      companyId,
      url: event.url,
      retrievedAt: now,
      fetchedByTaskId: taskId,
      freshnessState: computeSourceFreshnessState({
        httpStatus: event.httpStatus,
        retrievedAt: now,
        now,
      }),
    })
    .run();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const dbPath = process.env[SOURCE_CAPTURE_HOOK_ENV.DB_PATH];
  if (!dbPath) {
    // Not invoked with the context this hook needs (e.g. run manually, or misconfigured) —
    // silently no-op rather than erroring into the agent's tool-call stream.
    return;
  }
  const rawPayload = await readStdin();
  const db = createDb(dbPath);
  runCaptureSourceHook({ rawPayload, env: process.env, db });
}

// Only run main() when executed directly (by the claude CLI as a hook subprocess), not when
// imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("captureSourceHook failed:", err);
  });
}
