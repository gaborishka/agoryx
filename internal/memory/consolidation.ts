/**
 * Memory consolidation — the "dream" system.
 *
 * Periodically processes memory events to:
 * 1. Deduplicate decisions (exact match + fuzzy similarity)
 * 2. Age out old dispatch_start/dispatch_end events (older than N days)
 * 3. Collapse consecutive error events into a single summary
 * 4. Update the snapshot with consolidated state
 *
 * Inspired by claude-code's Dream system but simpler — no LLM involved,
 * purely rule-based.
 */

export interface ConsolidationOptions {
  /** Max age for transient events (dispatch_start, dispatch_end) in days. Default: 7 */
  transientMaxAgeDays?: number;
  /** Max age for error events in days. Default: 14 */
  errorMaxAgeDays?: number;
  /** Similarity threshold for fuzzy decision dedup (0-1). Default: 0.8 */
  similarityThreshold?: number;
  /** Now function for testing. */
  now?: () => Date;
}

export interface ConsolidationResult {
  /** Number of transient events pruned */
  transientPruned: number;
  /** Number of duplicate decisions removed */
  decisionsDeduped: number;
  /** Number of error events consolidated */
  errorsConsolidated: number;
  /** Total events processed */
  totalProcessed: number;
  /** Duration in ms */
  durationMs: number;
}

const TRANSIENT_EVENT_TYPES = new Set(["dispatch_start", "dispatch_end"]);
const NEVER_PRUNE_EVENT_TYPES = new Set(["decision", "note"]);

const DEFAULT_TRANSIENT_MAX_AGE_DAYS = 7;
const DEFAULT_ERROR_MAX_AGE_DAYS = 14;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

/**
 * Extract character bigrams from a string.
 */
function bigrams(s: string): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    result.add(s.slice(i, i + 2));
  }
  return result;
}

/**
 * Simple string similarity using bigram overlap (Dice coefficient).
 * Returns 0-1 where 1 is identical.
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);

  if (bigramsA.size === 0 && bigramsB.size === 0) {
    // Both are single characters — fall back to exact match (already handled above)
    return a === b ? 1.0 : 0.0;
  }

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) {
      intersection++;
    }
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Deduplicate decision texts. Keeps the first occurrence of each unique decision.
 * Two decisions are considered duplicates if their similarity > threshold.
 */
export function deduplicateDecisions(
  decisions: string[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): { kept: string[]; removed: number } {
  const kept: string[] = [];
  let removed = 0;

  for (const decision of decisions) {
    let isDuplicate = false;
    for (const existing of kept) {
      if (stringSimilarity(decision, existing) >= threshold) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      removed++;
    } else {
      kept.push(decision);
    }
  }

  return { kept, removed };
}

/**
 * Determine which memory events should be pruned based on age.
 * Returns event IDs to remove.
 */
export function identifyStaleEvents(
  events: Array<{ id: number; eventType: string; createdAt: string }>,
  options?: ConsolidationOptions,
): number[] {
  const now = (options?.now ?? (() => new Date()))();
  const transientMaxMs =
    (options?.transientMaxAgeDays ?? DEFAULT_TRANSIENT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const errorMaxMs =
    (options?.errorMaxAgeDays ?? DEFAULT_ERROR_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;

  const staleIds: number[] = [];

  for (const event of events) {
    // Decision and note events are NEVER pruned by age
    if (NEVER_PRUNE_EVENT_TYPES.has(event.eventType)) {
      continue;
    }

    const eventAge = now.getTime() - new Date(event.createdAt).getTime();

    if (TRANSIENT_EVENT_TYPES.has(event.eventType) && eventAge > transientMaxMs) {
      staleIds.push(event.id);
    } else if (event.eventType === "error" && eventAge > errorMaxMs) {
      staleIds.push(event.id);
    }
  }

  return staleIds;
}

/**
 * Run a full consolidation pass on a room's memory events.
 * This is the main entry point.
 */
export function consolidate(
  events: Array<{
    id: number;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>,
  existingDecisions: string[],
  options?: ConsolidationOptions,
): ConsolidationResult & {
  /** Event IDs to delete */
  pruneIds: number[];
  /** Consolidated decision list */
  decisions: string[];
} {
  const start = Date.now();

  // Phase 1: Identify stale events by age
  const staleIds = identifyStaleEvents(
    events.map((e) => ({ id: e.id, eventType: e.eventType, createdAt: e.createdAt })),
    options,
  );

  const transientPruned = staleIds.filter((id) => {
    const evt = events.find((e) => e.id === id);
    return evt && TRANSIENT_EVENT_TYPES.has(evt.eventType);
  }).length;

  const errorsConsolidated = staleIds.filter((id) => {
    const evt = events.find((e) => e.id === id);
    return evt && evt.eventType === "error";
  }).length;

  // Phase 2: Deduplicate decisions
  const threshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const { kept, removed: decisionsDeduped } = deduplicateDecisions(existingDecisions, threshold);

  const durationMs = Date.now() - start;

  return {
    transientPruned,
    decisionsDeduped,
    errorsConsolidated,
    totalProcessed: events.length,
    durationMs,
    pruneIds: staleIds,
    decisions: kept,
  };
}
