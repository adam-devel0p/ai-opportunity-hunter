/**
 * Shared provenance-verified evidence persistence (ADR-0004/ADR-0012), factored out of
 * `researchHandler.ts` so `refreshEvidenceHandler.ts` (Phase 14, spec §60 re-research) can reuse
 * the exact same "only persist an evidence item whose sourceUrl matches a `sources` row the hook
 * actually recorded for this task" rule without duplicating it.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { evidenceItems, sources } from "../db/schema.js";
import type { DeepResearchOutput } from "../agents/deepResearchAgent.js";

/** Tolerates a single trailing slash difference between the model's cited `sourceUrl` and the
 * hook-recorded `sources.url` — both are otherwise required to match exactly. Anything more
 * exotic (protocol/casing differences) is treated as a genuine mismatch and dropped, since
 * silently normalizing further would start eroding the point of the check. */
export function urlsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (u: string) => u.replace(/\/$/, "");
  return strip(a) === strip(b);
}

export interface PersistVerifiedEvidenceResult {
  insertedEvidenceCount: number;
  droppedUnverifiedEvidenceCount: number;
}

/**
 * The hook (ADR-0004) already recorded every real WebFetch call this task made as a `sources`
 * row. Only an evidence item whose `sourceUrl` matches one of those is trusted — this is the
 * actual enforcement point for "the model's own claim of what it fetched is never the sole
 * record of provenance."
 */
export function persistVerifiedEvidence(
  db: Db,
  companyId: string,
  workItemId: string,
  evidence: DeepResearchOutput["evidence"],
): PersistVerifiedEvidenceResult {
  let insertedEvidenceCount = 0;
  let droppedUnverifiedEvidenceCount = 0;

  const candidates = db
    .select()
    .from(sources)
    .where(eq(sources.fetchedByTaskId, workItemId))
    .all();

  for (const item of evidence) {
    const matchedSource = candidates.find((source) => urlsMatch(source.url, item.sourceUrl));

    if (!matchedSource) {
      droppedUnverifiedEvidenceCount++;
      continue;
    }

    db.insert(evidenceItems)
      .values({
        companyId,
        sourceId: matchedSource.id,
        claim: item.claim,
        classification: item.classification,
        supportingExcerpt: item.supportingExcerpt,
        confidence: item.confidence,
        generatedByTaskId: workItemId,
      })
      .run();
    insertedEvidenceCount++;
  }

  return { insertedEvidenceCount, droppedUnverifiedEvidenceCount };
}
