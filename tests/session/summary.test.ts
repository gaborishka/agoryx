import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTopics,
  extractDecisions,
  buildBudgetTail,
  buildStructuredSummary,
} from "../../internal/session/service.js";
import type { Message } from "../../internal/events/types.js";

function msg(author: string, text: string, id = "msg_x"): Message {
  return {
    id, roomId: "room_1", author, role: author === "user" ? "user" : "assistant",
    text, format: "plain", metadata: {}, createdAt: "2026-02-17T12:00:00Z",
  };
}

test("extractTopics returns top-5 keywords by frequency", () => {
  const msgs = [
    msg("user", "explain the context builder algorithm"),
    msg("codex", "the context builder uses token budgeting"),
    msg("user", "what about the checkpoint algorithm"),
    msg("claude", "checkpoint creates a summary of context"),
  ];
  const topics = extractTopics(msgs);

  assert.ok(topics.length <= 5);
  assert.ok(topics.length > 0);
  assert.ok(topics.includes("context"), "context should be a top topic");
});

test("extractTopics filters stop words and short words", () => {
  const msgs = [
    msg("user", "the and or but is are was with for this that from"),
  ];
  const topics = extractTopics(msgs);
  assert.equal(topics.length, 0, "stop words should be filtered");
});

test("extractDecisions finds EN patterns", () => {
  const msgs = [
    msg("user", "let's use SQLite for storage"),
    msg("codex", "agreed, we'll use TypeScript as well"),
  ];
  const decisions = extractDecisions(msgs);

  assert.ok(decisions.length >= 1);
  assert.ok(decisions.some(d => d.toLowerCase().includes("sqlite")));
});

test("extractDecisions finds UA patterns", () => {
  const msgs = [
    msg("user", "використовуємо SQLite для зберігання"),
    msg("claude", "вирішили що auto mode = smart routing"),
  ];
  const decisions = extractDecisions(msgs);

  assert.ok(decisions.length >= 1);
  assert.ok(decisions.some(d => d.toLowerCase().includes("sqlite")));
});

test("extractDecisions returns empty array when no patterns match", () => {
  const msgs = [
    msg("user", "hello world"),
    msg("codex", "hi there"),
  ];
  const decisions = extractDecisions(msgs);
  assert.deepEqual(decisions, []);
});

test("buildBudgetTail fits within char budget", () => {
  const msgs = Array.from({ length: 20 }, (_, i) =>
    msg("user", `message number ${i} with some extra text padding here`, `msg_${i}`)
  );
  const tail = buildBudgetTail(msgs, 200);

  const totalChars = tail.reduce((sum, line) => sum + line.length, 0);
  assert.ok(totalChars <= 200, `tail should be <= 200 chars, got ${totalChars}`);
  assert.ok(tail.length > 0, "tail should have at least one message");
});

test("buildBudgetTail joined output fits within char budget (including newlines)", () => {
  // Each line = "user: " + 14 chars = 20 chars exactly. 10 lines = 200 chars.
  // Without newline accounting: all 10 fit (200 <= 200).
  // Joined: 200 + 9 newlines = 209 > 200. Bug!
  const msgs = Array.from({ length: 10 }, (_, i) =>
    msg("user", `x`.repeat(14), `msg_${i}`)
  );
  const tail = buildBudgetTail(msgs, 200);
  const joined = tail.join("\n");

  assert.ok(joined.length <= 200,
    `joined tail should be <= 200 chars including newlines, got ${joined.length}`);
});

test("buildBudgetTail does not truncate messages mid-text", () => {
  const msgs = [
    msg("user", "short"),
    msg("codex", "a longer message that should not be cut in half"),
  ];
  const tail = buildBudgetTail(msgs, 2000);

  for (const line of tail) {
    // Each line should be a complete "author: text" format
    assert.ok(line.includes(": "), "each tail line should have author prefix");
    assert.ok(!line.endsWith("..."), "messages should not be truncated");
  }
});

test("buildStructuredSummary produces header + tail", () => {
  const msgs = [
    msg("user", "explain context builder"),
    msg("codex", "context builder uses token budgeting and checkpoints"),
    msg("claude", "I reviewed the context algorithm"),
    msg("user", "let's use SQLite"),
  ];
  const summary = buildStructuredSummary(msgs);

  assert.ok(summary.includes("[Checkpoint]"), "should have header marker");
  assert.ok(summary.includes("4 messages"), "should show message count");
  assert.ok(summary.includes("user:"), "should list participants");
  assert.ok(summary.includes("Topics:"), "should have topics section");
  assert.ok(summary.includes("---"), "should have separator before tail");
});

test("buildStructuredSummary includes previous summary trimmed", () => {
  const msgs = [
    msg("user", "new message after checkpoint"),
    msg("codex", "responding to new message"),
  ];
  const prevSummary = "Previous context about SQLite and auto mode";
  const summary = buildStructuredSummary(msgs, prevSummary);

  assert.ok(summary.includes("[Prior summary]"), "should include prior summary section");
  assert.ok(summary.includes("SQLite"), "prior summary content preserved");
});

test("buildStructuredSummary trims previous summary to ~1000 chars from END (freshest)", () => {
  const msgs = [msg("user", "new message")];
  const longPrev = "OLD_CONTENT_" + "X".repeat(1500) + "_FRESH_CONTENT";
  const summary = buildStructuredSummary(msgs, longPrev);

  // The prior summary section should be trimmed from end (keeping fresh)
  const priorSection = summary.split("[Prior summary]")[1]?.split("---")[0] ?? "";
  assert.ok(priorSection.length <= 1100,
    `prior summary section should be ~1000 chars, got ${priorSection.length}`);
  assert.ok(priorSection.includes("FRESH_CONTENT"),
    "trim should keep the tail (freshest content), not the head");
  assert.ok(!priorSection.includes("OLD_CONTENT"),
    "trim should discard the head (oldest content)");
});

test("buildStructuredSummary does not nest [Prior summary] wrappers (INV-3)", () => {
  // Simulate 3rd checkpoint: previous summary already contains [Prior summary]
  const prevWithNested = "[Prior summary]\nold context\n---\n[New: 5 messages]\nstuff";
  const msgs = [msg("user", "third round message")];
  const summary = buildStructuredSummary(msgs, prevWithNested);

  // Count occurrences of [Prior summary]
  const count = (summary.match(/\[Prior summary\]/g) || []).length;
  assert.equal(count, 1, "should have exactly one [Prior summary] section, not nested");
});
