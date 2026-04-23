import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { MemoryService } from "../../internal/memory/service.js";
import {
  setFeatureOverride,
  clearAllFeatureOverrides,
} from "../../internal/config/features.js";
import type { RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 10,
  maxHistoryMessages: 100,
  maxContextTokens: 4000,
};

function makeStore(): SQLiteStore {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
}

/**
 * Insert a memory event with a specific timestamp by running raw SQL.
 * Needed because appendMemoryEvent uses the DB's default NOW().
 */
function insertEventWithTimestamp(
  store: SQLiteStore,
  roomId: string,
  eventType: string,
  payload: Record<string, unknown>,
  timestamp: string,
  eventId: string,
): void {
  // Access the private db via the store's public methods is not possible,
  // so we use a workaround: the store wraps better-sqlite3 and we need to
  // insert with a custom timestamp. We'll use a helper that accesses the
  // internal db via (store as any).
  const db = (store as any).db;
  db.prepare(
    `INSERT INTO memory_log (event_id, room_id, source, event_type, payload, timestamp)
     VALUES (?, ?, 'engine', ?, ?, ?)`,
  ).run(eventId, roomId, eventType, JSON.stringify(payload), timestamp);
}

describe("MemoryService consolidation integration", () => {
  let store: SQLiteStore;

  beforeEach(() => {
    store = makeStore();
    clearAllFeatureOverrides();
  });

  afterEach(async () => {
    clearAllFeatureOverrides();
    store.close();
  });

  it("runConsolidation returns null when feature disabled", () => {
    // DREAM_CONSOLIDATION is disabled by default
    const room = store.createRoom("consol-test", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 0 },
    });
    svc.recordDispatchStart(room.id, "codex", "req_001");

    const result = svc.runConsolidation(room.id);
    assert.equal(result, null);
  });

  it("runConsolidation returns null for empty room", () => {
    setFeatureOverride("DREAM_CONSOLIDATION", true);
    const room = store.createRoom("consol-empty", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 0 },
    });

    const result = svc.runConsolidation(room.id);
    assert.equal(result, null);
  });

  it("runConsolidation prunes old dispatch events", () => {
    setFeatureOverride("DREAM_CONSOLIDATION", true);
    const room = store.createRoom("consol-prune", ["user"], ROOM_CONFIG);

    // Insert old dispatch events (10 days ago — beyond 7 day default)
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    insertEventWithTimestamp(store, room.id, "dispatch_start", { agent: "codex", requestId: "r1" }, tenDaysAgo, "old_evt_1");
    insertEventWithTimestamp(store, room.id, "dispatch_end", { agent: "codex", result: "done", files: [] }, tenDaysAgo, "old_evt_2");

    // Insert a recent decision (should NOT be pruned)
    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 0 },
    });
    svc.recordDecision(room.id, "Keep this decision");

    // Verify we have 3 events before consolidation
    const eventsBefore = store.listMemoryEvents(room.id);
    assert.equal(eventsBefore.length, 3);

    const result = svc.runConsolidation(room.id);
    assert.ok(result);
    assert.equal(result.transientPruned, 2);
    assert.equal(result.totalProcessed, 3);

    // Verify only the decision event remains
    const eventsAfter = store.listMemoryEvents(room.id);
    assert.equal(eventsAfter.length, 1);
    assert.equal(eventsAfter[0].eventType, "decision");
  });

  it("runConsolidation deduplicates decisions", () => {
    setFeatureOverride("DREAM_CONSOLIDATION", true);
    const room = store.createRoom("consol-dedup", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 0 },
    });

    // Record duplicate decisions
    svc.recordDecision(room.id, "Use SQLite for storage");
    svc.recordDecision(room.id, "Use SQLite for storage");  // exact dup
    svc.recordDecision(room.id, "Use TypeScript everywhere");

    // Build snapshot first so we have decisions in it
    svc.rebuildSnapshot(room.id);
    const snapBefore = store.getMemorySnapshot(room.id);
    assert.ok(snapBefore);
    // rebuildSnapshot already deduplicates exact matches
    assert.equal(snapBefore.keyDecisions.length, 2);

    // Now add a near-duplicate via another approach:
    // manually add a similar decision directly to the snapshot for consolidation to dedup
    store.upsertMemorySnapshot(room.id, {
      ...snapBefore,
      keyDecisions: [
        "Use SQLite for storage",
        "Use SQLite for data storage",  // fuzzy dup
        "Use TypeScript everywhere",
      ],
      lastLogId: snapBefore.lastLogId,
      reducerVersion: snapBefore.reducerVersion,
    });

    const result = svc.runConsolidation(room.id);
    assert.ok(result);
    assert.equal(result.decisionsDeduped, 1);

    // Verify snapshot was updated with deduplicated decisions
    const snapAfter = store.getMemorySnapshot(room.id);
    assert.ok(snapAfter);
    assert.equal(snapAfter.keyDecisions.length, 2);
    assert.ok(snapAfter.keyDecisions.includes("Use SQLite for storage"));
    assert.ok(snapAfter.keyDecisions.includes("Use TypeScript everywhere"));
  });

  it("dispose clears the consolidation timer", async () => {
    setFeatureOverride("DREAM_CONSOLIDATION", true);
    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 60_000 },
    });

    // The timer should exist
    assert.notEqual((svc as any).consolidationTimer, null);

    await svc.dispose();

    // After dispose, the timer should be null
    assert.equal((svc as any).consolidationTimer, null);
  });

  it("knownRooms tracking works — rooms seen via record methods are auto-consolidated", () => {
    setFeatureOverride("DREAM_CONSOLIDATION", true);
    const room1 = store.createRoom("consol-room1", ["user"], ROOM_CONFIG);
    const room2 = store.createRoom("consol-room2", ["user"], ROOM_CONFIG);

    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 0 },  // no auto timer
    });

    // Record events in room1 and room2
    svc.recordDispatchStart(room1.id, "codex", "req_001");
    svc.recordDecision(room2.id, "Some decision");

    // Both rooms should be known
    const known = (svc as any).knownRooms as Set<string>;
    assert.ok(known.has(room1.id));
    assert.ok(known.has(room2.id));
    assert.equal(known.size, 2);

    // Insert old events directly to make consolidation do something
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    insertEventWithTimestamp(store, room1.id, "dispatch_start", { agent: "claude", requestId: "old" }, tenDaysAgo, "old_r1_1");

    // Trigger auto-consolidate manually
    (svc as any).autoConsolidate();

    // Verify old event in room1 was pruned (the recent one stays, old one removed)
    const events1 = store.listMemoryEvents(room1.id);
    // Original dispatch_start is recent, so it stays. Only the old inserted one gets pruned.
    assert.equal(events1.length, 1);
    assert.equal(events1[0].eventType, "dispatch_start");

    // room2 decision should be untouched (decisions are never pruned by age)
    const events2 = store.listMemoryEvents(room2.id);
    assert.equal(events2.length, 1);
    assert.equal(events2[0].eventType, "decision");
  });

  it("autoConsolidate is a no-op when disposed", () => {
    setFeatureOverride("DREAM_CONSOLIDATION", true);
    const room = store.createRoom("consol-disposed", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 0 },
    });

    // Insert an old event
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    insertEventWithTimestamp(store, room.id, "dispatch_start", { agent: "codex", requestId: "r1" }, tenDaysAgo, "disposed_evt_1");

    svc.recordNote(room.id, "some note");

    // Mark as disposed
    (svc as any).disposed = true;

    // autoConsolidate should bail out
    (svc as any).autoConsolidate();

    // The old event should still be there (not pruned)
    const events = store.listMemoryEvents(room.id);
    assert.equal(events.length, 2);
  });

  it("autoConsolidate catches errors per room without stopping", () => {
    setFeatureOverride("DREAM_CONSOLIDATION", true);
    const room = store.createRoom("consol-err", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store, {
      consolidation: { intervalMs: 0 },
    });
    svc.recordDispatchStart(room.id, "codex", "req_001");

    // Sabotage listMemoryEvents to throw for this specific room
    const original = store.listMemoryEvents.bind(store);
    let callCount = 0;
    store.listMemoryEvents = (roomId: string, filter?: any) => {
      callCount++;
      if (roomId === room.id) throw new Error("Simulated DB error");
      return original(roomId, filter);
    };

    // Should not throw — errors are caught and logged
    (svc as any).autoConsolidate();
    assert.equal(callCount, 1);

    // Restore
    store.listMemoryEvents = original;
  });
});
