import test from "node:test";
import assert from "node:assert/strict";
import { ManualPolicy } from "../../internal/orchestrator/manual.js";
import { RoundRobinPolicy } from "../../internal/orchestrator/round-robin.js";
import type { Message, Room } from "../../internal/events/types.js";

const room: Room = {
  id: "room_1",
  name: "test",
  participants: ["user", "agent.codex", "agent.claude"],
  config: {
    mode: "manual",
    checkpointThreshold: 50,
    maxHistoryMessages: 200,
    maxContextTokens: 30_000,
  },
  createdAt: new Date().toISOString(),
};

const message = (text: string): Message => ({
  id: "msg_1",
  roomId: room.id,
  author: "user",
  role: "user",
  text,
  format: "plain",
  metadata: {},
  createdAt: new Date().toISOString(),
});

test("manual policy routes to mentioned adapter", () => {
  const policy = new ManualPolicy();
  const dispatches = policy.onUserMessage(room, message("@codex hello"), {
    availableAgents: ["codex", "claude"],
  });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]?.targetAdapter, "codex");
});

test("round-robin alternates between adapters", () => {
  const policy = new RoundRobinPolicy();
  const first = policy.onUserMessage(room, message("first"), {
    availableAgents: ["codex", "claude"],
  });
  const second = policy.onUserMessage(room, message("second"), {
    availableAgents: ["codex", "claude"],
  });

  assert.equal(first[0]?.targetAdapter, "codex");
  assert.equal(second[0]?.targetAdapter, "claude");
});
