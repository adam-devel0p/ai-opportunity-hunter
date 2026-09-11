/**
 * The autonomous scheduler/worker loop (spec §50-51, PLAN.md Phase 11) — the long-running
 * process that ties every prior phase's handler together into continuous, quota-aware
 * operation. Conceptually, per spec §50, each cycle:
 *
 *   check autonomous mode -> ensure discovery work exists -> pick the highest-priority eligible
 *   work item -> run its handler -> persist -> repeat
 *
 * with quota exhaustion pausing new Claude calls (never a tight retry loop, never automatic
 * API-key fallback — ADR-0001/spec §51/§78) and `system_config`-driven pause/resume (spec §71)
 * re-checked every single cycle so a toggle takes effect within one cycle, not on the next
 * process restart.
 *
 * This module is split into three layers, each independently testable:
 *   - `recoverStuckWorkItems` / `ensureDiscoveryWork`: one-shot / per-cycle DB-wiring helpers.
 *   - `runWorkerCycle`: does exactly one unit of work (or decides there's nothing to do) and
 *     returns a discriminated result — no sleeping, no looping, so it's trivial to call directly
 *     in a test without managing an actual infinite loop.
 *   - `runWorker`: the actual `while` loop, deciding how long to sleep between cycles based on
 *     what the last cycle returned (idle poll interval, quota backoff, or immediately again).
 */

import { eq } from "drizzle-orm";
import { createDb, type Db } from "./db/client.js";
import { companies, discoveryCampaigns, workItems } from "./db/schema.js";
import {
  getAutonomousMode,
  getCampaignSelectionState,
  getOpportunityGateConfig,
  getReResearchWindowMs,
  setCampaignSelectionState,
} from "./lib/config.js";
import { warnIfApiKeyPresent } from "./agents/claudeClient.js";
import { runDiscoverTask } from "./pipeline/discoverHandler.js";
import { runPrescreenTask } from "./pipeline/prescreenHandler.js";
import { runResearchTask } from "./pipeline/researchHandler.js";
import { runAnalyzeTask } from "./pipeline/analyzeHandler.js";
import { runVerifyTask } from "./pipeline/verifyHandler.js";
import { runBuildOfferTask } from "./pipeline/offerHandler.js";
import { runFindContactTask } from "./pipeline/contactHandler.js";
import { runWriteOutreachTask } from "./pipeline/outreachHandler.js";
import { runRefreshEvidenceTask } from "./pipeline/refreshEvidenceHandler.js";
import { selectNextCampaign } from "./pipeline/campaignSelection.js";
import { resolveFailureOutcome } from "./pipeline/failureClassification.js";
import { selectNextWorkItem, TASK_TYPE_PRIORITY, type TaskType } from "./pipeline/priority.js";
import {
  planStuckWorkItemRecovery,
  DEFAULT_STUCK_RUNNING_TIMEOUT_MS,
} from "./pipeline/crashRecovery.js";
export { DEFAULT_STUCK_RUNNING_TIMEOUT_MS } from "./pipeline/crashRecovery.js";
import { transitionWorkItemStatus, type WorkItemStatus } from "./pipeline/stateMachine.js";

// --- tunables --------------------------------------------------------------

/** How long to sleep when there's nothing eligible to run, or autonomous mode is paused. */
export const DEFAULT_IDLE_POLL_INTERVAL_MS = 60_000;

/**
 * Quota-exhaustion backoff (spec §51: "start at e.g. 30 min, capped"). Doubles on each
 * *consecutive* quota-exhausted cycle (reset by any cycle that isn't quota-exhausted), so a
 * still-exhausted quota backs off further instead of re-hammering the CLI every 30 minutes
 * forever, while a single blip only costs one 30-minute pause.
 */
export const DEFAULT_QUOTA_BACKOFF_BASE_MS = 30 * 60_000;
export const DEFAULT_QUOTA_BACKOFF_MAX_MS = 4 * 60 * 60_000;

// --- work-item context shared by every handler ------------------------------

