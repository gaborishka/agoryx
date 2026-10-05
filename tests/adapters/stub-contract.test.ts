import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../../internal/adapters/claude/index.js";
import { CodexAdapter } from "../../internal/adapters/codex/index.js";
import type { AgentInput, Adapter } from "../../internal/adapters/adapter.js";
import type { Message } from "../../internal/events/types.js";

const buildInput = (requestId: string): AgentInput => ({
  roomId: "room_contract",
  sessionId: "sess_contract",
  requestId,
  messages: [
    {
      id: "msg_user",
      roomId: "room_contract",
      author: "user",
      role: "user",
      text: "Provide a response in stub mode.",
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    } satisfies Message,
  ],
  config: {
    mode: "stub",
    timeoutMs: 1_000,
    maxTokens: 500,
  },
});

const collectEventTypes = async (
  adapter: Adapter,
  requestId: string,
): Promise<string[]> => {
  const types: string[] = [];
  for await (const event of adapter.send(buildInput(requestId))) {
    types.push(event.type);
  }
  return types;
};

test("codex adapter emits started/delta/completed in stub mode", async () => {
  const adapter = new CodexAdapter();
  const types = await collectEventTypes(adapter, "req_codex_stub");
  assert.deepEqual(types, ["message.started", "message.delta", "message.completed"]);
});

test("claude adapter emits started/delta/completed in stub mode", async () => {
  const adapter = new ClaudeAdapter();
  const types = await collectEventTypes(adapter, "req_claude_stub");
  assert.deepEqual(types, ["message.started", "message.delta", "message.completed"]);
});

test("codex adapter health and cancel behavior is stable", async () => {
  const adapter = new CodexAdapter();
  const before = await adapter.health();
  await adapter.cancel("non_existing_request");
  const after = await adapter.health();
  assert.equal(before, "ready");
  assert.equal(after, "ready");
});

test("claude adapter health and cancel behavior is stable", async () => {
  const adapter = new ClaudeAdapter();
  const before = await adapter.health();
  await adapter.cancel("non_existing_request");
  const after = await adapter.health();
  assert.equal(before, "ready");
  assert.equal(after, "ready");
});
