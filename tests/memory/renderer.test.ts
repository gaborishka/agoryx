import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MemoryLogEntry, MemorySnapshot } from "../../internal/storage/sqlite.js";
import {
  AUTO_GENERATED_HEADER,
  renderMemoryMarkdown,
  resolveMemoryFilePath,
  writeMemoryFile,
} from "../../internal/memory/renderer.js";

const makeSnapshot = (): MemorySnapshot => ({
  roomId: "room_renderer",
  currentGoal: "Ship v0.3",
  activeBranch: "main",
  activeWorktrees: [{ agent: "codex", path: "/tmp/wt/codex", branch: "agoryx/codex-main" }],
  keyDecisions: ["Use SQLite for memory"],
  blockers: ["None right now"],
  nextActions: ["Implement debounce tests"],
  taskStatus: {},
  lastLogId: 42,
  reducerVersion: 1,
  updatedAt: "2026-02-19T16:00:00.000Z",
});

const makeEvent = (id: number): MemoryLogEntry => ({
  id,
  eventId: `evt_${id}`,
  roomId: "room_renderer",
  timestamp: `2026-02-19T16:00:${String(id).padStart(2, "0")}.000Z`,
  source: "user",
  eventType: "note",
  payload: { text: `Entry ${id}` },
});

test("renderMemoryMarkdown includes header and all sections", () => {
  const markdown = renderMemoryMarkdown(
    makeSnapshot(),
    [makeEvent(1), makeEvent(2)],
    { generatedAt: "2026-02-19T16:01:00.000Z", roomId: "room_renderer" },
  );

  assert.match(markdown, new RegExp(`^${AUTO_GENERATED_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  assert.match(markdown, /# Agoryx Project Memory/);
  assert.match(markdown, /## Current State/);
  assert.match(markdown, /## Key Decisions/);
  assert.match(markdown, /## Blockers/);
  assert.match(markdown, /## Next Actions/);
  assert.match(markdown, /## Recent Log \(last 10\)/);
});

test("renderMemoryMarkdown handles empty snapshot gracefully", () => {
  const markdown = renderMemoryMarkdown(
    null,
    [],
    { generatedAt: "2026-02-19T16:01:00.000Z", roomId: "room_empty" },
  );

  assert.match(markdown, /\*\*Goal:\*\* \(empty\)/);
  assert.match(markdown, /\*\*Branch:\*\* \(empty\)/);
  assert.match(markdown, /- \(none\)/);
  assert.match(markdown, /\| - \| - \| - \| \(none\) \|/);
});

test("renderMemoryMarkdown includes only the last 10 log entries", () => {
  const events = Array.from({ length: 12 }, (_, index) => makeEvent(index + 1));
  const markdown = renderMemoryMarkdown(
    makeSnapshot(),
    events,
    { generatedAt: "2026-02-19T16:01:00.000Z", roomId: "room_renderer" },
  );

  assert.doesNotMatch(markdown, /"Entry 1"/);
  assert.doesNotMatch(markdown, /"Entry 2"/);
  assert.match(markdown, /"Entry 12"/);
});

test("resolveMemoryFilePath returns canonical .agoryx/memory.md path", () => {
  const root = "/tmp/agoryx-root";
  assert.equal(resolveMemoryFilePath(root), join(root, ".agoryx", "memory.md"));
});

test("writeMemoryFile writes to canonical path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agoryx-renderer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const path = writeMemoryFile(root, "first");
  assert.equal(path, join(root, ".agoryx", "memory.md"));
  assert.ok(existsSync(path));
  assert.equal(readFileSync(path, "utf8"), "first");
});

test("writeMemoryFile performs atomic tmp+rename without tmp leftovers", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agoryx-renderer-atomic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const path = writeMemoryFile(root, "initial");
  writeMemoryFile(root, "updated");

  assert.equal(readFileSync(path, "utf8"), "updated");
  const files = readdirSync(join(root, ".agoryx"));
  const tmpFiles = files.filter((name) => name.includes(".tmp-"));
  assert.equal(tmpFiles.length, 0);
});