/**
 * Every Phase 3-10 handler's `WorkItemContext` type (`DiscoverWorkItemContext`,
 * `PrescreenWorkItemContext`, ...) has this exact same shape — only the doc-comment on
 * `entityId` differs per task type (campaign id for DISCOVER, company id for
 * PRESCREEN/RESEARCH/ANALYZE, opportunity id from VERIFY onward). Defined once here rather than
 * importing all eight structurally-identical types.
 */
export interface WorkerWorkItemContext {
  id: string;
  status: "RUNNING";
  entityId: string;
  attempts: number;
}

export interface HandlerOutcome {
  workItemStatus: WorkItemStatus;
  error?: string;
}

/**
 * `dbPath` is only used by RESEARCH's handler (the ADR-0004 hook subprocess needs the DB file
 * path to open its own connection — see `researchHandler.ts`'s `RunResearchTaskOptions`). Every
 * other handler ignores its fourth parameter; TypeScript permits a function with fewer declared
 * parameters to satisfy a wider function type, so `TASK_HANDLERS`'s other entries below don't
 * need to mention it.
 */
export type TaskHandler = (
  db: Db,
  workItem: WorkerWorkItemContext,
  now: Date,
  dbPath: string,
) => Promise<HandlerOutcome>;

export const TASK_HANDLERS: Record<TaskType, TaskHandler> = {
  DISCOVER: (db, workItem, now) => runDiscoverTask({ db, workItem, now }),
  PRESCREEN: (db, workItem, now) => runPrescreenTask({ db, workItem, now }),
  RESEARCH: (db, workItem, now, dbPath) =>
    runResearchTask({ db, workItem, now, dbPath, reResearchWindowMs: getReResearchWindowMs(db) }),
  ANALYZE: (db, workItem, now) => runAnalyzeTask({ db, workItem, now }),
  VERIFY: (db, workItem, now) =>
    runVerifyTask({ db, workItem, now, gateConfig: getOpportunityGateConfig(db) }),
  BUILD_OFFER: (db, workItem, now) => runBuildOfferTask({ db, workItem, now }),
  FIND_CONTACT: (db, workItem, now) => runFindContactTask({ db, workItem, now }),
  WRITE_OUTREACH: (db, workItem, now) => runWriteOutreachTask({ db, workItem, now }),
  REFRESH_EVIDENCE: (db, workItem, now, dbPath) =>
    runRefreshEvidenceTask({
      db,
      workItem,
      now,
      dbPath,
      reResearchWindowMs: getReResearchWindowMs(db),
    }),
};

// --- startup: crash recovery (spec §67) -------------------------------------

/**
 * Runs once, at worker startup, against the live `work_items` table: any `RUNNING` item whose
 * `startedAt` is older than the timeout is assumed abandoned by a dead process and reset to
 * `RETRYABLE` so the normal queue picks it back up. Pure primitives already existed since Phase
 * 2 (`src/pipeline/crashRecovery.ts`) — this is the first phase that actually wires them to a
 * live DB.
 */
export function recoverStuckWorkItems(
  db: Db,
  now: Date = new Date(),
  timeoutMs: number = DEFAULT_STUCK_RUNNING_TIMEOUT_MS,
): number {
  const runningItems = db
    .select({ id: workItems.id, status: workItems.status, startedAt: workItems.startedAt })
    .from(workItems)
    .where(eq(workItems.status, "RUNNING"))
    .all();

  const plan = planStuckWorkItemRecovery(runningItems, now, timeoutMs);
  for (const item of plan) {
    db.update(workItems)
      .set({ status: item.nextStatus, updatedAt: now })
      .where(eq(workItems.id, item.id))
      .run();
  }
  return plan.length;
}

// --- per-cycle: keep discovery work flowing ---------------------------------

const DISCOVER_IN_FLIGHT_STATUSES: readonly WorkItemStatus[] = [
  "PENDING",
  "RUNNING",
  "RETRYABLE",
  "DEFERRED",
];

