import assert from "node:assert/strict";
import { test } from "node:test";
import { turnActivityEntries, turnSession } from "../../internal/agora/turn-activity.js";
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
