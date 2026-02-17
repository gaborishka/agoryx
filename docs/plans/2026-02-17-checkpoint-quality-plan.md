# Checkpoint Quality — Design & Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-02-17 | **Author:** Claude | **Approved by:** Ivan

**Goal:** Replace naive transcript-clip checkpoints with structured cumulative summaries, fix token counting bug, optimize context builder queries, and add checkpoint dedup/threshold guards.

**Architecture:** Changes span 3 files: `context.ts` (token fix + query optimization), `service.ts` (summary algorithm + thresholds), `chat.ts` (force parameter). All helpers stay in `service.ts` — no new files. Tests use `node:test` + `assert/strict` with in-memory SQLite.

**Tech Stack:** TypeScript, node:test, better-sqlite3 (in-memory for tests)

## Problem

The current `maybeCreateCheckpoint()` in `internal/session/service.ts` produces low-quality summaries:
- Raw transcript of last 12 messages clipped to 180 chars each
- No dedup guard: repeated `/summary` creates overlapping checkpoints
- No auto-checkpoint throttle: `chat.ts:145` calls `maybeCreateCheckpoint()` after every user message
- Token double-count bug in `context.ts:168`: system prompt counted twice in `totalEstimatedTokens`
- Context builder loads up to 10k messages instead of using targeted query

## Solution: Hybrid Structured Summary

```
[Prior summary]
{previous checkpoint text, trimmed ~1000 chars from END}
---
[Checkpoint] 15 messages (user: 8, codex: 4, claude: 3)
Topics: context builder, auto mode, SQLite
Decisions: використовуємо SQLite; auto mode = smart routing
---
user: @claude explain the context builder algorithm
claude: Context builder takes pinned context, checkpoint summary...
```

Components: header (count per author) + topics (top-5 by word frequency) + decisions (regex EN+UA) + budget-based tail (~2000 chars, no mid-message truncation). Previous summary prepended cumulatively.

## Invariants

- **INV-1:** Checkpoint range is cumulative — `fromMessageId` preserved from previous coverage, `toMessageId` = last message
- **INV-2:** Auto threshold = `checkpointThreshold` uncovered msgs; force (`/summary`) threshold = 2 uncovered msgs
- **INV-3:** No nested `[Prior summary]` wrappers — strip existing prefix before re-wrapping
- **INV-4:** `totalEstimatedTokens` computed solely from `result` array (no separate systemPrompt addition)
- **INV-5:** With coverage: uncovered count uses `listMessagesAfter` (no window dependency). Without coverage (first checkpoint): `listMessages(10_000)` — sufficient for v0.1 rooms. Context builder threshold check uses `max(maxHistoryMessages, checkpointThreshold + 1)` as limit

## Files Changed

| File | Changes |
|------|---------|
| `internal/session/service.ts` | `maybeCreateCheckpoint(room, force?)`, summary helpers (extractTopics, extractDecisions, buildBudgetTail, buildStructuredSummary) |
| `internal/session/context.ts` | Token fix, `listMessagesAfter`, `Math.max` for threshold check |
| `internal/engine/chat.ts` | `checkpointNow()` passes `force: true` |
| `tests/session/context.test.ts` | Token fix, listMessagesAfter, INV-5, long dialogue, pinned+summary, budget |
| `tests/session/summary.test.ts` | Helper unit tests (topics, decisions, tail, structured summary, INV-3) |
| `tests/session/checkpoint.test.ts` | Dedup, thresholds, cumulative, INV-1, INV-5 |

## Out of Scope

- LLM-based summarization (no API keys in v0.1)
- Topic clustering / NLP
- Configurable summary format
- Multiple checkpoint history (context builder uses latest only)

---

## Implementation Tasks

### Task 1: Fix token double-count bug in context builder

**Files:**
- Modify: `internal/session/context.ts:167-180`
- Test: `tests/session/context.test.ts` (create)

**Step 1: Write the failing test**