/**
 * Discovery (spec §16) is the one task type nothing upstream ever enqueues automatically — every
 * other task type is created by the handler that finishes the stage before it. Without this, the
 * queue would run dry after the operator's initial manual `scripts/discover.ts` runs completed,
 * even though PLAN.md Phase 11's objective is "wiring everything ... into continuous operation."
 * Judgment call (documented in ADR-0018): at most one DISCOVER item is ever in flight at a time
 * (discovery is explicitly the lowest-priority task per spec §49 — piling up several would only
 * ever matter once the queue is otherwise completely empty anyway) — if one already exists in a
 * non-terminal status, this is a no-op. Otherwise, picks the next campaign via the Phase 3
 * smooth-weighted-round-robin (`selectNextCampaign`, spec §16) over `ENABLED` campaigns, with its
 * running-weight state persisted in `system_config` (ADR-0010 part 2's forward pointer) so
 * diversity holds across restarts, not just within one process's lifetime.
 */
export function ensureDiscoveryWork(db: Db, now: Date = new Date()): string | null {
  const existing = db
    .select({ id: workItems.id, status: workItems.status })
    .from(workItems)
    .where(eq(workItems.taskType, "DISCOVER"))
    .all()
    .filter((row) => DISCOVER_IN_FLIGHT_STATUSES.includes(row.status));
  if (existing.length > 0) {
    return null;
  }

  const campaigns = db.select().from(discoveryCampaigns).all();
  const state = getCampaignSelectionState(db);
  const picked = selectNextCampaign(campaigns, state);
  if (!picked) {
    return null;
  }

  setCampaignSelectionState(db, picked.state, now);

  const [item] = db
    .insert(workItems)
    .values({
      taskType: "DISCOVER",
      entityId: picked.campaign.id,
      status: "PENDING",
      priority: TASK_TYPE_PRIORITY.DISCOVER,
    })
    .returning()
    .all();
  return item?.id ?? null;
}

// --- per-cycle: keep re-research (evidence refresh) work flowing -------------

const REFRESH_EVIDENCE_IN_FLIGHT_STATUSES: readonly WorkItemStatus[] = [
  "PENDING",
  "RUNNING",
  "RETRYABLE",
  "DEFERRED",
];

const REFRESHABLE_LIFECYCLE_STATUSES = ["RESEARCHED", "NO_OPPORTUNITY"] as const;

/** Caps how many `REFRESH_EVIDENCE` items this enqueues per cycle — unlike DISCOVER (at most one
 * ever in flight), several companies can legitimately become re-research-eligible around the same
 * time, but enqueueing all of them at once the moment a freshness window rolls over would spend a
 * burst of Claude quota that spec §49's priority ordering already ranks below every in-flight
 * opportunity's own progression. A small per-cycle batch spreads that out instead. */
export const DEFAULT_REFRESH_EVIDENCE_BATCH_SIZE = 3;

/**
 * Spec §60 re-research: unlike every other task type, nothing enqueues `REFRESH_EVIDENCE`
 * automatically as a side effect of finishing an earlier stage (there is no earlier stage — a
 * company only becomes eligible once its own `nextEligibleResearchAt` window, set by the last
 * `RESEARCH`/`REFRESH_EVIDENCE` run, has passed). Same "the worker itself tops this up every
 * cycle" pattern as `ensureDiscoveryWork` above (ADR-0018), scanning `RESEARCHED`/
 * `NO_OPPORTUNITY` companies whose window has passed and that don't already have a
 * `REFRESH_EVIDENCE` item in flight.
 */
export function ensureRefreshEvidenceWork(
  db: Db,
  now: Date = new Date(),
  batchSize: number = DEFAULT_REFRESH_EVIDENCE_BATCH_SIZE,
): string[] {
  const inFlightCompanyIds = new Set(
    db
      .select({ entityId: workItems.entityId, status: workItems.status })
      .from(workItems)
      .where(eq(workItems.taskType, "REFRESH_EVIDENCE"))
      .all()
      .filter((row) => REFRESH_EVIDENCE_IN_FLIGHT_STATUSES.includes(row.status))
      .map((row) => row.entityId),
  );

  const eligibleCompanies = db
    .select()
    .from(companies)
    .all()
    .filter(
      (company) =>
        REFRESHABLE_LIFECYCLE_STATUSES.includes(
          company.lifecycleStatus as (typeof REFRESHABLE_LIFECYCLE_STATUSES)[number],
        ) &&
        company.nextEligibleResearchAt !== null &&
        company.nextEligibleResearchAt.getTime() <= now.getTime() &&
        !inFlightCompanyIds.has(company.id),
    )
    .slice(0, batchSize);

  const createdIds: string[] = [];
  for (const company of eligibleCompanies) {
    const [item] = db
      .insert(workItems)
      .values({
        taskType: "REFRESH_EVIDENCE",
        entityId: company.id,
        status: "PENDING",
        priority: TASK_TYPE_PRIORITY.REFRESH_EVIDENCE,
      })
      .returning()
      .all();
    if (item) createdIds.push(item.id);
  }
  return createdIds;
}

