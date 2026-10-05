import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import type { RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 10,
  maxHistoryMessages: 100,
  maxContextTokens: 4000,
};

test("appendMemoryEvent inserts and returns event with id", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    const evt = store.appendMemoryEvent({
      eventId: "evt_test001",
      roomId: room.id,
      source: "engine",
      eventType: "dispatch_end",
      payload: { agent: "codex", result: "done" },
    });
    assert.equal(evt.eventId, "evt_test001");
    assert.equal(evt.source, "engine");
    assert.equal(evt.eventType, "dispatch_end");
    assert.ok(evt.id > 0);
  } finally {
    store.close();
  }
});

test("appendMemoryEvent deduplicates on event_id (ON CONFLICT DO NOTHING)", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    const first = store.appendMemoryEvent({
      eventId: "evt_dup001",
      roomId: room.id,
      source: "engine",
      eventType: "dispatch_start",
      payload: {},
    });
    const second = store.appendMemoryEvent({
      eventId: "evt_dup001",
      roomId: room.id,
      source: "engine",
      eventType: "dispatch_start",
      payload: {},
    });
    assert.equal(second, null, "duplicate insert should return null");
    const all = store.listMemoryEvents(room.id);
    assert.equal(all.length, 1);
  } finally {
    store.close();
  }
});

test("appendMemoryEvent rejects invalid event_type via CHECK constraint", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    assert.throws(() => {
      store.appendMemoryEvent({
        eventId: "evt_bad001",
        roomId: room.id,
        source: "engine",
        eventType: "invalid_type" as any,
        payload: {},
      });
    });
  } finally {
    store.close();
  }
});

test("listMemoryEvents returns events in id ASC order", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    store.appendMemoryEvent({ eventId: "evt_a", roomId: room.id, source: "engine", eventType: "dispatch_start", payload: {} });
    store.appendMemoryEvent({ eventId: "evt_b", roomId: room.id, source: "adapter.codex", eventType: "dispatch_end", payload: {} });
    store.appendMemoryEvent({ eventId: "evt_c", roomId: room.id, source: "user", eventType: "decision", payload: { text: "Use SQLite" } });
    const events = store.listMemoryEvents(room.id);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(e => e.eventId), ["evt_a", "evt_b", "evt_c"]);
  } finally {
    store.close();
  }
});

test("listMemoryEventsAfter supports afterId filter", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    store.appendMemoryEvent({ eventId: "evt_1", roomId: room.id, source: "engine", eventType: "dispatch_start", payload: {} });
    const second = store.appendMemoryEvent({ eventId: "evt_2", roomId: room.id, source: "engine", eventType: "dispatch_end", payload: {} });
    store.appendMemoryEvent({ eventId: "evt_3", roomId: room.id, source: "engine", eventType: "decision", payload: {} });
    const after = store.listMemoryEventsAfter(room.id, second!.id);
    assert.equal(after.length, 1);
    assert.equal(after[0].eventId, "evt_3");
  } finally {
    store.close();
  }
});

test("listMemoryEvents supports type and source filters", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    store.appendMemoryEvent({ eventId: "evt_d1", roomId: room.id, source: "engine", eventType: "dispatch_start", payload: {} });
    store.appendMemoryEvent({ eventId: "evt_d2", roomId: room.id, source: "user", eventType: "decision", payload: {} });
    store.appendMemoryEvent({ eventId: "evt_d3", roomId: room.id, source: "engine", eventType: "dispatch_end", payload: {} });
    const decisions = store.listMemoryEvents(room.id, { eventType: "decision" });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].source, "user");
    const engineOnly = store.listMemoryEvents(room.id, { source: "engine" });
    assert.equal(engineOnly.length, 2);
  } finally {
    store.close();
  }
});

test("getMaxMemoryLogId returns null for empty room", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    assert.equal(store.getMaxMemoryLogId(room.id), null);
  } finally {
    store.close();
  }
});

test("getMaxMemoryLogId returns latest id", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    store.appendMemoryEvent({ eventId: "evt_x1", roomId: room.id, source: "engine", eventType: "dispatch_start", payload: {} });
    const last = store.appendMemoryEvent({ eventId: "evt_x2", roomId: room.id, source: "engine", eventType: "dispatch_end", payload: {} });
    assert.equal(store.getMaxMemoryLogId(room.id), last!.id);
  } finally {
    store.close();
  }
});

test("listMemoryEvents with limit 0 returns empty array", () => {
  const store = new SQLiteStore(":memory:");
  store.init();
  try {
    const room = store.createRoom("mem-test", ["user"], ROOM_CONFIG);
    store.appendMemoryEvent({ eventId: "evt_lim1", roomId: room.id, source: "engine", eventType: "dispatch_start", payload: {} });
    store.appendMemoryEvent({ eventId: "evt_lim2", roomId: room.id, source: "engine", eventType: "dispatch_end", payload: {} });
    const result = store.listMemoryEvents(room.id, { limit: 0 });
    assert.equal(result.length, 0);
  } finally {
    store.close();
  }
});
