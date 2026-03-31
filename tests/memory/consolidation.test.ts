import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consolidate,
  deduplicateDecisions,
  identifyStaleEvents,
  stringSimilarity,
} from "../../internal/memory/consolidation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const daysAgo = (days: number, from: Date = new Date("2026-04-01T12:00:00Z")): string => {
  const d = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

const fixedNow = () => new Date("2026-04-01T12:00:00Z");

// ---------------------------------------------------------------------------
// stringSimilarity
// ---------------------------------------------------------------------------

describe("stringSimilarity", () => {
  it("1. identical strings return 1.0", () => {
    assert.equal(stringSimilarity("hello world", "hello world"), 1.0);
  });

  it("2. completely different strings return approximately 0.0", () => {
    const score = stringSimilarity("abcdef", "zyxwvu");
    assert.ok(score < 0.1, `expected < 0.1 but got ${score}`);
  });

  it("3. similar strings return > 0.5", () => {
    const score = stringSimilarity("use sqlite for storage", "use sqlite for persistence");
    assert.ok(score > 0.5, `expected > 0.5 but got ${score}`);
  });

  it("4a. both empty strings return 1.0", () => {
    assert.equal(stringSimilarity("", ""), 1.0);
  });

  it("4b. one empty string returns 0.0", () => {
    assert.equal(stringSimilarity("", "hello"), 0.0);
    assert.equal(stringSimilarity("hello", ""), 0.0);
  });

  it("5. comparison is case-sensitive", () => {
    const score = stringSimilarity("Hello", "hello");
    assert.ok(score < 1.0, `expected < 1.0 but got ${score}`);
  });
});

// ---------------------------------------------------------------------------
// deduplicateDecisions
// ---------------------------------------------------------------------------

describe("deduplicateDecisions", () => {
  it("6. exact duplicates are removed", () => {
    const result = deduplicateDecisions([
      "Use SQLite for memory",
      "Use SQLite for memory",
      "Use SQLite for memory",
    ]);
    assert.deepEqual(result.kept, ["Use SQLite for memory"]);
    assert.equal(result.removed, 2);
  });

  it("7. similar decisions above threshold are removed", () => {
    const result = deduplicateDecisions(
      [
        "use sqlite for storage layer",
        "use sqlite for the storage layer",
      ],
      0.8,
    );
    assert.equal(result.kept.length, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.kept[0], "use sqlite for storage layer");
  });

  it("8. different decisions are all kept", () => {
    const result = deduplicateDecisions([
      "Use SQLite for memory",
      "Ship as CLI first, not web",
      "TypeScript ESM only",
    ]);
    assert.equal(result.kept.length, 3);
    assert.equal(result.removed, 0);
  });

  it("9. empty list returns empty", () => {
    const result = deduplicateDecisions([]);
    assert.deepEqual(result.kept, []);
    assert.equal(result.removed, 0);
  });

  it("10. order is preserved — first occurrence is kept", () => {
    const result = deduplicateDecisions([
      "alpha",
      "beta",
      "alpha",
      "gamma",
      "beta",
    ]);
    assert.deepEqual(result.kept, ["alpha", "beta", "gamma"]);
    assert.equal(result.removed, 2);
  });
});

// ---------------------------------------------------------------------------
// identifyStaleEvents
// ---------------------------------------------------------------------------

