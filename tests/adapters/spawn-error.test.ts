import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../../internal/adapters/claude/index.js";
import { CodexAdapter } from "../../internal/adapters/codex/index.js";
import type { AdapterEvent, AgentInput, Adapter } from "../../internal/adapters/adapter.js";
import type { Message } from "../../internal/events/types.js";

const buildCliInput = (requestId: string): AgentInput => ({
  roomId: "room_spawn_error",
  sessionId: "sess_spawn_error",
  requestId,
  messages: [
    {
      id: "msg_user",
      roomId: "room_spawn_error",
      author: "user",
      role: "user",
      text: "Run in CLI mode and fail fast on missing binary.",
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    } satisfies Message,
  ],
  config: {
    mode: "cli",
    timeoutMs: 1_000,
    maxTokens: 500,
  },
});

const collectEvents = async (
  adapter: Adapter,
  requestId: string,
): Promise<AdapterEvent[]> => {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.send(buildCliInput(requestId))) {
    events.push(event);
  }
  return events;
};

test("one-shot adapters emit message.error when CLI binary cannot spawn", { concurrency: false }, async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/__agoryx_missing_path__";
  try {
    const codexEvents = await collectEvents(new CodexAdapter(), "req_codex_spawn_missing");
    assert.equal(codexEvents[0]?.type, "message.started");
    assert.ok(
      codexEvents.some((event) => event.type === "message.error"),
      "codex should emit message.error when spawn fails",
    );

    const claudeEvents = await collectEvents(new ClaudeAdapter(), "req_claude_spawn_missing");
    assert.equal(claudeEvents[0]?.type, "message.started");
    assert.ok(
      claudeEvents.some((event) => event.type === "message.error"),
      "claude should emit message.error when spawn fails",
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});
