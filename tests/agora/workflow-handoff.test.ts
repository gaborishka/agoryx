import assert from "node:assert/strict";
import test from "node:test";
import { conversationMaterials } from "../../internal/agora/workflow-handoff.js";
import type { RoomState } from "../../internal/agora/types.js";
import type { WorkflowRun } from "../../internal/agora/workflow-types.js";

const state = {
  id: "room",
  messages: [
    {
      id: "m1",
      author: "Ivan",
      kind: "human",
      text: "Original decision",
      ts: "2026-10-05",
    },
    {
      id: "m2",
      author: "Codex",
      kind: "reply",
      text: "Not selected",
      ts: "2026-10-05",
    },
  ],
} as RoomState;
const run = {
  id: "result",
  roomId: "room",
  mode: "council",
  status: "completed",
  task: "Decide",
  criteria: ["Evidence"],
  report: { summary: "Result", checks: [], unknowns: ["Dissent must survive"] },
  rounds: [
    {
      phase: "synthesis",
      status: "revealed",
      entries: [
        { status: "complete", label: "Synthesis", text: "Public synthesis" },
      ],
    },
    {
      phase: "dissent_audit",
      status: "revealed",
      entries: [{ status: "complete", label: "Audit", text: "Public dissent" }],
    },
    {
      phase: "private",
      status: "sealed",
      entries: [{ status: "complete", text: "SECRET" }],
    },
  ],
} as unknown as WorkflowRun;

test("a handoff freezes only human-selected messages and revealed results, retaining dissent and decisions", () => {
  const materials = conversationMaterials(state, [run], ["m1"], ["result"]);
  assert.equal(materials.length, 2);
  const text = JSON.stringify(materials);
  assert.match(text, /Original decision/);
  assert.match(text, /Public synthesis/);
  assert.match(text, /Dissent must survive/);
  assert.match(text, /Public dissent/);
  assert.doesNotMatch(text, /SECRET|Not selected/);
  assert.deepEqual(
    conversationMaterials(state, [run], undefined, undefined),
    [],
  );
  const before = materials[0]!.text;
  const copy = structuredClone(state);
  copy.messages[0]!.text = "Later edit";
  assert.equal(materials[0]!.text, before);
});

test("handoffs reject missing, cross-room, active, duplicate and oversized inputs", () => {
  assert.throws(
    () => conversationMaterials(state, [run], ["missing"], []),
    /not available/,
  );
  assert.throws(
    () => conversationMaterials(state, [run], ["m1", "m1"], []),
    /distinct/,
  );
  assert.throws(
    () =>
      conversationMaterials(
        state,
        [{ ...run, roomId: "other" }],
        [],
        ["result"],
      ),
    /this conversation/,
  );
  for (const status of ["running", "waiting_user"] as const)
    assert.throws(
      () => conversationMaterials(state, [{ ...run, status }], [], ["result"]),
      /finished/,
    );
  assert.throws(
    () =>
      conversationMaterials(state, [{ ...run, rounds: [] }], [], ["result"]),
    /revealed/,
  );
  assert.throws(
    () => conversationMaterials(state, [run], "m1", []),
    /distinct/,
  );
  const large = structuredClone(state);
  large.messages[0]!.text = "ї".repeat(100_001);
  assert.throws(() => conversationMaterials(large, [], ["m1"], []), /200 KB/);
});
