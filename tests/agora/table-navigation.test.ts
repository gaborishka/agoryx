import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, initialState } from "../../internal/agora/projection.js";
import { prepareTableOp } from "../../internal/agora/table.js";
import { DEFAULT_SETTINGS, type RoomEvent } from "../../internal/agora/types.js";
import { refAnchor, refExists } from "../../ui/src/lib/room.js";

const fixture = () => {
  const created: RoomEvent = { type: "room.created", id: "navigation", name: "Navigation", workspace: "/workspace", createdWorkspace: false, human: "Ivan", agents: [], settings: { ...DEFAULT_SETTINGS }, seq: 1, ts: "2026-10-04T10:00:00Z" };
  const room = initialState(created);
  const play = (raw: unknown, by = "claude") => {
    const op = prepareTableOp(room.table, raw, by, by === "Ivan");
    applyEvent(room, { type: "table.op", op, seq: room.seq + 1, ts: created.ts });
    return op;
  };
  play({ op: "ask", text: "Which design?" });
  play({ op: "propose", title: "Design", q: "Q1" });
  play({ op: "next", text: "Verify the design", target: "P1" });
  play({ op: "fact", text: "An observed fact" });
  play({ op: "settle", text: "A recorded conclusion" });
  return { room, play };
};

test("native evidence navigation opens the correct proposal, step, fact and conclusion context", () => {
  const { room, play } = fixture();
  for (const target of ["P1", "X1", "F1", "S1"]) play({ op: "evidence", target, text: `Evidence for ${target}` }, "codex");
  assert.deepEqual(room.table.notes.map(note => [note.id, refAnchor(room, note.id)]), [
    ["N1", "opt-P1"], ["N2", "ti-X1"], ["N3", "ti-F1"], ["N4", "ti-S1"],
  ]);
  for (const note of room.table.notes) {
    assert.equal(refExists(room, note.id), true);
    assert.equal(refAnchor(room, note.id), refAnchor(room, note.target));
  }
});

test("evidence on a closed question keeps the proposal anchor that expands its folded options", () => {
  const { room, play } = fixture();
  play({ op: "support", target: "P1", text: "The design passes review" }, "codex");
  play({ op: "decide", target: "P1" }, "Ivan");
  assert.equal(room.table.questions[0]?.status, "decided");
  assert.equal(refAnchor(room, "N1"), "opt-P1");
});

test("deleted and unsupported note references have no invented navigation target", () => {
  const { room, play } = fixture();
  play({ op: "evidence", target: "X1", text: "Recorded result" }, "codex");
  assert.equal(refAnchor(room, "N1"), "ti-X1");
  play({ op: "delete", target: "X1" }, "Ivan");
  assert.equal(refExists(room, "N1"), false);
  assert.equal(refAnchor(room, "N1"), null);
  room.table.notes.push({ id: "N2", kind: "evidence", target: "N2", text: "Unsupported legacy reference", by: "codex", seq: room.seq });
  assert.equal(refAnchor(room, "N2"), null, "malformed old data cannot recurse through note references");
});

test("decision navigation retains its own history anchor through proposal edits and deletion", () => {
  const { room, play } = fixture();
  play({ op: "decide", target: "P1" }, "Ivan");
  assert.equal(refExists(room, "D1"), true);
  assert.equal(refAnchor(room, "D1"), "decision-D1");
  play({ op: "reopen", target: "P1" }, "Ivan");
  play({ op: "edit", target: "P1", title: "A new design that was not chosen" }, "Ivan");
  assert.equal(room.table.decisions[0]?.title, "Design");
  assert.equal(refAnchor(room, "D1"), "decision-D1", "historical decisions must not navigate to a differently named proposal");
  play({ op: "delete", target: "P1" }, "Ivan");
  assert.equal(refExists(room, "P1"), false);
  assert.equal(refExists(room, "D1"), true);
  assert.equal(refAnchor(room, "D1"), "decision-D1", "deleting a proposal does not erase the recorded decision's destination");
  assert.equal(refAnchor(room, "D99"), null);
});