Create `tests/session/context.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../../internal/session/context.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

function createTestStore(): SQLiteStore {
  const store = new SQLiteStore(":memory:");
  store.init();
  return store;
}

function saveMsg(store: SQLiteStore, roomId: string, id: string, text: string, author = "user", role: "user" | "assistant" = "user") {
  store.saveMessage({
    id, roomId, author, role, text,
    format: "plain", metadata: {}, createdAt: new Date().toISOString(),
  });
}

test("totalEstimatedTokens does not double-count systemPrompt (INV-4)", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user"], {
    mode: "manual", checkpointThreshold: 50,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });
  saveMsg(store, room.id, "msg_1", "hello");

  const systemPrompt = "A".repeat(400); // 400 chars = ~100 tokens
  const ctx = buildContext(store, {
    roomId: room.id, systemPrompt,
    maxHistoryMessages: 100, checkpointThreshold: 50,
    maxContextTokens: 100_000,
  });

  // System prompt is in result as first message
  assert.equal(ctx.messages[0].role, "system");
  assert.ok(ctx.messages[0].text.includes(systemPrompt));

  // Total tokens should equal sum of all messages in result, NOT double system prompt
  let expected = 0;
  for (const msg of ctx.messages) {
    expected += Math.ceil(msg.text.length / 4);
  }
  assert.equal(ctx.totalEstimatedTokens, expected,
    "totalEstimatedTokens should match sum of result messages only");
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/session/context.test.ts`
Expected: FAIL — `totalEstimatedTokens` will be ~200 instead of ~100+small because system prompt is counted twice.

**Step 3: Write minimal fix**

In `internal/session/context.ts`, replace lines 167-180 (the `totalEstimatedTokens` calculation) with:

```typescript
  // Calculate total tokens from result messages only (system prompt already in result)
  let totalEstimatedTokens = 0;
  for (const msg of result) {
    totalEstimatedTokens += estimateTokens(msg.text);
  }

  return {
    messages: result,
    systemPrompt: systemPrompt ?? null,
    truncated,
    totalEstimatedTokens,
  };
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/session/context.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm run typecheck && npm test`
Expected: All existing tests pass + new test passes.

**Step 6: Commit**

```bash
git add internal/session/context.ts tests/session/context.test.ts
git commit -m "fix: token double-count in context builder (INV-4)"
```

---

### Task 2: Use listMessagesAfter in context builder

**Files:**
- Modify: `internal/session/context.ts:54-77`
- Test: `tests/session/context.test.ts` (append)

**Step 1: Write the failing test**

Append to `tests/session/context.test.ts`:

```typescript
test("buildContext uses checkpoint to load only post-checkpoint messages", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual", checkpointThreshold: 3,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });

  // Create 5 messages
  for (let i = 1; i <= 5; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }

  // Create checkpoint covering msg_1 through msg_3
  store.saveCheckpoint(room.id, "Summary of first 3 messages", "msg_1", "msg_3");

  const ctx = buildContext(store, {
    roomId: room.id,
    maxHistoryMessages: 100,
    checkpointThreshold: 3, // triggers checkpoint path
    maxContextTokens: 100_000,
  });

  // Should contain: checkpoint summary + msg_4, msg_5 (post-checkpoint)
  const userMsgs = ctx.messages.filter(m => m.role === "user");
  assert.equal(userMsgs.length, 2, "should only include post-checkpoint messages");
  assert.equal(userMsgs[0].id, "msg_4");
  assert.equal(userMsgs[1].id, "msg_5");

  // Checkpoint summary should be present
  const summaryMsg = ctx.messages.find(m => m.text.includes("Summary of first 3 messages"));
  assert.ok(summaryMsg, "checkpoint summary should be in context");
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/session/context.test.ts`
Expected: May pass already (current code does the same via findIndex), but this confirms the behavior is preserved.

**Step 3: Refactor to use listMessagesAfter**

In `internal/session/context.ts`, replace the message loading block (lines 54-79) with:

```typescript
  let messages: Message[];
  let checkpointSummary: string | null = null;

  // Use max of both limits for threshold check (INV-5: avoid false negatives
  // when checkpointThreshold > maxHistoryMessages)
  const countLimit = Math.max(maxHistoryMessages, checkpointThreshold + 1);
  const allMessages = store.listMessages(roomId, countLimit);
  const messageCount = allMessages.length;

  if (messageCount > checkpointThreshold) {
    const checkpoint = store.getLatestCheckpoint(roomId);
    if (checkpoint) {
      checkpointSummary = checkpoint.summaryText;
      // Use targeted query: only messages after checkpoint (no window dependency)
      const afterCheckpoint = store.listMessagesAfter(roomId, checkpoint.toMessageId);
      messages = afterCheckpoint.length > 0
        ? afterCheckpoint
        : allMessages.slice(-maxHistoryMessages);
    } else {
      messages = allMessages.slice(-maxHistoryMessages);
    }
  } else {
    messages = allMessages;
  }
```

