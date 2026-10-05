import test from "node:test";
import assert from "node:assert/strict";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import {
  setFeatureOverride,
  clearAllFeatureOverrides,
  isFeatureEnabled,
} from "../../internal/config/features.js";
import type { Room, RoomConfig } from "../../internal/events/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestStore(): SQLiteStore {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
}

const DEFAULT_ROOM_CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 50,
  maxHistoryMessages: 100,
  maxContextTokens: 100_000,
};

function createService(store: SQLiteStore): SessionService {
  return new SessionService(store);
}

function saveMsg(
  store: SQLiteStore,
  roomId: string,
  id: string,
  text: string,
  author = "user",
  role: "user" | "assistant" = "user",
): void {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("context cache: first call builds full context, second call uses cache", () => {
  setFeatureOverride("CONTEXT_CACHE", true);
  try {
    const store = createTestStore();
    const service = createService(store);
    const room = store.createRoom("test", ["user"], DEFAULT_ROOM_CONFIG);

    // Add a pin so there is static context to cache
    store.addPinnedContext(room.id, "rules", "Always use TypeScript", "user");

    saveMsg(store, room.id, "msg_1", "hello world");
    saveMsg(store, room.id, "msg_2", "how are you");

    const systemPrompt = "You are a helpful assistant.";

    // First call — cache miss, populates cache
    const ctx1 = service.buildFullContext(room, systemPrompt);

    // Second call — should use cache for static parts
    const ctx2 = service.buildFullContext(room, systemPrompt);

    // Both should produce the same messages
    assert.equal(ctx1.messages.length, ctx2.messages.length,
      "cached and non-cached should have same message count");

    // Static messages should be identical
    const static1 = ctx1.messages.filter(m =>
      m.id === "system-prompt" || m.id === "workspace-context" || m.text.startsWith("[Pinned:"));
    const static2 = ctx2.messages.filter(m =>
      m.id === "system-prompt" || m.id === "workspace-context" || m.text.startsWith("[Pinned:"));

    assert.equal(static1.length, static2.length,
      "static message counts should match");
    for (let i = 0; i < static1.length; i++) {
      assert.equal(static1[i].id, static2[i].id,
        `static message id should match at index ${i}`);
      assert.equal(static1[i].text, static2[i].text,
        `static message text should match at index ${i}`);
    }

    // Conversation messages should also match
    const conv1 = ctx1.messages.filter(m => m.role === "user");
    const conv2 = ctx2.messages.filter(m => m.role === "user");
    assert.equal(conv1.length, conv2.length);
    assert.equal(conv1[0].id, conv2[0].id);

    // systemPrompt field should be set
    assert.equal(ctx2.systemPrompt, systemPrompt);
  } finally {
    clearAllFeatureOverrides();
  }
});

test("context cache: adding a pin invalidates cache", () => {
  setFeatureOverride("CONTEXT_CACHE", true);
  try {
    const store = createTestStore();
    const service = createService(store);
    const room = store.createRoom("test", ["user"], DEFAULT_ROOM_CONFIG);

    saveMsg(store, room.id, "msg_1", "hello");

    const systemPrompt = "You are helpful.";

    // Build context once to populate cache
    const ctx1 = service.buildFullContext(room, systemPrompt);
    const pinsBefore = ctx1.messages.filter(m => m.text.startsWith("[Pinned:"));
    assert.equal(pinsBefore.length, 0, "no pins yet");

    // Add a pin — should invalidate cache
    service.addPinnedContext(room.id, "convention", "Use semicolons");

    // Build again — should reflect the new pin (cache was invalidated)
    const ctx2 = service.buildFullContext(room, systemPrompt);
    const pinsAfter = ctx2.messages.filter(m => m.text.startsWith("[Pinned:"));
    assert.equal(pinsAfter.length, 1, "new pin should appear after invalidation");
    assert.ok(pinsAfter[0].text.includes("Use semicolons"));
  } finally {
    clearAllFeatureOverrides();
  }
});

test("context cache: removing a pin invalidates cache", () => {
  setFeatureOverride("CONTEXT_CACHE", true);
  try {
    const store = createTestStore();
    const service = createService(store);
    const room = store.createRoom("test", ["user"], DEFAULT_ROOM_CONFIG);

    saveMsg(store, room.id, "msg_1", "hello");

    const systemPrompt = "You are helpful.";

    // Add a pin and build context to populate cache
    const pinId = service.addPinnedContext(room.id, "convention", "Use semicolons");
    const ctx1 = service.buildFullContext(room, systemPrompt);
    const pinsBefore = ctx1.messages.filter(m => m.text.startsWith("[Pinned:"));
    assert.equal(pinsBefore.length, 1, "pin should be present");

    // Remove the pin — should invalidate cache
    const removed = service.removePinnedContext(room.id, pinId);
    assert.ok(removed, "pin should be removed");

    // Build again — should not have the pin anymore
    const ctx2 = service.buildFullContext(room, systemPrompt);
    const pinsAfter = ctx2.messages.filter(m => m.text.startsWith("[Pinned:"));
    assert.equal(pinsAfter.length, 0, "pin should be gone after removal + invalidation");
  } finally {
    clearAllFeatureOverrides();
  }
});

test("context cache: disabled when feature flag is off", () => {
  // Explicitly disable the feature flag
  setFeatureOverride("CONTEXT_CACHE", false);
  try {
    const store = createTestStore();
    const service = createService(store);
    const room = store.createRoom("test", ["user"], DEFAULT_ROOM_CONFIG);

    store.addPinnedContext(room.id, "rules", "Always use TypeScript", "user");
    saveMsg(store, room.id, "msg_1", "hello");

    const systemPrompt = "You are helpful.";

    // Build context multiple times
    const ctx1 = service.buildFullContext(room, systemPrompt);
    const ctx2 = service.buildFullContext(room, systemPrompt);

    // Both should work correctly
    assert.equal(ctx1.messages.length, ctx2.messages.length);

    // Verify the flag is indeed off
    assert.equal(isFeatureEnabled("CONTEXT_CACHE"), false);

    // Access internal cache size via a second service to confirm no entries
    // (We can't directly access private fields, but we can verify the results
    // are produced from full builds by checking they have the same structure)
    const conv1 = ctx1.messages.filter(m => m.role === "user");
    const conv2 = ctx2.messages.filter(m => m.role === "user");
    assert.equal(conv1.length, conv2.length, "results should be consistent");
  } finally {
    clearAllFeatureOverrides();
  }
});

test("context cache: token counts are consistent between cached and non-cached results", () => {
  setFeatureOverride("CONTEXT_CACHE", true);
  try {
    const store = createTestStore();
    const service = createService(store);
    const room = store.createRoom("test", ["user"], DEFAULT_ROOM_CONFIG);

    store.addPinnedContext(room.id, "rules", "Always use TypeScript", "user");
    store.addPinnedContext(room.id, "style", "Use camelCase naming", "user");

    for (let i = 1; i <= 5; i++) {
      saveMsg(store, room.id, `msg_${i}`, `message number ${i}`);
    }

    const systemPrompt = "You are a collaborative participant in a group chat.";

    // First call — full build, populates cache
    const ctx1 = service.buildFullContext(room, systemPrompt);

    // Second call — uses cache for static parts
    const ctx2 = service.buildFullContext(room, systemPrompt);

    // Token counts should be equal (or very close — both use chars/4 ceiling)
    assert.equal(ctx1.totalEstimatedTokens, ctx2.totalEstimatedTokens,
      "token counts should be consistent between cached and non-cached results");

    // Verify the token count is reasonable: sum of all message texts / 4
    let expectedTokens = 0;
    for (const m of ctx1.messages) {
      expectedTokens += Math.ceil(m.text.length / 4);
    }
    assert.equal(ctx1.totalEstimatedTokens, expectedTokens,
      "token count should equal sum of message token estimates");
  } finally {
    clearAllFeatureOverrides();
  }
});

test("context cache: new messages appear correctly with cached static context", () => {
  setFeatureOverride("CONTEXT_CACHE", true);
  try {
    const store = createTestStore();
    const service = createService(store);
    const room = store.createRoom("test", ["user"], DEFAULT_ROOM_CONFIG);

    store.addPinnedContext(room.id, "rules", "Always use TypeScript", "user");

    const systemPrompt = "You are helpful.";

    // Build with one message
    saveMsg(store, room.id, "msg_1", "hello");
    const ctx1 = service.buildFullContext(room, systemPrompt);

    // Add more messages (static context unchanged — cache should still be valid)
    saveMsg(store, room.id, "msg_2", "world");
    saveMsg(store, room.id, "msg_3", "foo");
    const ctx2 = service.buildFullContext(room, systemPrompt);

    // ctx2 should have all 3 user messages
    const userMsgs = ctx2.messages.filter(m => m.role === "user");
    assert.equal(userMsgs.length, 3, "all 3 user messages should be present");
    assert.equal(userMsgs[0].id, "msg_1");
    assert.equal(userMsgs[1].id, "msg_2");
    assert.equal(userMsgs[2].id, "msg_3");

    // Static parts should still be there
    const hasSystem = ctx2.messages.some(m => m.id === "system-prompt");
    const hasPin = ctx2.messages.some(m => m.text.startsWith("[Pinned:"));
    assert.ok(hasSystem, "system prompt should be present");
    assert.ok(hasPin, "pinned context should be present");
  } finally {
    clearAllFeatureOverrides();
  }
});
