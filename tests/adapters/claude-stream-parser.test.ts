import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeChunk } from "../../internal/adapters/claude/index.js";

test("claude stream parser keeps assistant delta text and captures final result", () => {
  const chunk = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}',
    '{"type":"result","result":"hello world"}',
  ].join("\n");

  const parsed = parseClaudeChunk(chunk);
  assert.equal(parsed.deltaText, "hello world");
  assert.equal(parsed.resultText, "hello world");
});

test("claude stream parser supports result-only payload", () => {
  const parsed = parseClaudeChunk('{"type":"result","result":{"content":[{"text":"final"}]}}');
  assert.equal(parsed.deltaText, "");
  assert.equal(parsed.resultText, "final");
});

test("claude stream parser preserves non-json lines as deltas", () => {
  const parsed = parseClaudeChunk("plain output line");
  assert.equal(parsed.deltaText, "plain output line");
  assert.equal(parsed.resultText, null);
});
