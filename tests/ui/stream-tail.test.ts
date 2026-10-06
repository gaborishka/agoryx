import test from "node:test";
import assert from "node:assert/strict";
import { streamTail } from "../../ui/src/lib/stream-tail.js";

test("a short reply streams whole", () => {
  assert.equal(streamTail("hello", 2400), "hello");
  assert.equal(streamTail("x".repeat(3000), 2400), "x".repeat(3000), "under one step past the limit: still whole");
});

test("a long reply's tail starts at a paragraph and holds still while tokens arrive", () => {
  const paragraph = `${"word ".repeat(40).trim()}\n\n`;
  let text = paragraph.repeat(30);
  const first = streamTail(text, 2400);
  assert.ok(first.startsWith("…\n\n"), "begins at a paragraph");
  assert.ok(first.length - 3 >= 1200, "keeps enough to read");
  const start = first.slice(3, 60);
  for (let i = 0; i < 100; i += 1) {
    text += "more ";
    const next = streamTail(text, 2400);
    assert.ok(next.slice(3).startsWith(start), `token ${i}: the window's start stayed`);
  }
});

test("a reply with no paragraph breaks still keeps a steady tail", () => {
  const text = "a".repeat(5000);
  const tail = streamTail(text, 2400);
  assert.ok(tail.startsWith("…a"));
  assert.ok(tail.length - 1 >= 2400);
  assert.equal(streamTail(`${text}bbb`, 2400).slice(0, 50), tail.slice(0, 50));
});
