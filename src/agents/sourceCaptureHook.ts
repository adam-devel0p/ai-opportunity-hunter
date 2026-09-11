/**
 * Shared logic for the ADR-0004 evidence-provenance hook: a `PostToolUse` hook on `WebFetch`
 * that deterministically writes a `sources` row for every page the Deep Research Agent (Phase
 * 5) actually fetches, independent of what the agent's own structured output claims. This
 * module is imported by both `runDeepResearchAgent` (to register the hook + pass it context via
 * env vars) and `scripts/hooks/captureSourceHook.ts` (the actual hook subprocess entry point),
 * so the env var names and payload-parsing logic can't drift between the two sides.
 *
 * Registered only on `WebFetch`, not `WebSearch`: `WebSearch` returns result titles/URLs but
 * never fetches page content (confirmed against the Claude Code hooks/tools reference during
 * implementation), so there is no "page actually looked at" to record for it — recording a
 * search result URL as a `Source` would misrepresent it as fetched content when it wasn't.
 *
 * Why a separate OS process instead of an in-process callback: `claude -p` hooks are configured
 * via `--settings` and run as independent subprocesses spawned by the CLI itself, not callbacks
 * into this Node process — there is no way to hand them an in-memory `Db` handle, only env vars
 * and stdin. The hook process opens its own short-lived connection to the same SQLite file
 * (path passed via `AOH_DB_PATH`) to insert a row, then exits.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

/** Env var names the hook subprocess reads for context it can't get any other way. */
export const SOURCE_CAPTURE_HOOK_ENV = {
  DB_PATH: "AOH_DB_PATH",
  COMPANY_ID: "AOH_RESEARCH_COMPANY_ID",
  TASK_ID: "AOH_RESEARCH_TASK_ID",
} as const;

export interface SourceCaptureHookContext {
  dbPath: string;
  companyId: string;
  taskId: string;
}

/** Builds the extra env vars `invokeClaude` should merge in so the hook subprocess (a separate
 * OS process with no access to this Node process's memory) knows which DB file, company, and
 * work item its writes belong to. */
export function buildSourceCaptureHookEnv(
  context: SourceCaptureHookContext,
): NodeJS.ProcessEnv {
  return {
    [SOURCE_CAPTURE_HOOK_ENV.DB_PATH]: context.dbPath,
    [SOURCE_CAPTURE_HOOK_ENV.COMPANY_ID]: context.companyId,
    [SOURCE_CAPTURE_HOOK_ENV.TASK_ID]: context.taskId,
  };
}

function repoRoot(): string {
  // src/agents/sourceCaptureHook.ts -> repo root is two levels up, same pattern as
  // src/db/migrate.ts's migrationsFolder resolution.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
}

/**
 * Builds the `--settings` payload registering the hook, using the "exec form" (`command` +
 * `args`, no shell) so absolute paths never need shell-quoting. `tsx` is invoked directly
 * (rather than requiring a build step) to match every other script in this repo
 * (`scripts/*.ts` run via `tsx`, never a `dist/` build) — this hook script is not imported by
 * production code, only spawned by the `claude` CLI, so it doesn't need to be part of the
 * `tsc` build graph.
 */
export function buildSourceCaptureHookSettings(): Record<string, unknown> {
  const root = repoRoot();
  const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
  const hookScript = path.join(root, "scripts", "hooks", "captureSourceHook.ts");

  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "WebFetch",
          hooks: [{ type: "command", command: tsxBin, args: [hookScript], timeout: 15 }],
        },
      ],
    },
  };
}

export interface ExtractedWebFetchEvent {
  url: string;
  httpStatus: number | null;
}

/**
 * Parses a `PostToolUse` hook payload (JSON on stdin, per the Claude Code hooks reference) and
 * returns the fetched URL + HTTP status if this event is a `WebFetch` call with a usable URL,
 * or `null` for anything else (wrong tool, malformed payload, missing URL) — the hook script
 * should silently no-op in every `null` case rather than erroring.
 *
 * Prefers `tool_response.url` over `tool_input.url`: WebFetch documents that a cross-host
 * redirect is reported back rather than followed, with the agent then issuing a *second*
 * WebFetch call for the real target — `tool_response.url` is what was actually retrieved for
 * *this* event, `tool_input.url` is only what was requested.
 */
export function extractWebFetchEvent(rawPayload: string): ExtractedWebFetchEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.tool_name !== "WebFetch") {
    return null;
  }

  const toolInput = record.tool_input as Record<string, unknown> | undefined;
  const toolResponse = record.tool_response as Record<string, unknown> | undefined;

  const url = toolResponse?.url ?? toolInput?.url;
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }

  const httpStatus = typeof toolResponse?.code === "number" ? toolResponse.code : null;
  return { url, httpStatus };
}
