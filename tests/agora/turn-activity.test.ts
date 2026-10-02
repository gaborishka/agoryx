import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTurnActivity, turnActivityEntries, turnSession } from "../../internal/agora/turn-activity.js";
import type { RoomState, TranscriptTool, TurnState } from "../../internal/agora/types.js";

const turn = { startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:01:00.000Z", activity: [{ id: "same-id", kind: "command", label: "npm test" }] } as TurnState;
const tool = (id: string, at?: string, output = "correct output"): TranscriptTool => ({ kind: "tool", id, at, tool: "shell", title: "npm test", category: "command", output, status: "ok" });

test("activity details require an exact id within the turn, never a matching title from another turn", () => {
  const correct = tool("same-id", "2026-10-01T10:00:30.000Z");
  assert.deepEqual(turnActivityEntries(turn, [tool("same-id", "2026-10-01T09:59:00.000Z", "earlier turn"), correct, tool("same-id", "2026-10-01T10:02:00.000Z", "later turn"), tool("other-id", correct.at)]), [correct]);
});

test("ambiguous ids, undated tools and invalid timestamps do not acquire a guessed output", () => {
  assert.deepEqual(turnActivityEntries(turn, [tool("same-id"), tool("same-id", "invalid")]), []);
  assert.deepEqual(turnActivityEntries(turn, [tool("same-id", turn.startedAt), tool("same-id", turn.endedAt)]), []);
});

test("a running turn can receive tool results after its start, with no fabricated end boundary", () => {
  const running = { ...turn, endedAt: undefined };
  const e = tool("same-id", "2026-10-01T10:05:00.000Z");
  assert.deepEqual(turnActivityEntries(running, [e]), [e]);
});

test("old turns keep their own session; only running turns use a session bound during that turn", () => {
  const state = { sessions: { codex: { sessionId: "new", boundAt: "2026-10-01T10:00:10.000Z" } } } as Pick<RoomState, "sessions">;
  const t = { ...turn, agent: "codex", status: "ok", sessionId: "old" } as TurnState;
  assert.equal(turnSession(state, t), "old");
  assert.equal(turnSession(state, { ...t, status: "running" }), "new");
  assert.equal(turnSession({ sessions: { codex: { sessionId: "other", boundAt: "2026-10-01T09:00:00.000Z" } } }, { ...t, status: "running", sessionId: null }), null);
});

// P10's t5: its actions sat 6.8 MB into a 12.7 MB Claude session, behind the last page the room reads first.
const claudeSession = (calls: { id: string; at: string; output: string }[], filler: number, earlier = 0) => {
  const lines: object[] = [];
  for (let i = 0; i < earlier; i += 1) {
    const at = new Date(Date.parse("2026-10-01T08:00:00.000Z") + i * 1000).toISOString();
    lines.push({ type: "assistant", uuid: `earlier-${i}`, timestamp: at, message: { content: [{ type: "tool_use", id: `earlier-${i}`, name: "Bash", input: { command: "x".repeat(400) } }] } });
  }
  lines.push(...calls.flatMap(({ id, at, output }) => [
    { type: "assistant", uuid: `a-${id}`, timestamp: at, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }] } },
    { type: "user", uuid: `r-${id}`, timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } },
  ]));
  for (let i = 0; i < filler; i += 1) {
    const at = new Date(Date.parse("2026-10-01T12:00:00.000Z") + i * 1000).toISOString();
    lines.push({ type: "assistant", uuid: `later-${i}`, timestamp: at, message: { content: [{ type: "tool_use", id: `later-${i}`, name: "Bash", input: { command: "x".repeat(400) } }] } });
  }
  const file = join(mkdtempSync(join(tmpdir(), "agoryx-turn-activity-")), "session.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
};

test("an old turn of a long session shows its actions at once, with nothing older to load", () => {
  const old = { startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:10:00.000Z", activity: [{ id: "toolu_t5a", kind: "command", label: "npm test" }, { id: "toolu_t5b", kind: "command", label: "git diff" }] } as TurnState;
  const file = claudeSession([{ id: "toolu_t5a", at: "2026-10-01T10:01:00.000Z", output: "62 passed" }, { id: "toolu_t5b", at: "2026-10-01T10:02:00.000Z", output: "2 files changed" }], 600, 600);
  const reply = readTurnActivity("claude", file, old, { window: 32 * 1024 });
  assert.deepEqual(reply.entries.map((e) => [e.id, e.output]), [["toolu_t5a", "62 passed"], ["toolu_t5b", "2 files changed"]]);
  assert.equal(reply.start, 0, "no «Load older session entries» for a turn already found whole");
  // A turn none of whose actions the session holds stops at the turn's start, not at the file's:
  // a budget too small for the whole file is never reached.
  const lost = readTurnActivity("claude", file, { ...old, activity: [{ id: "toolu_gone", kind: "command", label: "x" }] } as TurnState, { window: 32 * 1024, budget: reply.size * 0.75 });
  assert.deepEqual(lost.entries, []);
  assert.equal(lost.start, 0);
  // An explicit page is read alone, as before.
  const page = readTurnActivity("claude", file, old, { window: 32 * 1024, end: reply.size });
  assert.deepEqual(page.entries, []);
  assert.ok(page.start > 0);
  // So is a running turn's last page, read again every two seconds while it works.
  const running = readTurnActivity("claude", file, { ...old, endedAt: undefined }, { window: 32 * 1024 });
  assert.deepEqual(running.entries, []);
  assert.ok(running.start > 0);
});

test("an id found on two pages of a session is as ambiguous as twice on one page", () => {
  const old = { startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T13:00:00.000Z", activity: [{ id: "same", kind: "command", label: "x" }, { id: "other", kind: "command", label: "y" }] } as TurnState;
  const file = claudeSession([{ id: "same", at: "2026-10-01T10:01:00.000Z", output: "first" }], 300);
  writeFileSync(file, JSON.stringify({ type: "assistant", uuid: "a-again", timestamp: "2026-10-01T12:59:00.000Z", message: { content: [{ type: "tool_use", id: "same", name: "Bash", input: { command: "echo again" } }] } }) + "\n", { flag: "a" });
  assert.deepEqual(readTurnActivity("claude", file, old, { window: 32 * 1024 }).entries, []);
});
