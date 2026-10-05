import test from "node:test";
import assert from "node:assert/strict";
import {
  collectRoomExportData,
  collectTargetExportData,
  normalizeExportFormat,
  parseExportCommandArgs,
  renderSessionAsMarkdown,
  renderSessionAsJson,
  renderSessionExport,
  type SessionExportData,
} from "../../cmd/agoryx/session-export.js";
import type {
  Room,
  Message,
  PinnedContext,
  Checkpoint,
  RoomConfig,
} from "../../internal/events/types.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

const FIXED_TIME = "2026-02-17T12:00:00.000Z";

const makeRoom = (overrides?: Partial<Room>): Room => ({
  id: "room_1",
  name: "Test Room",
  participants: ["user", "codex", "claude"],
  config: {
    mode: "manual",
    checkpointThreshold: 20,
    maxHistoryMessages: 100,
    maxContextTokens: 4000,
  },
  createdAt: "2026-02-17T10:00:00.000Z",
  ...overrides,
});

const makeMessage = (overrides?: Partial<Message>): Message => ({
  id: "msg_1",
  roomId: "room_1",
  author: "user",
  role: "user",
  text: "Hello world",
  format: "plain",
  metadata: {},
  createdAt: "2026-02-17T10:01:00.000Z",
  ...overrides,
});

const makePin = (overrides?: Partial<PinnedContext>): PinnedContext => ({
  id: "pin_1",
  roomId: "room_1",
  label: "Project goal",
  content: "Build a multi-agent chat system",
  pinnedBy: "user",
  createdAt: "2026-02-17T10:00:30.000Z",
  ...overrides,
});

const makeCheckpoint = (overrides?: Partial<Checkpoint>): Checkpoint => ({
  id: "cp_1",
  roomId: "room_1",
  summaryText: "Discussion about architecture decisions.",
  fromMessageId: "msg_1",
  toMessageId: "msg_5",
  createdAt: "2026-02-17T10:30:00.000Z",
  ...overrides,
});

const makeExportData = (overrides?: Partial<SessionExportData>): SessionExportData => ({
  targetId: "room_1",
  room: makeRoom(),
  messages: [makeMessage()],
  pinnedContext: [],
  checkpoint: null,
  exportedAt: FIXED_TIME,
  ...overrides,
});

// ── Markdown tests ──────────────────────────────────────────────

test("markdown: renders full export with messages, pinned context, and checkpoint", () => {
  const data = makeExportData({
    messages: [
      makeMessage({ id: "msg_1", author: "user", text: "What's the plan?" }),
      makeMessage({ id: "msg_2", author: "codex", role: "assistant", text: "I suggest we start with adapters.", createdAt: "2026-02-17T10:02:00.000Z" }),
    ],
    pinnedContext: [makePin()],
    checkpoint: makeCheckpoint(),
  });

  const md = renderSessionAsMarkdown(data);

  assert.ok(md.startsWith("# Agoryx Session Export"));
  assert.ok(md.includes(`- Exported At: ${FIXED_TIME}`));
  assert.ok(md.includes("- Room Id: room_1"));
  assert.ok(md.includes("- Room Name: Test Room"));
  assert.ok(md.includes("- Mode: manual"));
  assert.ok(md.includes("- Participants: user, codex, claude"));

  assert.ok(md.includes("## Pinned Context"));
  assert.ok(md.includes("### Project goal (pin_1)"));
  assert.ok(md.includes("Build a multi-agent chat system"));

  assert.ok(md.includes("## Latest Checkpoint"));
  assert.ok(md.includes("Discussion about architecture decisions."));

  assert.ok(md.includes("## Messages"));
  assert.ok(md.includes("### user ("));
  assert.ok(md.includes("What's the plan?"));
  assert.ok(md.includes("### codex ("));
  assert.ok(md.includes("I suggest we start with adapters."));
});

test("markdown: omits pinned context section when empty", () => {
  const data = makeExportData({ pinnedContext: [] });
  const md = renderSessionAsMarkdown(data);

  assert.ok(!md.includes("## Pinned Context"));
  assert.ok(md.includes("## Messages"));
});

