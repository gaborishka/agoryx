import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClaudeDeltaPart,
  parseClaudeChunk,
  resolveClaudeFinalText,
} from "../../internal/adapters/claude/index.js";

test("claude stream parser keeps assistant delta text and captures final result", () => {
  const chunk = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}',
    '{"type":"result","result":"hello world"}',
  ].join("\n");

  const parsed = parseClaudeChunk(chunk);
  assert.deepEqual(parsed.deltaParts, [{ text: "hello world", source: "assistant" }]);
  assert.equal(parsed.resultText, "hello world");
});

test("claude stream parser supports result-only payload", () => {
  const parsed = parseClaudeChunk('{"type":"result","result":{"content":[{"text":"final"}]}}');
  assert.deepEqual(parsed.deltaParts, []);
  assert.equal(parsed.resultText, "final");
});

test("claude stream parser ignores non-json diagnostic lines", () => {
  const parsed = parseClaudeChunk("plain output line");
  assert.deepEqual(parsed.deltaParts, []);
  assert.equal(parsed.resultText, null);
});

test("normalizeClaudeDeltaPart emits only incremental suffix for assistant snapshots", () => {
  const state = { sawStreamEventDelta: false, previousAssistantChunk: null as string | null };
  const deltas = [
    normalizeClaudeDeltaPart({ text: "Прив", source: "assistant" }, state),
    normalizeClaudeDeltaPart({ text: "Привіт", source: "assistant" }, state),
    normalizeClaudeDeltaPart({ text: "Привіт!", source: "assistant" }, state),
    normalizeClaudeDeltaPart({ text: "Привіт!", source: "assistant" }, state),
  ].filter((item) => item.length > 0);

  assert.deepEqual(deltas, ["Прив", "іт", "!"]);
});

test("normalizeClaudeDeltaPart keeps independent chunks intact", () => {
  const state = { sawStreamEventDelta: false, previousAssistantChunk: null as string | null };
  const deltas = [
    normalizeClaudeDeltaPart({ text: "Hello ", source: "generic" }, state),
    normalizeClaudeDeltaPart({ text: "world", source: "generic" }, state),
  ];

  assert.deepEqual(deltas, ["Hello ", "world"]);
});

test("normalizeClaudeDeltaPart ignores assistant snapshot after stream delta", () => {
  const state = { sawStreamEventDelta: false, previousAssistantChunk: null as string | null };
  const deltas = [
    normalizeClaudeDeltaPart({ text: "Привіт", source: "stream_event" }, state),
    normalizeClaudeDeltaPart({ text: "Привіт", source: "assistant" }, state),
  ].filter((item) => item.length > 0);

  assert.deepEqual(deltas, ["Привіт"]);
});

test("resolveClaudeFinalText prefers canonical result text over streamed output", () => {
  const text = resolveClaudeFinalText("partial streamed", "final canonical");
  assert.equal(text, "final canonical");
});

test("resolveClaudeFinalText falls back to streamed output when result is missing", () => {
  const text = resolveClaudeFinalText("streamed only", null);
  assert.equal(text, "streamed only");
});
