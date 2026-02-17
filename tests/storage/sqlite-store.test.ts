import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import type { Message, RoomConfig } from "../../internal/events/types.js";

const ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 10,
  maxHistoryMessages: 100,
  maxContextTokens: 4000,
};

function createMessage(roomId: string, id: string, text: string, createdAt: string): Message {
  return {
    id,
    roomId,
    author: "user",
    role: "user",
    text,
    format: "plain",
    metadata: {},
    createdAt,
  };
}

test("listMessagesAfter returns only messages after anchor in insertion order", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("storage-test", ["user"], ROOM_CONFIG);
    const ts = "2026-02-17T21:30:00.000Z";

    store.saveMessage(createMessage(room.id, "msg_1", "one", ts));
    store.saveMessage(createMessage(room.id, "msg_2", "two", ts));
    store.saveMessage(createMessage(room.id, "msg_3", "three", ts));

    const afterFirst = store.listMessagesAfter(room.id, "msg_1");
    assert.deepEqual(afterFirst.map((message) => message.id), ["msg_2", "msg_3"]);

    const afterLast = store.listMessagesAfter(room.id, "msg_3");
    assert.deepEqual(afterLast, []);
  } finally {
    store.close();
  }
});

test("listMessagesAfter returns empty array when anchor message does not exist", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("storage-test", ["user"], ROOM_CONFIG);
    store.saveMessage(
      createMessage(room.id, "msg_1", "hello", "2026-02-17T21:30:00.000Z"),
    );

    const result = store.listMessagesAfter(room.id, "missing_id");
    assert.deepEqual(result, []);
  } finally {
    store.close();
  }
});

test("getCheckpointCoverage returns null when room has no checkpoints", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("storage-test", ["user"], ROOM_CONFIG);
    assert.equal(store.getCheckpointCoverage(room.id), null);
  } finally {
    store.close();
  }
});

test("getCheckpointCoverage returns latest checkpoint range", async () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("storage-test", ["user"], ROOM_CONFIG);
    const ts = "2026-02-17T21:30:00.000Z";

    store.saveMessage(createMessage(room.id, "msg_1", "one", ts));
    store.saveMessage(createMessage(room.id, "msg_2", "two", ts));
    store.saveMessage(createMessage(room.id, "msg_3", "three", ts));

    store.saveCheckpoint(room.id, "summary-1", "msg_1", "msg_2");
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.saveCheckpoint(room.id, "summary-2", "msg_1", "msg_3");

    assert.deepEqual(store.getCheckpointCoverage(room.id), {
      fromMessageId: "msg_1",
      toMessageId: "msg_3",
    });
  } finally {
    store.close();
  }
});
