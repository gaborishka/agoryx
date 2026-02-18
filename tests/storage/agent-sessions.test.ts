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

const createMessage = (
  roomId: string,
  id: string,
  author: string,
  role: Message["role"],
  text: string,
  createdAt: string,
): Message => ({
  id,
  roomId,
  author,
  role,
  text,
  format: "plain",
  metadata: {},
  createdAt,
});

test("createAgentSession creates new active session", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const session = store.createAgentSession(room.id, "claude");

    assert.ok(session.id.startsWith("agtsess_"));
    assert.equal(session.roomId, room.id);
    assert.equal(session.agentName, "claude");
    assert.equal(session.nativeSessionId, null);
    assert.equal(session.transportMode, "resume");
    assert.equal(session.status, "active");
    assert.equal(session.lastSeenSeq, null);
    assert.equal(session.failCount, 0);
    assert.ok(typeof session.createdAt === "number");
  } finally {
    store.close();
  }
});

test("getActiveAgentSession returns active session for room+agent", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const created = store.createAgentSession(room.id, "claude");
    const found = store.getActiveAgentSession(room.id, "claude");

    assert.ok(found);
    assert.equal(found.id, created.id);
  } finally {
    store.close();
  }
});

test("getActiveAgentSession returns null when no active session", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const found = store.getActiveAgentSession(room.id, "claude");
    assert.equal(found, null);
  } finally {
    store.close();
  }
});

test("updateAgentSessionNativeId saves native session ID", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const created = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionNativeId(created.id, "thread_abc");

    const found = store.getActiveAgentSession(room.id, "claude");
    assert.equal(found?.nativeSessionId, "thread_abc");
  } finally {
    store.close();
  }
});

test("updateAgentSessionNativeId ignores empty string", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const created = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionNativeId(created.id, "thread_abc");
    store.updateAgentSessionNativeId(created.id, "");

    const found = store.getActiveAgentSession(room.id, "claude");
    assert.equal(found?.nativeSessionId, "thread_abc");
  } finally {
    store.close();
  }
});

test("updateAgentSessionCursor uses monotonic MAX semantics", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const created = store.createAgentSession(room.id, "claude");

    store.updateAgentSessionCursor(created.id, 10);
    store.updateAgentSessionCursor(created.id, 5);

    const found = store.getActiveAgentSession(room.id, "claude");
    assert.equal(found?.lastSeenSeq, 10);
  } finally {
    store.close();
  }
});

test("updateAgentSessionStatus transitions to expired", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const created = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionStatus(created.id, "expired");

    const found = store.getActiveAgentSession(room.id, "claude");
    assert.equal(found, null);
  } finally {
    store.close();
  }
});

test("creating new session after expired is allowed by partial unique index", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const first = store.createAgentSession(room.id, "claude");
    store.updateAgentSessionStatus(first.id, "expired");

    const second = store.createAgentSession(room.id, "claude");
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, "active");
  } finally {
    store.close();
  }
});

test("incrementAgentSessionFailCount increments and returns new count", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    const created = store.createAgentSession(room.id, "claude");

    const first = store.incrementAgentSessionFailCount(created.id);
    const second = store.incrementAgentSessionFailCount(created.id);

    assert.equal(first, 1);
    assert.equal(second, 2);
  } finally {
    store.close();
  }
});

test("listActiveAgentSessions returns only active sessions", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.createAgentSession(room.id, "claude");
    const codex = store.createAgentSession(room.id, "codex");
    store.updateAgentSessionStatus(codex.id, "failed");

    const active = store.listActiveAgentSessions(room.id);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.agentName, "claude");
  } finally {
    store.close();
  }
});

test("getMaxMessageSeq returns null for empty room", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    assert.equal(store.getMaxMessageSeq(room.id), null);
  } finally {
    store.close();
  }
});

test("getMaxMessageSeq returns rowid of latest message", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(
      createMessage(room.id, "msg_1", "user", "user", "hello", "2026-01-01T00:00:00Z"),
    );
    store.saveMessage(
      createMessage(
        room.id,
        "msg_2",
        "agent.claude",
        "assistant",
        "hi",
        "2026-01-01T00:00:01Z",
      ),
    );

    const seq = store.getMaxMessageSeq(room.id);
    assert.ok(typeof seq === "number");
    assert.ok((seq ?? 0) > 0);
  } finally {
    store.close();
  }
});

test("listMessagesDelta returns messages after seq excluding author", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(
      createMessage(room.id, "msg_1", "user", "user", "first", "2026-01-01T00:00:00Z"),
    );
    const seq1 = store.getMaxMessageSeq(room.id);

    store.saveMessage(
      createMessage(
        room.id,
        "msg_2",
        "agent.claude",
        "assistant",
        "my response",
        "2026-01-01T00:00:01Z",
      ),
    );
    store.saveMessage(
      createMessage(room.id, "msg_3", "user", "user", "second", "2026-01-01T00:00:02Z"),
    );
    store.saveMessage(
      createMessage(
        room.id,
        "msg_4",
        "agent.codex",
        "assistant",
        "codex says hi",
        "2026-01-01T00:00:03Z",
      ),
    );
    const cutoff = store.getMaxMessageSeq(room.id);

    assert.ok(seq1 !== null);
    assert.ok(cutoff !== null);
    const delta = store.listMessagesDelta(room.id, seq1!, cutoff!, "agent.claude");

    assert.equal(delta.length, 2);
    assert.equal(delta[0]?.id, "msg_3");
    assert.equal(delta[1]?.id, "msg_4");
  } finally {
    store.close();
  }
});

test("listMessagesDelta returns empty when no new messages", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const room = store.createRoom("test", ["user"], ROOM_CONFIG);
    store.saveMessage(
      createMessage(room.id, "msg_1", "user", "user", "hello", "2026-01-01T00:00:00Z"),
    );
    const seq = store.getMaxMessageSeq(room.id);

    assert.ok(seq !== null);
    const delta = store.listMessagesDelta(room.id, seq!, seq!, "agent.claude");
    assert.equal(delta.length, 0);
  } finally {
    store.close();
  }
});
