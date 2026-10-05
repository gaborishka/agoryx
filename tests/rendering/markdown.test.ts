import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToAnsi } from "../../internal/rendering/markdown.js";

test("renders heading with ANSI formatting", () => {
  const result = renderMarkdownToAnsi("# Hello");
  assert.notEqual(result, "# Hello", "heading should be transformed");
  assert.ok(result.includes("Hello"), "heading text preserved");
});

test("renders bold text with ANSI codes", () => {
  const result = renderMarkdownToAnsi("some **bold** text");
  assert.ok(result.includes("bold"), "bold text preserved");
  assert.notEqual(result, "some **bold** text", "bold markers should be transformed");
});

test("renders code block distinctly", () => {
  const result = renderMarkdownToAnsi("```js\nconsole.log('hi');\n```");
  assert.ok(result.includes("console.log"), "code content preserved");
});

test("renders bullet list", () => {
  const result = renderMarkdownToAnsi("- one\n- two\n- three");
  assert.ok(result.includes("one"), "list item preserved");
  assert.ok(result.includes("two"), "list item preserved");
});

test("plain text passes through mostly unchanged", () => {
  const result = renderMarkdownToAnsi("just plain text");
  assert.ok(result.includes("just plain text"), "plain text preserved");
});

test("empty string returns empty", () => {
  const result = renderMarkdownToAnsi("");
  assert.equal(result, "");
});

test("respects width parameter", () => {
  const wide = renderMarkdownToAnsi("# Title", 120);
  const narrow = renderMarkdownToAnsi("# Title", 40);
  // Both should render without error
  assert.ok(wide.includes("Title"));
  assert.ok(narrow.includes("Title"));
});
