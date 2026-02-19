import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { MemoryService, REDUCER_VERSION } from "../../internal/memory/service.js";
import type { RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual", checkpointThreshold: 10,
  maxHistoryMessages: 100, maxContextTokens: 4000,
};

function makeStore(): SQLiteStore {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
}

test("recordDispatchStart appends log entry with source engine", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);
    svc.recordDispatchStart(room.id, "codex", "req_001");
    const events = store.listMemoryEvents(room.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "dispatch_start");
    assert.equal(events[0].source, "engine");
    assert.deepEqual(events[0].payload, { agent: "codex", requestId: "req_001" });
  } finally { store.close(); }
});

test("recordDispatchEnd appends log entry with result and files", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);
    svc.recordDispatchEnd(room.id, "claude", "done", ["context.ts"]);
    const events = store.listMemoryEvents(room.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "dispatch_end");
    assert.deepEqual(events[0].payload, { agent: "claude", result: "done", files: ["context.ts"] });
  } finally { store.close(); }
});

test("recordDecision appends decision event with user source", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);
    svc.recordDecision(room.id, "Use SQLite for memory");
    const events = store.listMemoryEvents(room.id, { eventType: "decision" });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "user");
    assert.deepEqual(events[0].payload, { text: "Use SQLite for memory" });
  } finally { store.close(); }
});

test("rebuildSnapshot creates snapshot from log events", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);
    svc.recordDecision(room.id, "Decision A");
    svc.recordDecision(room.id, "Decision B");
    svc.recordDispatchEnd(room.id, "codex", "done", []);

    const snap = svc.rebuildSnapshot(room.id);
    assert.ok(snap);
    assert.ok(snap.keyDecisions.includes("Decision A"));
    assert.ok(snap.keyDecisions.includes("Decision B"));
    assert.equal(snap.reducerVersion, REDUCER_VERSION);
    assert.ok(snap.lastLogId > 0);
  } finally { store.close(); }
});

test("rebuildSnapshot is idempotent", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);
    svc.recordDecision(room.id, "Test");
    const snap1 = svc.rebuildSnapshot(room.id);
    const snap2 = svc.rebuildSnapshot(room.id);
    assert.equal(snap1!.lastLogId, snap2!.lastLogId);
    assert.deepEqual(snap1!.keyDecisions, snap2!.keyDecisions);
  } finally { store.close(); }
});

test("checkAndRecover replays missing events after crash", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);

    // Simulate: 2 events exist, snapshot only covers first 1
    svc.recordDecision(room.id, "Before crash");
    svc.rebuildSnapshot(room.id);
    // Now add more events (simulate post-crash appends)
    svc.recordDecision(room.id, "After crash");

    // checkAndRecover should detect gap and replay
    const result = svc.checkAndRecover(room.id);
    assert.equal(result.action, "replayed");
    assert.ok(result.processed > 0);
    const snap = store.getMemorySnapshot(room.id);
    assert.ok(snap!.keyDecisions.includes("After crash"));
  } finally { store.close(); }
});

test("checkAndRecover triggers full replay on reducer_version mismatch", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);
    svc.recordDecision(room.id, "V1 decision");
    svc.rebuildSnapshot(room.id);

    // Manually tamper reducer_version to simulate upgrade
    const currentSnap = store.getMemorySnapshot(room.id)!;
    store.upsertMemorySnapshot(room.id, {
      ...currentSnap,
      reducerVersion: 0, // old version
      lastLogId: currentSnap.lastLogId,
    });

    const result = svc.checkAndRecover(room.id);
    assert.equal(result.action, "full_replay");
  } finally { store.close(); }
});

test("checkAndRecover resets stale snapshot when log is empty", () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);

    // Build a snapshot with log backing it
    svc.recordDecision(room.id, "Some decision");
    svc.rebuildSnapshot(room.id);
    const snapBefore = store.getMemorySnapshot(room.id);
    assert.ok(snapBefore!.lastLogId > 0);

    // Simulate log loss: manually clear memory_log (emulating partial data loss)
    (store as any).db.exec("DELETE FROM memory_log");

    // checkAndRecover should detect stale snapshot and delete it
    const result = svc.checkAndRecover(room.id);
    assert.equal(result.action, "full_replay");
    const snapAfter = store.getMemorySnapshot(room.id);
    assert.equal(snapAfter, null, "stale snapshot should be deleted when log is empty");
  } finally { store.close(); }
});

test("withRoomLock serializes concurrent operations for same room", async () => {
  const store = makeStore();
  try {
    const room = store.createRoom("mem-svc", ["user"], ROOM_CONFIG);
    const svc = new MemoryService(store);
    const order: string[] = [];

    const first = svc.withRoomLock(room.id, async () => {
      await wait(25);
      order.push("first");
      return "first";
    });
    const second = svc.withRoomLock(room.id, async () => {
      order.push("second");
      return "second";
    });

    const values = await Promise.all([first, second]);
    assert.deepEqual(values, ["first", "second"]);
    assert.deepEqual(order, ["first", "second"]);
  } finally { store.close(); }
});
