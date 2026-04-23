import test from "node:test";
import assert from "node:assert/strict";
import { FreePolicy } from "../../internal/orchestrator/free.js";
import type { Message, Room } from "../../internal/events/types.js";
import type { OrchestrationContext } from "../../internal/orchestrator/policy.js";

const room: Room = {
  id: "room_free",
  name: "free-room",
  participants: ["user", "agent.codex", "agent.claude"],
  config: {
    mode: "free",
    checkpointThreshold: 50,
    maxHistoryMessages: 100,
    maxContextTokens: 30_000,
  },
  createdAt: new Date().toISOString(),
};

const context: OrchestrationContext = {
  availableAgents: ["codex", "claude"],
};

const message = (text: string, author = "user"): Message => ({
  id: "msg_1",
  roomId: room.id,
  author,
  role: author === "user" ? "user" : "assistant",
  text,
  format: "plain",
  metadata: {},
  createdAt: new Date().toISOString(),
});

test("free policy routes user messages to all available agents", () => {
  const policy = new FreePolicy();
  const dispatches = policy.onUserMessage(room, message("hello everyone"), context);

  assert.equal(dispatches.length, 2);
  const targets = dispatches.map((dispatch) => dispatch.targetAdapter);
  assert.ok(targets.includes("codex"));
  assert.ok(targets.includes("claude"));
});

test("free policy prioritizes mentioned agents first on user message", () => {
  const policy = new FreePolicy();
  const dispatches = policy.onUserMessage(room, message("@codex take the lead"), context);

  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0]?.targetAdapter, "codex");
  assert.ok(dispatches.map((dispatch) => dispatch.targetAdapter).includes("claude"));
});

test("free policy excludes author from agent-triggered dispatches", () => {
  const policy = new FreePolicy();
  policy.onUserMessage(room, message("kick off"), context); // reset guard

  const dispatches = policy.onAgentMessage(
    room,
    message("@claude! please review", "agent.codex"),
    context,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]?.targetAdapter, "claude");
  assert.equal(dispatches[0]?.reason, "free:agent:handoff:claude");
});

test("free policy handles @all! for agent message without self-dispatch", () => {
  const policy = new FreePolicy();
  policy.onUserMessage(room, message("kick off"), context); // reset guard

  const dispatches = policy.onAgentMessage(
    room,
    message("@all! what do you think?", "agent.claude"),
    context,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]?.targetAdapter, "codex");
});

test("free policy ends chain when agent message has no mentions", () => {
  const policy = new FreePolicy();
  policy.onUserMessage(room, message("start"), context);

  const dispatches = policy.onAgentMessage(
    room,
    message("I think this is enough", "agent.codex"),
    context,
  );
  assert.equal(dispatches.length, 0);
});

test("free policy does not treat plain @mention as handoff without exclamation", () => {
  const policy = new FreePolicy();
  policy.onUserMessage(room, message("start"), context);

  const dispatches = policy.onAgentMessage(
    room,
    message("@claude maybe add more", "agent.codex"),
    context,
  );
  assert.equal(dispatches.length, 0);
});

test("free policy autonomy guard caps chained agent turns", () => {
  const policy = new FreePolicy();
  policy.onUserMessage(room, message("start"), context);

  for (let i = 0; i < 6; i++) {
    const dispatches = policy.onAgentMessage(
      room,
      message("@claude! follow-up", "agent.codex"),
      context,
    );
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]?.targetAdapter, "claude");
  }

  const blocked = policy.onAgentMessage(
    room,
    message("@claude! one more", "agent.codex"),
    context,
  );
  assert.equal(blocked.length, 0);
});

test("free policy marks rebuttal handoff reason for @agent!!", () => {
  const policy = new FreePolicy();
  policy.onUserMessage(room, message("start"), context);

  const dispatches = policy.onAgentMessage(
    room,
    message("@claude!! counterpoint", "agent.codex"),
    context,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]?.targetAdapter, "claude");
  assert.equal(dispatches[0]?.reason, "free:agent:rebuttal:claude");
});
