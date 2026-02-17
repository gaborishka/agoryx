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

test("fallback when checkpoint covers all messages loads recent history, not oldest window", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user"], {
    mode: "manual", checkpointThreshold: 5,
    maxHistoryMessages: 10, maxContextTokens: 100_000,
  });

  // Add 20 messages — total exceeds countLimit (max(10, 6) = 10)
  for (let i = 1; i <= 20; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }

  // Checkpoint covers ALL messages (toMessageId = last message)
  store.saveCheckpoint(room.id, "Summary of 20 messages", "msg_1", "msg_20");

  const ctx = buildContext(store, {
    roomId: room.id,
    maxHistoryMessages: 10,
    checkpointThreshold: 5,
    maxContextTokens: 100_000,
  });

  // afterCheckpoint is empty (checkpoint covers last message)
  // Fallback must include the NEWEST messages, not the oldest window
  const userMsgs = ctx.messages.filter(m => m.role === "user");
  if (userMsgs.length > 0) {
    const lastMsg = userMsgs[userMsgs.length - 1];
    assert.equal(lastMsg.id, "msg_20",
      "fallback should include newest messages, not oldest window");
  }

  // Checkpoint summary should still be present
  const hasSummary = ctx.messages.some(m => m.text.includes("Summary of 20 messages"));
  assert.ok(hasSummary, "checkpoint summary should be in context");
});

test("long dialogue: buildContext uses summary + recent after checkpoint", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual", checkpointThreshold: 5,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });

  // Create 30 messages
  for (let i = 1; i <= 30; i++) {
    saveMsg(store, room.id, `msg_${i}`, `discussion point ${i}`);
  }

  // Checkpoint covers msg_1..msg_25
  store.saveCheckpoint(room.id, "Summary of 25 messages about discussion", "msg_1", "msg_25");

  const ctx = buildContext(store, {
    roomId: room.id, maxHistoryMessages: 100,
    checkpointThreshold: 5, maxContextTokens: 100_000,
  });

  const userMsgs = ctx.messages.filter(m => m.role === "user");
  assert.equal(userMsgs.length, 5, "should have 5 post-checkpoint messages");
  assert.equal(userMsgs[0].id, "msg_26");

  const hasSummary = ctx.messages.some(m => m.text.includes("Summary of 25 messages"));
  assert.ok(hasSummary, "should include checkpoint summary");
});

test("pinned context + checkpoint summary both present in context", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual", checkpointThreshold: 3,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });

  // Add pinned context
  store.addPinnedContext(room.id, "project-rules", "Always use TypeScript", "user");

  // Add messages + checkpoint
  for (let i = 1; i <= 5; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }
  store.saveCheckpoint(room.id, "Summary of first messages", "msg_1", "msg_3");

  const ctx = buildContext(store, {
    roomId: room.id, maxHistoryMessages: 100,
    checkpointThreshold: 3, maxContextTokens: 100_000,
  });

  const hasPinned = ctx.messages.some(m => m.text.includes("Always use TypeScript"));
  const hasSummary = ctx.messages.some(m => m.text.includes("Summary of first messages"));
  assert.ok(hasPinned, "pinned context should be in output");
  assert.ok(hasSummary, "checkpoint summary should be in output");
});

test("buildContext threshold check works when checkpointThreshold > maxHistoryMessages (INV-5)", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual",
    checkpointThreshold: 20, // larger than maxHistoryMessages
    maxHistoryMessages: 10,
    maxContextTokens: 100_000,
  });

  // Create 25 messages — exceeds threshold
  for (let i = 1; i <= 25; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }

  // Checkpoint covers first 20
  store.saveCheckpoint(room.id, "Summary of 20 messages", "msg_1", "msg_20");

  const ctx = buildContext(store, {
    roomId: room.id,
    maxHistoryMessages: 10,
    checkpointThreshold: 20,
    maxContextTokens: 100_000,
  });

  // Should use checkpoint path (threshold exceeded) and show post-checkpoint messages
  const userMsgs = ctx.messages.filter(m => m.role === "user");
  assert.equal(userMsgs.length, 5, "should have 5 post-checkpoint messages");
  assert.equal(userMsgs[0].id, "msg_21");

  const hasSummary = ctx.messages.some(m => m.text.includes("Summary of 20 messages"));
  assert.ok(hasSummary, "should include checkpoint summary");
});

test("token budget: trims oldest messages when over budget", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user"], {
    mode: "manual", checkpointThreshold: 50,
    maxHistoryMessages: 100, maxContextTokens: 200, // very small budget (~800 chars)
  });

  // Each message ~100 chars = ~25 tokens. 10 messages = ~250 tokens > budget
  for (let i = 1; i <= 10; i++) {
    saveMsg(store, room.id, `msg_${i}`, `A`.repeat(100));
  }

  const ctx = buildContext(store, {
    roomId: room.id, maxHistoryMessages: 100,
    checkpointThreshold: 50, maxContextTokens: 200,
  });

  assert.ok(ctx.truncated, "should be truncated");
  assert.ok(ctx.messages.length < 10, "should have fewer than 10 messages");
  // Last message should always be present (newest kept)
  const lastMsg = ctx.messages[ctx.messages.length - 1];
  assert.equal(lastMsg.id, "msg_10", "newest message should be kept");
});

test("context fallback returns newest messages, not oldest window (P3)", () => {
  // Bug: buildContext fallback uses listMessages(10_000) which is ASC LIMIT,
  // giving the oldest 10k rows. For rooms >10k, .slice(-maxHistoryMessages)
  // still returns stale data from the oldest window.
  const store = createTestStore();
  const room = store.createRoom("test", ["user"], {
    mode: "manual", checkpointThreshold: 5,
    maxHistoryMessages: 10, maxContextTokens: 100_000,
  });

  // Add 50 messages to clearly exceed any internal limits
  for (let i = 1; i <= 50; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }

  // No checkpoint — threshold exceeded → fallback path
  const ctx = buildContext(store, {
    roomId: room.id,
    maxHistoryMessages: 10,
    checkpointThreshold: 5,
    maxContextTokens: 100_000,
  });

  // Should contain the NEWEST 10 messages (msg_41..msg_50), not oldest
  const userMsgs = ctx.messages.filter(m => m.role === "user");
  assert.equal(userMsgs.length, 10, "should have maxHistoryMessages messages");
  assert.equal(userMsgs[userMsgs.length - 1].id, "msg_50",
    "last message should be the newest");
  assert.equal(userMsgs[0].id, "msg_41",
    "first message should be msg_41 (newest 10)");
});
