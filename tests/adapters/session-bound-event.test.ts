import test from "node:test";
import assert from "node:assert/strict";
import { sessionBound } from "../../internal/adapters/event-factory.js";

test("sessionBound creates event with session.bound type and nativeSessionId", () => {
  const event = sessionBound(
    {
      roomId: "room_1",
      sessionId: "sess_1",
      requestId: "req_1",
      source: "adapter.codex",
    },
    "thread_abc-123",
  );

  assert.equal(event.type, "session.bound");
  assert.equal(event.roomId, "room_1");
  assert.ok(event.eventId.startsWith("evt_"));

  const payload = event.payload as { nativeSessionId: string };
  assert.equal(payload.nativeSessionId, "thread_abc-123");
});