Note: `countLimit` uses `Math.max` to ensure the threshold check works even when `checkpointThreshold > maxHistoryMessages`. When a checkpoint exists, `listMessagesAfter` fetches only the delta without window limits.

**Step 4: Run tests**

Run: `npx tsx --test tests/session/context.test.ts`
Expected: PASS

**Step 5: Run full suite**

Run: `npm run typecheck && npm test`
Expected: All pass.

**Step 6: Commit**

```bash
git add internal/session/context.ts tests/session/context.test.ts
git commit -m "refactor: use listMessagesAfter in context builder"
```

---

### Task 3: Structured summary helpers

**Files:**
- Modify: `internal/session/service.ts` (add helper functions before class)
- Test: `tests/session/summary.test.ts` (create)

**Step 1: Write failing tests for all helpers**

Create `tests/session/summary.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/session/summary.test.ts`
Expected: FAIL — functions not exported from service.ts yet.

**Step 3: Implement helpers**

Add to `internal/session/service.ts` (before the `SessionService` class), and export them:

```typescript
// --- Stop words for topic extraction ---
const STOP_WORDS = new Set([
  // EN
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "such", "that", "this", "with", "will", "each",
  "make", "like", "from", "just", "into", "also", "more", "other", "would",
  "about", "which", "their", "there", "should", "what", "when", "where",
  "could", "does", "here", "much", "being", "those", "then", "these",
  "very", "after", "before", "your", "only",
  // UA
  "що", "який", "яка", "яке", "які", "для", "при", "або", "але", "так",
  "ще", "вже", "як", "цей", "ця", "це", "ці", "той", "та", "те", "ті",
  "він", "вона", "воно", "вони", "мій", "моя", "моє", "мої", "наш",
  "ваш", "його", "її", "їх", "нас", "вас", "них", "нам", "вам", "ним",
  "тут", "там", "коли", "тоді", "потім", "після", "перед", "між",
]);

export function extractTopics(messages: Message[]): string[] {
  const freq = new Map<string, number>();
  for (const m of messages) {
    const words = m.text
      .toLowerCase()
      .split(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ'']+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
    for (const w of words) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

const DECISION_PATTERNS = [
  // EN
  /(?:agreed|decision|let's use|we'll use|chosen|picked|going with)\s+(.+)/i,
  // UA
  /(?:використовуємо|вирішили|обрали|приймаємо|зупинились на)\s+(.+)/i,
];

export function extractDecisions(messages: Message[]): string[] {
  const decisions: string[] = [];
  for (const m of messages) {
    for (const pattern of DECISION_PATTERNS) {
      const match = m.text.match(pattern);
      if (match?.[1]) {
        // Take first sentence or up to 80 chars
        const text = match[1].split(/[.!?\n]/)[0].trim().slice(0, 80);
        if (text) decisions.push(text);
      }
    }
  }
  return decisions;
}

export function buildBudgetTail(messages: Message[], charBudget = 2000): string[] {
  const lines: string[] = [];
  let remaining = charBudget;

  for (let i = messages.length - 1; i >= 0; i--) {
    const line = `${messages[i].author}: ${messages[i].text}`;
    if (line.length > remaining) break;
    lines.unshift(line);
    remaining -= line.length;
  }
  return lines;
}

const PRIOR_SUMMARY_TRIM = 1000;

export function buildStructuredSummary(
  messages: Message[],
  previousSummary?: string,
): string {
  // Header: count per author
  const authorCounts = new Map<string, number>();
  for (const m of messages) {
    authorCounts.set(m.author, (authorCounts.get(m.author) ?? 0) + 1);
  }
  const authorBreakdown = [...authorCounts.entries()]
    .map(([a, c]) => `${a}: ${c}`)
    .join(", ");
  const total = messages.length;

  // Topics
  const topics = extractTopics(messages);
  const topicsLine = topics.length > 0 ? topics.join(", ") : "general discussion";

  // Decisions
  const decisions = extractDecisions(messages);
  const decisionsLine = decisions.length > 0
    ? decisions.join("; ")
    : "none detected";

  // Tail (budget-based)
  const tail = buildBudgetTail(messages);

  // Build output
  const parts: string[] = [];

  // Prior summary (cumulative, flat — strip existing marker to prevent nesting per INV-3)
  if (previousSummary) {
    // Strip existing [Prior summary] prefix to prevent nested wrappers
    const stripped = previousSummary.replace(/^\[Prior summary\]\n/, "");
    // Trim from END to keep freshest context (not oldest)
    const trimmed = stripped.length > PRIOR_SUMMARY_TRIM
      ? stripped.slice(-PRIOR_SUMMARY_TRIM)
      : stripped;
    parts.push(`[Prior summary]\n${trimmed}\n---`);
  }

  parts.push(`[Checkpoint] ${total} messages (${authorBreakdown})`);
  parts.push(`Topics: ${topicsLine}`);
  parts.push(`Decisions: ${decisionsLine}`);
  parts.push("---");
  parts.push(...tail);

  return parts.join("\n");
}
```