describe("identifyStaleEvents", () => {
  const opts = { now: fixedNow };

  it("11. fresh events are not pruned", () => {
    const events = [
      { id: 1, eventType: "dispatch_start", createdAt: daysAgo(1) },
      { id: 2, eventType: "dispatch_end", createdAt: daysAgo(2) },
      { id: 3, eventType: "error", createdAt: daysAgo(3) },
    ];
    const stale = identifyStaleEvents(events, opts);
    assert.deepEqual(stale, []);
  });

  it("12. old dispatch_start events are pruned", () => {
    const events = [
      { id: 1, eventType: "dispatch_start", createdAt: daysAgo(10) },
      { id: 2, eventType: "dispatch_start", createdAt: daysAgo(1) },
    ];
    const stale = identifyStaleEvents(events, opts);
    assert.deepEqual(stale, [1]);
  });

  it("13. old dispatch_end events are pruned", () => {
    const events = [
      { id: 1, eventType: "dispatch_end", createdAt: daysAgo(8) },
      { id: 2, eventType: "dispatch_end", createdAt: daysAgo(3) },
    ];
    const stale = identifyStaleEvents(events, opts);
    assert.deepEqual(stale, [1]);
  });

  it("14. old error events are pruned", () => {
    const events = [
      { id: 1, eventType: "error", createdAt: daysAgo(15) },
      { id: 2, eventType: "error", createdAt: daysAgo(5) },
    ];
    const stale = identifyStaleEvents(events, opts);
    assert.deepEqual(stale, [1]);
  });

  it("15. decision events are never pruned regardless of age", () => {
    const events = [
      { id: 1, eventType: "decision", createdAt: daysAgo(100) },
      { id: 2, eventType: "decision", createdAt: daysAgo(365) },
    ];
    const stale = identifyStaleEvents(events, opts);
    assert.deepEqual(stale, []);
  });

  it("16. note events are never pruned regardless of age", () => {
    const events = [
      { id: 1, eventType: "note", createdAt: daysAgo(200) },
      { id: 2, eventType: "note", createdAt: daysAgo(500) },
    ];
    const stale = identifyStaleEvents(events, opts);
    assert.deepEqual(stale, []);
  });
});

// ---------------------------------------------------------------------------
// consolidate
// ---------------------------------------------------------------------------

describe("consolidate", () => {
  const opts = { now: fixedNow };

  it("17. full consolidation pass returns correct counts", () => {
    const events = [
      { id: 1, eventType: "dispatch_start", payload: { agent: "claude" }, createdAt: daysAgo(10) },
      { id: 2, eventType: "dispatch_end", payload: { agent: "claude" }, createdAt: daysAgo(10) },
      { id: 3, eventType: "error", payload: { error: "timeout" }, createdAt: daysAgo(20) },
      { id: 4, eventType: "decision", payload: { text: "Use SQLite" }, createdAt: daysAgo(30) },
      { id: 5, eventType: "note", payload: { text: "A note" }, createdAt: daysAgo(1) },
    ];
    const decisions = ["Use SQLite", "Use SQLite", "Ship CLI first"];

    const result = consolidate(events, decisions, opts);

    assert.equal(result.transientPruned, 2);
    assert.equal(result.errorsConsolidated, 1);
    assert.equal(result.decisionsDeduped, 1);
    assert.equal(result.totalProcessed, 5);
  });

  it("18. returns correct pruneIds", () => {
    const events = [
      { id: 10, eventType: "dispatch_start", payload: {}, createdAt: daysAgo(10) },
      { id: 20, eventType: "dispatch_end", payload: {}, createdAt: daysAgo(10) },
      { id: 30, eventType: "error", payload: {}, createdAt: daysAgo(20) },
      { id: 40, eventType: "note", payload: {}, createdAt: daysAgo(1) },
    ];
    const result = consolidate(events, [], opts);

    assert.deepEqual(result.pruneIds.sort((a, b) => a - b), [10, 20, 30]);
  });

  it("19. returns deduplicated decisions", () => {
    const events: Array<{ id: number; eventType: string; payload: Record<string, unknown>; createdAt: string }> = [];
    const decisions = [
      "Use SQLite for storage",
      "Use SQLite for the storage",
      "Ship CLI first",
      "TypeScript ESM only",
    ];

    const result = consolidate(events, decisions, { ...opts, similarityThreshold: 0.8 });

    assert.ok(result.decisions.length < decisions.length, "expected some dedup");
    assert.ok(result.decisions.includes("Ship CLI first"));
    assert.ok(result.decisions.includes("TypeScript ESM only"));
    assert.equal(result.decisionsDeduped, decisions.length - result.decisions.length);
  });

  it("20. empty input returns zero counts", () => {
    const result = consolidate([], [], opts);

    assert.equal(result.transientPruned, 0);
    assert.equal(result.decisionsDeduped, 0);
    assert.equal(result.errorsConsolidated, 0);
    assert.equal(result.totalProcessed, 0);
    assert.deepEqual(result.pruneIds, []);
    assert.deepEqual(result.decisions, []);
  });
});
