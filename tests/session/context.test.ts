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
