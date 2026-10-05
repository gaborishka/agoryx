import assert from "node:assert/strict";
import test from "node:test";
import { buildDelta, messageGist } from "../../internal/agora/prompts.js";
import { createTestRoom } from "./helpers.js";

const gist = (text: string, kind: "agent" | "human" | "decision" = "agent") =>
  messageGist({ id: "m7", author: "claude", kind, text }, { id: "codex" }, "Ivan");

test("protected messages exceed the old 12000-character cap without loss", () => {
  const text = "Important instruction. ".repeat(1000) + "FINAL_CONSTRAINT";
  assert.equal(gist(text, "human"), text);
  assert.equal(gist(text, "decision"), text);
  assert.equal(gist(`@codex ${text}`), `@codex ${text}`);
});

test("single-paragraph excerpts retain both beginning and conclusion", () => {
  const text = "FIRST " + "background ".repeat(200) + "TAIL_CONCLUSION";
  const result = gist(text);
  assert.match(result, /^FIRST/);
  assert.match(result, /TAIL_CONCLUSION/);
  assert.match(result, /agoryx read m7/);
  assert.ok(result.length < 1200);
});

test("large fenced examples are omitted whole, with a read pointer", () => {
  for (const fence of ["```", "~~~"]) {
    const result = gist(`${fence}ts\n${"const x = 1;\n".repeat(200)}${fence}`);
    assert.ok(!result.includes(fence), "never emit an unclosed code fence");
    assert.match(result, /code block omitted/);
    assert.match(result, /agoryx read m7/);
  }
});

test("the delta does not globally slice away protected human instructions", async () => {
  const room = createTestRoom({ agents: [] });
  try {
    const text = "BEGIN_CONSTRAINT " + "Human context. ".repeat(5000) + " END_CONSTRAINT";
    const event = room.store.append({ type: "message.posted", message: {
      id: "m1", author: "Ivan", kind: "human", text, mentions: [], wakes: false,
    } });
    const delta = buildDelta({ state: room.store.state, events: [event], agent: { id: "codex", kind: "codex", label: "Codex" }, turnsLeft: 1 });
    assert.ok(delta.includes(text));
  } finally {
    await room.cleanup();
  }
});

test("budget pressure preserves addressed messages, dissent and table moves", async () => {
  const room = createTestRoom({ agents: [] });
  try {
    const add = (id: number, text: string, turnId?: string) => room.store.append({ type: "message.posted", message: {
      id: `m${id}`, author: "claude", kind: "agent", text, mentions: [], wakes: false, ...(turnId ? { turnId } : {}),
    } });
    const table = (id: number, text: string, turnId?: string) => room.store.append({ type: "table.op", op: {
      op: "concede", id: `C${id}`, by: "claude", text: `${"Qualification context. ".repeat(20)}${text}`, ...(turnId ? { turnId } : {}),
    } });
    const events = [
      add(1, "@codex ADDRESS_ONLY keep this condition"),
      add(2, "I disagree: DISSENT_ONLY cannot ship yet"),
      add(3, "@all BROADCAST_ONLY keep this condition"),
      table(1, "LOOSE_CONCESSION"),
      table(2, "ATTACHED_CONCESSION", "t1"),
      add(4, "Routine update.", "t1"),
      table(3, "ORPHAN_CONCESSION", "t2"),
    ];
    for (let n = 5; n < 130; n++) events.push(add(n, `FILLER_${n} ${"detail ".repeat(150)}`));
    const delta = buildDelta({ state: room.store.state, events, agent: { id: "codex", kind: "codex", label: "Codex" }, turnsLeft: 1 });
    for (const marker of ["ADDRESS_ONLY", "DISSENT_ONLY", "BROADCAST_ONLY", "LOOSE_CONCESSION", "ATTACHED_CONCESSION", "ORPHAN_CONCESSION"]) {
      assert.ok(delta.includes(marker), `protected signal lost: ${marker}`);
    }
    assert.ok(!delta.includes("FILLER_5 "), "ordinary old messages still yield to the budget");
  } finally {
    await room.cleanup();
  }
});