// --- one cycle ---------------------------------------------------------------

export type WorkerCycleResult =
  | { kind: "paused" }
  | { kind: "idle" }
  | {
      kind: "ran";
      taskType: TaskType;
      workItemId: string;
      workItemStatus: WorkItemStatus;
      /**
       * True exactly when the handler parked the item `DEFERRED` — by convention (every
       * handler from Phase 3 onward, see docs/DECISIONS.md ADR-0010 part 5 and its reuse in
       * every later phase's ADR), `DEFERRED` is used for one thing only: a `quota_exhausted`
       * result from `claudeClient`. Reusing that existing signal here means the worker doesn't
       * need every handler to also return a separate `quotaExhausted` flag.
       */
      quotaExhausted: boolean;
      error?: string;
    };

export interface RunWorkerCycleOptions {
  db: Db;
  now?: Date;
  /** Passed through to RESEARCH's handler for the ADR-0004 hook subprocess. Defaults to
   * `AOH_DB_PATH`/`./data/aoh.db`, same convention as every `scripts/*.ts` entry point. */
  dbPath?: string;
  /** Override specific handlers — tests inject fakes here instead of hitting the real `claude` CLI. */
  handlers?: Partial<Record<TaskType, TaskHandler>>;
}

/**
 * Runs exactly one unit of work: checks pause/resume, tops up discovery work, selects the single
 * highest-priority eligible item (spec §49, `selectNextWorkItem`), and runs it. Never sleeps and
 * never loops — `runWorker` below owns pacing. The handler call is wrapped in try/catch so a
 * thrown error (e.g. a handler's own referential-integrity guard, like `discoverHandler.ts`
 * throwing on an unknown campaign id) is routed through the same `resolveFailureOutcome`
 * classification as a handler-reported failure, rather than crashing the whole process — this is
 * the literal implementation of spec §66/PLAN.md §8's "each task handler is wrapped so one
 * failure never takes down the loop," which no prior phase had a real loop to apply.
 */
