import test from "node:test";
import assert from "node:assert/strict";
import { extractTextFromJsonLine } from "../../internal/adapters/parse-output.js";

test("parser returns plain text lines unchanged", () => {
  const result = extractTextFromJsonLine("hello world");
  assert.equal(result, "hello world");
});

test("parser extracts delta field from json", () => {
  const result = extractTextFromJsonLine('{"delta":"chunk-1"}');
  assert.equal(result, "chunk-1");
});

test("parser extracts nested content arrays", () => {
  const result = extractTextFromJsonLine(
    '{"content":[{"text":"hello "},{"value":"world"}]}',
  );
  assert.equal(result, "hello world");
});

test("parser extracts codex item.text payloads", () => {
  const result = extractTextFromJsonLine(
    '{"type":"item.completed","item":{"text":"codex payload"}}',
  );
  assert.equal(result, "codex payload");
});

test("parser extracts claude message.content text payloads", () => {
  const result = extractTextFromJsonLine(
    '{"message":{"content":[{"type":"text","text":"hello "},{"type":"text","text":"claude"}]}}',
  );
  assert.equal(result, "hello claude");
});

test("parser extracts claude result field", () => {
  const result = extractTextFromJsonLine(
    '{"type":"result","result":"final response"}',
  );
  assert.equal(result, "final response");
});

test("parser ignores codex reasoning items", () => {
  const result = extractTextFromJsonLine(
    '{"type":"item.completed","item":{"type":"reasoning","text":"internal thinking"}}',
  );
  assert.equal(result, null);
});

test("parser skips reasoning blocks but keeps regular text blocks", () => {
  const result = extractTextFromJsonLine(
    '{"message":{"content":[{"type":"reasoning","text":"hidden"},{"type":"text","text":"visible"}]}}',
  );
  assert.equal(result, "visible");
});

test("parser returns null for empty/unsupported json payload", () => {
  const empty = extractTextFromJsonLine("   ");
  const unsupported = extractTextFromJsonLine('{"foo":"bar"}');
  assert.equal(empty, null);
  assert.equal(unsupported, null);
});

test("parser falls back to raw line when json is malformed", () => {
  const malformed = extractTextFromJsonLine('{"delta":"unterminated"');
  assert.equal(malformed, '{"delta":"unterminated"');
});
