import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snipMessages, type SnipResult } from "../../internal/session/snipping.js";
import type { Message } from "../../internal/events/types.js";

function msg(
  author: string,
  text: string,
  role: "user" | "assistant" | "system" = "assistant",
): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    roomId: "room-1",
    author,
    role,
    text,
    format: "plain",
    metadata: {},
    createdAt: new Date().toISOString(),
  };
}

describe("snipMessages", () => {
  it("messages within recent window are not snipped", () => {
    const messages = [
      msg("agent.claude", "hello"),
      msg("user", "hi there"),
      msg("agent.codex", "greetings"),
    ];
    const result = snipMessages(messages, { recentWindow: 5 });

    assert.equal(result.snippedCount, 0);
    assert.equal(result.estimatedTokensSaved, 0);
    assert.equal(result.messages.length, 3);
    // Text should be unchanged
    assert.equal(result.messages[0].text, "hello");
    assert.equal(result.messages[1].text, "hi there");
    assert.equal(result.messages[2].text, "greetings");
  });

  it("messages outside window are snipped with preview", () => {
    const messages = [
      msg("agent.claude", "This is an old message that should be snipped"),
      msg("user", "Another old message"),
      msg("agent.codex", "This is a recent message"),
    ];
    const result = snipMessages(messages, {
      recentWindow: 1,
      collapseConsecutive: false,
    });

    assert.equal(result.snippedCount, 2);
    assert.ok(result.messages[0].text.startsWith("[snipped] "));
    assert.ok(result.messages[1].text.startsWith("[snipped] "));
    // Recent message is intact
    assert.equal(result.messages[2].text, "This is a recent message");
  });

  it("system messages are never snipped", () => {
    const messages = [
      msg("system", "You are a helpful assistant", "system"),
      msg("agent.claude", "Old assistant message"),
      msg("user", "Old user message"),
      msg("agent.codex", "Recent message"),
    ];
    const result = snipMessages(messages, {
      recentWindow: 1,
      collapseConsecutive: false,
    });

    // System message stays intact even though it's outside the window
    assert.equal(result.messages[0].text, "You are a helpful assistant");
    assert.equal(result.messages[0].role, "system");
    // The two non-system messages outside window are snipped
    assert.ok(result.messages[1].text.startsWith("[snipped] "));
    assert.ok(result.messages[2].text.startsWith("[snipped] "));
    // Recent message intact
    assert.equal(result.messages[3].text, "Recent message");
    assert.equal(result.snippedCount, 2);
  });

  it("consecutive same-author snips are collapsed", () => {
    const messages = [
      msg("agent.claude", "First message from claude"),
      msg("agent.claude", "Second message from claude"),
      msg("agent.claude", "Third message from claude"),
      msg("user", "Recent user message"),
    ];
    const result = snipMessages(messages, { recentWindow: 1 });

    // Three consecutive claude messages collapsed into one marker
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].text, "[3 messages snipped from agent.claude]");
    assert.equal(result.messages[1].text, "Recent user message");
    assert.equal(result.snippedCount, 3);
  });

  it("mixed authors are not collapsed", () => {
    const messages = [
      msg("agent.claude", "Claude message"),
      msg("agent.codex", "Codex message"),
      msg("agent.claude", "Another claude message"),
      msg("user", "Recent message"),
    ];
    const result = snipMessages(messages, { recentWindow: 1 });

    // Each snipped message from different author stays separate
    assert.equal(result.messages.length, 4);
    assert.ok(result.messages[0].text.startsWith("[snipped] "));
    assert.ok(result.messages[1].text.startsWith("[snipped] "));
    assert.ok(result.messages[2].text.startsWith("[snipped] "));
    assert.equal(result.messages[3].text, "Recent message");
  });

  it("snippedCount is accurate", () => {
    const messages = [
      msg("agent.claude", "msg 1"),
      msg("agent.codex", "msg 2"),
      msg("user", "msg 3"),
      msg("agent.claude", "msg 4"),
      msg("user", "msg 5"),
    ];
    const result = snipMessages(messages, { recentWindow: 2 });

    // 3 messages outside the window, all non-system
    assert.equal(result.snippedCount, 3);
  });

  it("estimatedTokensSaved is positive when snipping occurs", () => {
    const longText = "A".repeat(500);
    const messages = [
      msg("agent.claude", longText),
      msg("agent.codex", longText),
      msg("user", "short recent"),
    ];
    const result = snipMessages(messages, { recentWindow: 1 });

    assert.ok(
      result.estimatedTokensSaved > 0,
      `Expected positive token savings, got ${result.estimatedTokensSaved}`,
    );
  });

  it("empty input returns empty result", () => {
    const result = snipMessages([]);

    assert.equal(result.messages.length, 0);
    assert.equal(result.snippedCount, 0);
    assert.equal(result.estimatedTokensSaved, 0);
  });

  it("custom recentWindow works", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg("agent.claude", `message ${i}`),
    );
    const result = snipMessages(messages, {
      recentWindow: 5,
      collapseConsecutive: false,
    });

    // First 5 are snipped, last 5 kept
    assert.equal(result.snippedCount, 5);
    for (let i = 0; i < 5; i++) {
      assert.ok(result.messages[i].text.startsWith("[snipped] "));
    }
    for (let i = 5; i < 10; i++) {
      assert.equal(result.messages[i].text, `message ${i}`);
    }
  });

  it("custom previewChars truncates preview text", () => {
    const messages = [
      msg("agent.claude", "This is a long message that exceeds the preview limit"),
      msg("user", "Recent"),
    ];
    const result = snipMessages(messages, {
      recentWindow: 1,
      previewChars: 10,
      collapseConsecutive: false,
    });

    assert.equal(result.messages[0].text, "[snipped] This is a ...");
  });

  it("collapseConsecutive: false keeps individual snipped messages", () => {
    const messages = [
      msg("agent.claude", "First"),
      msg("agent.claude", "Second"),
      msg("agent.claude", "Third"),
      msg("user", "Recent"),
    ];
    const result = snipMessages(messages, {
      recentWindow: 1,
      collapseConsecutive: false,
    });

    // All three individual snipped messages preserved
    assert.equal(result.messages.length, 4);
    assert.ok(result.messages[0].text.startsWith("[snipped] "));
    assert.ok(result.messages[1].text.startsWith("[snipped] "));
    assert.ok(result.messages[2].text.startsWith("[snipped] "));
    assert.equal(result.messages[3].text, "Recent");
  });

  it("messages are not mutated (returns new array)", () => {
    const original = [
      msg("agent.claude", "Old message to be snipped"),
      msg("user", "Recent message"),
    ];
    const originalTexts = original.map((m) => m.text);
    const originalRef = original;

    const result = snipMessages(original, { recentWindow: 1 });

    // Original array is not the same reference
    assert.notEqual(result.messages, originalRef);
    // Original messages are not mutated
    assert.equal(original[0].text, originalTexts[0]);
    assert.equal(original[1].text, originalTexts[1]);
    assert.equal(original.length, 2);
  });

  it("snipped preview does not add ellipsis for short text", () => {
    const messages = [
      msg("agent.claude", "Short"),
      msg("user", "Recent"),
    ];
    const result = snipMessages(messages, {
      recentWindow: 1,
      previewChars: 80,
      collapseConsecutive: false,
    });

    // Short text should not have "..." appended
    assert.equal(result.messages[0].text, "[snipped] Short");
  });

  it("collapse handles alternating snipped and non-snipped messages", () => {
    const messages = [
      msg("system", "System prompt", "system"),
      msg("agent.claude", "Old claude msg 1"),
      msg("agent.claude", "Old claude msg 2"),
      msg("system", "Pinned context", "system"),
      msg("agent.codex", "Old codex msg"),
      msg("user", "Recent message"),
    ];
    const result = snipMessages(messages, { recentWindow: 1 });

    // System messages break collapse runs
    // msg[0]: system (kept)
    // msg[1-2]: 2 claude snips collapsed
    // msg[3]: system (kept)
    // msg[4]: codex snip (single)
    // msg[5]: recent (kept)
    assert.equal(result.messages[0].text, "System prompt");
    assert.equal(result.messages[1].text, "[2 messages snipped from agent.claude]");
    assert.equal(result.messages[2].text, "Pinned context");
    assert.ok(result.messages[3].text.startsWith("[snipped] "));
    assert.equal(result.messages[4].text, "Recent message");
    assert.equal(result.snippedCount, 3);
  });
});
