import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import type { Room, RoomConfig } from "../../internal/events/types.js";

const CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 5,
  maxHistoryMessages: 100,
  maxContextTokens: 100_000,
};

function setup(): { store: SQLiteStore; session: SessionService; room: Room } {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const { room } = session.createSession({
    roomName: "test", participants: ["user", "agent.codex"], roomConfig: CONFIG,
  });
  return { store, session, room };
}

function addMessages(session: SessionService, roomId: string, count: number) {
  for (let i = 0; i < count; i++) {
    session.saveUserMessage(roomId, `message ${i + 1}`);
  }
}

test("dedup: repeated /summary without new messages returns null", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 6);

  const first = session.maybeCreateCheckpoint(room, true);
  assert.ok(first, "first checkpoint should be created");

  const second = session.maybeCreateCheckpoint(room, true);
  assert.equal(second, null, "second checkpoint without new messages should be null");
});

test("auto threshold: skips when uncovered < checkpointThreshold", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 3); // less than threshold of 5

  const result = session.maybeCreateCheckpoint(room);
  assert.equal(result, null, "auto checkpoint should skip below threshold");
});

test("auto threshold: creates when uncovered >= checkpointThreshold", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 6); // above threshold of 5

  const result = session.maybeCreateCheckpoint(room);
  assert.ok(result, "auto checkpoint should create at threshold");
});

test("force threshold: creates when uncovered >= 2", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 2);

  const result = session.maybeCreateCheckpoint(room, true);
  assert.ok(result, "force checkpoint should create with 2+ messages");
});

test("force threshold: skips when uncovered < 2", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 1);

  const result = session.maybeCreateCheckpoint(room, true);
  assert.equal(result, null, "force checkpoint should skip with < 2 messages");
});

test("cumulative: new checkpoint includes previous summary", () => {
  const { store, session, room } = setup();
  addMessages(session, room.id, 6);

  const first = session.maybeCreateCheckpoint(room, true);
  assert.ok(first);

  // Add more messages
  addMessages(session, room.id, 6);

  const second = session.maybeCreateCheckpoint(room, true);
  assert.ok(second);
  assert.ok(second.includes("[Prior summary]"),
    "second checkpoint should include prior summary");
});

test("checkpoint range preserves fromMessageId (INV-1)", () => {
  const { store, session, room } = setup();
  addMessages(session, room.id, 6);

  session.maybeCreateCheckpoint(room, true);
  const firstCoverage = store.getCheckpointCoverage(room.id);
  assert.ok(firstCoverage);

  addMessages(session, room.id, 6);
  session.maybeCreateCheckpoint(room, true);
  const secondCoverage = store.getCheckpointCoverage(room.id);
  assert.ok(secondCoverage);

  assert.equal(secondCoverage.fromMessageId, firstCoverage.fromMessageId,
    "fromMessageId should be preserved from first checkpoint (INV-1)");
});

test("dedup works when anchor is outside maxHistoryMessages window (INV-5)", () => {
  const smallWindowConfig: RoomConfig = {
    mode: "manual",
    checkpointThreshold: 5,
    maxHistoryMessages: 3, // very small window
    maxContextTokens: 100_000,
  };
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const { room } = session.createSession({
    roomName: "test", participants: ["user"], roomConfig: smallWindowConfig,
  });

  // Add 10 messages
  for (let i = 0; i < 10; i++) {
    session.saveUserMessage(room.id, `message ${i}`);
  }
  const first = session.maybeCreateCheckpoint(room, true);
  assert.ok(first, "first checkpoint should be created");

  // Verify first checkpoint covers the REAL last message, not a windowed subset
  const firstCoverage = store.getCheckpointCoverage(room.id);
  assert.ok(firstCoverage);
  const allMsgs = store.listMessages(room.id, 10_000).filter(
    m => m.role === "user" || m.role === "assistant"
  );
  assert.equal(firstCoverage.toMessageId, allMsgs[allMsgs.length - 1].id,
    "first checkpoint toMessageId must be the actual last message (INV-1)");

  // Add 6 more messages — anchor is now outside window of 3
  for (let i = 0; i < 6; i++) {
    session.saveUserMessage(room.id, `new message ${i}`);
  }

  // This should NOT return null — there ARE new messages after the checkpoint
  const second = session.maybeCreateCheckpoint(room, true);
  assert.ok(second, "should create checkpoint even when anchor is outside history window");
});

