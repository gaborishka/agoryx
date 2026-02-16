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