**Step 4: Run tests**

Run: `npx tsx --test tests/session/summary.test.ts`
Expected: All PASS.

**Step 5: Run full suite**

Run: `npm run typecheck && npm test`
Expected: All pass.

**Step 6: Commit**

```bash
git add internal/session/service.ts tests/session/summary.test.ts
git commit -m "feat: structured summary helpers (topics, decisions, budget tail)"
```

---

### Task 4: Checkpoint dedup, thresholds, and cumulative summary

**Files:**
- Modify: `internal/session/service.ts` (rewrite `maybeCreateCheckpoint`)
- Test: `tests/session/checkpoint.test.ts` (create)

**Step 1: Write failing tests**

Create `tests/session/checkpoint.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../../internal/storage/sqlite.js";
import { SessionService } from "../../internal/session/service.js";
import type { Room, RoomConfig } from "../../internal/events/types.js";

const CONFIG: RoomConfig = {
  mode: "manual",
  checkpointThreshold: 5,
  maxHistoryMessages: 100,
  maxContextTokens: 100_000,
};

function setup(): { store: SQLiteStore; session: SessionService; room: Room } {
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const { room } = session.createSession({
    roomName: "test", participants: ["user", "agent.codex"], roomConfig: CONFIG,
  });
  return { store, session, room };
}

function addMessages(session: SessionService, roomId: string, count: number) {
  for (let i = 0; i < count; i++) {
    session.saveUserMessage(roomId, `message ${i + 1}`);
  }
}

test("dedup: repeated /summary without new messages returns null", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 6);

  const first = session.maybeCreateCheckpoint(room, true);
  assert.ok(first, "first checkpoint should be created");

  const second = session.maybeCreateCheckpoint(room, true);
  assert.equal(second, null, "second checkpoint without new messages should be null");
});

test("auto threshold: skips when uncovered < checkpointThreshold", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 3); // less than threshold of 5

  const result = session.maybeCreateCheckpoint(room);
  assert.equal(result, null, "auto checkpoint should skip below threshold");
});

test("auto threshold: creates when uncovered >= checkpointThreshold", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 6); // above threshold of 5

  const result = session.maybeCreateCheckpoint(room);
  assert.ok(result, "auto checkpoint should create at threshold");
});

test("force threshold: creates when uncovered >= 2", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 2);

  const result = session.maybeCreateCheckpoint(room, true);
  assert.ok(result, "force checkpoint should create with 2+ messages");
});

test("force threshold: skips when uncovered < 2", () => {
  const { session, room } = setup();
  addMessages(session, room.id, 1);

  const result = session.maybeCreateCheckpoint(room, true);
  assert.equal(result, null, "force checkpoint should skip with < 2 messages");
});

test("cumulative: new checkpoint includes previous summary", () => {
  const { store, session, room } = setup();
  addMessages(session, room.id, 6);

  const first = session.maybeCreateCheckpoint(room, true);
  assert.ok(first);

  // Add more messages
  addMessages(session, room.id, 6);

  const second = session.maybeCreateCheckpoint(room, true);
  assert.ok(second);
  assert.ok(second.includes("[Prior summary]"),
    "second checkpoint should include prior summary");
});

test("checkpoint range preserves fromMessageId (INV-1)", () => {
  const { store, session, room } = setup();
  addMessages(session, room.id, 6);

  session.maybeCreateCheckpoint(room, true);
  const firstCoverage = store.getCheckpointCoverage(room.id);
  assert.ok(firstCoverage);

  addMessages(session, room.id, 6);
  session.maybeCreateCheckpoint(room, true);
  const secondCoverage = store.getCheckpointCoverage(room.id);
  assert.ok(secondCoverage);

  assert.equal(secondCoverage.fromMessageId, firstCoverage.fromMessageId,
    "fromMessageId should be preserved from first checkpoint (INV-1)");
});

test("dedup works when anchor is outside maxHistoryMessages window (INV-5)", () => {
  const smallWindowConfig: RoomConfig = {
    mode: "manual",
    checkpointThreshold: 5,
    maxHistoryMessages: 3, // very small window
    maxContextTokens: 100_000,
  };
  const store = new SQLiteStore(":memory:");
  store.init();
  const session = new SessionService(store);
  const { room } = session.createSession({
    roomName: "test", participants: ["user"], roomConfig: smallWindowConfig,
  });

  // Add 10 messages
  for (let i = 0; i < 10; i++) {
    session.saveUserMessage(room.id, `message ${i}`);
  }
  const first = session.maybeCreateCheckpoint(room, true);
  assert.ok(first, "first checkpoint should be created");

  // Verify first checkpoint covers the REAL last message, not a windowed subset
  const firstCoverage = store.getCheckpointCoverage(room.id);
  assert.ok(firstCoverage);
  const allMsgs = store.listMessages(room.id, 10_000).filter(
    m => m.role === "user" || m.role === "assistant"
  );
  assert.equal(firstCoverage.toMessageId, allMsgs[allMsgs.length - 1].id,
    "first checkpoint toMessageId must be the actual last message (INV-1)");

  // Add 6 more messages — anchor is now outside window of 3
  for (let i = 0; i < 6; i++) {
    session.saveUserMessage(room.id, `new message ${i}`);
  }

  // This should NOT return null — there ARE new messages after the checkpoint
  const second = session.maybeCreateCheckpoint(room, true);
  assert.ok(second, "should create checkpoint even when anchor is outside history window");
});

test("structured summary has topics and decisions sections", () => {
  const { session, room } = setup();
  // Add messages with decision patterns
  session.saveUserMessage(room.id, "let's use SQLite for storage");
  session.saveUserMessage(room.id, "explain the context builder algorithm");
  session.saveUserMessage(room.id, "context builder uses checkpoints");
  session.saveUserMessage(room.id, "використовуємо TypeScript");
  session.saveUserMessage(room.id, "the checkpoint creates summaries");
  session.saveUserMessage(room.id, "testing the summary");

  const summary = session.maybeCreateCheckpoint(room, true);
  assert.ok(summary);
  assert.ok(summary.includes("Topics:"), "should have Topics section");
  assert.ok(summary.includes("Decisions:"), "should have Decisions section");
  assert.ok(summary.includes("[Checkpoint]"), "should have header");
});

test("no nested [Prior summary] wrappers after 3 checkpoints (INV-3)", () => {
  const { session, room } = setup();

  // 3 rounds of messages + checkpoints
  for (let round = 0; round < 3; round++) {
    addMessages(session, room.id, 6);
    session.maybeCreateCheckpoint(room, true);
  }

  // Get the latest summary
  addMessages(session, room.id, 6);
  const summary = session.maybeCreateCheckpoint(room, true);
  assert.ok(summary);

  const count = (summary.match(/\[Prior summary\]/g) || []).length;
  assert.equal(count, 1,
    "should have exactly one [Prior summary] section regardless of checkpoint depth");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/session/checkpoint.test.ts`
