import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { forHumanOnly } from "../../internal/agora/prompts.js";
import { sysError, sysLine } from "../../ui/src/lib/system.js";
import { createTestRoom, withTimeout } from "./helpers.js";

// A turn that fails shows the agent the same messages again next time, so nothing it was asked is lost.
// When every turn fails the same way (here: the fake CLI cannot read its rules), that alone woke it
// again at once, without end — a copy of a real room made 520 failed turns in a row.

const failed = (room: ReturnType<typeof createTestRoom>, agent: string) =>
  room.store.state.turns.filter((turn) => turn.agent === agent && turn.status === "error").length;

const notes = (room: ReturnType<typeof createTestRoom>) =>
  room.store.state.messages.filter((message) => message.sys?.code === "agent.failing");

test("an agent whose turns keep failing is not woken again until the human writes", async () => {
  const room = createTestRoom();
  try {
    writeFileSync(join(room.home, "rules.json"), "[{ broken");
    room.engine.postHuman("hi");
    await withTimeout(room.engine.waitIdle());

    for (const agent of ["claude", "codex"]) assert.equal(failed(room, agent), 3, `${agent} failed turns`);
    const said = notes(room);
    assert.equal(said.length, 2);
    for (const note of said) {
      assert.equal(note.wakes, false);
      assert.match(note.text, /failed 3 turns in a row/);
      assert.match(note.text, /woken again when you write/);
    }
    const codexNote = said.find((note) => note.sys?.code === "agent.failing" && note.sys.handle === "codex")!;
    assert.ok(codexNote.sys?.code === "agent.failing" && codexNote.sys.message.length > 0, "the note says why");

    // The human writing wakes them again, and they get as many tries as before.
    room.engine.postHuman("try again");
    await withTimeout(room.engine.waitIdle());
    for (const agent of ["claude", "codex"]) assert.equal(failed(room, agent), 6, `${agent} failed turns after the human wrote`);
    assert.equal(notes(room).length, 4);
  } finally {
    await room.cleanup();
  }
});

test("a turn that works in between starts the count again", async () => {
  // Codex fails twice, then answers, then fails for good: it is stopped only after three failures in a row.
  const room = createTestRoom({
    agents: [{ id: "codex", kind: "codex", label: "Codex" }],
    rules: [
      { agent: "codex", once: true, error: "boom 1" },
      { agent: "codex", once: true, error: "boom 2" },
      { agent: "codex", once: true, reply: "@Ivan done" },
      { agent: "codex", error: "boom again" },
    ],
  });
  try {
    room.engine.postHuman("hi");
    await withTimeout(room.engine.waitIdle());
    const statuses = room.store.state.turns.map((turn) => turn.status);
    assert.deepEqual(statuses, ["error", "error", "ok"]);
    assert.equal(notes(room).length, 0);

    room.engine.postHuman("more");
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(room.store.state.turns.map((turn) => turn.status), ["error", "error", "ok", "error", "error", "error"]);
    assert.equal(notes(room).length, 1);
  } finally {
    await room.cleanup();
  }
});

test("only the stopped agent is left out: the others go on, and their @mentions do not wake it", async () => {
  const room = createTestRoom({ rules: [{ agent: "claude", error: "boom" }, { agent: "codex", reply: "@claude what do you think?" }] });
  try {
    room.engine.postHuman("hi");
    await withTimeout(room.engine.waitIdle());
    assert.equal(failed(room, "claude"), 3);
    assert.equal(notes(room).length, 1);
    const quiet = notes(room)[0]!;
    assert.equal(sysError(quiet), false, "a quiet line, not an error");
    assert.equal(forHumanOnly(quiet), true, "the human's to act on: Codex does not read it");
    assert.match(sysLine(quiet), /^Claude failed 3 turns in a row — .*boom.* — so it is not woken again until you write\.$/s);

    // Codex @mentioning it: Codex's message is posted, Claude is not woken.
    room.engine.post("@claude are you there?", "codex");
    await withTimeout(room.engine.waitIdle());
    assert.equal(failed(room, "claude"), 3);
    assert.equal(room.store.state.turns.filter((turn) => turn.agent === "claude").length, 3);
  } finally {
    await room.cleanup();
  }
});

test("another round, or a change to the agent, gives it fresh tries too", async () => {
  const room = createTestRoom({ rules: [{ agent: "claude", error: "boom" }, { agent: "codex", reply: "::pass::" }] });
  const claudeTurns = () => room.store.state.turns.filter((turn) => turn.agent === "claude").length;
  try {
    room.engine.postHuman("@claude hi");
    await withTimeout(room.engine.waitIdle());
    assert.equal(failed(room, "claude"), 3);

    room.engine.continueRun();
    await withTimeout(room.engine.waitIdle());
    assert.equal(failed(room, "claude"), 6, "another round");

    // Codex's mention alone does not wake it (above); after the human changed it, the same mention does.
    room.engine.updateAgent("claude", { effort: "low" });
    room.engine.post("@claude try with less effort", "codex");
    await withTimeout(room.engine.waitIdle());
    assert.equal(failed(room, "claude"), 9, "changed");

    // Sent out and seated again: fresh tries too.
    const seat = room.store.state.agents.find((agent) => agent.id === "claude")!;
    await room.engine.removeAgent("claude");
    room.engine.addAgent({ id: seat.id, kind: seat.kind, label: seat.label });
    room.engine.post("@claude back again", "codex");
    await withTimeout(room.engine.waitIdle());
    assert.equal(failed(room, "claude"), 12, "seated again");
    assert.equal(claudeTurns(), 12);
    assert.equal(notes(room).length, 4);
  } finally {
    await room.cleanup();
  }
});
