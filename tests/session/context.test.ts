import test from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../../internal/session/context.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

function createTestStore(): SQLiteStore {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
}

function saveMsg(store: SQLiteStore, roomId: string, id: string, text: string, author = "user", role: "user" | "assistant" = "user") {
  store.saveMessage({
    id, roomId, author, role, text,
    format: "plain", metadata: {}, createdAt: new Date().toISOString(),
  });
}

test("totalEstimatedTokens does not double-count systemPrompt (INV-4)", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user"], {
    mode: "manual", checkpointThreshold: 50,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });
  saveMsg(store, room.id, "msg_1", "hello");

  const systemPrompt = "A".repeat(400); // 400 chars = ~100 tokens
  const ctx = buildContext(store, {
    roomId: room.id, systemPrompt,
    maxHistoryMessages: 100, checkpointThreshold: 50,
    maxContextTokens: 100_000,
  });

  // System prompt is in result as first message
  assert.equal(ctx.messages[0].role, "system");
  assert.ok(ctx.messages[0].text.includes(systemPrompt));

  // Total tokens should equal sum of all messages in result, NOT double system prompt
  let expected = 0;
  for (const msg of ctx.messages) {
    expected += Math.ceil(msg.text.length / 4);
  }
  assert.equal(ctx.totalEstimatedTokens, expected,
    "totalEstimatedTokens should match sum of result messages only");
});

test("buildContext uses checkpoint to load only post-checkpoint messages", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual", checkpointThreshold: 3,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });

  // Create 5 messages
  for (let i = 1; i <= 5; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }

  // Create checkpoint covering msg_1 through msg_3
  store.saveCheckpoint(room.id, "Summary of first 3 messages", "msg_1", "msg_3");

  const ctx = buildContext(store, {
    roomId: room.id,
    maxHistoryMessages: 100,
    checkpointThreshold: 3, // triggers checkpoint path
    maxContextTokens: 100_000,
  });

  // Should contain: checkpoint summary + msg_4, msg_5 (post-checkpoint)
  const userMsgs = ctx.messages.filter(m => m.role === "user");
  assert.equal(userMsgs.length, 2, "should only include post-checkpoint messages");
  assert.equal(userMsgs[0].id, "msg_4");
  assert.equal(userMsgs[1].id, "msg_5");

  // Checkpoint summary should be present
  const summaryMsg = ctx.messages.find(m => m.text.includes("Summary of first 3 messages"));
  assert.ok(summaryMsg, "checkpoint summary should be in context");
});