Expected: FAIL — `maybeCreateCheckpoint` doesn't accept `force` parameter yet.

**Step 3: Rewrite maybeCreateCheckpoint**

In `internal/session/service.ts`, replace the existing `maybeCreateCheckpoint` method:

```typescript
  public maybeCreateCheckpoint(room: Room, force?: boolean): string | null {
    // Determine uncovered messages (INV-5: no window dependency for dedup)
    const coverage = this.store.getCheckpointCoverage(room.id);
    let uncoveredMessages: Message[];
    let allConversationMessages: Message[] | null = null;

    if (coverage) {
      // Targeted query: messages after last checkpoint's endpoint (no window limit)
      const afterCheckpoint = this.store.listMessagesAfter(room.id, coverage.toMessageId);
      uncoveredMessages = afterCheckpoint.filter(
        (m) => m.role === "assistant" || m.role === "user",
      );
      // Dedup: nothing new since last checkpoint
      if (uncoveredMessages.length === 0) return null;
    } else {
      // No previous checkpoint: load conversation messages with a high ceiling
      // so that toMessageId is the real last message (holds for rooms ≤10k msgs; sufficient for v0.1)
      const messages = this.store.listMessages(room.id, 10_000);
      allConversationMessages = messages.filter(
        (m) => m.role === "assistant" || m.role === "user",
      );
      uncoveredMessages = allConversationMessages;
      if (uncoveredMessages.length === 0) return null;
    }

    // Threshold check (INV-2)
    const minRequired = force ? 2 : room.config.checkpointThreshold;
    if (uncoveredMessages.length < minRequired) return null;

    // Get previous summary for cumulative checkpoint
    const prevCheckpoint = this.store.getLatestCheckpoint(room.id);
    const previousSummary = prevCheckpoint?.summaryText;

    // Build structured summary
    const summaryText = buildStructuredSummary(uncoveredMessages, previousSummary);

    // Range (INV-1): preserve fromMessageId from previous coverage
    const firstMsgId = allConversationMessages
      ? allConversationMessages[0].id
      : uncoveredMessages[0].id;
    const fromMessageId = coverage?.fromMessageId ?? firstMsgId;
    // toMessageId = last conversation message (including uncovered)
    const lastMessages = allConversationMessages ?? uncoveredMessages;
    const toMessageId = lastMessages[lastMessages.length - 1].id;

    this.store.saveCheckpoint(room.id, summaryText, fromMessageId, toMessageId);
    return summaryText;
  }
```

