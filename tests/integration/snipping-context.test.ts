import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../../internal/session/context.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import {
  setFeatureOverride,
  clearAllFeatureOverrides,
} from "../../internal/config/features.js";

function createTestStore(): SQLiteStore {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
}

function saveMsg(
  store: SQLiteStore,
  roomId: string,
  id: string,
  text: string,
  author = "user",
  role: "user" | "assistant" | "system" = "user",
) {
  store.saveMessage({
    id,
    roomId,
    author,
    role,
    text,
    format: "plain",
    metadata: {},
    createdAt: new Date().toISOString(),
  });
}

describe("snipping integration with buildContext", () => {
  afterEach(() => {
    clearAllFeatureOverrides();
  });

  it("snips old messages when flag enabled and >20 messages", () => {
    setFeatureOverride("MESSAGE_SNIPPING", true);

    const store = createTestStore();
    const room = store.createRoom("test", ["user", "agent.codex"], {
      mode: "manual",
      checkpointThreshold: 100,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    // Create 30 messages — first 10 should be snipped (30 - 20 window = 10)
    for (let i = 1; i <= 30; i++) {
      saveMsg(store, room.id, `msg_${i}`, `This is message number ${i} with some content to verify snipping`);
    }

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 100,
      maxContextTokens: 100_000,
    });

    const userMsgs = ctx.messages.filter((m) => m.role !== "system");

    // Old messages (first 10) should contain [snipped] markers
    const snippedMsgs = userMsgs.filter(
      (m) =>
        m.text.startsWith("[snipped]") ||
        /^\[\d+ messages snipped from .+\]$/.test(m.text),
    );
    assert.ok(snippedMsgs.length > 0, "should have snipped messages");

    // Recent messages (last 20) should be intact
    const lastMsg = userMsgs[userMsgs.length - 1];
    assert.ok(
      lastMsg.text.includes("message number 30"),
      "newest message should be intact",
    );
  });

  it("does not snip when flag is disabled", () => {
    setFeatureOverride("MESSAGE_SNIPPING", false);

    const store = createTestStore();
    const room = store.createRoom("test", ["user", "agent.codex"], {
      mode: "manual",
      checkpointThreshold: 100,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    for (let i = 1; i <= 30; i++) {
      saveMsg(store, room.id, `msg_${i}`, `This is message number ${i}`);
    }

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 100,
      maxContextTokens: 100_000,
    });

    // No messages should contain snipped markers
    const snippedMsgs = ctx.messages.filter(
      (m) =>
        m.text.startsWith("[snipped]") ||
        /^\[\d+ messages snipped from .+\]$/.test(m.text),
    );
    assert.equal(snippedMsgs.length, 0, "no messages should be snipped when flag is off");

    // All 30 original messages should be present
    const userMsgs = ctx.messages.filter((m) => m.role !== "system");
    assert.equal(userMsgs.length, 30, "all messages should be present");
  });

  it("never snips system messages even when outside window", () => {
    setFeatureOverride("MESSAGE_SNIPPING", true);

    const store = createTestStore();
    const room = store.createRoom("test", ["user", "agent.codex"], {
      mode: "manual",
      checkpointThreshold: 100,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    // Place system messages early in conversation (outside recent window)
    saveMsg(store, room.id, "sys_1", "Important system instruction", "system", "system");
    saveMsg(store, room.id, "sys_2", "Another system note", "system", "system");

    // Add 25 more user messages so system messages are well outside the 20-message window
    for (let i = 1; i <= 25; i++) {
      saveMsg(store, room.id, `msg_${i}`, `User message ${i}`);
    }

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 100,
      maxContextTokens: 100_000,
    });

    // Find the system messages from the conversation (not synthetic ones from buildContext)
    const systemMsgs = ctx.messages.filter(
      (m) => m.id === "sys_1" || m.id === "sys_2",
    );
    assert.equal(systemMsgs.length, 2, "both system messages should be present");

    // System messages should NOT be snipped
    for (const msg of systemMsgs) {
      assert.ok(
        !msg.text.startsWith("[snipped]"),
        `system message "${msg.id}" should not be snipped`,
      );
    }
  });

  it("sets snippedCount field when snipping occurs", () => {
    setFeatureOverride("MESSAGE_SNIPPING", true);

    const store = createTestStore();
    const room = store.createRoom("test", ["user"], {
      mode: "manual",
      checkpointThreshold: 100,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    for (let i = 1; i <= 30; i++) {
      saveMsg(store, room.id, `msg_${i}`, `Message ${i}`);
    }

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 100,
      maxContextTokens: 100_000,
    });

    // 30 messages, window of 20 → 10 should be snipped
    assert.equal(ctx.snippedCount, 10, "snippedCount should be 10");
  });

  it("snippedCount is undefined when flag is disabled", () => {
    setFeatureOverride("MESSAGE_SNIPPING", false);

    const store = createTestStore();
    const room = store.createRoom("test", ["user"], {
      mode: "manual",
      checkpointThreshold: 100,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    for (let i = 1; i <= 30; i++) {
      saveMsg(store, room.id, `msg_${i}`, `Message ${i}`);
    }

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 100,
      maxContextTokens: 100_000,
    });

    assert.equal(ctx.snippedCount, undefined, "snippedCount should be undefined when flag is off");
  });

  it("does not snip messages within recent window (last 20)", () => {
    setFeatureOverride("MESSAGE_SNIPPING", true);

    const store = createTestStore();
    const room = store.createRoom("test", ["user", "agent.codex"], {
      mode: "manual",
      checkpointThreshold: 100,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    for (let i = 1; i <= 30; i++) {
      saveMsg(store, room.id, `msg_${i}`, `Message content for number ${i}`);
    }

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 100,
      maxContextTokens: 100_000,
    });

    // Messages 11-30 are within the 20-message recent window and should be intact
    const userMsgs = ctx.messages.filter((m) => m.role !== "system");
    for (const msg of userMsgs) {
      // Messages in the recent window should contain their original text
      if (msg.id && parseInt(msg.id.replace("msg_", ""), 10) > 10) {
        assert.ok(
          msg.text.includes("Message content for number"),
          `msg ${msg.id} in recent window should not be snipped`,
        );
      }
    }
  });

  it("works correctly with checkpoint-based context", () => {
    setFeatureOverride("MESSAGE_SNIPPING", true);

    const store = createTestStore();
    const room = store.createRoom("test", ["user", "agent.codex"], {
      mode: "manual",
      checkpointThreshold: 5,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    // Create 40 messages
    for (let i = 1; i <= 40; i++) {
      saveMsg(store, room.id, `msg_${i}`, `Discussion point ${i} with enough text`);
    }

    // Checkpoint covers messages 1-10
    store.saveCheckpoint(room.id, "Summary of first 10 messages", "msg_1", "msg_10");

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 5,
      maxContextTokens: 100_000,
    });

    // Post-checkpoint messages: msg_11 through msg_40 (30 messages)
    // With snipping: first 10 (msg_11 to msg_20) snipped, last 20 (msg_21 to msg_40) intact
    const userMsgs = ctx.messages.filter((m) => m.role === "user");

    // The newest message should always be intact
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    assert.ok(
      lastUserMsg.text.includes("Discussion point 40"),
      "newest message should be intact",
    );

    // snippedCount should reflect snipped messages
    assert.ok(
      ctx.snippedCount !== undefined && ctx.snippedCount > 0,
      "snippedCount should be set for checkpoint-based context with >20 post-checkpoint messages",
    );

    // Checkpoint summary should still be present
    const hasSummary = ctx.messages.some((m) =>
      m.text.includes("Summary of first 10 messages"),
    );
    assert.ok(hasSummary, "checkpoint summary should be in context");
  });

  it("snippedCount is 0 when all messages fit within recent window", () => {
    setFeatureOverride("MESSAGE_SNIPPING", true);

    const store = createTestStore();
    const room = store.createRoom("test", ["user"], {
      mode: "manual",
      checkpointThreshold: 100,
      maxHistoryMessages: 100,
      maxContextTokens: 100_000,
    });

    // Only 15 messages — all fit within the 20-message window
    for (let i = 1; i <= 15; i++) {
      saveMsg(store, room.id, `msg_${i}`, `Message ${i}`);
    }

    const ctx = buildContext(store, {
      roomId: room.id,
      maxHistoryMessages: 100,
      checkpointThreshold: 100,
      maxContextTokens: 100_000,
    });

    assert.equal(ctx.snippedCount, 0, "snippedCount should be 0 when all messages fit in window");

    // All messages should be intact
    const userMsgs = ctx.messages.filter((m) => m.role !== "system");
    assert.equal(userMsgs.length, 15, "all 15 messages should be present and intact");
  });
});