export async function runWorkerCycle(
  options: RunWorkerCycleOptions,
): Promise<WorkerCycleResult> {
  const { db } = options;
  const now = options.now ?? new Date();
  const dbPath = options.dbPath ?? process.env.AOH_DB_PATH ?? "./data/aoh.db";

  if (!getAutonomousMode(db)) {
    return { kind: "paused" };
  }

  ensureDiscoveryWork(db, now);
  ensureRefreshEvidenceWork(db, now);

  const allItems = db.select().from(workItems).all();
  const next = selectNextWorkItem(allItems, now);
  if (!next) {
    return { kind: "idle" };
  }

  const runningStatus = transitionWorkItemStatus(next.status, "RUNNING");
  db.update(workItems)
    .set({ status: runningStatus, startedAt: now, updatedAt: now })
    .where(eq(workItems.id, next.id))
    .run();

  const workItemContext: WorkerWorkItemContext = {
    id: next.id,
    status: "RUNNING",
    entityId: next.entityId,
    attempts: next.attempts,
  };

  const handler = options.handlers?.[next.taskType] ?? TASK_HANDLERS[next.taskType];

  let outcome: HandlerOutcome;
  try {
    outcome = await handler(db, workItemContext, now, dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureOutcome = resolveFailureOutcome(
      { errorMessage: message, attempts: next.attempts + 1 },
      now,
    );
    db.update(workItems)
      .set({
        status: failureOutcome.status,
        attempts: next.attempts + 1,
        lastError: message,
        runAfter: failureOutcome.runAfter,
        updatedAt: now,
      })
      .where(eq(workItems.id, next.id))
      .run();
    outcome = { workItemStatus: failureOutcome.status, error: message };
  }

  return {
    kind: "ran",
    taskType: next.taskType,
    workItemId: next.id,
    workItemStatus: outcome.workItemStatus,
    quotaExhausted: outcome.workItemStatus === "DEFERRED",
    error: outcome.error,
  };
}

// --- the loop ----------------------------------------------------------------

export interface RunWorkerOptions {
  db: Db;
  dbPath?: string;
  /** Aborts the loop between cycles (never mid-handler — the current task always finishes). */
  signal?: AbortSignal;
  /** Bounds the loop for tests; real usage runs until `signal` aborts. */
  maxCycles?: number;
  /** Injectable for tests, so backoff/idle waits don't actually block the test runner. */
  sleep?: (ms: number) => Promise<void>;
  idlePollIntervalMs?: number;
  quotaBackoffBaseMs?: number;
  quotaBackoffMaxMs?: number;
  now?: () => Date;
  /** Called after every cycle — worker.ts's `main()` uses this to log; tests use it to observe. */
  onCycle?: (result: WorkerCycleResult) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The actual long-running loop (spec §50/§51/PLAN.md §12). Recovers crashed work once at
 * startup, then repeatedly runs one cycle and decides how long to wait before the next one:
 *   - quota-exhausted cycle: back off (doubling per consecutive exhaustion, capped), then retry —
 *     "stop issuing new calls ... sleep with backoff ... resume later," never a tight retry loop.
 *   - a cycle that actually ran a task successfully (or failed it non-quota-wise): no delay,
 *     immediately try the next highest-priority item.
 *   - idle (nothing eligible) or paused (autonomous mode off): sleep the idle poll interval, then
 *     re-check — this is also what makes a pause/resume toggle take effect within one cycle
 *     (spec §71), since `runWorkerCycle` re-reads `system_config` fresh every time.
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const { db } = options;
  const sleep = options.sleep ?? defaultSleep;
  const idleMs = options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
  const backoffBase = options.quotaBackoffBaseMs ?? DEFAULT_QUOTA_BACKOFF_BASE_MS;
  const backoffMax = options.quotaBackoffMaxMs ?? DEFAULT_QUOTA_BACKOFF_MAX_MS;

  recoverStuckWorkItems(db, options.now?.() ?? new Date());

  let consecutiveQuotaExhaustions = 0;
  let cycles = 0;

  while (!options.signal?.aborted) {
    if (options.maxCycles !== undefined && cycles >= options.maxCycles) {
      return;
    }
    cycles++;

    const result = await runWorkerCycle({ db, now: options.now?.(), dbPath: options.dbPath });
    options.onCycle?.(result);

    if (result.kind === "ran" && result.quotaExhausted) {
      consecutiveQuotaExhaustions++;
      const backoffMs = Math.min(
        backoffBase * 2 ** (consecutiveQuotaExhaustions - 1),
        backoffMax,
      );
      await sleep(backoffMs);
      continue;
    }

    consecutiveQuotaExhaustions = 0;

    if (result.kind === "ran") {
      continue;
    }

    // idle or paused
    await sleep(idleMs);
  }
}

// --- process entry point -----------------------------------------------------

function formatCycleLog(result: WorkerCycleResult): string {
  const timestamp = new Date().toISOString();
  if (result.kind === "paused") {
    return `[${timestamp}] paused (autonomous mode off)`;
  }
  if (result.kind === "idle") {
    return `[${timestamp}] idle (no eligible work)`;
  }
  const suffix = result.error ? ` — ${result.error}` : "";
  return `[${timestamp}] ${result.taskType} ${result.workItemId} -> ${result.workItemStatus}${suffix}`;
}

async function main() {
  warnIfApiKeyPresent();

  const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
  const db = createDb(dbPath);

  console.log(`AI Opportunity Hunter worker starting (db: ${dbPath}).`);
  console.log("Toggle autonomous mode with: npm run autonomous -- --enable | --disable | --status");

  const controller = new AbortController();
  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down after the current cycle...`);
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await runWorker({
    db,
    dbPath,
    signal: controller.signal,
    onCycle: (result) => console.log(formatCycleLog(result)),
  });

  console.log("Worker stopped.");
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("Unexpected worker error:", err);
    process.exitCode = 1;
  });
}