test("markdown: omits checkpoint section when null", () => {
  const data = makeExportData({ checkpoint: null });
  const md = renderSessionAsMarkdown(data);

  assert.ok(!md.includes("## Latest Checkpoint"));
  assert.ok(md.includes("## Messages"));
});

test("markdown: omits checkpoint section when summaryText is empty", () => {
  const data = makeExportData({
    checkpoint: makeCheckpoint({ summaryText: "" }),
  });
  const md = renderSessionAsMarkdown(data);

  assert.ok(!md.includes("## Latest Checkpoint"));
});

test("markdown: renders empty messages section gracefully", () => {
  const data = makeExportData({ messages: [] });
  const md = renderSessionAsMarkdown(data);

  assert.ok(md.includes("## Messages"));
  // No message headers after "## Messages"
  const messagesIdx = md.indexOf("## Messages");
  const afterMessages = md.slice(messagesIdx + "## Messages".length).trim();
  assert.equal(afterMessages, "");
});

test("markdown: preserves message order", () => {
  const data = makeExportData({
    messages: [
      makeMessage({ id: "msg_a", author: "user", text: "First" }),
      makeMessage({ id: "msg_b", author: "codex", text: "Second" }),
      makeMessage({ id: "msg_c", author: "claude", text: "Third" }),
    ],
  });
  const md = renderSessionAsMarkdown(data);

  const firstIdx = md.indexOf("First");
  const secondIdx = md.indexOf("Second");
  const thirdIdx = md.indexOf("Third");

  assert.ok(firstIdx < secondIdx);
  assert.ok(secondIdx < thirdIdx);
});

test("markdown: handles multiple pinned contexts", () => {
  const data = makeExportData({
    pinnedContext: [
      makePin({ id: "pin_1", label: "Goal", content: "Build chat" }),
      makePin({ id: "pin_2", label: "Constraint", content: "Use TypeScript" }),
    ],
  });
  const md = renderSessionAsMarkdown(data);

  assert.ok(md.includes("### Goal (pin_1)"));
  assert.ok(md.includes("Build chat"));
  assert.ok(md.includes("### Constraint (pin_2)"));
  assert.ok(md.includes("Use TypeScript"));
});

// ── JSON tests ──────────────────────────────────────────────────

test("json: output is valid JSON with expected top-level fields", () => {
  const data = makeExportData({
    messages: [makeMessage()],
    pinnedContext: [makePin()],
    checkpoint: makeCheckpoint(),
  });

  const raw = renderSessionAsJson(data);
  const parsed = JSON.parse(raw);

  assert.equal(parsed.exportedAt, FIXED_TIME);
  assert.equal(parsed.targetId, "room_1");
  assert.equal(parsed.room.id, "room_1");
  assert.equal(parsed.room.name, "Test Room");
  assert.equal(parsed.checkpoint.id, "cp_1");
  assert.equal(parsed.pinnedContext.length, 1);
  assert.equal(parsed.messages.length, 1);
});

test("json: checkpoint is null when not provided", () => {
  const data = makeExportData({ checkpoint: null });
  const parsed = JSON.parse(renderSessionAsJson(data));

  assert.equal(parsed.checkpoint, null);
});

test("json: messages array preserves all message fields", () => {
  const msg = makeMessage({
    id: "msg_42",
    author: "claude",
    role: "assistant",
    text: "Here is my response.",
    format: "markdown",
    metadata: { provider: "anthropic", model: "claude-4", tokenUsage: { input: 100, output: 50 } },
  });
  const data = makeExportData({ messages: [msg] });
  const parsed = JSON.parse(renderSessionAsJson(data));

  const exported = parsed.messages[0];
  assert.equal(exported.id, "msg_42");
  assert.equal(exported.author, "claude");
  assert.equal(exported.role, "assistant");
  assert.equal(exported.text, "Here is my response.");
  assert.equal(exported.format, "markdown");
  assert.equal(exported.metadata.provider, "anthropic");
  assert.equal(exported.metadata.tokenUsage.input, 100);
});

