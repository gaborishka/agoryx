import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import type { Message, RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 50,
  maxHistoryMessages: 100,
  maxContextTokens: 8000,
};

function createMessage(roomId: string, id: string, author: string, text: string): Message {
  return {
    id,
    roomId,
    author,
    role: author === "user" ? "user" : "assistant",
    text,
    format: "plain",
    metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
  };
}

test("buildDeltaPrompt returns full context on cold start (null lastSeenSeq)", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(createMessage(room.id, "msg_1", "user", "hello"));

    const result = service.buildDeltaPrompt(room, "claude", null);
    assert.ok(result.prompt.includes("hello"));
    assert.ok(result.cutoffSeq !== null);
  } finally {
    store.close();
  }
});

test("buildDeltaPrompt returns only delta messages for warm turn", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(createMessage(room.id, "msg_1", "user", "first"));
    const seq1 = store.getMaxMessageSeq(room.id);

    store.saveMessage(createMessage(room.id, "msg_2", "agent.claude", "my response"));
    store.saveMessage(createMessage(room.id, "msg_3", "agent.codex", "codex says hi"));
    store.saveMessage(createMessage(room.id, "msg_4", "user", "second question"));

    assert.ok(seq1 !== null);
    const result = service.buildDeltaPrompt(room, "claude", seq1!);
    assert.ok(result.prompt.includes("codex says hi"));
    assert.ok(result.prompt.includes("second question"));
    assert.ok(!result.prompt.includes("my response"));
  } finally {
    store.close();
  }
});

test("buildDeltaPrompt returns empty delta section when no new messages", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(createMessage(room.id, "msg_1", "user", "hello"));
    const seq = store.getMaxMessageSeq(room.id);

    assert.ok(seq !== null);
    const result = service.buildDeltaPrompt(room, "claude", seq!);
    assert.equal(result.prompt, "");
    assert.equal(result.cutoffSeq, seq);
  } finally {
    store.close();
  }
});

test("buildDeltaPrompt excludes ::pass:: protocol responses from warm delta", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], { ...ROOM_CONFIG, mode: "free" });
    store.saveMessage(createMessage(room.id, "msg_1", "user", "first"));
    const seq1 = store.getMaxMessageSeq(room.id);

    store.saveMessage(createMessage(room.id, "msg_2", "agent.codex", "::pass::"));
    store.saveMessage(createMessage(room.id, "msg_3", "agent.codex", "I can add one detail"));

    assert.ok(seq1 !== null);
    const result = service.buildDeltaPrompt(room, "claude", seq1!);
    assert.ok(result.prompt.includes("I can add one detail"));
    assert.ok(!result.prompt.includes("- [agent.codex][msg_2] ::pass::"));
  } finally {
    store.close();
  }
});

test("acquireTurnLock serializes concurrent turns for same agent", async () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const order: number[] = [];

    const turn1 = service.acquireTurnLock(room.id, "claude", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push(1);
      return 1;
    });

    const turn2 = service.acquireTurnLock(room.id, "claude", async () => {
      order.push(2);
      return 2;
    });

    await Promise.all([turn1, turn2]);
    assert.deepEqual(order, [1, 2]);
  } finally {
    store.close();
  }
});

test("acquireTurnLock allows concurrent turns for different agents", async () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const service = new SessionService(store);
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const order: string[] = [];

    const turn1 = service.acquireTurnLock(room.id, "claude", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("claude");
      return "claude";
    });

    const turn2 = service.acquireTurnLock(room.id, "codex", async () => {
      order.push("codex");
      return "codex";
    });

    await Promise.all([turn1, turn2]);
    assert.equal(order[0], "codex");
  } finally {
    store.close();
  }
});
