import test from "node:test";
import assert from "node:assert/strict";
import {
  messageCompleted,
  messageDelta,
  messageError,
  messageStarted,
} from "../../internal/adapters/event-factory.js";

const base = {
  roomId: "room_test",
  sessionId: "sess_test",
  requestId: "req_test",
  source: "adapter.test",
};

const payload = {
  messageId: "msg_test",
  author: "agent.test",
  role: "assistant" as const,
  text: "hello",
  format: "markdown" as const,
};

test("event factory creates expected message event envelope", () => {
  const started = messageStarted(base, payload);
  const delta = messageDelta(base, payload);
  const completed = messageCompleted(base, payload);

  assert.equal(started.type, "message.started");
  assert.equal(delta.type, "message.delta");
  assert.equal(completed.type, "message.completed");

  assert.equal(started.roomId, base.roomId);
  assert.equal(started.sessionId, base.sessionId);
  assert.equal(started.requestId, base.requestId);
  assert.equal(started.source, base.source);
  assert.match(started.eventId, /^evt_/);
});

test("event factory creates typed message error payload", () => {
  const event = messageError(base, "PROTOCOL_ERROR", "invalid line", "raw text");
  assert.equal(event.type, "message.error");

  const errorPayload = event.payload as {
    class: string;
    message: string;
    raw?: string;
  };
  assert.equal(errorPayload.class, "PROTOCOL_ERROR");
  assert.equal(errorPayload.message, "invalid line");
  assert.equal(errorPayload.raw, "raw text");
});