test("json: empty messages and pinnedContext are empty arrays", () => {
  const data = makeExportData({ messages: [], pinnedContext: [] });
  const parsed = JSON.parse(renderSessionAsJson(data));

  assert.deepEqual(parsed.messages, []);
  assert.deepEqual(parsed.pinnedContext, []);
});

test("json: room config is fully serialized", () => {
  const data = makeExportData();
  const parsed = JSON.parse(renderSessionAsJson(data));

  assert.equal(parsed.room.config.mode, "manual");
  assert.equal(parsed.room.config.checkpointThreshold, 20);
  assert.equal(parsed.room.config.maxHistoryMessages, 100);
  assert.equal(parsed.room.config.maxContextTokens, 4000);
});

// ── exportedAt injection ────────────────────────────────────────

test("exportedAt defaults to current time when not provided", () => {
  const before = new Date().toISOString();
  const data = makeExportData({ exportedAt: undefined });

  const mdResult = renderSessionAsMarkdown(data);
  const jsonResult = JSON.parse(renderSessionAsJson(data));
  const after = new Date().toISOString();

  // Markdown: exported at is between before and after
  const mdMatch = mdResult.match(/- Exported At: (.+)/);
  assert.ok(mdMatch);
  assert.ok(mdMatch[1] >= before);
  assert.ok(mdMatch[1] <= after);

  // JSON: same check
  assert.ok(jsonResult.exportedAt >= before);
  assert.ok(jsonResult.exportedAt <= after);
});

test("normalizeExportFormat supports markdown/json and rejects unknown values", () => {
  assert.equal(normalizeExportFormat(undefined), "markdown");
  assert.equal(normalizeExportFormat("markdown"), "markdown");
  assert.equal(normalizeExportFormat("json"), "json");
  assert.equal(normalizeExportFormat("YAML"), null);
});

test("parseExportCommandArgs parses format and --out", () => {
  assert.deepEqual(parseExportCommandArgs([]), { format: "markdown", outPath: undefined });
  assert.deepEqual(parseExportCommandArgs(["json"]), { format: "json", outPath: undefined });
  assert.deepEqual(parseExportCommandArgs(["markdown", "--out", "./x.md"]), {
    format: "markdown",
    outPath: "./x.md",
  });
  assert.deepEqual(parseExportCommandArgs(["--out", "./x.json"]), {
    format: "markdown",
    outPath: "./x.json",
  });
  assert.equal(parseExportCommandArgs(["yaml"]), null);
  assert.equal(parseExportCommandArgs(["json", "--out"]), null);
  assert.equal(parseExportCommandArgs(["json", "--unknown", "x"]), null);
  assert.equal(parseExportCommandArgs(["json", "--out", "a.md", "--out", "b.md"]), null);
});

test("renderSessionExport switches by selected format", () => {
  const data = makeExportData();
  const markdown = renderSessionExport(data, "markdown");
  const json = renderSessionExport(data, "json");

  assert.match(markdown, /^# Agoryx Session Export/m);
  const parsed = JSON.parse(json);
  assert.equal(parsed.targetId, data.targetId);
});

test("collectTargetExportData resolves room from session id", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    const roomConfig: RoomConfig = {
      mode: "manual",
      checkpointThreshold: 10,
      maxHistoryMessages: 100,
      maxContextTokens: 4000,
    };
    const room = store.createRoom("Collect Export Test", ["user", "agent.codex"], roomConfig);
    const sessionId = store.createSessionRun(room.id);

    const data = collectTargetExportData(store, sessionId);
    assert.equal(data.targetId, sessionId);
    assert.equal(data.room.id, room.id);
    assert.deepEqual(data.messages, []);
  } finally {
    store.close();
  }
});

test("collectTargetExportData throws when target id is unknown", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    assert.throws(
      () => collectTargetExportData(store, "unknown_target"),
      /No room\/session found/,
    );
  } finally {
    store.close();
  }
});

test("collectRoomExportData throws when room does not exist", () => {
  const store = new SQLiteStore(":memory:");
  store.init();

  try {
    assert.throws(() => collectRoomExportData(store, "room_missing"), /was not found/);
  } finally {
    store.close();
  }
});
