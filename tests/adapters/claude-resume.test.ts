import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeInteractiveInput,
  buildClaudeInteractiveSpawnArgs,
  buildClaudeSpawnArgs,
  extractClaudeSessionId,
} from "../../internal/adapters/claude/index.js";

test("buildClaudeSpawnArgs cold: -p <prompt>", () => {
  const args = buildClaudeSpawnArgs("hello", null);
  assert.deepEqual(args, [
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]);
});

test("buildClaudeSpawnArgs resume: --resume <id> -p <prompt>", () => {
  const args = buildClaudeSpawnArgs("hello", "session_abc");
  assert.deepEqual(args, [
    "--resume",
    "session_abc",
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]);
});

test("buildClaudeInteractiveSpawnArgs cold: stream-json stdin/stdout mode", () => {
  const args = buildClaudeInteractiveSpawnArgs(null);
  assert.deepEqual(args, [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]);
});

test("buildClaudeInteractiveSpawnArgs resume: --resume prefix preserved", () => {
  const args = buildClaudeInteractiveSpawnArgs("session_abc");
  assert.deepEqual(args, [
    "--resume",
    "session_abc",
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]);
});

test("buildClaudeInteractiveInput builds user message envelope", () => {
  const payload = buildClaudeInteractiveInput("hello");
  assert.deepEqual(payload, {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "hello",
        },
      ],
    },
  });
});

test("extractClaudeSessionId extracts session_id from stream json", () => {
  const line = '{"type":"system","subtype":"init","session_id":"session_abc"}';
  assert.equal(extractClaudeSessionId(line), "session_abc");
});

test("extractClaudeSessionId extracts sessionId from stream json", () => {
  const line = '{"type":"assistant","sessionId":"session_xyz"}';
  assert.equal(extractClaudeSessionId(line), "session_xyz");
});

test("extractClaudeSessionId ignores hook system events", () => {
  const line = '{"type":"system","subtype":"hook_started","session_id":"hook_sid"}';
  assert.equal(extractClaudeSessionId(line), null);
});

test("extractClaudeSessionId extracts top-level id from stream_event", () => {
  const line = '{"type":"stream_event","session_id":"session_stream"}';
  assert.equal(extractClaudeSessionId(line), "session_stream");
});

test("extractClaudeSessionId returns null for non-json", () => {
  assert.equal(extractClaudeSessionId("not json"), null);
});