**Step 4: Run tests**

Run: `npx tsx --test tests/session/checkpoint.test.ts`
Expected: All PASS.

**Step 5: Run full suite**

Run: `npm run typecheck && npm test`
Expected: All pass. The existing command-handler test for `/summary` may need the `force` parameter — check `chat.ts:checkpointNow()` in Task 5.

**Step 6: Commit**

```bash
git add internal/session/service.ts tests/session/checkpoint.test.ts
git commit -m "feat: checkpoint dedup, thresholds, cumulative summary (INV-1,2,3)"
```

---

### Task 5: Engine integration — pass force=true for /summary

**Files:**
- Modify: `internal/engine/chat.ts:120-123`

**Step 1: Verify current behavior**

The `checkpointNow()` method in `chat.ts:120-123` calls `maybeCreateCheckpoint(state.room)` without force. After Task 4, this will apply the auto threshold — which is correct for `processUserMessage` but wrong for the user-invoked `/summary` command.

**Step 2: Update checkpointNow**

In `internal/engine/chat.ts`, change `checkpointNow()`:

```typescript
  public checkpointNow(): string | null {
    const state = this.getState();
    return this.session.maybeCreateCheckpoint(state.room, true);
  }
```

**Step 3: Run full test suite**

Run: `npm run typecheck && npm test`
Expected: All pass. The command-handler test for `/summary` should work because `force=true` allows checkpoint creation with fewer messages.

**Step 4: Commit**

```bash
git add internal/engine/chat.ts
git commit -m "feat: /summary uses force=true for checkpoint creation"
```

---

### Task 6: Integration tests — long dialogue, pinned+summary, rollover

**Files:**
- Test: `tests/session/context.test.ts` (append)

**Step 1: Write integration tests**

Append to `tests/session/context.test.ts`:

```typescript
test("long dialogue: buildContext uses summary + recent after checkpoint", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual", checkpointThreshold: 5,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });

  // Create 30 messages
  for (let i = 1; i <= 30; i++) {
    saveMsg(store, room.id, `msg_${i}`, `discussion point ${i}`);
  }

  // Checkpoint covers msg_1..msg_25
  store.saveCheckpoint(room.id, "Summary of 25 messages about discussion", "msg_1", "msg_25");

  const ctx = buildContext(store, {
    roomId: room.id, maxHistoryMessages: 100,
    checkpointThreshold: 5, maxContextTokens: 100_000,
  });

  const userMsgs = ctx.messages.filter(m => m.role === "user");
  assert.equal(userMsgs.length, 5, "should have 5 post-checkpoint messages");
  assert.equal(userMsgs[0].id, "msg_26");

  const hasSummary = ctx.messages.some(m => m.text.includes("Summary of 25 messages"));
  assert.ok(hasSummary, "should include checkpoint summary");
});

test("pinned context + checkpoint summary both present in context", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual", checkpointThreshold: 3,
    maxHistoryMessages: 100, maxContextTokens: 100_000,
  });

  // Add pinned context
  store.addPinnedContext(room.id, "project-rules", "Always use TypeScript", "user");

  // Add messages + checkpoint
  for (let i = 1; i <= 5; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }
  store.saveCheckpoint(room.id, "Summary of first messages", "msg_1", "msg_3");

  const ctx = buildContext(store, {
    roomId: room.id, maxHistoryMessages: 100,
    checkpointThreshold: 3, maxContextTokens: 100_000,
  });

  const hasPinned = ctx.messages.some(m => m.text.includes("Always use TypeScript"));
  const hasSummary = ctx.messages.some(m => m.text.includes("Summary of first messages"));
  assert.ok(hasPinned, "pinned context should be in output");
  assert.ok(hasSummary, "checkpoint summary should be in output");
});

test("buildContext threshold check works when checkpointThreshold > maxHistoryMessages (INV-5)", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user", "agent.codex"], {
    mode: "manual",
    checkpointThreshold: 20, // larger than maxHistoryMessages
    maxHistoryMessages: 10,
    maxContextTokens: 100_000,
  });

  // Create 25 messages — exceeds threshold
  for (let i = 1; i <= 25; i++) {
    saveMsg(store, room.id, `msg_${i}`, `message ${i}`);
  }

  // Checkpoint covers first 20
  store.saveCheckpoint(room.id, "Summary of 20 messages", "msg_1", "msg_20");

  const ctx = buildContext(store, {
    roomId: room.id,
    maxHistoryMessages: 10,
    checkpointThreshold: 20,
    maxContextTokens: 100_000,
  });

  // Should use checkpoint path (threshold exceeded) and show post-checkpoint messages
  const userMsgs = ctx.messages.filter(m => m.role === "user");
  assert.equal(userMsgs.length, 5, "should have 5 post-checkpoint messages");
  assert.equal(userMsgs[0].id, "msg_21");

  const hasSummary = ctx.messages.some(m => m.text.includes("Summary of 20 messages"));
  assert.ok(hasSummary, "should include checkpoint summary");
});

test("token budget: trims oldest messages when over budget", () => {
  const store = createTestStore();
  const room = store.createRoom("test", ["user"], {
    mode: "manual", checkpointThreshold: 50,
    maxHistoryMessages: 100, maxContextTokens: 200, // very small budget (~800 chars)
  });

  // Each message ~100 chars = ~25 tokens. 10 messages = ~250 tokens > budget
  for (let i = 1; i <= 10; i++) {
    saveMsg(store, room.id, `msg_${i}`, `A`.repeat(100));
  }

  const ctx = buildContext(store, {
    roomId: room.id, maxHistoryMessages: 100,
    checkpointThreshold: 50, maxContextTokens: 200,
  });

  assert.ok(ctx.truncated, "should be truncated");
  assert.ok(ctx.messages.length < 10, "should have fewer than 10 messages");
  // Last message should always be present (newest kept)
  const lastMsg = ctx.messages[ctx.messages.length - 1];
  assert.equal(lastMsg.id, "msg_10", "newest message should be kept");
});
```

**Step 2: Run tests**

Run: `npx tsx --test tests/session/context.test.ts`
Expected: All PASS.

**Step 3: Run full suite**

Run: `npm run typecheck && npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add tests/session/context.test.ts
git commit -m "test: integration tests for context builder (long dialogue, pinned+summary, budget)"
```

---

### Task 7: Final validation

**Step 1: Run full typecheck + test suite**

Run: `npm run typecheck && npm test`
Expected: All pass.

**Step 2: Update bridge files**

Update `bridge/SESSION.md` with checkpoint quality changes. Append entry to `bridge/LOG.md`.

**Step 3: Final commit**

```bash
git add bridge/SESSION.md bridge/LOG.md
git commit -m "docs(bridge): update session state after checkpoint quality implementation"
```