test("structured summary has topics and decisions sections", () => {
  const { session, room } = setup();
  // Add messages with decision patterns
  session.saveUserMessage(room.id, "let's use SQLite for storage");
  session.saveUserMessage(room.id, "explain the context builder algorithm");
  session.saveUserMessage(room.id, "context builder uses checkpoints");
  session.saveUserMessage(room.id, "використовуємо TypeScript");
  session.saveUserMessage(room.id, "the checkpoint creates summaries");
  session.saveUserMessage(room.id, "testing the summary");

  const summary = session.maybeCreateCheckpoint(room, true);
  assert.ok(summary);
  assert.ok(summary.includes("Topics:"), "should have Topics section");
  assert.ok(summary.includes("Decisions:"), "should have Decisions section");
  assert.ok(summary.includes("[Checkpoint]"), "should have header");
});

test("no nested [Prior summary] wrappers after 3 checkpoints (INV-3)", () => {
  const { session, room } = setup();

  // 3 rounds of messages + checkpoints
  for (let round = 0; round < 3; round++) {
    addMessages(session, room.id, 6);
    session.maybeCreateCheckpoint(room, true);
  }

  // Get the latest summary
  addMessages(session, room.id, 6);
  const summary = session.maybeCreateCheckpoint(room, true);
  assert.ok(summary);

  const count = (summary.match(/\[Prior summary\]/g) || []).length;
  assert.equal(count, 1,
    "should have exactly one [Prior summary] section regardless of checkpoint depth");
});

// --- 10k ceiling regression tests ---
// These use >10,001 messages so the old listMessages(10_000) ASC LIMIT
// would return stale data and fail. Inserting 10k+ rows takes ~60ms
// in in-memory SQLite, so runtime impact is minimal.

function bulkInsertMessages(store: SQLiteStore, roomId: string, count: number): string {
  const ts = "2026-02-17T12:00:00.000Z";
  let lastId = "";
  for (let i = 0; i < count; i++) {
    lastId = `bmsg_${i}`;
    store.saveMessage({
      id: lastId, roomId, author: "user", role: "user",
      text: `m${i}`, format: "plain", metadata: {}, createdAt: ts,
    });
  }
  return lastId;
}

test("auto-checkpoint triggers with >10k messages and threshold >10k (P2a)", () => {
  // Old code: listMessages(10_000) caps at oldest 10k → uncoveredMessages.length
  // maxes at 10,000, so a threshold of 10,001 can never be reached.
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const { room } = session.createSession({
    roomName: "test", participants: ["user"],
    roomConfig: { mode: "manual", checkpointThreshold: 10_001, maxHistoryMessages: 10, maxContextTokens: 100_000 },
  });

  // Insert 10,002 messages (exceeds threshold of 10,001)
  bulkInsertMessages(store, room.id, 10_002);

  const result = session.maybeCreateCheckpoint(room);
  assert.ok(result, "auto checkpoint must trigger when message count exceeds 10k threshold");
});

test("first checkpoint toMessageId is accurate with >10k messages (P2b)", () => {
  // Old code: listMessages(10_000) ASC LIMIT returns oldest 10k → toMessageId
  // points to the 10,000th oldest message, not the actual last.
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const { room } = session.createSession({
    roomName: "test", participants: ["user"],
    roomConfig: { mode: "manual", checkpointThreshold: 5, maxHistoryMessages: 10, maxContextTokens: 100_000 },
  });

  const actualLastId = bulkInsertMessages(store, room.id, 10_001);

  session.maybeCreateCheckpoint(room, true);
  const coverage = store.getCheckpointCoverage(room.id);
  assert.ok(coverage);
  assert.equal(coverage.toMessageId, actualLastId,
    "toMessageId must be the actual last message (bmsg_10000), not bmsg_9999 from capped window");
});
