import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import type { RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual", checkpointThreshold: 10,
  maxHistoryMessages: 100, maxContextTokens: 4000,
};

test("getMemorySnapshot returns null for room without snapshot", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("snap-test", ["user"], ROOM_CONFIG);
    assert.equal(store.getMemorySnapshot(room.id), null);
  } finally { store.close(); }
});

test("upsertMemorySnapshot creates snapshot and returns it", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("snap-test", ["user"], ROOM_CONFIG);
    const snap = store.upsertMemorySnapshot(room.id, {
      currentGoal: "Build v0.3",
      activeBranch: "feat/v0.3",
      activeWorktrees: [],
      keyDecisions: ["Use SQLite"],
      blockers: [],
      nextActions: ["Implement memory"],
      taskStatus: {},
      lastLogId: 5,
      reducerVersion: 1,
    });
    assert.equal(snap.roomId, room.id);
    assert.equal(snap.currentGoal, "Build v0.3");
    assert.equal(snap.lastLogId, 5);
    assert.equal(snap.reducerVersion, 1);
  } finally { store.close(); }
});

test("upsertMemorySnapshot updates existing snapshot", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("snap-test", ["user"], ROOM_CONFIG);
    store.upsertMemorySnapshot(room.id, {
      currentGoal: "v1", activeBranch: "main", activeWorktrees: [],
      keyDecisions: [], blockers: [], nextActions: [], taskStatus: {},
      lastLogId: 1, reducerVersion: 1,
    });
    store.upsertMemorySnapshot(room.id, {
      currentGoal: "v2", activeBranch: "feat/x", activeWorktrees: [],
      keyDecisions: ["Decision A"], blockers: [], nextActions: [], taskStatus: {},
      lastLogId: 10, reducerVersion: 1,
    });
    const snap = store.getMemorySnapshot(room.id);
    assert.equal(snap!.currentGoal, "v2");
    assert.equal(snap!.lastLogId, 10);
  } finally { store.close(); }
});

test("upsertMemorySnapshot enforces monotonic lastLogId", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("snap-test", ["user"], ROOM_CONFIG);
    store.upsertMemorySnapshot(room.id, {
      currentGoal: "v1", activeBranch: "main", activeWorktrees: [],
      keyDecisions: [], blockers: [], nextActions: [], taskStatus: {},
      lastLogId: 10, reducerVersion: 1,
    });
    assert.throws(() => {
      store.upsertMemorySnapshot(room.id, {
        currentGoal: "v2", activeBranch: "main", activeWorktrees: [],
        keyDecisions: [], blockers: [], nextActions: [], taskStatus: {},
        lastLogId: 5, reducerVersion: 1,
      });
    }, /monotonic/i);
  } finally { store.close(); }
});
